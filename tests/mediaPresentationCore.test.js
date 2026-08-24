import { describe, it, expect } from 'vitest';
import {
  timeToFrameIndex,
  frameIndexToTime,
  stepFrameTime,
  measureClockDrift,
  createMasterClock,
} from '../src/media-presentation-core.js';

describe('media-presentation-core', () => {
  it('時間與影格序號精準雙向轉換', () => {
    const fps = 25;
    const time = 2.0; // 第 50 格
    const frame = timeToFrameIndex(time, fps);
    expect(frame).toBe(50);
    expect(frameIndexToTime(frame, fps)).toBe(2.0);
  });

  it('精確逐格前後步進 (Step Frames)', () => {
    const fps = 30;
    // 從 1.0s (第 30 格) 後退 1 格 -> 第 29 格 = 29/30 = 0.96666...s
    const prev = stepFrameTime(1.0, -1, fps);
    expect(prev).toBeCloseTo(29 / 30, 4);

    // 前進 1 格 -> 第 31 格 = 31/30s
    const next = stepFrameTime(1.0, 1, fps);
    expect(next).toBeCloseTo(31 / 30, 4);
  });

  it('正確量測音畫漂移並判定是否需要強制 seek', () => {
    // 漂移 0.02s (在 0.04s 容差內)
    const d1 = measureClockDrift(1.02, 1.0, 0.04);
    expect(d1.outOfSync).toBe(false);
    expect(d1.needsHardSeek).toBe(false);

    // 漂移 0.1s (超過 0.04s，但小於 0.3s)
    const d2 = measureClockDrift(1.1, 1.0, 0.04);
    expect(d2.outOfSync).toBe(true);
    expect(d2.needsHardSeek).toBe(false);

    // 漂移 0.5s (嚴重脫節，需 hard seek)
    const d3 = measureClockDrift(1.5, 1.0, 0.04);
    expect(d3.outOfSync).toBe(true);
    expect(d3.needsHardSeek).toBe(true);
  });

  it('主時鐘 (Master Clock) 正確推進時間', () => {
    const clock = createMasterClock({ time: 10.0, speed: 1.0, fps: 30 });
    expect(clock.getTime()).toBe(10.0);

    clock.play();
    // 推進 1000ms
    const t = clock.tick(performance.now() + 1000);
    expect(t).toBeGreaterThanOrEqual(10.9);
  });
});
