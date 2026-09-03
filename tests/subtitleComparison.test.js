import { describe, expect, it } from 'vitest';
import { buildSubtitleComparisonPlan, subtitleFrameIndex } from '../src/subtitle-comparison-engine.js';
import { getExactFps, snapTimeToFrame } from '../src/time.js';

describe('字幕比對 plan', () => {
  it('影格比對使用 time.js 的唯一吸附格網', () => {
    const fps = 29.97;
    const time = 10.016;

    expect(subtitleFrameIndex(time, fps)).toBe(
      Math.round(snapTimeToFrame(time, fps) * getExactFps(fps)),
    );
  });

  it('使用 canonical 29.97 NDF 時碼，而不是牆鐘秒數自行格式化', () => {
    const plan = buildSubtitleComparisonPlan({
      tracks: [{ name: 'A' }, { name: 'B' }],
      cues: [
        { id: 'left', track: 0, start: 3600, end: 3601, text: '左' },
        { id: 'right', track: 1, start: 3600, end: 3601, text: '右' },
      ],
      fps: 29.97,
      dropFrame: false,
    }, { leftTrack: 0, rightTrack: 1 });

    expect(plan.rows[0].left.startTimecode).toBe('00:59:56:12');
  });

  it('使用 canonical drop-frame 時碼', () => {
    const plan = buildSubtitleComparisonPlan({
      tracks: [{ name: 'A' }, { name: 'B' }],
      cues: [
        { id: 'left', track: 0, start: 3600, end: 3601, text: '左' },
        { id: 'right', track: 1, start: 3600, end: 3601, text: '右' },
      ],
      fps: 29.97,
      dropFrame: true,
    }, { leftTrack: 0, rightTrack: 1 });

    expect(plan.rows[0].left.startTimecode).toBe('01:00:00;00');
  });

  it('開始相同但結束落在不同影格時仍是時間差異', () => {
    const plan = buildSubtitleComparisonPlan({
      tracks: [{ name: 'A' }, { name: 'B' }],
      cues: [
        { id: 'left', track: 0, start: 10, end: 11, text: '同一句' },
        { id: 'right', track: 1, start: 10, end: 12, text: '同一句' },
      ],
      fps: 25,
    }, { leftTrack: 0, rightTrack: 1 });

    expect(plan.rows[0].difference.time).toBe(true);
    expect(plan.rows[0].active.time).toBe(true);
  });

  it('比較生效樣式而非 raw cue.style', () => {
    const plan = buildSubtitleComparisonPlan({
      tracks: [{ name: 'A', fontSize: 80 }, { name: 'B', fontSize: 60 }],
      cues: [
        { id: 'left', track: 0, start: 10, end: 11, text: '同一句' },
        { id: 'right', track: 1, start: 10, end: 11, text: '同一句' },
      ],
      fps: 25,
    }, { leftTrack: 0, rightTrack: 1 });

    expect(plan.rows[0].difference.style).toBe(true);
    expect(plan.rows[0].difference.styleKeys).toEqual(['fontSize']);
  });

  it('不同 raw override 但生效樣式相同時不報樣式差異', () => {
    const plan = buildSubtitleComparisonPlan({
      tracks: [{ name: 'A', fontSize: 80 }, { name: 'B', fontSize: 60 }],
      cues: [
        { id: 'left', track: 0, start: 10, end: 11, text: '同一句', style: { fontSize: 60 } },
        { id: 'right', track: 1, start: 10, end: 11, text: '同一句' },
      ],
      fps: 25,
    }, { leftTrack: 0, rightTrack: 1 });

    expect(plan.rows[0].difference.style).toBe(false);
  });

  it('關閉某類檢查只改 active result，不篡改實際差異', () => {
    const plan = buildSubtitleComparisonPlan({
      tracks: [{ name: 'A', fontSize: 80 }, { name: 'B', fontSize: 60 }],
      cues: [
        { id: 'left', track: 0, start: 10, end: 11, text: '同一句' },
        { id: 'right', track: 1, start: 10, end: 11, text: '同一句' },
      ],
      fps: 25,
    }, { leftTrack: 0, rightTrack: 1, checks: { style: false } });

    expect(plan.rows[0].difference.style).toBe(true);
    expect(plan.rows[0].active.style).toBe(false);
    expect(plan.rows[0].active.any).toBe(false);
  });

  it('維持既有一秒 greedy pairing，並保留缺句 row', () => {
    const plan = buildSubtitleComparisonPlan({
      tracks: [{ name: 'A' }, { name: 'B' }],
      cues: [
        { id: 'left-1', track: 0, start: 10, end: 11, text: '左一' },
        { id: 'left-2', track: 0, start: 12, end: 13, text: '左二' },
        { id: 'right-1', track: 1, start: 10.9, end: 11.9, text: '右一' },
      ],
      fps: 25,
    }, { leftTrack: 0, rightTrack: 1 });

    expect(plan.rows).toHaveLength(2);
    expect(plan.rows[0].left.id).toBe('left-1');
    expect(plan.rows[0].right.id).toBe('right-1');
    expect(plan.rows[1].left.id).toBe('left-2');
    expect(plan.rows[1].right).toBeNull();
  });
});
