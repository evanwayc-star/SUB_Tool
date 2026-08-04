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

/* clipLength 與 fadeWindow 的規則住在 `shared/clip-fade.cjs`——匯出端（主程序、
   CommonJS）吃的是同一份。v6.1.2 之前 electron/export-plan.js 把長度下限內聯了
   三處、淡入淡出的夾擠又各寫一次。 */
import { clipLength, fadeWindow } from '../shared/clip-fade.cjs';

export { clipLength, fadeWindow };

/**
 * 片段在「片段內本地時間」的不透明度倍率（0–1）。
 *
 * 線性斜坡，與 ffmpeg `fade` 濾鏡的預設曲線一致。
 * 回傳的是**倍率**，呼叫端自行乘上軌道透明度等其他因素。
 *
 * 預覽端多半該用 {@link fadeAlphaAtTimeline}——它連時間域轉換一起做掉。
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

/**
 * 片段在「時間軸時間」的不透明度倍率（0–1）。片段還沒到或已經過去 → 0。
 *
 * 【為什麼要有這一支】
 * 預覽的三個呼叫端（app.js 的圖片疊層、decode/player.js 的合成、
 * media.js 的淡出入黑）拿到的都是**時間軸時間**，於是三處各自寫了
 * `fadeAlphaAt(c, t - c.offset)`。鐵律 §0.5 說時間域轉換不該散在呼叫端——
 * 而且它們寫得還不一樣：兩處是 `c.offset || 0`，一處是 `c.offset`，
 * 遇到沒有 offset 欄位的片段前者當 0、後者算出 NaN → **整段變全透明**，
 * 而且不會報錯。轉換收進來一次就沒有這個縫。
 *
 * @param {object} clip         片段（要有 offset／in／out／fadeIn／fadeOut）
 * @param {number} timelineTime 時間軸時間（秒）
 */
export function fadeAlphaAtTimeline(clip, timelineTime) {
  if (!clip) return 0;
  return fadeAlphaAt(clip, (+timelineTime || 0) - (+clip.offset || 0));
}
