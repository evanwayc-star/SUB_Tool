// @vitest-environment jsdom
/* 開啟另一個專案前的「未存檔變更」確認（src/project.js confirmDiscardUnsaved）。

   真實災情：手上有兩份 .subtool。已經開著其中一份並改了東西，再從 Explorer 雙擊
   另一份——軟體【不會問要不要存】，直接把目前專案關掉換成新的，未存檔的內容就沒了。

   原因是 isProjectDirty() 只被關閉視窗的流程用到（app.js onAppRequestClose），
   三條「開啟專案」的路徑（選單開啟、Explorer 雙擊、瀏覽器版選檔）全都直接呼叫
   Project.load*()，中間沒有任何確認。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ui = vi.hoisted(() => ({
  openModal: vi.fn(() => ({ isCurrent: () => true, close: (...args) => ui.closeModal(...args) })),
  closeModal: vi.fn(),
  showToast: vi.fn(),
  setStatus: vi.fn(),
}));

vi.mock('../src/ui.js', () => ui);
vi.mock('../src/media.js', () => ({ Media: {
  displayTime: vi.fn(() => 0),
  externalAudio: { list: vi.fn(() => []), get: vi.fn(() => null) },
  loadDesktopMedia: vi.fn(),
  reset: vi.fn(),
  restorePendingImageClips: vi.fn().mockResolvedValue({ restored: 0, pending: 0 }),
  seek: vi.fn(),
  waitForPendingProjectRestore: vi.fn().mockResolvedValue(),
} }));
vi.mock('../src/timeline-renderer.js', () => ({ drawTimeline: vi.fn() }));
vi.mock('../src/notes.js', () => ({ renderNotes: vi.fn() }));

let Project;
let State;
let confirmDiscardUnsaved;
let isProjectDirty;
let resetProject;

/* 取出 openModal 收到的按鈕，用標籤點它——測的是使用者真的按下去會發生什麼。 */
function clickModalButton(label) {
  const [, , buttons] = ui.openModal.mock.calls.at(-1);
  const button = buttons.find(b => b.label === label);
  if (!button) throw new Error(`對話框沒有「${label}」這顆按鈕：${buttons.map(b => b.label).join('／')}`);
  return button.act();
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  Object.defineProperty(window, 'subtool', {
    configurable: true,
    value: { isDesktop: true, stat: vi.fn().mockResolvedValue({ exists: true, size: 100 }), saveProject: vi.fn().mockResolvedValue('C:/proj/a.subtool') },
  });

  ({ State } = await import('../src/state.js'));
  ({ Project, confirmDiscardUnsaved, isProjectDirty, resetProject } = await import('../src/project.js'));

  await Project.startNewProject(() => {
    State.cues = [];
    State.notes = [];
    State.clips = [];
    State.tracks = [];
  });
});

afterEach(() => resetProject?.());

/* 從剛建立的新工作區增加持久內容。 */
function makeDirty() {
  State.cues = [{ id: 'c1', start: 0, end: 1, text: 'hello', track: 0 }];
  expect(isProjectDirty(), '前置條件：專案應為未存檔狀態').toBe(true);
}

describe('沒有未存檔變更時不打擾', () => {
  it('乾淨的專案直接放行，不跳對話框', async () => {
    await expect(confirmDiscardUnsaved()).resolves.toBe(true);
    expect(ui.openModal).not.toHaveBeenCalled();
  });

  it('已儲存的專案即使有字幕也直接開啟，不顯示刪除字幕警告', async () => {
    makeDirty();
    await Project.save();
    expect(isProjectDirty()).toBe(false);
    const pending = confirmDiscardUnsaved();
    try {
      expect(ui.openModal).not.toHaveBeenCalled();
    } finally {
      ui.openModal.mock.calls.at(-1)?.[3]?.onDismiss();
    }
    await expect(pending).resolves.toBe(true);
  });

  it.each([
    ['時間軸縮放', () => { State.pxPerSec = 137; }],
    ['視訊軌收合', () => { State.vtracksCollapsed = !State.vtracksCollapsed; }],
  ])('%s 只改檢視，不觸發未儲存提醒，實際字幕編輯仍受保護', async (_name, view) => {
    makeDirty();
    await Project.save();
    view();
    expect(isProjectDirty()).toBe(false);
    await expect(confirmDiscardUnsaved()).resolves.toBe(true);
    expect(ui.openModal).not.toHaveBeenCalled();
    State.cues[0].text = 'edited subtitle';
    expect(isProjectDirty()).toBe(true);
    const pending = confirmDiscardUnsaved();
    clickModalButton('取消');
    await expect(pending).resolves.toBe(false);
  });
});

