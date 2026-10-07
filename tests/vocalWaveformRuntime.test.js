// @subtool-ci windows
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { parse } from 'acorn';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createVocalWaveformRuntime, validateChunkRequest, buildChunkArgs, SAMPLE_RATE, CHANNELS } = require('../electron/vocal-waveform-runtime.js');
const { FileAuthority } = require('../electron/file-authority.js');
const { createIpcGuards } = require('../electron/ipc-guards.js');
const ROOT = path.resolve('');
const FFMPEG = process.env.FFMPEG_PATH || path.join(ROOT, 'electron/ffmpeg/ffmpeg.exe');
const FFPROBE = process.env.FFPROBE_PATH || path.join(ROOT, 'electron/ffmpeg/ffprobe.exe');
const nativeIt = fs.existsSync(FFMPEG) ? it : it.skip;
const directories = [];

function sender() {
  const owner = new EventEmitter();
  owner.isDestroyed = () => false;
  return owner;
}

function harness({ closeOnKill = true, timeoutMs } = {}) {
  const processes = [];
  const spawn = vi.fn(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn(signal => {
      if (closeOnKill) queueMicrotask(() => child.emit('close', null, signal));
      return true;
    });
    processes.push(child);
    return child;
  });
  const runtime = createVocalWaveformRuntime({ getFFmpegPath: () => 'trusted-ffmpeg', spawn, timeoutMs });
  return { runtime, spawn, processes };
}

const request = (requestId = 'vocal-1', extra = {}) => ({
  path: 'C:/素材/母音.wav', start: 12.5, duration: 1, requestId, ...extra,
});

function preloadBridge() {
  let api;
  const invoke = vi.fn().mockResolvedValue({});
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'electron/preload.js'), 'utf8'), {
    require: name => {
      if (name !== 'electron') throw new Error(`unexpected preload require: ${name}`);
      return {
        contextBridge: { exposeInMainWorld: (name, exposed) => { if (name === 'subtool') api = exposed; } },
        ipcRenderer: { invoke, on: vi.fn(), send: vi.fn() }, webUtils: {},
      };
    },
    ArrayBuffer, Uint8Array, Promise, TypeError, RangeError,
  });
  return { api, invoke };
}

function mainHandlers(runtime, authority) {
  const source = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const registrations = ast.body.filter(node => node.type === 'ExpressionStatement'
    && node.expression.type === 'CallExpression'
    && node.expression.callee.object?.name === 'ipcMain'
    && node.expression.callee.property?.name === 'handle'
    && ['audio:vocal-wave-chunk', 'audio:vocal-wave-cancel'].includes(node.expression.arguments[0]?.value));
  expect(registrations).toHaveLength(2);
  const handlers = new Map();
  const context = {
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    vocalWaveformRuntime: runtime, validateChunkRequest,
    requireReadablePath: createIpcGuards(authority).requireReadablePath,
  };
  for (const registration of registrations) vm.runInNewContext(source.slice(registration.start, registration.end), context);
  return handlers;
}

