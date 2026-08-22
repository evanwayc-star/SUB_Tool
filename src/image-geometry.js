/* ==============================================================================
   SUB Tool — 片段疊層幾何計算（Renderer 配接層）
   ==============================================================================
   【架構與職責】
   核心幾何矩形公式統一維護於 `shared/image-geometry.cjs`（`imageBox`, `trackFrame`）。
   本模組提供渲染端專屬的視窗最適縮放 (`fitScale`) 與多層幾何複合計算 (`imageBoxOnStage`)。
   ============================================================================== */
import { imageBox, trackFrame } from '../shared/image-geometry.cjs';

export { imageBox, trackFrame };

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp01 = (v, d) => Math.max(0, Math.min(1, num(v, d)));

/**
 * 計算素材「符合視窗」所需的縮放倍率。
 * 
 * 演算法說明：
 * 維持目前素材的中心點座標，等比例放大或縮小至上下左右【最先觸及】的視窗邊界。
 * 若中心點已貼齊極限邊界（可用空間為 0），則自動回報 `recentred: true` 並以置中計算填滿倍率。
 * 
 * @param {object} [options]
 * @param {number} [options.stageW=0] 舞台寬度
 * @param {number} [options.stageH=0] 舞台高度
 * @param {number} [options.natW=0] 素材原生寬度
 * @param {number} [options.natH=0] 素材原生高度
 * @param {number} [options.posX=0.5] 水平中心比例 (0..1)
 * @param {number} [options.posY=0.5] 垂直中心比例 (0..1)
 * @param {number} [options.min=0.02] 縮放倍率下限
 * @param {number} [options.max=8] 縮放倍率上限
 * @returns {{scale: number, recentred: boolean}} 計算結果倍率與是否建議重設為置中
 */
export function fitScale({
  stageW,
  stageH,
  natW,
  natH,
  posX = 0.5,
  posY = 0.5,
  min = 0.02,
  max = 8,
} = {}) {
  const W = Math.max(0, num(stageW, 0));
  const H = Math.max(0, num(stageH, 0));

  const at = (px, py) => {
    const b = imageBox({ stageW: W, stageH: H, natW, natH, scale: 1, posX: px, posY: py });
    if (!(b.w > 0) || !(b.h > 0)) return 1;
    const cx = W * clamp01(px, 0.5);
    const cy = H * clamp01(py, 0.5);
    return Math.min((2 * Math.min(cx, W - cx)) / b.w, (2 * Math.min(cy, H - cy)) / b.h);
  };

  let s = at(clamp01(posX, 0.5), clamp01(posY, 0.5));
  let recentred = false;
  if (!(s > 0.05)) {
    s = at(0.5, 0.5);
    recentred = true;
  }
  return { scale: Math.max(min, Math.min(max, s)), recentred };
}

/**
 * 計算素材片段在整體專案畫布上的最終複合矩形（先套用軌道 PiP 影格，再套用素材自身縮放與位移）。
 * 
 * @param {object} [params]
 * @param {number} [params.stageW] 專案舞台寬度
 * @param {number} [params.stageH] 專案舞台高度
 * @param {object} [params.track] 視訊軌道設定 (scale, posX, posY)
 * @param {number} [params.natW] 素材原生寬度
 * @param {number} [params.natH] 素材原生高度
 * @param {number} [params.scale] 片段縮放比例
 * @param {number} [params.posX] 片段水平中心比例
 * @param {number} [params.posY] 片段垂直中心比例
 * @returns {{x: number, y: number, w: number, h: number}} 最終在畫布上的像素矩形
 */
export function imageBoxOnStage({ stageW, stageH, track, natW, natH, scale, posX, posY } = {}) {
  const f = trackFrame({
    stageW,
    stageH,
    scale: track?.scale,
    posX: track?.posX,
    posY: track?.posY,
  });
  const b = imageBox({
    stageW: f.w,
    stageH: f.h,
    natW,
    natH,
    scale,
    posX,
    posY,
  });
  return { x: f.x + b.x, y: f.y + b.y, w: b.w, h: b.h };
}
