// @vitest-environment jsdom
/* 「最近開啟」選單真的畫得出來嗎（src/recent-projects.js initRecentProjects）。
   ================================================================================

   真實災情（v6.1.8）：工具列的「🕘 最近開啟」按下去，選單是打開的，但裡面【永遠空白】——
   即使 settings.json 裡明明存著三筆開過的專案。

   原因不在資料，也不在 IPC，而在【兩個 click 監聽器的註冊順序】：

     1. `src/app.js` 在**模組頂層**就替所有 `.menu>button` 掛上通用的開合處理器，
        它負責把 `.open` 這個 class 加上／拿掉。
     2. `initRecentProjects()` 由 initAll() 呼叫，晚得多，掛的是第二個監聽器。

   兩個都掛在同一顆 `recentBtn` 上（AT_TARGET），所以依註冊順序執行：通用處理器
   【先】把 class 翻好，才輪到 recent 那個。而 recent 那個原本寫的是

       if (menu.classList.contains('open')) return; // 這一次點擊是要關閉

   ——它想用 class 判斷「這次是開還是關」，但輪到它時 class 早就被加上了，於是每一次
   「要打開」都被誤判成「要關閉」而直接 return，render 永遠不會發生。反而是第二次點擊
   （關閉那次）才會畫，所以要點到第三次才看得到東西。

   這種 bug 是【靜默】的：功能在、按鈕會動、選單會開，只是永遠沒有內容，而且既有的
   tests/recentProjects.test.js（測 electron 端的純函式：去重、排序、上限）全綠。
   所以這支測試刻意**照 app.js 的順序**先註冊通用處理器，再呼叫 initRecentProjects，
   然後模擬真人點一下——測的是「使用者按下去會不會看到清單」，不是任一支函式的回傳值。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ui = vi.hoisted(() => ({
  showToast: vi.fn(),
  /* 真的把 .open 拿掉——選單關閉的行為要跟正式碼一致，測試才測得到「點了會關」。 */
  closeMenus: vi.fn(() => {
    document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open'));
  }),
  openMenu: vi.fn(m => m?.classList.add('open')),
  /* 內容填完後要重算 mpv 讓位（見 src/ui.js 的註解）。這支被呼叫到幾次、
     在什麼時機呼叫，是本檔案要盯的東西之一。 */
  syncMenuOverlay: vi.fn(),
}));
vi.mock('../src/ui.js', () => ui);
vi.mock('../src/project.js', () => ({
  Project: { loadDesktop: vi.fn() },
  confirmDiscardUnsaved: vi.fn().mockResolvedValue(true),
}));

const RECENT = [
  { index: 0, name: 'A.subtool', path: 'D:\\proj\\A.subtool', at: 1786011143592, missing: false },
  { index: 1, name: 'B.subtool', path: 'D:\\proj\\B.subtool', at: 1786011135104, missing: true },
];

let recentProjects;
let openRecentProject;
let initRecentProjects;

/** 把 index.html 那段標記與 app.js 的通用開合處理器一起重建出來。 */
function mountToolbar() {
  document.body.innerHTML = `
    <div class="menu" id="recentMenu">
      <button class="icon" id="recentBtn">🕘 <span class="lbl">最近開啟</span></button>
      <div class="items" id="recentItems"></div>
    </div>`;
  /* ── 這就是 src/app.js 頂層那段（`.menu>button`），順序必須在 init 之前 ──
     若把這幾行搬到 initRecentProjects() 之後，這支測試就會失去意義：它測的正是
     「recent 不可以依賴自己比通用處理器早或晚」。 */
  document.querySelectorAll('.menu>button').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const m = btn.parentElement;
      const wasOpen = m.classList.contains('open');
      document.querySelectorAll('.menu.open').forEach(x => x.classList.remove('open'));
      if (!wasOpen) m.classList.add('open');
    });
  });
}

const click = id => document.getElementById(id)
  .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

/** 只取專案那幾列，跳過末端的分隔線與「清除清單」。 */
const projectRows = () => [...document.querySelectorAll('#recentItems button')]
  .filter(b => b.textContent !== '清除清單');

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  recentProjects = vi.fn().mockResolvedValue(RECENT);
  openRecentProject = vi.fn().mockResolvedValue({ path: 'D:\\proj\\A.subtool', b64: '' });
  Object.defineProperty(window, 'subtool', {
    configurable: true,
    value: {
      isDesktop: true,
      recentProjects,
      openRecentProject,
      clearRecentProjects: vi.fn().mockResolvedValue(true),
    },
  });
  mountToolbar();
  ({ initRecentProjects } = await import('../src/recent-projects.js'));
});

