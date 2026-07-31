/* 「這個樣式等於哪一組常用樣式」的唯一判準，以及「沒有作用的逐句覆蓋要清掉」。

   v5.9.1 之前同一個謂詞在專案裡有三份實作（subtitles.js 兩處內聯、app.js 的
   _sameStyle），靠註解維持同步——而那兩則註解指名的 `_trackPresetName` 早就改名
   成 `_getPresetNameForStyle` 了，註解沒跟上。新增樣式欄位時只會有人想到改一處。 */
import { describe, expect, it } from 'vitest';
import { STYLE_DEFAULTS, effStyle, styleMatchesPreset, pruneRedundantCueStyle } from '../src/substyle.js';

const styleOf = (over = {}) => ({ ...STYLE_DEFAULTS, ...over });

describe('styleMatchesPreset', () => {
  it('preset 沒寫到的欄位視為預設值', () => {
    expect(styleMatchesPreset(styleOf(), { style: {} })).toBe(true);
    expect(styleMatchesPreset(styleOf(), {})).toBe(true);
  });

  it('全欄位相符才算命中', () => {
    expect(styleMatchesPreset(styleOf({ fontSize: 80 }), { style: { fontSize: 80 } })).toBe(true);
    expect(styleMatchesPreset(styleOf({ fontSize: 80 }), { style: { fontSize: 60 } })).toBe(false);
  });

  it('任何一個欄位不同就不算命中（不可只比對部分欄位）', () => {
    for (const k of Object.keys(STYLE_DEFAULTS)) {
      const v = STYLE_DEFAULTS[k];
      const different = typeof v === 'number' ? v + 7 : (typeof v === 'boolean' ? !v : String(v) + 'x');
      expect(styleMatchesPreset(styleOf({ [k]: different }), { style: {} }), `欄位 ${k}`).toBe(false);
    }
  });

  it('直接傳 style 物件（不包 preset 殼）也能比對', () => {
    expect(styleMatchesPreset(styleOf({ bold: false }), { bold: false })).toBe(true);
  });
});

describe('pruneRedundantCueStyle', () => {
  const track = { fontSize: 80, color: '#ffee00' };

  it('與軌道相同的覆蓋會被清掉', () => {
    const cue = { style: { fontSize: 80 } };
    expect(pruneRedundantCueStyle(cue, track)).toBe(true);
    expect(cue.style).toBeUndefined();
  });

  it('與軌道不同的覆蓋一律保留（那是使用者要的釘選）', () => {
    const cue = { style: { fontSize: 120 } };
    expect(pruneRedundantCueStyle(cue, track)).toBe(false);
    expect(cue.style).toEqual({ fontSize: 120 });
  });

  it('混合時只清掉沒作用的那些', () => {
    const cue = { style: { fontSize: 80, color: '#ff0000' } };
    pruneRedundantCueStyle(cue, track);
    expect(cue.style).toEqual({ color: '#ff0000' });
  });

  /* 使用者實際回報的情境：軌道是預設樣式，對某一句「套用預設」→
     每個欄位都被寫成逐句覆蓋 → 列表標上 ✱，看起來像沒改乾淨。 */
  it('軌道就是預設時，把整組預設套到單句 → 覆蓋全部清空，不再顯示為「有逐句覆蓋」', () => {
    const defaultTrack = {};
    const cue = { style: { ...STYLE_DEFAULTS } };
    expect(pruneRedundantCueStyle(cue, defaultTrack)).toBe(true);
    expect(cue.style).toBeUndefined();
  });

  it('軌道不是預設時，把預設套到單句 → 覆蓋有意義，必須保留', () => {
    const cue = { style: { ...STYLE_DEFAULTS } };
    pruneRedundantCueStyle(cue, track);
    expect(cue.style.fontSize).toBe(STYLE_DEFAULTS.fontSize);
    expect(cue.style.color).toBe(STYLE_DEFAULTS.color);
  });

  it('清除前後的生效樣式完全相同（清除不可改變任何外觀）', () => {
    const cue = { style: { fontSize: 80, color: '#ff0000' }, track: 0 };
    const before = effStyle(cue, track);
    pruneRedundantCueStyle(cue, track);
    expect(effStyle(cue, track)).toEqual(before);
  });

  it('沒有 style 或空物件時安全', () => {
    expect(pruneRedundantCueStyle({}, track)).toBe(false);
    expect(pruneRedundantCueStyle(null, track)).toBe(false);
    const empty = { style: {} };
    expect(pruneRedundantCueStyle(empty, track)).toBe(true);
    expect(empty.style).toBeUndefined();
  });
});
