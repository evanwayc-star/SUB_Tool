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
vi.mock('../src/timeline.js', () => ({
  renderCueBlocks: vi.fn(),
  drawTimeline: vi.fn(),
  updatePlayhead: vi.fn(),
  refreshTrackGutterActive: vi.fn(),
}));

import { State } from '../src/state.js';
import { updateSearchCount } from '../src/subtitles.js';

describe('搜尋浮動視窗顯示作用字幕軌道', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="searchDialog">
        <div id="searchDialogHead">
          <span>🔍 搜尋 / 取代</span>
          <span id="searchDialogTrackBadge" class="sd-track-badge">[軌道 1]</span>
        </div>
        <span id="searchCount"></span>
      </div>
    `;
    State.tracks = [
      { name: '主對白', style: {} },
      { name: '英文字幕', style: {} },
    ];
    State.listTrack = 0;
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
});
