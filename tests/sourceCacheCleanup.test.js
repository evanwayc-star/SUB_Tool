import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const runtimeId = require.resolve('../electron/media-intake-runtime');
const { createMediaIntakeRuntime, cacheKeyFor } = require(runtimeId);
const { FileAuthority } = require('../electron/file-authority');
const workerModule = require('../electron/source-waveform-worker');
const { sharedSourceFingerprintSync } = require('../electron/mother-source-evidence');
const roots = [], runtimes = [];
function fixture({ factory = createMediaIntakeRuntime, central = true, ...options } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-source-cleanup-')); roots.push(root);
  const source = path.join(root, 'mother.mov'), cacheRoot = path.join(root, 'central'), tempRoot = path.join(root, 'temp');
  fs.writeFileSync(source, 'mother source'); fs.mkdirSync(tempRoot); if (central) fs.mkdirSync(cacheRoot);
  const fileAuthority = new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }); fileAuthority.grantTrustedFile(source);
  const runtime = factory({ cacheRoot, tempRoot, fileAuthority, allowSidecarCache: true,
    ffmpegExecution: { execute: vi.fn() }, ...options }); runtimes.push(runtime);
  return { root, source, cacheRoot, tempRoot, runtime, fileAuthority };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  for (const root of roots.splice(0)) {
    const resolved = fs.realpathSync(root);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('subtool-source-cleanup-')) throw new Error('unsafe fixture cleanup');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

it.each(['clearAll', 'cleanOrphans'].flatMap(method => [false, true].map(central => ({ method, central }))))
('$method 無素材且中央存在=$central 時會立即收斂，不建立中央目錄', async ({ method, central }) => {
  const f = fixture({ central });
  const result = await f.runtime[method]();
  expect(result).toMatchObject({ bytes: 0, incomplete: !central });
  expect(fs.existsSync(f.cacheRoot)).toBe(central);
});

it.each(['clearAll', 'cleanOrphans'])('%s 不等待仍在讀取舊來源的唯讀資訊 worker，shutdown 仍持有它', async method => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const oldModule = require.cache[runtimeId];
  const spy = vi.spyOn(workerModule, 'runSourceWaveformWorker').mockImplementation((config, { publish, session }) => {
    expect(config.operation).toBe('cache-info');
    return gate.then(() => {
      if (session.isCancelled()) throw Object.assign(new Error('cancelled'), { code: 'INGEST_SUPERSEDED' });
      return publish({ root: config.cacheRoot, folders: 0, bytes: 0 });
    });
  });
  delete require.cache[runtimeId];
  const factory = require(runtimeId).createMediaIntakeRuntime;
  require.cache[runtimeId] = oldModule;
  const f = fixture({ factory, backgroundWaveforms: true });
  const info = f.runtime.cacheInfo(f.source).catch(error => error);
  let cleaned = false, closed = false;
  const cleanup = f.runtime[method]().then(value => { cleaned = true; return value; });
  let closing;
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(cleaned).toBe(true);
    closing = f.runtime.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(closed).toBe(false);
  } finally { release(); await Promise.all([info, cleanup, closing]); spy.mockRestore(); }
});

it('sourceOnly 資訊不列舉中央，也不回傳中央統計', async () => {
  const f = fixture(), centralRead = vi.fn(), read = fs.readdirSync;
  vi.spyOn(fs, 'readdirSync').mockImplementation((dir, ...args) => {
    if (path.resolve(String(dir)) === f.cacheRoot) centralRead();
    return read(dir, ...args);
  });
  const info = await f.runtime.cacheInfo(f.source, { sourceOnly: true });
  expect(centralRead).not.toHaveBeenCalled();
  expect(info).toEqual({ source: { path: f.source, locations: [] } });
});

it('clearSource 只清目前素材 sidecar，主執行緒不讀取來源／快取檔案', async () => {
  const f = fixture({ backgroundWaveforms: true });
  const own = path.join(f.root, '.subtool_Cache', cacheKeyFor(f.source)); fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, 'old.bin'), 'own-cache');
  const central = path.join(f.cacheRoot, 'keep.bin'); fs.writeFileSync(central, 'central untouched');
  const foreign = path.join(path.dirname(own), 'f'.repeat(16)); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'keep.bin'), 'other source');
  const touched = [], lstat = fs.lstatSync;
  const spy = vi.spyOn(fs, 'lstatSync').mockImplementation((file, ...args) => {
    if (typeof file === 'string' && (file === f.source || file.startsWith(path.dirname(own) + path.sep))) touched.push(file);
    return lstat(file, ...args);
  });
  let result;
  try { result = await f.runtime.clearSource(f.source); } finally { spy.mockRestore(); }
  expect(result).toMatchObject({ bytes: 9, incomplete: false });
  expect(touched).toEqual([]);
  expect(fs.existsSync(own)).toBe(false);
  expect(fs.readFileSync(central, 'utf8')).toBe('central untouched');
  expect(fs.readFileSync(path.join(foreign, 'keep.bin'), 'utf8')).toBe('other source');
  expect(fs.readFileSync(f.source, 'utf8')).toBe('mother source');
});

