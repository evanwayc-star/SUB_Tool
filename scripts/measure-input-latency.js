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

(async () => {
  let pid = Number(process.argv[2]) || findMainPid();
  if (!pid) {
    console.log('等待 app 啟動…');
    const until = Date.now() + 60 * 60 * 1000;
    while (!pid && Date.now() < until) { await sleep(2000); pid = findMainPid(); }
  }
  if (!pid) { console.error('等不到 app。'); process.exit(1); }
  console.log(`主行程 PID = ${pid}`);
  try { process._debugProcess(pid); } catch (e) {}
  await sleep(1200);

  const main = await connect((await getJSON('http://127.0.0.1:9229/json/list'))[0]);
  await main.eval(inPage(ARM));

  console.log('\n量測已就緒（不使用計時器，所以不受背景節流影響）。');
  console.log('★ 載入影音，然後按「開啟影音」。每一次輸入都會即時印出來。');
  console.log('   延遲 = 事件實際發生 → renderer 的 handler 跑起來\n');
  console.log('  時間      事件           延遲       可見性     目標');
  console.log('  --------  -------------  ---------  ---------  ----');

  let seen = 0;
  for (;;) {
    let list = [];
    try { list = JSON.parse(await main.eval(inPage('JSON.stringify(window.__inp || [])'))); }
    catch (e) { console.error('（讀取失敗，app 可能關了）', e.message); break; }
    for (let i = seen; i < list.length; i++) {
      const r = list[i];
      const mark = r.延遲ms > 1000 ? '   ← 這一段就是使用者等的時間' : '';
      console.log(`  ${new Date(r.at).toTimeString().slice(0, 8)}  ${r.kind.padEnd(13)}` +
        `  ${String(r.延遲ms).padStart(6)} ms  ${r.vis.padEnd(9)}  ${r.act}${mark}`);
    }
    seen = list.length;
    await sleep(1000);
  }
})().catch(e => { console.error('失敗:', e.message); process.exit(1); });
