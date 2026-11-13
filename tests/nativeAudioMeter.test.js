import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createNativeAudioMeter } = require('../electron/native-audio-meter.js');
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function pcm(values, frames = 2400) {
  const bytes = Buffer.alloc(frames * values.length * 4);
  for (let frame = 0; frame < frames; frame++) values.forEach((value, channel) =>
    bytes.writeFloatLE((frame % 2 ? -1 : 1) * value, (frame * values.length + channel) * 4));
  return bytes;
}
function fixture({ info = { video: {}, audio: [{ channels: 2 }, { channels: 1 }] }, describeSource,
  automaticClose = true, spawnError = false } = {}) {
  const children = [];
  const spawn = vi.fn((file, args, options) => {
    if (spawnError) throw new Error('spawn failed');
    const child = new EventEmitter();
    child.stdio = options.stdio.map(() => new PassThrough());
    child.stderr = child.stdio[2];
    child.kill = vi.fn(() => {
      if (automaticClose) Promise.resolve().then(() => child.emit('close', null, 'SIGTERM'));
      return true;
    });
    children.push(child);
    return child;
  });
  const probe = describeSource || vi.fn(async () => info);
  const meter = createNativeAudioMeter({ spawn, ffmpeg: () => 'trusted-ffmpeg', describeSource: probe });
  return { meter, spawn, children, probe,
    read: (time = 0, extra = {}) => meter.read({ path: 'C:/mother.mxf', time, ...extra }) };
}
const runtimes = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  vi.useRealTimers();
});
const setup = options => { const f = fixture(options); runtimes.push(f.meter); return f; };

