import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createSpeechAudioReader, validateSpeechAudioRequest, buildSpeechAudioArgs,
  SAMPLE_RATE, MAX_READ_BYTES } = require('../electron/speech-audio-reader.js');
const request = (extra = {}) => ({ path: 'C:/素材/原始音訊.mxf', start: 12, duration: 4 / 16000,
  sourceStream: 0, sourceChannel: null, processed: false, requestId: 'speech-read-1', ...extra });
const media = { duration: 100, video: { timestampOffset: -5 }, audio: [
  { channels: 2, timestampOffset: -5 }, { channels: 1, timestampOffset: -5 },
] };
function owner() { const sender = new EventEmitter(); sender.isDestroyed = () => false; return sender; }
function fixture({ probe = vi.fn(async () => media), closeOnKill = true, timeoutMs = 120000 } = {}) {
  const children = [];
  const spawn = vi.fn(() => {
    const child = new EventEmitter(); child.pid = 100 + children.length;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = vi.fn(signal => { if (closeOnKill) queueMicrotask(() => child.emit('close', null, signal)); return true; });
    children.push(child); return child;
  });
  const runtime = createSpeechAudioReader({ getFFmpegPath: () => 'trusted-ffmpeg', probe, spawn, timeoutMs });
  return { runtime, spawn, children, probe };
}
async function launched(f) { for (let i = 0; i < 6 && !f.children.length; i++) await Promise.resolve(); return f.children[0]; }
function pcm(values) { return Buffer.from(new Float32Array(values).buffer); }
afterEach(() => vi.useRealTimers());

