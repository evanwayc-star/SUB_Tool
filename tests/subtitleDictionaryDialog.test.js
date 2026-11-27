// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../src/media.js', () => ({ Media: { mpvMode: false } }));
vi.mock('../src/media-player-adapter.js', () => ({ getNativePreviewRuntime: vi.fn() }));

const byId = id => document.getElementById(id);
const submit = () => document.querySelector('#modalFoot .primary').click();
const cancel = () => document.querySelector('#modalFoot button').click();
let editor;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  localStorage.clear();
  document.body.innerHTML = '<div id="modalBg"><div class="modal"><div id="modalTitle"></div><div id="modalBody"></div><div id="modalFoot"></div></div></div>';
  editor = await import('../src/subtitle-dictionary-dialog.js');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('草稿可取消，儲存後更新檢查與本機字庫，重新載入也保留空字庫', async () => {
  const refreshed = vi.fn();
  const { on } = await import('../src/events.js');
  on('render:checkPanel', refreshed);
  editor.openSubtitleDictionaryDialog();
  expect(byId('cpDictionaryEntries').value.split('\n')).toContain('简');
  expect(byId('cpDictionaryOther').checked).toBe(true);

  byId('cpDictionaryClear').click();
  byId('cpDictionaryEntries').value = '你我他\n你我他\n<b>';
  cancel();
  expect(editor.getSubtitleDictionaryMatcher()('简あ你我他')).toEqual(['简', 'あ']);
  expect(refreshed).not.toHaveBeenCalled();
  editor.openSubtitleDictionaryDialog();
  byId('cpDictionaryClear').click();
  byId('cpDictionaryEntries').value = '你我他\n你我他\n<b>';
  submit();
  expect(byId('modalBg').classList.contains('show')).toBe(false);
  expect(refreshed).toHaveBeenCalledTimes(1);

  vi.resetModules();
  editor = await import('../src/subtitle-dictionary-dialog.js');
  expect(editor.getSubtitleDictionaryMatcher()('简あ他和我 你我他你我他<b>')).toEqual(['你我他', '<b>']);
  editor.openSubtitleDictionaryDialog();
  expect(byId('cpDictionaryEntries').value.split('\n').filter(Boolean)).toEqual(['你我他', '<b>']);
  expect(byId('cpDictionaryOther').checked).toBe(false);
  byId('cpDictionaryRestore').click();
  expect(byId('cpDictionaryOther').checked).toBe(true);
  cancel();
  expect(editor.getSubtitleDictionaryMatcher()('简あ')).toEqual([]);
  editor.openSubtitleDictionaryDialog();
  byId('cpDictionaryClear').click();
  submit();
  vi.resetModules();
  editor = await import('../src/subtitle-dictionary-dialog.js');
  expect(editor.getSubtitleDictionaryMatcher()('简あ你我他')).toEqual([]);
});

it('無法儲存時顯示錯誤並保留草稿，既有比對規則持續生效', () => {
  editor.openSubtitleDictionaryDialog();
  byId('cpDictionaryClear').click();
  byId('cpDictionaryEntries').value = '你我他';
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
  submit();
  expect(byId('cpDictionaryError').hidden).toBe(false);
  expect(byId('modalBg').classList.contains('show')).toBe(true);
  expect(byId('cpDictionaryEntries').value).toBe('你我他');
  expect(editor.getSubtitleDictionaryMatcher()('简你我他')).toEqual(['简']);
});