describe('空工作區的持久設定也受未儲存保護', () => {
  it.each([
    ['字幕軌名稱', () => { State.tracks[0].name = '自訂對白'; }],
    ['字幕軌樣式', () => { State.tracks[0].fontSize = 111; }],
    ['視訊軌設定', () => { State.videoTracks[0].opacity = 0.5; }],
    ['格網', () => { State.fps = 25; }],
    ['交付範圍', () => { State.exportIn = 1; State.exportOut = 5; }],
  ])('%s 修改後先提示，取消開啟保留設定，Undo 回到乾淨基準', async (_name, edit) => {
    const { History } = await import('../src/history.js');
    await Project.startNewProject(() => {
      resetProject();
      Object.assign(State, {
        tracks: [{ name: '字幕軌 1', visible: true }], trackCount: 1,
        videoTracks: [{ name: '視訊軌 1', visible: true }], fps: 24,
        cues: [], clips: [], notes: [], duration: 0, externalAudioState: [], externalAudioEnd: 0,
      });
      History.reset();
    });
    expect(isProjectDirty()).toBe(false);
    edit();
    History.record('編輯空專案設定');
    expect(isProjectDirty()).toBe(true);
    const pending = confirmDiscardUnsaved();
    clickModalButton('取消');
    await expect(pending).resolves.toBe(false);
    expect(isProjectDirty()).toBe(true);
    History.undo();
    expect(isProjectDirty()).toBe(false);
    History.redo();
    expect(isProjectDirty()).toBe(true);
  });
});

describe('有未存檔變更時三個選項的行為', () => {
  beforeEach(() => makeDirty());

  it('跳出對話框，且在使用者選擇前不放行', async () => {
    let settled = false;
    const pending = confirmDiscardUnsaved().then(v => { settled = true; return v; });
    await Promise.resolve();
    expect(ui.openModal).toHaveBeenCalledTimes(1);
    expect(settled, '還沒選就放行等於沒問').toBe(false);
    clickModalButton('取消');
    await expect(pending).resolves.toBe(false);
  });

  it('切換專案只說明未儲存變更，不把切換誤稱為刪除字幕', async () => {
    const pending = confirmDiscardUnsaved();
    try {
      const [, content, buttons] = ui.openModal.mock.calls.at(-1);
      expect(content).toContain('未儲存的變更');
      expect(content).not.toMatch(/移除|既有字幕|刪除/);
      expect(buttons.map(button => button.label)).toEqual(['儲存後開啟', '不儲存直接開啟', '取消']);
    } finally {
      clickModalButton('取消');
    }
    await expect(pending).resolves.toBe(false);
  });

  it('「取消」不開啟新專案', async () => {
    const pending = confirmDiscardUnsaved();
    await Promise.resolve();
    clickModalButton('取消');
    await expect(pending).resolves.toBe(false);
    expect(ui.closeModal).toHaveBeenCalled();
  });

  it('「不儲存直接開啟」放行', async () => {
    const pending = confirmDiscardUnsaved();
    await Promise.resolve();
    clickModalButton('不儲存直接開啟');
    await expect(pending).resolves.toBe(true);
  });

  it('「儲存後開啟」等儲存真的成功才放行', async () => {
    const save = vi.spyOn(Project, 'save');
    const pending = confirmDiscardUnsaved();
    await Promise.resolve();
    await clickModalButton('儲存後開啟');
    await expect(pending).resolves.toBe(true);
    expect(save).toHaveBeenCalled();
  });

  it('關閉或取代提示視窗會取消開啟，不留下未完成的 Promise', async () => {
    for (const action of ['onDismiss', 'onReplaced']) {
      const pending = confirmDiscardUnsaved();
      ui.openModal.mock.calls.at(-1)[3][action]();
      await expect(pending).resolves.toBe(false);
    }
  });

  it('存檔期間新增的修改不能隨儲存後開啟一起丟棄', async () => {
    window.subtool.saveProject.mockImplementation(async () => {
      State.cues[0].text = 'changed during save';
      return 'C:/proj/a.subtool';
    });
    const pending = confirmDiscardUnsaved();
    await clickModalButton('儲存後開啟');
    await expect(pending).resolves.toBe(false);
    expect(isProjectDirty()).toBe(true);
  });

  /* 使用者在存檔對話框按了取消 → Project.save() 回 null。這時【不能】繼續開新專案，
     否則使用者以為存好了，結果兩邊都沒了。與關閉視窗流程的處理一致。 */
  it('「儲存後開啟」但使用者取消了存檔對話框時，不開啟新專案', async () => {
    vi.spyOn(Project, 'save').mockResolvedValue(null);
    const pending = confirmDiscardUnsaved();
    await Promise.resolve();
    await clickModalButton('儲存後開啟');
    await expect(pending).resolves.toBe(false);
  });
});

describe('標題可依情境替換', () => {
  it('預設標題是「開啟另一個專案」', async () => {
    makeDirty();
    const pending = confirmDiscardUnsaved();
    await Promise.resolve();
    expect(ui.openModal.mock.calls.at(-1)[0]).toBe('開啟另一個專案');
    clickModalButton('取消');
    await pending;
  });
});
