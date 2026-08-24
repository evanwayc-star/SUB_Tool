import { describe, it, expect } from 'vitest';
import { detectWaveformTransients, findNearestWaveformSnap } from '../src/waveform-snapping-engine.js';

describe('waveform-snapping-engine', () => {
  it('正確從波形 peaks 中偵測語音起點與終點', () => {
    // 假設 100 samples/sec (每 sample 0.01s)
    // 0~0.2s: 靜音 (energy 0.01)
    // 0.2~0.5s: 語音 (energy 0.5)
    // 0.5~0.8s: 靜音 (energy 0.01)
    const samplesPerSec = 100;
    const totalSamples = 80;
    const peaks = new Float32Array(totalSamples * 2);

    for (let i = 0; i < totalSamples; i++) {
      if (i >= 20 && i < 50) {
        peaks[i * 2] = -0.5;
        peaks[i * 2 + 1] = 0.5;
      } else {
        peaks[i * 2] = -0.01;
        peaks[i * 2 + 1] = 0.01;
      }
    }

    const transients = detectWaveformTransients(peaks, samplesPerSec, {
      threshold: 0.1,
      minSilenceDuration: 0.1,
    });

    expect(transients.length).toBeGreaterThanOrEqual(2);
    expect(transients[0].type).toBe('onset');
    expect(transients[0].time).toBeCloseTo(0.2, 2);

    expect(transients[1].type).toBe('offset');
    expect(transients[1].time).toBeCloseTo(0.5, 2);
  });

  it('在磁吸範圍內精準找到最近的波形特徵點', () => {
    const transients = [
      { time: 1.5, type: 'onset' },
      { time: 3.2, type: 'offset' },
    ];

    // 1.52s 靠近 1.5s (diff=0.02s <= 0.05s)
    const snap1 = findNearestWaveformSnap(1.52, transients, 0.05);
    expect(snap1).not.toBeNull();
    expect(snap1.snappedTime).toBe(1.5);
    expect(snap1.type).toBe('onset');

    // 2.0s 離任何特徵點都很遠 -> 回傳 null
    const snap2 = findNearestWaveformSnap(2.0, transients, 0.05);
    expect(snap2).toBeNull();
  });
});
