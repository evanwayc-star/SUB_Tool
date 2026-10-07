// @subtool-ci windows
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { parse } from 'acorn';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Seq } from '../src/sequence.js';

const require = createRequire(import.meta.url);
const { createClipAudioCache, validateReverseAudioRequest } = require('../electron/clip-audio-cache.js');
const { FileAuthority } = require('../electron/file-authority.js');
const { createFFmpegExecution } = require('../electron/ffmpeg-execution-engine.js');
const { createIpcGuards } = require('../electron/ipc-guards.js');
const FFMPEG = path.resolve('electron/ffmpeg/ffmpeg.exe');
const directories = [];

function wav(value = 0.3, duration = 1, channels = 2) {
  const length = Math.round(48000 * duration), bytes = Buffer.alloc(44 + length * channels * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(48000 * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(length * channels * 2, 40);
  for (let i = 44; i < bytes.length; i += 2) bytes.writeInt16LE(Math.round(value * 32767), i);
  return bytes;
}
function fixture(extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-clip-audio-test-'));
  directories.push(directory);
  const source = path.join(directory, 'mother.wav');
  fs.writeFileSync(source, wav());
  const authority = new FileAuthority(); authority.grantTrustedFile(source, { read: true, write: false });
  const execute = vi.fn(async args => fs.writeFileSync(args.at(-1), wav()));
  const options = { cacheRoot: path.join(directory, 'reverse'), fileAuthority: authority, execute, ...extra };
  return { directory, source, authority, execute, options, runtime: createClipAudioCache(options),
    request: { path: source, in: 0, out: 1, sourceStream: 0 } };
}
function preload() {
  let api;
  const invoke = vi.fn().mockResolvedValue({});
  vm.runInNewContext(fs.readFileSync('electron/preload.js', 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_, exposed) => { api = exposed; } },
      ipcRenderer: { invoke, on: vi.fn(), send: vi.fn() }, webUtils: {} }),
    Promise, ArrayBuffer, Uint8Array, TypeError, RangeError,
  });
  return { api, invoke };
}
afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) {
    const resolved = fs.realpathSync(directory);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('subtool-clip-audio-test-')) {
      throw new Error('拒絕清除未驗證的測試路徑');
    }
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
describe('反轉片段預覽音訊', () => {
  it('來源與快取播放器的時間轉換共用 Seq，包含裁切、offset 和變速', () => {
    const clip = { in: 2, out: 10, offset: 5, speed: 2, reverse: true };
    expect(Seq.toReverseAudio(5, clip)).toBe(0);
    expect(Seq.toReverseAudio(6.25, clip)).toBe(2.5);
    expect(Seq.toReverseAudio(9, clip)).toBe(8);
  });
  it.each([{ in: -1 }, { in: NaN }, { in: '0' }, { out: 0 }, { out: Infinity },
    { path: '' }, { path: 'bad\0file' }, { sourceStream: -1 }, { sourceStream: 256 }])
  ('preload 和 native 都拒絕非法參數 %j', invalid => {
    const request = { path: 'C:/mother.mov', in: 0, out: 1, sourceStream: 0, ...invalid };
    expect(() => validateReverseAudioRequest(request)).toThrow();
    const bridge = preload();
    expect(() => bridge.api.reverseAudio(request)).toThrow();
    expect(bridge.invoke).not.toHaveBeenCalled();
  });
  it('preload 不接受 caller 指定輸出路徑', async () => {
    const bridge = preload();
    const request = { path: 'C:/mother.mov', in: 2, out: 3, sourceStream: 1 };
    await bridge.api.reverseAudio({ ...request, output: 'C:/forbidden.wav' });
    expect(bridge.invoke).toHaveBeenCalledWith('audio:reverse-clip', request);
  });
  it('main IPC 必須在工作開始前核對來源 read capability', async () => {
    const source = fs.readFileSync('electron/main.js', 'utf8');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
    const registration = ast.body.find(node => node.type === 'ExpressionStatement'
      && node.expression.type === 'CallExpression' && node.expression.callee.object?.name === 'ipcMain'
      && node.expression.arguments[0]?.value === 'audio:reverse-clip');
    expect(registration).toBeDefined();
    const authority = new FileAuthority(), reverse = vi.fn().mockResolvedValue({ duration: 1 });
    let handler;
    vm.runInNewContext(source.slice(registration.start, registration.end), {
      ipcMain: { handle: (_, callback) => { handler = callback; } }, validateReverseAudioRequest,
      requireReadablePath: createIpcGuards(authority).requireReadablePath, clipAudioCache: { reverse },
    });
    const request = { path: 'C:/mother.wav', in: 0, out: 1, sourceStream: 0 };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => handler({}, request)).toThrow(/未授權/);
      expect(reverse).not.toHaveBeenCalled();
      authority.grantTrustedFile(request.path, { read: true, write: false });
      await handler({}, request);
      expect(reverse).toHaveBeenCalledWith(request);
    } finally { warn.mockRestore(); }
  });
  it('完整 PCM 才授權，去重並在新 runtime 中復用；來源或裁切修改使快取失效', async () => {
    const f = fixture();
    const [first, second] = await Promise.all([f.runtime.reverse(f.request), f.runtime.reverse(f.request)]);
    expect(second).toEqual(first); expect(first.duration).toBe(1);
    expect(f.authority.canRead(first.path)).toBe(true);
    expect(f.authority.canWrite(first.path)).toBe(false);
    expect(await createClipAudioCache(f.options).reverse(f.request)).toEqual(first);
    expect(f.execute).toHaveBeenCalledOnce();
    fs.writeFileSync(f.source, wav(0.6));
    const changed = await f.runtime.reverse(f.request);
    expect(changed.path).not.toBe(first.path);
    f.execute.mockImplementationOnce(async args => fs.writeFileSync(args.at(-1), wav(0.6, 0.5)));
    expect((await f.runtime.reverse({ ...f.request, in: 0.5 })).path).not.toBe(changed.path);
  });
  it('未授權、關閉、短缺／損毀 PCM 和來源途中修改不發布，失敗可以重試', async () => {
    const f = fixture();
    await expect(f.runtime.reverse({ ...f.request, path: path.join(f.directory, 'forbidden.wav') })).rejects.toThrow(/未授權/);
    await expect(createClipAudioCache({ ...f.options, isClosing: () => true }).reverse(f.request)).rejects.toMatchObject({ name: 'AbortError' });
    f.execute.mockImplementationOnce(async args => fs.writeFileSync(args.at(-1), wav().subarray(0, 80)));
    await expect(f.runtime.reverse(f.request)).rejects.toThrow(/完整/);
    expect(fs.readdirSync(f.options.cacheRoot)).toEqual([]);
    f.execute.mockImplementationOnce(async args => {
      fs.writeFileSync(args.at(-1), wav()); fs.writeFileSync(f.source, wav(0.7));
    });
    await expect(f.runtime.reverse(f.request)).rejects.toThrow(/變更/);
    expect(fs.readdirSync(f.options.cacheRoot)).toEqual([]);
    await expect(f.runtime.reverse(f.request)).resolves.toMatchObject({ duration: 1 });
  });
  it('逾時等待 FFmpeg close 才釋放 staging，仍由全域 execution 持有程序', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = fixture(), child = new EventEmitter();
    child.stderr = new EventEmitter(); child.kill = vi.fn();
    let staging, closing = false, processStarted;
    const ready = new Promise(resolve => { processStarted = resolve; });
    const execution = createFFmpegExecution({ getFFmpegPath: () => 'trusted-ffmpeg', getUserDataDir: () => f.directory,
      spawnDirect: (_, args) => { staging = args.at(-1); fs.writeFileSync(staging, wav()); return child; } });
    const runtime = createClipAudioCache({ ...f.options,
      execute: (args, options) => execution.execute(args, { ...options, onProcess: process => {
        options.onProcess(process); processStarted();
      } }), isClosing: () => closing, timeoutMs: 50, terminationGraceMs: 20 });
    const pending = runtime.reverse(f.request), outcome = pending.catch(error => error);
    try {
      await Promise.race([ready, pending.then(() => { throw new Error('未建立程序就已完成請求'); })]);
      expect(staging).toBeDefined();
      await vi.advanceTimersByTimeAsync(50);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(fs.existsSync(staging)).toBe(true);
      expect(runtime.activeCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(20);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      child.emit('close', null, 'SIGKILL');
      expect(await outcome).toMatchObject({ code: 'CLIP_AUDIO_TIMEOUT' });
      expect(fs.existsSync(staging)).toBe(false);
      expect(runtime.activeCount()).toBe(0);
    } finally {
      closing = true;
      const shutdown = execution.cancelAllAndWait();
      child.emit('close', null, 'SIGKILL');
      try { await shutdown; }
      finally { await outcome; await runtime.waitForIdle(); }
    }
  });
  it('shutdown 等待快取 owner 清除 staging，不能只等 FFmpeg close', async () => {
    const f = fixture(), child = new EventEmitter();
    child.stderr = new EventEmitter(); child.kill = vi.fn();
    let staging, closing = false, finishCleanup, cleanupStarted, processStarted;
    const ready = new Promise(resolve => { processStarted = resolve; });
    const cleanupGate = new Promise(resolve => { finishCleanup = resolve; });
    const cleanupEntered = new Promise(resolve => { cleanupStarted = resolve; });
    const originalUnlink = fsp.unlink;
    const unlink = vi.spyOn(fsp, 'unlink').mockImplementation(async file => {
      if (file === staging) { cleanupStarted(); await cleanupGate; }
      return originalUnlink(file);
    });
    const execution = createFFmpegExecution({ getFFmpegPath: () => 'trusted-ffmpeg', getUserDataDir: () => f.directory,
      spawnDirect: (_, args) => { staging = args.at(-1); fs.writeFileSync(staging, wav()); return child; } });
    const runtime = createClipAudioCache({ ...f.options,
      execute: (args, options) => execution.execute(args, { ...options, onProcess: process => {
        options.onProcess(process); processStarted();
      } }), isClosing: () => closing });
    const pending = runtime.reverse(f.request);
    const outcome = pending.catch(error => error);
    try {
      await Promise.race([ready, pending.then(() => { throw new Error('未建立程序就已完成請求'); })]);
      expect(staging).toBeDefined();
      closing = true;
      const shutdown = execution.cancelAllAndWait();
      child.emit('close', null, 'SIGTERM');
      await shutdown;
      await Promise.race([cleanupEntered, pending.then(() => { throw new Error('未進入 staging 清理就已完成請求'); })]);
      let idle = false;
      const waiting = runtime.waitForIdle().then(() => { idle = true; });
      await new Promise(resolve => setImmediate(resolve));
      expect(idle).toBe(false);
      expect(fs.existsSync(staging)).toBe(true);
      await expect(runtime.reverse(f.request)).rejects.toMatchObject({ name: 'AbortError' });
      finishCleanup(); expect(await outcome).toMatchObject({ name: 'AbortError' }); await waiting;
      expect(fs.existsSync(staging)).toBe(false);
      expect(runtime.activeCount()).toBe(0);
    } finally {
      closing = true;
      const shutdown = execution.cancelAllAndWait();
      child.emit('close', null, 'SIGKILL');
      finishCleanup();
      try {
        try { await shutdown; }
        finally { await outcome; await runtime.waitForIdle(); }
      }
      finally { unlink.mockRestore(); }
    }
  });
  it('shutdown 等待已進入但尚未完成 fingerprint 的請求，再拒絕建立 staging', async () => {
    const f = fixture();
    let closing = false, resumeRead, readStarted;
    const gate = new Promise(resolve => { resumeRead = resolve; });
    const entered = new Promise(resolve => { readStarted = resolve; });
    const originalOpen = fsp.open;
    const open = vi.spyOn(fsp, 'open').mockImplementation(async (...args) => {
      if (args[0] === f.source) { readStarted(); await gate; }
      return originalOpen(...args);
    });
    const runtime = createClipAudioCache({ ...f.options, isClosing: () => closing });
    const outcome = runtime.reverse(f.request).catch(error => error);
    try {
      await entered; closing = true;
      let idle = false;
      const waiting = runtime.waitForIdle().then(() => { idle = true; });
      await new Promise(resolve => setImmediate(resolve));
      expect(idle).toBe(false);
      expect(f.execute).not.toHaveBeenCalled();
      resumeRead(); expect(await outcome).toMatchObject({ name: 'AbortError' }); await waiting;
      expect(fs.existsSync(f.options.cacheRoot)).toBe(false);
    } finally {
      resumeRead(); await outcome; open.mockRestore();
    }
  });
});

