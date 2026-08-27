import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShuttleRuntime } from '../src/shuttle-runtime.js';

function makeRuntime({ time = 10 } = {}) {
  const media = {
    displayTime: vi.fn(() => time), seek: vi.fn(value => { time = value; }),
    scrubAudio: vi.fn(), pause: vi.fn(), setRate: vi.fn(), setPlaybackDirection: vi.fn().mockResolvedValue(true),
  };
  const onFallbackFrame = vi.fn();
  const onReachedStart = vi.fn();
  const runtime = createShuttleRuntime({ media, getExactFps: () => 30000 / 1001, onFallbackFrame, onReachedStart });
  return { media, runtime, onFallbackFrame, onReachedStart };
}

describe('shuttle runtime', () => {
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('fallback 只以時間軸 displayTime 倒退並在開頭停止', () => {
    vi.useFakeTimers();
    const { media, runtime, onFallbackFrame, onReachedStart } = makeRuntime({ time: 1 / 60 });
    runtime.setSpeed(-1);
    runtime.startReverseSeekFallback(-1);
    vi.advanceTimersByTime(34);
    expect(media.seek).toHaveBeenCalledWith(0);
    expect(onFallbackFrame).toHaveBeenCalledWith(0, expect.closeTo(1 / 30, 8));
    vi.advanceTimersByTime(34);
    expect(onReachedStart).toHaveBeenCalledTimes(1);
  });

  it('原生倒播在 watchdog 內無進度時只觸發當次 fallback', () => {
    vi.useFakeTimers();
    const { media, runtime } = makeRuntime({ time: 20 });
    const onStall = vi.fn();
    runtime.setSpeed(-1);
    runtime.setNativeReverse(true);
    runtime.watchNativeReverseProgress(-1, runtime.beginEpoch(), onStall);
    vi.advanceTimersByTime(400);
    expect(media.pause).toHaveBeenCalledTimes(1);
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(runtime.isNativeReverse()).toBe(false);
  });

  it('離開原生倒播會恢復 forward，且可重複呼叫', async () => {
    const { media, runtime } = makeRuntime();
    runtime.setNativeReverse(true);
    expect(runtime.leaveNativeReverse()).toBe(true);
    await Promise.resolve();
    expect(media.setPlaybackDirection).toHaveBeenCalledWith('forward');
    expect(runtime.leaveNativeReverse()).toBe(false);
  });
});
