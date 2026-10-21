/* ==============================================================================
   抓出「載入影音後 renderer 卡住 70 幾秒」是哪個函式
   ==============================================================================
   用法：
     1) 先跑這支（app 可以還沒開，它會等）：
          node scripts/diagnostics/profile-renderer-stall.js
     2) 開啟 SUB Tool → 載入影音
     3) 累積可見區間延遲，結束後印出 CPU 採樣中最耗時的函式

   ── renderer 採樣的限制 ──
   舊量測曾錄到每秒約 900ms 與一次 39,943ms 延遲，但沒有同期可見性證據，
   不能據此判定主執行緒卡死：Chromium 的背景計時器節流也會產生相同讀數。
   現在只累積連續可見區間的延遲，並以 CPU profile 找出實際執行的函式。

   ── 為什麼用 webContents.debugger ──
   不需要 --remote-debugging-port：從主行程的 inspector 呼叫
   webContents.debugger.attach() 就能對 renderer 下 Profiler 指令。
   採樣結果在【主行程裡】就地彙總，只把前幾名送回來——整份 profile 有幾十 MB，
   透過 CDP 傳回來只會自己卡住。
============================================================================== */


const { execFileSync } = require('child_process');
const { CdpClient, getJSON } = require('../acceptance/cdp-electron-harness.js');
const { rendererLagProbe } = require('./renderer-lag-probe.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

/* 此函式整段送往主行程執行。取得、取消與釋放共用同一個 token owner；
   native detach 會撤銷資格，晚到回覆不能關閉之後別人重新 attach 的 session。 */
async function rendererProfileSession(command, token, lagScript) {
  const key = '__subtoolDiagnosticProfile';
  const owns = session => globalThis[key] === session && session.attached && session.debugger.isAttached();
  const cleanup = session => {
    if (session.cleanup) return session.cleanup;
    const pending = (async () => {
      try {
        if (owns(session) && session.startSent && !session.profileStopped) {
          const result = await session.debugger.sendCommand('Profiler.stop');
          if (!owns(session)) throw new Error('診斷 debugger session 已被取代');
          session.profile = result.profile;
          session.profileStopped = true;
        }
      } finally {
        if (owns(session)) {
          try { session.debugger.detach(); }
          finally {
            // A rejected detach is not a release acknowledgement. Retain the
            // registry and detach listener while this native session is alive.
            if (!session.debugger.isAttached()) {
              session.attached = false;
              session.debugger.removeListener('detach', session.onDetach);
              if (globalThis[key] === session) delete globalThis[key];
            }
          }
        }
      }
      return session.profile;
    })();
    session.cleanup = pending;
    void pending.catch(() => {
      if (session.cleanup === pending) session.cleanup = null;
    });
    return pending;
  };

  if (command.startsWith('lag-')) {
    const session = globalThis[key];
    const current = () => !!session && session.token === token && owns(session) && session.ready && !session.cancelled;
    if (command !== 'lag-stop' && !current()) throw new Error('診斷 profile 已取消或被取代');
    // Native detach removes the profile owner before the CLI reaches finally.
    // Keep only the probe's original WebContents until its token is released.
    const probeKey = key + 'Renderers';
    const contents = command === 'lag-stop' ? globalThis[probeKey]?.get(token) : session.webContents;
    if (!contents && command === 'lag-stop') return true;
    if (!contents) throw new Error('找不到本次診斷的 renderer');
    if (command === 'lag-start') (globalThis[probeKey] ||= new Map()).set(token, contents);
    const forget = () => {
      const renderers = globalThis[probeKey];
      if (renderers?.get(token) !== contents) return;
      renderers.delete(token);
      if (!renderers.size) delete globalThis[probeKey];
    };
    const timerKey = '__lagTimer_p_' + token, totalKey = '__lagTotal_p_' + token;
    const release = `(() => {
      const timerKey = ${JSON.stringify(timerKey)}, totalKey = ${JSON.stringify(totalKey)};
      window[timerKey + '_cleanup']?.();
      delete window[timerKey]; delete window[totalKey];
      return true;
    })()`;
    const releaseProbe = async () => {
      try { if (!contents.isDestroyed()) await contents.executeJavaScript(release, true); }
      catch (error) { if (!contents.isDestroyed()) throw error; }
      forget();
      return true;
    };
    if (command === 'lag-stop') return releaseProbe();
    const code = command === 'lag-start' ? lagScript : `window[${JSON.stringify(totalKey)}] || 0`;
    const result = await contents.executeJavaScript(code, true);
    if (command === 'lag-start' && !current()) {
      await releaseProbe();
      throw new Error('診斷 profile 已取消或被取代');
    }
    return result;
  }

  if (command === 'start') {
    const B = require('electron').BrowserWindow;
    const w = B.getAllWindows().find(x => !x.getParentWindow());
    if (!w) throw new Error('找不到 renderer 視窗');
    const d = w.webContents.debugger;
    if (globalThis[key] || d.isAttached()) throw new Error('debugger 已由其他工作持有，請先結束該工作');
    const session = { token, debugger: d, webContents: w.webContents, attached: false, cancelled: false, startSent: false };
    globalThis[key] = session;
    session.onDetach = () => {
      session.attached = false;
      session.cancelled = true;
      if (globalThis[key] === session) delete globalThis[key];
    };
    const assertOwner = () => {
      if (!owns(session) || session.cancelled) throw new Error('診斷 profile 已取消或被取代');
    };
    session.start = (async () => {
      try {
        d.attach('1.3');
        session.attached = true;
        d.once('detach', session.onDetach);
        await d.sendCommand('Profiler.enable');
        assertOwner();
        await d.sendCommand('Profiler.setSamplingInterval', { interval: 1000 });
        assertOwner();
        session.startSent = true;
        await d.sendCommand('Profiler.start');
        assertOwner();
        session.ready = true;
        return 'ok';
      } catch (error) {
        try { await cleanup(session); } catch { /* 保留啟動失敗的原始錯誤。 */ }
        if (globalThis[key] === session && !session.attached) delete globalThis[key];
        throw error;
      }
    })();
    return session.start;
  }

  const session = globalThis[key];
  if (!session || session.token !== token) return JSON.stringify({ err: '沒有屬於本次診斷的 profile' });
  session.cancelled = true;
  try { await session.start; } catch { /* 啟動 owner 已完成失敗清理。 */ }
  const profile = await cleanup(session);
  if (!profile || !session.ready) return JSON.stringify({ err: '診斷 profile 未完成啟動或已取消' });
  /* 在主行程裡就地彙總，只回傳前幾名。 */
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
}

function profileCommand(command, token, lagScript) {
  return `(${rendererProfileSession.toString()})(${JSON.stringify(command)}, ${JSON.stringify(token)}, ${JSON.stringify(lagScript)})`;
}
const PROFILE_TOKEN = require('node:crypto').randomUUID();
const START_PROFILE = profileCommand('start', PROFILE_TOKEN);
const STOP_PROFILE = profileCommand('stop', PROFILE_TOKEN);

const ARM_LAG = profileCommand('lag-start', PROFILE_TOKEN, rendererLagProbe({
  timerKey: '__lagTimer_p_' + PROFILE_TOKEN, totalKey: '__lagTotal_p_' + PROFILE_TOKEN,
}));
const READ_LAG = profileCommand('lag-read', PROFILE_TOKEN);
const CLEANUP_LAG = profileCommand('lag-stop', PROFILE_TOKEN);

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
  const main = new CdpClient((t).webSocketDebuggerUrl);
    await main.connect();

  try {
  const started = await main.evaluate(START_PROFILE);
  if (started !== 'ok') throw new Error(started);
  await main.evaluate(ARM_LAG);
  console.log('\nCPU profiler 已啟動。');
  console.log('★ 現在請【載入影音】。只量測可見區間的 renderer 延遲，結束後自動報告。\n');

  /* 等到可見區間累積延遲超過 8 秒，再等它安靜 8 秒，就停止採樣。 */
  const deadline = Date.now() + 60 * 60 * 1000;
  let seen = 0, quietSince = 0, sawBlock = false;
  while (Date.now() < deadline) {
    const total = Number(await main.evaluate(READ_LAG)) || 0;
    if (total > seen) { seen = total; quietSince = 0; if (!sawBlock && total > 8000) { sawBlock = true; console.log(`renderer 可見區間延遲（累計 ${Math.round(total / 1000)} 秒），繼續採樣查明原因…`); } }
    else if (sawBlock) { if (!quietSince) quietSince = Date.now(); else if (Date.now() - quietSince > 8000) break; }
    process.stdout.write(sawBlock ? '#' : '.');
    await sleep(2000);
  }
  console.log('\n');

  const raw = await main.evaluate(STOP_PROFILE);
  const out = JSON.parse(raw);
  if (out.err) throw new Error(out.err);

  console.log(`採樣總長 ${Math.round(out.取樣總長ms / 1000)} 秒，${out.取樣數} 個樣本`);
  console.log(`renderer 可見區間累計採樣延遲 ${Math.round(seen / 1000)} 秒（原因由 profile 與操作核對）\n`);
  console.log('  自身耗時最高的函式（ms）：');
  for (const r of out.前25名) {
    if (r.ms < 50) continue;
    console.log(`  ${String(r.ms).padStart(8)}  ${r.fn}`);
  }

  } finally {
    try { await main.evaluate(CLEANUP_LAG); } catch { /* 只清本 token 的 renderer probe。 */ }
    try { await main.evaluate(STOP_PROFILE); } catch { /* 斷線時不可影響其他 owner。 */ }
    main.close();
  }
})().catch(e => { console.error('失敗:', e.message); process.exitCode = 1; });
