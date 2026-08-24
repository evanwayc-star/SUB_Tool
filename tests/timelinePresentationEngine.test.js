import { describe, it, expect } from 'vitest';
import {
  buildTimelineSceneGraph,
  computeRulerTicks,
} from '../src/timeline-presentation-engine.js';

describe('timeline-presentation-engine', () => {
  it('正確依視窗座標範圍計算虛擬場景圖 (Scene Graph)', () => {
    const viewport = {
      scrollLeft: 1000,
      viewportW: 1000,
      pxPerSec: 100,
      viewStart: 0,
    };
    // 視野範圍約 10s ~ 20s (外加 4s 緩衝 = 6s ~ 24s)

    const cues = [
      { id: 'c1', start: 1.0, end: 3.0, text: '太早的字幕' },
      { id: 'c2', start: 12.0, end: 15.0, text: '視野內的字幕' },
      { id: 'c3', start: 30.0, end: 35.0, text: '太晚的字幕' },
    ];

    const clips = [
      { id: 'v1', offset: 10.0, duration: 5.0, name: '影片片段' },
    ];

    const scene = buildTimelineSceneGraph(viewport, cues, clips, {
      selectedIds: ['c2'],
      primaryId: 'c2',
    });

    expect(scene.cues.length).toBe(1);
    expect(scene.cues[0].id).toBe('c2');
    expect(scene.cues[0].selected).toBe(true);
    expect(scene.cues[0].primary).toBe(true);

    expect(scene.clips.length).toBe(1);
    expect(scene.clips[0].id).toBe('v1');
  });

  it('計算標尺刻度圖元', () => {
    const ticks = computeRulerTicks(0, 10, 1.0, 100, 0);
    expect(ticks.length).toBeGreaterThanOrEqual(10);
    expect(ticks[0].time).toBe(0);
    expect(ticks[0].isMajor).toBe(true);
  });
});
