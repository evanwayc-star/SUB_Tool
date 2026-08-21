import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createFFmpegExecution } = require('../electron/ffmpeg-execution.js');

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
  it('可重建快取工作走 direct child adapter，並從公開 outcome 回傳進度與 stream maps', async () => {
    const userDataDir = makeTempRoot();
    const spawned = [];
    const owned = [];
    const progress = [];
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
      duration: 10,
      jobId: 'proxy',
      label: '轉檔預覽影片',
      cwd: userDataDir,
      onProcess: process => owned.push(process),
      onProgress: value => progress.push(value),
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
    })]);
    expect(outcome.maps).toEqual(['h264 (native) -> h264 (libx264)']);
    expect(outcome.tail).toContain('time=00:00:05.00');
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
      duration: 12,
      jobId: 'export-abc',
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
      jobId: 'export-abc',
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

    await execution.execute(['-version'], { jobId: 'probe' });

    expect(logErrors).toEqual([{
      logPath: expect.stringMatching(/export-\d+-probe\.log$/),
      error: expect.objectContaining({ message: 'disk is read-only' }),
    }]);
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
      jobId: 'export-busy',
      outPath,
    })).rejects.toMatchObject({
      code: 'OUTPUT_BUSY',
      watchdogResult,
      message: expect.stringContaining(`[LOG_PATH]${path.join(queueDir, 'export-busy.log')}[/LOG_PATH]`),
    });
  });
});
