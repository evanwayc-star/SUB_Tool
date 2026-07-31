/* ==============================================================================
   SUB Tool — 預覽合成的版面決策（Compositor Plan）
   ==============================================================================

   「這一幀要不要自己合成、畫布上的專案畫面區在哪」——兩個純決策，
   從 decode/player.js 抽出來。

   【為什麼抽出來】
   `decode/player.js` 有 412 行，決策與 `VideoDecoder`／`VideoFrame` 的生命週期
   焊在一起，vitest 跑不起來，所以**沒有任何測試 import 過它**。
   但它是三條渲染路徑的其中一條（見鐵律 §0.1），必須和另外兩條對得上——
   v5.8.0 的兩個真實 bug（預覽與匯出差 120px、疊層溢出軌影格 24×54px）都住在這裡，
   兩個都是靠臨時搭的比對工具抓到的，不是測試。

   幾何本身走 `imagegeom.js`（已有跨行程契約測試），淡入淡出走 `clip-fade.js`；
   這一支補的是「要不要接管」與「畫面區在哪」這兩塊還沒有接縫的決策。
============================================================================== */

const EPS = 0.001;

/* mpv 只會把單一片段滿版播放，表達不了縮放、偏移、透明度與淡變。
   凡是需要這些效果的情境，WebCodecs 就必須接管，否則畫面看起來「設定沒生效」，
   匯出卻套用了——預覽與成品不一致，而且**不會有任何錯誤訊息**。

   v5.7.0 的實例：逐片段幾何（clip.scale／posX／posY）漏了這幾條判斷，
   設了幾何的影片段在 mpv 模式下完全看不出變化。 */
export function needsComposite(activeClips, videoTracks) {
  const acts = activeClips || [];
  if (acts.length > 1) return true;              // 多層一定要合成
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
 * 畫布上的「專案畫面區」——把專案畫布（State.videoWidth/Height）contain 進實際畫布並置中。
 *
 * 基準必須是**專案畫布**，不是第一層素材的解析度：否則切換到不同比例的片段時
 * 整個畫面區會跟著變，字幕大小也跟著跳（症狀＝「字幕在各個影片上大小不同」，v4.25.3）。
 * 各層再 contain 進這個區域，比例不同就留黑邊，與匯出一致。
 */
export function stageBox({ canvasW, canvasH, projectW, projectH }) {
  const pw = projectW || 1920, ph = projectH || 1080;
  const s = Math.min(canvasW / pw, canvasH / ph);
  const w = Math.round(pw * s), h = Math.round(ph * s);
  return { x: (canvasW - w) >> 1, y: (canvasH - h) >> 1, w, h };
}
