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
vi.mock('../src/timeline-renderer.js', () => ({
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

  it('直接呼叫核心刪除命令也不能繞過鎖定', async () => {
    const { deleteSelectedCues } = await import('../src/subtitle-model.js');
    const { recordHistory } = await import('../src/history.js');

    deleteSelectedCues(['b']);

    expect(State.cues.map(c => c.id)).toEqual(['a', 'b']);
    expect(recordHistory).not.toHaveBeenCalled();
    expect(ui.showToast.mock.calls.at(-1)?.[0]).toContain('刪除字幕');
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

describe('字幕樣式命令鎖定防護', () => {
  it('單句與全軌樣式命令都不能改寫鎖定軌', async () => {
    const { applyCueStylePatch, applyTrackStylePlan } = await import('../src/subtitles.js');

    expect(applyCueStylePatch(State.cues[1], { fontSize: 99 })).toBe(false);
    expect(applyTrackStylePlan(State.tracks[1], [State.cues[1]], { fontSize: 88 })).toBe(false);

    expect(State.cues[1].style).toBeUndefined();
    expect(State.tracks[1].fontSize).toBeUndefined();
    expect(ui.showToast).toHaveBeenCalledTimes(2);
  });

  it('貼上樣式到鎖定軌字幕時整批擋下且不寫入 History', async () => {
    const { copySelectedStyle, pasteStyleToSelected } = await import('../src/subtitles.js');
    const { recordHistory } = await import('../src/history.js');
    State.cues[0].style = { fontSize: 72, color: '#ff0000' };
    State.selectedId = 'a';
    State.selectedIds = ['a'];
    copySelectedStyle();

    State.selectedId = 'b';
    State.selectedIds = ['b'];
    pasteStyleToSelected();

    expect(State.cues[1].style).toBeUndefined();
    expect(recordHistory).not.toHaveBeenCalled();
    expect(ui.showToast.mock.calls.at(-1)?.[0]).toContain('貼上字幕樣式');
  });
});

describe('批次 In/Out 命令鎖定防護', () => {
  it('時間位移與持續時間調整都不能修改鎖定軌字幕', async () => {
    document.body.insertAdjacentHTML('beforeend', `
      <input id="tcShiftInput" value="00:00:01:00">
      <input id="durAdjTcInput" value="00:00:01:00">
      <input id="durAdjPctInput" value="150">
      <select id="tcShiftSel"><option value="sel" selected>sel</option></select>
    `);
    const { parseTimecodeInput } = await import('../src/tcparse.js');
    parseTimecodeInput.mockReturnValue(1);
    const { recordHistory } = await import('../src/history.js');
    const { applyTcShift, applyDurAdjTc, applyDurAdjPct } = await import('../src/subio.js');
    State.selectedId = 'b';
    State.selectedIds = ['b'];

    for (const command of [() => applyTcShift(1), () => applyDurAdjTc(1), applyDurAdjPct]) {
      State.cues[1].start = 2;
      State.cues[1].end = 3;
      command();
      expect({ start: State.cues[1].start, end: State.cues[1].end }).toEqual({ start: 2, end: 3 });
    }
    expect(recordHistory).not.toHaveBeenCalled();
    expect(ui.showToast.mock.calls.at(-1)?.[0]).toContain('修改字幕時間');
  });
});

describe('字幕模型內容與 In/Out 命令鎖定防護', () => {
  it('清除字幕時間點不能讓鎖定軌字幕變成無時間字幕', async () => {
    const { clearSelectedCuesTime } = await import('../src/subtitle-model.js');
    const { recordHistory } = await import('../src/history.js');
    State.selectedId = 'b';
    State.selectedIds = ['b'];

    clearSelectedCuesTime();

    expect(State.cues[1].timed).not.toBe(false);
    expect(recordHistory).not.toHaveBeenCalled();
    expect(ui.showToast.mock.calls.at(-1)?.[0]).toContain('清除字幕時間點');
  });

  it('Trim 不能修改目前鎖定軌的字幕內容', async () => {
    const { trimTrackSpaces } = await import('../src/subtitle-model.js');
    const { recordHistory } = await import('../src/history.js');
    State.listTrack = 1;
    State.cues[1].text = '  鎖定內容  ';

    trimTrackSpaces();

    expect(State.cues[1].text).toBe('  鎖定內容  ');
    expect(recordHistory).not.toHaveBeenCalled();
    expect(ui.showToast.mock.calls.at(-1)?.[0]).toContain('整理字幕頭尾空白');
  });

  it('全域清除標籤只修改未鎖定軌並提示已跳過鎖定軌', async () => {
    const { removeSrtTags } = await import('../src/subtitle-model.js');
    State.cues[0].text = '<b>可修改</b>';
    State.cues[1].text = '<i>鎖定內容</i>';

    removeSrtTags();

    expect(State.cues[0].text).toBe('可修改');
    expect(State.cues[1].text).toBe('<i>鎖定內容</i>');
    expect(ui.setStatus.mock.calls.at(-1)?.[0]).toContain('跳過鎖定軌');
  });

  it('相鄰換位、合併與文字上下移都不能修改鎖定軌內容', async () => {
    const { swapAdjacentCues, mergeAdjacentCues, shiftTextsDown, shiftTextsUp } = await import('../src/subtitle-model.js');
    const { recordHistory } = await import('../src/history.js');
    const resetLockedCues = (firstText = '第一句', secondText = '第二句') => {
      State.cues = [
        { id: 'b1', start: 0, end: 1, text: firstText, track: 1, timed: true },
        { id: 'b2', start: 2, end: 3, text: secondText, track: 1, timed: true },
      ];
      return structuredClone(State.cues);
    };

    let original = resetLockedCues();
    swapAdjacentCues('b1', 1);
    expect(State.cues).toEqual(original);

    original = resetLockedCues();
    mergeAdjacentCues('b1', 1);
    expect(State.cues).toEqual(original);

    original = resetLockedCues('第一句', '');
    shiftTextsDown('b2');
    expect(State.cues).toEqual(original);

    original = resetLockedCues('', '第二句');
    shiftTextsUp('b1');
    expect(State.cues).toEqual(original);
    expect(recordHistory).not.toHaveBeenCalled();
    expect(ui.showToast).toHaveBeenCalledTimes(4);
  });
});

describe('字幕匯入鎖定防護', () => {
  it('不能把匯入結果寫入已鎖定的既有字幕軌', async () => {
    document.body.insertAdjacentHTML('beforeend', `
      <select id="importTkSel"><option value="1" selected>歌詞</option></select>
      <select id="importPresetSel"><option value="" selected>無</option></select>
      <input id="importNewTkName" value="新字幕軌">
      <input id="importAppend" type="checkbox">
    `);
    const { _openImportModal } = await import('../src/subio.js');
    const original = structuredClone(State.cues);
    _openImportModal('匯入字幕', [{ start: 5, end: 6, text: '新內容' }], 'srt');
    const buttons = ui.openModal.mock.calls.at(-1)?.[2];

    buttons[0].act();

    expect(State.cues).toEqual(original);
    expect(ui.closeModal).not.toHaveBeenCalled();
    expect(ui.showToast.mock.calls.at(-1)?.[0]).toContain('匯入字幕');
  });

  it('取代未鎖定軌的字幕時保留其他鎖定軌內容', async () => {
    document.body.insertAdjacentHTML('beforeend', `
      <select id="importTkSel"><option value="0" selected>對白</option></select>
      <select id="importPresetSel"><option value="" selected>無</option></select>
      <input id="importNewTkName" value="新字幕軌">
      <input id="importAppend" type="checkbox">
    `);
    const { _openImportModal } = await import('../src/subio.js');
    _openImportModal('匯入字幕', [{ start: 5, end: 6, text: '取代內容' }], 'srt');
    const buttons = ui.openModal.mock.calls.at(-1)?.[2];

    buttons[0].act();

    expect(State.cues.map(c => ({ text: c.text, track: c.track }))).toEqual([
      { text: 'y', track: 1 },
      { text: '取代內容', track: 0 },
    ]);
  });
});
