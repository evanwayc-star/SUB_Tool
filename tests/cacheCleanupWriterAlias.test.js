import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { FileAuthority } = require('../electron/file-authority');
const { createMediaIntakeRuntime } = require('../electron/media-intake-runtime');
let root;
afterEach(() => {
  vi.restoreAllMocks();
  if (root && path.dirname(root) === fs.realpathSync(os.tmpdir()) && path.basename(root).startsWith('subtool-cache-writer-alias-')) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  root = null;
});

it.runIf(process.platform === 'win32').each(['cleanOrphans', 'clearAll'])(
  '%s 不可用長目錄名誤刪從 8.3 祖先路徑啟動的活躍 writer', async (operation, context) => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-cache-writer-alias-'));
    const cacheRoot = path.join(root, 'cache'), tempRoot = path.join(root, 'temp');
    const ancestor = path.join(cacheRoot, 'Long Source Folder For Active Writer');
    fs.mkdirSync(ancestor, { recursive: true }); fs.mkdirSync(tempRoot);
    const longSource = path.join(ancestor, 'source.mov'); fs.writeFileSync(longSource, 'original mother source');
    const shortPath = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:SUBTOOL_ALIAS_DIR).ShortPath'], {
      encoding: 'utf8', env: { ...process.env, SUBTOOL_ALIAS_DIR: ancestor },
    }).trim();
    const shortAncestor = path.join(cacheRoot, path.basename(shortPath));
    if (shortAncestor.toLowerCase() === ancestor.toLowerCase()) context.skip('此磁碟沒有 8.3 短檔名');
    expect(fs.realpathSync.native(shortAncestor).toLowerCase()).toBe(fs.realpathSync.native(ancestor).toLowerCase());
    const source = path.join(shortAncestor, 'source.mov');
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { started = resolve; });
    const authority = new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] });
    authority.grantTrustedFile(source);
    const runtime = createMediaIntakeRuntime({ cacheRoot, tempRoot, allowSidecarCache: true,
      fileAuthority: authority, delay: () => { started(); return gate; }, ffmpegExecution: { async execute() {} } });
    const writer = runtime.ingest({ src: source, duration: 1, needsProxy: false, audio: [{ channels: 1 }] });
    writer.catch(() => {});
    try {
      await Promise.race([entered, writer.then(() => { throw new Error('writer 未開始'); }, error => { throw error; })]);
      // The short-ancestor sidecar is rejected; ingest falls back to this
      // active central entry while the original mother remains in ancestor.
      const activeKeys = fs.readdirSync(cacheRoot).filter(name => /^[a-f0-9]{16}$/.test(name));
      expect(activeKeys).toHaveLength(1);
      const activeDirectory = path.join(cacheRoot, activeKeys[0]);
      const result = operation === 'clearAll' ? await runtime.clearAll(source) : await runtime.cleanOrphans();
      expect(result.incomplete).toBe(true);
      expect(fs.readFileSync(longSource, 'utf8')).toBe('original mother source');
      expect(fs.existsSync(activeDirectory)).toBe(true);
    } finally { release(); await writer.catch(() => {}); await runtime.close(); }
  }, 10000,
);

it.runIf(process.platform === 'win32').each(['cleanOrphans', 'clearAll'])(
  '%s 不可用 8.3 快取根誤刪以長目錄名啟動的活躍 writer', async (operation, context) => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-cache-writer-alias-'));
    const longRoot = path.join(root, 'Long Central Cache Directory'), tempRoot = path.join(root, 'temp');
    fs.mkdirSync(longRoot); fs.mkdirSync(tempRoot);
    const shortPath = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:SUBTOOL_ALIAS_DIR).ShortPath'], {
      encoding: 'utf8', env: { ...process.env, SUBTOOL_ALIAS_DIR: longRoot },
    }).trim();
    const cacheRoot = path.join(root, path.basename(shortPath));
    if (cacheRoot.toLowerCase() === longRoot.toLowerCase()) context.skip('此磁碟沒有 8.3 短檔名');
    expect(fs.realpathSync.native(cacheRoot).toLowerCase()).toBe(fs.realpathSync.native(longRoot).toLowerCase());
    const ancestor = path.join(longRoot, 'Long Source Folder For Active Writer'); fs.mkdirSync(ancestor);
    const source = path.join(ancestor, 'source.mov'); fs.writeFileSync(source, 'original mother source');
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { started = resolve; });
    const authority = new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }); authority.grantTrustedFile(source);
    const runtime = createMediaIntakeRuntime({ cacheRoot, tempRoot, allowSidecarCache: true,
      fileAuthority: authority, delay: () => { started(); return gate; }, ffmpegExecution: { async execute() {} } });
    const writer = runtime.ingest({ src: source, duration: 1, needsProxy: false, audio: [{ channels: 1 }] });
    writer.catch(() => {});
    try {
      await Promise.race([entered, writer.then(() => { throw new Error('writer 未開始'); }, error => { throw error; })]);
      const sidecar = path.join(ancestor, '.subtool_Cache');
      const candidates = [longRoot, ...(fs.existsSync(sidecar) ? [sidecar] : [])].flatMap(directory =>
        fs.readdirSync(directory).filter(name => /^[a-f0-9]{16}$/.test(name)).map(name => path.join(directory, name)));
      expect(candidates).toHaveLength(1);
      const result = operation === 'clearAll' ? await runtime.clearAll(source) : await runtime.cleanOrphans();
      expect(result.incomplete).toBe(true);
      expect(fs.readFileSync(source, 'utf8')).toBe('original mother source');
      expect(fs.existsSync(candidates[0])).toBe(true);
    } finally { release(); await writer.catch(() => {}); await runtime.close(); }
  }, 10000,
);

