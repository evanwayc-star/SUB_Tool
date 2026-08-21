import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

function completedProcess({ stdout = '', stderr = '', status = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  queueMicrotask(() => {
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    child.emit('close', status, null);
  });
  return child;
}

describe('媒體探測 interface', () => {
  it('把 ffprobe 輸出正規化成 renderer 使用的 descriptor', async () => {
    const { createMediaProbe } = require('../electron/media-probe');
    const spawnProcess = vi.fn(() => completedProcess({
      stdout: JSON.stringify({
        format: { duration: '12.5' },
        streams: [
          { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 }, width: 800, height: 800 },
          { codec_type: 'video', codec_name: 'prores', avg_frame_rate: '30000/1001', width: 1920, height: 1080 },
          { codec_type: 'audio', index: 2, codec_name: 'pcm_s24le', channels: 2, tags: { LANGUAGE: 'zho', TITLE: '20FM' } },
        ],
      }),
    }));
    const probe = createMediaProbe({ executable: 'ffprobe', spawnProcess });

    await expect(probe.describe('D:/media/master.mov')).resolves.toEqual({
      duration: 12.5,
      video: { codec: 'prores', width: 1920, height: 1080, fps: 30000 / 1001 },
      audio: [{ index: 0, streamIndex: 2, codec: 'pcm_s24le', channels: 2, lang: 'zho', title: '20FM' }],
    });
    expect(spawnProcess).toHaveBeenCalledWith('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', 'D:/media/master.mov',
    ], expect.objectContaining({ windowsHide: true }));
  });

  it('stalled ffprobe 到期後先終止並等 close，下一次探測才可啟動', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      const spawnProcess = vi.fn()
        .mockReturnValueOnce(child)
        .mockImplementation(() => completedProcess({ stdout: JSON.stringify({ streams: [] }) }));
      const { createMediaProbe } = require('../electron/media-probe');
      const probe = createMediaProbe({ executable: 'ffprobe', spawnProcess, timeoutMs: 25 });

      let firstSettled = false;
      const result = probe.describe('//server/slow/master.mxf').catch(error => {
        firstSettled = true;
        return error;
      });
      await vi.advanceTimersByTimeAsync(25);

      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(firstSettled).toBe(false);

      const nextResult = probe.describe('D:/media/next.mov');
      await Promise.resolve();
      expect(spawnProcess).toHaveBeenCalledTimes(1);

      child.emit('close', null, 'SIGKILL');
      await expect(result).resolves.toMatchObject({ code: 'PROBE_TIMEOUT' });
      await expect(nextResult).resolves.toMatchObject({ audio: [] });
      expect(spawnProcess).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('音訊存在探測失敗時採保守策略，不會讓 legacy export 靜默漏音訊', async () => {
    const { createMediaProbe } = require('../electron/media-probe');
    const probe = createMediaProbe({
      executable: 'ffprobe',
      spawnProcess: () => completedProcess({ status: 1, stderr: 'network input failed' }),
    });

    await expect(probe.hasAudio('Z:/offline/master.mxf')).resolves.toBe(true);
  });

  it('交付完成後回報檔案實際寫入的聲道數與 bitrate', async () => {
    const { createMediaProbe } = require('../electron/media-probe');
    const probe = createMediaProbe({
      executable: 'ffprobe',
      spawnProcess: () => completedProcess({
        stdout: JSON.stringify({ streams: [
          { channels: 2, bit_rate: '320000' },
          { channels: 6, bit_rate: '639500' },
        ] }),
      }),
    });

    await expect(probe.audioBitrates('D:/delivery/program.mp4')).resolves.toEqual([
      { channels: 2, kbps: 320 },
      { channels: 6, kbps: 640 },
    ]);
  });

  it('caller 取消探測時會終止 native process', async () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => queueMicrotask(() => child.emit('close', null, 'SIGTERM')));
    const controller = new AbortController();
    const { createMediaProbe } = require('../electron/media-probe');
    const probe = createMediaProbe({ executable: 'ffprobe', spawnProcess: () => child });

    const result = probe.describe('D:/media/slow.mxf', { signal: controller.signal }).catch(error => error);
    await Promise.resolve();
    controller.abort();

    expect(child.kill).toHaveBeenCalledTimes(1);
    await expect(result).resolves.toMatchObject({ code: 'PROBE_ABORTED' });
  });

  it('終止後未收到 close 會安全收斂，且阻擋新的 ffprobe 重疊啟動', async () => {
    vi.useFakeTimers();
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => { throw new Error('kill refused'); });
    const spawnProcess = vi.fn(() => child);
    try {
      const controller = new AbortController();
      const { createMediaProbe } = require('../electron/media-probe');
      const probe = createMediaProbe({
        executable: 'ffprobe',
        spawnProcess,
        terminationGraceMs: 50,
      });
      let outcome = null;
      const result = probe.describe('D:/media/stuck.mov', { signal: controller.signal })
        .catch(error => { outcome = error; return error; });

      await Promise.resolve();
      expect(spawnProcess).toHaveBeenCalledTimes(1);
      controller.abort();
      await vi.advanceTimersByTimeAsync(50);

      expect(outcome).toMatchObject({
        code: 'PROBE_TERMINATION_TIMEOUT',
        cause: { code: 'PROBE_ABORTED' },
      });
      await expect(result).resolves.toBe(outcome);
      await expect(probe.describe('D:/media/must-not-overlap.mov'))
        .rejects.toMatchObject({ code: 'PROBE_TERMINATION_PENDING' });
      expect(spawnProcess).toHaveBeenCalledTimes(1);
    } finally {
      child.emit('close', null, 'SIGKILL');
      vi.useRealTimers();
    }
  });

  it('malformed ffprobe JSON 以穩定錯誤碼拒絕', async () => {
    const { createMediaProbe } = require('../electron/media-probe');
    const probe = createMediaProbe({
      executable: 'ffprobe',
      spawnProcess: () => completedProcess({ stdout: '{broken' }),
    });

    await expect(probe.describe('D:/media/broken.mov')).rejects.toMatchObject({ code: 'PROBE_PARSE' });
  });
});
