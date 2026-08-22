/* ==============================================================================
   SUB Tool — 預覽合成決策器 (Compositor Plan Engine)
   ==============================================================================
   【架構與職責】
   負責預覽播放時的兩大核心決策（純資料計算）：
   1. `needsComposite`：決定當前影格是否需要由 WebCodecs 多層合成引擎接管（處理多軌、縮放、淡入淡出、透明度）。
   2. `stageBox`：計算專案畫布在實際視窗/Canvas 中的等比居中縮放矩形區域。
   ============================================================================== */

/** 幾何比較微小容差 */
const EPS = 0.001;

/**
 * 判斷當前活躍的片段與視訊軌道是否需要由 WebCodecs 引擎進行多層幾何合成。
 * 
 * 決策條件：
 * 1. 同時有 2 個以上活躍片段（多層必定要合成）。
 * 2. 單一片段具備淡入、淡出、縮放非 100%、中心點偏移或軌道不透明度小於 1。
 * 
 * @param {Array<object>} activeClips 當前時間點活躍的視訊/圖片片段清單
 * @param {Array<object>} videoTracks 專案視訊軌道設定清單
 * @returns {boolean} 是否需要多層合成接管
 */
export function needsComposite(activeClips, videoTracks) {
  const acts = activeClips || [];
  if (acts.length > 1) return true;

  return acts.some(c => {
    const vt = (videoTracks || [])[c.vtrack || 0] || {};
    return (c.fadeIn || 0) > 0 || (c.fadeOut || 0) > 0
      || (vt.scale != null && Math.abs(vt.scale - 1) > EPS)
      || (vt.opacity != null && vt.opacity < 1 - EPS)
      || (c.scale != null && Math.abs(c.scale - 1) > EPS)
      || (c.posX != null && Math.abs(c.posX - 0.5) > EPS)
      || (c.posY != null && Math.abs(c.posY - 0.5) > EPS);
  });
}

/**
 * 計算專案畫布在顯示畫布中的實際繪製矩形（等比縮放並置中，邊界留黑邊）。
 * 
 * @param {object} options
 * @param {number} options.canvasW 顯示視窗/Canvas 寬度
 * @param {number} options.canvasH 顯示視窗/Canvas 高度
 * @param {number} [options.projectW=1920] 專案設定畫布寬度
 * @param {number} [options.projectH=1080] 專案設定畫布高度
 * @returns {{x: number, y: number, w: number, h: number}} 居中矩形區域
 */
export function stageBox({ canvasW, canvasH, projectW, projectH }) {
  const pw = projectW || 1920;
  const ph = projectH || 1080;
  const s = Math.min(canvasW / pw, canvasH / ph);
  const w = Math.round(pw * s);
  const h = Math.round(ph * s);
  return {
    x: (canvasW - w) >> 1,
    y: (canvasH - h) >> 1,
    w,
    h,
  };
}
