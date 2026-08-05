/* ==============================================================================
   CDP 執行器 —— 把一段 JS 送進正在執行的 SUB Tool 視窗並取回結果
   ==============================================================================
   用法：
     1) 先用偵錯連接埠啟動已安裝的 app（PowerShell）：
          & "C:\Program Files\SUB Tool\SUB Tool.exe" --remote-debugging-port=9223
     2) node scripts/cdp-run.js <要執行的 js 檔> [連接埠]

   為什麼不用 DevTools 前端：同一個目標只能接一個 DevTools 客戶端，而 Chrome 內建的
   DevTools 版本也可能與 Electron 對不上，症狀就是「WebSocket disconnected」。
   直接走 CDP 沒有這些問題，而且可重複執行、輸出能存檔。
   這正是 docs/開發與驗證.md §3 記載的專案主要驗證手段。

   注意：對方腳本若是 async IIFE，這裡會 await 它的結果（awaitPromise:true）。
   `console.log` 的輸出也會被轉發出來——驗證腳本就是靠它印表格的。
============================================================================== */
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const file = process.argv[2];
const port = Number(process.argv[3] || 9223);
if (!file) {
  console.error('用法：node scripts/cdp-run.js <js 檔> [連接埠]');
  process.exit(2);
}
const source = fs.readFileSync(path.resolve(file), 'utf8');

const getJSON = url => new Promise((resolve, reject) => {
  http.get(url, res => {
    let body = '';
    res.on('data', d => { body += d; });
    res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

(async () => {
  /* 一律用 127.0.0.1：Windows 上 localhost 會先解析成 IPv6 ::1，
     而 Electron 的偵錯連接埠只綁 IPv4，連 ::1 會直接 ERR_CONNECTION_CLOSED。 */
  const targets = await getJSON(`http://127.0.0.1:${port}/json/list`).catch(err => {
    console.error(`連不上 127.0.0.1:${port} —— app 有用 --remote-debugging-port=${port} 啟動嗎？`);
    console.error(err.message);
    process.exit(1);
  });

  const page = targets.find(t => t.type === 'page' && /index\.html/.test(t.url || ''));
  if (!page) {
    console.error('找不到 SUB Tool 的主頁面。目前的目標：');
    targets.forEach(t => console.error(`  [${t.type}] ${t.url}`));
    process.exit(1);
  }
  console.log(`→ 連上 ${page.title || page.url}\n`);

  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      return;
    }
    /* 把頁面裡的 console 轉發到終端機——驗證腳本的表格就是這樣印出來的。
       %c 樣式參數在終端機沒有意義，濾掉。 */
    if (msg.method === 'Runtime.consoleAPICalled') {
      const args = (msg.params.args || [])
        .filter(a => !(typeof a.value === 'string' && /^(color|background|font-weight):/.test(a.value)))
        .map(a => (a.value !== undefined ? a.value : (a.description || '')))
        .join(' ')
        .replace(/%c/g, '');
      if (args.trim()) console.log(args);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      console.error('！頁面丟出例外：', msg.params.exceptionDetails?.exception?.description
        || msg.params.exceptionDetails?.text);
    }
  });

  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  await send('Runtime.enable');

  const result = await send('Runtime.evaluate', {
    expression: source,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });

  if (result.exceptionDetails) {
    console.error('\n！執行失敗：', result.exceptionDetails.exception?.description
      || result.exceptionDetails.text);
    ws.close();
    process.exit(1);
  }
  if (result.result && result.result.value !== undefined) {
    console.log('\n=== 回傳值 ===');
    console.log(JSON.stringify(result.result.value, null, 2));
  }
  /* consoleAPICalled 是非同步送達的，關太快會漏掉最後幾行。 */
  setTimeout(() => { ws.close(); process.exit(0); }, 400);
})();
