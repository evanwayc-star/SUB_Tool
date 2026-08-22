/* ==============================================================================
   SUB Tool — 交付解析度與建議碼率 (Delivery Resolution & Bitrate Recommendation)
   ==============================================================================
   【架構與職責】
   兩個行程（主行程 CommonJS 與渲染端 ES Module）共用的單一領域規則。
   
   【鐵律與不變量】
   CONTEXT.md 定義：交付解析度 ＝ 一份交付實際寫進檔案的畫面尺寸。
   - 這裡實作「同比例等比縮放」：給定目標高度，依專案畫布的高寬比算出寬度。
   - 【偶數尺寸防護】：H.264 / H.265 的 YUV 4:2:0 色度子採樣要求寬度與高度必須為偶數，
     奇數寬度會導致 FFmpeg 編碼器直接報錯中斷。因此計算出之寬度必須向下對齊偶數。
   ============================================================================== */

/**
 * 依據專案畫布比例與目標高度，計算出合法的交付解析度（寬高皆為偶數）。
 * 
 * @param {object} [options]
 * @param {number} [options.canvasW=1920] 專案畫布寬度（像素）
 * @param {number} [options.canvasH=1080] 專案畫布高度（像素）
 * @param {number} [options.targetH] 目標高度（像素）；若為 0 或未提供則維持畫布尺寸
 * @param {boolean} [options.isWav=false] 是否為純音訊 WAV 匯出（WAV 無視訊軌，直接回傳畫布尺寸）
 * @returns {{w: number, h: number}} 交付解析度物件（寬度必定為偶數且大於等於 2）
 */
function deliveryResolution({ canvasW, canvasH, targetH, isWav } = {}) {
  const rawW = Number(canvasW);
  const rawH = Number(canvasH);
  const W = Number.isFinite(rawW) && rawW > 0 ? Math.floor(rawW) : 1920;
  const H = Number.isFinite(rawH) && rawH > 0 ? Math.floor(rawH) : 1080;

  const rawTargetH = Number(targetH);
  const validTarget = Number.isFinite(rawTargetH) && rawTargetH > 0;

  if (isWav || !validTarget) {
    // 確保即使畫布是奇數，交付時也安全修正為偶數
    const safeW = W - (W % 2);
    const safeH = H - (H % 2);
    return { w: Math.max(2, safeW), h: Math.max(2, safeH) };
  }

  const h = Math.floor(rawTargetH);
  let w = Math.round(h * (W / H));
  w -= (w % 2); // 確保 H.264/H.265 4:2:0 要求之偶數寬度

  return {
    w: Math.max(2, w),
    h: Math.max(2, h - (h % 2)),
  };
}

/**
 * 依據視訊解析度計算建議之視訊編碼碼率（kbps）。
 * 
 * 備註：
 * 換解析度時必須連動建議碼率，避免低解析度浪費空間或高解析度過度模糊。
 * 
 * @param {object} [resolution] 解析度物件
 * @param {number} [resolution.w] 視訊寬度
 * @param {number} [resolution.h] 視訊高度
 * @returns {number} 建議碼率（kbps，整數）
 */
function suggestKbps({ w, h } = {}) {
  const width = Math.max(0, Number(w) || 0);
  const height = Math.max(0, Number(h) || 0);
  return Math.max(0, Math.round((width * height * 30 * 0.1) / 1000));
}

module.exports = { deliveryResolution, suggestKbps };
