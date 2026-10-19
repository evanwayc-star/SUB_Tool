/* ==============================================================================
   讀出頁面裡的輸入延遲探針（由 scripts/diagnostics/measure-input-latency.js 裝上）
   ==============================================================================
   用法：node scripts/diagnostics/read-input-probe.js

   ── 為什麼要拆成「裝」與「讀」兩支 ──
   常駐的監看行程一再被中止，而它一死輸出就停在表頭，看起來像「什麼都沒量到」
   ——這種失敗方式跟「真的沒有事件」長得一模一樣，已經浪費過兩輪。

   但監聽器一旦裝進頁面就會【一直留著】，不受外部行程生死影響。
   所以裝一次、之後隨時讀，比讓一個行程活著可靠得多。
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

(async () => {
  const pid = Number(process.argv[2]) || findMainPid();
  if (!pid) { console.error('app 沒有在跑。'); process.exit(1); }
  console.log(`主行程 PID = ${pid}`);
  try { process._debugProcess(pid); } catch (e) {}
  await sleep(1200);

  const main = new CdpClient(((await getJSON('http://127.0.0.1:9229/json/list'))[0]).webSocketDebuggerUrl);
    await main.connect();
  const armed = await main.evaluate(inPage('!!window.__inpArmed'));
  if (!armed) {
    console.error('頁面裡沒有探針。請先跑 scripts/diagnostics/measure-input-latency.js 裝上，');
    console.error('而且【不要在裝好之後重開 app】——重開會把它清掉。');
    process.exit(1);
  }
  const list = JSON.parse(await main.evaluate(inPage('JSON.stringify(window.__inp || [])')));
  if (!list.length) { console.log('探針在，但一次輸入都沒記錄到。'); process.exit(0); }

  console.log(`\n共 ${list.length} 筆輸入\n`);
  console.log('  時間      事件           延遲       可見性     目標');
  console.log('  --------  -------------  ---------  ---------  ----');
  for (const r of list) {
    const mark = r.延遲ms > 1000 ? '   ← 到 handler 前等待超過 1 秒' : '';
    console.log(`  ${new Date(r.at).toTimeString().slice(0, 8)}  ${String(r.kind).padEnd(13)}` +
      `  ${String(r.延遲ms).padStart(6)} ms  ${String(r.vis).padEnd(9)}  ${r.act}${mark}`);
  }

  const worst = list.reduce((a, b) => (b.延遲ms > a.延遲ms ? b : a));
  console.log(`\n最長的一筆：${worst.延遲ms} ms（${worst.kind} → ${worst.act}）`);
  console.log(worst.延遲ms > 1000
    ? '→ 到 handler 執行前的總等待超過 1 秒；可能包含 renderer JavaScript 排隊，不能單靠這個數字判定原因。請搭配 long-task／trace 記錄定位。'
    : '→ 本次保留樣本未出現超過 1000 ms 的等待；未記錄的時段與 handler 之後的工作仍需另查。');

  /* 主行程側的對話框計時：把每一次點擊與它之後的 showOpenDialog 配對起來。
     enter→resolved 是呼叫到回傳的總耗時，包含原生對話框、使用者操作與排程；
     這些欄位沒有記錄視窗首次顯示的時刻，不能據此細分。 */
  const dlg = JSON.parse(await main.evaluate('JSON.stringify(globalThis.__dlgLog || [])'));
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
    console.log('\n  「呼叫→關閉」是呼叫到回傳的總耗時，包含原生對話框、使用者操作與排程。');
    console.log('  沒有視窗首次顯示的時間戳，不能單靠這個數字判定視窗出現花了多久。');
  }

  main.close();
  process.exit(0);
})().catch(e => { console.error('失敗:', e.message); process.exit(1); });
