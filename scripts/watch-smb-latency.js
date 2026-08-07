/* ==============================================================================
   持續量測：載入影音之後，列 SMB 目錄要花多久
   ==============================================================================
   用法：
     node scripts/watch-smb-latency.js ["\\\\Storage\\DCP\\...\\Original"]
     （不給路徑就用預設的那個 DCP 資料夾）

   ── 為什麼要這支 ──
   使用者回報「載入影音後，第一次叫出檔案總管會卡一分多鐘，之後就不會」，而且
   6.0.4 也一樣——所以不是版本回歸，是【載入媒體這件事本身】造成的。

   Windows 的檔案對話框要列出資料夾內容才畫得出視窗。如果那個資料夾在 SMB 上，
   而我們的程式正用全速讀同一台伺服器上的大檔（mpv 串流 + 背景產生 proxy／波形
   快取），對話框的列目錄請求就得排在那些大量讀取後面。

   這支不需要改動 app：它從【外部】量同一個資料夾的列目錄時間。
   在完全閒置時應該是幾十毫秒；如果在載入影音後跳到數十秒，
   那就證明瓶頸是 SMB 連線被吃滿，而不是我們的 JS 卡住。

   每一行：時間 / 列目錄耗時 / 項目數 / 當下在跑的相關行程
============================================================================== */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const B = '\\';
const DEFAULT_DIR = B + B + 'Storage' + B + 'DCP' + B + '#The Land of Sometimes' + B + 'Original';
const DIR = process.argv[2] || DEFAULT_DIR;
const EVERY_MS = 2000;

const hhmmss = () => new Date().toTimeString().slice(0, 8);

/** 哪些相關行程在跑——用來對照「變慢的那一刻」發生了什麼。 */
function busyProcs() {
  try {
    /* 用 -join 不用 Join-String：後者是 PowerShell 7 才有的，
       Windows 內建的 5.1 會直接 CommandNotFoundException。 */
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      "(Get-Process | Where-Object { $_.Name -match 'ffmpeg|ffprobe|mpv' } | " +
      'Group-Object Name | ForEach-Object { "$($_.Name)x$($_.Count)" }) -join " "'],
    { encoding: 'utf8' }).trim();
    return out || '—';
  } catch (e) { return '?'; }
}

let n = 0;
console.log(`量測目標：${DIR}`);
console.log(`每 ${EVERY_MS} ms 一次。Ctrl+C 結束。\n`);
console.log('  時間      列目錄      項目   讀第一個檔 64KB   在跑的行程');
console.log('  --------  ----------  -----  ---------------   ----------');

const tick = () => {
  const a = process.hrtime.bigint();
  let count = '—', err = '';
  let entries = [];
  try { entries = fs.readdirSync(DIR, { withFileTypes: true }); count = entries.length; }
  catch (e) { err = e.code; }
  const listMs = Math.round(Number(process.hrtime.bigint() - a) / 1e6);

  /* 再讀一個真的檔案的開頭——檔案總管的屬性處理常式會做類似的事，
     而且它比列目錄更容易被大量循序讀取排擠。 */
  let readMs = -1;
  const f = entries.find(e => e.isFile());
  if (f) {
    const b = process.hrtime.bigint();
    try {
      const fd = fs.openSync(path.join(DIR, f.name), 'r');
      fs.readSync(fd, Buffer.alloc(65536), 0, 65536, 0);
      fs.closeSync(fd);
    } catch (e) {}
    readMs = Math.round(Number(process.hrtime.bigint() - b) / 1e6);
  }

  const mark = listMs > 3000 || readMs > 3000 ? '  ← 慢' : '';
  console.log(`  ${hhmmss()}  ${String(listMs).padStart(7)} ms  ${String(count).padStart(4)}` +
    `   ${String(readMs).padStart(10)} ms   ${busyProcs()}${err ? '  ERR ' + err : ''}${mark}`);
  if (++n % 30 === 0) console.log('');
};

tick();
setInterval(tick, EVERY_MS);
