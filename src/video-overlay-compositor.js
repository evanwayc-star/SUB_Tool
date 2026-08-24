/* ==============================================================================
   SUB Tool — 視訊疊層排版與安全框合成核心 ("src/video-overlay-compositor.js")
   ==============================================================================
   【架構與職責】
   純領域計算深層模組：負責字幕 HTML/CSS 疊層樣式計算、安全框 (Safe Frame 80/90/100%)
   邊界座標換算與時間碼浮水印格式化，確保三路一致性（§0.1、§0.2）。
   ============================================================================== */

/**
 * 依據專案畫布與視窗高寬比計算預覽畫布縮放比例與位置偏移。
 * 
 * @param {number} containerW 容器寬度
 * @param {number} containerH 容器高度
 * @param {number} canvasW 專案畫布寬度 (例如 1920)
 * @param {number} canvasH 專案畫布高度 (例如 1080)
 * @returns {{width: number, height: number, left: number, top: number, scale: number}} 變換矩陣
 */
export function computePreviewViewport(containerW, containerH, canvasW = 1920, canvasH = 1080) {
  const cw = Math.max(1, Number(containerW) || 1920);
  const ch = Math.max(1, Number(containerH) || 1080);
  const pw = Math.max(1, Number(canvasW) || 1920);
  const ph = Math.max(1, Number(canvasH) || 1080);

  const scale = Math.min(cw / pw, ch / ph);
  const width = Math.round(pw * scale);
  const height = Math.round(ph * scale);
  const left = Math.round((cw - width) / 2);
  const top = Math.round((ch - height) / 2);

  return { width, height, left, top, scale };
}

/**
 * 計算各級安全框 (Action / Title Safe Frame) 的像素邊界。
 * 
 * @param {number} previewW 預覽畫面寬度
 * @param {number} previewH 預覽畫面高度
 * @returns {{safe90: object, safe80: object}} 90% 與 80% 安全框幾何
 */
export function computeSafeFrameBounds(previewW, previewH) {
  const w = Math.max(0, Number(previewW) || 0);
  const h = Math.max(0, Number(previewH) || 0);

  const safe90 = {
    x: Math.round(w * 0.05),
    y: Math.round(h * 0.05),
    w: Math.round(w * 0.9),
    h: Math.round(h * 0.9),
  };

  const safe80 = {
    x: Math.round(w * 0.1),
    y: Math.round(h * 0.1),
    w: Math.round(w * 0.8),
    h: Math.round(h * 0.8),
  };

  return { safe90, safe80 };
}

/**
 * 字級縮放計算（嚴格遵守鐵律 §0.2：基準為畫面高 ÷ PlayResY）。
 * 
 * @param {number} baseFontSize ASS 設定字級 (px)
 * @param {number} previewH 當前預覽畫面高度 (px)
 * @param {number} [playResY=1080] 字幕畫布高度 (固定 1080)
 * @returns {number} 縮放後的實際顯示字級 (px)
 */
export function computeScaledFontSize(baseFontSize, previewH, playResY = 1080) {
  const size = Math.max(1, Number(baseFontSize) || 60);
  const h = Math.max(1, Number(previewH) || 1080);
  const resY = Math.max(1, Number(playResY) || 1080);

  const scaled = size * (h / resY);
  return Number(scaled.toFixed(2));
}
