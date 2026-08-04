/* ==============================================================================
   SUB Tool — 片段長度與淡入淡出視窗（兩個行程共用的唯一一份）
   ==============================================================================

   預覽端要算「這一格的不透明度」，匯出端要產生 ffmpeg 的 `fade` / `afade` 參數。
   兩者的表達不同（一個是數值、一個是濾鏡字串），但**視窗的規則必須同一份**：
     - 片段長度下限 0.001：長度 0 會讓淡入比例除以零，ffmpeg 那邊則產生 d=0 的
       fade（等同沒有淡入，但不會報錯）。兩邊夾同一個下限才不會一邊有淡一邊沒有。
     - 淡入／淡出秒數：負數視為 0，且不得超過片段長度
       （淡入 3 秒放在 1 秒長的片段上，實際只能淡 1 秒）。

   v6.1.2 之前 `electron/export-plan.js` 把 `Math.max(0.001, c.out - c.in)` 內聯了
   三處、把 `Math.min(fade, length)` 的夾擠又各寫一次，靠
   `tests/clipFadeContract.test.js` 比對兩側。現在規則只有這一份。
============================================================================== */

/** 片段在時間軸上的長度（下限 0.001，見檔頭）。 */
function clipLength(clip) {
  return Math.max(0.001, (+clip.out || 0) - (+clip.in || 0));
}

/**
 * 生效的淡入／淡出視窗。
 * @returns {{length:number, fadeIn:number, fadeOut:number, fadeOutStart:number}}
 *          fadeOutStart＝片段內開始淡出的本地時間
 */
function fadeWindow(clip) {
  const length = clipLength(clip);
  const fadeIn = Math.min(Math.max(0, +clip.fadeIn || 0), length);
  const fadeOut = Math.min(Math.max(0, +clip.fadeOut || 0), length);
  return { length, fadeIn, fadeOut, fadeOutStart: Math.max(0, length - fadeOut) };
}

module.exports = { clipLength, fadeWindow };
