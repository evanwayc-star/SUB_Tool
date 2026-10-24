/* ==============================================================================
   持續量測：載入影音之後，列 SMB 目錄要花多久
   ==============================================================================
   用法：
     node scripts/diagnostics/watch-smb-latency.js ["\\\\Storage\\DCP\\...\\Original"]
     （不給路徑就用預設的那個 DCP 資料夾）

   ── 為什麼要這支 ──
   使用者回報「載入影音後，第一次叫出檔案總管會卡一分多鐘，之後就不會」，
   並在 6.0.4 觀察到相同現象；這是重現線索，尚不能判定成因或排除版本回歸。

   Windows 的檔案對話框可能讀取資料夾內容及檔案中繼資料。若素材在 SMB 上，
   mpv 播放與背景 Proxy／波形快取的讀取可能與這些工作競爭，但需另行量測。

   這支不需要改動 app：它從【外部】量同一個資料夾的列目錄與一次檔案讀取時間。
   不同播放狀態的結果只提供各輪 I/O 耗時線索；本工具沒有量測網路吞吐、
   SMB 飽和程度或 app 的 JavaScript，不能單憑變慢判定瓶頸，也不能排除 JS 阻塞。
   請搭配主行程／renderer 探針、網路量測及實際操作時間核對。

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
  let readMs = -1, readError = '';
  const f = entries.find(e => e.isFile());
  if (f) {
    const b = process.hrtime.bigint();
    try {
      const fd = fs.openSync(path.join(DIR, f.name), 'r');
      try { fs.readSync(fd, Buffer.alloc(65536), 0, 65536, 0); }
      finally { fs.closeSync(fd); }
    } catch (e) { readError = e.code || e.message; }
    readMs = Math.round(Number(process.hrtime.bigint() - b) / 1e6);
  }

  const mark = listMs > 3000 || readMs > 3000 ? '  ← 慢' : '';
  console.log(`  ${hhmmss()}  ${String(listMs).padStart(7)} ms  ${String(count).padStart(4)}` +
    `   ${String(readMs).padStart(10)} ms   ${busyProcs()}${err ? '  LIST ERR ' + err : ''}${readError ? '  READ ERR ' + readError : ''}${mark}`);
  if (++n % 30 === 0) console.log('');
};

tick();
setInterval(tick, EVERY_MS);
