/* ==============================================================================
   抓出「載入影音後 renderer 卡住 70 幾秒」是哪個函式
   ==============================================================================
   用法：
     1) 先跑這支（app 可以還沒開，它會等）：
          node scripts/profile-renderer-stall.js
     2) 開啟 SUB Tool → 載入影音
     3) 偵測到 renderer 開始被擋住就自動開始計時，卡住結束後印出最耗時的函式

   ── 為什麼是 renderer ──
   實測（scripts/measure-dialog-stall.js）：

     點擊「開啟影音」→ 主行程進入 dialog.showOpenDialog：1 ms
     主行程被擋住：（沒有）
     renderer 被擋住：09:20:57~09:21:32 每秒約 900ms，接著一次 39,943 ms

   合計約 75 秒。使用者按下按鈕時 renderer 主執行緒卡死，click 事件根本沒被處理，
   一直排到它恢復才送出去——所以看起來像「檔案對話框很慢」，其實對話框只花 1 ms。

   ── 為什麼用 webContents.debugger ──
   不需要 --remote-debugging-port：從主行程的 inspector 呼叫
   webContents.debugger.attach() 就能對 renderer 下 Profiler 指令。
   採樣結果在【主行程裡】就地彙總，只把前幾名送回來——整份 profile 有幾十 MB，
   透過 CDP 傳回來只會自己卡住。
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
    const bail = setTimeout(() => {
      try { ws.close(); } catch (e) {}
      reject(new Error('連上 inspector 逾時（10 秒）'));
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
      else if (m.result?.exceptionDetails) rej(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 400)));
      else res(m.result?.result?.value);
    });
    ws.on('error', reject);
  });
}

/* 找 Electron 的【主】行程（沒有 --type= 的那個）。

   兩種啟動方式的行程名不一樣，兩個都要認：
     - 安裝版：SUB Tool.exe
     - 啟動桌面版.bat：node_modules\electron\dist\electron.exe
   只寫前者的話，用 .bat 測試時腳本會一直「等不到 app」。 */
function findMainPid() {
  const ps = 'Get-CimInstance Win32_Process | '
    + "Where-Object { ($_.Name -eq 'SUB Tool.exe' -or $_.Name -eq 'electron.exe') "
    + "-and $_.CommandLine -notmatch '--type=' } | "
    + 'Select-Object -First 1 -ExpandProperty ProcessId';
  try {
    return Number(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim());
  } catch (e) { return NaN; }
}

const START_PROFILE = `(async () => {
  const B = require('electron').BrowserWindow;
  const w = B.getAllWindows().find(x => !x.getParentWindow());
  const d = w.webContents.debugger;
  try { if (!d.isAttached()) d.attach('1.3'); }
  catch (e) { return 'attach 失敗：' + e.message + '（DevTools 開著的話請先關掉）'; }
  globalThis.__prof = d;
  await d.sendCommand('Profiler.enable');
  await d.sendCommand('Profiler.setSamplingInterval', { interval: 1000 });
  await d.sendCommand('Profiler.start');
  return 'ok';
})()`;

/* 在主行程裡就地彙總，只回傳前幾名。 */
const STOP_PROFILE = `(async () => {
  const d = globalThis.__prof;
  if (!d) return JSON.stringify({ err: '沒有在進行中的 profile' });
  const { profile } = await d.sendCommand('Profiler.stop');
  try { d.detach(); } catch (e) {}
  const byId = new Map(profile.nodes.map(n => [n.id, n]));
  const self = new Map();
  const samples = profile.samples || [];
  const deltas = profile.timeDeltas || [];
  for (let i = 0; i < samples.length; i++) {
    const n = byId.get(samples[i]);
    if (!n) continue;
    const cf = n.callFrame || {};
    const file = String(cf.url || '').split('/').pop().split('?')[0] || '(無檔名)';
    const key = (cf.functionName || '(匿名)') + '  @ ' + file + ':' + ((cf.lineNumber | 0) + 1);
    self.set(key, (self.get(key) || 0) + (deltas[i] || 0));
  }
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
    .map(([fn, us]) => ({ fn, ms: Math.round(us / 1000) }));
  return JSON.stringify({
    取樣總長ms: Math.round((profile.endTime - profile.startTime) / 1000),
    取樣數: samples.length,
    前25名: top,
  });
})()`;

