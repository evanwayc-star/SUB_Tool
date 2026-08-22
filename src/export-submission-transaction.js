/* ==============================================================================
   SUB Tool — 交付工作送交事務交易 (Export Submission Transaction Boundary)
   ==============================================================================
   【架構與職責】
   使用者點擊「開始匯出」或「加入佇列」時的事務邊界：
   1. 同步快照（Capture）：在進入任何 async/await 或衝突檢查前，立刻同步凍結專案與交付設定快照。
   2. 驗證與衝突檢核：在此凍結快照上進行時碼驗證與同路徑衝突檢查。
   3. 派發送交（Dispatch）：送入主行程 IPC 啟動轉檔。
   ============================================================================== */

/**
 * 執行凍結狀態的匯出送交事務流程。
 * 
 * @param {object} options
 * @param {Function} options.capture 同步擷取當前匯出快照函式
 * @param {Function} [options.validate] 驗證快照有效性函式（若有錯回傳錯誤字串）
 * @param {Function} [options.checkConflicts] 檢查路徑衝突之非同步函式
 * @param {Function} options.dispatch 送交主行程之非同步函式
 * @returns {Promise<{status: 'invalid'|'cancelled'|'submitted', reason?: string, value?: any}>} 事務結果
 */
export async function runFrozenExportSubmission({
  capture,
  validate = () => null,
  checkConflicts = () => true,
  dispatch,
} = {}) {
  if (typeof capture !== 'function' || typeof dispatch !== 'function') {
    throw new TypeError('capture and dispatch are required');
  }

  const frozen = capture();
  if (!frozen) {
    return { status: 'invalid', reason: '目前沒有可匯出的影片或外部音訊' };
  }

  const invalidReason = validate(frozen);
  if (invalidReason) {
    return { status: 'invalid', reason: invalidReason };
  }

  if (!(await checkConflicts(frozen))) {
    return { status: 'cancelled' };
  }

  return { status: 'submitted', value: await dispatch(frozen) };
}
