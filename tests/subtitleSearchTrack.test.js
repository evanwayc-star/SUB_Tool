// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/dom.js', () => {
  const dummy = document.createElement('div');
  return {
    $: id => document.getElementById(id),
    video: dummy,
    tlScroll: dummy,
    tlLayer: dummy,
    tlTracks: dummy,
    rulerCv: document.createElement('canvas'),
    sublist: dummy,
    imageLayer: dummy,
  };
});
vi.mock('../src/menus.js', () => ({ hideCtx: vi.fn(), showCueMenu: vi.fn() }));
vi.mock('../src/events.js', () => ({ emit: vi.fn(), on: vi.fn() }));
vi.mock('../src/timeline-renderer.js', () => ({
  renderCueBlocks: vi.fn(),
  drawTimeline: vi.fn(),
  updatePlayhead: vi.fn(),
  refreshTrackGutterActive: vi.fn(),
}));

import { State } from '../src/state.js';
import { updateSearchCount } from '../src/subtitles.js';
import { searchUpdate } from '../src/subtitle-search.js';

describe('搜尋浮動視窗顯示作用字幕軌道', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="searchDialog">
        <div id="searchDialogHead">
          <span>🔍 搜尋 / 取代</span>
          <span id="searchDialogTrackBadge" class="sd-track-badge">[軌道 1]</span>
        </div>
        <span id="searchCount"></span>
        <input id="searchInput"><p id="searchFeedback"></p>
        <button data-act="search-next">下一個</button>
        <button data-act="replace-one">取代</button>
      </div>
    `;
    State.tracks = [
      { name: '主對白', style: {} },
      { name: '英文字幕', style: {} },
    ];
    State.listTrack = 0;
    State.cues=[{id:'a',track:0,text:'測試字幕',start:0,end:1}];
    searchUpdate('');
  });

  it('初始時依據 State.listTrack 顯示對應軌道名稱徽章', () => {
    updateSearchCount();
    const badge = document.getElementById('searchDialogTrackBadge');
    expect(badge.textContent).toBe('[主對白]');
    expect(badge.title).toContain('主對白');
  });

  it('切換至第 2 軌時，徽章即時同步更新', () => {
    State.listTrack = 1;
    updateSearchCount();
    const badge = document.getElementById('searchDialogTrackBadge');
    expect(badge.textContent).toBe('[英文字幕]');
    expect(badge.title).toContain('英文字幕');
  });

  it('軌道無自訂名稱時以「軌道 N」呈現', () => {
    State.tracks = [{ style: {} }];
    State.listTrack = 0;
    updateSearchCount();
    const badge = document.getElementById('searchDialogTrackBadge');
    expect(badge.textContent).toBe('[軌道 1]');
  });

  it('無結果提供恢復提示並停用結果動作，命中後可繼續操作', () => {
    searchUpdate('不存在');updateSearchCount();
    expect(document.getElementById('searchFeedback').textContent).toContain('請調整關鍵字');
    expect(document.querySelector('[data-act="search-next"]').disabled).toBe(true);
    expect(document.querySelector('[data-act="replace-one"]').disabled).toBe(true);
    searchUpdate('字幕');updateSearchCount();
    expect(document.querySelector('[data-act="search-next"]').disabled).toBe(false);
    expect(document.querySelector('[data-act="replace-one"]').disabled).toBe(false);
    State.tracks[0].locked=true;updateSearchCount();
    expect(document.querySelector('[data-act="search-next"]').disabled).toBe(false);
    expect(document.querySelector('[data-act="replace-one"]').disabled).toBe(true);
    expect(document.getElementById('searchFeedback').textContent).toContain('請先解鎖再取代');
  });

  it('空軌提示匯入或切換軌道', () => {
    State.listTrack=1;updateSearchCount();
    expect(document.getElementById('searchFeedback').textContent).toContain('此字幕軌尚無字幕');
    expect(document.querySelector('[data-act="search-next"]').disabled).toBe(true);
  });
});
