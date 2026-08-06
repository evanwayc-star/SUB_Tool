/* ==============================================================================
   診斷：「選單被 mpv 蓋住」與「開啟影音要等很久對話框才出現」
   ==============================================================================
   用法（PowerShell）：
     1) 用偵錯連接埠啟動已安裝的 app：
          & "C:\Program Files\SUB Tool\SUB Tool.exe" --remote-debugging-port=9223
     2) 在 app 裡把專案／影片開起來，讓畫面上真的看得到 mpv 的播放畫面
     3) node scripts/diagnose-mpv-dialog.js [連接埠]

   ── 為什麼需要這支，而不是在頁面裡攔 IPC ──
   `contextBridge.exposeInMainWorld` 暴露的物件是【凍住的】（writable:false），
   非嚴格模式下賦值會**無聲失敗**。所以在頁面裡寫
       window.subtool.mpv.show = spy
   根本裝不上去，量到的「沒有被呼叫」是自己的沉默，不是證據。
   （這個坑真的踩過，見 docs/版本變更紀錄.md v6.1.11。）

   ── 觀察點 ──
   mpv 疊層自己是一個 BrowserWindow（data:text/html 的 target），
   被 hide() 之後它的 `document.visibilityState` 會變成 'hidden'。
   那是唯一能從外部確認「mpv 到底有沒有讓位」的地方。
============================================================================== */
const http = require('http');
const WebSocket = require('ws');

const PORT = Number(process.argv[2] || 9223);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const getJSON = url => new Promise((resolve, reject) => {
  http.get(url, res => {
    let b = '';
    res.on('data', d => { b += d; });
    res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

function connect(target) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
    let id = 0;
    const pending = new Map();
    ws.on('open', () => resolve({
      eval: expr => new Promise((res, rej) => {
        const msgId = ++id;
        pending.set(msgId, { res, rej });
        ws.send(JSON.stringify({
          id: msgId, method: 'Runtime.evaluate',
          params: { expression: expr, awaitPromise: true, returnByValue: true },
        }));
      }),
      close: () => { try { ws.close(); } catch (e) {} },
    }));
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (!m.id || !pending.has(m.id)) return;
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(m.error.message));
      else if (m.result?.exceptionDetails) rej(new Error(m.result.exceptionDetails.text));
      else res(m.result?.result?.value);
    });
    ws.on('error', reject);
  });
}

/* 在主視窗裡重算一次 _syncMpvPanel 的判斷，並把每一項中間值報出來——
   這樣「它算出要讓位了嗎」與「訊息有沒有生效」可以分開看。 */
const SNAPSHOT = `JSON.stringify((() => {
  const $ = id => document.getElementById(id);
  const M = window.SUB && window.SUB.Media;
  const vr = $('videoWrap') && $('videoWrap').getBoundingClientRect();
  const box = document.querySelector('.menu.open .items');
  const ir = box && box.getBoundingClientRect();
  const ov = (a, b) => !!(a && b) && !(a.right<=b.left||a.left>=b.right||a.bottom<=b.top||a.top>=b.bottom);
  const r = x => x ? {top:Math.round(x.top),bottom:Math.round(x.bottom),left:Math.round(x.left),right:Math.round(x.right)} : null;
  return {
    mpvMode: !!(M && M.mpvMode),
    有mpv這條IPC: !!(window.subtool && window.subtool.mpv),
    inGap: !!(M && M.inGap && M.inGap()),
    webCodecsTakeover: !!(M && M.webCodecsTakeover && M.webCodecsTakeover()),
    選單展開: !!document.querySelector('.menu.open'),
    選單矩形: r(ir),
    影片區矩形: r(vr),
    重疊: ov(ir, vr),
    '_syncMpvPanel 應算出 hides': !!(M && (M.inGap && M.inGap() || M.webCodecsTakeover && M.webCodecsTakeover()) || ov(ir, vr)),
  };
})())`;

