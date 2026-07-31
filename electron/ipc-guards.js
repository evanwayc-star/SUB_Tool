/* ==============================================================================
   SUB Tool — IPC 輸入守衛（主程序）
   ==============================================================================

   handler 收到 renderer 傳來的路徑／格式後，送進真正動作（讀檔、開檔、燒錄）
   之前要先問過的守衛。抽成獨立模組是為了讓 tests/fileAuthority.test.js 能夠
   真的呼叫它們、餵真的授權狀態、斷言真的丟不丟例外——而不是用正規表示式
   掃 main.js 的原始碼字面（「有沒有寫這幾個字」證明不了「這段程式碼真的會執行到」，
   見 docs/開發與驗證.md §3 第三例）。

   main.js 本身沒辦法被 vitest import（模組頂層就呼叫 electron 的 app／ipcMain），
   所以只把「檔案存不存在授權」這個純判斷抽出來，繼續留在 main.js 裡的是
   ipcMain.handle 的接線——那一部分沒有變。 */

/** @param {import('./file-authority').FileAuthority} fileAuthority */
function createIpcGuards(fileAuthority) {
  function requireReadablePath(operation, file) {
    if (fileAuthority.canRead(file)) return;
    console.warn(`[sec] ${operation} blocked (unauthorized path):`, file);
    const error = new Error('未授權存取此檔案');
    error.code = 'UNAUTHORIZED_PATH';
    throw error;
  }

  function requirePermittedShellOpenPath(file) {
    if (fileAuthority.canOpenQueueLog(file)) return;
    console.warn('[sec] app:openPath blocked (unauthorized log):', file);
    const error = new Error('未授權開啟此檔案');
    error.code = 'UNAUTHORIZED_PATH';
    throw error;
  }

  function requirePermittedDeliveryRevealPath(file) {
    if (fileAuthority.canRevealDeliveryOutput(file)) return;
    console.warn('[sec] app:showItemInFolder blocked (unauthorized delivery):', file);
    const error = new Error('未授權顯示此交付檔案');
    error.code = 'UNAUTHORIZED_OUTPUT_PATH';
    throw error;
  }

  return { requireReadablePath, requirePermittedShellOpenPath, requirePermittedDeliveryRevealPath };
}

/* 與 fileAuthority 無關的純格式驗證，放在同一支模組是因為它守的是同一類東西
   （IPC 輸入在動手前的驗證），不需要另開一支只有一個函式的檔案。 */
function expectedExportExtension(format) {
  if (format === 'wav') return 'wav';
  if (format === 'prores') return 'mov';
  if (format === 'h264') return 'mp4';
  const error = new Error(`不支援的匯出格式：${format || '(empty)'}`);
  error.code = 'INVALID_EXPORT_FORMAT';
  throw error;
}

module.exports = { createIpcGuards, expectedExportExtension };
