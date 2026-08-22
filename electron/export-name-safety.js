/* ==============================================================================
   SUB Tool — 匯出路徑圍堵防線 (Export Path Containment Guard)
   ==============================================================================
   【架構與職責】
   主行程側的第二道安全防線：驗證解析後的最終檔案路徑是否確實包含於使用者指定的目錄內。
   
   【安全鐵律】
   渲染端雖然已對資料夾與檔名進行淨化，但主程序不能盲目信任。
   透過 `path.resolve` 確保路徑中未包含跨越父層目錄的符號（例如 `../`），
   徹底防禦路徑穿越（Path Traversal）漏洞。
   ============================================================================== */
'use strict';

const path = require('path');

/**
 * 檢查指定的子路徑或檔名在解析後是否嚴格位於根目錄範圍之內。
 * 
 * @param {string} root 使用者選擇的輸出根目錄絕對路徑
 * @param {string} name 欲輸出的相對路徑或檔名
 * @returns {boolean} 若完整路徑落在 root 目錄內（或剛好為 root）則回傳 true，否則回傳 false
 */
function isPathContained(root, name) {
  if (typeof root !== 'string' || !root || typeof name !== 'string') {
    return false;
  }
  const r = path.resolve(root);
  const full = path.resolve(r, name);
  return full === r || full.startsWith(r + path.sep);
}

module.exports = { isPathContained };