describe('最近開啟選單', () => {
  it('第一次點開就看得到清單（不是空的）', async () => {
    initRecentProjects();
    click('recentBtn');
    await vi.waitFor(() => expect(projectRows()).toHaveLength(2));

    expect(document.getElementById('recentMenu').classList.contains('open')).toBe(true);
    expect(projectRows()[0].textContent).toContain('A.subtool');
  });

  it('打開前就先畫過一次，選單不會先閃一格空白', async () => {
    initRecentProjects();
    await vi.waitFor(() => expect(projectRows()).toHaveLength(2));
    expect(recentProjects).toHaveBeenCalled();
  });

  it('每次點都重抓，別的視窗改動過的清單不會過期', async () => {
    initRecentProjects();
    await vi.waitFor(() => expect(projectRows()).toHaveLength(2));
    const afterInit = recentProjects.mock.calls.length;

    recentProjects.mockResolvedValue([
      { index: 0, name: 'C.subtool', path: 'D:\\proj\\C.subtool', at: 1, missing: false },
    ]);
    click('recentBtn');
    await vi.waitFor(() => expect(projectRows()).toHaveLength(1));
    expect(recentProjects.mock.calls.length).toBeGreaterThan(afterInit);
    expect(projectRows()[0].textContent).toContain('C.subtool');
  });

  it('檔案已不在的那筆標灰但仍可點', async () => {
    initRecentProjects();
    await vi.waitFor(() => expect(projectRows()).toHaveLength(2));
    const missing = projectRows()[1];
    expect(missing.textContent).toContain('⚠');
    expect(Number(missing.style.opacity)).toBeLessThan(1);
    expect(missing.disabled).toBe(false);
  });

  it('點某一列送出的是【索引】而不是路徑', async () => {
    initRecentProjects();
    await vi.waitFor(() => expect(projectRows()).toHaveLength(2));
    projectRows()[1].click();
    await vi.waitFor(() => expect(openRecentProject).toHaveBeenCalledWith(1));
    /* renderer 不可以有能力指定路徑——那等於一條「叫主程序讀任意檔案」的路。 */
    expect(openRecentProject.mock.calls.flat().some(a => typeof a === 'string')).toBe(false);
  });

  /* mpv 是 OS 層子視窗，HTML 蓋不過它。選單內容是【非同步】填進來的，高度到那一刻
     才確定，所以填完必須再要求重算一次讓位；只在「打開的瞬間」算，量到的是還沒長高
     的空盒子，判斷會是「不重疊」，mpv 不讓位，選單照樣被蓋住。 */
  it('內容填完後會要求重算 mpv 讓位', async () => {
    initRecentProjects();
    await vi.waitFor(() => expect(projectRows()).toHaveLength(2));
    expect(ui.syncMenuOverlay).toHaveBeenCalled();
  });

  it('清單空的時候也要重算（那一格同樣有高度）', async () => {
    recentProjects.mockResolvedValue([]);
    initRecentProjects();
    await vi.waitFor(() => expect(ui.syncMenuOverlay).toHaveBeenCalled());
  });

  it('點某一列會關掉選單（走 closeMenus，不自己動 classList）', async () => {
    initRecentProjects();
    await vi.waitFor(() => expect(projectRows()).toHaveLength(2));
    click('recentBtn');
    await vi.waitFor(() =>
      expect(document.getElementById('recentMenu').classList.contains('open')).toBe(true));
    projectRows()[0].click();
    expect(ui.closeMenus).toHaveBeenCalled();
    expect(document.getElementById('recentMenu').classList.contains('open')).toBe(false);
  });

  it('清單是空的時候給一句話，不是留一個空盒子', async () => {
    recentProjects.mockResolvedValue([]);
    initRecentProjects();
    await vi.waitFor(() =>
      expect(document.getElementById('recentItems').textContent).toContain('還沒有開啟過專案'));
  });

  it('網頁版整個藏起來，不留一顆按了沒反應的按鈕', async () => {
    vi.resetModules();
    Object.defineProperty(window, 'subtool', { configurable: true, value: undefined });
    mountToolbar();
    const mod = await import('../src/recent-projects.js');
    mod.initRecentProjects();
    expect(document.getElementById('recentMenu').hidden).toBe(true);
  });
});
