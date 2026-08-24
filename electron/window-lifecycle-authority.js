/* ==============================================================================
   SUB Tool — 桌面主視窗生命週期與設定權威 ("electron/window-lifecycle-authority.js")
   ==============================================================================
   【架構與職責】
   純領域 CommonJS 深層模組：負責視窗幾何邊界持久化 (Window Bounds Persistence)、
   螢幕可見區域保護 (Screen Boundary Clamping) 與關閉攔截決策計算。
   ============================================================================== */
'use strict';

/**
 * 校驗並限制視窗尺寸與座標，確保不會超出任何連接的螢幕顯示範圍。
 * 
 * @param {object} savedBounds 儲存的視窗幾何 { x, y, width, height }
 * @param {Array<object>} displays 所有顯示器工作區域清單 [{ workArea: { x, y, width, height } }]
 * @param {object} [fallback={ width: 1280, height: 800 }] 預設尺寸
 * @returns {object} 安全可用的視窗幾何
 */
function sanitizeWindowBounds(savedBounds, displays = [], fallback = { width: 1280, height: 800 }) {
  if (!savedBounds || typeof savedBounds !== 'object') {
    return { width: fallback.width, height: fallback.height };
  }

  const w = Math.max(800, Number(savedBounds.width) || fallback.width);
  const h = Math.max(600, Number(savedBounds.height) || fallback.height);
  const x = Number.isFinite(savedBounds.x) ? savedBounds.x : null;
  const y = Number.isFinite(savedBounds.y) ? savedBounds.y : null;

  if (x == null || y == null || !Array.isArray(displays) || !displays.length) {
    return { width: w, height: h };
  }

  // 檢查是否落在任一螢幕的可見區域內
  const isVisible = displays.some(d => {
    const area = d?.workArea;
    if (!area) return false;
    return (
      x >= area.x - 50 &&
      x + w <= area.x + area.width + 50 &&
      y >= area.y - 50 &&
      y + h <= area.y + area.height + 50
    );
  });

  if (!isVisible) {
    return { width: w, height: h };
  }

  return { x, y, width: w, height: h };
}

/**
 * 判定主視窗關閉時應採取的動作（隱藏至背景、打開監控視窗或提示警告）。
 * 
 * @param {number} liveExportCount 進行中或暫停中的轉檔工作數
 * @param {boolean} isQuitting 是否為應用程式全域退出 (app.quit)
 * @returns {'quit'|'prompt_running_jobs'|'hide_to_tray_or_queue'} 決策動作
 */
function decideWindowCloseAction(liveExportCount = 0, isQuitting = false) {
  if (isQuitting) return 'quit';
  if (liveExportCount > 0) {
    return 'prompt_running_jobs';
  }
  return 'quit';
}

module.exports = {
  sanitizeWindowBounds,
  decideWindowCloseAction,
};
