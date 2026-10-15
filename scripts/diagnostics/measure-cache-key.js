/* ==============================================================================
   量測：載入影音時，快取相關的【同步】I/O 各要花多久
   ==============================================================================
   用法：node scripts/diagnostics/measure-cache-key.js "<影片完整路徑>"

   ── 為什麼盯這裡 ──
   這些全部跑在【主行程的 UI 執行緒】上，而原生檔案對話框的訊息迴圈也在那條執行緒。
   只要其中一段慢，「按下開啟影音 → 對話框出現」就會等那麼久。

     cacheKeyFor()   metadata + 前／中／尾段同步取樣——對象是 SMB 上的大檔
     isDirWritable() mkdir + 寫一個測試檔 + 刪掉——在 SMB 上是三次往返
     inspectCache()  依 runtime 的 generation 路徑與檔案證據檢查各元件

   重複取樣是成本比較；實際呼叫次數以當前 media-intake-runtime 的載入路徑為準。
============================================================================== */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { cacheKeyFor, createMediaIntakeRuntime } = require('../../electron/media-intake-runtime.js');

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

console.log(`來源：${SRC}\n`);

console.log('第一次（冷）：');
time('statSync', () => fs.statSync(SRC));
const key = time('cacheKeyFor（現行來源 fingerprint）', () => cacheKeyFor(SRC));

console.log('\n重複四次（暖快取成本比較）：');
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
  console.log('\nmeta.json 的內容檢查（runtime owner 保留 generation 相對路徑）：');
  time('讀 meta.json', () => JSON.parse(fs.readFileSync(metaPath, 'utf8')));
  const runtime = createMediaIntakeRuntime({ tempRoot: os.tmpdir() });
  const inspected = time('runtime.inspectCache（路徑解析與檔案證據）', () =>
    runtime.inspectCache(SRC).find(entry => entry.dir === sideDir));
  if (inspected?.error) console.log(`  索引不可用：${inspected.error}`);
  else {
    const files = inspected?.files || [];
    const missing = files.filter(entry => entry.state === 'missing').length;
    const unknown = files.filter(entry => entry.state === 'unknown').length;
    console.log(`  ${files.length} 個元件（缺 ${missing} 個，無法確認 ${unknown} 個）`);
  }

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
