/* ==============================================================================
   同時記錄：CPU 佔用 / 每個 ffmpeg 在做什麼 / renderer 被擋住多久
   ==============================================================================
   用法：node scripts/watch-cpu-and-lag.js      （app 可以還沒開，它會等）

   ── 為什麼查到這裡 ──
   CPU profiler 的結果是：renderer 累計被擋住 22 秒，但 JS 有 97% 的時間是
   (idle)——V8 幾乎沒在執行任何東西。能讓「事件迴圈延遲很久、但 JS 沒在跑」
   同時成立的只有兩類原因：

     1. 同步 IPC（執行緒卡在等主行程）——已排除，全專案沒有任何 sendSync
     2. 行程根本沒拿到 CPU

   而載入媒體會 spawn 一連串 ffmpeg：proxy 轉檔、逐聲道抽取（這支素材有 18 個
   聲道檔）、波形、單次讀取 ingest，對象是 107 GB 的來源。

   這支把三件事並排：總 CPU、各行程 CPU、renderer 的事件迴圈延遲。
   如果 renderer 的延遲與 ffmpeg 的 CPU 佔用同進同退，那就是 CPU 被吃光，
   修法是把 ingest 的優先權調低，而不是去改 renderer 的 JS。
============================================================================== */
const http = require('http');
const WebSocket = require('ws');
const { execFileSync } = require('child_process');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const CORES = require('os').cpus().length;

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

const ps = script => {
  try { return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim(); }
  catch (e) { return ''; }
};

function findMainPid() {
  return Number(ps("Get-CimInstance Win32_Process | "
    + "Where-Object { ($_.Name -eq 'SUB Tool.exe' -or $_.Name -eq 'electron.exe') "
    + "-and $_.CommandLine -notmatch '--type=' } | "
    + 'Select-Object -First 1 -ExpandProperty ProcessId'));
}

/* 每個相關行程的累計 CPU 秒數；相鄰兩次取樣相減就是這段期間的 CPU%。 */
function cpuSnapshot() {
  const raw = ps("Get-Process | Where-Object { $_.Name -match 'SUB Tool|electron|ffmpeg|ffprobe|mpv' } | "
    + 'ForEach-Object { "$($_.Id)|$($_.Name)|$($_.CPU)" }');
  const out = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const [id, name, cpu] = line.split('|');
    if (!id) continue;
    out.set(Number(id), { name, cpu: Number(cpu) || 0 });
  }
  return out;
}

/** 目前在跑的 ffmpeg 在做什麼（從命令列猜工作類型）。 */
function ffmpegJobs() {
  const raw = ps("Get-CimInstance Win32_Process -Filter \"Name='ffmpeg.exe' or Name='ffprobe.exe'\" | "
    + 'ForEach-Object { $_.CommandLine }');
  const jobs = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let kind = '其他';
    if (/-ar\s+4000/.test(line)) kind = '波形';
    else if (/-map\s+0:a:\d+/.test(line)) kind = '抽聲道';
    else if (/ffprobe/i.test(line)) kind = 'ffprobe';
    else if (/-c:v|scale=|-crf|-b:v/.test(line)) kind = 'proxy/轉檔';
    jobs.push(kind);
  }
  const tally = {};
  jobs.forEach(j => { tally[j] = (tally[j] || 0) + 1; });
  return Object.entries(tally).map(([k, v]) => `${k}x${v}`).join(' ') || '—';
}

const ARM = `(async () => {
  const B = require('electron').BrowserWindow;
  const w = B.getAllWindows().find(x => !x.getParentWindow());
  return await w.webContents.executeJavaScript(\`(() => {
    if (window.__lagT) clearInterval(window.__lagT);
    window.__lagSum = 0;
    let last = Date.now();
    window.__lagT = setInterval(() => {
      const now = Date.now();
      const d = now - last - 100;
      if (d > 200) window.__lagSum += d;
      last = now;
    }, 100);
    return true;
  })()\`, true);
})()`;

