import { clamp } from './util.js';
import { State, cueSuffix } from './state.js';
import { Seq } from './sequence.js';
import { Media } from './media.js';
import { anchorPct, effStyle } from './substyle.js';

let _imgDrag = null;
let _subDrag = null;

let ctx = {
  getStageRect: () => null,
  selectImageClip: (clip, opts) => {},
  renderImageOverlays: () => {},
  renderVideoSub: () => {},
  drawTimeline: () => {},
  recordHistory: (msg) => {},
  imageBoxOf: (clip, rect) => null,
  getPresetEdit: () => null,
  refreshMpvSubs: (force, throttle) => {},
  setSubtitleHover: (el) => {},
  renderTrackStyle: () => {},
  refreshStyleSummaries: () => {},
  onSubDragEndCleanup: (pointerId, d) => {}
};

export function setupInteractionContext(callbacks) {
  Object.assign(ctx, callbacks);
}

export function startImageDrag({ id, corner=null, x, y, pointerId=null, captureTarget=null, source='dom' }) {
  const clip = Seq.byId(id);
  const rect = ctx.getStageRect();
  if(!clip || clip.type !== 'image' || !rect?.w || !rect?.h || State.videoTracks[clip.vtrack || 0]?.locked) return false;
  _imgDrag = {
    clip, rect, x0:x, y0:y, pointerId, captureTarget, source,
    origPosX: clip.posX ?? 0.5, origPosY: clip.posY ?? 0.5, origScale: clip.scale ?? 1,
    origBox: ctx.imageBoxOf(clip, rect),
    corner
  };
  ctx.selectImageClip(clip, { redrawTimeline:false });
  const layer = document.getElementById('imageLayer');
  layer?.classList.add('dragging');
  if(captureTarget && pointerId != null){ try{ captureTarget.setPointerCapture(pointerId); }catch(_){} }
  ctx.renderImageOverlays();
  return true;
}

export function moveImageDrag(x, y) {
  const d = _imgDrag; if(!d) return;
  const clip = d.clip;
  if(d.corner){
    const sx = (d.corner === 'nw' || d.corner === 'sw') ? -1 : 1;
    const sy = (d.corner === 'nw' || d.corner === 'ne') ? -1 : 1;
    const bw = d.origBox?.w > 1 ? d.origBox.w : d.rect.w;
    const bh = d.origBox?.h > 1 ? d.origBox.h : d.rect.h;
    const dx = (x - d.x0) * sx * 2 / bw;
    const dy = (y - d.y0) * sy * 2 / bh;
    const delta = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
    clip.scale = clamp(d.origScale * (1 + delta), 0.02, 8);
  } else {
    clip.posX = clamp(d.origPosX + (x - d.x0) / d.rect.w, 0, 1);
    clip.posY = clamp(d.origPosY + (y - d.y0) / d.rect.h, 0, 1);
  }
  ctx.renderImageOverlays();
  ctx.renderVideoSub();
}

export function finishImageDrag(pointerId=null, source=null) {
  const d = _imgDrag; if(!d || (source && d.source !== source)) return;
  _imgDrag = null;
  const layer = document.getElementById('imageLayer');
  layer?.classList.remove('dragging');
  if(d.captureTarget && d.pointerId != null && (pointerId == null || pointerId === d.pointerId)){
    try{ d.captureTarget.releasePointerCapture(d.pointerId); }catch(_){}
  }
  ctx.renderImageOverlays();
  ctx.drawTimeline();
  ctx.recordHistory(d.corner ? '調整圖片大小' : '移動圖片位置');
}

export function bindImageDomEvents(imageLayer) {
  function startDomImageDrag(e, pointerId=null) {
    if(e.button !== 0) return false;
    const wrap = e.target.closest?.('.img-wrap') || document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.img-wrap');
    if(!wrap || !imageLayer?.contains(wrap)) return false;
    const handle = e.target.closest?.('.resize-handle') || document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.resize-handle');
    const corner = handle?.dataset?.corner || null;
    if(startImageDrag({ id:wrap.dataset.id, corner, x:e.clientX, y:e.clientY, pointerId, captureTarget:imageLayer })){
      e.preventDefault();
      e.stopPropagation();
      return true;
    }
    return false;
  }

  imageLayer?.addEventListener('pointerdown', e => startDomImageDrag(e, e.pointerId));
  document.addEventListener('pointermove', e => {
    if(!_imgDrag || _imgDrag.source !== 'dom') return;
    moveImageDrag(e.clientX, e.clientY);
    e.preventDefault();
  });
  document.addEventListener('pointerup', e => finishImageDrag(e.pointerId, 'dom'));
  document.addEventListener('pointercancel', e => finishImageDrag(e.pointerId, 'dom'));

  imageLayer?.addEventListener('mousedown', e => {
    if(_imgDrag?.source === 'dom' && _imgDrag.pointerId != null) return;
    startDomImageDrag(e, null);
  });
  document.addEventListener('mousemove', e => {
    if(!_imgDrag || _imgDrag.source !== 'dom' || _imgDrag.pointerId != null) return;
    moveImageDrag(e.clientX, e.clientY);
    e.preventDefault();
  });
  document.addEventListener('mouseup', e => {
    if(_imgDrag?.source === 'dom' && _imgDrag.pointerId == null) finishImageDrag(null, 'dom');
  });
}

