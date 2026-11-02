import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parse } from 'acorn';
import { afterEach, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { FileAuthority } = require('../electron/file-authority.js');
const { createMediaIntakeRuntime } = require('../electron/media-intake-runtime.js');
const { buildIngestArgs } = require('../electron/ffmpeg-execution-engine.js');
const { sourceAudioClockFilter } = require('../electron/media-intake-runtime.js');
const { createIpcGuards } = require('../electron/ipc-guards.js');
const ExportLease = require('../electron/export-lease.js');
let root;
function fixture() {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-legacy-temp-owner-'));
  const tempRoot = path.join(root, 'temp'), cacheRoot = path.join(root, 'cache');
  fs.mkdirSync(tempRoot); fs.mkdirSync(cacheRoot);
  const forgotten = [];
  const options = {
    tempRoot, cacheRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [tempRoot, cacheRoot] }),
    forgetTemporaryFile: file => forgotten.push(file), ffmpegExecution: { async execute() {} },
  };
  return { tempRoot, cacheRoot, forgotten, options, runtime: createMediaIntakeRuntime(options) };
}
afterEach(() => {
  vi.restoreAllMocks();
  if (root && path.dirname(root) === fs.realpathSync(os.tmpdir()) && path.basename(root).startsWith('subtool-legacy-temp-owner-')) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  root = null;
});

it('舊式音訊暫存交接後被替換時，真 cleanup 不得刪除新檔案', async () => {
  const { tempRoot, runtime } = fixture();
  const target = path.join(tempRoot, 'legacy.m4a'), original = path.join(root, 'original.m4a');
  expect(await runtime.produceTemporaryFile(target, async output => { fs.writeFileSync(output, 'owned audio'); })).toBe(target);
  fs.renameSync(target, original);
  fs.writeFileSync(target, 'foreign audio');
  expect(runtime.cleanupGeneratedFile(target)).toBe(false);
  expect(fs.readFileSync(target, 'utf8')).toBe('foreign audio');
  expect(fs.readFileSync(original, 'utf8')).toBe('owned audio');
});

