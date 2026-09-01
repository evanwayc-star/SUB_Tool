// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ui = vi.hoisted(() => ({
  showToast: vi.fn(),
  openModal: vi.fn(),
  closeModal: vi.fn(),
  setStatus: vi.fn(),
}));

vi.mock('../src/events.js', () => ({ emit: vi.fn(), on: vi.fn() }));
vi.mock('../src/history.js', () => ({ recordHistory: vi.fn() }));
vi.mock('../src/ui.js', () => ui);

import { State } from '../src/state.js';
import { emit } from '../src/events.js';
import { recordHistory } from '../src/history.js';
import {
  searchUpdate,
  searchNav,
  searchNext,
  searchPrev,
  searchSelectAll,
  searchReplace,
  searchClear,
  setSelectCueHandler,
  getSearchCountText,
  isSearchHit,
  txtHTML,
} from '../src/subtitle-search.js';

describe('字幕搜尋與導航定位 (subtitle-search)', () => {
  let selectCueMock;

  beforeEach(() => {
    vi.clearAllMocks();
    selectCueMock = vi.fn();
    setSelectCueHandler(selectCueMock);

    State.tracks = [{ name: '軌道 1', style: {} }];
    State.listTrack = 0;
    State.selectedId = null;
    State.selectedIds = [];
    State.activeTrackKind = 'sub';

    State.cues = [
      { id: 'c1', text: '這是第一句測試字幕', start: 1, end: 3, track: 0, timed: true },
      { id: 'c2', text: '第二句沒有關鍵字', start: 4, end: 6, track: 0, timed: true },
      { id: 'c3', text: '第三句也是測試內容', start: 7, end: 9, track: 0, timed: true },
      { id: 'c4', text: '第四句包含測試詞彙', start: 10, end: 12, track: 0, timed: true },
      { id: 'c5', text: '其他軌道的測試字幕', start: 13, end: 15, track: 1, timed: true },
    ];

    document.body.innerHTML = `
      <input type="text" id="searchInput" value="">
      <input type="text" id="replaceInput" value="">
      <span id="searchCount"></span>
    `;
  });

  it('searchUpdate 在輸入關鍵字時能篩選符合項目並選取第一筆（seek: false）', () => {
    searchUpdate('測試');

    expect(isSearchHit('c1')).toBe(true);
    expect(isSearchHit('c2')).toBe(false);
    expect(isSearchHit('c3')).toBe(true);
    expect(isSearchHit('c4')).toBe(true);
    expect(isSearchHit('c5')).toBe(false); // 跨軌不應納入當前軌道搜尋

    expect(getSearchCountText()).toBe('1/3');
    expect(emit).toHaveBeenCalledWith('render:subList');
    expect(emit).toHaveBeenCalledWith('render:searchCount');
    expect(selectCueMock).toHaveBeenCalledWith('c1', { seek: false });
  });

  it('searchNext 能向下定位到下一筆符合的字幕，並要求播放器跳轉（seek: true）', () => {
    searchUpdate('測試');
    selectCueMock.mockClear();

    searchNext();
    expect(getSearchCountText()).toBe('2/3');
    expect(selectCueMock).toHaveBeenCalledWith('c3', { seek: true });

    searchNext();
    expect(getSearchCountText()).toBe('3/3');
    expect(selectCueMock).toHaveBeenCalledWith('c4', { seek: true });

    // 循環回到第一筆
    searchNext();
    expect(getSearchCountText()).toBe('1/3');
    expect(selectCueMock).toHaveBeenCalledWith('c1', { seek: true });
  });

  it('searchPrev 能向上定位到上一筆符合的字幕，並要求播放器跳轉（seek: true）', () => {
    searchUpdate('測試');
    selectCueMock.mockClear();

    // 在第 1 筆往回按，循環至最後一筆 (c4)
    searchPrev();
    expect(getSearchCountText()).toBe('3/3');
    expect(selectCueMock).toHaveBeenCalledWith('c4', { seek: true });

    searchPrev();
    expect(getSearchCountText()).toBe('2/3');
    expect(selectCueMock).toHaveBeenCalledWith('c3', { seek: true });
  });

  it('當使用者在列表中手動選取某筆符合項目後，searchNext / searchPrev 會從該項目接續導航', () => {
    searchUpdate('測試');
    selectCueMock.mockClear();

    // 模擬使用者在列表中點選了 c3
    State.selectedId = 'c3';
    State.selectedIds = ['c3'];

    searchNext();
    expect(getSearchCountText()).toBe('3/3');
    expect(selectCueMock).toHaveBeenCalledWith('c4', { seek: true });

    // 再模擬使用者點選了 c1
    State.selectedId = 'c1';
    State.selectedIds = ['c1'];

    searchPrev();
    expect(getSearchCountText()).toBe('3/3');
    expect(selectCueMock).toHaveBeenCalledWith('c4', { seek: true });
  });

  it('searchSelectAll 能全選所有符合的字幕', () => {
    searchUpdate('測試');
    searchSelectAll();

    expect(State.selectedIds).toEqual(['c1', 'c3', 'c4']);
    expect(emit).toHaveBeenCalledWith('render:selection');
  });

  it('searchReplace 單句與全部取代能正確修改文字並維持搜尋更新', () => {
    searchUpdate('測試');

    // 目前在 c1，單句取代
    searchReplace(false, '驗證');
    expect(State.cues.find(c => c.id === 'c1').text).toBe('這是第一句驗證字幕');
    expect(State.cues.find(c => c.id === 'c3').text).toBe('第三句也是測試內容');

    // 全部取代
    searchReplace(true, '範例');
    expect(State.cues.find(c => c.id === 'c3').text).toBe('第三句也是範例內容');
    expect(State.cues.find(c => c.id === 'c4').text).toBe('第四句包含範例詞彙');
  });

  it('目前字幕軌鎖定時搜尋取代不會修改內容或寫入 History', () => {
    State.tracks[0].locked = true;
    searchUpdate('測試');

    searchReplace(true, '禁止修改');

    expect(State.cues.filter(c => c.track === 0).map(c => c.text)).toEqual([
      '這是第一句測試字幕',
      '第二句沒有關鍵字',
      '第三句也是測試內容',
      '第四句包含測試詞彙',
    ]);
    expect(recordHistory).not.toHaveBeenCalled();
    expect(ui.showToast.mock.calls.at(-1)?.[0]).toContain('取代字幕內容');
  });

  it('txtHTML 能正確將搜尋詞用 search-match 高亮包覆', () => {
    searchUpdate('第一||內容');
    const html1 = txtHTML('這是第一句測試字幕');
    expect(html1).toContain('<span class="search-match">第一</span>');

    const html2 = txtHTML('第三句也是測試內容');
    expect(html2).toContain('<span class="search-match">內容</span>');
  });

  it('searchClear 能清空搜尋文字與選取狀態', () => {
    document.getElementById('searchInput').value = '測試';
    searchUpdate('測試');
    expect(getSearchCountText()).toBe('1/3');

    searchClear();
    expect(document.getElementById('searchInput').value).toBe('');
    expect(getSearchCountText()).toBe('');
    expect(isSearchHit('c1')).toBe(false);
  });
});
