/* ==============================================================================
   SUB Tool — IPC 輸入能力守衛 (IPC Input Capability Guards)
   ==============================================================================
   【架構與職責】
   主行程接收到渲染端（Renderer）傳入之路徑、檔案或匯出格式時，在執行具體動作
   （讀檔、開檔、外殼喚起、寫入匯出）前強制通過的權限與格式校驗。
   
   【安全性與設計原因】
   Renderer 傳來的路徑僅代表「外部請求」，不可直接作為執行參數。
   抽離成獨立模組使 `tests/fileAuthority.test.js` 與 `tests/ipcGuards.test.js`
   能對真實授權狀態進行單元驗證，而非僅靠靜態字面掃描。
   ============================================================================== */

/**
 * 建立 IPC 呼叫的檔案存取守衛集合。
 * 
 * @param {import('./file-authority').FileAuthority} fileAuthority 檔案能力權威管理實例
 * @returns {{
 *   requireReadablePath: (operation: string, file: string) => void,
 *   requirePermittedShellOpenPath: (file: string) => void,
 *   requirePermittedDeliveryRevealPath: (file: string) => void,
 *   requirePermittedSourceRevealPath: (file: string) => void
 * }} 守衛檢查函式物件
 */
function createIpcGuards(fileAuthority) {
  /**
   * 驗證路徑是否具備可讀取能力（例如載入媒體、專案檔、讀取 Base64）。
   * 若未授權則記錄警告並拋出 UNAUTHORIZED_PATH 例外。
   * 
   * @param {string} operation 操作識別名稱（用於紀錄 log）
   * @param {string} file 請求存取的檔案路徑
   * @throws {Error} 若未授權存取
   */
  function requireReadablePath(operation, file) {
    if (fileAuthority && typeof fileAuthority.canRead === 'function' && fileAuthority.canRead(file)) {
      return;
    }
    console.warn(`[sec] ${operation} blocked (unauthorized path):`, file);
    const error = new Error('未授權存取此檔案');
    error.code = 'UNAUTHORIZED_PATH';
    throw error;
  }

  /**
   * 驗證路徑是否允許由作業系統 Shell 開啟（限制僅限失敗佇列的 .log 記錄檔）。
   * 
   * @param {string} file 請求開啟的記錄檔路徑
   * @throws {Error} 若未獲授權
   */
  function requirePermittedShellOpenPath(file) {
    if (fileAuthority && typeof fileAuthority.canOpenQueueLog === 'function' && fileAuthority.canOpenQueueLog(file)) {
      return;
    }
    console.warn('[sec] app:openPath blocked (unauthorized log):', file);
    const error = new Error('未授權開啟此檔案');
    error.code = 'UNAUTHORIZED_PATH';
    throw error;
  }

  /**
   * 驗證路徑是否允許在檔案總管/Finder 中定位顯示（僅限正式交付輸出的完成檔案）。
   * 
   * @param {string} file 交付產物路徑
   * @throws {Error} 若未獲授權
   */
  function requirePermittedDeliveryRevealPath(file) {
    if (fileAuthority && typeof fileAuthority.canRevealDeliveryOutput === 'function' && fileAuthority.canRevealDeliveryOutput(file)) {
      return;
    }
    console.warn('[sec] app:showItemInFolder blocked (unauthorized delivery):', file);
    const error = new Error('未授權顯示此交付檔案');
    error.code = 'UNAUTHORIZED_OUTPUT_PATH';
    throw error;
  }

  /**
   * 驗證路徑是否允許在檔案總管中顯示來源素材。
   * 
   * @param {string} file 來源素材路徑
   * @throws {Error} 若未獲授權
   */
  function requirePermittedSourceRevealPath(file) {
    if (fileAuthority && typeof fileAuthority.canRead === 'function' && fileAuthority.canRead(file)) {
      return;
    }
    console.warn('[sec] app:showSourceInFolder blocked (unauthorized source):', file);
    const error = new Error('未授權顯示此來源檔案');
    error.code = 'UNAUTHORIZED_SOURCE_PATH';
    throw error;
  }

  return {
    requireReadablePath,
    requirePermittedShellOpenPath,
    requirePermittedDeliveryRevealPath,
    requirePermittedSourceRevealPath,
  };
}

/**
 * 驗證並取得匯出格式所預期的副檔名（不含小數點）。
 * 
 * 支援格式：
 * - `wav` -> `wav`
 * - `prores` -> `mov`
 * - `h264` -> `mp4`
 * 
 * @param {string} format 請求之匯出格式識別字串
 * @returns {string} 預期的副檔名
 * @throws {Error} 若為未支援的匯出格式
 */
function expectedExportExtension(format) {
  const fmt = typeof format === 'string' ? format.trim().toLowerCase() : '';
  if (fmt === 'wav') return 'wav';
  if (fmt === 'prores') return 'mov';
  if (fmt === 'h264') return 'mp4';
  const error = new Error(`不支援的匯出格式：${format || '(empty)'}`);
  error.code = 'INVALID_EXPORT_FORMAT';
  throw error;
}

module.exports = { createIpcGuards, expectedExportExtension };
