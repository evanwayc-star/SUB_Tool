/* ==============================================================================
   SUB Tool — 視訊匯出能力與環境判定 (Video Export Capability)
   ==============================================================================
   【架構與職責】
   判定當前執行環境（Electron 桌面版 vs 純網頁版）是否具備視訊與多聲道 WAV 交付能力。
   ============================================================================== */

/** 網頁版不支援視訊匯出時的繁體中文提示訊息 */
const WEB_VIDEO_EXPORT_MESSAGE = '網頁版不支援影片／多聲道 WAV 交付，請使用 Electron 桌面版';

/**
 * 檢查當前平台是否具備視訊交付匯出能力。
 * 
 * @param {boolean} isDesktop 是否為桌面版環境 (IS_DESKTOP)
 * @returns {{supported: boolean, message: string}} 能力判定結果
 */
export function videoExportCapability(isDesktop) {
  return isDesktop
    ? Object.freeze({ supported: true, message: '' })
    : Object.freeze({ supported: false, message: WEB_VIDEO_EXPORT_MESSAGE });
}

/**
 * 執行開啟視訊匯出對話框之命令（若在非桌面版環境則發送 toast 提示並中斷）。
 * 
 * @param {object} options
 * @param {boolean} options.isDesktop 是否為桌面版環境
 * @param {Function} options.openExport 開啟匯出面板之非同步函式
 * @param {Function} [options.notify] 提示訊息回呼
 * @param {Function} [options.reportError] 例外捕捉回呼
 * @returns {Promise<boolean>} 是否成功啟動
 */
export async function runVideoExportCommand({
  isDesktop,
  openExport,
  notify = () => {},
  reportError = () => {},
} = {}) {
  const capability = videoExportCapability(isDesktop);
  if (!capability.supported) {
    notify(capability.message);
    return false;
  }
  try {
    if (typeof openExport === 'function') {
      await openExport();
    }
    return true;
  } catch (error) {
    reportError(error);
    return false;
  }
}

export { WEB_VIDEO_EXPORT_MESSAGE };
