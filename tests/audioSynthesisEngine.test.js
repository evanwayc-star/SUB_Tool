import { describe, it, expect } from 'vitest';
import {
  buildAudioRoutingGraph,
  computeEffectiveBusGain,
  buildFfmpegAudioPanFilter,
} from '../src/audio-synthesis-engine.js';

describe('audio-synthesis-engine', () => {
  it('正確建立專案音訊匯流排拓撲', () => {
    const graph = buildAudioRoutingGraph({
      sourceChannelCount: 4,
      busConfig: [
        { volume: 0.8, muted: false, solo: false },
        { volume: 1.0, muted: true, solo: false },
      ],
    });

    expect(graph.buses.length).toBe(8);
    expect(graph.buses[0].volume).toBe(0.8);
    expect(graph.buses[1].muted).toBe(true);
    expect(graph.buses[0].sourceMap).toEqual([0]);
  });

  it('精確計算 Solo 與 Mute 狀態下的有效增益', () => {
    const normalBus = { volume: 1.0, muted: false, solo: false };
    const soloBus = { volume: 0.9, muted: false, solo: true };
    const muteBus = { volume: 1.0, muted: true, solo: false };

    // 無任何 solo 時，正常軌播放、靜音軌為 0
    expect(computeEffectiveBusGain(normalBus, false)).toBe(1.0);
    expect(computeEffectiveBusGain(muteBus, false)).toBe(0);

    // 有任一軌 solo 時，非 solo 軌全靜音，solo 軌維持音量
    expect(computeEffectiveBusGain(normalBus, true)).toBe(0);
    expect(computeEffectiveBusGain(soloBus, true)).toBe(0.9);
  });

  it('產生 ffmpeg 音訊 filter 規格', () => {
    const buses = [{ volume: 1.0, muted: false, solo: false }];
    const filter = buildFfmpegAudioPanFilter(buses, 2);
    expect(filter).toBe('volume=1.0');
  });
});
