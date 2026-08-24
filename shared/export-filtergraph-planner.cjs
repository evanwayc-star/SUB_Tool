/* ==============================================================================
   SUB Tool — 匯出濾鏡圖與解析度調度核心 ("shared/export-filtergraph-planner.cjs")
   ==============================================================================
   【架構與職責】
   純領域 CommonJS 零相依深層模組：負責 ffmpeg 視訊縮放 (Scale/Pad)、圖片疊層、
   ASS 字幕燒錄 (subtitles filter) 與 Windows 路徑雙層跳脫（§0.4）。
   ============================================================================== */
'use strict';

/**
 * 對 Windows 路徑進行 libavfilter 雙層跳脫（鐵律 §0.4）。
 * 冒號與反斜線在 ffmpeg subtitles filter 中必須跳脫為 `C\\:/path`。
 * 
 * @param {string} filePath 原始路徑
 * @returns {string} 跳脫後的 filtergraph 路徑
 */
function escapeFfmpegFilterPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return '';
  // 先將所有反斜線轉為正斜線
  let normalized = filePath.replace(/\\/g, '/');
  // 將冒號 `C:` 跳脫為 `C\\:`
  normalized = normalized.replace(/:/g, '\\\\:');
  // 跳脫單引號與特殊字元
  normalized = normalized.replace(/'/g, "'\\\\''");
  return normalized;
}

/**
 * 建立 ASS 字幕燒錄的 filtergraph 字串。
 * 
 * @param {string} assFilePath ASS 檔案路徑
 * @param {string} [fontsDir] 自訂字型目錄路徑
 * @returns {string} subtitles filter 字串
 */
function buildSubtitlesFilter(assFilePath, fontsDir = null) {
  const escapedPath = escapeFfmpegFilterPath(assFilePath);
  if (!fontsDir) {
    return `subtitles='${escapedPath}'`;
  }
  const escapedFonts = escapeFfmpegFilterPath(fontsDir);
  return `subtitles='${escapedPath}':fontsdir='${escapedFonts}'`;
}

/**
 * 計算視訊縮放與留黑邊 (Letterbox / Pillarbox) 的 scale & pad filter。
 * 
 * @param {number} srcW 來源寬度
 * @param {number} srcH 來源高度
 * @param {number} targetW 目標寬度 (如 1920)
 * @param {number} targetH 目標高度 (如 1080)
 * @returns {string} ffmpeg scale/pad filter 字串
 */
function buildScaleAndPadFilter(srcW, srcH, targetW = 1920, targetH = 1080) {
  const sw = Math.max(1, Number(srcW) || 1920);
  const sh = Math.max(1, Number(srcH) || 1080);
  const tw = Math.max(1, Number(targetW) || 1920);
  const th = Math.max(1, Number(targetH) || 1080);

  if (sw === tw && sh === th) {
    return 'null';
  }

  return `scale=${tw}:${th}:force_original_aspect_ratio=decrease,pad=${tw}:${th}:(ow-ih)/2:(oh-ih)/2`;
}

module.exports = {
  escapeFfmpegFilterPath,
  buildSubtitlesFilter,
  buildScaleAndPadFilter,
};
