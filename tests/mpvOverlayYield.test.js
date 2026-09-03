// @vitest-environment jsdom
/* mpv 讓位判斷（src/video-renderer.js `_syncMpvPanel`）。
   ================================================================================

   mpv 是【主行程建立的 OS 層子視窗】，疊在 renderer 之上。HTML 的 z-index 蓋不過它，
   所以任何浮在畫面上的疊層只要伸進影片區，就會整個被蓋在下面看不見。
   `_syncMpvPanel()` 的職責就是：量疊層與 #videoWrap 的矩形，真的重疊才叫 mpv 讓位
   （不重疊時影片繼續顯示，不會為了一個選單就閃黑）。

   真實事故（v6.1.9）：工具列新增的「🕘 最近開啟」展開後最多 10 筆、每筆兩行，
   高度遠超過工具列，直接伸進影片區——選單有正確 render（CDP 量到 computed style
   可見、每一列的 getBoundingClientRect 都有寬高）卻【完全看不到】。
   原因是 `_syncMpvPanel()` 認得浮動面板、搜尋視窗、右鍵選單，唯獨沒有把工具列的
   `.menu.open .items` 算進去。先前沒被發現，是因為在這之前工具列選單都很矮，
   撐不到影片區。

   > 這個 bug 也說明了鐵律 §0.7（可見性只看 computed style）的邊界：computed style
   > 只證明「HTML 這一層把它畫出來了」，證明不了「使用者的眼睛看得到」。畫面上還有
   > 一層 HTML 看不見的 OS 視窗。

   【jsdom 不做版面計算】——getBoundingClientRect 一律回傳 0。所以這裡的矩形是
   stub 出來的。這支測試因此測的是【重疊判斷與接線】，不是 CSS 排版；排版要靠真機
   驗證（docs/開發與驗證.md §3 的 CDP，或看得到畫面的截圖）。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPlayerAdapter } from '../src/media-player-adapter.js';

/* spy 掛在 preload mpv bridge 系統邊界；正式碼則經單一 preview runtime 送達。 */
const show = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../src/media.js', () => ({ Media: {
  mpvMode: true,
  inGap: () => false,
  webCodecsTakeover: () => false,
  mpvPresenting: () => true,
  displayTime: () => 0,
  externalAudio: { list: () => [], get: () => null },
} }));
vi.mock('../src/sequence.js', () => ({ Seq: { clipAt: () => null, clips: () => [] } }));
vi.mock('../src/subio.js', () => ({ toASSFromState: () => '' }));
vi.mock('../src/timeline.js', () => ({ drawTimeline: vi.fn() }));
vi.mock('../src/timeline-interaction-engine.js', () => ({
  createPreviewDrag: () => ({ bind: vi.fn(), begin: vi.fn(), end: vi.fn() }),
}));

let _syncMpvPanel;

/** 影片區固定在 (300,100)–(1300,700)。 */
const VIDEO = { left: 300, top: 100, right: 1300, bottom: 700, width: 1000, height: 600 };

function stubRect(el, r) {
  el.getBoundingClientRect = () => ({ ...r, x: r.left, y: r.top,
    width: r.right - r.left, height: r.bottom - r.top, toJSON: () => r });
}

/** 建一個工具列下拉選單，並指定它展開後的矩形。 */
function mountMenu({ open, rect }) {
  const menu = document.createElement('div');
  menu.className = 'menu' + (open ? ' open' : '');
  const items = document.createElement('div');
  items.className = 'items';
  menu.appendChild(items);
  document.body.appendChild(menu);
  stubRect(items, rect);
  return { menu, items };
}

beforeEach(async () => {
  vi.resetModules();
  show.mockClear();
  Object.defineProperty(window, 'subtool', {
    configurable: true,
    value: { isDesktop: true, mpv: { show } },
  });
  resetPlayerAdapter(window.subtool);
  document.body.innerHTML = `
    <div id="videoWrap"></div><div id="videoSub"></div>
    <div id="modalBg"><div class="modal"><div id="modalTitle"></div>
      <div id="modalBody"></div><div id="modalBtns"></div></div></div>
    <div id="ctxmenu"></div><div id="searchDialog" style="display:none"></div>
    <div id="stMsg"></div><div id="stDot"></div><div id="toast"></div><div id="osd"></div>
    <canvas id="rulerCv"></canvas><div id="tlScroll"></div><div id="tlLayer"></div>
    <div id="tlTracks"></div><div id="sublist"></div><div id="imageLayer"></div>
    <video id="video"></video>`;
  stubRect(document.getElementById('videoWrap'), VIDEO);
  stubRect(document.getElementById('modalBg'), { left: 0, top: 0, right: 0, bottom: 0 });
  ({ _syncMpvPanel } = await import('../src/video-renderer.js'));
});

describe('工具列下拉選單與 mpv 讓位', () => {
  it('展開的選單蓋到影片區 → mpv 讓位', () => {
    /* 工具列在最上面，選單往下展開，下緣伸進了影片區。 */
    mountMenu({ open: true, rect: { left: 320, top: 40, right: 560, bottom: 420 } });
    _syncMpvPanel();
    expect(show).toHaveBeenCalledWith(false);
  });

  it('展開的選單沒碰到影片區 → mpv 續留，影片不閃黑', () => {
    /* 矮選單，整個停在工具列高度內。 */
    mountMenu({ open: true, rect: { left: 320, top: 40, right: 560, bottom: 90 } });
    _syncMpvPanel();
    expect(show).toHaveBeenCalledWith(true);
  });

  it('選單沒展開就不算 —— 收起來的盒子不該讓 mpv 讓位', () => {
    /* .menu 沒有 .open 時 CSS 是 display:none；即使矩形數字重疊也不能算。
       選取器必須是 `.menu.open .items`，不是 `.menu .items`。 */
    mountMenu({ open: false, rect: { left: 320, top: 40, right: 560, bottom: 420 } });
    _syncMpvPanel();
    expect(show).toHaveBeenCalledWith(true);
  });

  it('選單關掉之後 mpv 會回來', () => {
    const { menu } = mountMenu({ open: true, rect: { left: 320, top: 40, right: 560, bottom: 420 } });
    _syncMpvPanel();
    expect(show).toHaveBeenLastCalledWith(false);
    menu.classList.remove('open');
    _syncMpvPanel();
    expect(show).toHaveBeenLastCalledWith(true);
  });

  it('選單在影片區左邊（例如視窗很寬）→ 不讓位', () => {
    mountMenu({ open: true, rect: { left: 10, top: 40, right: 290, bottom: 500 } });
    _syncMpvPanel();
    expect(show).toHaveBeenCalledWith(true);
  });
});

describe('讓位的訊息要真的送到主程序', () => {
  it('active transport 是 HTML5 時仍然能讓原生 OS 視窗讓位', () => {
    mountMenu({ open: true, rect: { left: 320, top: 40, right: 560, bottom: 420 } });
    _syncMpvPanel();
    expect(show).toHaveBeenCalledWith(false);
  });

  it('沒有 mpv 這條 IPC（網頁版）時不做任何事', async () => {
    Object.defineProperty(window, 'subtool', { configurable: true, value: undefined });
    vi.resetModules();
    const mod = await import('../src/video-renderer.js');
    mountMenu({ open: true, rect: { left: 320, top: 40, right: 560, bottom: 420 } });
    expect(() => mod._syncMpvPanel()).not.toThrow();
    expect(show).not.toHaveBeenCalled();
  });
});
