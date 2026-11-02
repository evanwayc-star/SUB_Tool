import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { FileAuthority } = require('../electron/file-authority.js');
const { createMediaIntakeRuntime } = require('../electron/media-intake-runtime.js');
let root;
// Trigger external replacement only after the directory handle is closed;
// Windows cannot rename a directory while that handle remains open.
function interceptDirectoryScan(targetPath, { afterClose = () => {}, onRead = () => {}, sorted = false } = {}) {
  const open = fs.opendirSync;
  return vi.spyOn(fs, 'opendirSync').mockImplementation((directory, ...options) => {
    const handle = open(directory, ...options);
    if (path.resolve(String(directory)) !== targetPath) return handle;
    let sortedEntries, sortedIndex = 0;
    return new Proxy(handle, { get(target, property) {
      if (property === 'readSync') return () => {
        let entry;
        if (sorted) {
          if (!sortedEntries) {
            sortedEntries = [];
            for (let value; (value = target.readSync());) sortedEntries.push(value);
            sortedEntries.sort((left, right) => left.name.localeCompare(right.name));
          }
          entry = sortedEntries[sortedIndex++] || null;
        } else entry = target.readSync();
        onRead(entry);
        return entry;
      };
      if (property === 'closeSync') return () => { target.closeSync(); afterClose(); };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  if (root && path.dirname(root) === fs.realpathSync(os.tmpdir()) && path.basename(root).startsWith('subtool-cache-child-')) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  root = null;
});

it.each([
  { operation: 'cleanOrphans' },
  { operation: 'clearAll' },
])('$operation 檢查候選後原目錄被替換，不能刪除新建快取', async ({ operation }) => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-cache-child-'));
  const cacheRoot = path.join(root, 'cache'), tempRoot = path.join(root, 'temp');
  const candidate = path.join(cacheRoot, 'candidate'), original = path.join(root, 'original-candidate');
  fs.mkdirSync(candidate, { recursive: true }); fs.mkdirSync(tempRoot);
  fs.writeFileSync(path.join(candidate, 'old.bin'), 'old orphan');
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    ffmpegExecution: { async execute() {} },
  });
  let swapped = false;
  const spy = interceptDirectoryScan(candidate, { afterClose: () => {
    if (swapped) return;
    fs.renameSync(candidate, original);
    fs.mkdirSync(candidate);
    fs.writeFileSync(path.join(candidate, 'foreign.bin'), 'new cache owner');
    swapped = true;
  } });
  try { await runtime[operation](); } finally { spy.mockRestore(); }
  expect(swapped).toBe(true);
  expect(fs.readFileSync(path.join(candidate, 'foreign.bin'), 'utf8')).toBe('new cache owner');
  expect(fs.readFileSync(path.join(original, 'old.bin'), 'utf8')).toBe('old orphan');
});

it('clearAll 測量候選檔案後同名檔被替換，不能刪除新檔', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-cache-child-'));
  const cacheRoot = path.join(root, 'cache'), tempRoot = path.join(root, 'temp');
  const candidate = path.join(cacheRoot, 'candidate.bin'), original = path.join(root, 'original.bin');
  fs.mkdirSync(cacheRoot); fs.mkdirSync(tempRoot); fs.writeFileSync(candidate, 'old cache file');
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    ffmpegExecution: { async execute() {} },
  });
  const realStat = fs.lstatSync; let swapped = false;
  const spy = vi.spyOn(fs, 'lstatSync').mockImplementation((file, ...options) => {
    const result = realStat(file, ...options);
    if (!swapped && path.resolve(String(file)) === candidate) {
      fs.renameSync(candidate, original); fs.writeFileSync(candidate, 'new cache file'); swapped = true;
    }
    return result;
  });
  try { await runtime.clearAll(); } finally { spy.mockRestore(); }
  expect(swapped).toBe(true);
  expect(fs.readFileSync(candidate, 'utf8')).toBe('new cache file');
  expect(fs.readFileSync(original, 'utf8')).toBe('old cache file');
});

it('clearAll 檢查候選資料夾後檔案被其他工作更新，不可刪除新內容', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-cache-child-'));
  const cacheRoot = path.join(root, 'cache'), tempRoot = path.join(root, 'temp');
  const candidate = path.join(cacheRoot, 'candidate'), file = path.join(candidate, 'wave.bin');
  fs.mkdirSync(candidate, { recursive: true }); fs.mkdirSync(tempRoot);
  fs.writeFileSync(file, 'old cache');
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    ffmpegExecution: { async execute() {} },
  });
  const realStat = fs.lstatSync; let changed = false, reads = 0;
  const spy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...options) => {
    const stat = realStat(target, ...options);
    if (!changed && path.resolve(String(target)) === file && ++reads === 2) {
      fs.writeFileSync(file, 'new cache'); changed = true;
    }
    return stat;
  });
  try { await runtime.clearAll(); } finally { spy.mockRestore(); }
  expect(changed).toBe(true);
  expect(fs.readFileSync(file, 'utf8')).toBe('new cache');
});