it('writer 尚未結束時 cleanup 不可刪除輸出，交接後可正常清理', async () => {
  const { tempRoot, runtime, forgotten } = fixture();
  const target = path.join(tempRoot, 'legacy.wav');
  let finish, started;
  const pending = new Promise(resolve => { finish = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const work = runtime.produceTemporaryFile(target, async output => {
    fs.writeFileSync(output, 'owned bytes'); started(); await pending;
  });
  work.catch(() => {});
  await entered;
  try {
    expect(runtime.cleanupGeneratedFile(target)).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('owned bytes');
  } finally { finish(); }
  await expect(work).resolves.toBe(target);
  expect(runtime.cleanupGeneratedFile(target)).toBe(true);
  expect(fs.existsSync(target)).toBe(false);
  expect(forgotten).toContain(target);
});

it.each([false, true])('已交接檔案清除=%s 後同名路徑不得重用或被舊清理刪除', async cleanFirst => {
  const { tempRoot, runtime } = fixture();
  const target = path.join(tempRoot, 'legacy.mp4'), old = path.join(root, 'old.mp4');
  await runtime.produceTemporaryFile(target, async output => { fs.writeFileSync(output, 'old output'); });
  if (cleanFirst) expect(runtime.cleanupGeneratedFile(target)).toBe(true);
  else fs.renameSync(target, old);
  fs.writeFileSync(target, 'new foreign');
  expect(runtime.cleanupGeneratedFile(target)).toBe(false);
  expect(runtime.cleanupGeneratedFile(target)).toBe(false);
  expect(fs.readFileSync(target, 'utf8')).toBe('new foreign');
  await expect(runtime.produceTemporaryFile(target, vi.fn())).rejects.toThrow();
  expect(fs.readFileSync(target, 'utf8')).toBe('new foreign');
});

it('同程序重新建立 runtime 後仍沿用原工作 owner，拒絕誤刪同名新物件', async () => {
  const { tempRoot, runtime, options } = fixture();
  const target = path.join(tempRoot, 'legacy.wav'), old = path.join(root, 'old.wav');
  await runtime.produceTemporaryFile(target, async output => { fs.writeFileSync(output, 'owned output'); });
  await runtime.close();
  fs.renameSync(target, old); fs.writeFileSync(target, 'foreign replacement');
  const reopened = createMediaIntakeRuntime(options);
  expect(reopened.cleanupGeneratedFile(target)).toBe(false);
  expect(fs.readFileSync(target, 'utf8')).toBe('foreign replacement');
  expect(fs.readFileSync(old, 'utf8')).toBe('owned output');
});

it('未知 TMP 檔沒有清理資格，但受管中央快取仍維持舊式清理', () => {
  const { tempRoot, cacheRoot, runtime } = fixture();
  const foreign = path.join(tempRoot, 'unknown.wav'), cached = path.join(cacheRoot, 'legacy.wav');
  fs.writeFileSync(foreign, 'foreign content'); fs.writeFileSync(cached, 'cache content');
  expect(runtime.cleanupGeneratedFile(foreign)).toBe(false);
  expect(fs.readFileSync(foreign, 'utf8')).toBe('foreign content');
  expect(runtime.cleanupGeneratedFile(cached)).toBe(true);
  expect(fs.existsSync(cached)).toBe(false);
});

it('獨占預留失敗後，同名外部檔保持 tombstone 並阻止退出遞迴清理', async () => {
  const { tempRoot, runtime, forgotten } = fixture();
  const target = path.join(tempRoot, 'legacy.wav'); fs.writeFileSync(target, 'foreign content');
  const writer = vi.fn();
  await expect(runtime.produceTemporaryFile(target, writer)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(writer).not.toHaveBeenCalled(); expect(forgotten).toContain(target);
  expect(runtime.hasUnsafeTemporaryFiles()).toBe(true);
  expect(runtime.cleanupGeneratedFile(target)).toBe(false);
  expect(fs.readFileSync(target, 'utf8')).toBe('foreign content');
});

it('同程序重建 runtime 後，仍可正常清理仍屬原工作的檔案', async () => {
  const { tempRoot, runtime, options } = fixture();
  const target = path.join(tempRoot, 'legacy.m4a');
  await runtime.produceTemporaryFile(target, async output => { fs.writeFileSync(output, 'owned output'); });
  await runtime.close();
  const reopened = createMediaIntakeRuntime(options);
  expect(reopened.cleanupGeneratedFile(target)).toBe(true);
  expect(fs.existsSync(target)).toBe(false);
  expect(reopened.cleanupGeneratedFile(target)).toBe(false);
});

it('舊式輸出的 8.3 別名不能繞過原本 owner 或取得清理權', async () => {
  const { tempRoot, runtime } = fixture();
  const target = path.join(tempRoot, 'legacy-output-long.wav'), alias = path.join(tempRoot, 'LEGACY~1.WAV');
  await runtime.produceTemporaryFile(target, async output => { fs.writeFileSync(output, 'owned output'); });
  const realpath = fs.realpathSync.native;
  const spy = vi.spyOn(fs.realpathSync, 'native').mockImplementation((file, ...args) => realpath(file === alias ? target : file, ...args));
  try {
    expect(runtime.isOwnedTemporary(alias)).toBe(true);
    expect(runtime.cleanupGeneratedFile(alias)).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('owned output');
  } finally { spy.mockRestore(); }
  expect(runtime.cleanupGeneratedFile(target)).toBe(true);
});

it('真 main 退出程序保留已交接後被取代的非波形暫存檔', async () => {
  const { tempRoot, runtime } = fixture();
  const target = path.join(tempRoot, 'legacy.m4a'), old = path.join(root, 'old.m4a');
  await runtime.produceTemporaryFile(target, async output => { fs.writeFileSync(output, 'owned output'); });
  fs.renameSync(target, old); fs.writeFileSync(target, 'foreign replacement');
  const main = fs.readFileSync(path.join(process.cwd(), 'electron/main.js'), 'utf8');
  const tree = parse(main, { ecmaVersion: 'latest', sourceType: 'script' });
  const registration = tree.body.find(node => node.expression?.callee?.object?.name === 'app'
    && node.expression.callee.property?.name === 'on' && node.expression.arguments?.[0]?.value === 'quit');
  let quit;
  vm.runInNewContext(main.slice(registration.start, registration.end), {
    app: { on: (_event, callback) => { quit = callback; } }, mpvHost: { dispose() {} },
    mediaIntakeRuntime: runtime, tempFiles: new Set([target]), TMP: tempRoot,
    TMP_OWNER: ExportLease.captureOutputDirectory(tempRoot), ExportLease, path, fs,
  });
  quit();
  expect(fs.readFileSync(target, 'utf8')).toBe('foreign replacement');
  expect(fs.readFileSync(old, 'utf8')).toBe('owned output');
});

it.each(['ffmpeg:proxy', 'ffmpeg:waveAudio', 'ffmpeg:extractAudio'])('%s 真 IPC writer 開始時路徑被替換，不覆寫或刪除新檔', async channel => {
  const { tempRoot, runtime, options } = fixture();
  const source = path.join(root, 'mother.mov'); fs.writeFileSync(source, 'mother source');
  options.fileAuthority.grantTrustedFile(source);
  const main = fs.readFileSync(path.join(process.cwd(), 'electron/main.js'), 'utf8');
  const tree = parse(main, { ecmaVersion: 'latest', sourceType: 'script' });
  const call = tree.body.map(node => node.expression).find(node => node?.callee?.object?.name === 'ipcMain'
    && node.callee.property?.name === 'handle' && node.arguments?.[0]?.value === channel);
  let handler, target, old;
  const execute = vi.fn(async (args, work) => {
    old = path.join(root, 'owned-reservation');
    fs.renameSync(target, old); fs.writeFileSync(target, 'foreign content');
    if (Number.isInteger(work.outputDescriptor)) fs.writeSync(work.outputDescriptor, Buffer.from('generated media'));
    else fs.writeFileSync(args.at(-1), 'generated media');
  });
  vm.runInNewContext(main.slice(call.start, call.end), {
    ipcMain: { handle: (_name, value) => { handler = value; } },
    requireReadablePath: createIpcGuards(options.fileAuthority).requireReadablePath,
    tmpPath: ext => (target = path.join(tempRoot, `legacy.${ext}`)),
    runFF: execute, mediaProbe: { describe: async () => ({ video: { width: 16, height: 16 }, audio: [{}] }) },
    mediaIntakeRuntime: runtime, buildIngestArgs, sourceAudioClockFilter, VENC: 'libx264',
  });
  await expect(handler({ sender: {} }, { path: source, duration: 1, idx: 0, codec: 'pcm_s16le' })).rejects.toThrow();
  expect(execute).toHaveBeenCalledOnce();
  expect(fs.readFileSync(target, 'utf8')).toBe('foreign content');
  expect(fs.readFileSync(old, 'utf8')).toBe('generated media');
});
