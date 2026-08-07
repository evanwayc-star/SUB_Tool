/* ==============================================================================
   讀出頁面裡的輸入延遲探針（由 scripts/measure-input-latency.js 裝上）
   ==============================================================================
   用法：node scripts/read-input-probe.js

   ── 為什麼要拆成「裝」與「讀」兩支 ──
   常駐的監看行程一再被中止，而它一死輸出就停在表頭，看起來像「什麼都沒量到」
   ——這種失敗方式跟「真的沒有事件」長得一模一樣，已經浪費過兩輪。

   但監聽器一旦裝進頁面就會【一直留著】，不受外部行程生死影響。
   所以裝一次、之後隨時讀，比讓一個行程活著可靠得多。
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

(async () => {
  const pid = Number(process.argv[2]) || findMainPid();
  if (!pid) { console.error('app 沒有在跑。'); process.exit(1); }
  console.log(`主行程 PID = ${pid}`);
  try { process._debugProcess(pid); } catch (e) {}
  await sleep(1200);

  const main = await connect((await getJSON('http://127.0.0.1:9229/json/list'))[0]);
  const armed = await main.eval(inPage('!!window.__inpArmed'));
  if (!armed) {
    console.error('頁面裡沒有探針。請先跑 scripts/measure-input-latency.js 裝上，');
    console.error('而且【不要在裝好之後重開 app】——重開會把它清掉。');
    process.exit(1);
  }
  const list = JSON.parse(await main.eval(inPage('JSON.stringify(window.__inp || [])')));
  if (!list.length) { console.log('探針在，但一次輸入都沒記錄到。'); process.exit(0); }

  console.log(`\n共 ${list.length} 筆輸入\n`);
  console.log('  時間      事件           延遲       可見性     目標');
  console.log('  --------  -------------  ---------  ---------  ----');
  for (const r of list) {
    const mark = r.延遲ms > 1000 ? '   ← 這一段就是使用者等的時間' : '';
    console.log(`  ${new Date(r.at).toTimeString().slice(0, 8)}  ${String(r.kind).padEnd(13)}` +
      `  ${String(r.延遲ms).padStart(6)} ms  ${String(r.vis).padEnd(9)}  ${r.act}${mark}`);
  }

  const worst = list.reduce((a, b) => (b.延遲ms > a.延遲ms ? b : a));
  console.log(`\n最長的一筆：${worst.延遲ms} ms（${worst.kind} → ${worst.act}）`);
  console.log(worst.延遲ms > 1000
    ? '→ 事件本身就晚到了。延誤發生在【事件送到 renderer 之前】，不是頁面裡的 JS。'
    : '→ 每一次輸入都是即時處理的。那一分鐘不在這一段。');

  /* 主行程側的對話框計時：把每一次點擊與它之後的 showOpenDialog 配對起來。
     我們這一側已經確定不到 5 毫秒，所以 enter→resolved 幾乎就是
     「Windows 畫出視窗」＋「使用者操作」。 */
  const dlg = JSON.parse(await main.eval('JSON.stringify(globalThis.__dlgLog || [])'));
  if (!dlg.length) {
    console.log('\n（主行程的對話框探針沒有記錄——這一輪沒開過檔案對話框，'
      + '或探針是在 app 重開之後才裝的）');
  } else {
    console.log('\n檔案對話框：');
    console.log('  時間      點擊的按鈕     點擊→呼叫   呼叫→關閉');
    console.log('  --------  -------------  ----------  ---------');
    for (const en of dlg.filter(x => x.phase === 'enter')) {
      const clickBefore = list.filter(c => c.kind === 'click' && c.at <= en.t).pop();
      const res = dlg.find(x => x.phase === 'resolved' && x.t >= en.t);
      const a = clickBefore ? en.t - clickBefore.at : null;
      const b = res ? res.t - en.t : null;
      console.log(`  ${new Date(en.t).toTimeString().slice(0, 8)}  ${(clickBefore?.act || '?').padEnd(13)}` +
        `  ${String(a == null ? '?' : a + ' ms').padStart(10)}  ${String(b == null ? '（還開著）' : b + ' ms').padStart(9)}`);
    }
    console.log('\n  「呼叫→關閉」含 Windows 畫出視窗＋你的操作。');
    console.log('  一看到視窗就按取消的話，這個數字就近似於【視窗出現所花的時間】。');
  }

  main.close();
  process.exit(0);
})().catch(e => { console.error('失敗:', e.message); process.exit(1); });