it.each(['same', 'hardlink', 'different'])('活躍來源是 %s 時只阻擋同一來源清理，不等待長片 writer', async kind => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
  const f = fixture({ ffmpegExecution: { execute: async (_args, options) => {
    started(); await gate; fs.writeSync(options.outputDescriptor, Buffer.from('transient-wave'));
  } } });
  const target = path.join(f.root, '.subtool_Cache', cacheKeyFor(f.source)); fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'old.bin'), 'own-cache');
  const active = kind === 'same' ? f.source : path.join(f.root, 'active.mov');
  if (kind === 'hardlink') fs.linkSync(f.source, active);
  if (kind === 'different') fs.writeFileSync(active, 'different mother');
  f.fileAuthority.grantTrustedFile(active);
  const work = f.runtime.waveform({ src: active, duration: 1, audio: [{ channels: 1 }] });
  try {
    await entered;
    const result = await f.runtime.clearSource(f.source);
    if (kind === 'different') {
      expect(result).toEqual({ bytes: 9, incomplete: false }); expect(fs.existsSync(target)).toBe(false);
    } else {
      expect(result).toEqual({ bytes: 0, incomplete: true, reason: 'busy' });
      expect(fs.readFileSync(path.join(target, 'old.bin'), 'utf8')).toBe('own-cache');
    }
  } finally { release(); const wave = await work; expect(f.runtime.cleanupGeneratedFile(wave.wave)).toBe(true); }
});

it('先前已登記 sidecar 被同名新目錄替換，worker 不會重新採信或刪除外來內容', async () => {
  const f = fixture();
  const parent = path.join(f.root, '.subtool_Cache'), target = path.join(parent, cacheKeyFor(f.source));
  fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, 'old.bin'), 'original');
  f.runtime.cacheInfo(f.source, { sourceOnly: true });
  fs.renameSync(parent, parent + '.original');
  fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, 'foreign.bin'), 'foreign');
  expect(await f.runtime.clearSource(f.source)).toEqual({ bytes: 0, incomplete: true });
  expect(fs.readFileSync(path.join(target, 'foreign.bin'), 'utf8')).toBe('foreign');
  expect(fs.readFileSync(path.join(parent + '.original', path.basename(target), 'old.bin'), 'utf8')).toBe('original');
});

it('資訊已顯示的其他 client key 共享快取可清除，別來源的同名產物保留', async () => {
  const f = fixture({ backgroundWaveforms: true }), parent = path.join(f.root, '.subtool_Cache');
  const key = cacheKeyFor(f.source), shared = sharedSourceFingerprintSync(f.source), otherKey = 'b'.repeat(16);
  const own = path.join(parent, otherKey), foreign = path.join(parent, 'c'.repeat(16));
  for (const directory of [own, foreign]) {
    fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'proxy.mp4'), 'proxy-content');
    fs.writeFileSync(path.join(directory, 'meta.json'), JSON.stringify({ proxy: 'proxy.mp4', channels: [], sourceKeys: [otherKey],
      sourceContent: { format: 'source-v4-shared-file', size: 13, sharedSourceKey: directory === own ? shared : 'f'.repeat(64) } }));
  }
  expect(key).not.toBe(otherKey);
  expect((await f.runtime.cacheInfo(f.source, { sourceOnly: true })).source.locations.map(item => item.directory)).toEqual([own]);
  const result = await f.runtime.clearSource(f.source);
  expect(result.incomplete).toBe(false); expect(result.bytes).toBeGreaterThan(13);
  expect(fs.existsSync(own)).toBe(false);
  expect(fs.readFileSync(path.join(foreign, 'proxy.mp4'), 'utf8')).toBe('proxy-content');
});

it('關閉立即撤銷尚未開始的清理 worker，不刪來源快取或發布晚到成功', async () => {
  const f = fixture({ backgroundWaveforms: true });
  const target = path.join(f.root, '.subtool_Cache', cacheKeyFor(f.source)); fs.mkdirSync(target, { recursive: true });
  const file = path.join(target, 'old.bin'); fs.writeFileSync(file, 'own-cache');
  const pending = f.runtime.clearSource(f.source);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'INGEST_SUPERSEDED' });
  await f.runtime.close(); await rejected;
  expect(fs.readFileSync(file, 'utf8')).toBe('own-cache');
});

