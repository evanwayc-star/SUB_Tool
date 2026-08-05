/* ==============================================================================
   SUB Tool — 交付解析度與建議碼率（兩個行程共用的唯一一份）
   ==============================================================================

   CONTEXT.md：**交付解析度**＝一份交付實際寫進檔案的畫面尺寸。
   與專案畫布同比例時純粹是等比縮放；改變比例則牽涉裁切或黑邊，是另一件事。

   這裡只做「同比例縮放」：給定目標高度，依專案畫布的比例算出寬度。
   寬度取偶數——H.264 的 4:2:0 色度取樣要求寬高皆為偶數，奇數寬會讓 ffmpeg 直接失敗。

   【為什麼要進 shared/】
   規則原本只在 `src/delivery-list.js`（renderer ESM）。v6.1.5 起匯出佇列監控
   也要能改已入列工作的解析度，而那個視窗與主行程都拿不到 renderer 的模組。
   複製一份到主行程正是本專案一再踩到的坑（見 shared/README.md），所以移到這裡。
============================================================================== */

/**
 * 目標高度 → 交付解析度。
 * @param {number} canvasW 專案畫布寬
 * @param {number} canvasH 專案畫布高
 * @param {number} targetH 目標高度；0／未給＝維持來源解析度
 * @param {boolean} isWav WAV 沒有視訊，直接回畫布尺寸（呼叫端不會用到）
 */
function deliveryResolution({ canvasW, canvasH, targetH, isWav } = {}) {
  const W = canvasW || 1920, H = canvasH || 1080;
  if (isWav || !(targetH > 0)) return { w: W, h: H };
  const h = targetH;
  let w = Math.round(h * (W / H));
  w -= (w % 2); // H.264 4:2:0 要求偶數寬
  return { w, h };
}

/* 依解析度給的建議碼率（kbps）。

   換解析度時要一起換碼率：1080p 的碼率套在 720p 上是浪費，套在 4K 上則會糊掉
   ——v4.32 使用者回報「輸出像 proxy」就是這個成因。 */
function suggestKbps({ w, h } = {}) {
  return Math.round(((w || 0) * (h || 0) * 30 * 0.1) / 1000);
}

module.exports = { deliveryResolution, suggestKbps };
