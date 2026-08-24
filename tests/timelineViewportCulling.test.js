import { describe, it, expect } from 'vitest';
import { visibleTimeRange, cullCues, cullClips, cullOverlaps } from '../src/timeline-viewport-culling.js';

describe('timeline-viewport-culling', () => {
  it('正確計算含安全緩衝區之可視時間範圍', () => {
    // scrollLeft=1000px, viewportW=1000px, pxPerSec=100px/s, bufferPx=500px
    // left = 1000 - 500 = 500px -> 5.0s
    // right = 1000 + 1000 + 500 = 2500px -> 25.0s
    const range = visibleTimeRange(1000, 1000, 100, 500);
    expect(range.tMin).toBeCloseTo(5.0, 5);
    expect(range.tMax).toBeCloseTo(25.0, 5);
  });

  it('在最左側時時間下限不小於 0', () => {
    const range = visibleTimeRange(100, 1000, 100, 500);
    expect(range.tMin).toBe(0);
    expect(range.tMax).toBeCloseTo(16.0, 5);
  });

  it('精準篩選與視窗交集之字幕 (Cues)', () => {
    const cues = [
      { id: 'c1', in: 1.0, out: 3.0 },   // 完全在左側 buiten
      { id: 'c2', in: 4.0, out: 6.0 },   // 跨越 tMin (5.0s) -> 應保留
      { id: 'c3', in: 10.0, out: 12.0 }, // 完全在視窗內 -> 應保留
      { id: 'c4', in: 24.0, out: 26.0 }, // 跨越 tMax (25.0s) -> 應保留
      { id: 'c5', in: 30.0, out: 32.0 }, // 完全在右側 buiten
    ];

    const culled = cullCues(cues, 5.0, 25.0);
    expect(culled.map(c => c.id)).toEqual(['c2', 'c3', 'c4']);
  });

  it('精準篩選與視窗交集之時間軸片段 (Clips)', () => {
    const clips = [
      { id: 'v1', start: 0.0, duration: 4.0 },  // end=4.0 < 5.0 -> 排除
      { id: 'v2', start: 4.0, duration: 5.0 },  // end=9.0 >= 5.0 -> 保留
      { id: 'v3', start: 20.0, duration: 10.0 },// start=20.0 <= 25.0 -> 保留
      { id: 'v4', start: 26.0, duration: 2.0 }, // start=26.0 > 25.0 -> 排除
    ];

    const culled = cullClips(clips, 5.0, 25.0);
    expect(culled.map(c => c.id)).toEqual(['v2', 'v3']);
  });

  it('精準篩選重疊標記 (Overlaps)', () => {
    const overlaps = [
      { id1: 'c1', id2: 'c2', start: 1.0, end: 2.0 },
      { id1: 'c2', id2: 'c3', start: 5.5, end: 6.0 },
      { id1: 'c4', id2: 'c5', start: 28.0, end: 29.0 },
    ];

    const culled = cullOverlaps(overlaps, 5.0, 25.0);
    expect(culled.map(o => o.id1)).toEqual(['c2']);
  });
});
