/* ==============================================================================
   量測：Windows 檔案對話框要讀那個大檔的中繼資料時，會慢多久
   ==============================================================================
   用法：node scripts/diagnostics/measure-shell-metadata-read.js "<影片完整路徑>"
        （在 mpv 正在播那個檔的時候跑，才量得到真實情況）

   ── 為什麼查到這裡 ──
   已經量到：

     按下滑鼠 → renderer 收到事件               1–4 ms
     renderer → 主行程呼叫 showOpenDialog        1 ms
     showOpenDialog 呼叫 → 關閉                 42,610 ms   ← 全部在這

   而且那 42 秒只在 mpv 打開那個 106 GB 的 .mov 之後才發生。

   ── 假設 ──
   Windows 的檔案對話框要列出資料夾內容才畫得出視窗，而 shell 的屬性處理常式
   會讀每個影片檔的中繼資料（長度、解析度）來填欄位。`.mov` 的中繼資料索引
   （moov atom）除非做過 faststart，否則【放在檔案結尾】——也就是要跳到
   106 GB 的尾端去讀，而那條 SMB 連線此刻正被 mpv 串流佔著。

   先前量過「每檔讀開頭 64KB＝60ms」，但那只讀開頭、而且是資料夾裡的小檔，
   完全沒有碰到這個情況。

   ── 這支量什麼 ──
   開頭 1MB、【結尾 1MB】、以及中段各讀一次，分別計時。
   結尾特別慢就證實了上面的假設。
============================================================================== */
const fs = require('fs');

const SRC = process.argv[2];
if (!SRC) {
  console.error('用法：node scripts/diagnostics/measure-shell-metadata-read.js "<影片完整路徑>"');
  process.exit(2);
}

const ms = a => Math.round(Number(process.hrtime.bigint() - a) / 1e6);

let st;
try { st = fs.statSync(SRC); }
catch (e) { console.error('讀不到這個檔：', e.code); process.exit(1); }

console.log(`檔案：${SRC}`);
console.log(`大小：${(st.size / 1e9).toFixed(2)} GB\n`);

const LEN = 1024 * 1024;
const spots = [
  ['開頭 1MB', 0],
  ['1/4 處 1MB', Math.floor(st.size * 0.25)],
  ['中段 1MB', Math.floor(st.size * 0.5)],
  ['3/4 處 1MB', Math.floor(st.size * 0.75)],
  ['結尾 1MB', Math.max(0, st.size - LEN)],
];

const buf = Buffer.alloc(LEN);
let fd;
const a0 = process.hrtime.bigint();
try { fd = fs.openSync(SRC, 'r'); } catch (e) { console.error('開檔失敗：', e.code); process.exit(1); }
console.log(`  ${String(ms(a0)).padStart(7)} ms  openSync\n`);

for (const [label, pos] of spots) {
  const a = process.hrtime.bigint();
  let err = '';
  try { fs.readSync(fd, buf, 0, LEN, pos); } catch (e) { err = e.code; }
  const t = ms(a);
  const mark = t > 3000 ? '   ← 慢' : '';
  console.log(`  ${String(t).padStart(7)} ms  ${label}  @ ${(pos / 1e9).toFixed(1)} GB${err ? ' (' + err + ')' : ''}${mark}`);
}
fs.closeSync(fd);

console.log('\n讀法：');
console.log('  結尾特別慢 → .mov 的 moov atom 在檔尾，shell 讀中繼資料時要跨 100GB 定位，');
console.log('               而那條 SMB 連線正被 mpv 串流佔著。這就是對話框慢的原因。');
console.log('  全部都快   → 不是這個機制，要再往別的方向查。');
