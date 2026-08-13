/* ==============================================================================
   SUB Tool — 片段疊層幾何（兩個行程共用的唯一一份）
   ==============================================================================

   片段（圖片與影片段）在畫框上實際被畫出來的矩形。鐵律 §0.9：
     方框 ＝ scale × 畫框（寬高各自乘）
     素材 contain 縮進方框、置中
     posX / posY ＝ 素材【中心】在畫框上的位置比例（0..1）

   三路共用同一組數字：
     1) 預覽 DOM 疊層（app.js renderImageOverlays）
     2) mpv 透明 guide 視窗的滑鼠命中區
     3) 匯出 filtergraph（electron/export-plan.js）

   v6.1.2 之前第 3 路是 `imageBoxForExport()`——與 `src/image-geometry.js imageBox()`
   逐行相同的手抄副本，靠 `tests/imageGeomContract.test.js` 比對兩份輸出。
   壞掉的樣子：預覽與匯出差幾十到上百 px（v5.8.0 實測 4:3 素材、軌 scale=0.5
   時差 120px），而兩邊各自看起來都很正常。

   natW/natH 取不到時（舊專案、圖檔還沒載入）退回方框尺寸＝舊行為，不會破圖。
============================================================================== */

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const clamp01 = (v, d) => Math.max(0, Math.min(1, num(v, d)));

/**
 * 素材在畫框內實際被畫出來的矩形。
 * @param {object} p
 * @param {number} p.stageW 畫框寬（匯出端傳的是軌影格寬）
 * @param {number} p.stageH 畫框高
 * @param {number} p.natW   素材原生寬（0／缺值＝退回方框尺寸）
 * @param {number} p.natH   素材原生高
 * @param {number} p.scale  方框佔畫框的比例
 * @param {number} p.posX   素材中心的水平位置比例 0..1
 * @param {number} p.posY   素材中心的垂直位置比例 0..1
 * @returns {{x:number,y:number,w:number,h:number}} 相對畫框左上角的像素矩形
 */
function imageBox({ stageW, stageH, natW, natH, scale = 1, posX = 0.5, posY = 0.5 } = {}) {
  const SW = Math.max(0, num(stageW, 0)), SH = Math.max(0, num(stageH, 0));
  const s = Math.max(0.01, num(scale, 1));
  const boxW = SW * s, boxH = SH * s;
  const nw = Math.max(0, num(natW, 0)), nh = Math.max(0, num(natH, 0));
  let w = boxW, h = boxH;
  if (nw > 0 && nh > 0 && boxW > 0 && boxH > 0) {
    const k = Math.min(boxW / nw, boxH / nh); // contain
    w = nw * k; h = nh * k;
  }
  const cx = SW * clamp01(posX, 0.5), cy = SH * clamp01(posY, 0.5);
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/**
 * 視訊軌本身的 PiP 影格（軌 scale / posX / posY）。
 * 匯出是「片段放進軌影格 → 軌影格再疊到畫布」，預覽必須套同一層，
 * 否則對該軌做子母畫面時預覽與匯出會對不上。
 * 注意 posX/posY 在這裡是【可用空間比例】`(W-w)*px`，與 imageBox 的中心語意不同。
 */
function trackFrame({ stageW, stageH, scale = 1, posX = 0.5, posY = 0.5 } = {}) {
  const SW = Math.max(0, num(stageW, 0)), SH = Math.max(0, num(stageH, 0));
  const s = Math.max(0.02, Math.min(1, num(scale, 1)));
  const w = SW * s, h = SH * s;
  return { x: (SW - w) * clamp01(posX, 0.5), y: (SH - h) * clamp01(posY, 0.5), w, h };
}

module.exports = { imageBox, trackFrame };
