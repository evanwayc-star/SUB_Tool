/* ==============================================================================
   SUB Tool — 交付解析度與建議碼率 (Delivery Resolution & Bitrate Recommendation)
   ==============================================================================
   【架構與職責】
   兩個行程（主行程 CommonJS 與渲染端 ES Module）共用的單一領域規則。
   
   【鐵律與不變量】
   CONTEXT.md 定義：交付解析度 ＝ 一份交付實際寫進檔案的畫面尺寸。
   - 高度預設依專案比例推導寬度；自訂寬高直接指定交付幀的像素尺寸。
   - 【偶數尺寸防護】：H.264 / H.265 的 YUV 4:2:0 色度子採樣要求寬度與高度必須為偶數，
     奇數寬度會導致 FFmpeg 編碼器直接報錯中斷。因此計算出之寬度必須向下對齊偶數。
   ============================================================================== */

// 自訂交付幀的編碼／合成上限，支援橫式與直式 8K。
function validCustomDeliverySize(width, height) {
  return [width, height].every(n => Number.isSafeInteger(n) && n >= 16 && n <= 8192 && n % 2 === 0)
    && width * height <= 8192 * 4320;
}

function normalizeTargetHeight(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const h = Math.floor(n);
  return Math.max(2, h - (h % 2));
}

/**
 * 取得自訂交付寬高，或依專案畫布比例與目標高度計算交付解析度。
 *
 * @param {object} [options]
 * @param {number} [options.canvasW=1920] 專案畫布寬度（像素）
 * @param {number} [options.canvasH=1080] 專案畫布高度（像素）
 * @param {number} [options.targetW] 自訂交付寬度；搭配 targetH 指定實際成品尺寸
 * @param {number} [options.targetH] 目標高度（像素）；若為 0 或未提供則維持畫布尺寸
 * @param {boolean} [options.isWav=false] 是否為純音訊 WAV 匯出（WAV 無視訊軌，直接回傳畫布尺寸）
 * @returns {{w: number, h: number}} 交付解析度物件（寬高必定為偶數且大於等於 2）
 */
function deliveryResolution({ canvasW, canvasH, targetW, targetH, isWav } = {}) {
  if (!isWav && targetW != null) {
    if (!validCustomDeliverySize(targetW, targetH)) {
      throw new Error('自訂寬度與高度須為 16 至 8192 的偶數，總像素不可超過 8192 × 4320');
    }
    return { w: targetW, h: targetH };
  }
  const rawW = Number(canvasW);
  const rawH = Number(canvasH);
  const W = Number.isFinite(rawW) && rawW > 0 ? Math.floor(rawW) : 1920;
  const H = Number.isFinite(rawH) && rawH > 0 ? Math.floor(rawH) : 1080;

  const h = normalizeTargetHeight(targetH);

  if (isWav || !h) {
    // 確保即使畫布是奇數，交付時也安全修正為偶數
    const safeW = W - (W % 2);
    const safeH = H - (H % 2);
    return { w: Math.max(2, safeW), h: Math.max(2, safeH) };
  }

  // 寬度必須使用實際輸出高度；奇數高度會先向下對齊，否則畫面會被拉伸。
  let w = Math.round(h * (W / H));
  w -= (w % 2); // 確保 H.264/H.265 4:2:0 要求之偶數寬度

  return {
    w: Math.max(2, w),
    h,
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

// 交付清單建立工作與佇列修改工作共用同一份規格派生。呼叫端保留各自的
// 時間碼來源：新工作以輸出 FPS 換算，已入列工作使用送出時凍結的起點。
function deriveDeliverySpec({ format, preset = null, canvasW, canvasH, targetW, targetH = 0,
  projectFps, bdMode = null,
  fps, videoKbps = 0, previousWidth, previousHeight, kbpsOverride, resetVideoBitrate = false,
  burnTimecode = false, timecodeStart = null } = {}) {
  const audioOnly = format === 'wav' || format === 'mp3';
  if (format === 'bd-iso' && (!bdMode || Math.abs(bdMode.fps - Number(fps)) > 0.001
      || (Number.isFinite(Number(projectFps)) && bdMode.fps + 0.001 < Number(projectFps)))) {
    throw new Error('BD 輸出影格率必須是支援的光碟格式，且不得低於專案 FPS');
  }
  const fixed = bdMode || preset;
  const height = fixed?.height || normalizeTargetHeight(targetH);
  const { w, h } = fixed
    ? { w: fixed.width, h: fixed.height }
    : deliveryResolution({ canvasW, canvasH, targetW, targetH, isWav: audioOnly });
  let kbps = preset ? preset.videoKbps : (resetVideoBitrate ? 0 : Number(videoKbps) || 0);
  if (format === 'h264') {
    if (kbpsOverride != null) kbps = Math.max(1, Math.floor(Number(kbpsOverride) || 0));
    else if (resetVideoBitrate || kbps <= 0 || (previousWidth != null && previousHeight != null
      && (w !== Number(previousWidth) || h !== Number(previousHeight)))) kbps = suggestKbps({ w, h });
  }
  if (!audioOnly && burnTimecode && !timecodeStart) {
    throw new Error('這份工作沒有記錄時間軸起點，無法補上燒入 TC；請重新從交付清單送出');
  }
  return {
    width: w, height: h, targetH: height,
    ...(!fixed && !audioOnly && targetW ? { targetW: w } : {}),
    fps: bdMode?.fps || preset?.fps || fps,
    videoKbps: format === 'mp3' ? null : kbps,
    timecodeWatermark: !audioOnly && burnTimecode ? { start: timecodeStart } : null,
  };
}

// While typing a custom width/height, the draft can be incomplete. Preserve
// that state so the estimate can clear without interrupting the input field.
function deliveryEstimateDimensions({ format, canvasW, canvasH, targetW, targetH, videoKbps }) {
  if (targetW != null && !validCustomDeliverySize(targetW, targetH)) return { width: null, height: null };
  const size = deliveryResolution({ canvasW, canvasH, targetW, targetH });
  return { width: size.w, height: size.h, videoKbps: format === 'h264' && !(videoKbps > 0) ? suggestKbps(size) : videoKbps };
}

module.exports = { deliveryResolution, suggestKbps, deriveDeliverySpec, normalizeTargetHeight, validCustomDeliverySize, deliveryEstimateDimensions };
