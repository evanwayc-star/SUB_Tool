/* ==============================================================================
   SUB Tool — Module Architecture Protection ("src/imagegeom.js")
   ==============================================================================
   【維護鐵律】本檔案已納入全專案終極防禦網。
   所有修改必須遵循專案的單向資料流與職責分離原則，嚴禁在此實作越權的 DOM 操作。
============================================================================== */
/* SUB Tool — 圖片疊層幾何（v4.7）

   【唯一公式】圖片在畫面上的實際矩形，由這裡算出來，三處共用同一組數字：
     1) 預覽 DOM 疊層（app.js renderImageOverlays → .img-wrap 的 left/top/width/height）
     2) mpv 透明 guide 視窗的滑鼠命中區（app.js → main.js pointerHitsMpvImage）
     3) 匯出 filtergraph（electron/main.js 圖片分支，見該處註解與 tests/imageGeom.test.js）

   語意：
     - clip.scale ＝「方框」佔畫框的比例（寬高各自 scale×畫框），圖片再以 contain 縮進方框、置中。
     - clip.posX/posY ＝ 圖片【中心】在畫框上的位置比例（0..1）。
   ── v4.7 之前 .img-wrap 直接就是「方框」，非 16:9 的圖片（方形 LOGO、直式）方框遠大於圖片本身，
      虛線框與四角把手因此離圖片最遠可達上百 px、甚至掉到播放列底下點不到＝「圖片無法調整大小」。
      現在改成先把 contain 算完，回傳圖片【真正被畫出來的那塊】，互動框才會貼合素材。

   natW/natH 取不到時（舊專案、圖檔還沒載入）退回方框尺寸＝舊行為，不會破圖。 */

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp01 = (v, d) => Math.max(0, Math.min(1, num(v, d)));

/* 回傳 { x, y, w, h }：相對「畫框左上角」的像素矩形（畫框＝stageW×stageH）。 */
export function imageBox({ stageW, stageH, natW, natH, scale = 1, posX = 0.5, posY = 0.5 } = {}) {
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

/* 視訊軌本身的 PiP 影格（軌 scale/posX/posY）。匯出是「圖片放進軌影格 → 軌影格再疊到畫布」，
   預覽必須套同一層，否則對圖片軌做子母畫面時預覽與匯出會對不上。 */
export function trackFrame({ stageW, stageH, scale = 1, posX = 0.5, posY = 0.5 } = {}) {
  const SW = Math.max(0, num(stageW, 0)), SH = Math.max(0, num(stageH, 0));
  const s = Math.max(0.02, Math.min(1, num(scale, 1)));
  const w = SW * s, h = SH * s;
  return { x: (SW - w) * clamp01(posX, 0.5), y: (SH - h) * clamp01(posY, 0.5), w, h };
}

/* 「符合視窗」要用的倍率：維持目前中心位置，等比例放大／縮小到上下左右
   【最先碰到】的那個邊界為止。

   素材實際矩形的寬高與 scale 成正比（框跟著 scale 縮放、contain 也是線性），
   所以量一次 scale=1 的矩形就能解出倍率：
     可用寬 = 2×min(cx, W−cx)      可用高 = 2×min(cy, H−cy)
     倍率   = min(可用寬 / w₁, 可用高 / h₁)
   取較小者，就是第一個被超過的邊界。

   位置貼齊邊緣（posX≈0 或 1）時可用空間為零、倍率會趨近 0，那個結果沒有意義；
   此時回報 recentred=true 並以置中重算（等同傳統的「填滿視窗」），
   由呼叫端決定要不要一起把位置改成置中。 */
export function fitScale({ stageW, stageH, natW, natH, posX = 0.5, posY = 0.5, min = 0.02, max = 8 } = {}) {
  const W = Math.max(0, num(stageW, 0)), H = Math.max(0, num(stageH, 0));
  const at = (px, py) => {
    const b = imageBox({ stageW: W, stageH: H, natW, natH, scale: 1, posX: px, posY: py });
    if (!(b.w > 0) || !(b.h > 0)) return 1;
    const cx = W * clamp01(px, 0.5), cy = H * clamp01(py, 0.5);
    return Math.min((2 * Math.min(cx, W - cx)) / b.w, (2 * Math.min(cy, H - cy)) / b.h);
  };
  let s = at(clamp01(posX, 0.5), clamp01(posY, 0.5));
  let recentred = false;
  if (!(s > 0.05)) { s = at(0.5, 0.5); recentred = true; }
  return { scale: Math.max(min, Math.min(max, s)), recentred };
}

/* 圖片在整個畫框上的最終矩形（先套軌影格、再套圖片自身幾何）。 */
export function imageBoxOnStage({ stageW, stageH, track, natW, natH, scale, posX, posY } = {}) {
  const f = trackFrame({ stageW, stageH, scale: track?.scale, posX: track?.posX, posY: track?.posY });
  const b = imageBox({ stageW: f.w, stageH: f.h, natW, natH, scale, posX, posY });
  return { x: f.x + b.x, y: f.y + b.y, w: b.w, h: b.h };
}

