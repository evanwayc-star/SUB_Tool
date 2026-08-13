/* ==============================================================================
   量測：載入影音時，快取相關的【同步】I/O 各要花多久
   ==============================================================================
   用法：node scripts/diagnostics/measure-cache-key.js "<影片完整路徑>"

   ── 為什麼盯這裡 ──
   這些全部跑在【主行程的 UI 執行緒】上，而原生檔案對話框的訊息迴圈也在那條執行緒。
   只要其中一段慢，「按下開啟影音 → 對話框出現」就會等那麼久。

     cacheKeyFor()   statSync + open + 【同步讀前 1MB】——對象是 SMB 上的大檔
     isDirWritable() mkdir + 寫一個測試檔 + 刪掉——在 SMB 上是三次往返
     metaValid()     對 meta 裡【每一個】聲道檔各做一次 existsSync

   readCache() 與 writeCacheDir() 各會呼叫一次 cacheCandidates()，
   而 cacheCandidates() 每次都重算 cacheKeyFor()——同一次載入會重複算好幾遍。
============================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SRC = process.argv[2];
if (!SRC) {
  console.error('用法：node scripts/diagnostics/measure-cache-key.js "<影片完整路徑>"');
  process.exit(2);
}

const ms = a => Math.round(Number(process.hrtime.bigint() - a) / 1e6);
const time = (label, fn) => {
  const a = process.hrtime.bigint();
  let out, err = '';
  try { out = fn(); } catch (e) { err = e.code || e.message; }
  console.log(`  ${String(ms(a)).padStart(7)} ms  ${label}${err ? '   (' + err + ')' : ''}`);
  return out;
};

/* 與 electron/main.js 的 cacheKeyFor 同一份邏輯。 */
function cacheKeyFor(src) {
  const s = fs.statSync(src);
  const readLen = Math.min(1024 * 1024, s.size);
  const h = crypto.createHash('sha1').update(path.basename(src) + '|' + s.size + '|');
  if (readLen > 0) {
    const fd = fs.openSync(src, 'r');
    try { const buf = Buffer.alloc(readLen); fs.readSync(fd, buf, 0, readLen, 0); h.update(buf); }
    finally { fs.closeSync(fd); }
  }
  return h.digest('hex').slice(0, 16);
}

console.log(`來源：${SRC}\n`);

console.log('第一次（冷）：');
time('statSync', () => fs.statSync(SRC));
const key = time('cacheKeyFor（含同步讀 1MB）', () => cacheKeyFor(SRC));

console.log('\n重複四次（載入一支素材期間會重算這麼多遍）：');
let total = 0;
for (let i = 0; i < 4; i++) {
  const a = process.hrtime.bigint();
  try { cacheKeyFor(SRC); } catch (e) {}
  const t = ms(a); total += t;
  console.log(`  ${String(t).padStart(7)} ms  第 ${i + 1} 次`);
}
console.log(`  ${String(total).padStart(7)} ms  合計`);

if (!key) process.exit(0);

const sideDir = path.join(path.dirname(SRC), '.subtool_Cache', key);
console.log(`\n影片旁的快取目錄：${sideDir}`);
console.log(`  存在：${fs.existsSync(sideDir)}`);

console.log('\nisDirWritable（mkdir + 寫測試檔 + 刪除，SMB 上是三次往返）：');
time('isDirWritable', () => {
  fs.mkdirSync(sideDir, { recursive: true });
  const t = path.join(sideDir, '.wtest_' + process.pid);
  fs.writeFileSync(t, 'x');
  fs.unlinkSync(t);
  return true;
});

const metaPath = path.join(sideDir, 'meta.json');
if (fs.existsSync(metaPath)) {
  console.log('\nmeta.json 的內容檢查（metaValid：每個聲道檔各一次 existsSync）：');
  const raw = time('讀 meta.json', () => JSON.parse(fs.readFileSync(metaPath, 'utf8'))) || {};
  const files = [raw.proxy, raw.wave, ...(raw.channels || []).map(c => c.file)].filter(Boolean);
  console.log(`  meta 裡有 ${files.length} 個檔案要檢查`);
  const a = process.hrtime.bigint();
  let missing = 0;
  for (const f of files) if (!fs.existsSync(path.join(sideDir, path.basename(f)))) missing++;
  console.log(`  ${String(ms(a)).padStart(7)} ms  全部 existsSync（缺 ${missing} 個）`);

  const b = process.hrtime.bigint();
  let bytes = 0, n = 0;
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { bytes += fs.statSync(p).size; n++; } catch (err) {} }
    }
  };
  try { walk(sideDir); } catch (e) {}
  console.log(`  ${String(ms(b)).padStart(7)} ms  遞迴 dirSize（${n} 個檔，${(bytes / 1e9).toFixed(2)} GB）`);
} else {
  console.log('\n（這個快取目錄裡沒有 meta.json）');
}
