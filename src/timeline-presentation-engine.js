/* ==============================================================================
   SUB Tool — 時間軸呈現與場景圖引擎 ("src/timeline-presentation-engine.js")
   ==============================================================================
   【架構與職責】
   純領域計算深層模組：負責時間軸虛擬場景圖 (Timeline Scene Graph) 的計算、
   可視視窗節點挑選、DOM 比對與 Canvas 渲染圖元產生，將呈現細節收攏於單一接縫背後。
   ============================================================================== */

import { visibleTimeRange } from './timeline-viewport-culling.js';

/**
 * 建立時間軸可視範圍之聲明立場景圖 (Scene Graph)。
 * 
 * @param {object} viewport 視窗狀態 { scrollLeft, viewportW, pxPerSec, viewStart }
 * @param {Array<object>} cues 字幕清單
 * @param {Array<object>} clips 視訊/音訊片段清單
 * @param {object} [options]
 * @returns {object} 完整場景圖數據
 */
export function buildTimelineSceneGraph(viewport, cues = [], clips = [], {
  selectedIds = [],
  primaryId = null,
  activeClipId = null,
  selectedClipId = null,
} = {}) {
  const { scrollLeft = 0, viewportW = 1000, pxPerSec = 100 } = viewport || {};
  const { tMin, tMax } = visibleTimeRange(scrollLeft, viewportW, pxPerSec, 400);

  const visibleCues = [];
  const selectedSet = new Set(selectedIds);

  for (const c of cues) {
    if (c.timed === false) continue;
    if (c.end < tMin || c.start > tMax) continue;


    const x = Math.round((c.start - (viewport.viewStart || 0)) * pxPerSec);
    const w = Math.max(2, Math.round((c.end - c.start) * pxPerSec));

    visibleCues.push({
      id: c.id,
      track: c.track || 0,
      x,
      w,
      start: c.start,
      end: c.end,
      text: c.text || '',
      selected: selectedSet.has(c.id),
      primary: c.id === primaryId,
    });
  }

  const visibleClips = [];
  for (const clip of clips) {
    const s = clip.offset || 0;
    const e = s + (clip.duration || 0);
    if (e < tMin || s > tMax) continue;

    const x = Math.round((s - (viewport.viewStart || 0)) * pxPerSec);
    const w = Math.max(2, Math.round((e - s) * pxPerSec));

    visibleClips.push({
      id: clip.id,
      vtrack: clip.vtrack || 0,
      x,
      w,
      start: s,
      end: e,
      name: clip.name || 'Clip',
      active: clip.id === activeClipId,
      selected: clip.id === selectedClipId,
    });
  }

  return {
    timeRange: { start: tMin, end: tMax },
    cues: visibleCues,
    clips: visibleClips,
  };

}

/**
 * 計算標尺刻度圖元清單 (Ruler Ticks)。
 * 
 * @param {number} t0 起始時間
 * @param {number} t1 結束時間
 * @param {number} step 每刻度秒數
 * @param {number} pxPerSec 像素比例
 * @param {number} viewStart 視窗起始時間
 * @returns {Array<{x: number, time: number, isMajor: boolean}>} 刻度清單
 */
export function computeRulerTicks(t0, t1, step, pxPerSec, viewStart = 0) {
  if (step <= 0 || pxPerSec <= 0) return [];
  const ticks = [];
  const startTick = Math.floor(t0 / step) * step;

  for (let t = startTick; t <= t1 + step; t += step) {
    if (t < 0) continue;
    const x = (t - viewStart) * pxPerSec;
    const isMajor = Math.abs(Math.round(t) - t) < 0.001;
    ticks.push({
      x: Math.round(x),
      time: t,
      isMajor,
    });
  }

  return ticks;
}