describe.skipIf(!fs.existsSync(FFMPEG))('實際反向音訊快取內容', () => {
  it('反轉區間完全位於音訊 EOF 後，仍產生完整時長的靜音 PCM', async () => {
    const f = fixture();
    const created = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=black:s=16x16:r=10:d=4',
      '-f', 'lavfi', '-i', 'aevalsrc=0.4:s=48000:d=1',
      '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'pcm_s16le', '-f', 'matroska', f.source], { windowsHide: true, timeout: 15000 });
    expect(created.status, created.stderr.toString()).toBe(0);
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => f.directory });
    const runtime = createClipAudioCache({ ...f.options, execute: (argv, options) => execution.execute(argv, options) });
    try {
      const reversed = await runtime.reverse({ path: f.source, in: 2, out: 3 });
      const decoded = spawnSync(FFMPEG, ['-v', 'error', '-i', reversed.path, '-f', 'f32le', '-c:a', 'pcm_f32le', '-'],
        { windowsHide: true, timeout: 15000, maxBuffer: 300000 });
      expect(decoded.status, decoded.stderr.toString()).toBe(0);
      expect(decoded.stdout.length).toBe(48000 * 4);
      expect(decoded.stdout.every(byte => byte === 0)).toBe(true);
    } finally { await execution.cancelAllAndWait(); await runtime.waitForIdle(); }
  }, 30000);

  it('只倒轉裁切區間，保留不同左右聲道；音訊 EOF 補零也隨片段反向', async () => {
    const f = fixture();
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
      "aevalsrc='if(lt(t,0.5),0.15,0.6)|if(lt(t,0.5),-0.2,-0.7)':s=48000:d=1", '-c:a', 'pcm_s16le', f.source];
    const created = spawnSync(FFMPEG, args, { windowsHide: true, timeout: 15000 });
    expect(created.status, created.stderr.toString()).toBe(0);
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => f.directory });
    const runtime = createClipAudioCache({ ...f.options, execute: (argv, options) => execution.execute(argv, options) });
    try {
      const reversed = await runtime.reverse({ path: f.source, in: 0.25, out: 1.25 });
      const decoded = spawnSync(FFMPEG, ['-v', 'error', '-i', reversed.path, '-f', 'f32le', '-c:a', 'pcm_f32le', '-'],
        { windowsHide: true, timeout: 15000, maxBuffer: 500000 });
      expect(decoded.status, decoded.stderr.toString()).toBe(0);
      expect(decoded.stdout.length).toBe(48000 * 2 * 4);
      const sample = (seconds, channel) => decoded.stdout.readFloatLE((Math.round(seconds * 48000) * 2 + channel) * 4);
      expect(sample(0.1, 0)).toBeCloseTo(0, 3);
      expect(sample(0.4, 0)).toBeCloseTo(0.6, 3);
      expect(sample(0.4, 1)).toBeCloseTo(-0.7, 3);
      expect(sample(0.9, 0)).toBeCloseTo(0.15, 3);
      expect(sample(0.9, 1)).toBeCloseTo(-0.2, 3);
    } finally { await execution.cancelAllAndWait(); }
  }, 30000);
  it.each([[0, 1.5], [0.25, 1.25]])('音訊延後開聲的 PTS 靜音也按来源區間 %s 至 %s 倒轉', async (start, end) => {
    const f = fixture();
    const created = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=black:s=16x16:r=10:d=1.5', '-itsoffset', '0.5',
      '-f', 'lavfi', '-i', 'aevalsrc=0.4:s=48000:d=1', '-c:a', 'pcm_s16le', '-f', 'matroska', f.source],
      { windowsHide: true, timeout: 15000 });
    expect(created.status, created.stderr.toString()).toBe(0);
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => f.directory });
    const runtime = createClipAudioCache({ ...f.options, execute: (argv, options) => execution.execute(argv, options) });
    try {
      const reversed = await runtime.reverse({ path: f.source, in: start, out: end });
      const decoded = spawnSync(FFMPEG, ['-v', 'error', '-i', reversed.path, '-f', 'f32le', '-c:a', 'pcm_f32le', '-'],
        { windowsHide: true, timeout: 15000, maxBuffer: 400000 });
      expect(decoded.status, decoded.stderr.toString()).toBe(0);
      const sample = seconds => decoded.stdout.readFloatLE(Math.round(seconds * 48000) * 4);
      expect(sample(0.2)).toBeCloseTo(0.4, 3);
      expect(sample(0.4)).toBeCloseTo(0.4, 3);
      expect(sample(end - start - 0.1)).toBeCloseTo(0, 3);
    } finally { await execution.cancelAllAndWait(); }
  }, 30000);
});
