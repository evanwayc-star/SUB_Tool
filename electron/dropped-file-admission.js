/* ==============================================================================
   SUB Tool — 拖放媒體檔案授權准入 (Dropped Media File Admission)
   ==============================================================================
   【架構與職責】
   處理使用者從作業系統直接拖放至視窗的單一媒體檔案授權。
   
   【安全鐵律】
   專案檔 (.subtool / .json) 嚴格禁止經由拖放媒體流程授權，專案必須透過專門的
   trusted-project-intake 流程，避免意外將專案檔當成一般視訊素材載入。
   ============================================================================== */
'use strict';

const path = require('path');
const { PROJECT_FILE } = require('./file-authority');

/**
 * 檢查路徑是否為專案檔 (.subtool 或 .json)。
 * @param {string} filePath 檔案路徑
 * @returns {boolean}
 */
function isProjectFilePath(filePath) {
  return typeof filePath === 'string' && PROJECT_FILE.test(filePath);
}

/**
 * 授權使用者拖放的非專案媒體檔案。
 * 
 * @param {string} filePath 拖放檔案路徑
 * @param {object} [options]
 * @param {Function} options.grantRead 授予讀取能力函式
 * @param {Function} [options.grantScreenshotDirectory] 授予截圖目錄函式
 * @param {object} [options.pathModule=path] 路徑模組注入
 * @returns {string|null} 授權成功回傳標準化路徑，否則回傳 null
 */
function authorizeDroppedMediaPath(filePath, {
  grantRead,
  grantScreenshotDirectory,
  pathModule = path,
} = {}) {
  if (typeof filePath !== 'string' || !filePath || isProjectFilePath(filePath)) {
    return null;
  }
  if (typeof grantRead !== 'function' || !grantRead(filePath)) {
    return null;
  }
  if (typeof grantScreenshotDirectory === 'function') {
    grantScreenshotDirectory(pathModule.dirname(filePath));
  }
  return filePath;
}

module.exports = { authorizeDroppedMediaPath };
