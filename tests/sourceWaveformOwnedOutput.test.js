import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { FileAuthority } = require('../electron/file-authority.js');
const { createMediaIntakeRuntime } = require('../electron/media-intake-runtime.js');
const { captureOutputDirectory } = require('../electron/export-lease.js');
let root;
afterEach(() => {
  if (root && path.dirname(root) === fs.realpathSync(os.tmpdir()) && path.basename(root).startsWith('subtool-wave-owner-')) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  root = null;
});

it('來源波形 writer 啟動時暫存路徑被取代，不覆寫新物件', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-wave-owner-'));
  const source = path.join(root, 'mother.mov');
  const tempRoot = path.join(root, 'temp');
  const cacheRoot = path.join(root, 'cache');
  const output = path.join(tempRoot, 'source-wave.wav');
  const original = path.join(tempRoot, 'original-wave.wav');
  fs.mkdirSync(tempRoot);
  fs.writeFileSync(source, 'mother source');
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    createTempPath: () => output,
    ffmpegExecution: { async execute(args, options) {
      // An external writer replaces the reserved directory entry immediately
      // before FFmpeg opens its output. Keep the original inode alive.
      fs.renameSync(output, original);
      fs.writeFileSync(output, 'foreign content');
      if (options.outputDescriptor !== undefined) fs.writeSync(options.outputDescriptor, Buffer.from('wave content'));
      else fs.writeFileSync(args.at(-1), 'wave content');
    } },
  });
  await expect(runtime.waveform({ src: source, duration: 1, audio: [{ channels: 1 }] })).rejects.toThrow();
  expect(fs.readFileSync(output, 'utf8')).toBe('foreign content');
  expect(fs.readFileSync(original, 'utf8')).toBe('wave content');
});

it.each(['sync', 'microtask'])('成功進度通知 %s 取代暫存檔時，不交接或刪除新的同名檔', async (timing) => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-wave-owner-'));
  const source = path.join(root, 'mother.mov');
  const tempRoot = path.join(root, 'temp');
  const cacheRoot = path.join(root, 'cache');
  const output = path.join(tempRoot, 'source-wave.wav');
  const original = path.join(tempRoot, 'original-wave.wav');
  fs.mkdirSync(tempRoot);
  fs.writeFileSync(source, 'mother source');
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    createTempPath: () => output,
    sendProgress: (_target, progress) => {
      if (!progress.done || progress.outcome !== 'success') return;
      const replace = () => { fs.renameSync(output, original); fs.writeFileSync(output, 'foreign content'); };
      if (timing === 'sync') replace();
      else queueMicrotask(replace);
    },
    ffmpegExecution: { async execute(_args, options) {
      fs.writeSync(options.outputDescriptor, Buffer.from('wave content'));
    } },
  });
  await expect(runtime.waveform({ src: source, duration: 1, audio: [{ channels: 1 }] })).rejects.toThrow();
  expect(fs.readFileSync(output, 'utf8')).toBe('foreign content');
  expect(fs.readFileSync(original, 'utf8')).toBe('wave content');
});

it('完成通知後母素材變更，回收本工作 WAV 而不交接舊波形', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-wave-owner-'));
  const source = path.join(root, 'mother.mov'), tempRoot = path.join(root, 'temp');
  const cacheRoot = path.join(root, 'cache'), output = path.join(tempRoot, 'source-wave.wav');
  fs.mkdirSync(tempRoot);
  fs.writeFileSync(source, 'mother source');
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    createTempPath: () => output,
    sendProgress: (_target, progress) => {
      if (progress.done && progress.outcome === 'success') queueMicrotask(() => fs.writeFileSync(source, 'new source content'));
    },
    ffmpegExecution: { async execute(_args, options) { fs.writeSync(options.outputDescriptor, Buffer.from('wave content')); } },
  });
  await expect(runtime.waveform({ src: source, duration: 1, audio: [{ channels: 1 }] })).rejects.toThrow(/變更/);
  expect(fs.existsSync(output)).toBe(false);
  expect(fs.readFileSync(source, 'utf8')).toBe('new source content');
});

it('完成通知後失去工作資格，回收本工作 WAV 而不交接', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-wave-owner-'));
  const source = path.join(root, 'mother.mov'), tempRoot = path.join(root, 'temp');
  const cacheRoot = path.join(root, 'cache'), output = path.join(tempRoot, 'source-wave.wav');
  fs.mkdirSync(tempRoot);
  fs.writeFileSync(source, 'mother source');
  let cancelled = false;
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    createTempPath: () => output,
    sendProgress: (_target, progress) => {
      if (progress.done && progress.outcome === 'success') queueMicrotask(() => { cancelled = true; });
    },
    ffmpegExecution: { async execute(_args, options) { fs.writeSync(options.outputDescriptor, Buffer.from('wave content')); } },
  });
  await expect(runtime.waveform({ src: source, duration: 1, audio: [{ channels: 1 }] }, { isCancelled: () => cancelled })).rejects.toThrow();
  expect(fs.existsSync(output)).toBe(false);
});

