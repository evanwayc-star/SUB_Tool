/* ==============================================================================
   量測：「按下開啟影音 → 檔案總管視窗出現」中間那一分鐘花在哪
   ==============================================================================
   用法：
     1) 開啟 SUB Tool，把影音載入好（重點：載入後才會發生）
     2) node scripts/diagnostics/measure-dialog-stall.js
     3) 腳本會說「請按開啟影音」——去按，等對話框真的出現後按取消
     4) 回到終端機看結果

   不需要特定版本的 app：所有量測都是從主行程的 inspector 掛上去的
   （process._debugProcess），6.0.4 也適用。

   ── 記錄的時間點與限制 ──
     t0  renderer 收到 click
     t1  主行程進入 dialog.showOpenDialog
     t2  使用者看到視窗（只能由人回報）
     t3  showOpenDialog 的 Promise 回覆

   t1-t0 包含事件處理、IPC 與主行程排程；差值大時仍須用 trace 判斷成因。
   t1-t0 小只代表這段較短，不能排除呼叫後的 JavaScript 或其他排程等待。
   t3-t1 包含原生對話框、使用者操作與排程，不能當成 t2-t1 的視窗顯示耗時。

   主行程與 renderer 另記錄超過 200ms 的計時器漂移，renderer 只採連續可見區間。
   漂移是排程延遲的線索，須與實際操作及 trace 核對，不能單憑數字斷定哪段 JS 阻塞。
============================================================================== */


