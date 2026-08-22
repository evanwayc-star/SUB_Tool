/* ==============================================================================
   SUB Tool — 片段長度與淡入淡出視窗 (Clip Length & Fade Window Calculation)
   ==============================================================================
   【架構與職責】
   兩個行程（主行程 CommonJS 與渲染端 ES Module）共用的單一領域規則。
   
   【鐵律與不變量】
   - 預覽端：計算「當前時間格的不透明度與音量淡化」。
   - 匯出端：產生 FFmpeg 的 `fade` / `afade` 濾鏡參數。
   表達形式雖不同（數值計算 vs 濾鏡字串），但核心視窗規則必須絕對一致：
   1. 片段長度安全下限 0.001 秒：防止長度為 0 導致除以零（NaN/Infinity）或產生無效濾鏡。
   2. 淡入/淡出秒數：負數強制視為 0，且最大不得超過片段長度本身（避免淡入重疊或溢出）。
   ============================================================================== */

/**
 * 計算片段在時間軸上的有效持續時間（秒）。
 * 
 * 邊界防禦：
 * 設有安全下限 0.001 秒，避免 clip.in >= clip.out 或物件缺失時產生 0 或負長度。
 * 
 * @param {object} [clip] 片段物件
 * @param {number} [clip.in] 片段起點（秒）
 * @param {number} [clip.out] 片段終點（秒）
 * @returns {number} 片段有效持續秒數（至少 0.001）
 */
function clipLength(clip) {
  const outTime = Number(clip?.out);
  const inTime = Number(clip?.in);
  const safeOut = Number.isFinite(outTime) ? outTime : 0;
  const safeIn = Number.isFinite(inTime) ? inTime : 0;
  return Math.max(0.001, safeOut - safeIn);
}

/**
 * 計算片段生效的淡入與淡出時間視窗。
 * 
 * @param {object} [clip] 片段物件
 * @param {number} [clip.in] 片段起點（秒）
 * @param {number} [clip.out] 片段終點（秒）
 * @param {number} [clip.fadeIn] 使用者設定的淡入秒數
 * @param {number} [clip.fadeOut] 使用者設定的淡出秒數
 * @returns {{length: number, fadeIn: number, fadeOut: number, fadeOutStart: number}}
 *          - `length`: 片段總長（秒）
 *          - `fadeIn`: 限制在 [0, length] 內的有效淡入秒數
 *          - `fadeOut`: 限制在 [0, length] 內的有效淡出秒數
 *          - `fadeOutStart`: 片段本地時間軸上開始淡出的時間點（秒）
 */
function fadeWindow(clip) {
  const length = clipLength(clip);
  const rawFadeIn = Number(clip?.fadeIn);
  const rawFadeOut = Number(clip?.fadeOut);
  const safeFadeIn = Number.isFinite(rawFadeIn) ? rawFadeIn : 0;
  const safeFadeOut = Number.isFinite(rawFadeOut) ? rawFadeOut : 0;

  const fadeIn = Math.min(Math.max(0, safeFadeIn), length);
  const fadeOut = Math.min(Math.max(0, safeFadeOut), length);
  const fadeOutStart = Math.max(0, length - fadeOut);

  return { length, fadeIn, fadeOut, fadeOutStart };
}

module.exports = { clipLength, fadeWindow };
