import { describe, expect, it } from 'vitest';
import { inspectSubtitleCharacters } from '../src/subtitleTextCheck.js';

describe('字幕字元檢查', () => {
  it('允許繁中、英文、數字、標點與 emoji', () => {
    expect(inspectSubtitleCharacters('繁體中文：臺灣的龍門。Hello SUB Tool 123 ＡＢＣ１２３！😀❤️👨‍👩‍👧‍👦 1️⃣'))
      .toEqual({ simplified: [], sharedSimplified: [], unsupported: [] });
  });

  it('找出確定會簡轉繁的簡體字', () => {
    const result=inspectSubtitleCharacters('简体中文字幕：这是测试。');
    expect(result.unsupported).toEqual([]);
    expect(result.sharedSimplified).toEqual([]);
    expect(result.simplified).toEqual(expect.arrayContaining(['简','体','这','测','试']));
  });

  it('找出非繁中／英文／數字／符號的文字與隱藏字元', () => {
    const result=inspectSubtitleCharacters('これは日本語。안녕하세요 Привет 繁體\u200B中文');
    expect(result.simplified).toEqual([]);
    expect(result.sharedSimplified).toEqual([]);
    expect(result.unsupported).toEqual(expect.arrayContaining(['こ','안','П','\u200B']));
  });

  it('依嚴格規則找出繁簡共用字', () => {
    expect(inspectSubtitleCharacters('后后干干台台里里')).toEqual({
      simplified: ['后','干','台','里'],
      sharedSimplified: ['后','干','台','里'],
      unsupported: [],
    });
  });

  it('不誤報對應的繁體字', () => {
    expect(inspectSubtitleCharacters('後乾臺裡繁體中文：Hello 123！😀'))
      .toEqual({ simplified: [], sharedSimplified: [], unsupported: [] });
  });

  it('共用字與明確簡體字依出現順序一起回傳', () => {
    expect(inspectSubtitleCharacters('简后干台里简あ')).toEqual({
      simplified: ['简','后','干','台','里'],
      sharedSimplified: ['后','干','台','里'],
      unsupported: ['あ'],
    });
  });

  it('明確簡體與繁簡共用字混用時，保留明確簡體分類', () => {
    expect(inspectSubtitleCharacters('台简')).toEqual({
      simplified: ['台','简'],
      sharedSimplified: ['台'],
      unsupported: [],
    });
  });

  it('依出現順序回傳去重後的字元', () => {
    expect(inspectSubtitleCharacters('简简体体ああ')).toEqual({
      simplified: ['简','体'],
      sharedSimplified: [],
      unsupported: ['あ'],
    });
  });
});