it('清理隔離期間原路徑出現懸空連結，還原不得覆蓋新連結', async (context) => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-cache-child-'));
  const cacheRoot = path.join(root, 'cache'), tempRoot = path.join(root, 'temp');
  const candidate = path.join(cacheRoot, 'candidate.bin'), original = path.join(root, 'original.bin');
  const missing = path.join(root, 'missing-target'), probe = path.join(root, 'symlink-probe');
  try { fs.symlinkSync(missing, probe, 'file'); fs.unlinkSync(probe); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { context.skip('目前環境無法建立檔案 symbolic link'); return; }
    throw error;
  }
  fs.mkdirSync(cacheRoot); fs.mkdirSync(tempRoot); fs.writeFileSync(candidate, 'old cache file');
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    ffmpegExecution: { async execute() {} },
  });
  const realRename = fs.renameSync; let swapped = false;
  const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    const result = realRename(from, to);
    if (!swapped && path.resolve(String(from)) === candidate && path.basename(String(to)) === 'entry') {
      realRename(to, original);
      fs.writeFileSync(to, 'substituted quarantine content');
      fs.symlinkSync(missing, candidate, 'file');
      swapped = true;
    }
    return result;
  });
  try { await runtime.clearAll(); } finally { spy.mockRestore(); }
  expect(swapped).toBe(true);
  expect(fs.lstatSync(candidate).isSymbolicLink()).toBe(true);
  expect(fs.readlinkSync(candidate)).toBe(missing);
  expect(fs.readFileSync(original, 'utf8')).toBe('old cache file');
});

it('sidecar 隔離期間原路徑出現懸空連結，還原不得覆蓋新連結', async (context) => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-cache-child-'));
  const media = path.join(root, 'media'), cacheRoot = path.join(root, 'cache'), tempRoot = path.join(root, 'temp');
  const missing = path.join(root, 'missing-target'), probe = path.join(root, 'symlink-probe');
  try { fs.symlinkSync(missing, probe, 'file'); fs.unlinkSync(probe); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { context.skip('目前環境無法建立檔案 symbolic link'); return; }
    throw error;
  }
  fs.mkdirSync(media); fs.mkdirSync(cacheRoot); fs.mkdirSync(tempRoot);
  const source = path.join(media, 'source.mov'); fs.writeFileSync(source, 'mother source');
  const authority = new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] });
  authority.grantTrustedFile(source);
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, fileAuthority: authority, delay: async () => {},
    ffmpegExecution: { async execute(args) {
      for (const file of args.filter(value => /\.(?:m4a|wav|mp4)$/.test(value))) fs.writeFileSync(file, 'source cache content');
    } },
  });
  try {
    const result = await runtime.ingest({ src: source, duration: 1, needsProxy: false, audio: [{ channels: 1 }] });
    const directory = path.dirname(path.dirname(result.wave));
    expect(path.basename(path.dirname(directory)).toLowerCase()).toBe('.subtool_cache');
    const saved = path.join(root, 'saved-original');
    const realRename = fs.renameSync; let swapped = false;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      const value = realRename(from, to);
      if (!swapped && path.resolve(String(from)) === directory && path.basename(String(to)).startsWith('.subtool-clear-')) {
        realRename(to, saved); fs.mkdirSync(to); fs.writeFileSync(path.join(to, 'new.bin'), 'new content');
        fs.symlinkSync(missing, directory, 'file'); swapped = true;
      }
      return value;
    });
    try { await runtime.clearAll(source); } finally { spy.mockRestore(); }
    expect(swapped).toBe(true);
    expect(fs.lstatSync(directory).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(directory)).toBe(missing);
    expect(fs.readFileSync(path.join(saved, path.relative(directory, result.wave)), 'utf8')).toBe('source cache content');
  } finally { await runtime.close(); }
});

