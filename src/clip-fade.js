/* ==============================================================================
   SUB Tool — 片段淡入淡出（Clip Fade）
   ==============================================================================

   片段的長度與淡入淡出視窗。**預覽與匯出必須用同一組數字**，否則畫面在
   預覽裡淡完了、匯出卻還沒淡完（或反過來），而且完全不會報錯。

   【為什麼獨立成一支】
   同一組計算原本散在三個地方：
     src/app.js              renderImageOverlays() 的 alpha 疊乘
     electron/export-plan.js 影像 `fade=t=in/out:...:alpha=1`
     electron/export-plan.js 音訊 `afade=t=in/out:...`
   三份都寫著 `Math.max(0.001, c.out - c.in)`，改一份不會讓另外兩份紅。

   【跨行程的接縫】
   electron/ 是主程序（CommonJS），不能 import 這裡。所以這支模組不是
   「唯一實作」，而是「唯一的規格」——匯出側各自套用在自己的 filtergraph 上，
   由 tests/clipFadeContract.test.js 以矩陣窮舉比對兩邊，任一邊漂掉就紅。
   這與 imagegeom.js ↔ export-plan.js 的作法相同（見 imageGeomContract）。
============================================================================== */

/* 片段在時間軸上的長度。下限 0.001 是刻意的：長度為 0 的片段會讓
   淡入比例變成除以零，ffmpeg 那邊則會產生 d=0 的 fade（等同沒有淡入，
   但不會報錯）。兩邊都夾同一個下限才不會一邊有淡、一邊沒有。 */
export function clipLength(clip) {
  return Math.max(0.001, (+clip.out || 0) - (+clip.in || 0));
}

/* 生效的淡入／淡出秒數：負數視為 0，且不得超過片段長度
   （淡入 3 秒放在 1 秒長的片段上，實際只能淡 1 秒）。 */
export function fadeWindow(clip) {
  const length = clipLength(clip);
  const fadeIn = Math.min(Math.max(0, +clip.fadeIn || 0), length);
  const fadeOut = Math.min(Math.max(0, +clip.fadeOut || 0), length);
  return { length, fadeIn, fadeOut, fadeOutStart: Math.max(0, length - fadeOut) };
}

/**
 * 片段在「片段內本地時間」的不透明度倍率（0–1）。
 *
 * 線性斜坡，與 ffmpeg `fade` 濾鏡的預設曲線一致。
 * 回傳的是**倍率**，呼叫端自行乘上軌道透明度等其他因素。
 *
 * @param {object} clip     片段（要有 in／out／fadeIn／fadeOut）
 * @param {number} localTime 片段內時間（＝時間軸時間 − clip.offset）
 */
export function fadeAlphaAt(clip, localTime) {
  const { length, fadeIn, fadeOut, fadeOutStart } = fadeWindow(clip);
  const t = +localTime || 0;
  if (t < 0 || t > length) return 0;
  let a = 1;
  if (fadeIn > 0 && t < fadeIn) a *= t / fadeIn;
  if (fadeOut > 0 && t > fadeOutStart) a *= (length - t) / fadeOut;
  return Math.max(0, Math.min(1, a));
}