export function getImgDrag() {
  return _imgDrag;
}

export function getSubDrag() {
  return _subDrag;
}

export function bindSubtitleDomEvents(videoSub, videoWrap) {
  function subDragMove(e){
    const d = _subDrag; if(!d) return;
    const cue = d.cue; if(!cue) return;
    const presetEdit = ctx.getPresetEdit();
    const targetObj = presetEdit ? presetEdit.draft : (cue.style = cue.style || {});
    if(d.rot){
      let ang = d.angle + (Math.atan2(e.clientY-d.py, e.clientX-d.px)*180/Math.PI - d.a0);
      if(e.shiftKey) ang = Math.round(ang/15)*15;
      targetObj.angle = Math.round(((ang+180)%360+360)%360-180);
    }else{
      targetObj.posX = clamp(d.posX + (e.clientX-d.x0)/d.rect.w*100, 0, 100);
      targetObj.posY = clamp(d.posY + (e.clientY-d.y0)/d.rect.h*100, 0, 100);
    }
    if(presetEdit) ctx.renderTrackStyle(); 
    ctx.renderVideoSub();
    if(Media.mpvPresenting()) ctx.refreshMpvSubs(false,true);
    e.preventDefault();
  }

  function subDragEnd(e){
    const d = _subDrag; if(!d) return;
    _subDrag = null;
    ctx.onSubDragEndCleanup(e.pointerId, d);
    
    const nextEl = videoSub?.querySelector(`.vsub-track.drag[data-cue="${d.cue.id}"]`);
    ctx.setSubtitleHover(nextEl||null);
    ctx.refreshStyleSummaries(); 
    ctx.drawTimeline(); 
    ctx.recordHistory((d.rot ? '旋轉字幕' : '移動字幕位置')+cueSuffix(d.cue));
  }

  videoSub?.addEventListener('pointerdown', e => {
    if(e.button !== 0) return;
    const el = e.target.closest?.('.vsub-track.drag'); if(!el) return;
    ctx.setSubtitleHover(el);
    let trk, cue;
    const presetEdit = ctx.getPresetEdit();
    if(presetEdit && el.dataset.cue === 'draft_preview'){
      trk = presetEdit.draft;
      cue = { style: {} }; 
    }else{
      trk = State.tracks[+el.dataset.tk];
      cue = State.cues.find(c => c.id === el.dataset.cue);
    }
    const rect = ctx.getStageRect();
    if(!trk || !cue || trk.locked || !rect?.w || !rect?.h) return;
    const st = presetEdit ? presetEdit.draft : effStyle(cue, trk);
    const box = el.getBoundingClientRect();
    const a = anchorPct(st);
    const px = box.left + box.width*a.x/100, py = box.top + box.height*a.y/100;
    _subDrag = { cue, rect, rot: e.altKey || !!e.target.closest('.rot'), x0: e.clientX, y0: e.clientY,
      posX: st.posX, posY: st.posY, angle: st.angle||0, px, py,
      a0: Math.atan2(e.clientY-py, e.clientX-px)*180/Math.PI };
      
    try{ videoSub.setPointerCapture(e.pointerId); }catch(err){}
    videoSub.classList.add('dragging');
    e.preventDefault();
  });

  videoSub?.addEventListener('pointermove', subDragMove);
  videoSub?.addEventListener('pointerup', subDragEnd);
  videoSub?.addEventListener('pointercancel', subDragEnd);

  videoWrap?.addEventListener('pointermove', e => { if(!_subDrag) ctx.setSubtitleHover(e.target.closest?.('.vsub-track.drag')||null); });
  videoWrap?.addEventListener('pointerleave', () => { if(!_subDrag) ctx.setSubtitleHover(null); });
}
