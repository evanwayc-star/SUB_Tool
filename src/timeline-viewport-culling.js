/* ==============================================================================
   SUB Tool — 時間軸可視視窗虛擬裁切引擎 ("src/timeline-viewport-culling.js")
   ==============================================================================
   【架構與職責】
   純領域計算引擎：根據時間軸當前視窗滾動位置、寬度與縮放比例，精準計算
   可視時間範圍（含安全邊界緩衝區），並對字幕 (cues)、片段 (clips) 及重疊 (overlaps)
   進行高效率視窗裁切 (Viewport Culling)。
   
   【效能優勢】
   - 當專案包含數千句字幕或數小時長片時，將 DOM 節點數量限制在視窗可見範圍內，
     大幅減少瀏覽器重排（Reflow）與記憶體佔用，維持穩定 60 FPS。
   ============================================================================== */

/**
 * 計算當前視窗可見的時間範圍（秒）。
 * 
 * @param {number} scrollLeft 時間軸水平滾動偏移像素 (px)
 * @param {number} viewportW 時間軸可視區域寬度像素 (px)
 * @param {number} pxPerSec 每秒對應的像素寬度 (Zoom)
 * @param {number} [bufferPx=500] 前後預載安全緩衝區像素 (px)
 * @returns {{tMin: number, tMax: number}} 可視時間範圍 [tMin, tMax]
 */
export function visibleTimeRange(scrollLeft, viewportW, pxPerSec, bufferPx = 500) {
  const z = Math.max(0.0001, Number(pxPerSec) || 100);
  const left = Math.max(0, (Number(scrollLeft) || 0) - bufferPx);
  const right = (Number(scrollLeft) || 0) + (Number(viewportW) || 1920) + bufferPx;

  return {
    tMin: Math.max(0, left / z),
    tMax: Math.max(0, right / z),
  };
}

/**
 * 篩選落在指定時間範圍內的字幕片段 (Cues)。
 * 
 * @param {Array<object>} cues 字幕清單
 * @param {number} tMin 起始時間（秒）
 * @param {number} tMax 結束時間（秒）
 * @returns {Array<object>} 與視窗交集之字幕清單
 */
export function cullCues(cues, tMin, tMax) {
  if (!Array.isArray(cues) || !cues.length) return [];
  const min = Number(tMin) || 0;
  const max = Number(tMax) || Infinity;

  return cues.filter(c => {
    const start = Number(c?.in) || 0;
    const end = Number(c?.out) || 0;
    return end >= min && start <= max;
  });
}

/**
 * 篩選落在指定時間範圍內的時間軸片段 (Clips)。
 * 
 * @param {Array<object>} clips 片段清單
 * @param {number} tMin 起始時間（秒）
 * @param {number} tMax 結束時間（秒）
 * @returns {Array<object>} 與視窗交集之片段清單
 */
export function cullClips(clips, tMin, tMax) {
  if (!Array.isArray(clips) || !clips.length) return [];
  const min = Number(tMin) || 0;
  const max = Number(tMax) || Infinity;

  return clips.filter(c => {
    const start = Number(c?.start) || 0;
    const duration = Math.max(0, Number(c?.duration) || 0);
    const end = start + duration;
    return end >= min && start <= max;
  });
}

/**
 * 篩選落在指定時間範圍內的字幕重疊標記 (Overlaps)。
 * 
 * @param {Array<object>} overlaps 重疊標記清單
 * @param {number} tMin 起始時間（秒）
 * @param {number} tMax 結束時間（秒）
 * @returns {Array<object>} 與視窗交集之重疊標記清單
 */
export function cullOverlaps(overlaps, tMin, tMax) {
  if (!Array.isArray(overlaps) || !overlaps.length) return [];
  const min = Number(tMin) || 0;
  const max = Number(tMax) || Infinity;

  return overlaps.filter(ov => {
    const start = Number(ov?.start) || 0;
    const end = Number(ov?.end) || 0;
    return end >= min && start <= max;
  });
}