it('清理開始後的新來源工作等本次隔離刪除結束才啟動，不被舊快照刪除', async () => {
  let cleaned = false;
  const execute = vi.fn(async (_args, options) => {
    expect(cleaned).toBe(true); fs.writeSync(options.outputDescriptor, Buffer.from('new transient waveform'));
  });
  const f = fixture({ ffmpegExecution: { execute } });
  const target = path.join(f.root, '.subtool_Cache', cacheKeyFor(f.source)); fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'old.bin'), 'own-cache');
  const cleanup = f.runtime.clearSource(f.source).then(result => { cleaned = true; return result; });
  const work = f.runtime.waveform({ src: f.source, duration: 1, audio: [{ channels: 1 }] });
  expect(await cleanup).toEqual({ bytes: 9, incomplete: false });
  const wave = await work;
  expect(execute).toHaveBeenCalledOnce();
  expect(fs.readFileSync(wave.wave, 'utf8')).toBe('new transient waveform');
  expect(f.runtime.cleanupGeneratedFile(wave.wave)).toBe(true);
});

it('串流已轉完但播放 reader 尚未釋放時立即 busy，釋放後才可清除', async () => {
  const f = fixture({ ffmpegExecution: { execute: async args => fs.writeFileSync(args.at(-1), Buffer.alloc(131072)) } });
  const stream = await f.runtime.stream({ src: f.source, duration: 1, audio: [] });
  await stream.completion;
  expect(await f.runtime.clearSource(f.source)).toEqual({ bytes: 0, incomplete: true, reason: 'busy' });
  expect(fs.existsSync(stream.response.proxy)).toBe(true);
  expect(f.runtime.releaseStream(stream.response.streamLeaseId)).toBe(true);
  const result = await f.runtime.clearSource(f.source);
  expect(result.incomplete).toBe(false); expect(result.bytes).toBeGreaterThanOrEqual(131072);
  expect(fs.existsSync(stream.response.proxy)).toBe(false);
});

it('背景 sourceOnly 資訊沿用主程序已登記的 sidecar 身分，不採信同名替換目錄', async () => {
  const f = fixture({ backgroundWaveforms: true, ffmpegExecution: { execute: async args => {
    for (const file of args.filter(value => /\.(?:wav|m4a|mp4)$/.test(value))) fs.writeFileSync(file, 'encoded cache');
  } } });
  await f.runtime.ingest({ src: f.source, duration: 1, needsProxy: true, audio: [] });
  const parent = path.join(f.root, '.subtool_Cache'), target = path.join(parent, cacheKeyFor(f.source));
  fs.renameSync(parent, parent + '.original');
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(path.join(parent + '.original', path.basename(target), 'meta.json'), path.join(target, 'meta.json'));
  fs.writeFileSync(path.join(target, 'proxy.mp4'), 'external replacement');
  const info = await f.runtime.cacheInfo(f.source, { sourceOnly: true });
  expect(info.source.locations).toEqual([]);
  expect(fs.readFileSync(path.join(target, 'proxy.mp4'), 'utf8')).toBe('external replacement');
});

it.each(['removed', 'replacement'])('清理已%s後才關閉：撤銷舊回覆並只釋放確實刪除的舊目錄權威', async kind => {
  let release, entered, handlers, config;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const oldModule = require.cache[runtimeId];
  vi.spyOn(workerModule, 'runSourceWaveformWorker').mockImplementation((input, callbacks) => {
    config = input; handlers = callbacks; entered();
    return gate.then(() => callbacks.publish({ bytes: 13, incomplete: false, removedDirectories: [target] }));
  });
  delete require.cache[runtimeId]; const factory = require(runtimeId).createMediaIntakeRuntime; require.cache[runtimeId] = oldModule;
  const execute = vi.fn(async args => {
    for (const file of args.filter(value => /\.(?:wav|m4a|mp4)$/.test(value))) fs.writeFileSync(file, 'encoded cache');
  });
  const f = fixture({ factory, ffmpegExecution: { execute } });
  const request = { src: f.source, duration: 1, needsProxy: true, audio: [] };
  await f.runtime.ingest(request);
  const target = path.join(f.root, '.subtool_Cache', cacheKeyFor(f.source));
  const pending = f.runtime.clearSource(f.source), rejected = expect(pending).rejects.toMatchObject({ code: 'INGEST_SUPERSEDED' });
  await started;
  const owner = config.cleanupState.roots.find(([, value]) => path.resolve(value.requestedPath) === target)[1];
  // Simulate a worker that already finished deleting its verified object,
  // or one that saw a replacement and therefore could not delete anything.
  if (kind === 'removed') {
    if (path.dirname(path.dirname(fs.realpathSync(target))) !== f.root) throw new Error('unsafe simulated cleanup');
    fs.rmSync(target, { recursive: true });
  } else {
    fs.renameSync(target, target + '.original'); fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'foreign.bin'), 'foreign');
  }
  const closing = f.runtime.close();
  if (kind === 'removed') handlers.removed?.({ directory: target, physicalDirectory: owner.path, dev: owner.dev, ino: owner.ino });
  release(); await rejected; await closing;
  expect(await f.runtime.resume()).toBe(true);
  execute.mockClear();
  if (kind === 'removed') {
    expect(await f.runtime.ingest(request)).toMatchObject({ cached: false });
    expect(execute).toHaveBeenCalledOnce();
  } else {
    await expect(f.runtime.ingest(request)).rejects.toMatchObject({ code: 'SIDECAR_CACHE_UNAVAILABLE' });
    expect(execute).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(target, 'foreign.bin'), 'utf8')).toBe('foreign');
  }
});

