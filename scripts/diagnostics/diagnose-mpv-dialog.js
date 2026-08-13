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

   有效的觀察點只有兩個，這支腳本用的就是它們：
   - **主行程的 inspector**（`process._debugProcess` 開啟）→ `BrowserWindow.isVisible()`
     才是視窗可見性的唯一真相。
   - **`document.elementFromPoint()`** → 它回答「這個座標上使用者實際點得到誰」，
     會如實反映裁切。
============================================================================== */
const http = require('http');
const WebSocket = require('ws');
const { execFileSync } = require('child_process');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJSON = url => new Promise((res, rej) => {
  http.get(url, r => {
    let b = '';
    r.on('data', d => { b += d; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

function connect(target) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
    let id = 0;
    const pend = new Map();
    /* 沒有這道逾時的話，連不上就是【無聲地卡住】——先前使用者跑到一半沒有任何輸出，
       就是卡在這裡。寧可明確失敗也不要讓人盯著空白終端機。 */
    const bail = setTimeout(() => {
      try { ws.close(); } catch (e) {}
      reject(new Error('連上 inspector 逾時（10 秒）。'
        + '常見原因：已經有另一個偵錯工具佔著這個 session（DevTools、VS Code、或上一次沒關乾淨的執行）。'));
    }, 10000);
    ws.on('open', () => {
      clearTimeout(bail);
      resolve({
        eval: expr => new Promise((res, rej) => {
          const i = ++id;
          pend.set(i, { res, rej });
          ws.send(JSON.stringify({
            id: i, method: 'Runtime.evaluate',
            params: { expression: expr, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true },
          }));
        }),
        close: () => { try { ws.close(); } catch (e) {} },
      });
    });
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (!m.id || !pend.has(m.id)) return;
      const { res, rej } = pend.get(m.id);
      pend.delete(m.id);
      if (m.error) rej(new Error(m.error.message));
      else if (m.result?.exceptionDetails) rej(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 300)));
      else res(m.result?.result?.value);
    });
    ws.on('error', reject);
  });
}

/** 在 renderer 裡執行一段 JS（透過主行程的 webContents，不需要另外連 renderer）。 */
const inPage = js => `(async () => {
  const B = require('electron').BrowserWindow;
  const w = B.getAllWindows().find(x => !x.getParentWindow());
  return await w.webContents.executeJavaScript(${JSON.stringify(js)}, true);
})()`;

/** 視窗可見性的唯一真相。 */
const WINDOWS = `JSON.stringify(require('electron').BrowserWindow.getAllWindows().map(w => ({
  id: w.id, 可見: w.isVisible(), 是子視窗: !!w.getParentWindow(),
  url: (w.webContents && w.webContents.getURL() || '').slice(0, 42),
})))`;

/** 選單使用者「實際看得到多少」——elementFromPoint 會如實反映裁切。 */
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
    使用者實際看得到: probes.filter(p => p.在選單內).length + '/3 個取樣點',
    探針: probes,
    menubar: bcs ? { overflow: bcs.overflow, backdropFilter: bcs.backdropFilter,
                     底緣: Math.round(bar.getBoundingClientRect().bottom) } : null,
  }, null, 1);
})()`;

/* 只找沒有 --type= 的那個，就是 Electron 的主行程。
   用 execFileSync 傳【參數陣列】而不是拼一整條命令列：這段 PowerShell 裡有巢狀
   引號，交給 shell 拼字串在不同殼層（PowerShell vs Git Bash）會被吃掉不同的地方，
   結果是 PID 變成 0 而錯誤訊息完全看不出原因。 */
function findMainPid() {
  const ps = 'Get-CimInstance Win32_Process | '
    + "Where-Object { ($_.Name -eq 'SUB Tool.exe' -or $_.Name -eq 'electron.exe') "
    + "-and $_.CommandLine -notmatch '--type=' } | "
    + 'Select-Object -First 1 -ExpandProperty ProcessId';
  try {
    return Number(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim());
  } catch (e) { return NaN; }
}

(async () => {
  const pid = Number(process.argv[2]) || findMainPid();
  if (!Number.isFinite(pid)) { console.error('找不到 SUB Tool 的主行程，app 有開著嗎？'); process.exit(1); }
  console.log(`主行程 PID = ${pid}`);
  try { process._debugProcess(pid); } catch (e) { console.error('開啟 inspector 失敗：', e.message); }
  await sleep(1200);

  let t;
  try { t = (await getJSON('http://127.0.0.1:9229/json/list'))[0]; }
  catch (e) { console.error('連不上主行程的 inspector（9229）：' + e.message); process.exit(1); }
  const main = await connect(t);

  const dump = async label => {
    console.log(`\n【${label}】`);
    for (const w of JSON.parse(await main.eval(WINDOWS))) {
      console.log(`  視窗 id=${String(w.id).padStart(2)}  可見=${String(w.可見).padEnd(5)}` +
        `  ${w.是子視窗 ? '子' : '主'}  ${w.url}`);
    }
  };

  console.log('\n================ 1. 下拉選單看不看得到 ================');
  await dump('打開選單前');
  await main.eval(inPage(`document.getElementById('recentBtn').click(); true`));
  await sleep(1000);
  await dump('打開選單後');
  console.log('  ' + (await main.eval(inPage(VISIBLE_PART))).split('\n').join('\n  '));
  await main.eval(inPage(`document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open')); true`));
  await sleep(400);
  await dump('關閉選單後');

  console.log('\n================ 2. 主行程有沒有被擋住 ================');
  const lag = await main.eval(inPage(`window.subtool && window.subtool.mainLoopLag
    ? window.subtool.mainLoopLag(false).then(x => JSON.stringify(x)) : '"（此版本沒有 mainLoopLag）"'`));
  console.log('  事件迴圈延遲（ms）:', lag);

  console.log('\n================ 怎麼讀 ================');
  console.log('  A. 「使用者實際看得到」不是 3/3，但 mpv 子視窗【可見=false】');
  console.log('     → mpv 已經讓位了，蓋住選單的是【HTML 這一層的裁切】。');
  console.log('       看 menubar 的 overflow 與 backdropFilter：那兩個各自都會裁子孫，');
  console.log('       而且拿掉任一個都不夠（見 tests/menubarClipping.test.js）。');
  console.log('  B. mpv 子視窗【可見=true】而選單與影片區重疊');
  console.log('     → 讓位沒有生效，往 _syncMpvPanel → mpv:show 那條查。');
  console.log('  C. 事件迴圈延遲 max 很大 → 卡頓是主行程被擋住；很小 → 不在主行程。');

  main.close();
  process.exit(0);
})().catch(e => { console.error('失敗:', e.message); process.exit(1); });