it.each([false, true])('正式交接後同路徑被替換時，%s 次前清理不會刪除新物件', async (cleanFirst) => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-wave-owner-'));
  const source = path.join(root, 'mother.mov'), tempRoot = path.join(root, 'temp');
  const cacheRoot = path.join(root, 'cache'), output = path.join(tempRoot, 'source-wave.wav');
  const original = path.join(tempRoot, 'original-wave.wav');
  fs.mkdirSync(tempRoot);
  fs.writeFileSync(source, 'mother source');
  const forgotten = [];
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    createTempPath: () => output,
    forgetTemporaryFile: file => forgotten.push(file),
    ffmpegExecution: { async execute(_args, options) { fs.writeSync(options.outputDescriptor, Buffer.from('wave content')); } },
  });
  const result = await runtime.waveform({ src: source, duration: 1, audio: [{ channels: 1 }] });
  if (cleanFirst) expect(runtime.cleanupGeneratedFile(result.wave)).toBe(true);
  else fs.renameSync(output, original);
  fs.writeFileSync(output, 'foreign content');
  expect(runtime.cleanupGeneratedFile(result.wave)).toBe(false);
  expect(runtime.cleanupGeneratedFile(result.wave)).toBe(false);
  expect(fs.readFileSync(output, 'utf8')).toBe('foreign content');
  expect(forgotten).toContain(output);
  if (!cleanFirst) expect(fs.readFileSync(original, 'utf8')).toBe('wave content');
});

it('波形路徑清理後不可在同一 runtime 重用，以免舊清理刪除新工作', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-wave-owner-'));
  const source = path.join(root, 'mother.mov'), tempRoot = path.join(root, 'temp');
  const cacheRoot = path.join(root, 'cache'), output = path.join(tempRoot, 'source-wave.wav');
  fs.mkdirSync(tempRoot); fs.writeFileSync(source, 'mother source');
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    createTempPath: () => output,
    ffmpegExecution: { async execute(_args, options) { fs.writeSync(options.outputDescriptor, Buffer.from('wave content')); } },
  });
  const result = await runtime.waveform({ src: source, duration: 1, audio: [{ channels: 1 }] });
  expect(runtime.cleanupGeneratedFile(result.wave)).toBe(true);
  await expect(runtime.waveform({ src: source, duration: 1, audio: [{ channels: 1 }] })).rejects.toThrow(/重用/);
  expect(fs.existsSync(output)).toBe(false);
});

it('不同私有路徑可正常產生多段並分別清理', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-wave-owner-'));
  const source = path.join(root, 'mother.mov'), tempRoot = path.join(root, 'temp');
  const cacheRoot = path.join(root, 'cache');
  fs.mkdirSync(tempRoot); fs.writeFileSync(source, 'mother source');
  let sequence = 0;
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    createTempPath: () => path.join(tempRoot, `wave-${++sequence}.wav`),
    ffmpegExecution: { async execute(_args, options) { fs.writeSync(options.outputDescriptor, Buffer.from('wave content')); } },
  });
  const first = await runtime.waveform({ src: source, duration: 120, start: 0, length: 60, audio: [{ channels: 1 }] });
  const second = await runtime.waveform({ src: source, duration: 120, start: 60, length: 60, audio: [{ channels: 1 }] });
  expect(first.wave).not.toBe(second.wave);
  expect(fs.readFileSync(first.wave, 'utf8')).toBe('wave content');
  expect(fs.readFileSync(second.wave, 'utf8')).toBe('wave content');
  expect(runtime.cleanupGeneratedFile(first.wave)).toBe(true);
  expect(fs.readFileSync(second.wave, 'utf8')).toBe('wave content');
  expect(runtime.cleanupGeneratedFile(second.wave)).toBe(true);
  expect(runtime.hasUnsafeSourceWaveFiles()).toBe(false);
});

it('來源波形消失後不會誤刪後來新建的同名檔案', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-wave-owner-'));
  const source = path.join(root, 'mother.mov'), tempRoot = path.join(root, 'temp');
  const cacheRoot = path.join(root, 'cache'), output = path.join(tempRoot, 'source-wave.wav');
  fs.mkdirSync(tempRoot); fs.writeFileSync(source, 'mother source');
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    createTempPath: () => output,
    ffmpegExecution: { async execute(_args, options) { fs.writeSync(options.outputDescriptor, Buffer.from('wave content')); } },
  });
  const result = await runtime.waveform({ src: source, duration: 1, audio: [{ channels: 1 }] });
  fs.unlinkSync(output);
  expect(runtime.cleanupGeneratedFile(result.wave)).toBe(false);
  expect(runtime.hasUnsafeSourceWaveFiles()).toBe(false);
  fs.writeFileSync(output, 'foreign content');
  expect(runtime.cleanupGeneratedFile(result.wave)).toBe(false);
  expect(runtime.hasUnsafeSourceWaveFiles()).toBe(true);
  expect(fs.readFileSync(output, 'utf8')).toBe('foreign content');
});

