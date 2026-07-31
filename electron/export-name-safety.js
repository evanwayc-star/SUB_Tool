/* ==============================================================================
   SUB Tool — 匯出檔名淨化與圍堵（主程序側，第二道防線）
   ==============================================================================

   renderer 端（`src/export-name-safety.js`）已經淨化過一次；這裡不是信任它，
   是再驗證一次最終路徑真的落在使用者選定的資料夾內——`path.join`／`path.resolve`
   會把 `"../"` 正規化掉，只靠呼叫端把關等於沒有把關。

   兩邊各自維護一份規則（不同行程、不同模組系統，無法合併成一份實作），
   由 `tests/exportNameSafetyContract.test.js` 矩陣窮舉比對，任一邊漂掉就紅。
============================================================================== */
const path = require('path');

/** 拆解後的路徑是否真的落在 root 底下（不含 root 本身之外的旁支）。 */
function isPathContained(root, name) {
  const r = path.resolve(root);
  const full = path.resolve(r, name);
  return full === r || full.startsWith(r + path.sep);
}

module.exports = { isPathContained };
