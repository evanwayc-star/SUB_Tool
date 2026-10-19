/* ==============================================================================
   量測：從「你按下滑鼠」到「renderer 處理那個 click」中間隔了多久
   ==============================================================================
   用法：node scripts/diagnostics/measure-input-latency.js   （app 可以還沒開，它會等）

   ── 為什麼查到這裡 ──
   這個工具源於一次開檔等待。當時已觀察到的樣本如下，並不代表每次操作都相同：

     點擊 → 主行程進入 dialog.showOpenDialog       1 ms
     主行程事件迴圈被擋住                          當時樣本未觀察到
     renderer CPU profile                          97% idle
     renderer「被擋住 75 秒」                      量錯了，那是背景視窗的計時器節流
     SMB 列目錄／快取的同步 I/O                    全部 < 0.1 秒

   這支探針補量【事件建立 → renderer 的 capture handler 真的跑起來】這一段。

   `event.timeStamp` 與 performance.now() 使用同一時間軸；兩者的差是到 handler
   執行前的總等待，可能包含 renderer JavaScript 排隊。探針不靠計時器估算這段
   等待，但無法單憑數值區分作業系統、瀏覽器派送與頁面 JS，需搭配 long-task／trace。

   同時記錄 handler 執行時的 visibilityState，供判讀背景排程影響；不是事件建立時的狀態。
============================================================================== */


const { execFileSync } = require('child_process');
const { CdpClient, getJSON } = require('../acceptance/cdp-electron-harness.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function findMainPid() {
  const ps = 'Get-CimInstance Win32_Process | '
    + "Where-Object { ($_.Name -eq 'SUB Tool.exe' -or $_.Name -eq 'electron.exe') "
    + "-and $_.CommandLine -notmatch '--type=' } | "
    + 'Select-Object -First 1 -ExpandProperty ProcessId';
  try { return Number(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim()); }
  catch (e) { return NaN; }
}

const inPage = js => `(async () => {
  const B = require('electron').BrowserWindow;
  const w = B.getAllWindows().find(x => !x.getParentWindow());
  return await w.webContents.executeJavaScript(${JSON.stringify(js)}, true);
})()`;

/* 主行程側：攔 dialog.showOpenDialog，記錄呼叫與回傳的時間。

   resolved - enter 是呼叫到回傳的總耗時，包含原生對話框、使用者操作與排程。
   這裡沒有記錄視窗首次顯示的時刻；即使使用者見到視窗就取消，也不能排除
   操作及排程時間，或把其他未記錄的等待全數歸給 showOpenDialog。

   這個 monkeypatch 掛在主行程上，只要 app 不重開就一直有效。 */
const ARM_DIALOG = `(() => {
  const d = require('electron').dialog;
  if (!globalThis.__dlgArmed) {
    const orig = d.showOpenDialog.bind(d);
    d.showOpenDialog = (...a) => {
      globalThis.__dlgLog.push({ phase: 'enter', t: Date.now() });
      return orig(...a).then(r => {
        globalThis.__dlgLog.push({ phase: 'resolved', t: Date.now(), canceled: r.canceled });
        return r;
      });
    };
    globalThis.__dlgArmed = true;
  }
  globalThis.__dlgLog = globalThis.__dlgLog || [];
  return true;
})()`;

/* 三種事件各自記錄：pointerdown、mousedown、click。
   每個差值都可能包含 renderer JS 排隊；這些事件並未保存共同手勢身分，
   不能只靠它們的差值判定延誤位置，也不代表使用者整段等待。 */
const ARM = `(() => {
  window.__inp = window.__inp || [];
  window.__inpSeq = window.__inpSeq || 0;
  if (window.__inpArmed) return true;
  const rec = (kind, e) => {
    const el = e.target && e.target.closest && e.target.closest('[data-act]');
    window.__inp.push({
      seq: ++window.__inpSeq,
      kind,
      act: el ? el.dataset.act : (e.target && e.target.id) || '(其他)',
      延遲ms: Math.round(performance.now() - e.timeStamp),
      vis: document.visibilityState,
      at: Date.now(),
    });
    if (window.__inp.length > 60) window.__inp.shift();
  };
  for (const k of ['pointerdown', 'mousedown', 'click']) {
    document.addEventListener(k, e => rec(k, e), true);
  }
  window.__inpArmed = true;
  return true;
})()`;

async function waitForPid(prev) {
  const until = Date.now() + 60 * 60 * 1000;
  let announced = false;
  while (Date.now() < until) {
    const pid = findMainPid();
    if (pid && pid !== prev) return pid;
    if (!announced) { console.log(prev ? '\napp 已關閉，等待重新啟動…' : '等待 app 啟動…'); announced = true; }
    await sleep(2000);
  }
  return 0;
}

/* 【外層重掛迴圈】
   使用者在測試過程中會關掉、重開 app（每次重開 PID 都不同）。原本掛一次就結束，
   app 一重開監看器就跟著死，而且輸出是空的——看起來像「什麼都沒量到」，
   實際上是目標不見了。現在偵測到讀取失敗就重新等待、重新掛上。 */
(async () => {
  let pid = Number(process.argv[2]) || 0;
  let printedHeader = false;
  for (;;) {
    if (!pid) pid = await waitForPid(0);
    if (!pid) { console.error('等不到 app。'); process.exit(1); }
    console.log(`\n主行程 PID = ${pid}`);
    try { process._debugProcess(pid); } catch (e) {}
    await sleep(1200);

    let main;
    try {
      main = new CdpClient(((await getJSON('http://127.0.0.1:9229/json/list'))[0]).webSocketDebuggerUrl);
    await main.connect();
      await main.evaluate(inPage(ARM));
      await main.evaluate(ARM_DIALOG);
    } catch (e) {
      main?.close();
      console.error('掛上失敗，重試：', e.message);
      pid = 0; await sleep(2000); continue;
    }

    if (!printedHeader) {
      console.log('\n量測已就緒（記錄事件時間戳與 capture handler 時間）。');
      console.log('★ 載入影音，然後按「開啟影音」。以下列出探針仍保留的輸入樣本。');
      console.log('   延遲 = 事件建立 → renderer 的 handler 執行；可能包含 renderer JavaScript 排隊，需搭配 long-task／trace 判讀。\n');
      console.log('  時間      事件           延遲       可見性     目標');
      console.log('  --------  -------------  ---------  ---------  ----');
      printedHeader = true;
    } else {
      console.log('（已重新掛上，繼續量測）');
    }

    let seen = 0, alive = true;
    while (alive) {
      let list = [];
      try { list = JSON.parse(await main.evaluate(inPage('JSON.stringify(window.__inp || [])'))); }
      catch (e) { alive = false; break; }
      const unread = list.filter(r => r.seq > seen);
      if (unread.length && unread[0].seq > seen + 1) {
        console.warn(`輸入探針已捲動，略過 ${unread[0].seq - seen - 1} 筆；以下為仍保留的事件。`);
      }
      for (const r of unread) {
        const mark = r.延遲ms > 1000 ? '   ← 到 handler 前等待超過 1 秒' : '';
        console.log(`  ${new Date(r.at).toTimeString().slice(0, 8)}  ${r.kind.padEnd(13)}` +
          `  ${String(r.延遲ms).padStart(6)} ms  ${r.vis.padEnd(9)}  ${r.act}${mark}`);
        seen = r.seq;
      }
      await sleep(1000);
    }
    try { main.close(); } catch (e) {}
    pid = 0;
  }
})().catch(e => { console.error('失敗:', e.message); process.exit(1); });
