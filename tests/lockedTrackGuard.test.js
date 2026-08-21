// @vitest-environment jsdom
/* 鎖定字幕軌的編輯守衛（src/subtitles.js trackLocked / cueTrackLocked）。

   真實災情：把字幕軌鎖起來，進上字幕模式後 I／O 鍵照樣能改該軌字幕的時間、
   照樣能在該軌新增字幕，而且【沒有任何提示】——使用者以為鎖住了，其實沒鎖。

   原因是 locked 只在兩處被檢查：右鍵選單（menus.js）與時間軸拖曳
   （timeline-renderer.js）。setIn／setOut 這兩個上字幕模式的核心入口完全沒有守衛。

   這裡測的是守衛本身：擋下來、而且一定要出提示。沉默地不作用比擋不住更難查。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ui = vi.hoisted(() => ({
  showToast: vi.fn(),
  openModal: vi.fn(),
  closeModal: vi.fn(),
  setStatus: vi.fn(),
  showOsd: vi.fn(),
}));

vi.mock('../src/ui.js', () => ui);
vi.mock('../src/media.js', () => ({ Media: {
  displayTime: () => 5,
  externalAudio: { list: () => [], get: () => null },
  seek: vi.fn(), scrubAudio: vi.fn(), pause: vi.fn(), setRate: vi.fn(),
}, Wave: {} }));
vi.mock('../src/timeline.js', () => ({
  drawTimeline: vi.fn(), updatePlayhead: vi.fn(), renderCueBlocks: vi.fn(),
  refreshTrackGutterActive: vi.fn(),
}));
vi.mock('../src/menus.js', () => ({ hideCtx: vi.fn(), showCueMenu: vi.fn() }));
vi.mock('../src/history.js', () => ({ History: {}, recordHistory: vi.fn(), renderHistory: vi.fn() }));
vi.mock('../src/project.js', () => ({ Project: {}, ensureProjectSaved: vi.fn().mockResolvedValue() }));
vi.mock('../src/substyle.js', async orig => ({ ...(await orig()) }));
vi.mock('../src/tcparse.js', () => ({ parseTimecodeInput: vi.fn(), setupTimecodeInput: vi.fn() }));

let State;
let trackLocked;
let cueTrackLocked;
let deleteSelected;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="sublist"></div><div id="stSel"></div><video id="video"></video>';
  ({ State } = await import('../src/state.js'));
  ({ trackLocked, cueTrackLocked, deleteSelected } = await import('../src/subtitles.js'));

  State.tracks = [
    { name: '對白', locked: false },
    { name: '歌詞', locked: true },
  ];
  State.cues = [
    { id: 'a', start: 0, end: 1, text: 'x', track: 0 },
    { id: 'b', start: 2, end: 3, text: 'y', track: 1 },
  ];
  State.selectedId = null;
  State.selectedIds = [];
});

describe('trackLocked：擋下並且一定要提示', () => {
  it('未鎖定的軌回 false，不出提示', () => {
    expect(trackLocked(0)).toBe(false);
    expect(ui.showToast).not.toHaveBeenCalled();
  });

  it('鎖定的軌回 true，並且提示裡有軌道名稱與動作', () => {
    expect(trackLocked(1, '在此軌新增字幕')).toBe(true);
    expect(ui.showToast).toHaveBeenCalledTimes(1);
    const msg = ui.showToast.mock.calls[0][0];
    expect(msg).toContain('歌詞');
    expect(msg).toContain('在此軌新增字幕');
  });

  /* 沒有名稱的軌也要講得出是哪一軌，不能只說「軌道已鎖定」。 */
  it('軌道沒有名稱時退回「軌道 N」而不是空字串', () => {
    State.tracks[1].name = '';
    trackLocked(1, '調整');
    expect(ui.showToast.mock.calls[0][0]).toContain('軌道 2');
  });

  it('索引超出範圍不會丟例外，視為未鎖定', () => {
    expect(() => trackLocked(99)).not.toThrow();
    expect(trackLocked(99)).toBe(false);
  });
});

describe('cueTrackLocked：依字幕所在軌判斷', () => {
  it('字幕在未鎖定軌 → 放行', () => {
    expect(cueTrackLocked(State.cues[0], '調整字幕起點')).toBe(false);
  });

  it('字幕在鎖定軌 → 擋下並提示', () => {
    expect(cueTrackLocked(State.cues[1], '調整字幕起點')).toBe(true);
    expect(ui.showToast.mock.calls[0][0]).toContain('調整字幕起點');
  });

  /* track 未定義的舊資料視為第 0 軌，不可因為 undefined 就無條件放行。 */
  it('沒有 track 欄位的字幕視為第 0 軌', () => {
    State.tracks[0].locked = true;
    expect(cueTrackLocked({ id: 'z', start: 0, end: 1 }, '調整')).toBe(true);
  });
});

describe('deleteSelected：選取跨到鎖定軌時整批擋下', () => {
  it('只選鎖定軌的字幕 → 不刪，且提示', () => {
    State.selectedIds = ['b'];
    State.selectedId = 'b';
    deleteSelected();
    expect(State.cues.map(c => c.id)).toEqual(['a', 'b']);
    expect(ui.showToast.mock.calls[0][0]).toContain('刪除字幕');
  });

  /* 多選裡只要有一條在鎖定軌就整批擋下——部分刪除會讓使用者以為全刪了。 */
  it('多選中混有鎖定軌的字幕 → 整批不刪', () => {
    State.selectedIds = ['a', 'b'];
    State.selectedId = 'a';
    deleteSelected();
    expect(State.cues.map(c => c.id)).toEqual(['a', 'b']);
    expect(ui.showToast).toHaveBeenCalled();
  });
});

describe('pasteCues 鎖定防護', () => {
  it('嘗試在鎖定軌道貼上字幕 → 擋下並提示', async () => {
    const { pasteCues } = await import('../src/subtitle-model.js');
    State.clipboard = [{ id: 'copy-1', text: 'hi', start: 0, end: 1, track: 0 }];
    State.listTrack = 1; // 歌詞軌（鎖定）
    pasteCues();
    expect(State.cues.length).toBe(2);
    expect(ui.showToast).toHaveBeenCalled();
  });
});
