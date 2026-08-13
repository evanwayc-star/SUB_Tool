// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/subtitle-model.js', () => ({ detectOverlaps: () => new Set() }));
vi.mock('../src/subtitle-text-check.js', () => ({
  inspectSubtitleCharacters: () => ({ simplified: [], unsupported: [] }),
}));

import { analyzeSubtitles } from '../src/subtitle-analyzer.js';

describe('連續相同字幕診斷', () => {
  it('只把同一影格頭尾黏接的一對都標為深綠編號', () => {
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
    expect(report.consecutiveIdenticalJoinedNums).toEqual([3, 4]);
  });

  it('三句相同時，只讓真正黏接的那一對變成深綠編號', () => {
    const cues = [
      { id: 'first', text: '同一句', start: 0, end: 1, timed: true },
      { id: 'second', text: '同一句', start: 1, end: 2, timed: true },
      { id: 'third', text: '同一句', start: 2.08, end: 3, timed: true },
    ];

    const report = analyzeSubtitles(cues, { fps: 25 });

    expect(report.consecutiveIdenticalNums).toEqual([1, 2, 3]);
    expect(report.consecutiveIdenticalJoinedNums).toEqual([1, 2]);
  });
});