describe('原生播放音量表的只讀 PCM 取樣', () => {
  it('同一視窗的 signed PCM 跨 stream 混音，相加削波、反相相消，改配線不重啟解碼', async () => {
    const f = setup(); await f.read();
    f.children[0].stdio[3].write(pcm([.6, -.6]));
    f.children[0].stdio[4].write(pcm([.6]));
    const input = (sourceStream, sourceChannel, gain = 1) => ({ sourceStream, sourceChannel, gain });
    const mixes = [
      { busId: 'sum', inputs: [input(0, 0), input(1, 0)] },
      { busId: 'cancel', inputs: [input(0, 0), input(0, 1)] },
      { busId: 'weighted', inputs: [input(0, 0, .25), input(1, 0, .75)] },
      { busId: 'silent', inputs: [] },
    ];
    const result = await f.read(.025, { mixes });
    expect(result.busLevels.map(item => item.busId)).toEqual(['sum', 'cancel', 'weighted', 'silent']);
    expect(result.busLevels[0].level).toBeCloseTo(1.2, 6);
    expect(result.busLevels[1].level).toBe(0);
    expect(result.busLevels[2].level).toBeCloseTo(.6, 6);
    expect(result.busLevels[3].level).toBe(0);
    const changed = await f.read(.025, { mixes: [{ busId: 'sum', inputs: [input(0, 0, .5)] }] });
    expect(changed.busLevels).toHaveLength(1); expect(changed.busLevels[0].level).toBeCloseTo(.3, 6);
    expect(f.spawn).toHaveBeenCalledOnce(); expect(f.children[0].kill).not.toHaveBeenCalled();
  });

  it('單 input 與完整 signed sum 相等，連續多 bus / 多次讀取不殘留上一組加總', async () => {
    const f = setup(); await f.read();
    const stereo = Buffer.alloc(2400 * 2 * 4), mono = Buffer.alloc(2400 * 4);
    for (let frame = 0; frame < 2400; frame++) {
      const wave = Math.sin(frame * .017) * .7, other = Math.cos(frame * .031) * .4;
      stereo.writeFloatLE(wave, frame * 8); stereo.writeFloatLE(-wave, frame * 8 + 4);
      mono.writeFloatLE(other, frame * 4);
    }
    f.children[0].stdio[3].write(stereo); f.children[0].stdio[4].write(mono);
    const input = (sourceStream, sourceChannel, gain = 1) => ({ sourceStream, sourceChannel, gain });
    const mixes = [
      ...[0, .125, 1, 3.5].map(gain => ({ busId: `single-${gain}`, inputs: [input(0, 1, gain)] })),
      { busId: 'in-phase', inputs: [input(0, 0), input(0, 0)] },
      { busId: 'cancel', inputs: [input(0, 0), input(0, 1)] },
      { busId: 'different-gains', inputs: [input(0, 0, .5), input(0, 1, 2), input(1, 0, .25)] },
      { busId: 'empty', inputs: [] },
    ];
    const reference = mix => {
      let peak = 0;
      for (let frame = 0; frame < 2400; frame++) {
        let sum = 0;
        for (const { sourceStream, sourceChannel, gain } of mix.inputs) {
          sum += (sourceStream ? mono.readFloatLE(frame * 4) : stereo.readFloatLE(frame * 8 + sourceChannel * 4)) * gain;
        }
        peak = Math.max(peak, Math.abs(sum));
      }
      return { busId: mix.busId, level: peak };
    };
    const result = await f.read(.025, { mixes });
    expect(result.busLevels).toEqual(mixes.map(reference));
    for (const gain of [0, .125, 1, 3.5]) {
      expect(result.busLevels.find(level => level.busId === `single-${gain}`).level).toBe(result.levels[1].level * gain);
    }
    const reversed = mixes.toReversed();
    expect((await f.read(.025, { mixes: reversed })).busLevels).toEqual(reversed.map(reference));
    expect(f.spawn).toHaveBeenCalledOnce();
  });

  it.each([
    null, {}, [{ busId: '', inputs: [] }], [{ busId: 'a', inputs: 'graph' }],
    [{ busId: 'a', inputs: [{ sourceStream: -1, sourceChannel: 0, gain: 1 }] }],
    [{ busId: 'a', inputs: [{ sourceStream: 0, sourceChannel: .5, gain: 1 }] }],
    [{ busId: 'a', inputs: [{ sourceStream: 0, sourceChannel: 0, gain: Infinity }] }],
    [{ busId: 'a', inputs: [{ sourceStream: 0, sourceChannel: 0, gain: -1 }] }],
    [{ busId: 'a', inputs: [] }, { busId: 'a', inputs: [] }],
  ])('拒絕未授權混音結構 %j，不能啟動 decoder', async mixes => {
    const f = setup(); expect(await f.read(0, { mixes })).toBeNull(); expect(f.spawn).not.toHaveBeenCalled();
  });

  it('mix 引用不存在的來源聲道時不以其他聲道或零值冒充完整混音', async () => {
    const f = setup(); await f.read();
    f.children[0].stdio[3].write(pcm([.5, .25])); f.children[0].stdio[4].write(pcm([.5]));
    expect(await f.read(.025, { mixes: [{ busId: 'bad', inputs: [{ sourceStream: 0, sourceChannel: 2, gain: 1 }] }] })).toBeNull();
  });

  it('逐 stream/channel 解析真實浮點樣本，chunk 可切在 sample 中間且保留超載峰值', async () => {
    const f = setup();
    expect(await f.read()).toBeNull();
    const child = f.children[0], stereo = pcm([0.125, 1.25]);
    child.stdio[3].write(stereo.subarray(0, 3));
    child.stdio[3].write(stereo.subarray(3, 101));
    child.stdio[3].write(stereo.subarray(101));
    child.stdio[4].write(pcm([0.5]));
    const result = await f.read(0.025);
    expect(result.time).toBeCloseTo(0.025);
    expect(result.levels).toEqual([
      { sourceStream: 0, sourceChannel: 0, level: 0.125 },
      { sourceStream: 0, sourceChannel: 1, level: 1.25 },
      { sourceStream: 1, sourceChannel: 0, level: 0.5 },
    ]);
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.spawn.mock.calls[0][2]).toMatchObject({ windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  });

  it('影片與各音訊 stream 的時間原點只在 native 邊界換算，且保留原聲道數', async () => {
    const f = setup({ info: { video: { timestampOffset: -5 }, audio: [
      { channels: 2, timestampOffset: -4.9 }, { channels: 6, timestampOffset: -5 },
    ] } });
    await f.read(2, { rate: 1.5 });
    const [file, args] = f.spawn.mock.calls[0];
    expect(file).toBe('trusted-ffmpeg');
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 2)).toEqual(['-ss', '7']);
    // Input readrate throttles seek pre-roll and leaves a fixed source-time lag.
    // The consumer applies bounded PCM backpressure after accurate seek instead.
    expect(args).not.toContain('-readrate');
    expect(args).toContain('0:a:0'); expect(args).toContain('0:a:1');
    expect(args).toContain('pipe:3'); expect(args).toContain('pipe:4');
    expect(args).toContain('asetpts=PTS+0.100000/TB,aresample=48000:async=1:first_pts=0');
    expect(args).not.toContain('-ac');
    expect(args.filter(value => value === 'pcm_f32le')).toHaveLength(2);
  });

  it('連續讀取沿用程序，長時間 probe 完成後從當下來源位置開始，不重啟飢餓', async () => {
    const probe = deferred(), f = setup({ describeSource: vi.fn(() => probe.promise) });
    const first = f.read(4);
    await flush();
    await vi.advanceTimersByTimeAsync(600);
    const second = f.read(4.6);
    probe.resolve({ video: {}, audio: [{ channels: 1 }] });
    await first; await second;
    expect(f.spawn).toHaveBeenCalledOnce();
    const args = f.spawn.mock.calls[0][1];
    expect(Number(args[args.indexOf('-ss') + 1])).toBeCloseTo(4.6);
    await vi.advanceTimersByTimeAsync(100);
    await f.read(4.7);
    expect(f.spawn).toHaveBeenCalledOnce();
  });

  it.each([{ path: 'C:/other.mov', time: 0 }, { time: 8 }, { rate: 2, time: 0 }])
  ('換素材、跳轉、變速 %j 都等舊程序 close 才建新程序', async change => {
    const f = setup({ automaticClose: false });
    await f.read();
    const old = f.children[0], next = f.read(change.time, change);
    await flush();
    expect(old.kill).toHaveBeenCalledWith('SIGTERM');
    expect(f.spawn).toHaveBeenCalledOnce();
    old.emit('close', null, 'SIGTERM');
    expect(await next).toBeNull();
    expect(f.spawn).toHaveBeenCalledTimes(2);
    const closing = f.meter.stop(); f.children[1].emit('close', null, 'SIGTERM'); await closing;
  });

  it('停止撤銷尚未完成的 probe，晚到回覆不能產生子程序；stop 後可重新使用', async () => {
    const probe = deferred(), f = setup({ describeSource: vi.fn(() => probe.promise) });
    const first = f.read(); await flush();
    await f.meter.stop();
    expect(await first).toBeNull();
    probe.resolve({ audio: [{ channels: 1 }] }); await flush();
    expect(f.spawn).not.toHaveBeenCalled();
    await f.read();
    expect(f.spawn).toHaveBeenCalledOnce();
  });

  it('只讀到目前來源位置附近，pipe 背壓保留未來資料而非解碼整檔', async () => {
    const f = setup({ info: { audio: [{ channels: 1 }] } });
    await f.read();
    const pipe = f.children[0].stdio[3], bytes = pcm([0.25], 48000 * 10);
    pipe.write(bytes);
    expect((await f.read(0.1)).levels[0].level).toBe(0.25);
    expect(bytes.length - pipe.readableLength).toBeLessThanOrEqual(48000 * 4 * 0.3);
    expect(pipe.readableLength).toBeGreaterThan(48000 * 4 * 9);
    await f.read(10);
    const child = f.children.at(-1);
    child.stdio[3].write(pcm([0.4]));
    expect((await f.read(10.025)).levels[0].level).toBeCloseTo(0.4);
    await vi.advanceTimersByTimeAsync(600);
    expect(await f.read(10.6)).toBeNull();
  });

  it('一秒沒有 read 自動停止，舊 PCM 及退出事件不影響新的來源', async () => {
    const f = setup(); await f.read(); const old = f.children[0];
    await vi.advanceTimersByTimeAsync(1000);
    expect(old.kill).toHaveBeenCalledWith('SIGTERM');
    await f.read(3);
    old.stdio[3].write(pcm([0.9, 0.9])); old.emit('close', 1);
    expect(await f.read(3.1)).toBeNull();
    expect(f.spawn).toHaveBeenCalledTimes(2);
  });

  it('程序拒絕正常結束時強制終止，仍等待 close 後才允許重啟', async () => {
    const f = setup({ automaticClose: false }); await f.read();
    const child = f.children[0], stopped = f.meter.stop();
    expect(child.stdio[3].destroyed).toBe(true);
    expect(child.stdio[4].destroyed).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
    const pending = f.read(2); await flush(); expect(f.spawn).toHaveBeenCalledOnce();
    child.emit('close', null, 'SIGKILL'); await stopped; await pending;
    const closing = f.meter.stop(); f.children[1].emit('close', null, 'SIGTERM'); await closing;
  });

  it('probe、spawn 或 stream 錯誤只清除取樣，不拋到播放 UI；dispose 禁止新程序', async () => {
    const badProbe = setup({ describeSource: async () => { throw new Error('probe failed'); } });
    expect(await badProbe.read()).toBeNull();
    const badSpawn = setup({ spawnError: true }); expect(await badSpawn.read()).toBeNull();
    const f = setup(); await f.read();
    f.children[0].stdio[3].emit('error', new Error('pipe failed'));
    await flush(); expect(f.children[0].kill).toHaveBeenCalled();
    await f.meter.dispose();
    expect(await f.read()).toBeNull(); expect(f.spawn).toHaveBeenCalledOnce();
  });

  it('首段 PCM 晚到時可以追上正在播放的位置，不因固定延遲永久回傳 null', async () => {
    const f = setup({ info: { audio: [{ channels: 1 }] } });
    await f.read(30);
    await vi.advanceTimersByTimeAsync(700);
    expect(await f.read(30.7)).toBeNull();
    f.children[0].stdio[3].write(pcm([0.25], 48000));
    const result = await f.read(30.7);
    expect(result.time).toBeCloseTo(30.675);
    expect(result.levels[0].level).toBe(0.25);
    expect(f.spawn).toHaveBeenCalledOnce();
  });

  it('低速播放不預讀過遠，當前 PCM 不會尚未播放就超過新鮮度期限', async () => {
    const f = setup({ info: { audio: [{ channels: 1 }] } });
    await f.read(0, { rate: 0.25 });
    f.children[0].stdio[3].write(pcm([0.25], 48000));
    expect((await f.read(0, { rate: 0.25 })).levels[0].level).toBe(0.25);
    await vi.advanceTimersByTimeAsync(700);
    const result = await f.read(0.175, { rate: 0.25 });
    expect(result).not.toBeNull();
    expect(result.time).toBeCloseTo(0.175);
    expect(result.levels[0].level).toBe(0.25);
    expect(f.spawn).toHaveBeenCalledOnce();
  });
});