it('clearAll 掃描活躍 writer 父目錄後，不能遞迴清除被取代的新目錄內容', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-cache-child-'));
  const cacheRoot = path.join(root, 'cache'), tempRoot = path.join(root, 'temp');
  const ancestor = path.join(cacheRoot, 'ancestor'), oldAncestor = path.join(root, 'original-ancestor');
  const source = path.join(ancestor, 'source.mov'), marker = path.join(ancestor, 'existing.txt');
  fs.mkdirSync(ancestor, { recursive: true }); fs.mkdirSync(tempRoot);
  fs.writeFileSync(source, 'original mother source'); fs.writeFileSync(marker, 'old content');
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: true,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    delay: () => { started(); return gate; },
    ffmpegExecution: { async execute() {} },
  });
  const writer = runtime.ingest({ src: source, duration: 1, needsProxy: false, audio: [{ channels: 1 }] });
  writer.catch(() => {});
  await Promise.race([entered, writer.then(() => { throw new Error('writer 未開始'); }, error => { throw error; })]);
  let swapped = false;
  const spy = interceptDirectoryScan(ancestor, { afterClose: () => {
    if (!swapped) {
      fs.renameSync(ancestor, oldAncestor);
      fs.mkdirSync(ancestor);
      fs.mkdirSync(path.join(ancestor, '.subtool_Cache'));
      fs.writeFileSync(source, 'foreign mother source');
      fs.writeFileSync(marker, 'foreign content');
      swapped = true;
    }
  } });
  try {
    await runtime.clearAll();
    expect(swapped).toBe(true);
    expect(fs.readFileSync(source, 'utf8')).toBe('foreign mother source');
    expect(fs.readFileSync(marker, 'utf8')).toBe('foreign content');
    expect(fs.readFileSync(path.join(oldAncestor, 'existing.txt'), 'utf8')).toBe('old content');
  } finally {
    spy.mockRestore(); release(); await writer.catch(() => {}); await runtime.close();
  }
});

it('cleanOrphans 遇到活躍 sidecar writer 的祖先時保留整個候選並回報未完成', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-cache-child-'));
  const cacheRoot = path.join(root, 'cache'), tempRoot = path.join(root, 'temp');
  const ancestor = path.join(cacheRoot, 'ancestor'), source = path.join(ancestor, 'source.mov');
  const marker = path.join(ancestor, 'other.txt');
  fs.mkdirSync(ancestor, { recursive: true }); fs.mkdirSync(tempRoot);
  fs.writeFileSync(source, 'mother source'); fs.writeFileSync(marker, 'must stay with active writer');
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: true,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    delay: () => { started(); return gate; }, ffmpegExecution: { async execute() {} },
  });
  const writer = runtime.ingest({ src: source, duration: 1, needsProxy: false, audio: [{ channels: 1 }] });
  writer.catch(() => {});
  await Promise.race([entered, writer.then(() => { throw new Error('writer 未開始'); }, error => { throw error; })]);
  try {
    expect(await runtime.cleanOrphans()).toEqual({ removed: 0, bytes: 0, incomplete: true });
    expect(fs.readFileSync(source, 'utf8')).toBe('mother source');
    expect(fs.readFileSync(marker, 'utf8')).toBe('must stay with active writer');
  } finally { release(); await writer.catch(() => {}); await runtime.close(); }
});

it('clearAll 掃描活躍 writer 父目錄後，不能清除同一父目錄中新置換的檔案', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-cache-child-'));
  const cacheRoot = path.join(root, 'cache'), tempRoot = path.join(root, 'temp');
  const ancestor = path.join(cacheRoot, 'ancestor'), oldFile = path.join(root, 'original-marker');
  const source = path.join(ancestor, 'source.mov'), marker = path.join(ancestor, 'existing.txt');
  fs.mkdirSync(ancestor, { recursive: true }); fs.mkdirSync(tempRoot);
  fs.writeFileSync(source, 'original mother source'); fs.writeFileSync(marker, 'old content');
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: true,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    delay: () => { started(); return gate; }, ffmpegExecution: { async execute() {} },
  });
  const writer = runtime.ingest({ src: source, duration: 1, needsProxy: false, audio: [{ channels: 1 }] });
  writer.catch(() => {});
  await Promise.race([entered, writer.then(() => { throw new Error('writer 未開始'); }, error => { throw error; })]);
  let swapped = false;
  const spy = interceptDirectoryScan(ancestor, { afterClose: () => {
    if (!swapped) {
      fs.renameSync(marker, oldFile); fs.writeFileSync(marker, 'foreign content'); swapped = true;
    }
  } });
  try {
    await runtime.clearAll();
    expect(swapped).toBe(true);
    expect(fs.readFileSync(marker, 'utf8')).toBe('foreign content');
    expect(fs.readFileSync(oldFile, 'utf8')).toBe('old content');
  } finally { spy.mockRestore(); release(); await writer.catch(() => {}); await runtime.close(); }
});