it('波形的父目錄被替換時，即使新路徑是同 inode 的硬連結也不能刪除', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-wave-owner-'));
  const source = path.join(root, 'mother.mov'), tempRoot = path.join(root, 'temp');
  const cacheRoot = path.join(root, 'cache'), output = path.join(tempRoot, 'source-wave.wav');
  const oldTemp = path.join(root, 'original-temp'), original = path.join(oldTemp, 'source-wave.wav');
  fs.mkdirSync(tempRoot); fs.writeFileSync(source, 'mother source');
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    createTempPath: () => output,
    ffmpegExecution: { async execute(_args, options) { fs.writeSync(options.outputDescriptor, Buffer.from('wave content')); } },
  });
  const result = await runtime.waveform({ src: source, duration: 1, audio: [{ channels: 1 }] });
  fs.renameSync(tempRoot, oldTemp); fs.mkdirSync(tempRoot); fs.linkSync(original, output);
  expect(runtime.cleanupGeneratedFile(result.wave)).toBe(false);
  expect(runtime.hasUnsafeSourceWaveFiles()).toBe(true);
  expect(fs.readFileSync(output, 'utf8')).toBe('wave content');
  expect(fs.readFileSync(original, 'utf8')).toBe('wave content');
});

it('writer 執行期間父目錄被替換時，不刪除新目錄的同 inode 連結', async (context) => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-wave-owner-'));
  const source = path.join(root, 'mother.mov'), tempRoot = path.join(root, 'temp');
  const cacheRoot = path.join(root, 'cache'), output = path.join(tempRoot, 'source-wave.wav');
  const oldTemp = path.join(root, 'original-temp'), original = path.join(oldTemp, 'source-wave.wav');
  fs.mkdirSync(tempRoot); fs.writeFileSync(source, 'mother source');
  let unsupported = false;
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    createTempPath: () => output,
    ffmpegExecution: { async execute(_args, options) {
      fs.writeSync(options.outputDescriptor, Buffer.from('wave content'));
      try { fs.renameSync(tempRoot, oldTemp); }
      catch (error) {
        if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { unsupported = true; return; }
        throw error;
      }
      fs.mkdirSync(tempRoot); fs.linkSync(original, output);
    } },
  });
  let result, failure;
  try { result = await runtime.waveform({ src: source, duration: 1, audio: [{ channels: 1 }] }); }
  catch (error) { failure = error; }
  if (unsupported) {
    expect(runtime.cleanupGeneratedFile(result.wave)).toBe(true);
    context.skip('此 Windows 檔案系統不允許已開啟檔案的父目錄改名');
    return;
  }
  expect(failure).toBeTruthy();
  expect(fs.readFileSync(output, 'utf8')).toBe('wave content');
  expect(fs.readFileSync(original, 'utf8')).toBe('wave content');
});

it('writer 執行期間父目錄身分無法再證明時，失敗清理不刪除目錄項', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-wave-owner-'));
  const source = path.join(root, 'mother.mov'), tempRoot = path.join(root, 'temp');
  const cacheRoot = path.join(root, 'cache'), output = path.join(tempRoot, 'source-wave.wav');
  fs.mkdirSync(tempRoot); fs.writeFileSync(source, 'mother source');
  let changed = false;
  const realLstat = fs.lstatSync;
  const spy = vi.spyOn(fs, 'lstatSync').mockImplementation((file, ...args) => {
    const stat = realLstat(file, ...args);
    if (!changed || path.resolve(String(file)).toLowerCase() !== tempRoot.toLowerCase()) return stat;
    return new Proxy(stat, { get(target, property, receiver) {
      return property === 'ino' ? target.ino + 1n : Reflect.get(target, property, receiver);
    } });
  });
  try {
    const runtime = createMediaIntakeRuntime({
      cacheRoot, tempRoot, allowSidecarCache: false,
      fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
      createTempPath: () => output,
      ffmpegExecution: { async execute(_args, options) { fs.writeSync(options.outputDescriptor, Buffer.from('wave content')); changed = true; } },
    });
    await expect(runtime.waveform({ src: source, duration: 1, audio: [{ channels: 1 }] })).rejects.toThrow();
    expect(fs.readFileSync(output, 'utf8')).toBe('wave content');
    expect(runtime.cleanupGeneratedFile(output)).toBe(false);
    expect(runtime.hasUnsafeSourceWaveFiles()).toBe(true);
  } finally { spy.mockRestore(); }
});

