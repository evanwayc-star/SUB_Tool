/* ==============================================================================
   量測：「按下開啟影音 → 檔案總管視窗出現」中間那一分鐘花在哪
   ==============================================================================
   用法：
     1) 開啟 SUB Tool，把影音載入好（重點：載入後才會發生）
     2) node scripts/measure-dialog-stall.js
     3) 腳本會說「請按開啟影音」——去按，等對話框真的出現後按取消
     4) 回到終端機看結果

   不需要特定版本的 app：所有量測都是從主行程的 inspector 掛上去的
   （process._debugProcess），6.0.4 也適用。

   ── 把等待切成三段 ──
     t0  renderer 收到 click
     t1  主行程進入 dialog.showOpenDialog（＝我們的 JS 做完了）
     t2  使用者看到視窗（只能由人回報）

   t1-t0 大        → 卡在 renderer 或 IPC（我們的問題）
   t1-t0 小而仍久等 → 卡在 Windows 畫視窗那一段（我們的 JS 已經交棒了）

   同時在【主行程】與【renderer】各埋一個事件迴圈阻塞偵測（>200ms 才記錄），
   所以「哪一條執行緒被卡住」也會直接寫在輸出裡。
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
      reject(new Error('連上 inspector 逾時（10 秒）——是不是已經有別的偵錯工具佔著？'));
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

const inPage = js => `(async () => {
  const B = require('electron').BrowserWindow;
  const w = B.getAllWindows().find(x => !x.getParentWindow());
  return await w.webContents.executeJavaScript(${JSON.stringify(js)}, true);
})()`;

/* 兩種啟動方式的行程名不一樣，兩個都要認：
   安裝版是 SUB Tool.exe，啟動桌面版.bat 跑的是 electron.exe。 */
function findMainPid() {
  const ps = 'Get-CimInstance Win32_Process | '
    + "Where-Object { ($_.Name -eq 'SUB Tool.exe' -or $_.Name -eq 'electron.exe') "
    + "-and $_.CommandLine -notmatch '--type=' } | "
    + 'Select-Object -First 1 -ExpandProperty ProcessId';
  try {
    return Number(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim());
  } catch (e) { return NaN; }
}

/* 事件迴圈阻塞偵測：100ms 的計時器，只記錄漂移超過 200ms 的那幾次。
   成本可忽略，而且不需要 app 內建任何東西。 */
const LAG_PROBE = tag => `(() => {
  if (globalThis.__lagTimer_${tag}) clearInterval(globalThis.__lagTimer_${tag});
  globalThis.__lag_${tag} = [];
  let last = Date.now();
  globalThis.__lagTimer_${tag} = setInterval(() => {
    const now = Date.now();
    const drift = now - last - 100;
    if (drift > 200) globalThis.__lag_${tag}.push({ t: now, blocked: drift });
    last = now;
  }, 100);
  return true;
})()`;

/* 等 app 出現。這樣可以【先】把量測跑起來，使用者再開 app——
   否則要求「先開 app 再跑腳本」很容易忘，而且錯過載入那一段就白跑一次。 */
async function waitForApp(maxMs = 10 * 60 * 1000) {
  const until = Date.now() + maxMs;
  let announced = false;
  while (Date.now() < until) {
    const pid = Number(process.argv[2]) || findMainPid();
    if (Number.isFinite(pid) && pid) return pid;
    if (!announced) { console.log('等待 SUB Tool 啟動…（請開啟 app 並載入影音）'); announced = true; }
    await sleep(2000);
  }
  return NaN;
}

