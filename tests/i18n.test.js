import { describe, it, expect, beforeEach } from 'vitest';
import { t, setLang, getLang } from '../src/i18n.js';

describe('i18n (X4 phase 1)', () => {
  beforeEach(() => setLang('zh'));

  it('zh 預設原樣回傳原文（非破壞性）', () => {
    expect(t('所選軌道沒有字幕')).toBe('所選軌道沒有字幕');
    expect(getLang()).toBe('zh');
  });

  it('佔位符 {0}{1} 替換', () => {
    expect(t('已匯出 {0}', 'a.srt')).toBe('已匯出 a.srt');
    expect(t('{0} → {1}', 'A', 'B')).toBe('A → B');
  });

  it('未知語言（無翻譯表）回退原文', () => {
    setLang('en'); // MESSAGES.en 尚未提供
    expect(t('已匯出 {0}', 'x.ass')).toBe('已匯出 x.ass');
  });

  it('缺少參數時保留佔位符', () => {
    expect(t('已匯出 {0}')).toBe('已匯出 {0}');
  });
});
