/* ==============================================================================
   時間軸接縫（"src/timeline.js"）
   ==============================================================================
   其他模組一律 import 這一支，不要直接 import timeline-renderer.js。

   這裡【刻意逐一列出】對外的名稱，不用 `export *`。原因是接縫的寬度必須是一個
   有意識的決定：`export *` 會讓 timeline-renderer.js 裡任何新加的 export 自動
   變成全專案可見，接縫在沒有人按下同意的情況下慢慢變寬。逐一列出時，要拓寬就得
   改這個檔案，diff 看得見。

   收窄那次順手清掉四個沒有呼叫端的名稱：yToTrack 與 tlTotal 只在繪製模組內部用
   （改回私有），redrawTimeline 與 navigateClip 是零呼叫端的死碼（已刪）。
============================================================================== */
export {
  /* 版面度量與座標換算 */
  RULER_H, ROW_H, tracksTop, tracksScrollTop, viewportW, timeToX, xToTime,

  /* 繪製 */
  layoutTimeline, drawTimeline, drawRuler, drawWave,
  niceStep, fmtTick, renderTrackRows, renderCueBlocks,
  updatePlayhead, refreshTrackGutterActive,

  /* 縮放 */
  setZoom, zoomFit, zoomFitVideo,

  /* 軌道操作 */
  trackFromY, addTrack, removeTrack, moveSelectedToTrack,

  /* 磁吸 */
  snapTargets, snapVal, cueNeighborBounds,

  /* 影片段操作 */

} from './timeline-renderer.js';
export { selectClip, clearClipSelection, deleteSelectedClip, closeClipGapLeft, showClipFade, showCrossfade, showImageGeom, showClipDuration } from './clip-model.js';
