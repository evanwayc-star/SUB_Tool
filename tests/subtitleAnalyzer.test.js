// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/subtitle-model.js', () => ({ detectOverlaps: () => new Set() }));
vi.mock('../src/subtitle-text-check.js', () => ({
  inspectSubtitleCharacters: () => ({ simplified: [], unsupported: [] }),
}));

import { analyzeSubtitles } from '../src/subtitle-audit.js';

describe('連續相同字幕診斷', () => {
  it('同一影格內仍有真實間隙時，不可把兩句視為頭尾相接', () => {
    const nominalFps = 29.97;
    const boundaryFrame = 600000;
    const exactOnlyJoinedOut = (boundaryFrame + 0.49) / nominalFps;
    const exactOnlyJoinedIn = (boundaryFrame + 0.51) / nominalFps;
    expect(Math.round(exactOnlyJoinedOut * nominalFps)).not.toBe(
      Math.round(exactOnlyJoinedIn * nominalFps),
    );
    const cues = [
      { id: 'gap-a', text: '相同但有間隙', start: 0, end: 1, timed: true },
      { id: 'gap-b', text: '相同但有間隙', start: 1.04, end: 2, timed: true },
      { id: 'joined-a', text: '相同而且黏接', start: 3, end: exactOnlyJoinedOut, timed: true },
      { id: 'joined-b', text: '相同而且黏接', start: exactOnlyJoinedIn, end: exactOnlyJoinedIn + 1, timed: true },
    ];

    const report = analyzeSubtitles(cues, { fps: 29.97 });

    expect(report.consecutiveIdenticalNums).toEqual([1, 2, 3, 4]);
    expect(report.consecutiveIdenticalJoinedNums).toEqual([]);
    expect(report.consecutiveIdenticalRanges).toEqual([[1, 1], [2, 2], [3, 3], [4, 4]]);
  });

  it('三句相同時，只壓縮真正相接的一對，其餘單獨顯示', () => {
    const cues = [
      { id: 'first', text: '同一句', start: 0, end: 1, timed: true },
      { id: 'second', text: '同一句', start: 1, end: 2, timed: true },
      { id: 'third', text: '同一句', start: 2.08, end: 3, timed: true },
    ];

    const report = analyzeSubtitles(cues, { fps: 25 });

    expect(report.consecutiveIdenticalNums).toEqual([1, 2, 3]);
    expect(report.consecutiveIdenticalJoinedNums).toEqual([1, 2]);
    expect(report.consecutiveIdenticalRanges).toEqual([[1, 2], [3, 3]]);
  });

  it.each([23.976, 24, 25, 29.97, 30])('相接以時間軸秒數為準，不受 %s FPS 影格標籤影響', fps => {
    const cues = [
      { id: 'a', text: '相同', start: 0, end: 0.1 + 0.2 },
      { id: 'b', text: '相同', start: 0.3, end: 1 },
      { id: 'c', text: '相同', start: 1, end: 2 },
      { id: 'd', text: '相同', start: 2, end: 3 },
      { id: 'e', text: '相同', start: 3.000001, end: 4 },
      { id: 'f', text: '相同', start: 4, end: 5 },
      { id: 'g', text: '相同', start: 4.999999, end: 6 },
    ];
    const before = structuredClone(cues);
    const report = analyzeSubtitles(cues, { fps });
    expect(report.consecutiveIdenticalGroups).toEqual([[1, 2, 3, 4, 5, 6, 7]]);
    expect(report.consecutiveIdenticalRanges).toEqual([[1, 4], [5, 6], [7, 7]]);
    expect(report.consecutiveIdenticalJoinedNums).toEqual([1, 2, 3, 4, 5, 6]);
    expect(cues).toEqual(before);
  });

  it('六小時 NTSC 端點只吸收浮點誤差，微秒間隙仍拆開', () => {
    const exactFps = 30000 / 1001, start = 647352 / exactFps;
    const cues = [
      { id: 'a', text: '同句', start: start - 1, end: start },
      { id: 'b', text: '同句', start: start + Number.EPSILON * start, end: start + 1 },
      { id: 'c', text: '同句', start: start + 1.000001, end: start + 2 },
    ];
    expect(analyzeSubtitles(cues, { fps: 29.97 }).consecutiveIdenticalRanges).toEqual([[1, 2], [3, 3]]);
  });

  it.each([
    { timed: false }, { start: null }, { end: null }, { start: NaN },
    { end: Infinity }, { start: -1 }, { end: 1 },
  ])('未定時或無效區間不可成為連續範圍的橋接：%j', invalid => {
    const cues = [
      { id: 'a', text: '同句', start: 0, end: 1 },
      { id: 'b', text: '同句', start: 1, end: 2, ...invalid },
      { id: 'c', text: '同句', start: 2, end: 3 },
    ];
    expect(analyzeSubtitles(cues).consecutiveIdenticalRanges).toEqual([[1, 1], [2, 2], [3, 3]]);
  });

  it('不同軌道、不同文字或空白中斷群組，不可跨組合併編號範圍', () => {
    const cues = [
      { text: '甲', start: 0, end: 1, track: 0 },
      { text: '甲', start: 1, end: 2, track: 0 },
      { text: '甲', start: 2, end: 3, track: 1 },
      { text: '甲', start: 3, end: 4, track: 1 },
      { text: '', start: 4, end: 5, track: 1 },
      { text: '乙', start: 5, end: 6, track: 1 },
      { text: '乙', start: 6, end: 7, track: 1 },
      { text: '甲', start: 7, end: 8, track: 0 },
    ];
    const report = analyzeSubtitles(cues);
    expect(report.consecutiveIdenticalGroups).toEqual([[1, 2], [3, 4], [6, 7]]);
    expect(report.consecutiveIdenticalNums).toEqual([1, 2, 3, 4, 6, 7]);
    expect(report.consecutiveIdenticalRanges).toEqual([[1, 2], [3, 4], [6, 7]]);
  });
});
