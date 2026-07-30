// @vitest-environment jsdom
/* 開啟另一個專案前的「未存檔變更」確認（src/project.js confirmDiscardUnsaved）。

   真實災情：手上有兩份 .subtool。已經開著其中一份並改了東西，再從 Explorer 雙擊
   另一份——軟體【不會問要不要存】，直接把目前專案關掉換成新的，未存檔的內容就沒了。

   原因是 isProjectDirty() 只被關閉視窗的流程用到（app.js onAppRequestClose），
   三條「開啟專案」的路徑（選單開啟、Explorer 雙擊、瀏覽器版選檔）全都直接呼叫
   Project.load*()，中間沒有任何確認。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ui = vi.hoisted(() => ({
  openModal: vi.fn(),
  closeModal: vi.fn(),
  showToast: vi.fn(),
  setStatus: vi.fn(),
}));

vi.mock('../src/ui.js', () => ui);
vi.mock('../src/media.js', () => ({ Media: {
  displayTime: vi.fn(() => 0),
  getExternalAudioSources: vi.fn(() => []),
  loadDesktopMedia: vi.fn(),
  reset: vi.fn(),
  restorePendingImageClips: vi.fn().mockResolvedValue({ restored: 0, pending: 0 }),
  seek: vi.fn(),
  waitForPendingProjectRestore: vi.fn().mockResolvedValue(),
} }));
vi.mock('../src/timeline.js', () => ({ drawTimeline: vi.fn() }));
vi.mock('../src/notes.js', () => ({ renderNotes: vi.fn() }));

let Project;
let State;
let confirmDiscardUnsaved;
let isProjectDirty;

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
    value: { isDesktop: true, stat: vi.fn().mockResolvedValue({ exists: true, size: 100 }) },
  });

  ({ State } = await import('../src/state.js'));
  ({ Project, confirmDiscardUnsaved, isProjectDirty } = await import('../src/project.js'));

  State.cues = [];
  State.notes = [];
  State.clips = [];
  State.tracks = [];
});

/* 讓專案變成「有內容且未存檔」——isProjectDirty() 的前提是至少有字幕／備註／
   clip／音訊路由其中之一，否則空專案永遠不算 dirty。 */
function makeDirty() {
  State.cues = [{ id: 'c1', start: 0, end: 1, text: 'hello', track: 0 }];
  expect(isProjectDirty(), '前置條件：專案應為未存檔狀態').toBe(true);
}

describe('沒有未存檔變更時不打擾', () => {
  it('乾淨的專案直接放行，不跳對話框', async () => {
    await expect(confirmDiscardUnsaved()).resolves.toBe(true);
    expect(ui.openModal).not.toHaveBeenCalled();
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
    const save = vi.spyOn(Project, 'save').mockResolvedValue('C:/proj/a.subtool');
    const pending = confirmDiscardUnsaved();
    await Promise.resolve();
    await clickModalButton('儲存後開啟');
    await expect(pending).resolves.toBe(true);
    expect(save).toHaveBeenCalled();
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