const ARM_LAG = `(async () => {
  const B = require('electron').BrowserWindow;
  const w = B.getAllWindows().find(x => !x.getParentWindow());
  return await w.webContents.executeJavaScript(\`(() => {
    if (window.__lagTimer_p) clearInterval(window.__lagTimer_p);
    window.__lagTotal_p = 0;
    let last = Date.now();
    window.__lagTimer_p = setInterval(() => {
      const now = Date.now();
      const drift = now - last - 100;
      if (drift > 200) window.__lagTotal_p += drift;
      last = now;
    }, 100);
    return true;
  })()\`, true);
})()`;

const READ_LAG = `(async () => {
  const B = require('electron').BrowserWindow;
  const w = B.getAllWindows().find(x => !x.getParentWindow());
  return await w.webContents.executeJavaScript('window.__lagTotal_p || 0', true);
})()`;

(async () => {
  let pid = Number(process.argv[2]) || findMainPid();
  if (!pid) {
    console.log('等待 SUB Tool 啟動…');
    const until = Date.now() + 60 * 60 * 1000;   // 等一小時：使用者不一定馬上有空
    while (!pid && Date.now() < until) { await sleep(2000); pid = findMainPid(); }
  }
  if (!pid) { console.error('等不到 SUB Tool。'); process.exit(1); }
  console.log(`主行程 PID = ${pid}`);
  try { process._debugProcess(pid); } catch (e) { console.error('開 inspector 失敗：', e.message); }
  await sleep(1200);

  let t;
  try { t = (await getJSON('http://127.0.0.1:9229/json/list'))[0]; }
  catch (e) { console.error('連不上 9229：' + e.message); process.exit(1); }
  const main = await connect(t);

  await main.eval(ARM_LAG);
  const started = await main.eval(START_PROFILE);
  if (started !== 'ok') { console.error(started); process.exit(1); }
  console.log('\nCPU profiler 已啟動。');
  console.log('★ 現在請【載入影音】。偵測到 renderer 開始卡住就會計時，結束後自動報告。\n');

  /* 等到累積阻塞超過 8 秒，再等它安靜 8 秒，就停止採樣。 */
  const deadline = Date.now() + 60 * 60 * 1000;
  let seen = 0, quietSince = 0, sawBlock = false;
  while (Date.now() < deadline) {
    const total = Number(await main.eval(READ_LAG)) || 0;
    if (total > seen) { seen = total; quietSince = 0; if (!sawBlock && total > 8000) { sawBlock = true; console.log(`偵測到 renderer 卡住（累計 ${Math.round(total / 1000)} 秒），繼續採樣…`); } }
    else if (sawBlock) { if (!quietSince) quietSince = Date.now(); else if (Date.now() - quietSince > 8000) break; }
    process.stdout.write(sawBlock ? '#' : '.');
    await sleep(2000);
  }
  console.log('\n');

  const raw = await main.eval(STOP_PROFILE);
  const out = JSON.parse(raw);
  if (out.err) { console.error(out.err); process.exit(1); }

  console.log(`採樣總長 ${Math.round(out.取樣總長ms / 1000)} 秒，${out.取樣數} 個樣本`);
  console.log(`renderer 累計被擋住 ${Math.round(seen / 1000)} 秒\n`);
  console.log('  自身耗時最高的函式（ms）：');
  for (const r of out.前25名) {
    if (r.ms < 50) continue;
    console.log(`  ${String(r.ms).padStart(8)}  ${r.fn}`);
  }

  main.close();
  process.exit(0);
})().catch(e => { console.error('失敗:', e.message); process.exit(1); });