describe('辨識專用有界 PCM 讀取', () => {
  it.each([{ start: -1 }, { start: Infinity }, { start: '2' }, { duration: 0 },
    { duration: 600.0001 }, { duration: NaN }, { duration: 1e-9 },
    { sourceStream: -1 }, { sourceStream: 256 }, { sourceChannel: 128 },
    { sourceChannel: .5 }, { processed: 'true' }, { path: '' }, { path: 'a\0b' },
    { requestId: '../escape' }, { requestId: '' }])('拒絕無效參數 %j', invalid => {
    expect(() => validateSpeechAudioRequest(request(invalid))).toThrow();
  });

  it('只依 probe 的 stream/channel 編譯等權 mono、母片時鐘與精確 sample 上限', () => {
    const args = buildSpeechAudioArgs(request({ sourceStream: 0, duration: 1 }), media);
    expect(args[args.indexOf('-ss') + 1]).toBe('17');
    expect(args[args.indexOf('-map') + 1]).toBe('0:a:0');
    const filter = args[args.indexOf('-af') + 1];
    expect(filter).toContain('pan=mono|c0=0.5*c0+0.5*c1');
    expect(filter).toContain('aresample=16000:async=1:first_pts=0');
    expect(filter).toContain('apad=whole_len=16000,atrim=end_sample=16000');
    expect(args.slice(-4)).toEqual(['pcm_f32le', '-f', 'f32le', 'pipe:1']);
    expect(args).not.toContain('volume');
    expect(MAX_READ_BYTES).toBe(600 * 16000 * 4);
  });

  it('來源channel與processed零原點獨立，不能套回母片偏移或混其它stream', () => {
    const args = buildSpeechAudioArgs(request({ sourceChannel: 1, processed: true }), media);
    expect(args[args.indexOf('-ss') + 1]).toBe('12');
    expect(args[args.indexOf('-af') + 1]).toContain('pan=mono|c0=c1');
    expect(() => buildSpeechAudioArgs(request({ sourceStream: 2 }), media)).toThrow(/串流/);
    expect(() => buildSpeechAudioArgs(request({ sourceStream: 1, sourceChannel: 1 }), media)).toThrow(/聲道/);
    expect(() => buildSpeechAudioArgs(request(), { audio: [{ channels: 129 }] })).toThrow(/聲道/);
  });

  it('以實際 PCM bytes 跨任意 stdout chunk 邊界回傳，且回覆精確可持有的 ArrayBuffer', async () => {
    const f = fixture(), sender = owner(), pending = f.runtime.read(sender, request());
    const child = await launched(f), data = pcm([.25, -.5, .75, 0]);
    child.stdout.emit('data', data.subarray(0, 3)); child.stdout.emit('data', data.subarray(3));
    child.emit('close', 0);
    const result = await pending;
    expect(result).toMatchObject({ sampleRate: SAMPLE_RATE, numberOfChannels: 1, frames: 4 });
    expect(result.pcm).toBeInstanceOf(ArrayBuffer);
    expect([...new Float32Array(result.pcm)]).toEqual([.25, -.5, .75, 0]);
    data.fill(0); expect(new Float32Array(result.pcm)[1]).toBe(-.5);
    expect(sender.listenerCount('destroyed')).toBe(0); expect(f.runtime.activeCount()).toBe(0);
  });

  it.each([0, 200])('完全沒有音訊packet的正常EOF仍回指定長度靜音（start %s）', async start => {
    const f = fixture(), pending = f.runtime.read(owner(), request({ start }));
    const child = await launched(f); child.emit('close', 0);
    expect([...new Float32Array((await pending).pcm)]).toEqual([0, 0, 0, 0]);
  });

  it.each([3, 8])('非零短輸出 %s bytes 不能偽裝成功或默默補零', async length => {
    const f = fixture(), pending = f.runtime.read(owner(), request());
    const rejected = expect(pending).rejects.toThrow(/完整|截斷/);
    const child = await launched(f); child.stdout.emit('data', Buffer.alloc(length)); child.emit('close', 0);
    await rejected; expect(f.runtime.activeCount()).toBe(0);
  });

  it('超量輸出立即中止，但仍等 native close 才釋放 owner', async () => {
    const f = fixture({ closeOnKill: false }), sender = owner(), pending = f.runtime.read(sender, request());
    const rejected = expect(pending).rejects.toThrow(/上限/), child = await launched(f);
    child.stdout.emit('data', Buffer.alloc(17));
    expect(child.kill).toHaveBeenCalledWith('SIGTERM'); expect(f.runtime.activeCount()).toBe(1);
    child.emit('close', null, 'SIGTERM'); await rejected; expect(f.runtime.activeCount()).toBe(0);
  });

  it('失敗code帶有受限stderr，不能以部分PCM當有效辨識來源', async () => {
    const f = fixture(), pending = f.runtime.read(owner(), request());
    const rejected = expect(pending).rejects.toThrow(/讀取失敗.*bad AAC/), child = await launched(f);
    child.stdout.emit('data', pcm([1, 2, 3, 4])); child.stderr.emit('data', Buffer.from('bad AAC')); child.emit('close', 1);
    await rejected;
  });

  it('每sender只准一個pending，其他sender不能取消本工作', async () => {
    const f = fixture(), sender = owner(), other = owner(), pending = f.runtime.read(sender, request());
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const child = await launched(f);
    await expect(f.runtime.read(sender, request({ requestId: 'new' }))).rejects.toMatchObject({ code: 'SPEECH_AUDIO_BUSY' });
    expect(f.runtime.cancel(other, 'speech-read-1')).toBe(false);
    expect(f.runtime.cancel(sender, 'speech-read-1')).toBe(true);
    child.stdout.emit('data', pcm([1, 2, 3, 4])); await rejected;
    expect(f.spawn).toHaveBeenCalledTimes(1); expect(f.runtime.activeCount()).toBe(0);
  });

  it('probe等待時取消會撤銷late spawn，保留signal與收尾所有權', async () => {
    let resolveProbe; const probe = vi.fn(() => new Promise(resolve => { resolveProbe = resolve; }));
    const f = fixture({ probe }), sender = owner(), pending = f.runtime.read(sender, request());
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve(); f.runtime.cancel(sender, 'speech-read-1');
    expect(probe.mock.calls[0][1].signal.aborted).toBe(true);
    resolveProbe(media); await rejected;
    expect(f.spawn).not.toHaveBeenCalled(); expect(f.runtime.activeCount()).toBe(0);
  });

  it('sender關閉停止自己的child，late成功不能回傳PCM', async () => {
    const f = fixture(), sender = owner(), pending = f.runtime.read(sender, request());
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const child = await launched(f); sender.emit('destroyed'); child.stdout.emit('data', pcm([1, 2, 3, 4]));
    child.emit('close', 0); await rejected; expect(sender.listenerCount('destroyed')).toBe(0);
  });

  it('shutdown等真close、逾時不假裝結束，resume也不越過未收尾工作', async () => {
    vi.useFakeTimers();
    const f = fixture({ closeOnKill: false }), pending = f.runtime.read(owner(), request());
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' }), child = await launched(f);
    const closing = f.runtime.cancelAllAndWait({ timeoutMs: 20 });
    const timeout = expect(closing).rejects.toMatchObject({ code: 'SPEECH_AUDIO_TERMINATION_PENDING' });
    await vi.advanceTimersByTimeAsync(20); await timeout;
    expect(f.runtime.activeCount()).toBe(1); expect(f.runtime.resume()).toBe(false);
    await expect(f.runtime.read(owner(), request())).rejects.toMatchObject({ name: 'AbortError' });
    child.emit('close', 0); await cancelled; expect(f.runtime.activeCount()).toBe(0);
    const resumed = f.runtime.read(owner(), request()); await Promise.resolve(); await Promise.resolve();
    f.children[1].emit('close', 0); await resumed;
  });

  it('probe或child逾時受同一deadline保護，TERM後仍不close會升級KILL', async () => {
    vi.useFakeTimers();
    const f = fixture({ closeOnKill: false, timeoutMs: 20 }), pending = f.runtime.read(owner(), request());
    const rejected = expect(pending).rejects.toThrow(/逾時/), child = await launched(f);
    await vi.advanceTimersByTimeAsync(20); expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(1000); expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null, 'SIGKILL'); await rejected;
  });

  it('probe失敗或不存在的來源聲道不啟動decoder，也不殘留sender工作', async () => {
    const f = fixture({ probe: vi.fn().mockRejectedValueOnce(new Error('probe failed'))
      .mockResolvedValueOnce({ audio: [] }).mockResolvedValueOnce({ audio: [{ channels: 1 }] }) }), sender = owner();
    await expect(f.runtime.read(sender, request())).rejects.toThrow('probe failed');
    await expect(f.runtime.read(sender, request())).rejects.toThrow(/串流/);
    await expect(f.runtime.read(sender, request({ sourceChannel: 1 }))).rejects.toThrow(/聲道/);
    expect(f.spawn).not.toHaveBeenCalled(); expect(f.runtime.activeCount()).toBe(0);
    expect(sender.listenerCount('destroyed')).toBe(0);
  });

  it('沒有ffmpeg立即失敗，不做probe或錯誤回傳靜音', async () => {
    const probe = vi.fn(), spawn = vi.fn();
    const runtime = createSpeechAudioReader({ getFFmpegPath: () => '', probe, spawn });
    await expect(runtime.read(owner(), request())).rejects.toThrow(/找不到 ffmpeg/);
    expect(probe).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
  });

  it.each([false, true])('spawn error存活PID=%s：只有確認沒活程序才可立刻收尾', async live => {
    const f = fixture({ closeOnKill: false }), pending = f.runtime.read(owner(), request());
    const rejected = expect(pending).rejects.toThrow('spawn failure'), child = await launched(f);
    if (!live) child.pid = undefined;
    child.emit('error', new Error('spawn failure'));
    if (live) { expect(f.runtime.activeCount()).toBe(1); child.emit('close', 1); }
    await rejected; expect(f.runtime.activeCount()).toBe(0);
  });
});
