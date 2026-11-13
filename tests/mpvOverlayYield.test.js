// @vitest-environment jsdom
/* mpv 讓位判斷（src/video-renderer.js `_syncMpvPanel`）。
   ================================================================================

   mpv 是【主行程建立的 OS 層子視窗】，疊在 renderer 之上。HTML 的 z-index 蓋不過它，
   所以任何浮在畫面上的疊層只要伸進影片區，就會整個被蓋在下面看不見。
   `_syncMpvPanel()` 量疊層與 #videoWrap 的矩形，主程序僅裁掉被覆蓋區域。
   舊策略把整個 mpv 隱藏，底下沒有 HTML／Canvas 接手時會使影片全部變黑。

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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPlayerAdapter } from '../src/media-player-adapter.js';

/* spy 掛在 preload mpv bridge 系統邊界；正式碼則經單一 preview runtime 送達。 */
const show = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const setViewport = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const mediaState = vi.hoisted(() => ({ gap:false, takeover:false }));
vi.mock('../src/media.js', () => ({ Media: {
  mpvMode: true,
  inGap: () => mediaState.gap,
  webCodecsTakeover: () => mediaState.takeover,
  mpvPresenting: () => true,
  displayTime: () => 0,
  externalAudio: { list: () => [], get: () => null },
} }));
vi.mock('../src/sequence.js', () => ({ Seq: { clipAt: () => null, clips: () => [] } }));
vi.mock('../src/subio.js', () => ({ toASSFromState: () => '' }));
vi.mock('../src/timeline-renderer.js', () => ({ drawTimeline: vi.fn() }));
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
  setViewport.mockClear();
  mediaState.gap=false; mediaState.takeover=false;
  Object.defineProperty(window, 'subtool', {
    configurable: true,
    value: { isDesktop: true, mpv: { show, setViewport } },
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
afterEach(()=>vi.unstubAllGlobals());

describe('工具列下拉選單與 mpv 讓位', () => {
  it('展開的選單蓋到影片區 → mpv 讓位', () => {
    /* 工具列在最上面，選單往下展開，下緣伸進了影片區。 */
    mountMenu({ open: true, rect: { left: 320, top: 40, right: 560, bottom: 420 } });
    _syncMpvPanel();
    expect(setViewport).toHaveBeenLastCalledWith({ bounds:{x:300,y:100,w:1000,h:600}, visible:true,
      occluders:[{x:320,y:40,w:240,h:380}] });
    expect(show).not.toHaveBeenCalled();
  });

  it('展開的選單沒碰到影片區 → mpv 續留，影片不閃黑', () => {
    /* 矮選單，整個停在工具列高度內。 */
    mountMenu({ open: true, rect: { left: 320, top: 40, right: 560, bottom: 90 } });
    _syncMpvPanel();
    expect(setViewport).toHaveBeenLastCalledWith(expect.objectContaining({visible:true,occluders:[]}));
  });

  it('選單沒展開就不算 —— 收起來的盒子不該讓 mpv 讓位', () => {
    /* .menu 沒有 .open 時 CSS 是 display:none；即使矩形數字重疊也不能算。
       選取器必須是 `.menu.open .items`，不是 `.menu .items`。 */
    mountMenu({ open: false, rect: { left: 320, top: 40, right: 560, bottom: 420 } });
    _syncMpvPanel();
    expect(setViewport).toHaveBeenLastCalledWith(expect.objectContaining({visible:true,occluders:[]}));
  });

  it('選單關掉之後 mpv 會回來', () => {
    const { menu } = mountMenu({ open: true, rect: { left: 320, top: 40, right: 560, bottom: 420 } });
    _syncMpvPanel();
    expect(setViewport).toHaveBeenLastCalledWith(expect.objectContaining({occluders:[{x:320,y:40,w:240,h:380}]}));
    menu.classList.remove('open');
    _syncMpvPanel();
    expect(setViewport).toHaveBeenLastCalledWith(expect.objectContaining({visible:true,occluders:[]}));
  });

  it('選單在影片區左邊（例如視窗很寬）→ 不讓位', () => {
    mountMenu({ open: true, rect: { left: 10, top: 40, right: 290, bottom: 500 } });
    _syncMpvPanel();
    expect(setViewport).toHaveBeenLastCalledWith(expect.objectContaining({visible:true,occluders:[]}));
  });
});

describe('讓位的訊息要真的送到主程序', () => {
  it.each(['mixer', 'modal'])('%s 只遮住一角且沒有替代畫格時，不得隱藏整個原生影片', kind => {
    // Native-only MXF/MOV deliberately hides HTML video until a decoded
    // replacement can take over. Hiding the entire host exposes a black stage.
    const video = document.getElementById('video');
    video.style.display = 'none';
    const canvas = document.createElement('canvas');
    canvas.id = 'wcCanvas'; canvas.style.display = 'none'; document.body.append(canvas);
    const corner = { left: 1100, top: 100, right: 1450, bottom: 360 };
    if (kind === 'mixer') {
      const panel = document.createElement('div');
      panel.id = 'mixerPanel'; panel.className = 'float-panel show'; document.body.append(panel);
      stubRect(panel, corner);
    } else {
      const background = document.getElementById('modalBg'); background.classList.add('show');
      stubRect(background.querySelector('.modal'), corner);
    }
    expect(getComputedStyle(video).display).toBe('none');
    expect(getComputedStyle(canvas).display).toBe('none');
    _syncMpvPanel();
    // The uncovered majority of the preview must retain its current native
    // presenter until an actual replacement frame or native clipping is ready.
    expect(show).not.toHaveBeenCalledWith(false);
    expect(setViewport).toHaveBeenLastCalledWith(expect.objectContaining({visible:true,occluders:[{x:1100,y:100,w:350,h:260}]}));
  });

  it('只收集實際顯示的面板、搜尋框與選單，並保留所有重疊區域', () => {
    const {items}=mountMenu({open:true,rect:{left:320,top:80,right:500,bottom:200}});
    items.style.visibility='hidden';
    const panel=document.createElement('div');panel.className='float-panel show';panel.style.display='none';
    document.body.append(panel);stubRect(panel,VIDEO);
    const search=document.getElementById('searchDialog');search.style.display='flex';
    stubRect(search,{left:1000,top:80,right:1450,bottom:420});
    const ctx=document.getElementById('ctxmenu');ctx.classList.add('show');
    stubRect(ctx,{left:600,top:300,right:750,bottom:500});
    _syncMpvPanel();
    expect(setViewport).toHaveBeenLastCalledWith(expect.objectContaining({visible:true,occluders:[
      {x:1000,y:80,w:450,h:340},{x:600,y:300,w:150,h:200}]}));
  });

  it.each(['gap','takeover'])('%s 時維持真正隱藏，不能因開關面板而重露原生畫面', reason => {
    mediaState[reason]=true;
    _syncMpvPanel();
    expect(setViewport).toHaveBeenLastCalledWith(expect.objectContaining({visible:false}));
  });

  it('快捷鍵搜尋使對話框縮小時會更新裁切，關閉後停止觀察已移除節點', () => {
    let notify;
    const observe=vi.fn(),unobserve=vi.fn();
    vi.stubGlobal('ResizeObserver',class { constructor(callback){notify=callback;} observe=observe; unobserve=unobserve; });
    const settings=document.createElement('div');settings.id='settingsModal';
    settings.innerHTML='<div class="settings-modal-content"></div>';document.body.append(settings);
    const content=settings.firstElementChild;
    stubRect(content,{left:600,top:200,right:1400,bottom:650});
    _syncMpvPanel();
    expect(observe).toHaveBeenCalledWith(content);
    stubRect(content,{left:600,top:200,right:1400,bottom:350});
    observe.mockClear();unobserve.mockClear();
    notify();
    expect(observe).not.toHaveBeenCalled();expect(unobserve).not.toHaveBeenCalled();
    expect(setViewport).toHaveBeenLastCalledWith(expect.objectContaining({occluders:[{x:600,y:200,w:800,h:150}]}));
    settings.remove();_syncMpvPanel();
    expect(unobserve).toHaveBeenCalledWith(content);
    expect(setViewport).toHaveBeenLastCalledWith(expect.objectContaining({occluders:[]}));
  });

  it('modal 開關都重新計算遮擋，關閉後仍保留另一個音量表的區域', async () => {
    const {on}=await import('../src/events.js');on('mpv:sync',_syncMpvPanel);
    const {openModal,closeModal}=await import('../src/ui.js');
    const panel=document.createElement('div');panel.className='float-panel show';document.body.append(panel);
    stubRect(panel,{left:1100,top:100,right:1450,bottom:360});
    stubRect(document.querySelector('.modal'),{left:320,top:200,right:700,bottom:500});
    openModal('測試','');
    expect(setViewport).toHaveBeenLastCalledWith(expect.objectContaining({visible:true,occluders:expect.arrayContaining([
      {x:320,y:200,w:380,h:300},{x:1100,y:100,w:350,h:260}])}));
    closeModal();
    expect(setViewport).toHaveBeenLastCalledWith(expect.objectContaining({visible:true,occluders:[{x:1100,y:100,w:350,h:260}]}));
    expect(show).not.toHaveBeenCalled();
  });

  it('active transport 是 HTML5 時仍然能讓原生 OS 視窗讓位', () => {
    mountMenu({ open: true, rect: { left: 320, top: 40, right: 560, bottom: 420 } });
    _syncMpvPanel();
    expect(setViewport).toHaveBeenLastCalledWith(expect.objectContaining({visible:true,occluders:[{x:320,y:40,w:240,h:380}]}));
  });

  it('沒有 mpv 這條 IPC（網頁版）時不做任何事', async () => {
    Object.defineProperty(window, 'subtool', { configurable: true, value: undefined });
    vi.resetModules();
    const mod = await import('../src/video-renderer.js');
    mountMenu({ open: true, rect: { left: 320, top: 40, right: 560, bottom: 420 } });
    expect(() => mod._syncMpvPanel()).not.toThrow();
    expect(show).not.toHaveBeenCalled();
    expect(setViewport).not.toHaveBeenCalled();
  });
});
