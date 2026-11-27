// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { listBrowserDrafts, saveBrowserDraft, removeBrowserDraft } from '../src/browser-project-drafts.js';

afterEach(()=>localStorage.clear());

it('未命名、相同檔名的不同工作區與舊版備份可以各自還原', () => {
  localStorage.setItem('subtool_autosave_data','legacy');
  localStorage.setItem('subtool_autosave_name','舊專案.subtool');
  for(const [id, payload] of [['first','one'],['second','two']])
    saveBrowserDraft(localStorage,id,{name:'未命名.subtool',payload,savedAt:1});
  expect(listBrowserDrafts(localStorage).map(item=>item.payload).sort()).toEqual(['legacy','one','two']);
  expect(localStorage.getItem('subtool_autosave_data')).toBeNull();
  const [first,second,legacy]=listBrowserDrafts(localStorage);
  saveBrowserDraft(localStorage,first.key.replace('subtool_project_draft_',''),{...first,payload:'changed',savedAt:2});
  expect(removeBrowserDraft(localStorage,first)).toBe(false);
  expect(removeBrowserDraft(localStorage,second)).toBe(true);
  expect(removeBrowserDraft(localStorage,legacy)).toBe(true);
  expect(listBrowserDrafts(localStorage).map(item=>item.payload)).toEqual(['changed']);
});

it('額滿無法遷移時仍可從舊鍵讀取原始備份', () => {
  localStorage.setItem('subtool_autosave_data','original');
  const write=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{ throw Error('quota'); });
  try {
    expect(listBrowserDrafts(localStorage)).toMatchObject([{key:'subtool_autosave_data',payload:'original'}]);
    expect(localStorage.getItem('subtool_autosave_data')).toBe('original');
  } finally { write.mockRestore(); }
});
