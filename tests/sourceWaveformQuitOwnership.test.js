import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { parse } = require('acorn');
const { FileAuthority } = require('../electron/file-authority.js');
const { createMediaIntakeRuntime } = require('../electron/media-intake-runtime.js');
const ExportLease = require('../electron/export-lease.js');
let root;
function realQuitCallback(runtime, tempFiles, tempRoot, tempOwner = ExportLease.captureOutputDirectory(tempRoot)) {
  const main = fs.readFileSync(path.join(process.cwd(), 'electron/main.js'), 'utf8');
  const tree = parse(main, { ecmaVersion: 'latest', sourceType: 'script' });
  const registration = tree.body.find(node => node.expression?.callee?.object?.name === 'app'
    && node.expression?.callee?.property?.name === 'on' && node.expression?.arguments?.[0]?.value === 'quit');
  expect(registration).toBeTruthy();
  let quit;
  vm.runInNewContext(main.slice(registration.start, registration.end), {
    app: { on: (_event, callback) => { quit = callback; } },
    mpvHost: { dispose() {} }, mediaIntakeRuntime: runtime, tempFiles, TMP: tempRoot, TMP_OWNER: tempOwner, ExportLease, path, fs,
  });
  return quit;
}
afterEach(() => {
  if (root && path.dirname(root) === fs.realpathSync(os.tmpdir()) && path.basename(root).startsWith('subtool-wave-quit-')) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  root = null;
});

it.each([false, true])('程式退出前波形已清理=%s 時，同名新檔不屬於本程序，不可被遞迴清理', async (cleanFirst) => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-wave-quit-'));
  const source = path.join(root, 'mother.mov'), tempRoot = path.join(root, 'temp');
  const cacheRoot = path.join(root, 'cache'), output = path.join(tempRoot, 'source-wave.wav');
  const original = path.join(root, 'original-wave.wav');
  fs.mkdirSync(tempRoot);
  fs.writeFileSync(source, 'mother source');
  const tempFiles = new Set([output]);
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    createTempPath: () => output, forgetTemporaryFile: file => tempFiles.delete(file),
    ffmpegExecution: { async execute(_args, options) { fs.writeSync(options.outputDescriptor, Buffer.from('wave content')); } },
  });
  const result = await runtime.waveform({ src: source, duration: 1, audio: [{ channels: 1 }] });
  if (cleanFirst) expect(runtime.cleanupGeneratedFile(result.wave)).toBe(true);
  else fs.renameSync(result.wave, original);
  fs.writeFileSync(result.wave, 'foreign content');

  realQuitCallback(runtime, tempFiles, tempRoot)();
  expect(fs.readFileSync(result.wave, 'utf8')).toBe('foreign content');
  if (!cleanFirst) expect(fs.readFileSync(original, 'utf8')).toBe('wave content');
});

it('正常關閉時，擁有的來源波形會清理，但未登記的子目錄須保留', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-wave-quit-'));
  const source = path.join(root, 'mother.mov'), tempRoot = path.join(root, 'temp');
  const cacheRoot = path.join(root, 'cache'), output = path.join(tempRoot, 'source-wave.wav');
  fs.mkdirSync(tempRoot); fs.writeFileSync(source, 'mother source');
  const tempFiles = new Set([output]);
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    createTempPath: () => output, forgetTemporaryFile: file => tempFiles.delete(file),
    ffmpegExecution: { async execute(_args, options) { fs.writeSync(options.outputDescriptor, Buffer.from('wave content')); } },
  });
  await runtime.waveform({ src: source, duration: 1, audio: [{ channels: 1 }] });
  fs.mkdirSync(path.join(tempRoot, 'native-shot-owned'));
  fs.writeFileSync(path.join(tempRoot, 'native-shot-owned', 'frame.jpg'), 'owned screenshot');
  realQuitCallback(runtime, tempFiles, tempRoot)();
  expect(fs.existsSync(output)).toBe(false);
  expect(fs.readFileSync(path.join(tempRoot, 'native-shot-owned', 'frame.jpg'), 'utf8')).toBe('owned screenshot');
});

