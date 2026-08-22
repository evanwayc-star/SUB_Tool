/* ==============================================================================
   SUB Tool — 片段疊層與子母畫面幾何計算 (Overlay & Track Frame Geometry)
   ==============================================================================
   【架構與職責】
   兩個行程（主行程 CommonJS 與渲染端 ES Module）共用的單一領域規則。
   
   【鐵律與不變量】
   鐵律 §0.9：靜態圖片與影片片段在畫框上實際繪製的矩形區域：
   1. 方框 (Bounding Box) ＝ scale × 畫框（寬高各自乘）
   2. 素材等比縮放 (Contain) 縮進方框並置中
   3. posX / posY ＝ 素材【幾何中心】在畫框上的座標比例 (0..1)
   
   三路渲染必須共用同一套數值輸出：
   - 預覽端 HTML DOM 疊層 (renderImageOverlays)
   - MPV 透明 Guide 視窗的滑鼠互動命中區
   - 匯出端 FFmpeg filtergraph (export-plan.js)
   
   若未依原生尺寸提供（例如舊專案或尚未取得圖片尺寸），安全退回方框尺寸。
   ============================================================================== */

/**
 * 安全數值轉換輔助函式。
 * @param {*} value 輸入值
 * @param {number} fallback 預設後援值
 * @returns {number} 保證為有限數值 (Finite Number)
 */
const safeNum = (value, fallback) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

/**
 * 數值截取在 [0, 1] 區間。
 * @param {*} value 輸入比例值
 * @param {number} fallback 預設值
 * @returns {number} [0, 1] 範圍內的浮點數
 */
const clamp01 = (value, fallback) => Math.max(0, Math.min(1, safeNum(value, fallback)));

/**
 * 計算素材片段在畫框內實際被繪製的矩形區域（中心對齊 Contain 模式）。
 * 
 * @param {object} [params]
 * @param {number} [params.stageW=0] 畫框/舞台寬度（像素）
 * @param {number} [params.stageH=0] 畫框/舞台高度（像素）
 * @param {number} [params.natW=0] 素材原生寬度（0 或缺失時退回方框寬度）
 * @param {number} [params.natH=0] 素材原生高度（0 或缺失時退回方框高度）
 * @param {number} [params.scale=1] 縮放比例（方框佔畫框的比例）
 * @param {number} [params.posX=0.5] 素材中心點水平座標比例 (0..1)
 * @param {number} [params.posY=0.5] 素材中心點垂直座標比例 (0..1)
 * @returns {{x: number, y: number, w: number, h: number}} 相對畫框左上角 (0, 0) 的像素矩形
 */
function imageBox({ stageW, stageH, natW, natH, scale = 1, posX = 0.5, posY = 0.5 } = {}) {
  const SW = Math.max(0, safeNum(stageW, 0));
  const SH = Math.max(0, safeNum(stageH, 0));
  const s = Math.max(0.01, safeNum(scale, 1));
  const boxW = SW * s;
  const boxH = SH * s;

  const nw = Math.max(0, safeNum(natW, 0));
  const nh = Math.max(0, safeNum(natH, 0));
  let w = boxW;
  let h = boxH;

  if (nw > 0 && nh > 0 && boxW > 0 && boxH > 0) {
    // 依長寬比等比縮放 Contain 模式
    const k = Math.min(boxW / nw, boxH / nh);
    w = nw * k;
    h = nh * k;
  }

  const cx = SW * clamp01(posX, 0.5);
  const cy = SH * clamp01(posY, 0.5);

  return {
    x: cx - w / 2,
    y: cy - h / 2,
    w,
    h,
  };
}

/**
 * 計算視訊軌本身的子母畫面 (PiP) 影格矩形。
 * 
 * 備註：
 * 匯出時為兩層複合：「片段疊進軌影格 → 軌影格再疊至專案畫布」。
 * 注意：posX / posY 在此處為【剩餘可用空間的偏移比例】`(SW - w) * posX`，
 * 與 `imageBox` 的「幾何中心」語意有所區隔。
 * 
 * @param {object} [params]
 * @param {number} [params.stageW=0] 舞台/畫布寬度
 * @param {number} [params.stageH=0] 舞台/畫布高度
 * @param {number} [params.scale=1] 軌道縮放比例 (0.02..1)
 * @param {number} [params.posX=0.5] 水平偏移比例 (0..1)
 * @param {number} [params.posY=0.5] 垂直偏移比例 (0..1)
 * @returns {{x: number, y: number, w: number, h: number}} 軌道在畫布上的像素矩形
 */
function trackFrame({ stageW, stageH, scale = 1, posX = 0.5, posY = 0.5 } = {}) {
  const SW = Math.max(0, safeNum(stageW, 0));
  const SH = Math.max(0, safeNum(stageH, 0));
  const s = Math.max(0.02, Math.min(1, safeNum(scale, 1)));
  const w = SW * s;
  const h = SH * s;

  return {
    x: (SW - w) * clamp01(posX, 0.5),
    y: (SH - h) * clamp01(posY, 0.5),
    w,
    h,
  };
}

module.exports = { imageBox, trackFrame };
