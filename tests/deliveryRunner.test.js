import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createDeliveryRunner } = require('../electron/delivery-runner.js');

const tempRoots = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function make(overrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'subtool-delivery-runner-'));
  tempRoots.push(root);
  const queueDir = path.join(root, 'queue');
  const tempDir = path.join(root, 'temp');
  const sent = [];
  const active = new Map();
  const queue = {
    assertJobCapabilities: vi.fn(),
    reportProgress: vi.fn(() => true),
    registerActiveJob: vi.fn((id, value) => { active.set(id, value); return true; }),
    clearActiveJob: vi.fn(id => active.delete(id)),
    activeJob: vi.fn(id => active.get(id) || null),
    ...overrides.queue,
  };
  const runFfmpeg = overrides.runFfmpeg || vi.fn(async (args, options) => {
    const controller = {
      process: { pid: 42 }, stop: vi.fn(), completion: Promise.resolve(),
    };
    options.onProcess(controller);
    options.onProgress({ jobId: options.jobId, pct: 50 });
    return { maps: ['mpeg2video (native) -> h264 (libx264)'] };
  });
  const runner = createDeliveryRunner({
    queue,
    queueDir: () => queueDir,
    tempDir,
    mediaProbe: () => ({
      hasAudio: vi.fn(async () => false),
      audioBitrates: vi.fn(async () => ['320k']),
    }),
    runFfmpeg,
    encoder: {
      name: () => 'libx264',
      hwdecArgs: () => [],
      bitrateArgs: () => ['-c:v', 'libx264'],
      proresArgs: () => ['-c:v', 'prores_ks', '-c:a', 'pcm_s24le'],
    },
    fonts: { root: () => null, timecodeFile: () => null },
    events: {
      senderForId: id => id ? { id } : null,
      fallbackSender: () => ({ id: 'fallback' }),
      send: (target, event, payload) => sent.push({ target, event, payload }),
    },
    now: overrides.now || (() => 1000),
  });
  return { runner, queue, queueDir, tempDir, sent, active, runFfmpeg };
}

function videoJob(overrides = {}) {
  return {
    id: 'delivery-1', senderId: 7, assRef: null,
    payload: {
      format: 'h264', width: 1920, height: 1080, fps: 25, duration: 10,
      videoKbps: 8000, audioPlan: null, timecodeWatermark: null,
      outPath: 'D:/out/delivery.mp4',
      videoTracks: [{ vt: 0, scale: 1, posX: 0.5, posY: 0.5, opacity: 1 }],
      clips: [{
        path: 'D:/source/master.mxf', type: 'video', vtrack: 0,
        in: 0, out: 10, offset: 0, natW: 1280, natH: 720,
        fadeIn: 0, fadeOut: 0,
      }],
    },
    ...overrides,
  };
}

describe('delivery runner public interface', () => {
  it('以完整交易執行計畫、註冊程序並提交可觀察結果', async () => {
    let clock = 1000;
    const setup = make({ now: () => (clock += 250) });

    await setup.runner.run(videoJob());

    expect(setup.queue.assertJobCapabilities).toHaveBeenCalledOnce();
    expect(setup.runFfmpeg).toHaveBeenCalledWith(
      expect.arrayContaining(['-c:v', 'libx264', 'D:/out/delivery.mp4']),
      expect.objectContaining({ jobId: 'delivery-1', cwd: setup.tempDir }),
    );
    expect(setup.queue.registerActiveJob).toHaveBeenCalledOnce();
    expect(setup.queue.clearActiveJob).toHaveBeenCalledWith('delivery-1');
    expect(setup.sent.at(-1)).toMatchObject({
      target: { id: 7 }, event: 'task-progress',
      payload: { done: true, result: { encoder: 'libx264', gpu: false, videoKbps: 8000 } },
    });
  });

  it('queue 拒絕終態時不會先通知 renderer 完成', async () => {
    const setup = make({ queue: { reportProgress: vi.fn(() => false) } });

    await setup.runner.run(videoJob());

    expect(setup.queue.reportProgress).toHaveBeenCalledWith('delivery-1', expect.objectContaining({ done: true }));
    expect(setup.sent.some(item => item.payload?.done)).toBe(false);
  });

  it('找不到 frozen ASS 時以 MISSING_SOURCE 拒絕，ffmpeg 不會啟動', async () => {
    const setup = make();

    await expect(setup.runner.run(videoJob({ assRef: 'missing.ass' }))).rejects.toMatchObject({
      code: 'MISSING_SOURCE',
    });
    expect(setup.runFfmpeg).not.toHaveBeenCalled();
    expect(existsSync(path.join(setup.tempDir, 'burn_delivery-1.ass'))).toBe(false);
  });

  it('使用者停止優先於隨後的 shutdown，回報 stopped 而不是 error', async () => {
    let setup;
    const runFfmpeg = vi.fn(async (args, options) => {
      const controller = { process: {}, stop: vi.fn(), completion: Promise.resolve() };
      options.onProcess(controller);
      setup.active.get('delivery-1').stopped = true;
      setup.active.get('delivery-1').shutdown = true;
      throw new Error('terminated');
    });
    setup = make({ runFfmpeg });

    await setup.runner.run(videoJob());

    expect(setup.queue.reportProgress).toHaveBeenLastCalledWith(
      'delivery-1', expect.objectContaining({ stopped: true }),
    );
    expect(setup.sent.at(-1)?.payload).toMatchObject({ stopped: true });
  });
});
