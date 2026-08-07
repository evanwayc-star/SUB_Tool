/* ==============================================================================
   量測：從「你按下滑鼠」到「renderer 處理那個 click」中間隔了多久
   ==============================================================================
   用法：node scripts/measure-input-latency.js   （app 可以還沒開，它會等）

   ── 為什麼查到這裡 ──
   到目前為止量到的全部是「沒問題」：

     點擊 → 主行程進入 dialog.showOpenDialog       1 ms
     主行程事件迴圈被擋住                          從來沒有
     renderer CPU profile                          97% idle
     renderer「被擋住 75 秒」                      量錯了，那是背景視窗的計時器節流
     SMB 列目錄／快取的同步 I/O                    全部 < 0.1 秒

   但使用者確實等了一分鐘。唯一還沒量過的區段，就是【按下滑鼠 → renderer 的
   handler 真的跑起來】這一段。

   `event.timeStamp` 是【事件實際發生的時間】（與 performance.now() 同一時間軸），
   在 handler 裡減一下就是這一段的長度。這個數字不受計時器節流影響——
   它不是用計時器量的。

   同時記錄事件當下的 visibilityState，避免又把節流混進來。
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
    const bail = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('inspector 逾時')); }, 10000);
    ws.on('open', () => {
      clearTimeout(bail);
      resolve({
        eval: expr => new Promise((res, rej) => {
          const i = ++id;
          pend.set(i, { res, rej });
          ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate',
            params: { expression: expr, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true } }));
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

   已經量到我們這一側從按下到交棒不到 5 毫秒（輸入延遲 1–4ms ＋ 點擊到呼叫
   showOpenDialog 1ms），所以那一分鐘只可能在【showOpenDialog 裡面】。
   resolved - enter 含「Windows 畫出視窗」與「使用者操作」兩段——
   請使用者一看到視窗就按取消，這個差值就近似於視窗出現所花的時間。

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

/* 三種事件都攔：pointerdown（最早）、mousedown、click。
   若 pointerdown 就已經遲到，代表事件在【送進頁面之前】就被延誤了；
   若 pointerdown 準時而 click 遲到，代表延誤發生在頁面內部。 */
const ARM = `(() => {
  window.__inp = [];
  if (window.__inpArmed) return true;
  const rec = (kind, e) => {
    const el = e.target && e.target.closest && e.target.closest('[data-act]');
    window.__inp.push({
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
      main = await connect((await getJSON('http://127.0.0.1:9229/json/list'))[0]);
      await main.eval(inPage(ARM));
      await main.eval(ARM_DIALOG);
    } catch (e) {
      console.error('掛上失敗，重試：', e.message);
      pid = 0; await sleep(2000); continue;
    }

    if (!printedHeader) {
      console.log('\n量測已就緒（不使用計時器，所以不受背景節流影響）。');
      console.log('★ 載入影音，然後按「開啟影音」。每一次輸入都會即時印出來。');
      console.log('   延遲 = 事件實際發生 → renderer 的 handler 跑起來\n');
      console.log('  時間      事件           延遲       可見性     目標');
      console.log('  --------  -------------  ---------  ---------  ----');
      printedHeader = true;
    } else {
      console.log('（已重新掛上，繼續量測）');
    }

    let seen = 0, alive = true;
    while (alive) {
      let list = [];
      try { list = JSON.parse(await main.eval(inPage('JSON.stringify(window.__inp || [])'))); }
      catch (e) { alive = false; break; }
      for (let i = seen; i < list.length; i++) {
        const r = list[i];
        const mark = r.延遲ms > 1000 ? '   ← 這一段就是使用者等的時間' : '';
        console.log(`  ${new Date(r.at).toTimeString().slice(0, 8)}  ${r.kind.padEnd(13)}` +
          `  ${String(r.延遲ms).padStart(6)} ms  ${r.vis.padEnd(9)}  ${r.act}${mark}`);
      }
      seen = list.length;
      await sleep(1000);
    }
    try { main.close(); } catch (e) {}
    pid = 0;
  }
})().catch(e => { console.error('失敗:', e.message); process.exit(1); });
