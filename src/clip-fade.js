/* ==============================================================================
   SUB Tool — 片段淡入淡出計算（Renderer 配接層）
   ==============================================================================
   【架構與職責】
   核心視窗計算規則統一維護於 `shared/clip-fade.cjs`（`clipLength`, `fadeWindow`）。
   本模組提供渲染端在不同時間域下（片段本地時間 vs 時間軸全域時間）的不透明度計算。
   ============================================================================== */
import { clipLength, fadeWindow } from '../shared/clip-fade.cjs';

export { clipLength, fadeWindow };

/**
 * 計算片段在「片段內部本地時間」下的不透明度倍率 (0..1)。
 * 
 * 線性斜坡計算，與 FFmpeg `fade` 濾鏡的預設曲線完全一致。
 * 
 * @param {object} clip 片段物件 (in, out, fadeIn, fadeOut)
 * @param {number} localTime 片段內相對時間（秒，等於 時間軸時間 - clip.offset）
 * @returns {number} 不透明度倍率 (0..1)
 */
export function fadeAlphaAt(clip, localTime) {
  const { length, fadeIn, fadeOut, fadeOutStart } = fadeWindow(clip);
  const t = Number(localTime) || 0;
  if (t < 0 || t > length) return 0;

  let a = 1;
  if (fadeIn > 0 && t < fadeIn) a *= t / fadeIn;
  if (fadeOut > 0 && t > fadeOutStart) a *= (length - t) / fadeOut;

  return Math.max(0, Math.min(1, a));
}

/**
 * 計算片段在「時間軸全域時間」下的不透明度倍率 (0..1)。
 * 
 * 鐵律 §0.5 防禦：時間域轉換集中於此處理，自動補正缺失之 `offset` 欄位。
 * 
 * @param {object} clip 片段物件 (offset, in, out, fadeIn, fadeOut)
 * @param {number} timelineTime 時間軸時間（秒）
 * @returns {number} 不透明度倍率 (0..1)
 */
export function fadeAlphaAtTimeline(clip, timelineTime) {
  if (!clip) return 0;
  return fadeAlphaAt(clip, (Number(timelineTime) || 0) - (Number(clip.offset) || 0));
}
