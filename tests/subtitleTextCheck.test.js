import { describe, expect, it } from 'vitest';
import { inspectSubtitleCharacters } from '../src/subtitleTextCheck.js';

describe('字幕字元檢查', () => {
  it('允許繁中、英文、數字、標點與 emoji', () => {
    expect(inspectSubtitleCharacters('繁體中文：臺灣的龍門。Hello SUB Tool 123 ＡＢＣ１２３！😀❤️👨‍👩‍👧‍👦 1️⃣'))
      .toEqual({ simplified: [], sharedSimplified: [], unsupported: [] });
  });

  it('找出常見簡體字', () => {
    const result = inspectSubtitleCharacters('简体中文字幕：这是测试。');
    expect(result.unsupported).toEqual([]);
    expect(result.sharedSimplified).toEqual([]);
    expect(result.simplified).toEqual(expect.arrayContaining(['简', '体', '这', '测', '试']));
  });

  it('找出日文假名、韓文、俄文與零寬空白等非允許字元', () => {
    const result = inspectSubtitleCharacters('これは日本語。안녕하세요 Привет 繁體\u200B中文');
    expect(result.simplified).toEqual([]);
    expect(result.sharedSimplified).toEqual([]);
    expect(result.unsupported).toEqual(expect.arrayContaining(['こ', '안', 'П', '\u200B']));
  });

  it('繁簡共用字（如「后、干、台、里」）不會誤報為簡體或問題字元', () => {
    expect(inspectSubtitleCharacters('后后干干台台里里')).toEqual({
      simplified: [],
      sharedSimplified: ['后', '干', '台', '里'],
      unsupported: [],
    });
  });

  it('不誤報對應的繁體字', () => {
    expect(inspectSubtitleCharacters('後乾臺裡繁體中文：Hello 123！😀'))
      .toEqual({ simplified: [], sharedSimplified: [], unsupported: [] });
  });

  it('共用字與常見簡體字混用時，僅回傳常見簡體字與非允許字元', () => {
    expect(inspectSubtitleCharacters('简后干台里简あ')).toEqual({
      simplified: ['简'],
      sharedSimplified: ['后', '干', '台', '里'],
      unsupported: ['あ'],
    });
  });

  it('繁簡共用字與常見簡體混用時，simplified 僅包含常見簡體字', () => {
    expect(inspectSubtitleCharacters('台简')).toEqual({
      simplified: ['简'],
      sharedSimplified: ['台'],
      unsupported: [],
    });
  });

  it('依出現順序回傳去重後的字元', () => {
    expect(inspectSubtitleCharacters('简简体体ああ')).toEqual({
      simplified: ['简', '体'],
      sharedSimplified: [],
      unsupported: ['あ'],
    });
  });
});