it.each(['ingest', 'stream'].flatMap(operation => ['cleanOrphans', 'clearAll'].map(cleanup => ({ operation, cleanup }))))
('$operation 的快取預檢尚未完成時，$cleanup 不得刪除背景母素材', async ({ operation, cleanup }) => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-cache-writer-alias-'));
  const cacheRoot = path.join(root, 'cache'), tempRoot = path.join(root, 'temp');
  const ancestor = path.join(cacheRoot, 'pending-source'), source = path.join(ancestor, 'source.mov');
  fs.mkdirSync(ancestor, { recursive: true }); fs.mkdirSync(tempRoot);
  fs.writeFileSync(source, 'original mother source before verification');
  const authority = new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] });
  authority.grantTrustedFile(source);
  const runtime = createMediaIntakeRuntime({ cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: authority, ffmpegExecution: { async execute() {} } });
  let release, started, held = false;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const originalRead = fs.promises.readdir.bind(fs.promises);
  const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation(async (directory, ...args) => {
    if (!held && path.resolve(String(directory)) === cacheRoot) { held = true; started(); await gate; }
    return originalRead(directory, ...args);
  });
  const request = { src: source, duration: 1, needsProxy: false, audio: [{ channels: 1 }] };
  const work = runtime[operation](request); work.catch(() => {});
  try {
    await Promise.race([entered, work.then(() => { throw new Error('工作未進入快取預檢'); }, error => { throw error; })]);
    const result = cleanup === 'clearAll' ? await runtime.clearAll(null) : await runtime.cleanOrphans();
    expect(fs.readFileSync(source, 'utf8')).toBe('original mother source before verification');
    expect(result.incomplete).toBe(true);
  } finally {
    spy.mockRestore();
    const closing = runtime.close(); release();
    await work.catch(() => {}); await closing;
  }
}, 10000);

it.each(['cleanOrphans', 'clearAll'])('%s 在同源預檢取消一份後仍保留另一份，全部結束才釋放資格', async cleanup => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-cache-writer-alias-'));
  const cacheRoot = path.join(root, 'cache'), tempRoot = path.join(root, 'temp');
  const ancestor = path.join(cacheRoot, 'pending-source'), source = path.join(ancestor, 'source.mov');
  fs.mkdirSync(ancestor, { recursive: true }); fs.mkdirSync(tempRoot);
  fs.writeFileSync(source, 'shared mother source');
  const authority = new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] });
  authority.grantTrustedFile(source);
  const runtime = createMediaIntakeRuntime({ cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: authority, ffmpegExecution: { async execute() {} } });
  const gates = [], entered = [];
  for (let index = 0; index < 2; index++) {
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { started = resolve; });
    gates.push({ gate, release, started }); entered.push(ready);
  }
  let cancelledFirst = false, cancelledSecond = false, count = 0;
  const originalRead = fs.promises.readdir.bind(fs.promises);
  const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation(async (directory, ...args) => {
    if (path.resolve(String(directory)) === cacheRoot && count < gates.length) {
      const item = gates[count++]; item.started(); await item.gate;
    }
    return originalRead(directory, ...args);
  });
  const request = { src: source, duration: 1, needsProxy: false, audio: [{ channels: 1 }] };
  const first = runtime.ingest(request, { isCancelled: () => cancelledFirst }); first.catch(() => {});
  const second = runtime.stream(request, { isCancelled: () => cancelledSecond }); second.catch(() => {});
  try {
    await Promise.all(entered);
    cancelledFirst = true; gates[0].release(); await first.catch(() => {});
    const partial = cleanup === 'clearAll' ? await runtime.clearAll(null) : await runtime.cleanOrphans();
    expect(fs.readFileSync(source, 'utf8')).toBe('shared mother source');
    expect(partial.incomplete).toBe(true);
    cancelledSecond = true; gates[1].release(); await second.catch(() => {});
    const completed = cleanup === 'clearAll' ? await runtime.clearAll(null) : await runtime.cleanOrphans();
    expect(completed.incomplete).toBe(false);
    expect(fs.existsSync(source)).toBe(false);
  } finally {
    cancelledFirst = true; cancelledSecond = true; spy.mockRestore();
    gates.forEach(item => item.release());
    await Promise.allSettled([first, second]); await runtime.close();
  }
}, 10000);