it.each([false, true])('根目錄仍屬於本程序時，未擁有的檔案（列入 tempFiles=%s）不得在退出時被刪除', listed => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-wave-quit-'));
  const tempRoot = path.join(root, 'temp'), foreign = path.join(tempRoot, 'foreign.txt');
  fs.mkdirSync(tempRoot); fs.writeFileSync(foreign, 'foreign bytes');
  const runtime = createMediaIntakeRuntime({
    cacheRoot: path.join(root, 'cache'), tempRoot,
    fileAuthority: new FileAuthority({ internalDirectories: [tempRoot] }),
    ffmpegExecution: { async execute() {} },
  });
  realQuitCallback(runtime, new Set(listed ? [foreign] : []), tempRoot)();
  expect(fs.readFileSync(foreign, 'utf8')).toBe('foreign bytes');
});

it('空的私有根目錄可在正常退出時移除', () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-wave-quit-'));
  const tempRoot = path.join(root, 'temp'); fs.mkdirSync(tempRoot);
  const runtime = createMediaIntakeRuntime({
    cacheRoot: path.join(root, 'cache'), tempRoot,
    fileAuthority: new FileAuthority({ internalDirectories: [tempRoot] }),
    ffmpegExecution: { async execute() {} },
  });
  realQuitCallback(runtime, new Set(), tempRoot)();
  expect(fs.existsSync(tempRoot)).toBe(false);
});

it('私有根目錄被整體替換且新目錄沒有原波形時，退出不能刪除新目錄內容', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-wave-quit-'));
  const source = path.join(root, 'mother.mov'), tempRoot = path.join(root, 'temp');
  const cacheRoot = path.join(root, 'cache'), output = path.join(tempRoot, 'source-wave.wav');
  const oldTemp = path.join(root, 'original-temp'), foreign = path.join(tempRoot, 'foreign.txt');
  fs.mkdirSync(tempRoot); fs.writeFileSync(source, 'mother source');
  const tempFiles = new Set([output]);
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    createTempPath: () => output, forgetTemporaryFile: file => tempFiles.delete(file),
    ffmpegExecution: { async execute(_args, options) { fs.writeSync(options.outputDescriptor, Buffer.from('wave content')); } },
  });
  await runtime.waveform({ src: source, duration: 1, audio: [{ channels: 1 }] });
  const tempOwner = ExportLease.captureOutputDirectory(tempRoot);
  fs.renameSync(tempRoot, oldTemp); fs.mkdirSync(tempRoot); fs.writeFileSync(foreign, 'foreign directory content');
  realQuitCallback(runtime, tempFiles, tempRoot, tempOwner)();
  expect(fs.readFileSync(foreign, 'utf8')).toBe('foreign directory content');
  expect(fs.readFileSync(path.join(oldTemp, 'source-wave.wav'), 'utf8')).toBe('wave content');
});

it.each(['directory', 'junction', 'missing'])('沒有波形時 TMP 被替換為 %s，退出不得碰新目錄或舊目錄', async kind => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-wave-quit-'));
  const tempRoot = path.join(root, 'temp'), oldTemp = path.join(root, 'original-temp');
  const foreignRoot = path.join(root, 'foreign-root'), foreign = path.join(tempRoot, 'legacy.wav');
  fs.mkdirSync(tempRoot); fs.writeFileSync(path.join(tempRoot, 'own.txt'), 'original root');
  const tempOwner = ExportLease.captureOutputDirectory(tempRoot);
  const runtime = createMediaIntakeRuntime({
    cacheRoot: path.join(root, 'cache'), tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [tempRoot] }),
    ffmpegExecution: { async execute() {} },
  });
  const tempFiles = new Set([foreign]);
  fs.renameSync(tempRoot, oldTemp);
  if (kind === 'directory') fs.mkdirSync(tempRoot);
  if (kind === 'junction') { fs.mkdirSync(foreignRoot); fs.symlinkSync(foreignRoot, tempRoot, 'junction'); }
  if (kind !== 'missing') fs.writeFileSync(foreign, 'foreign root content');
  realQuitCallback(runtime, tempFiles, tempRoot, tempOwner)();
  if (kind !== 'missing') expect(fs.readFileSync(foreign, 'utf8')).toBe('foreign root content');
  expect(fs.readFileSync(path.join(oldTemp, 'own.txt'), 'utf8')).toBe('original root');
});

