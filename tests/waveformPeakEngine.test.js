import { describe, it, expect } from 'vitest';
import {
  extractChannelPeaks,
  downsamplePeaks,
} from '../src/waveform-peak-engine.js';

describe('waveform-peak-engine', () => {
  it('正確從 PCM float 陣列萃取 min/max 峰值', () => {
    // 1000 點採樣，採樣率 1000Hz，目標每秒 10 點 -> 每 block 100 點，共 10 blocks
    const pcm = new Float32Array(1000);
    pcm[50] = 0.8; // 第一個 block max 應為 0.8
    pcm[60] = -0.6; // 第一個 block min 應為 -0.6

    const peaks = extractChannelPeaks(pcm, 1000, 10);
    expect(peaks.length).toBe(20); // 10 blocks * 2
    expect(peaks[0]).toBeCloseTo(-0.6, 2);
    expect(peaks[1]).toBeCloseTo(0.8, 2);
  });

  it('多層級 LOD 降採樣運算', () => {
    // 4 個 blocks 的峰值
    const src = new Float32Array([
      -0.2, 0.5,
      -0.7, 0.3,
      -0.1, 0.9,
      -0.4, 0.2,
    ]);

    // 因子 2 降採樣 -> 變成 2 個 blocks
    const down = downsamplePeaks(src, 2);
    expect(down.length).toBe(4);

    // block 0: min(-0.2, -0.7) = -0.7, max(0.5, 0.3) = 0.5
    expect(down[0]).toBeCloseTo(-0.7, 5);
    expect(down[1]).toBeCloseTo(0.5, 5);

    // block 1: min(-0.1, -0.4) = -0.4, max(0.9, 0.2) = 0.9
    expect(down[2]).toBeCloseTo(-0.4, 5);
    expect(down[3]).toBeCloseTo(0.9, 5);
  });
});