it('活躍 writer 父目錄先清理一個 sibling 時，另一 sibling 內更新的檔案不能被刪', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-cache-child-'));
  const cacheRoot = path.join(root, 'cache'), tempRoot = path.join(root, 'temp');
  const ancestor = path.join(cacheRoot, 'ancestor'), source = path.join(ancestor, 'source.mov');
  const first = path.join(ancestor, 'a'), second = path.join(ancestor, 'b');
  const updated = path.join(second, 'wave.bin');
  fs.mkdirSync(first, { recursive: true }); fs.mkdirSync(second); fs.mkdirSync(tempRoot);
  fs.writeFileSync(source, 'original mother source'); fs.writeFileSync(path.join(first, 'first.bin'), 'old sibling');
  fs.writeFileSync(updated, 'old cache');
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: true,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    delay: () => { started(); return gate; }, ffmpegExecution: { async execute() {} },
  });
  const writer = runtime.ingest({ src: source, duration: 1, needsProxy: false, audio: [{ channels: 1 }] });
  writer.catch(() => {});
  await Promise.race([entered, writer.then(() => { throw new Error('writer 未開始'); }, error => { throw error; })]);
  const realRemove = fs.unlinkSync; let changed = false;
  const readSpy = interceptDirectoryScan(ancestor, { sorted: true });
  const removeSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...options) => {
    const firstEntry = path.basename(String(target)) === 'first.bin' && path.basename(path.dirname(String(target))) === 'entry';
    const result = realRemove(target, ...options);
    if (firstEntry) { fs.writeFileSync(updated, 'new cache'); changed = true; }
    return result;
  });
  try {
    await runtime.clearAll();
    expect(changed).toBe(true);
    expect(fs.readFileSync(updated, 'utf8')).toBe('new cache');
  } finally {
    readSpy.mockRestore(); removeSpy.mockRestore(); release(); await writer.catch(() => {}); await runtime.close();
  }
});

it('超過目錄樹數量上限時，孤兒清理與全部清理都完整保留原項', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-cache-child-'));
  const cacheRoot = path.join(root, 'cache'), tempRoot = path.join(root, 'temp');
  const candidate = path.join(cacheRoot, 'candidate');
  fs.mkdirSync(candidate, { recursive: true }); fs.mkdirSync(tempRoot);
  for (let index = 0; index < 20001; index++) fs.writeFileSync(path.join(candidate, `${index}.bin`), 'x');
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    ffmpegExecution: { async execute() {} },
  });
  let reads = 0;
  const spy = interceptDirectoryScan(candidate, { onRead: entry => { if (entry) reads++; } });
  try {
    expect(await runtime.cleanOrphans()).toEqual({ removed: 0, bytes: 0, incomplete: true });
    expect(reads).toBeGreaterThan(0); expect(reads).toBeLessThanOrEqual(20001);
    expect(fs.readdirSync(candidate)).toHaveLength(20001);
    reads = 0;
    expect(await runtime.clearAll()).toEqual({ bytes: 0, incomplete: true });
    expect(reads).toBeGreaterThan(0); expect(reads).toBeLessThanOrEqual(20001);
    expect(fs.readdirSync(candidate)).toHaveLength(20001);
    expect(fs.readFileSync(path.join(candidate, '20000.bin'), 'utf8')).toBe('x');
  } finally { spy.mockRestore(); }
}, 30000);

it('超過目錄深度上限時，孤兒清理與全部清理都完整保留原項', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-cache-child-'));
  const cacheRoot = path.join(root, 'cache'), tempRoot = path.join(root, 'temp');
  const candidate = path.join(cacheRoot, 'candidate');
  fs.mkdirSync(candidate, { recursive: true }); fs.mkdirSync(tempRoot);
  let nested = candidate;
  for (let index = 0; index < 50; index++) { nested = path.join(nested, 'd'); fs.mkdirSync(nested); }
  const file = path.join(nested, 'wave.bin'); fs.writeFileSync(file, 'keep deep cache');
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    ffmpegExecution: { async execute() {} },
  });
  expect(await runtime.cleanOrphans()).toEqual({ removed: 0, bytes: 0, incomplete: true });
  expect(await runtime.clearAll()).toEqual({ bytes: 0, incomplete: true });
  expect(fs.readFileSync(file, 'utf8')).toBe('keep deep cache');
});

it.each(['cleanOrphans', 'clearAll'])('%s 可完整清除未超過限制的 1200 項快取', async operation => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-cache-child-'));
  const cacheRoot = path.join(root, 'cache'), tempRoot = path.join(root, 'temp');
  const candidate = path.join(cacheRoot, 'candidate');
  fs.mkdirSync(candidate, { recursive: true }); fs.mkdirSync(tempRoot);
  for (let index = 0; index < 1200; index++) fs.writeFileSync(path.join(candidate, `${index}.bin`), 'x');
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    ffmpegExecution: { async execute() {} },
  });
  const result = await runtime[operation]();
  expect(result.bytes).toBe(1200);
  expect(result.incomplete).toBe(false);
  if (operation === 'cleanOrphans') expect(result.removed).toBe(1);
  expect(fs.existsSync(candidate)).toBe(false);
}, 30000);