it('首次來源波形工作前私有根已換檔時，不採納替換後目錄或啟動 writer', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-wave-owner-'));
  const source = path.join(root, 'mother.mov'), tempRoot = path.join(root, 'temp');
  const cacheRoot = path.join(root, 'cache'), output = path.join(tempRoot, 'source-wave.wav');
  fs.mkdirSync(tempRoot); fs.writeFileSync(source, 'mother source');
  const rootAuthority = captureOutputDirectory(tempRoot), writer = vi.fn();
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, tempRootAuthority: rootAuthority, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    createTempPath: () => output, ffmpegExecution: { execute: writer },
  });
  fs.renameSync(tempRoot, path.join(root, 'old-temp')); fs.mkdirSync(tempRoot);
  fs.writeFileSync(path.join(tempRoot, 'foreign.txt'), 'foreign content');
  await expect(runtime.waveform({ src: source, duration: 1, audio: [{ channels: 1 }] })).rejects.toThrow();
  expect(writer).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(tempRoot, 'foreign.txt'), 'utf8')).toBe('foreign content');
});

it('完成進度同步呼叫清理不能提前移除尚未交接的波形', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-wave-owner-'));
  const source = path.join(root, 'mother.mov'), tempRoot = path.join(root, 'temp');
  const cacheRoot = path.join(root, 'cache'), output = path.join(tempRoot, 'source-wave.wav');
  fs.mkdirSync(tempRoot); fs.writeFileSync(source, 'mother source');
  let runtime, duringCompletion;
  runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    createTempPath: () => output,
    sendProgress: (_target, progress) => {
      if (progress.done && progress.outcome === 'success') duringCompletion = runtime.cleanupGeneratedFile(output);
    },
    ffmpegExecution: { async execute(_args, options) { fs.writeSync(options.outputDescriptor, Buffer.from('wave content')); } },
  });
  const result = await runtime.waveform({ src: source, duration: 1, audio: [{ channels: 1 }] });
  expect(duringCompletion).toBe(false);
  expect(fs.readFileSync(result.wave, 'utf8')).toBe('wave content');
  expect(runtime.cleanupGeneratedFile(result.wave)).toBe(true);
});

it('進度通知同步啟動較新的同路徑工作時，較舊呼叫不得移除新 owner', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-wave-owner-'));
  const source = path.join(root, 'mother.mov'), tempRoot = path.join(root, 'temp');
  const cacheRoot = path.join(root, 'cache'), output = path.join(tempRoot, 'source-wave.wav');
  fs.mkdirSync(tempRoot); fs.writeFileSync(source, 'mother source');
  let runtime, newer, release, entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  const request = { src: source, duration: 1, audio: [{ channels: 1 }] };
  runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    createTempPath: () => output,
    sendProgress: (_target, progress) => {
      if (!entered && !progress.done) { entered = true; newer = runtime.waveform(request); }
    },
    ffmpegExecution: { async execute(_args, options) {
      fs.writeSync(options.outputDescriptor, Buffer.from('new owner content')); await gate;
    } },
  });
  const older = runtime.waveform(request);
  try {
    await expect(older).rejects.toThrow(/重用/);
    expect(runtime.cleanupGeneratedFile(output)).toBe(false);
    expect(fs.readFileSync(output, 'utf8')).toBe('new owner content');
  } finally { release(); }
  const result = await newer;
  expect(fs.readFileSync(result.wave, 'utf8')).toBe('new owner content');
  expect(runtime.cleanupGeneratedFile(result.wave)).toBe(true);
});

it('無法核對來源波形檔時不刪除並保留退出防線', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-wave-owner-'));
  const source = path.join(root, 'mother.mov'), tempRoot = path.join(root, 'temp');
  const cacheRoot = path.join(root, 'cache'), output = path.join(tempRoot, 'source-wave.wav');
  fs.mkdirSync(tempRoot); fs.writeFileSync(source, 'mother source');
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    createTempPath: () => output,
    ffmpegExecution: { async execute(_args, options) { fs.writeSync(options.outputDescriptor, Buffer.from('wave content')); } },
  });
  const result = await runtime.waveform({ src: source, duration: 1, audio: [{ channels: 1 }] });
  const realLstat = fs.lstatSync;
  const spy = vi.spyOn(fs, 'lstatSync').mockImplementation((file, ...args) => {
    if (file === output) throw Object.assign(new Error('not readable'), { code: 'EACCES' });
    return realLstat(file, ...args);
  });
  try {
    expect(runtime.cleanupGeneratedFile(result.wave)).toBe(false);
    expect(runtime.hasUnsafeSourceWaveFiles()).toBe(true);
  } finally { spy.mockRestore(); }
  expect(fs.readFileSync(output, 'utf8')).toBe('wave content');
});
