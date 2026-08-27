import { describe, expect, it } from 'vitest';
import { planSubtitleBackgroundLayouts } from '../src/subtitle-background-layout.js';
import { STYLE_DEFAULTS } from '../src/substyle.js';

describe('字幕單一底色版面', () => {
  it('只凍結最寬行索引與整段垂直幾何，不傳遞跨引擎數值寬度', () => {
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
    expect(layout.height).toBeCloseTo(151.5, 5);
    expect(layout.offsetY).toBeCloseTo(-75.75, 5);
    expect(layout.textLines).toHaveLength(2);
    expect(layout).not.toHaveProperty('width');
    expect(layout).not.toHaveProperty('boxW');
    expect(layout).not.toHaveProperty('absoluteX');
  });

  it('無底色不建立矩形計畫', () => {
    const plain = { ...STYLE_DEFAULTS, bgBox: false };
    const cues = [
      { id: 'plain', track: 0, text: 'A' },
    ];

    expect(planSubtitleBackgroundLayouts(cues, [plain], {
      measureLineWidth: () => 100,
    })).toEqual({});
  });
  
  it('直書建立垂直矩形計畫', () => {
    const vertical = { ...STYLE_DEFAULTS, fontSize: 60, bgBox: true, vertical: true };
    const cues = [
      { id: 'vertical', track: 0, text: '甲\n乙' },
    ];

    const layouts = planSubtitleBackgroundLayouts(cues, [vertical], {
      measureLineWidth: () => ({ width: 40, height: 100 }),
    });
    
    expect(layouts['vertical']).toBeDefined();
    expect(layouts['vertical'].height).toBeCloseTo(118, 0); // 100 + padY*2
  });
});