it('真 worker 完成刪除通知先於被取消的成功回覆，resume 可重建已刪除快取', async () => {
  const originalWorker = workerModule.runSourceWaveformWorker, oldModule = require.cache[runtimeId];
  let runtime, closing, removed;
  vi.spyOn(workerModule, 'runSourceWaveformWorker').mockImplementation((config, callbacks) => originalWorker(config, {
    ...callbacks, removed: evidence => { removed = evidence; callbacks.removed(evidence); closing = runtime.close(); },
  }));
  delete require.cache[runtimeId]; const factory = require(runtimeId).createMediaIntakeRuntime; require.cache[runtimeId] = oldModule;
  const execute = vi.fn(async args => {
    for (const file of args.filter(value => /\.(?:wav|m4a|mp4)$/.test(value))) fs.writeFileSync(file, 'encoded cache');
  });
  const f = fixture({ factory, ffmpegExecution: { execute } }); runtime = f.runtime;
  const request = { src: f.source, duration: 1, needsProxy: true, audio: [] };
  const first = await runtime.ingest(request), target = path.join(f.root, '.subtool_Cache', cacheKeyFor(f.source));
  const physical = fs.realpathSync.native(target), physicalDirectory = process.platform === 'win32' ? physical.toLowerCase() : physical;
  const stat = fs.lstatSync(target, { bigint: true });
  await expect(runtime.clearSource(f.source)).rejects.toMatchObject({ code: 'INGEST_SUPERSEDED' });
  await closing;
  expect(removed).toEqual({ directory: target, physicalDirectory, dev: String(stat.dev), ino: String(stat.ino) });
  expect(fs.existsSync(first.proxy)).toBe(false);
  expect(await runtime.resume()).toBe(true);
  expect(await runtime.ingest(request)).toMatchObject({ cached: false });
  expect(execute).toHaveBeenCalledTimes(2);
});

it.runIf(process.platform === 'win32').each(['short-to-long', 'long-to-short'])
('經 %s 祖先別名清除同一素材快取後，原路徑可重建且不殘留舊 inode 權威', async (direction, context) => {
  const execute = vi.fn(async args => {
    for (const file of args.filter(value => /\.(?:wav|m4a|mp4)$/.test(value))) fs.writeFileSync(file, 'encoded cache');
  });
  const f = fixture({ ffmpegExecution: { execute } });
  const shortPath = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:SUBTOOL_ALIAS_DIR).ShortPath'], {
    encoding: 'utf8', env: { ...process.env, SUBTOOL_ALIAS_DIR: f.root },
  }).trim();
  const shortRoot = path.join(path.dirname(f.root), path.basename(shortPath));
  if (shortRoot.toLowerCase() === f.root.toLowerCase()) context.skip('此磁碟沒有 8.3 短檔名');
  expect(fs.realpathSync.native(shortRoot).toLowerCase()).toBe(fs.realpathSync.native(f.root).toLowerCase());
  const shortSource = path.join(shortRoot, path.basename(f.source));
  f.fileAuthority.grantTrustedFile(shortSource);
  const [source, cleanupSource] = direction === 'short-to-long' ? [shortSource, f.source] : [f.source, shortSource];
  const request = { src: source, duration: 1, needsProxy: true, audio: [] };
  const first = await f.runtime.ingest(request);
  expect(fs.existsSync(first.proxy)).toBe(true);
  const result = await f.runtime.clearSource(cleanupSource);
  expect(result.incomplete).toBe(false); expect(result.bytes).toBeGreaterThan(0);
  expect(fs.existsSync(first.proxy)).toBe(false);
  expect(await f.runtime.ingest(request)).toMatchObject({ cached: false });
  expect(execute).toHaveBeenCalledTimes(2);
});
