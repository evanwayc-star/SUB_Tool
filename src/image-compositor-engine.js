/* ==============================================================================
   SUB Tool — Image Compositor Engine ("src/image-compositor-engine.js")
   ==============================================================================
   深層影像疊層幾何與合成規劃引擎 (Image Compositor Engine)。
   提供素材疊層幾何、軌道 PiP 影格、淡入淡出透明度與合成接管決策：
   1. 幾何矩形與最適縮放計算 (imageBox / trackFrame / fitScale / imageBoxOnStage)
   2. 多層合成接管與黑邊置中判定 (needsComposite / stageBox)
   3. 淡入淡出視窗與時間軸透明度曲線 (fadeAlphaAt / fadeAlphaAtTimeline)
   ============================================================================== */

import { imageBox, trackFrame } from '../shared/image-geometry.cjs';
import { clipLength, fadeWindow } from '../shared/clip-fade.cjs';
import { fixedFrameTime } from '../shared/clip-visual.cjs';

export { imageBox, trackFrame, clipLength, fadeWindow };

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp01 = (v, d) => Math.max(0, Math.min(1, num(v, d)));
const EPS = 0.001;

export function imageSourceUrl(clip){
  if(fixedFrameTime(clip)!=null) return clip.freezeWeb?.url||'';
  let url=clip?.web?.url||clip?.path||'';
  if(url&&!/^(https?|file|blob|data|subtool-local):/i.test(url)) url='file:///'+url.replace(/\\/g,'/');
  return url;
}

/* Native guide 可畫在影片之上的圖片；圖片插在影片下方或中間時，必須由
   同一個 compositor 畫完整層序，不能把兩種素材拆成各自的 stack。 */
export function visualStackPlan(activeClips,videoTracks){
  const clips=(activeClips||[]).filter(c=>videoTracks?.[c.vtrack||0]?.visible!==false)
    .map(c=>fixedFrameTime(c)!=null?{...c,type:'image'}:c)
    .slice().sort((a,b)=>(a.vtrack||0)-(b.vtrack||0));
  const videos=clips.filter(c=>c.type!=='image');
  const images=clips.filter(c=>c.type==='image');
  const lastVideo=clips.findLastIndex(c=>c.type!=='image');
  const mixedImages=images.length>0&&clips.some((c,index)=>c.type==='image'&&index<lastVideo);
  const composited=mixedImages?clips:videos;
  return {clips,videos,images,composited,mixedImages,
    needsComposite:videos.length>0&&(mixedImages||needsComposite(videos,videoTracks))};
}

/**
 * 計算素材「符合視窗」所需的縮放倍率。
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
 * 計算素材片段在整體專案畫布上的最終複合矩形。
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

/** One image layer includes its containing track frame, not just its bitmap box. */
export function imageLayerPlan({stageW,stageH,track,clip,natW,natH,time}={}){
  const box=imageBoxOnStage({stageW,stageH,track,natW,natH,scale:clip?.scale,posX:clip?.posX,posY:clip?.posY});
  const frame=trackFrame({stageW,stageH,scale:track?.scale,posX:track?.posX,posY:track?.posY});
  const x=Math.max(0,frame.x,box.x),y=Math.max(0,frame.y,box.y);
  const right=Math.min(stageW,frame.x+frame.w,box.x+box.w);
  const bottom=Math.min(stageH,frame.y+frame.h,box.y+box.h);
  return {box,frame,visible:{x,y,w:Math.max(0,right-x),h:Math.max(0,bottom-y)},
    alpha:clamp01(track?.opacity,1)*fadeAlphaAtTimeline(clip,time)};
}

/**
 * 判斷當前活躍的片段與視訊軌道是否需要由 WebCodecs 引擎進行多層幾何合成。
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

/**
 * 計算片段在「片段內部本地時間」下的不透明度倍率 (0..1)。
 */
export function fadeAlphaAt(clip, localTime) {
  const { length, fadeIn, fadeOut, fadeOutStart } = fadeWindow(clip);
  const local=Number(localTime)||0;
  if(local<0||local>clipLength(clip)) return 0;
  const rawOrigin = Number(clip?.fadeSourceOffset);
  const t = local + (Number.isFinite(rawOrigin) ? Math.max(0, rawOrigin) : 0);
  if (t < 0 || t > length) return 0;

  let a = 1;
  if (fadeIn > 0 && t < fadeIn) a *= t / fadeIn;
  if (fadeOut > 0 && t > fadeOutStart) a *= (length - t) / fadeOut;

  return Math.max(0, Math.min(1, a));
}

/**
 * 計算片段在「時間軸全域時間」下的不透明度倍率 (0..1)。
 */
export function fadeAlphaAtTimeline(clip, timelineTime) {
  if (!clip) return 0;
  return fadeAlphaAt(clip, (Number(timelineTime) || 0) - (Number(clip.offset) || 0));
}