(async () => {
  const pid = await waitForApp();
  if (!Number.isFinite(pid) || !pid) {
    console.error('等不到 SUB Tool 的主行程。');
    process.exit(1);
  }
  console.log(`主行程 PID = ${pid}`);
  try { process._debugProcess(pid); } catch (e) { console.error('開啟 inspector 失敗：', e.message); }
  await sleep(1200);

  let t;
  try { t = (await getJSON('http://127.0.0.1:9229/json/list'))[0]; }
  catch (e) { console.error('連不上主行程的 inspector（9229）：' + e.message); process.exit(1); }
  const main = await connect(t);

  /* 主行程：攔 dialog.showOpenDialog，記錄進入／回傳的時間。 */
  await main.eval(`(() => {
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
    globalThis.__dlgLog = [];
    return true;
  })()`);
  await main.eval(LAG_PROBE('main'));

  /* renderer：記錄按鈕點擊時間 + 自己的阻塞偵測。 */
  await main.eval(inPage(`(() => {
    window.__clickLog = [];
    if (!window.__clickArmed) {
      document.addEventListener('click', e => {
        const b = e.target.closest && e.target.closest('[data-act]');
        if (b) window.__clickLog.push({ act: b.dataset.act, t: Date.now() });
      }, true);
      window.__clickArmed = true;
    }
    if (window.__lagTimer_rend) clearInterval(window.__lagTimer_rend);
    window.__lag_rend = [];
    let last = Date.now();
    window.__lagTimer_rend = setInterval(() => {
      const now = Date.now();
      const drift = now - last - 100;
      if (drift > 200) window.__lag_rend.push({ t: now, blocked: drift });
      last = now;
    }, 100);
    return true;
  })()`));

  console.log('\n量測已就緒。');
  console.log('★ 現在請在 SUB Tool 裡按「開啟影音」，等對話框真的出現後按【取消】。');
  console.log('（最多等 5 分鐘，抓到就會自動印結果）\n');

  /* 只認【開啟影音】那一輪。

     先前這裡寫成「看到任何一次 resolved 就收工」，結果抓到的是使用者在載入影音
     【之前】按的『開啟專案』——那一輪只花 2 ms，完全正常，白跑一趟。
     現在要等到：出現一次 act 含 media 的點擊，而且它之後有一次 showOpenDialog。 */
  const deadline = Date.now() + 10 * 60 * 1000;
  let dlg = [], clk = [];
  while (Date.now() < deadline) {
    dlg = JSON.parse(await main.eval(`JSON.stringify(globalThis.__dlgLog || [])`));
    clk = JSON.parse(await main.eval(inPage(`JSON.stringify(window.__clickLog || [])`)));
    const media = clk.filter(c => /media/.test(c.act)).pop();
    if (media && dlg.some(x => x.phase === 'enter' && x.t >= media.t)) {
      /* 抓到了。再等一下把 resolved（使用者按取消／選檔）也收進來。 */
      await sleep(1500);
      dlg = JSON.parse(await main.eval(`JSON.stringify(globalThis.__dlgLog || [])`));
      break;
    }
    process.stdout.write('.');
    await sleep(2000);
  }
  console.log('\n');

  clk = JSON.parse(await main.eval(inPage(`JSON.stringify(window.__clickLog || [])`)));
  const lagMain = JSON.parse(await main.eval(`JSON.stringify(globalThis.__lag_main || [])`));
  const lagRend = JSON.parse(await main.eval(inPage(`JSON.stringify(window.__lag_rend || [])`)));
  const hhmmssms = t2 => new Date(t2).toTimeString().slice(0, 8) + '.' + String(t2 % 1000).padStart(3, '0');

  /* 配對【那一次】開啟影音的點擊與它之後的 showOpenDialog——不是第一次的。
     同一次執行裡通常還有先前開啟專案那一輪，取錯就會算成 2 ms 而誤判成正常。 */
  const c0 = clk.filter(c => /media/.test(c.act)).pop();
  const d0 = c0 ? dlg.find(x => x.phase === 'enter' && x.t >= c0.t) : null;
  const d1 = d0 ? dlg.find(x => x.phase === 'resolved' && x.t >= d0.t) : null;

  console.log('renderer 收到的點擊：');
  clk.forEach(c => console.log(`  ${hhmmssms(c.t)}  act=${c.act}`));
  console.log('\n主行程的對話框事件：');
  dlg.forEach(x => console.log(`  ${hhmmssms(x.t)}  ${x.phase}` +
    (x.canceled !== undefined ? `  canceled=${x.canceled}` : '')));

  console.log('\n主行程被擋住的時段（>200ms）：');
  if (!lagMain.length) console.log('  （沒有）');
  lagMain.forEach(l => console.log(`  ${hhmmssms(l.t)}  擋住 ${l.blocked} ms`));
  console.log('\nrenderer 被擋住的時段（>200ms）：');
  if (!lagRend.length) console.log('  （沒有）');
  lagRend.forEach(l => console.log(`  ${hhmmssms(l.t)}  擋住 ${l.blocked} ms`));

  console.log('\n================ 結論 ================');
  if (c0 && d0) {
    const a = d0.t - c0.t;
    console.log(`  點擊 → 主行程進入 showOpenDialog： ${a} ms   ← 這一段是我們的 JS`);
    if (d1) console.log(`  進入 → 你按下取消：             ${d1.t - d0.t} ms   ← 含 Windows 畫視窗＋你操作`);
    console.log('');
    console.log(a > 3000
      ? '  → 卡在我們的程式。看上面哪一條執行緒被擋住，時間對得起來的就是兇手。'
      : '  → 我們的 JS 幾乎沒花時間就把控制權交給 Windows 了；等待發生在對話框自己那一段。');
  } else {
    console.log('  沒有抓到完整的一輪。有按到「開啟影音」嗎？');
    console.log(`  （clickLog ${clk.length} 筆、dlgLog ${dlg.length} 筆）`);
  }

  main.close();
  process.exit(0);
})().catch(e => { console.error('失敗:', e.message); process.exit(1); });
