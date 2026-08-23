/* ==============================================================================
   SUB Tool — Timeline Interaction Engine ("src/timeline-interaction-engine.js")
   ==============================================================================
   深層時間軸手勢互動、佈局與導航引擎 (Timeline Interaction Engine)。
   提供預覽視窗拖曳狀態機、時間軸軌道佈局幾何計算與座標換算：
   1. 預覽拖曳手勢工廠 (createPreviewDrag)
   2. 時間軸軌道高度與垂直幾何計算 (RULER_H / ROW_H / VROW_H / AROW_H / trackH / tracksHeight / yToTrack / vtracksHeight / atracksHeight / tracksTop)
   ============================================================================== */

import { clamp } from './util.js';
import { State, cueSuffix } from './state.js';
import { Seq } from './sequence.js';
import { Media } from './media.js';
import { anchorPct, effStyle } from './substyle.js';

export const RULER_H = 36;
export const ROW_H = 64;
export const VROW_H = 44;
export const AROW_H = 48;
export const AUDIO_HEAD_H = 0;
export const AUDIO_MAX_VIEW_H = 216;
export const AUDIO_MIN_SUB_H = 72;

export function trackH(tracks, tk) {
  return tracks[tk]?.height || ROW_H;
}

export function tracksHeight(tracks, trackCount) {
  let h = 0;
  for (let i = 0; i < trackCount; i++) h += trackH(tracks, i);
  return h;
}

export function yToTrack(tracks, trackCount, y) {
  let c = 0;
  for (let i = 0; i < trackCount; i++) {
    c += trackH(tracks, i);
    if (y < c) return i;
  }
  return Math.max(0, trackCount - 1);
}

export function vtrackCount(videoTracks) {
  return Math.max(1, videoTracks.length);
}

export function vtrackH(videoTracks, v) {
  return videoTracks[v]?.height || VROW_H;
}

export function vtracksHeight(videoTracks, hasSeq, collapsed) {
  if (!hasSeq || collapsed) return 0;
  let h = 0;
  const N = vtrackCount(videoTracks);
  for (let v = 0; v < N; v++) h += vtrackH(videoTracks, v);
  return h;
}

export function vtrackTop(videoTracks, v) {
  const N = vtrackCount(videoTracks);
  let top = 0;
  for (let disp = 0; disp < N; disp++) {
    const vv = N - 1 - disp;
    if (vv === v) return top;
    top += vtrackH(videoTracks, vv);
  }
  return 0;
}

export function sourceAudioRowH(row) {
  const h = Number(row?.height);
  return Number.isFinite(h) ? clamp(h, 32, 160) : AROW_H;
}

export function audioRowsHeight(layout) {
  return layout.reduce((sum, row) => sum + row.h, 0);
}

export function audioViewportH(layout, layerH, vHeight) {
  const full = audioRowsHeight(layout);
  if (!full) return 0;
  const room = layerH ? layerH - RULER_H - vHeight - AUDIO_HEAD_H - AUDIO_MIN_SUB_H : AUDIO_MAX_VIEW_H;
  const cap = Math.max(36, Math.min(AUDIO_MAX_VIEW_H, room));
  return Math.min(full, cap);
}

export function atracksHeight(layout, layerH, vHeight) {
  return layout.length ? AUDIO_HEAD_H + audioViewportH(layout, layerH, vHeight) : 0;
}

export function tracksTop(vHeight, aHeight) {
  return RULER_H + vHeight + aHeight;
}

const DEFAULT_DEPS = {
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

export function createPreviewDrag(deps = {}) {
  const ctx = { ...DEFAULT_DEPS, ...deps };
  let _imgDrag = null;
  let _subDrag = null;

  function startImageDrag({ id, corner=null, x, y, pointerId=null, captureTarget=null }) {
    const clip = Seq.byId(id);
    const rect = ctx.getStageRect();
    if(!clip || clip.type !== 'image' || !rect?.w || !rect?.h || State.videoTracks[clip.vtrack || 0]?.locked) return false;
    _imgDrag = {
      clip, rect, x0:x, y0:y, pointerId, captureTarget,
      origPosX: clip.posX ?? 0.5, origPosY: clip.posY ?? 0.5, origScale: clip.scale ?? 1,
      origBox: ctx.imageBoxOf(clip, rect),
      corner
    };
    ctx.selectImageClip(clip, { redrawTimeline:false });
    const layer = typeof document !== 'undefined' ? document.getElementById('imageLayer') : null;
    layer?.classList.add('dragging');
    if(captureTarget && pointerId != null){ try{ captureTarget.setPointerCapture(pointerId); }catch(_){} }
    ctx.renderImageOverlays();
    return true;
  }

  function moveImageDrag(x, y) {
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

  function finishImageDrag(pointerId=null) {
    const d = _imgDrag; if(!d) return;
    _imgDrag = null;
    const layer = typeof document !== 'undefined' ? document.getElementById('imageLayer') : null;
    layer?.classList.remove('dragging');
    if(d.captureTarget && d.pointerId != null && (pointerId == null || pointerId === d.pointerId)){
      try{ d.captureTarget.releasePointerCapture(d.pointerId); }catch(_){}
    }
    ctx.renderImageOverlays();
    ctx.drawTimeline();
    ctx.recordHistory(d.corner ? '調整圖片大小' : '移動圖片位置');
  }

  function bindImageDomEvents(imageLayer) {
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
      if(!_imgDrag) return;
      moveImageDrag(e.clientX, e.clientY);
      e.preventDefault();
    });
    document.addEventListener('pointerup', e => finishImageDrag(e.pointerId));
    document.addEventListener('pointercancel', e => finishImageDrag(e.pointerId));

    imageLayer?.addEventListener('mousedown', e => {
      if(_imgDrag?.pointerId != null) return;
      startDomImageDrag(e, null);
    });
    document.addEventListener('mousemove', e => {
      if(!_imgDrag || _imgDrag.pointerId != null) return;
      moveImageDrag(e.clientX, e.clientY);
      e.preventDefault();
    });
    document.addEventListener('mouseup', e => {
      if(_imgDrag?.pointerId == null) finishImageDrag(null);
    });
  }

  function bindSubtitleDomEvents(videoSub, videoWrap) {
    function subDragMove(e){
      const d = _subDrag; if(!d) return;
      if (!d.moved && (Math.abs(e.clientX - d.x0) > 3 || Math.abs(e.clientY - d.y0) > 3)) d.moved = true;
      if (!d.moved) return;

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
      
      if (!d.moved) {
        if(ctx.selectCueSingle) ctx.selectCueSingle(d.cue.id);
      } else {
        ctx.refreshStyleSummaries(); 
        ctx.drawTimeline(); 
        ctx.recordHistory((d.rot ? '旋轉字幕' : '移動字幕位置')+cueSuffix(d.cue));
      }
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
        a0: Math.atan2(e.clientY-py, e.clientX-px)*180/Math.PI, moved: false };
        
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

  return {
    bind({ imageLayer, videoSub, videoWrap } = {}) {
      bindImageDomEvents(imageLayer);
      bindSubtitleDomEvents(videoSub, videoWrap);
    },
    startImageDrag,
    moveImageDrag,
    finishImageDrag,
    imageDrag: () => _imgDrag,
    subtitleDrag: () => _subDrag,
  };
}
