import { describe, expect, it, vi } from 'vitest';
import { createNativeAudioMeterClient } from '../src/native-audio-meter.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const request = (over = {}) => ({ path: 'source.mov', sourceKey: 'clip-1', time: 10, ...over });
const result = (time = 10, level = 0.5) => ({ time, levels: [{ sourceStream: 0, sourceChannel: 1, level }] });
function setup(options = {}) {
  let clock = 0;
  const read = options.read || vi.fn(async () => result());
  const stop = options.stop || vi.fn();
  const client = createNativeAudioMeterClient({ read, stop, now: () => clock });
  return { client, read, stop, at: value => { clock = value; } };
}

describe('native audio meter renderer client', () => {
  it('mix changes revoke late bus peaks without stopping or overlapping the source decoder', async () => {
    const first = deferred(), second = deferred();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { client, stop, at } = setup({ read });
    const mixes = [{ busId: 'a', inputs: [{ sourceStream: 0, sourceChannel: 1, gain: 1 }] }];
    client.sample(request({ mixes }));
    expect(read.mock.calls[0][0].mixes).toEqual(mixes);
    mixes[0].inputs[0].gain = .5;
    expect(read.mock.calls[0][0].mixes[0].inputs[0].gain).toBe(1);
    at(100); expect(client.sample(request({ mixes }))).toBeNull();
    first.resolve({ ...result(), busLevels: [{ busId: 'a', level: .5 }] }); await flush();
    expect(client.sample(request({ mixes }))).toBeNull();
    expect(read).toHaveBeenCalledTimes(2); expect(stop).not.toHaveBeenCalled();
    second.resolve({ ...result(), busLevels: [{ busId: 'a', level: .25 }] }); await flush();
    expect(client.sample(request({ mixes })).busLevels).toEqual([{ busId: 'a', level: .25 }]);
  });

  it.each([undefined, [{ busId: 'wrong', level: .5 }], [{ busId: 'a', level: NaN }], [{ busId: 'a', level: -1 }]])
  ('mix requests reject missing, mismatched or malformed bus levels %j', async busLevels => {
    const { client } = setup({ read: vi.fn(async () => ({ ...result(), busLevels })) });
    const value = request({ mixes: [{ busId: 'a', inputs: [] }] });
    client.sample(value); await flush(); expect(client.sample(value)).toBeNull();
  });

  it('sample synchronously returns the latest decoded levels and polls at most every 100ms', async () => {
    const { client, read, at } = setup();
    expect(client.sample(request())).toBeNull();
    expect(read).toHaveBeenCalledExactlyOnceWith({ path: 'source.mov', time: 10, rate: 1 });
    await flush();
    expect(client.sample(request())).toEqual(result());
    at(99); client.sample(request({ time: 10.099 }));
    expect(read).toHaveBeenCalledTimes(1);
    at(100); expect(client.sample(request({ time: 10.1 }))).toEqual(result());
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keeps a single pending read even when many polling intervals elapse', async () => {
    const pending = deferred();
    const { client, read, at } = setup({ read: vi.fn(() => pending.promise) });
    for (let i = 0; i < 20; i++) { at(i * 100); client.sample(request({ time: 10 + i / 10 })); }
    expect(read).toHaveBeenCalledTimes(1);
    pending.resolve(result(11.9)); await flush();
    expect(client.sample(request({ time: 11.9 }))).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each([
    { path: 'other.mov' }, { sourceKey: 'clip-2' }, { rate: 2 }, { time: 40 },
  ])('revokes late responses and waits for stop plus the old read on change %j', async change => {
    const oldRead = deferred(), stopped = deferred(), nextRead = deferred();
    const read = vi.fn().mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(nextRead.promise);
    const { client, stop, at } = setup({ read, stop: vi.fn(() => stopped.promise) });
    client.sample(request()); at(100);
    const next = request(change);
    expect(client.sample(next)).toBeNull();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    stopped.resolve(); await flush();
    client.sample(next);
    expect(read).toHaveBeenCalledTimes(1);
    oldRead.resolve(result()); await flush();
    expect(client.sample(next)).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1][0]).toEqual({ path: next.path, time: next.time, rate: next.rate ?? 1 });
    nextRead.resolve(result(next.time, 0.25)); await flush();
    expect(client.sample(next)).toEqual(result(next.time, 0.25));
  });

  it('cannot start the replacement before an asynchronous stop completes', async () => {
    const stopped = deferred();
    const { client, read, at } = setup({ stop: vi.fn(() => stopped.promise) });
    client.sample(request()); await flush(); at(100);
    expect(client.sample(request({ time: 30 }))).toBeNull(); await flush();
    client.sample(request({ time: 30 })); expect(read).toHaveBeenCalledTimes(1);
    stopped.resolve(); await flush();
    client.sample(request({ time: 30 })); expect(read).toHaveBeenCalledTimes(2);
  });

  it('several replacements during stop keep only the latest source and one stop barrier', async () => {
    const stopped = deferred();
    const { client, read, stop, at } = setup({ stop: vi.fn(() => stopped.promise) });
    client.sample(request()); await flush(); at(100);
    client.sample(request({ path: 'second.mov' }));
    client.sample(request({ path: 'third.mov', sourceKey: 'clip-3' }));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    stopped.resolve(); await flush();
    client.sample(request({ path: 'third.mov', sourceKey: 'clip-3' }));
    expect(read).toHaveBeenLastCalledWith({ path: 'third.mov', time: 10, rate: 1 });
  });

  it('detects seeks relative to expected playback progress, including the playback rate', async () => {
    const { client, stop, at } = setup();
    client.sample(request({ rate: 2 })); await flush();
    at(600); client.sample(request({ time: 11.2, rate: 2 }));
    expect(stop).not.toHaveBeenCalled(); await flush();
    at(700); client.sample(request({ time: 11.95, rate: 2 }));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('clear immediately removes the snapshot, rejects late replies, and sends only one stop', async () => {
    const pending = deferred();
    const { client, read, stop, at } = setup({ read: vi.fn(() => pending.promise) });
    client.sample(request());
    for (let i = 0; i < 50; i++) client.clear();
    expect(stop).toHaveBeenCalledTimes(1);
    pending.resolve(result()); await flush(); at(100);
    expect(client.sample(request())).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('clear of an unused client does not send an unnecessary stop', () => {
    const { client, stop } = setup(); client.clear(); client.clear();
    expect(stop).not.toHaveBeenCalled();
  });

  it('an invalid request clears an active meter without scheduling native work', async () => {
    const { client, read, stop } = setup();
    client.sample(request()); await flush();
    for (const value of [null, {}, request({ path: '' }), request({ time: NaN }), request({ rate: 0 })]) {
      expect(client.sample(value)).toBeNull();
    }
    expect(read).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('expires snapshots after 400ms even when the source time is unchanged', async () => {
    const pending = deferred();
    const read = vi.fn().mockResolvedValueOnce(result()).mockReturnValue(pending.promise);
    const { client, at } = setup({ read });
    client.sample(request()); await flush();
    at(399); expect(client.sample(request())).toEqual(result());
    at(401); expect(client.sample(request())).toBeNull();
    pending.resolve(null); await flush();
  });

  it('rejects old or future source timestamps more than 0.5 seconds from the latest request', async () => {
    for (const time of [9.49, 10.51]) {
      const { client } = setup({ read: vi.fn(async () => result(time)) });
      client.sample(request()); await flush();
      expect(client.sample(request())).toBeNull();
    }
  });

  it('a slow read cannot become a fresh snapshot simply by arriving late', async () => {
    const pending = deferred();
    const { client, at } = setup({ read: vi.fn(() => pending.promise) });
    client.sample(request()); at(401); pending.resolve(result()); await flush();
    expect(client.sample(request())).toBeNull();
  });

  it.each([
    null, { time: NaN, levels: [] }, { time: 10, levels: null },
    result(10, NaN), result(10, Infinity), result(10, -1),
    { time: 10, levels: [{ sourceStream: -1, sourceChannel: 0, level: 0.5 }] },
    { time: 10, levels: [{ sourceStream: 0, sourceChannel: 0.5, level: 0.5 }] },
    { time: 10, levels: [{ sourceStream: '0', sourceChannel: 0, level: 0.5 }] },
  ])('rejects malformed native results: %j', async value => {
    const { client } = setup({ read: vi.fn(async () => value) });
    client.sample(request()); await flush(); expect(client.sample(request())).toBeNull();
  });

  it.each(['throw', 'reject'])('read %s is contained and retried on the next polling interval', async failure => {
    const read = vi.fn().mockImplementationOnce(() => {
      if (failure === 'throw') throw new Error('read failed');
      return Promise.reject(new Error('read failed'));
    }).mockResolvedValue(result(10.1));
    const { client, at } = setup({ read });
    expect(() => client.sample(request())).not.toThrow(); await flush();
    at(100); expect(client.sample(request({ time: 10.1 }))).toBeNull(); await flush();
    expect(client.sample(request({ time: 10.1 }))).toEqual(result(10.1));
  });

  it('contains rejected stop calls without leaving an unhandled promise', async () => {
    const { client, read, at } = setup({ stop: vi.fn(async () => { throw new Error('already stopped'); }) });
    client.sample(request()); await flush(); client.clear(); await flush(); at(100);
    client.sample(request()); expect(read).toHaveBeenCalledTimes(2);
  });
});
