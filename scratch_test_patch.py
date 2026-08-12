import re

with open('tests/subtitleBackgroundLayout.test.js', 'r', encoding='utf-8') as f:
    test_code = f.read()

test_search = """  it('無底色與直書不建立水平矩形計畫', () => {
    const plain = { ...STYLE_DEFAULTS, bgBox: false };
    const vertical = { ...STYLE_DEFAULTS, bgBox: true, vertical: true };
    const cues = [
      { id: 'plain', track: 0, text: 'A' },
      { id: 'vertical', track: 1, text: '甲\\n乙' },
    ];

    expect(planSubtitleBackgroundLayouts(cues, [plain, vertical], {
      measureLineWidth: () => 100,
    })).toEqual({});
  });"""

test_replace = """  it('無底色不建立矩形計畫', () => {
    const plain = { ...STYLE_DEFAULTS, bgBox: false };
    const cues = [
      { id: 'plain', track: 0, text: 'A' },
    ];

    expect(planSubtitleBackgroundLayouts(cues, [plain], {
      measureLineWidth: () => 100,
    })).toEqual({});
  });
  
  it('直書建立垂直矩形計畫', () => {
    const vertical = { ...STYLE_DEFAULTS, bgBox: true, vertical: true };
    const cues = [
      { id: 'vertical', track: 0, text: '甲\\n乙' },
    ];

    const layouts = planSubtitleBackgroundLayouts(cues, [vertical], {
      measureLineWidth: () => ({ width: 40, height: 100 }),
    });
    
    expect(layouts['vertical']).toBeDefined();
    expect(layouts['vertical'].height).toBeCloseTo(118, 0); // 100 + padY*2
  });"""

test_code = test_code.replace(test_search, test_replace)

with open('tests/subtitleBackgroundLayout.test.js', 'w', encoding='utf-8') as f:
    f.write(test_code)

print("Test patch applied")