function shutdownHandler(vocalRuntime) {
  const source = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const registration = ast.body.find(node => node.type === 'ExpressionStatement'
    && node.expression.type === 'CallExpression'
    && node.expression.callee.object?.name === 'app'
    && node.expression.callee.property?.name === 'on'
    && node.expression.arguments[0]?.value === 'before-quit');
  expect(registration).toBeDefined();
  let handler;
  const nativeOwner = () => ({ cancelAllAndWait: vi.fn().mockResolvedValue(), resume: vi.fn() });
  const context = {
    app: { on: (channel, listener) => { handler = listener; }, quit: vi.fn() },
    _quitReady: false, _quitSequenceStarted: false, _isAppQuitting: false,
    audioNormalizationJobs: new Map(), ffmpegExecution: nativeOwner(),
    clipAudioCache: { waitForIdle: vi.fn().mockResolvedValue() },
    speechCompressionRuntime: nativeOwner(), mediaIngestCoordinator: nativeOwner(),
    vocalWaveformRuntime: vocalRuntime, QueueManager: { prepareForShutdown: vi.fn().mockResolvedValue() },
    mediaIntakeRuntime: { close: vi.fn().mockResolvedValue() }, screenshotOutput: { close: vi.fn().mockResolvedValue() },
    mainWin: null, dialog: { showMessageBox: vi.fn().mockResolvedValue() },
    console: { error: vi.fn() }, Promise,
  };
  vm.runInNewContext(source.slice(registration.start, registration.end), context);
  return { handler, context };
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) {
    const resolved = fs.realpathSync(directory);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('subtool-vocal-wave-test-')) {
      throw new Error('拒絕清除未驗證的測試路徑');
    }
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('人聲模型的受限母素材 PCM 邊界', () => {
  it.each([
    { start: -1 }, { start: NaN }, { start: Infinity }, { start: '0' },
    { duration: 0 }, { duration: 36.001 }, { duration: Infinity },
    { sourceStream: -1 }, { sourceStream: 256 }, { sourceChannel: 64 }, { sourceChannel: 0.5 },
    { requestId: '' }, { requestId: '../vocal' }, { requestId: 'x'.repeat(101) },
    { path: '' }, { path: 'bad\0path' }, { path: null },
  ])('拒絕超出 PCM 讀取契約的參數 %j', invalid => {
    const { runtime, spawn } = harness();
    expect(() => validateChunkRequest(request('vocal-1', invalid))).toThrow();
    const { api, invoke } = preloadBridge();
    expect(() => api.vocalWaveChunk(request('vocal-1', invalid))).toThrow();
    expect(invoke).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(runtime.activeCount()).toBe(0);
  });

  it('preload 只送白名單讀取欄位，取消使用獨立 request id IPC', async () => {
    const { api, invoke } = preloadBridge();
    await api.vocalWaveChunk(request('vocal-good', { outputPath: 'C:/forbidden.wav' }));
    await api.cancelVocalWaveChunk('vocal-good');
    expect(invoke).toHaveBeenNthCalledWith(1, 'audio:vocal-wave-chunk', {
      ...request('vocal-good'), sourceStream: 0, sourceChannel: null,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'audio:vocal-wave-cancel', { requestId: 'vocal-good' });
    expect(() => api.cancelVocalWaveChunk('../invalid')).toThrow(TypeError);
  });

  it('main 先核對實際 read capability，未授權路徑不能啟動 native 讀取', async () => {
    const authority = new FileAuthority();
    const runtime = { readChunk: vi.fn().mockResolvedValue({}), cancel: vi.fn().mockReturnValue(true) };
    const handlers = mainHandlers(runtime, authority);
    const owner = sender();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => handlers.get('audio:vocal-wave-chunk')({ sender: owner }, request())).toThrow(/未授權/);
      expect(runtime.readChunk).not.toHaveBeenCalled();
      authority.grantTrustedFile(request().path, { read: true, write: false });
      await handlers.get('audio:vocal-wave-chunk')({ sender: owner }, request());
      expect(runtime.readChunk).toHaveBeenCalledWith(owner, { ...request(), sourceStream: 0, sourceChannel: null });
      expect(handlers.get('audio:vocal-wave-cancel')({ sender: owner }, { requestId: 'vocal-1' })).toBe(true);
      expect(runtime.cancel).toHaveBeenCalledWith(owner, 'vocal-1');
    } finally { warning.mockRestore(); }
  });

  it('來源時間與原始 stream/channel 只進 argv，回傳完整 Float32 交錯立體聲 bytes', async () => {
    const { runtime, spawn, processes } = harness();
    const owner = sender();
    const input = request('vocal-stereo', { sourceStream: 2, sourceChannel: 3 });
    const pending = runtime.readChunk(owner, input);
    const pcm = Buffer.alloc(16);
    [0.25, -0.5, 0.75, -1].forEach((value, index) => pcm.writeFloatLE(value, index * 4));
    processes[0].stdout.emit('data', pcm.subarray(0, 5));
    processes[0].stdout.emit('data', pcm.subarray(5));
    processes[0].emit('close', 0);
    const result = await pending;
    expect(result).toMatchObject({ sampleRate: 44100, channels: 2 });
    expect(result.samples).toBeInstanceOf(ArrayBuffer);
    expect([...new Float32Array(result.samples)]).toEqual([0.25, -0.5, 0.75, -1]);
    expect(spawn).toHaveBeenCalledWith('trusted-ffmpeg', buildChunkArgs(input), {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const args = spawn.mock.calls[0][1];
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 4)).toEqual(['-ss', '12.5', '-i', input.path]);
    expect(args).toEqual(expect.arrayContaining(['0:a:2', 'pan=stereo|c0=c3|c1=c3,aresample=44100:async=1:first_pts=0', 'f32le', 'pipe:1']));
    expect(runtime.activeCount()).toBe(0);
    expect(owner.listenerCount('destroyed')).toBe(0);
  });

  it('同 id 的不同 sender 互相隔離，取消只停止自己的 ffmpeg', async () => {
    const { runtime, processes } = harness();
    const first = sender(), second = sender(), outsider = sender();
    const firstPending = runtime.readChunk(first, request());
    const firstRejected = expect(firstPending).rejects.toMatchObject({ name: 'AbortError' });
    const secondPending = runtime.readChunk(second, request());
    expect(runtime.cancel(outsider, 'vocal-1')).toBe(false);
    expect(runtime.cancel(first, 'vocal-1')).toBe(true);
    await firstRejected;
    expect(processes[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(processes[1].kill).not.toHaveBeenCalled();
    processes[1].stdout.emit('data', Buffer.alloc(8));
    processes[1].emit('close', 0);
    await secondPending;
    expect(runtime.activeCount()).toBe(0);
  });

  it('同 sender 重複 id 不啟動第二個程序，視窗銷毀停止原工作', async () => {
    const { runtime, spawn, processes } = harness();
    const owner = sender();
    const pending = runtime.readChunk(owner, request());
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(runtime.readChunk(owner, request())).rejects.toThrow(/重複/);
    expect(spawn).toHaveBeenCalledOnce();
    owner.emit('destroyed');
    await rejected;
    expect(processes[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(runtime.activeCount()).toBe(0);
    expect(owner.listenerCount('destroyed')).toBe(0);
  });

  it('PCM 超過本片段大小立即停止，不完整 frame 不能作成功結果', async () => {
    const { runtime, processes } = harness();
    const pending = runtime.readChunk(sender(), request('vocal-too-large', { duration: 1 / SAMPLE_RATE }));
    const rejected = expect(pending).rejects.toThrow(/超過/);
    processes[0].stdout.emit('data', Buffer.alloc(16));
    await rejected;
    expect(processes[0].kill).toHaveBeenCalledWith('SIGTERM');
    for (const size of [7]) {
      const invalid = runtime.readChunk(sender(), request(`vocal-size-${size}`));
      const rejection = expect(invalid).rejects.toThrow(/完整/);
      processes.at(-1).stdout.emit('data', Buffer.alloc(size));
      processes.at(-1).emit('close', 0);
      await rejection;
    }
    expect(runtime.activeCount()).toBe(0);
  });

  it('ffmpeg 成功且空 PCM 是有效 EOF，stderr warning 不能冒充讀取失敗', async () => {
    const { runtime, processes } = harness();
    const pending = runtime.readChunk(sender(), request('vocal-empty-eof'));
    processes[0].stderr.emit('data', Buffer.from('Output file is empty, nothing was encoded'));
    processes[0].emit('close', 0);
    const result = await pending;
    expect(result.samples).toBeInstanceOf(ArrayBuffer);
    expect(result.samples.byteLength).toBe(0);
    expect(result).toMatchObject({ sampleRate: 44100, channels: 2 });
    expect(runtime.activeCount()).toBe(0);
  });

  it('讀取失敗保存 stderr，spawn error 也會釋放工作與 listener', async () => {
    const { runtime, processes } = harness();
    const owner = sender();
    const pending = runtime.readChunk(owner, request());
    const rejected = expect(pending).rejects.toThrow(/missing stream/);
    processes[0].stderr.emit('data', Buffer.from('missing stream'));
    processes[0].emit('close', 1);
    await rejected;
    const failedSpawn = runtime.readChunk(owner, request('vocal-spawn'));
    const spawnRejected = expect(failedSpawn).rejects.toThrow(/spawn failed/);
    processes[1].emit('error', new Error('spawn failed'));
    await spawnRejected;
    expect(runtime.activeCount()).toBe(0);
    expect(owner.listenerCount('destroyed')).toBe(0);
  });

  it('逾時先 SIGTERM、再 SIGKILL，close 前保留程序追蹤', async () => {
    vi.useFakeTimers();
    const { runtime, processes } = harness({ closeOnKill: false, timeoutMs: 20 });
    const pending = runtime.readChunk(sender(), request());
    const rejected = expect(pending).rejects.toThrow(/逾時/);
    await vi.advanceTimersByTimeAsync(20);
    expect(processes[0].kill).toHaveBeenLastCalledWith('SIGTERM');
    expect(runtime.activeCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(processes[0].kill).toHaveBeenLastCalledWith('SIGKILL');
    processes[0].emit('close', null);
    await rejected;
    expect(runtime.activeCount()).toBe(0);
  });

  it('native kill error 不能冒充 close 而放棄存活 PID 的追蹤', async () => {
    const { runtime, processes } = harness({ closeOnKill: false });
    const owner = sender();
    const pending = runtime.readChunk(owner, request());
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    processes[0].pid = 123;
    runtime.cancel(owner, 'vocal-1');
    processes[0].emit('error', new Error('kill failed'));
    expect(runtime.activeCount()).toBe(1);
    processes[0].emit('close', null);
    await rejected;
    expect(runtime.activeCount()).toBe(0);
  });

  it('shutdown 關閉准入，等待所有 close 完成後才離開；取消退出可恢復准入', async () => {
    const { runtime, processes, spawn } = harness({ closeOnKill: false });
    const pending = runtime.readChunk(sender(), request());
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    let closed = false;
    const shutdown = runtime.cancelAllAndWait().then(() => { closed = true; });
    await expect(runtime.readChunk(sender(), request('vocal-late'))).rejects.toMatchObject({ name: 'AbortError' });
    expect(spawn).toHaveBeenCalledOnce();
    expect(closed).toBe(false);
    processes[0].emit('close', null);
    await Promise.all([rejected, shutdown]);
    expect(closed).toBe(true);
    expect(runtime.activeCount()).toBe(0);
    runtime.resume();
    const fresh = runtime.readChunk(sender(), request('vocal-fresh'));
    processes[1].stdout.emit('data', Buffer.alloc(8));
    processes[1].emit('close', 0);
    await fresh;
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('未確認 native close 的 shutdown 有界失敗並保留追蹤，不能誤報安全關閉', async () => {
    vi.useFakeTimers();
    const { runtime, processes } = harness({ closeOnKill: false });
    const pending = runtime.readChunk(sender(), request());
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const shutdown = runtime.cancelAllAndWait({ timeoutMs: 1100 });
    const shutdownRejected = expect(shutdown).rejects.toMatchObject({ code: 'VOCAL_WAVE_TERMINATION_PENDING' });
    await vi.advanceTimersByTimeAsync(1100);
    await shutdownRejected;
    expect(processes[0].kill).toHaveBeenLastCalledWith('SIGKILL');
    expect(runtime.activeCount()).toBe(1);
    processes[0].emit('close', null);
    await rejected;
    await runtime.cancelAllAndWait();
    expect(runtime.activeCount()).toBe(0);
  });

  it('實際 main shutdown wiring 等人聲 PCM barrier 才清暫存及退出', async () => {
    let resolveVocal;
    const vocalRuntime = {
      cancelAllAndWait: vi.fn(() => new Promise(resolve => { resolveVocal = resolve; })), resume: vi.fn(),
    };
    const { handler, context } = shutdownHandler(vocalRuntime);
    const preventDefault = vi.fn();
    handler({ preventDefault });
    await vi.waitFor(() => expect(vocalRuntime.cancelAllAndWait).toHaveBeenCalledOnce());
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(context.mediaIntakeRuntime.close).not.toHaveBeenCalled();
    expect(context.app.quit).not.toHaveBeenCalled();
    resolveVocal();
    await vi.waitFor(() => expect(context.app.quit).toHaveBeenCalledOnce());
    expect(context.clipAudioCache.waitForIdle).toHaveBeenCalledOnce();
    expect(context.mediaIntakeRuntime.close).toHaveBeenCalledOnce();
    expect(context.screenshotOutput.close).toHaveBeenCalledOnce();
    expect(context._quitReady).toBe(true);
  });

  it('實際 main 先等 FFmpeg close，再等反向音訊 owner 清理才退出', async () => {
    const { handler, context } = shutdownHandler({ cancelAllAndWait: vi.fn().mockResolvedValue(), resume: vi.fn() });
    let closeWriter, cleanCache;
    context.ffmpegExecution.cancelAllAndWait.mockImplementation(() => new Promise(resolve => { closeWriter = resolve; }));
    context.clipAudioCache.waitForIdle.mockImplementation(() => new Promise(resolve => { cleanCache = resolve; }));
    handler({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(context.ffmpegExecution.cancelAllAndWait).toHaveBeenCalledOnce());
    expect(context.clipAudioCache.waitForIdle).not.toHaveBeenCalled();
    closeWriter();
    await vi.waitFor(() => expect(context.clipAudioCache.waitForIdle).toHaveBeenCalledOnce());
    expect(context.mediaIntakeRuntime.close).not.toHaveBeenCalled();
    expect(context.app.quit).not.toHaveBeenCalled();
    cleanCache();
    await vi.waitFor(() => expect(context.app.quit).toHaveBeenCalledOnce());
    expect(context.mediaIntakeRuntime.close).toHaveBeenCalledOnce();
  });

  it('main 收到人聲 PCM shutdown 失敗會取消退出並恢復准入', async () => {
    const vocalRuntime = {
      cancelAllAndWait: vi.fn().mockRejectedValue(new Error('native still running')), resume: vi.fn(),
    };
    const { handler, context } = shutdownHandler(vocalRuntime);
    handler({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(vocalRuntime.resume).toHaveBeenCalledOnce());
    expect(context.app.quit).not.toHaveBeenCalled();
    expect(context.mediaIntakeRuntime.close).not.toHaveBeenCalled();
    expect(context.dialog.showMessageBox).toHaveBeenCalledOnce();
    expect(context._quitSequenceStarted).toBe(false);
    expect(context._isAppQuitting).toBe(false);
  });

  nativeIt.each([.25, .3])('實際 FFmpeg 從 %s 秒依來源 sample 對齊，指定單聲道仍保持相同 source 時間', async start => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-vocal-wave-test-'));
    directories.push(directory);
    const source = path.join(directory, '母素材.wav');
    const bytes = Buffer.alloc(44 + SAMPLE_RATE * CHANNELS * 2);
    bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(CHANNELS, 22);
    bytes.writeUInt32LE(SAMPLE_RATE, 24); bytes.writeUInt32LE(SAMPLE_RATE * CHANNELS * 2, 28);
    bytes.writeUInt16LE(CHANNELS * 2, 32); bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
    for (let frame = 0; frame < SAMPLE_RATE; frame++) {
      bytes.writeInt16LE(frame % 10000 - 5000, 44 + frame * 4);
      bytes.writeInt16LE(9000 - frame % 10000, 46 + frame * 4);
    }
    fs.writeFileSync(source, bytes);
    const runtime = createVocalWaveformRuntime({ getFFmpegPath: () => FFMPEG });
    const owner = sender();
    const input = request('vocal-native', { path: source, start, duration: 0.4 });
    const mix = await runtime.readChunk(owner, input);
    const channel = await runtime.readChunk(owner, { ...input, requestId: 'vocal-native-channel', sourceChannel: 1 });
    const mixSamples = new Float32Array(mix.samples), selected = new Float32Array(channel.samples);
    expect(mixSamples).toHaveLength(17640 * 2);
    expect(selected).toHaveLength(mixSamples.length);
    for (let frame = 0; frame < 17640; frame++) {
      const original = Math.round(start * SAMPLE_RATE) + frame;
      const left = bytes.readInt16LE(44 + original * 4) / 32768;
      const right = bytes.readInt16LE(46 + original * 4) / 32768;
      expect(mixSamples[frame * 2]).toBeCloseTo(left, 7);
      expect(mixSamples[frame * 2 + 1]).toBeCloseTo(right, 7);
      expect(selected[frame * 2]).toBeCloseTo(right, 7);
      expect(selected[frame * 2 + 1]).toBeCloseTo(right, 7);
    }
    expect(fs.readFileSync(source)).toEqual(bytes);
    expect(fs.readdirSync(directory)).toEqual(['母素材.wav']);
    expect(runtime.activeCount()).toBe(0);
  });

  nativeIt('影片長於音訊時回傳真實短 PCM，音訊 EOF 後讀取可交付零 sample', async () => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-vocal-wave-test-'));
    directories.push(directory);
    const source = path.join(directory, '長影片短音訊.mkv');
    const generated = spawnSync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 'lavfi', '-i', 'color=size=16x16:rate=5:duration=4',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1',
      '-c:v', 'ffv1', '-c:a', 'pcm_s16le', source,
    ], { windowsHide: true, timeout: 15000 });
    expect(generated.error || generated.status, generated.stderr?.toString()).toBe(0);
    const motherBytes = fs.readFileSync(source);
    const runtime = createVocalWaveformRuntime({ getFFmpegPath: () => FFMPEG });
    const owner = sender();
    const decoded = await runtime.readChunk(owner, request('vocal-short-audio', { path: source, start: 0, duration: 4 }));
    expect(decoded.samples.byteLength).toBe(SAMPLE_RATE * CHANNELS * 4);
    expect(new Float32Array(decoded.samples).some(value => Math.abs(value) > .01)).toBe(true);
    const tail = await runtime.readChunk(owner, request('vocal-after-audio-eof', { path: source, start: 2, duration: 2 }));
    expect(tail.samples.byteLength).toBe(0);
    expect(tail).toMatchObject({ sampleRate: SAMPLE_RATE, channels: CHANNELS });
    await expect(runtime.readChunk(owner, request('vocal-missing-stream', { path: source, sourceStream: 1 }))).rejects.toThrow(/讀取失敗/);
    expect(fs.readFileSync(source)).toEqual(motherBytes);
    expect(fs.readdirSync(directory)).toEqual(['長影片短音訊.mkv']);
    expect(runtime.activeCount()).toBe(0);
  });

  nativeIt('容器音訊 PTS 延後兩秒時，PCM 保留來源的前置靜音與 seek 後剩餘靜音', async () => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-vocal-wave-test-'));
    directories.push(directory);
    const source = path.join(directory, '音訊PTS延後.mkv');
    const generated = spawnSync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 'lavfi', '-i', 'color=size=16x16:rate=5:duration=6',
      '-itsoffset', '2', '-f', 'lavfi', '-i', 'aevalsrc=0.125*sin(2*PI*440*t)|0.25*sin(2*PI*220*t):s=44100:d=3',
      '-c:v', 'ffv1', '-c:a', 'pcm_s16le', source,
    ], { windowsHide: true, timeout: 15000 });
    expect(generated.error || generated.status, generated.stderr?.toString()).toBe(0);
    const probe = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,start_time', '-of', 'json', source], {
      windowsHide: true, timeout: 15000,
    });
    expect(probe.error || probe.status, probe.stderr?.toString()).toBe(0);
    const streams = JSON.parse(probe.stdout.toString('utf8')).streams;
    expect(Number(streams.find(stream => stream.codec_type === 'video').start_time)).toBe(0);
    expect(Number(streams.find(stream => stream.codec_type === 'audio').start_time)).toBe(2);
    const original = fs.readFileSync(source);
    const runtime = createVocalWaveformRuntime({ getFFmpegPath: () => FFMPEG });
    const owner = sender();
    for (const [start, duration, silence] of [[0, 4, 2], [1, 3, 1], [2, 1, 0]]) {
      const result = await runtime.readChunk(owner, request(`vocal-delayed-${start}`, { path: source, start, duration }));
      const samples = new Float32Array(result.samples);
      expect(samples).toHaveLength(duration * SAMPLE_RATE * CHANNELS);
      const silenceSamples = silence * SAMPLE_RATE * CHANNELS;
      expect(samples.subarray(0, silenceSamples).every(value => value === 0)).toBe(true);
      const firstSignal = samples.findIndex(value => Math.abs(value) > .001);
      expect(Math.floor(firstSignal / CHANNELS)).toBe(silence * SAMPLE_RATE + 1);
      expect(samples.subarray(silenceSamples).some(value => Math.abs(value) > .1)).toBe(true);
    }
    const selected = await runtime.readChunk(owner, request('vocal-delayed-channel', {
      path: source, start: 1, duration: 3, sourceChannel: 1,
    }));
    const samples = new Float32Array(selected.samples);
    expect(samples).toHaveLength(3 * SAMPLE_RATE * CHANNELS);
    expect(samples.subarray(0, SAMPLE_RATE * CHANNELS).every(value => value === 0)).toBe(true);
    for (let frame = 0; frame < samples.length / CHANNELS; frame++) {
      expect(samples[frame * CHANNELS]).toBe(samples[frame * CHANNELS + 1]);
    }
    expect(fs.readFileSync(source)).toEqual(original);
    expect(runtime.activeCount()).toBe(0);
  });

  nativeIt('延後 PTS 的補靜音也不得超過 36 秒 PCM 大小上限', async () => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-vocal-wave-test-'));
    directories.push(directory);
    const source = path.join(directory, '音訊在片段外開始.mkv');
    const generated = spawnSync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 'lavfi', '-i', 'color=size=16x16:rate=1:duration=42',
      '-itsoffset', '40', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1',
      '-c:v', 'ffv1', '-c:a', 'pcm_s16le', source,
    ], { windowsHide: true, timeout: 15000 });
    expect(generated.error || generated.status, generated.stderr?.toString()).toBe(0);
    const runtime = createVocalWaveformRuntime({ getFFmpegPath: () => FFMPEG });
    const result = await runtime.readChunk(sender(), request('vocal-delayed-bound', { path: source, start: 0, duration: 36 }));
    expect(result.samples.byteLength).toBe(36 * SAMPLE_RATE * CHANNELS * 4);
    expect(new Float32Array(result.samples).every(value => value === 0)).toBe(true);
    expect(runtime.activeCount()).toBe(0);
  });
});