const { isMainWindowTarget } = require('../acceptance/cdp-electron-harness.js');
const { findMainPid, connectMainInspector } = require('./main-inspector.js');
const { rendererLagProbe } = require('./renderer-lag-probe.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const TOKEN = require('node:crypto').randomUUID();

// 有限診斷工作持有自己的 hook、timer、renderer 與讀數；不改常駐輸入探針的全域資料。
async function dialogDiagnosticSession(command, token, rendererScript, isMain) {
  const key = '__subtoolDialogDiagnostic';
  if (command === 'start') {
    const previous = globalThis[key];
    if (previous?.active) throw new Error('開檔診斷已在執行');
    // 保留失敗收尾的資格，下一輪先重試；不能永久鎖住，也不能漏掉原 renderer。
    if (previous) await dialogDiagnosticSession('stop', previous.token);
    if (globalThis[key]) throw new Error('開檔診斷已在執行');
    const { BrowserWindow, dialog } = require('electron');
    const w = BrowserWindow.getAllWindows().find(x => !x.getParentWindow()
      && isMain({ type: 'page', url: x.webContents.getURL() }));
    if (!w) throw new Error('找不到 SUB Tool 主 renderer 視窗');
    const session = { token, active: true, webContents: w.webContents, dialog,
      original: dialog.showOpenDialog, dialogs: [], lag: [], nextId: 0 };
    globalThis[key] = session;
    session.wrapper = (...args) => {
      if (!session.active) return session.original.apply(dialog, args);
      const id = ++session.nextId;
      session.dialogs.push({ id, phase: 'enter', t: Date.now() });
      const record = details => {
        if (session.active) session.dialogs.push({ id, t: Date.now(), ...details });
      };
      try {
        return Promise.resolve(session.original.apply(dialog, args)).then(result => {
          record({ phase: 'resolved', canceled: result.canceled });
          return result;
        }, error => { record({ phase: 'rejected' }); throw error; });
      } catch (error) { record({ phase: 'rejected' }); throw error; }
    };
    dialog.showOpenDialog = session.wrapper;
    let last = performance.now();
    session.timer = setInterval(() => {
      const now = performance.now(), drift = now - last - 100;
      if (drift > 200) session.lag.push({ t: Date.now(), blocked: drift });
      last = now;
    }, 100);
    // 先登記 owner：即使 renderer 已裝上探針但回覆失敗，finally 仍能釋放它。
    await session.webContents.executeJavaScript(rendererScript, true);
    return true;
  }
  const session = globalThis[key];
  if (!session || session.token !== token) {
    if (command === 'stop') return true;
    throw new Error('開檔診斷已結束或被取代');
  }
  if (command === 'stop') {
    session.active = false;
    clearInterval(session.timer);
    if (session.dialog.showOpenDialog === session.wrapper) session.dialog.showOpenDialog = session.original;
    if (!session.webContents.isDestroyed()) {
      try {
        await session.webContents.executeJavaScript(`(() => {
          const probe = window.__subtoolDialogProbe;
          if (probe?.token === ${JSON.stringify(token)}) probe.cleanup();
          return true;
        })()`, true);
      } catch (error) {
        if (!session.webContents.isDestroyed()) throw error;
      }
    }
    if (globalThis[key] === session) delete globalThis[key];
    return true;
  }
  const page = await session.webContents.executeJavaScript(`(() => {
    const probe = window.__subtoolDialogProbe;
    if (probe?.token !== ${JSON.stringify(token)}) throw new Error('renderer 診斷已被取代');
    return { clk: probe.clicks, lagRend: window.__dialogLag || [], droppedRend: window.__dialogLagDropped || 0 };
  })()`, true);
  return { ...page, dlg: session.dialogs, lagMain: session.lag };
}

const ARM_RENDERER = `(() => {
  const token = ${JSON.stringify(TOKEN)};
  if (window.__subtoolDialogProbe) {
    if (window.__subtoolDialogProbe.token === token) return true;
    throw new Error('renderer 開檔診斷已在執行');
  }
  const probe = { token, clicks: [] };
  window.__subtoolDialogProbe = probe;
  const click = e => {
    const b = e.target.closest && e.target.closest('[data-act]');
    if (b) probe.clicks.push({ act: b.dataset.act, t: Date.now() });
  };
  probe.cleanup = () => {
    document.removeEventListener('click', click, true);
    if (window.__subtoolDialogProbe !== probe) return;
    window.__dialogLagTimer_cleanup?.();
    delete window.__dialogLagTimer; delete window.__dialogLag; delete window.__dialogLagDropped;
    delete window.__subtoolDialogProbe;
  };
  document.addEventListener('click', click, true);
  return ${rendererLagProbe({ timerKey: '__dialogLagTimer', recordsKey: '__dialogLag' })};
})()`;

function sessionCommand(command) {
  return `(${dialogDiagnosticSession.toString()})(${JSON.stringify(command)}, ${JSON.stringify(TOKEN)}, ${JSON.stringify(ARM_RENDERER)}, (${isMainWindowTarget.toString()}))`;
}


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

  const main = await connectMainInspector(pid);
  let interruption;
  const signalHandlers = new Map([['SIGINT', 130], ['SIGTERM', 143]].map(([signal, exitCode]) => [signal, () => {
    interruption ||= Object.assign(new Error(`量測已中止（${signal}）`), { exitCode });
    process.exitCode = interruption.exitCode;
  }]));
  const checkInterrupted = () => { if (interruption) throw interruption; };
  // 中止仍走同一個 finally；不能讓 CLI 先離開，留下 app 裡的 active owner。
  // 等目前 CDP 呼叫完成後再收尾，避免 renderer 安裝與清除彼此超車。
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);
  try {
    checkInterrupted();
    await main.evaluate(sessionCommand('start'));
    checkInterrupted();

    console.log('\n量測已就緒。');
    console.log('★ 現在請在 SUB Tool 裡按「開啟影音」，等對話框真的出現後按【取消】。');
    console.log('（最多等 10 分鐘，抓到就會自動印結果）\n');

    /* 只認【開啟影音】那一輪。

       先前這裡寫成「看到任何一次 resolved 就收工」，結果抓到的是使用者在載入影音
       【之前】按的『開啟專案』——那一輪只花 2 ms，完全正常，白跑一趟。
       現在要等到：出現一次 act 含 media 的點擊，而且它之後有一次 showOpenDialog。 */
    const deadline = Date.now() + 10 * 60 * 1000;
    let snapshot;
    while (Date.now() < deadline) {
      checkInterrupted();
      snapshot = await main.evaluate(sessionCommand('read'));
      checkInterrupted();
      const { dlg, clk } = snapshot;
      const media = clk.filter(c => /media/.test(c.act)).pop();
      const entered = media && dlg.find(x => x.phase === 'enter' && x.t >= media.t);
      // 必須等同一呼叫回覆；固定等 1.5 秒會在使用者尚未關閉對話框時提早結束。
      if (entered && dlg.some(x => x.id === entered.id && x.phase !== 'enter')) break;
      process.stdout.write('.');
      await sleep(2000);
    }
    console.log('\n');

    const { dlg, clk, lagMain, lagRend, droppedRend } = await main.evaluate(sessionCommand('read'));
    checkInterrupted();
    const hhmmssms = t2 => new Date(t2).toTimeString().slice(0, 8) + '.' + String(t2 % 1000).padStart(3, '0');

    /* 配對【那一次】開啟影音的點擊與它之後的 showOpenDialog——不是第一次的。
       同一次執行裡通常還有先前開啟專案那一輪，取錯就會算成 2 ms 而誤判成正常。 */
    const c0 = clk.filter(c => /media/.test(c.act)).pop();
    const d0 = c0 ? dlg.find(x => x.phase === 'enter' && x.t >= c0.t) : null;
    const d1 = d0 ? dlg.find(x => x.phase === 'resolved' && x.id === d0.id) : null;

    console.log('renderer 收到的點擊：');
    clk.forEach(c => console.log(`  ${hhmmssms(c.t)}  act=${c.act}`));
    console.log('\n主行程的對話框事件：');
    dlg.forEach(x => console.log(`  ${hhmmssms(x.t)}  ${x.phase}` +
      (x.canceled !== undefined ? `  canceled=${x.canceled}` : '')));

    console.log('\n主行程採樣延遲（>200ms，原因待查）：');
    if (!lagMain.length) console.log('  （沒有）');
    lagMain.forEach(l => console.log(`  ${hhmmssms(l.t)}  採樣延遲 ${l.blocked} ms`));
    console.log('\nrenderer 可見區間的採樣延遲（>200ms，原因待查）：');
    if (droppedRend) console.log(`  （只保留最近 600 筆；略過 ${droppedRend} 筆）`);
    if (!lagRend.length) console.log('  （沒有）');
    lagRend.forEach(l => console.log(`  ${hhmmssms(l.t)}  採樣延遲 ${l.blocked} ms`));

    console.log('\n================ 量測摘要 ================');
    if (c0 && d0) {
      const a = d0.t - c0.t;
      console.log(`  點擊 → 主行程進入 showOpenDialog： ${a} ms   ← 含事件處理、IPC 與排程`);
      if (d1) console.log(`  呼叫 → Promise 回覆：             ${d1.t - d0.t} ms   ← 含原生對話框、使用者操作與排程`);
      console.log('');
      console.log(a > 3000
        ? '  → 呼叫前的等待較長；請對照上方採樣與 trace，查明事件處理、IPC 或排程的實際耗時。'
        : '  → 本輪呼叫前的間隔較短；其他等待仍須另查，不能排除呼叫後的 JavaScript 或作業系統工作。');
    } else {
      console.log('  沒有抓到完整的一輪。有按到「開啟影音」嗎？');
      console.log(`  （clickLog ${clk.length} 筆、dlgLog ${dlg.length} 筆）`);
    }

  } finally {
    try { await main.evaluate(sessionCommand('stop')); }
    finally {
      main.close();
      for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    }
  }
})().catch(e => { console.error('失敗:', e.message); process.exitCode ||= e.exitCode || 1; });
