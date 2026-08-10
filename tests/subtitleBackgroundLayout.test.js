import { describe, expect, it } from 'vitest';
import { planSubtitleBackgroundLayouts } from '../src/subtitle-background-layout.js';
import { STYLE_DEFAULTS } from '../src/substyle.js';

describe('字幕單一底色版面', () => {
  it('只凍結最寬行索引與垂直幾何，不把 Chromium 字寬冒充 libass 字寬', () => {
    const track = {
      ...STYLE_DEFAULTS,
      fontSize: 80,
      align: 'center',
      valign: 'middle',
      lineSpacing: 1,
      outline: 2,
      shadow: 0,
      bgBox: true,
    };
    const cue = {
      id: 'uneven-lines',
      track: 0,
      text: '短行\n這一行明顯比較寬',
    };
    const widths = new Map([
      ['短行', 120],
      ['這一行明顯比較寬', 480],
    ]);

    const layouts = planSubtitleBackgroundLayouts([cue], [track], {
      measureLineWidth: line => widths.get(line) ?? 0,
    });
    const layout = layouts['uneven-lines'];

    expect(layout.lineIndex).toBe(1);
    expect(layout.height).toBeCloseTo(145.9, 5);
    expect(layout.offsetY).toBeCloseTo(-72.95, 5);
  });

  it('無底色與直書不建立水平矩形計畫', () => {
    const plain = { ...STYLE_DEFAULTS, bgBox: false };
    const vertical = { ...STYLE_DEFAULTS, bgBox: true, vertical: true };
    const cues = [
      { id: 'plain', track: 0, text: 'A' },
      { id: 'vertical', track: 1, text: '甲\n乙' },
    ];

    expect(planSubtitleBackgroundLayouts(cues, [plain, vertical], {
      measureLineWidth: () => 100,
    })).toEqual({});
  });
});