it('TMP 根目錄無法核對時，不進行逐檔或遞迴清理', () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-wave-quit-'));
  const tempRoot = path.join(root, 'temp'), file = path.join(tempRoot, 'legacy.wav');
  fs.mkdirSync(tempRoot); fs.writeFileSync(file, 'keep until identity can be verified');
  const tempOwner = ExportLease.captureOutputDirectory(tempRoot);
  const runtime = createMediaIntakeRuntime({
    cacheRoot: path.join(root, 'cache'), tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [tempRoot] }),
    ffmpegExecution: { async execute() {} },
  });
  const quit = realQuitCallback(runtime, new Set([file]), tempRoot, tempOwner);
  const realLstat = fs.lstatSync;
  const spy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => {
    if (target === tempOwner.path) throw Object.assign(new Error('not readable'), { code: 'EACCES' });
    return realLstat(target, ...args);
  });
  try { quit(); } finally { spy.mockRestore(); }
  expect(fs.readFileSync(file, 'utf8')).toBe('keep until identity can be verified');
});

it('來源波形 writer 尚未 close 時，不在退出通知中移除其輸出或私有目錄', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-wave-quit-'));
  const source = path.join(root, 'mother.mov'), tempRoot = path.join(root, 'temp');
  const cacheRoot = path.join(root, 'cache'), output = path.join(tempRoot, 'source-wave.wav');
  fs.mkdirSync(tempRoot); fs.writeFileSync(source, 'mother source');
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const execute = vi.fn(async (_args, options) => { fs.writeSync(options.outputDescriptor, Buffer.from('wave content')); await pending; });
  const tempFiles = new Set([output]);
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    createTempPath: () => output, forgetTemporaryFile: file => tempFiles.delete(file), ffmpegExecution: { execute },
  });
  const work = runtime.waveform({ src: source, duration: 1, audio: [{ channels: 1 }] });
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  realQuitCallback(runtime, tempFiles, tempRoot)();
  try { expect(fs.readFileSync(output, 'utf8')).toBe('wave content'); }
  finally { release(); await expect(work).rejects.toThrow(); }
});

it('完成通知同步換檔並退出時，不刪除新檔或交接其路徑', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-wave-quit-'));
  const source = path.join(root, 'mother.mov'), tempRoot = path.join(root, 'temp');
  const cacheRoot = path.join(root, 'cache'), output = path.join(tempRoot, 'source-wave.wav');
  const original = path.join(root, 'original-wave.wav');
  fs.mkdirSync(tempRoot); fs.writeFileSync(source, 'mother source');
  const tempFiles = new Set([output]);
  let runtime;
  runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    createTempPath: () => output, forgetTemporaryFile: file => tempFiles.delete(file),
    sendProgress: (_target, progress) => {
      if (!progress.done || progress.outcome !== 'success') return;
      fs.renameSync(output, original); fs.writeFileSync(output, 'foreign content');
      realQuitCallback(runtime, tempFiles, tempRoot)();
    },
    ffmpegExecution: { async execute(_args, options) { fs.writeSync(options.outputDescriptor, Buffer.from('wave content')); } },
  });
  await expect(runtime.waveform({ src: source, duration: 1, audio: [{ channels: 1 }] })).rejects.toThrow();
  expect(fs.readFileSync(output, 'utf8')).toBe('foreign content');
  expect(fs.readFileSync(original, 'utf8')).toBe('wave content');
});
