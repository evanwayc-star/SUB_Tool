import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createFFmpegExecution } = require('../electron/ffmpeg-execution-engine.js');
const { createAudioNormalizationRuntime } = require('../electron/audio-normalization-runtime.js');

const tempRoots = [];

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-ffmpeg-execution-'));
  tempRoots.push(root);
  return root;
}

function directProcess(stderrText, code = 0) {
  const process = new EventEmitter();
  process.stderr = new EventEmitter();
  queueMicrotask(() => {
    process.stderr.emit('data', Buffer.from(stderrText));
    process.emit('close', code);
  });
  return process;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('FFmpeg execution', () => {
  it('關閉時取消音訊 Pass 1，即使 close 回傳成功也不能啟動 Pass 2', async () => {
    const root = makeTempRoot();
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    const spawnDirect = vi.fn(() => child);
    const execution = createFFmpegExecution({ getFFmpegPath: () => 'ffmpeg', getUserDataDir: () => root, spawnDirect });
    const signalOwner = new AbortController();
    const removeFile = vi.fn();
    const runtime = createAudioNormalizationRuntime({
      createTempPath: () => path.join(root, 'normalized.wav'),
      execute: (args, options) => execution.execute(args, { ...options, executionKind: 'direct' }),
      removeFile,
    });
    const work = runtime.normalize('master.wav', { isTruePeak: true }, { signal: signalOwner.signal }).catch(error => error);
    signalOwner.abort();
    const closing = execution.cancelAllAndWait();
    child.emit('close', 0);
    await expect(work).resolves.toMatchObject({ name: 'AbortError' });
    await closing;
    expect(spawnDirect).toHaveBeenCalledOnce();
    expect(removeFile).toHaveBeenCalledWith(path.join(root, 'normalized.wav'));
  });

  it('shutdown 統一終止 direct child，close 前不結束且拒絕新工作', async () => {
    const root = makeTempRoot();
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    const spawnDirect = vi.fn(() => child);
    const execution = createFFmpegExecution({ getFFmpegPath: () => 'ffmpeg', getUserDataDir: () => root, spawnDirect });
    const work = execution.execute(['-version'], { executionKind: 'direct' }).catch(error => error);
    let finished = false;
    const shutdown = execution.cancelAllAndWait().then(() => { finished = true; });
    expect(child.kill).toHaveBeenCalledOnce();
    await expect(execution.execute(['-version'], { executionKind: 'direct' })).rejects.toMatchObject({ code: 'FFMPEG_SHUTTING_DOWN' });
    await Promise.resolve();
    expect(finished).toBe(false);
    child.emit('close', null);
    await work;
    await shutdown;
    expect(finished).toBe(true);
    expect(spawnDirect).toHaveBeenCalledOnce();
  });

  it('error 事件尚未 close 時保留 native ownership；shutdown timeout 明確拒絕', async () => {
    const root = makeTempRoot();
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    const execution = createFFmpegExecution({ getFFmpegPath: () => 'ffmpeg', getUserDataDir: () => root, spawnDirect: () => child });
    let settled = false;
    const failure = new Error('spawn/runtime failed');
    const work = execution.execute(['-version'], { executionKind: 'direct' }).catch(error => { settled = true; return error; });
    child.emit('error', failure);
    await Promise.resolve();
    expect(settled).toBe(false);
    await expect(execution.cancelAllAndWait({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'FFMPEG_TERMINATION_PENDING' });
    expect(execution.resume()).toBe(false);
    child.emit('close', 1);
    await expect(work).resolves.toBe(failure);
    await execution.cancelAllAndWait();
    expect(execution.resume()).toBe(true);
  });

  it('缺少明確執行種類或 watchdog 必要資料時直接拒絕，不啟動任何程序', async () => {
    const userDataDir = makeTempRoot();
    let queueDir = null;
    let spawned = 0;
    const execution = createFFmpegExecution({
      getFFmpegPath: () => 'ffmpeg-test',
      getUserDataDir: () => userDataDir,
      getQueueDir: () => queueDir,
      spawnDirect() { spawned++; throw new Error('不可啟動 direct'); },
      spawnWatchdog() { spawned++; throw new Error('不可啟動 watchdog'); },
    });
    const outPath = path.join(userDataDir, 'delivery.mov');
    await expect(execution.execute([outPath], { jobId: 'export-legacy', outPath }))
      .rejects.toThrow(/executionKind/);
    await expect(execution.execute([outPath], { executionKind: 'unknown', jobId: 'export-legacy', outPath }))
      .rejects.toThrow(/executionKind/);
    await expect(execution.execute([outPath], { executionKind: 'queued-delivery', jobId: 'delivery-abc', outPath }))
      .rejects.toThrow(/佇列目錄/);
    queueDir = path.join(userDataDir, 'export-queue');
    await expect(execution.execute([outPath], { executionKind: 'queued-delivery', jobId: 'delivery-abc' }))
      .rejects.toThrow(/輸出路徑/);
    await expect(execution.execute([outPath], { executionKind: 'queued-delivery', outPath }))
      .rejects.toThrow(/工作識別/);
    expect(spawned).toBe(0);
  });

  it('直接執行不會因工作 ID 帶 export- 前綴而切到 watchdog', async () => {
    const userDataDir = makeTempRoot();
    let directCalls = 0;
    const execution = createFFmpegExecution({
      getFFmpegPath: () => 'ffmpeg-test',
      getUserDataDir: () => userDataDir,
      getQueueDir: () => path.join(userDataDir, 'export-queue'),
      spawnDirect() { directCalls++; return directProcess('', 0); },
      spawnWatchdog() { throw new Error('直接執行不可啟動 watchdog'); },
    });
    await execution.execute(['-version'], { executionKind: 'direct', jobId: 'export-preview' });
    expect(directCalls).toBe(1);
  });

  it.each([
    ['dvd-iso', '.iso', 47.5],
    ['bd-iso', '.iso', 47.5],
    ['airline-dmpes', '.mpg', 50],
  ])('%s 的 watchdog 編碼進度遵守成品階段進度尺', async (format, extension, expected) => {
    const userDataDir = makeTempRoot();
    const queueDir = path.join(userDataDir, 'export-queue');
    const outPath = path.join(userDataDir, `delivery${extension}`);
    const progress = [];
    const execution = createFFmpegExecution({
      getFFmpegPath: () => 'ffmpeg-test',
      getUserDataDir: () => userDataDir,
      getQueueDir: () => queueDir,
      ensureQueueDir: () => fs.mkdirSync(queueDir, { recursive: true }),
      spawnWatchdog(config, handlers) {
        handlers.onStderr(Buffer.from('frame=25 time=00:00:05.00 speed=1.0x\n'));
        return { ready: Promise.resolve(), completion: Promise.resolve({ ok: true, code: 0 }) };
      },
    });
    await execution.execute([outPath], {
      executionKind: 'queued-delivery', duration: 10, jobId: `export-${format}`, outPath, outputFormat: format,
      onProgress: event => progress.push(event),
    });
    expect(progress).toContainEqual(expect.objectContaining({ pct: expected }));
  });
  it('可重建快取工作走 direct child adapter，並從公開 outcome 回傳進度與 stream maps', async () => {
    const userDataDir = makeTempRoot();
    const spawned = [];
    const owned = [];
    const progress = [];
    const stderr = [];
    const child = directProcess(
      'Stream #0:0 -> #0:0 (h264 (native) -> h264 (libx264))\n'
      + 'frame=25 time=00:00:05.00 speed=1.0x\n',
    );
    const execution = createFFmpegExecution({
      getFFmpegPath: () => 'ffmpeg-test',
      getUserDataDir: () => userDataDir,
      spawnDirect(executable, args, options) {
        spawned.push({ executable, args, options });
        return child;
      },
      spawnWatchdog() {
        throw new Error('direct 工作不可啟動 watchdog');
      },
    });

    const outcome = await execution.execute(['-i', 'master.mxf', 'proxy.mp4'], {
      executionKind: 'direct',
      duration: 10,
      jobId: 'proxy',
      label: '轉檔預覽影片',
      cwd: userDataDir,
      onProcess: process => owned.push(process),
      onProgress: value => progress.push(value),
      onStderr: value => stderr.push(value),
    });

    expect(spawned).toEqual([{
      executable: 'ffmpeg-test',
      args: ['-i', 'master.mxf', 'proxy.mp4'],
      options: { cwd: userDataDir },
    }]);
    expect(owned).toEqual([child]);
    expect(progress).toEqual([expect.objectContaining({
      jobId: 'proxy',
      label: '轉檔預覽影片',
      pct: 50,
    }), expect.objectContaining({ jobId: 'proxy', done: true, outcome: 'success', pct: 100 })]);
    expect(outcome.maps).toEqual(['h264 (native) -> h264 (libx264)']);
    expect(outcome.tail).toContain('time=00:00:05.00');
    expect(stderr.join('')).toBe(outcome.tail);
  });

  it('每份交付各自走 watchdog adapter，並把可停止的 controller 交給 owner', async () => {
    const userDataDir = makeTempRoot();
    const queueDir = path.join(userDataDir, 'export-queue');
    const outPath = path.join(userDataDir, 'delivery.mov');
    const owned = [];
    const watchdogCalls = [];
    const controller = {
      process: { pid: 4321 },
      stop() {},
      ready: Promise.resolve(),
      completion: Promise.resolve({ ok: true, code: 0 }),
    };
    const execution = createFFmpegExecution({
      getFFmpegPath: () => 'ffmpeg-test',
      getUserDataDir: () => userDataDir,
      getQueueDir: () => queueDir,
      ensureQueueDir: () => fs.mkdirSync(queueDir, { recursive: true }),
      spawnDirect() {
        throw new Error('交付工作不可由 Electron main 直接持有 ffmpeg');
      },
      spawnWatchdog(config, handlers) {
        watchdogCalls.push(config);
        queueMicrotask(() => handlers.onStderr(Buffer.from(
          'Stream #0:0 -> #0:0 (prores (native) -> prores (prores_ks))\n',
        )));
        return controller;
      },
    });

    const outcome = await execution.execute(['-i', 'master.mxf', outPath], {
      executionKind: 'queued-delivery',
      duration: 12,
      jobId: 'delivery-abc',
      label: '匯出 ProRes',
      outPath,
      cwd: userDataDir,
      onProcess: value => owned.push(value),
    });

    expect(watchdogCalls).toEqual([expect.objectContaining({
      ffmpegPath: 'ffmpeg-test',
      args: ['-i', 'master.mxf', outPath],
      cwd: userDataDir,
      outPath,
      jobId: 'delivery-abc',
      queueDir,
    })]);
    expect(owned).toEqual([controller]);
    expect(outcome.maps).toEqual(['prores (native) -> prores (prores_ks)']);
  });

  it('寫入 execution log 失敗時透過公開 logger boundary 告警', async () => {
    const userDataDir = makeTempRoot();
    const logStream = new EventEmitter();
    logStream.write = () => true;
    logStream.end = () => { logStream.writableFinished = true; logStream.emit('finish'); };
    logStream.writableFinished = false;
    logStream.destroyed = false;
    const logErrors = [];
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    const execution = createFFmpegExecution({
      fs: {
        ...fs,
        createWriteStream() {
          queueMicrotask(() => logStream.emit('error', new Error('disk is read-only')));
          return logStream;
        },
      },
      getFFmpegPath: () => 'ffmpeg-test',
      getUserDataDir: () => userDataDir,
      onLogError: (logPath, error) => logErrors.push({ logPath, error }),
      spawnDirect() {
        setTimeout(() => child.emit('close', 0), 0);
        return child;
      },
    });

    await execution.execute(['-version'], { executionKind: 'direct', jobId: 'probe' });

    expect(logErrors).toEqual([{
      logPath: expect.stringMatching(/export-\d+-probe\.log$/),
      error: expect.objectContaining({ message: 'disk is read-only' }),
    }]);
  });

  it('航空 watchdog 路徑由格式與主輸出推導，不接受呼叫端提供的旁檔列表', async () => {
    const userDataDir = makeTempRoot();
    const queueDir = path.join(userDataDir, 'export-queue');
    const outPath = path.join(userDataDir, 'air.mpg');
    let config;
    const execution = createFFmpegExecution({
      getFFmpegPath: () => 'ffmpeg-test',
      getUserDataDir: () => userDataDir,
      getQueueDir: () => queueDir,
      ensureQueueDir: () => fs.mkdirSync(queueDir, { recursive: true }),
      spawnWatchdog(value) {
        config = value;
        return { ready: Promise.resolve(), completion: Promise.resolve({ ok: true, code: 0 }) };
      },
    });
    await execution.execute([outPath], {
      executionKind: 'queued-delivery', jobId: 'export-air', outPath, outputFormat: 'airline-dmpes',
      outputPaths: [path.join(userDataDir, 'unrelated.txt')],
    });
    expect(config.outPath).toBe(outPath);
    expect(config).not.toHaveProperty('outputPaths');
  });

  it('watchdog 失敗會以穩定 error code、outcome 與 log path 回報', async () => {
    const userDataDir = makeTempRoot();
    const queueDir = path.join(userDataDir, 'export-queue');
    const outPath = path.join(userDataDir, 'delivery.mov');
    const watchdogResult = { ok: false, code: 1, cleanup: { retainedLease: false } };
    const execution = createFFmpegExecution({
      getFFmpegPath: () => 'ffmpeg-test',
      getUserDataDir: () => userDataDir,
      getQueueDir: () => queueDir,
      ensureQueueDir: () => fs.mkdirSync(queueDir, { recursive: true }),
      spawnWatchdog(config, handlers) {
        handlers.onMessage({ type: 'error', code: 'OUTPUT_BUSY' });
        return {
          ready: Promise.resolve(),
          completion: Promise.resolve(watchdogResult),
        };
      },
    });

    await expect(execution.execute(['-i', 'master.mxf', outPath], {
      executionKind: 'queued-delivery',
      jobId: 'export-busy',
      outPath,
    })).rejects.toMatchObject({
      code: 'OUTPUT_BUSY',
      watchdogResult,
      message: expect.stringContaining(`[LOG_PATH]${path.join(queueDir, 'export-busy.log')}[/LOG_PATH]`),
    });
  });
});
