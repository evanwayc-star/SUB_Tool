import { describe, expect, it } from 'vitest';
import { createSubtitleDictionaryMatcher, DEFAULT_SUBTITLE_DICTIONARY, inspectSubtitleCharacters } from '../src/subtitle-text-check.js';

describe('可編輯的字幕字庫', () => {
  it('預設包含實際會提示的簡體字及其他字元，連同補充平面的字元一併比對', () => {
    const text = '简简体这测𠀾试 台裡著面才只它嘆夠峰群妳 后干里' +
      ' これは日本語。안녕하세요 Привет\u200B 繁體！ABC 123 😀❤️👨‍👩‍👧‍👦 1️⃣';
    const { simplified, unsupported } = inspectSubtitleCharacters(text);
    expect(createSubtitleDictionaryMatcher()(text)).toEqual([...simplified, ...unsupported]);
    expect(DEFAULT_SUBTITLE_DICTIONARY.entries).toContain('𠀾');
    expect(DEFAULT_SUBTITLE_DICTIONARY.entries).not.toContain('峰');
  });

  it('即使繼續檢查其他字元也可移除任一預設字，亦可新增原先允許的文字', () => {
    const match = createSubtitleDictionaryMatcher({ entries: ['群', '你我他'], includeUnsupported: true });
    expect(match('简体群你我他あ')).toEqual(['群', '你我他', 'あ']);
  });

  it('可停用其他字元、自訂重疊詞組及清空整份字庫', () => {
    const match = createSubtitleDictionaryMatcher({ entries: ['𠀾乙', '乙丙', '𠀾乙', 'あ'], includeUnsupported: false });
    expect(match('𠀾乙丙あ안')).toEqual(['𠀾乙', '乙丙', 'あ']);
    expect(createSubtitleDictionaryMatcher({ entries: [], includeUnsupported: false })('简体あ')).toEqual([]);
  });
});

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

  it('繁簡共用字（如「后、干、里」）不會誤報為簡體或問題字元', () => {
    expect(inspectSubtitleCharacters('后后干干里里')).toEqual({
      simplified: [],
      sharedSimplified: ['后', '干', '里'],
      unsupported: [],
    });
  });

  it('不誤報對應的繁體字', () => {
    expect(inspectSubtitleCharacters('後乾臺裡繁體中文：Hello 123！😀'))
      .toEqual({ simplified: [], sharedSimplified: [], unsupported: [] });
  });

  it('共用字與常見簡體字混用時，僅回傳常見簡體字與非允許字元', () => {
    expect(inspectSubtitleCharacters('简后干里简あ')).toEqual({
      simplified: ['简'],
      sharedSimplified: ['后', '干', '里'],
      unsupported: ['あ'],
    });
  });

  it('繁簡共用字與常見簡體混用時，simplified 僅包含常見簡體字', () => {
    expect(inspectSubtitleCharacters('干简')).toEqual({
      simplified: ['简'],
      sharedSimplified: ['干'],
      unsupported: [],
    });
  });

  it('白名單字元（如「台、裡、著、面、才、只、它、嘆、夠、峰、群、妳」）直接放行，不視為簡體或共用字', () => {
    expect(inspectSubtitleCharacters('台裡著面才只它嘆夠峰群妳')).toEqual({
      simplified: [],
      sharedSimplified: [],
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
