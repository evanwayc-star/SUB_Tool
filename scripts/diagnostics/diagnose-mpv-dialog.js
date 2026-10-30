/* ==============================================================================
   診斷：工具列下拉選單看不到，以及檔案對話框卡頓
   ==============================================================================
   用法（PowerShell）：
     1) 用偵錯連接埠啟動已安裝的 app：
          & "C:\Program Files\SUB Tool\SUB Tool.exe" --remote-debugging-port=9223
     2) 在 app 裡把專案／影片開起來，讓畫面上真的看得到播放畫面
     3) node scripts/diagnostics/diagnose-mpv-dialog.js

   ── 這支腳本存在的理由：三個不能用的觀察點 ──
   同一個「選單看不到」的問題查了三輪才找對地方，因為最直覺的三種驗證全是無效的：

   1. **在頁面裡攔 IPC**：`contextBridge.exposeInMainWorld` 暴露的物件是【凍住的】
      （writable:false），非嚴格模式下 `window.subtool.mpv.show = spy` 會**無聲失敗**。
      量到的「沒有被呼叫」是自己的沉默，不是證據。
   2. **讀 mpv 疊層視窗的 `document.visibilityState`**：`_mpvWin` 是用
      `backgroundThrottling:false` 建的，Electron 在那個設定下【即使視窗被 hide()，
      頁面仍回報 visible】。這條路整整誤導了一輪。
   3. **`getBoundingClientRect()` / computed style**：兩者都【看不到裁切】。被祖先
      `overflow:hidden` 裁掉的元素照樣回報完整高度、`display:block`、`opacity:1`。
      鐵律 §0.7 在這裡會給出錯誤答案。

   這支腳本補充兩種觀察：
   - **主行程的 inspector**（`process._debugProcess` 開啟）→ `BrowserWindow.isVisible()`
     提供視窗的顯示狀態，仍須核對實際畫面是否被遮擋。
   - **`document.elementFromPoint()`** → 它回答「這個座標上使用者實際點得到誰」，
     可提供裁切或其他遮擋的線索；三個取樣點不能代表整份選單的可見範圍。
============================================================================== */


const { isMainWindowTarget } = require('../acceptance/cdp-electron-harness.js');
const { findMainPid, connectMainInspector } = require('./main-inspector.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 在 renderer 裡執行一段 JS（透過主行程的 webContents，不需要另外連 renderer）。 */
const inPage = js => `(async () => {
  const B = require('electron').BrowserWindow;
  const isMain = (${isMainWindowTarget.toString()});
  const w = B.getAllWindows().find(x => !x.getParentWindow()
    && isMain({ type: 'page', url: x.webContents.getURL() }));
  if (!w) throw new Error('找不到 SUB Tool 主 renderer 視窗');
  return await w.webContents.executeJavaScript(${JSON.stringify(js)}, true);
})()`;

/** 主行程回報的視窗顯示狀態；不代表螢幕上的遮擋結果。 */
const WINDOWS = `JSON.stringify(require('electron').BrowserWindow.getAllWindows().map(w => ({
  id: w.id, 可見: w.isVisible(), 是子視窗: !!w.getParentWindow(),
  url: (w.webContents && w.webContents.getURL() || '').slice(0, 42),
})))`;

/** 選單三個座標的 DOM 命中結果，須搭配實際畫面核對裁切或遮擋。 */
const VISIBLE_PART = `(() => {
  const box = document.querySelector('.menu.open .items');
  if (!box) return JSON.stringify({ 選單沒展開: true });
  const r = box.getBoundingClientRect();
  const probes = [r.top + 3, (r.top + r.bottom) / 2, r.bottom - 5].map(y => {
    const el = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(y));
    return { y: Math.round(y), 命中: el ? (el.id || el.className || el.tagName) : null,
             在選單內: !!(el && box.contains(el)) };
  });
  const bar = document.querySelector('.menubar');
  const bcs = bar && getComputedStyle(bar);
  return JSON.stringify({
    選單矩形: { top: Math.round(r.top), bottom: Math.round(r.bottom), 高: Math.round(r.height) },
    選單命中取樣: probes.filter(p => p.在選單內).length + '/3 個取樣點',
    探針: probes,
    menubar: bcs ? { overflow: bcs.overflow, backdropFilter: bcs.backdropFilter,
                     底緣: Math.round(bar.getBoundingClientRect().bottom) } : null,
  }, null, 1);
})()`;


(async () => {
  const pid = Number(process.argv[2]) || findMainPid();
  if (!Number.isInteger(pid) || pid <= 0) { console.error('找不到 SUB Tool 的主行程，app 有開著嗎？'); process.exit(1); }
  console.log(`主行程 PID = ${pid}`);

  const main = await connectMainInspector(pid);
  try {

    const dump = async label => {
      console.log(`\n【${label}】`);
      for (const w of JSON.parse(await main.evaluate(WINDOWS))) {
        console.log(`  視窗 id=${String(w.id).padStart(2)}  可見=${String(w.可見).padEnd(5)}` +
          `  ${w.是子視窗 ? '子' : '主'}  ${w.url}`);
      }
    };

    console.log('\n================ 1. 下拉選單看不看得到 ================');
    await dump('打開選單前');
    try {
      // 從關閉狀態開始；開合都走正式 click handler，讓 mpv 讓位狀態一起更新。
      await main.evaluate(inPage(`document.body.click(); document.getElementById('recentBtn').click(); true`));
      await sleep(1000);
      await dump('打開選單後');
      console.log('  ' + (await main.evaluate(inPage(VISIBLE_PART))).split('\n').join('\n  '));
    } finally {
      await main.evaluate(inPage(`document.body.click(); true`));
    }
    await sleep(400);
    await dump('關閉選單後');

    console.log('\n================ 2. 主行程有沒有被擋住 ================');
    const lag = await main.evaluate(inPage(`window.subtool && window.subtool.mainLoopLag
      ? window.subtool.mainLoopLag(false).then(x => JSON.stringify(x)) : '"（此版本沒有 mainLoopLag）"'`));
    console.log('  事件迴圈延遲（ms）:', lag);

    console.log('\n================ 怎麼讀 ================');
    console.log('  A. 「選單命中取樣」不是 3/3，但 mpv 子視窗【可見=false】');
    console.log('     → 請檢查 HTML 的裁切、其他遮擋與取樣座標，並核對實際畫面。');
    console.log('       menubar 的 overflow 與 backdropFilter 是既有排查線索');
    console.log('       （見 tests/menubarClipping.test.js），本輪仍須各自驗證。');
    console.log('  B. mpv 子視窗【可見=true】而選單與影片區重疊');
    console.log('     → 請沿 _syncMpvPanel → mpv:show 檢查讓位狀態；isVisible 不能單獨證明實際遮擋。');
    console.log('  C. 事件迴圈延遲只提供採樣區間的排程線索；大值須核對 trace，小值不能排除未取樣時段的主行程等待。');

  } finally {
    main.close();
  }
  process.exit(0);
})().catch(e => { console.error('失敗:', e.message); process.exit(1); });
