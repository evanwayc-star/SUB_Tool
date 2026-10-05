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
  it('有效素材在 16 秒後完成探測時，仍保留完整音視訊資訊', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      const completion = setTimeout(() => {
        child.stdout.end(JSON.stringify({
          format: { duration: '123.5' },
          streams: [
            { codec_type: 'video', codec_name: 'prores', width: 2048, height: 858, avg_frame_rate: '24/1' },
            { codec_type: 'audio', index: 1, codec_name: 'pcm_s24le', channels: 6 },
          ],
        }));
        child.emit('close', 0, null);
      }, 16000);
      child.kill = vi.fn(() => {
        clearTimeout(completion);
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
      });
      const { createMediaProbe } = require('../electron/media-probe');
      const probe = createMediaProbe({ executable: 'ffprobe', spawnProcess: () => child });
      const result = probe.describe('D:/media/slow-but-valid.mov').catch(error => error);

      await vi.advanceTimersByTimeAsync(16000);

      await expect(result).resolves.toMatchObject({
        duration: 123.5,
        video: { width: 2048, height: 858, fps: 24 },
        audio: [{ streamIndex: 1, channels: 6 }],
      });
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['hasAudio', 'audioVideoStartOffsets', 'audioBitrates'])('%s 取消不被保守 fallback 吞掉，且等待 native close', async method => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    const controller = new AbortController();
    const { createMediaProbe } = require('../electron/media-probe');
    const probe = createMediaProbe({ executable: 'ffprobe', spawnProcess: () => child });
    let settled = false;
    const result = probe[method]('D:/media/slow.mxf', { signal: controller.signal }).catch(error => { settled = true; return error; });
    await Promise.resolve();
    controller.abort();
    expect(child.kill).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit('close', null, 'SIGTERM');
    await expect(result).resolves.toMatchObject({ code: 'PROBE_ABORTED' });
  });

  it('同時還原多個有效素材時，不會因探測搶讀而誤報超時，排隊也不占執行期限', async () => {
    vi.useFakeTimers();
    try {
      let active = 0;
      let peak = 0;
      const spawnProcess = vi.fn(() => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        active++;
        peak = Math.max(peak, active);
        const completion = setTimeout(() => {
          active--;
          child.stdout.end(JSON.stringify({ format: { duration: '123.5' }, streams: [] }));
          child.emit('close', 0, null);
        }, active * 5000);
        child.kill = vi.fn(() => {
          clearTimeout(completion);
          active--;
          queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        });
        return child;
      });
      const { createMediaProbe } = require('../electron/media-probe');
      const probe = createMediaProbe({ executable: 'ffprobe', spawnProcess, timeoutMs: 15000 });
      const results = Promise.all(['a.mov', 'b.mxf', 'c.mp4', 'd.mov'].map(file =>
        probe.describe(`D:/media/${file}`).catch(error => error)));

      await vi.advanceTimersByTimeAsync(20000);

      await expect(results).resolves.toEqual(Array.from({ length: 4 }, () => ({
        duration: 123.5, video: null, audio: [],
      })));
      expect(peak).toBeLessThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('同母檔的並行探測共用進行中的 native 工作，下一次重新探測可讀到更新內容', async () => {
    const children = [];
    const spawnProcess = vi.fn(() => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      children.push(child);
      return child;
    });
    const { createMediaProbe } = require('../electron/media-probe');
    const probe = createMediaProbe({ executable: 'ffprobe', spawnProcess });
    const first = probe.describe('D:/media/master.mov');
    const second = probe.describe('D:/media/master.mov');
    await Promise.resolve();
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    children[0].stdout.end(JSON.stringify({ format: { duration: '12' }, streams: [] }));
    children[0].emit('close', 0, null);
    await expect(first).resolves.toMatchObject({ duration: 12 });
    await expect(second).resolves.toMatchObject({ duration: 12 });

    const next = probe.describe('D:/media/master.mov');
    await Promise.resolve();
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    children[1].stdout.end(JSON.stringify({ format: { duration: '24' }, streams: [] }));
    children[1].emit('close', 0, null);
    await expect(next).resolves.toMatchObject({ duration: 24 });
  });

  it('排隊期間取消不會啟動 ffprobe，後續素材仍可完成探測', async () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    const spawnProcess = vi.fn().mockReturnValueOnce(child)
      .mockImplementation(() => completedProcess({ stdout: JSON.stringify({ streams: [] }) }));
    const { createMediaProbe } = require('../electron/media-probe');
    const probe = createMediaProbe({ executable: 'ffprobe', spawnProcess, maxConcurrent: 1 });
    const first = probe.describe('D:/media/first.mov');
    await Promise.resolve();
    const controller = new AbortController();
    const cancelled = probe.describe('D:/media/cancelled.mov', { signal: controller.signal }).catch(error => error);
    const next = probe.describe('D:/media/next.mov');
    controller.abort();
    await expect(cancelled).resolves.toMatchObject({ code: 'PROBE_ABORTED' });
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    child.stdout.end(JSON.stringify({ streams: [] }));
    child.emit('close', 0, null);
    await expect(first).resolves.toMatchObject({ audio: [] });
    await expect(next).resolves.toMatchObject({ audio: [] });
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(spawnProcess.mock.calls[1][1].at(-1)).toBe('D:/media/next.mov');
  });

  it('同母檔有取消所有者的工作不會中止其他 caller 的探測', async () => {
    const children = [];
    const spawnProcess = vi.fn(() => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn(() => queueMicrotask(() => child.emit('close', null, 'SIGTERM')));
      children.push(child);
      return child;
    });
    const { createMediaProbe } = require('../electron/media-probe');
    const probe = createMediaProbe({ executable: 'ffprobe', spawnProcess });
    const controller = new AbortController();
    const independent = probe.describe('D:/media/master.mov');
    const cancelled = probe.describe('D:/media/master.mov', { signal: controller.signal }).catch(error => error);
    await Promise.resolve();
    controller.abort();
    await expect(cancelled).resolves.toMatchObject({ code: 'PROBE_ABORTED' });
    expect(children[0].kill).not.toHaveBeenCalled();
    children[0].stdout.end(JSON.stringify({ format: { duration: '12' }, streams: [] }));
    children[0].emit('close', 0, null);
    await expect(independent).resolves.toMatchObject({ duration: 12 });
  });

  it('spawn 失敗後共用工作與佇列會釋放，重試可取得素材資訊', async () => {
    const spawnProcess = vi.fn().mockImplementationOnce(() => { throw new Error('process unavailable'); })
      .mockImplementation(() => completedProcess({ stdout: JSON.stringify({ format: { duration: '12' }, streams: [] }) }));
    const { createMediaProbe } = require('../electron/media-probe');
    const probe = createMediaProbe({ executable: 'ffprobe', spawnProcess, maxConcurrent: 1 });
    const first = probe.describe('D:/media/master.mov').catch(error => error);
    const shared = probe.describe('D:/media/master.mov').catch(error => error);
    const next = probe.describe('D:/media/next.mov');
    await expect(first).resolves.toMatchObject({ message: 'process unavailable' });
    await expect(shared).resolves.toMatchObject({ message: 'process unavailable' });
    await expect(next).resolves.toMatchObject({ duration: 12 });
    await expect(probe.describe('D:/media/master.mov')).resolves.toMatchObject({ duration: 12 });
    expect(spawnProcess).toHaveBeenCalledTimes(3);
  });

  it('排隊工作等待期間若再有另一個行程取消，會等全部終止屏障關閉才啟動', async () => {
    const children = [];
    const spawnProcess = vi.fn(() => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      children.push(child);
      return child;
    });
    const { createMediaProbe } = require('../electron/media-probe');
    const probe = createMediaProbe({ executable: 'ffprobe', spawnProcess, maxConcurrent: 3 });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = probe.describe('D:/media/a.mov', { signal: firstController.signal }).catch(error => error);
    const second = probe.describe('D:/media/b.mov', { signal: secondController.signal }).catch(error => error);
    const third = probe.describe('D:/media/c.mov');
    const next = probe.describe('D:/media/d.mov').catch(error => error);
    await Promise.resolve();
    firstController.abort();
    children[2].stdout.end(JSON.stringify({ streams: [] }));
    children[2].emit('close', 0, null);
    await third;
    secondController.abort();
    children[0].emit('close', null, 'SIGTERM');
    await first;
    expect(spawnProcess).toHaveBeenCalledTimes(3);
    children[1].emit('close', null, 'SIGTERM');
    await second;
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(4));
    children[3].stdout.end(JSON.stringify({ streams: [] }));
    children[3].emit('close', 0, null);
    await expect(next).resolves.toMatchObject({ audio: [] });
  });

  it('預設上限仍會中止永久卡住的探測，確認 close 後才回報超時', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      const { createMediaProbe } = require('../electron/media-probe');
      const probe = createMediaProbe({ executable: 'ffprobe', spawnProcess: () => child });
      let settled = false;
      const result = probe.describe('D:/media/stuck.mov').catch(error => { settled = true; return error; });
      await vi.advanceTimersByTimeAsync(16000);
      expect(child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(44000);
      expect(child.kill).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      child.emit('close', null, 'SIGTERM');
      await expect(result).resolves.toMatchObject({ code: 'PROBE_TIMEOUT' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('保留壓縮來源音訊相對影像的起始時間，供航空交付去除前導', async () => {
    const { createMediaProbe } = require('../electron/media-probe');
    const probe = createMediaProbe({ executable: 'ffprobe', spawnProcess: () => completedProcess({
      stdout: JSON.stringify({ streams: [
        { codec_type: 'video', start_time: '0', disposition: { attached_pic: 1 } },
        { codec_type: 'video', start_time: '2.033367' },
        { codec_type: 'audio', start_time: '2.023344' },
        { codec_type: 'audio', start_time: '2.033367' },
      ] }),
    }) });
    await expect(probe.audioVideoStartOffsets('D:/media/encoded.mpg'))
      .resolves.toEqual([expect.closeTo(-0.010023, 6), 0]);
  });

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