(async () => {
  let targets;
  try {
    targets = (await getJSON(`http://127.0.0.1:${PORT}/json/list`)).filter(t => t.type === 'page');
  } catch (e) {
    console.error(`連不上 127.0.0.1:${PORT} —— app 有用 --remote-debugging-port=${PORT} 啟動嗎？`);
    console.error('（一律用 127.0.0.1：Windows 的 localhost 會先解析成 IPv6，而偵錯埠只綁 IPv4。）');
    process.exit(1);
  }

  const mainT = targets.find(t => /index\.html/.test(t.url || ''));
  const mpvT = targets.find(t => /^data:text\/html/.test(t.url || ''));
  if (!mainT) { console.error('找不到主視窗。目前的目標：'); targets.forEach(t => console.error('  ' + t.url)); process.exit(1); }

  const main = await connect(mainT);
  const mpv = mpvT ? await connect(mpvT) : null;

  if (!mpv) {
    console.log('※ 找不到 mpv 疊層視窗的 CDP target。');
    console.log('  代表 mpv 目前【沒有】在跑——請先把影片開起來、確認畫面上看得到播放畫面，再跑一次。');
  }

  const mpvState = async () => {
    if (!mpv) return '（沒有 mpv target）';
    try { return await mpv.eval('document.visibilityState'); } catch (e) { return '讀取失敗：' + e.message; }
  };

  const report = async label => {
    const snap = JSON.parse(await main.eval(SNAPSHOT));
    console.log(`\n【${label}】`);
    for (const [k, v] of Object.entries(snap)) console.log(`  ${k}: ${JSON.stringify(v)}`);
    console.log(`  ★ mpv 視窗 visibilityState = ${await mpvState()}`);
  };

  console.log('=== 1. 選單遮蔽 ===');
  await report('打開選單前');
  await main.eval(`(document.getElementById('recentBtn')||{click(){}}).click(); true`);
  await sleep(900);
  await report('打開選單後');
  await main.eval(`(document.getElementById('recentBtn')||{click(){}}).click(); true`);
  await sleep(400);
  await report('關閉選單後');

  console.log('\n=== 2. 開啟影音的等待 ===');
  const wait = await main.eval(`(async () => {
    const P = window.SUB && window.SUB.Project;
    const relink = P && P.pendingMediaRelink ? (P.pendingMediaRelink() || null) : null;
    const out = { 有pending_relink: !!relink };
    if (relink) {
      const t0 = performance.now();
      await P.continueLoad(relink.generation, async () => {});
      out.空工作排進專案載入佇列等了_ms = Math.round(performance.now() - t0);
    }
    if (window.subtool && window.subtool.mainLoopLag) {
      out.主行程事件迴圈延遲 = await window.subtool.mainLoopLag(false);
    }
    return JSON.stringify(out);
  })()`);
  const w = JSON.parse(wait);
  for (const [k, v] of Object.entries(w)) console.log(`  ${k}: ${JSON.stringify(v)}`);

  console.log('\n=== 怎麼讀 ===');
  console.log('  1. 「應算出 hides」= true 但 mpv visibilityState 仍是 visible');
  console.log('     → 判斷是對的，但讓位的訊息沒有生效（往 mpv:show 那條查）');
  console.log('  2. 「應算出 hides」= false');
  console.log('     → 判斷本身就錯（看選單矩形與影片區矩形為什麼沒重疊）');
  console.log('  3. mpvMode = false 但畫面上看得到 mpv');
  console.log('     → _syncMpvPanel 第一行就 return 了，這是守衛的問題');
  console.log('  4. 主行程事件迴圈延遲的 max 很大 → 卡頓是我們擋住主行程');
  console.log('     max 很小 → 卡頓不在主行程（renderer 或 Windows 對話框）');

  main.close(); if (mpv) mpv.close();
  process.exit(0);
})().catch(e => { console.error('失敗:', e.message); process.exit(1); });