/* 【一定要同時讀可見性與焦點】

   「每秒被擋住約 900ms」除了真的被擋住，還有一個完全不同的成因：
   Chromium 對【背景視窗】的計時器節流——視窗不在前景時 setInterval 被壓到
   每秒一次，背景滿 5 分鐘後更會進入「密集節流」變成每分鐘一次。
   那在事件迴圈延遲的量測上看起來與「被擋住」一模一樣，但實際上什麼事都沒發生。

   （這個坑真的踩到了：先前量到「renderer 被擋 75 秒」，其中一次是 39,943 ms
   ——那正好是密集節流每分鐘才醒一次的長度。沒有這兩欄就會把節流誤判成阻塞。） */
const READ = `(async () => {
  const B = require('electron').BrowserWindow;
  const w = B.getAllWindows().find(x => !x.getParentWindow());
  const r = await w.webContents.executeJavaScript(
    'JSON.stringify({ lag: window.__lagSum || 0, vis: document.visibilityState, focus: document.hasFocus() })', true);
  return JSON.stringify({ ...JSON.parse(r), winVisible: w.isVisible(), winMin: w.isMinimized(), winFocus: w.isFocused() });
})()`;

(async () => {
  let pid = Number(process.argv[2]) || findMainPid();
  if (!pid) {
    console.log('等待 app 啟動…');
    const until = Date.now() + 60 * 60 * 1000;
    while (!pid && Date.now() < until) { await sleep(2000); pid = findMainPid(); }
  }
  if (!pid) { console.error('等不到 app。'); process.exit(1); }
  console.log(`主行程 PID = ${pid}（本機 ${CORES} 顆邏輯核心）`);
  try { process._debugProcess(pid); } catch (e) {}
  await sleep(1200);

  const main = await connect((await getJSON('http://127.0.0.1:9229/json/list'))[0]);
  await main.eval(ARM);

  console.log('\n★ 請【載入影音】。Ctrl+C 結束。\n');
  console.log('  時間      新增延遲   總CPU%  ffmpeg%   可見性/焦點          ffmpeg 工作');
  console.log('  --------  --------  -------  -------  -------------------  -----------');

  let prev = cpuSnapshot();
  let prevLag = 0;
  const EVERY = 2000;
  setInterval(async () => {
    const now = cpuSnapshot();
    let ff = 0, appCpu = 0;
    for (const [id, cur] of now) {
      const before = prev.get(id);
      const delta = cur.cpu - (before ? before.cpu : 0);
      if (delta <= 0) continue;
      if (/ffmpeg|ffprobe/i.test(cur.name)) ff += delta;
      else appCpu += delta;
    }
    prev = now;
    const pct = s => Math.round((s / (EVERY / 1000)) * 100 / CORES);
    let st = { lag: 0, vis: '?', focus: false, winMin: false };
    try { st = JSON.parse(await main.eval(READ)); } catch (e) {}
    const dLag = Math.max(0, st.lag - prevLag); prevLag = st.lag;
    /* 延遲大但頁面 hidden／沒有焦點 → 是【背景節流】，不是被擋住。 */
    const throttled = st.vis !== 'visible' || !st.focus;
    const mark = dLag > 500
      ? (throttled ? '  ← 延遲（視窗在背景＝節流，不是卡住）' : '  ← 真的卡住')
      : '';
    const visCol = `${st.vis}/${st.focus ? '有焦點' : '無焦點'}${st.winMin ? '/最小化' : ''}`;
    console.log(`  ${new Date().toTimeString().slice(0, 8)}  ${String(dLag).padStart(5)} ms` +
      `  ${String(pct(ff + appCpu)).padStart(6)}%  ${String(pct(ff)).padStart(6)}%` +
      `  ${visCol.padEnd(19)}  ${ffmpegJobs()}${mark}`);
  }, EVERY);
})().catch(e => { console.error('失敗:', e.message); process.exit(1); });
