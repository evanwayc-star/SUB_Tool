/* ==============================================================================
   量測：本輪開檔與指定位置讀取的耗時，供檔案對話框排查參考
   ==============================================================================
   用法：node scripts/diagnostics/measure-shell-metadata-read.js "<檔案完整路徑>"
        （可在不同播放狀態下重複採樣，保留各輪結果比較）

   ── 這支量什麼 ──
   openSync 及開頭、四分位、中段、結尾的 readSync 各計時一次，最多讀 1MB；
   小檔案的取樣位置可能重疊或短讀。這些數字只提供本輪 I/O 的線索。
   本工具不解析容器、不追蹤 shell 呼叫，也不量測 SMB／mpv 競爭或快取命中；
   不能單憑某位置慢或本輪全部快，判定或排除檔案對話框等待的原因。
============================================================================== */
const fs = require('fs');

const SRC = process.argv[2];
if (!SRC) {
  console.error('用法：node scripts/diagnostics/measure-shell-metadata-read.js "<檔案完整路徑>"');
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
  ['開頭（最多 1MB）', 0],
  ['1/4 處（最多 1MB）', Math.floor(st.size * 0.25)],
  ['中段（最多 1MB）', Math.floor(st.size * 0.5)],
  ['3/4 處（最多 1MB）', Math.floor(st.size * 0.75)],
  ['結尾（最多 1MB）', Math.max(0, st.size - LEN)],
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
console.log('  上方數字只表示本輪 openSync 與各指定位置 readSync 的耗時。');
console.log('  某位置較慢 → 可作為該次 I/O 的線索，不能據此推定 moov 位置、SMB 競爭或對話框原因。');
console.log('  全部都快   → 只說明本輪讀取較快，不能排除 shell 其他讀取方式或快取／排程差異。');
console.log('  容器索引位置、shell 實際呼叫與快取命中情況需另有證據。');
