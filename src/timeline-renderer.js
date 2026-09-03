/* ==============================================================================
   SUB Tool — 時間軸渲染與互動模組 (Timeline Engine)
   ==============================================================================
   
   【架構與職責總覽】
   本檔案是唯一的時間軸引擎：將「時間」視覺化，並處理所有時間軸 DOM/Canvas 互動與操作。
   包含尺規 (Ruler)、音訊波形 (Waveform)、軌道容器 (Tracks)、與片段區塊 (Cues)。
   
   1. 高 DPI Canvas 渲染
      波形與尺規是透過 HTML5 Canvas 繪製。為了在不同螢幕縮放 (devicePixelRatio)
      下保持清晰度，本模組實作了物理像素與邏輯 CSS 像素的解耦，所有的 Canvas
      繪製在 `drawRuler` 與 `drawWave` 中都已包含 Scale 縮放修正。
      
   2. 座標系統轉換
      時間與像素的互轉是本模組核心 (`timeToX`, `xToTime`)。
      牽扯到 Zoom Level 的變化時，為了維持播放頭 (Playhead) 的視覺穩定，
      `layoutTimeline` 與 `setZoom` 內部處理了複雜的 Scroll Left 數學補償。
      
   3. 高效能局部重繪 (DOM 虛擬化概念)
      因為軌道上可能有數千個字幕片段，如果每次 `requestAnimationFrame` 都重繪整個 DOM
      將會嚴重卡頓。本模組實作了選擇性的狀態更新，例如透過 `updatePlayhead` 只平移
      指標，而不會觸發重新排版。

   【維護鐵律】
   - 繪製函式中 (特別是 requestAnimationFrame 的迴圈)，【絕對禁止】頻繁呼叫
     引起 Reflow 的屬性 (如 offsetWidth, clientHeight)。請改讀取緩存的 `viewportW` 變數。
============================================================================== */
import { paintClipBlocks } from './painters/clip-painter.js';
import { paintSubtitleBlocks } from './painters/subtitle-painter.js';
import { paintClipWave } from './painters/waveform-painter.js';
import { $, video, tlScroll, tlLayer, tlTracks, rulerCv } from './dom.js';
import { fitScale } from './image-compositor-engine.js'; // 「符合視窗」與匯出共用同一條 contain 公式
import { State, trackVisible, newTrack, syncTrackCount, isSel, cueSuffix, newVideoTrack, ensureVideoTrackCount, videoTrackVisible, resetVideoTracks, newId,
  setSelection, deselect, pruneSelection, focusTrackKind } from './state.js';
import { clamp, pad, escapeHTML, escapeHTMLWithSpaces } from './util.js';
import { Media, Wave } from './media.js';
import { selectCue, refreshSelectionUI, renderSubRow } from './subtitles.js';
import { sortCues, sweepContainedCues, trackLocked, cueTrackLocked } from './subtitle-model.js';
import { encoreParts, snapTimeToFrame, fmtClock, secToSRT, secToASS, secToEncore, getExactFps } from './time.js';
import { emit } from './events.js';
import { isProjectGuardDone, ensureProjectSaved } from './project.js';
import { showToast, openModal, closeModal } from './ui.js';
import { jklReset, nudge } from './keyboard.js';
import { recordHistory } from './history.js';
import { beginTimelineTrackEdit, updateTimelineTrack, ABSENT } from './timeline-edit-transaction.js';
import {
  beginTimelineGestureLifecycle,
  planCueGesturePreview,
  planClipGesturePreview,
  planAudioGesturePreview,
} from './timeline-gesture-transaction.js';
import { hideCtx, showCueMenu } from './menus.js';
import { Seq } from './sequence.js';
import { timeToX, xToTime, snapTargets, snapVal, cueNeighborBounds, requestPointerSeek } from './timeline-interaction-engine.js';
import { parseTimecodeInput, setupTimecodeInput } from './tcparse.js';
import { planCueStyleAssignment } from './subtitle-style-engine.js';
import { effStyle } from './substyle.js';

import { on as _onEvent } from './events.js';
import { selectClip, clearClipSelection } from './clip-model.js';
_onEvent('clip:blocksChanged', ()=>renderClipBlocks());

/* ===== 5. 時間軸 ====================================================== */
import * as L from './timeline-interaction-engine.js';
const { RULER_H, ROW_H } = L;

/* 影片序列：獨立視訊軌列容器（在專案音訊軌上方），與字幕軌列同一套「列＋列頭」機制。
   容器 pointer-events:none、片段本身 auto——空白處仍可拖曳捲動/框選。 */
const tlVtracks=document.getElementById('tlVtracks');
const tlAtracks=document.getElementById('tlAtracks');
function trackH(tk){ return L.trackH(State.tracks, tk); }
function _tracksHeight(){ return L.tracksHeight(State.tracks, State.trackCount); }
function yToTrack(y){ return L.yToTrack(State.tracks, State.trackCount, y); }
/* 視訊軌：數量、每軌高度、總高（無影片序列時為 0＝不佔空間，維持純字幕版面）。
   顯示由上而下：disp0＝最高軌（vtrack 最大）；vtrackTop 回傳某軌在容器內的 y。 */
function vtrackCount(){ return L.vtrackCount(State.videoTracks); }
function vtrackH(v){ return L.vtrackH(State.videoTracks, v); }
function vtracksHeight(){ return L.vtracksHeight(State.videoTracks, Seq.active(), State.vtracksCollapsed); }
function vtrackTop(v){ return L.vtrackTop(State.videoTracks, v); }
/* 補足 videoTracks 以涵蓋現有片段的最高軌（只增不減；每次全繪前呼叫，確保軌列與片段一致） */
function syncVideoTracks(){ let m=0; for(const c of State.clips) m=Math.max(m,(c.vtrack||0)+1); ensureVideoTrackCount(m); }
/* 音訊時間軸：一個匯入素材＝一條可視音訊軌；專案 A bus 只留在 mixer／配線資料。
   這樣 8 聲道素材不會在 A1～A8 複製出八張一樣的波形。右鍵可決定這條素材
   顯示 MIX 或任一來源聲道；大量素材仍以獨立捲動區避免擠掉字幕。 */
function audioRowsHeight(){ return L.audioRowsHeight(audioRowLayout()); }
/* 每列為一個實際匯入的影音／音檔 source；同一檔切成多段仍共用同一列。 */
function audioRowLayout(){
  let y0=0;
  return audioSourceLanes().map((lane,index)=>{
    const h=L.sourceAudioRowH(lane.source);
    const row={...lane,kind:'source',index,y0,h}; y0+=h; return row;
  });
}
function atracksHeight(){ return L.atracksHeight(audioRowLayout(), tlLayer?.clientHeight||tlScroll?.clientHeight||0, vtracksHeight()); }
function tracksTop(){return L.tracksTop(vtracksHeight(), atracksHeight());}
function tracksScrollTop(){ return tlTracks?tlTracks.scrollTop:0; }

function viewportW(){return tlScroll.clientWidth;}
function snapFrame(t){
  return snapTimeToFrame(t, State.fps, State.dropFrame);
}


function tlTotal(){
  const maxCueEnd=State.cues.reduce((m,c)=>c.end>m?c.end:m, 0);
  const base=Math.max(State.duration, maxCueEnd);
  const extra=Math.max(30, base*0.15);
  // 無影片且無字幕時給 10 分鐘預設空間，讓使用者可先移動播放點、新增空白字幕
  return (base > 0 ? base : 600) + extra;
}
function layoutTimeline(){
  const total=tlTotal();
  $('tlSpacer').style.width=(total*State.pxPerSec)+'px';
  const vw=viewportW();
  tlLayer.style.width=vw+'px';
  $('timelinePanel')?.style.setProperty('--timeline-ruler-height',RULER_H+'px');
  rulerCv.width=vw*devicePixelRatio; rulerCv.height=RULER_H*devicePixelRatio;
  rulerCv.style.width=vw+'px'; rulerCv.style.height=RULER_H+'px';
  const vh=vtracksHeight();
  const ah=atracksHeight();
  if(tlVtracks){ tlVtracks.style.top=RULER_H+'px'; tlVtracks.style.height=vh+'px'; tlVtracks.style.display=vh>0?'block':'none'; }
  if(tlAtracks){
    tlAtracks.style.top=(RULER_H+vh)+'px';
    tlAtracks.style.height=ah+'px';
    tlAtracks.style.display=ah>0?'block':'none';
  }
  tlTracks.style.top=tracksTop()+'px';
  const gutWave=document.querySelector('.tl-gutter-wave'); if(gutWave) gutWave.style.display='none';
  const gutA=$('tlGutterAtracks'); if(gutA){ gutA.style.height=ah+'px'; gutA.style.display=ah>0?'block':'none'; }
}
// 次刻度等分數：依 step 與 fps 動態計算，確保每個次刻度落在格邊界
function minorDiv(step){
  const fps=State.fps||25; 
  let exactFps = getExactFps(fps);
  const nf=Math.round(step*exactFps);
  if(step<1&&Math.abs(nf-step*exactFps)<0.01){
    if(nf<=1)return 1; // 1格步距：不畫次刻度
    for(const d of[5,4,3,2,1])if(nf%d===0)return d; // 最大整除數 ≤5
    return 1;
  }
  const t={1:4,2:4,5:5,10:5,15:3,30:6,60:4,120:4,300:5,600:5,1800:6,3600:6};
  return t[step]||5;
}

function drawRuler(){
  const ctx=rulerCv.getContext('2d'); const dpr=devicePixelRatio;
  ctx.save();ctx.scale(dpr,dpr);
  const vw=viewportW();
  ctx.clearRect(0,0,vw,RULER_H);
  // 中性深灰保留明確的「可點擊跳轉帶」，近白文字與兩級刻度兼顧辨識與長時間舒適度。
  ctx.fillStyle='rgb(65,65,65)';ctx.fillRect(0,0,vw,RULER_H);
  const targetPx=80;
  const step=niceStep(targetPx/State.pxPerSec);
  const t0=State.viewStart, t1=State.viewStart+vw/State.pxPerSec;
  ctx.lineWidth=1;

  // 次刻度（用整數索引避免浮點累積誤差）
  const div=minorDiv(step);
  if(div>1){
    ctx.beginPath();ctx.strokeStyle='#9299a3';
    const firstMinorIdx=Math.ceil(t0*div/step);
    for(let mi=firstMinorIdx;;mi++){
      let t=(mi*step)/div;
      t = snapFrame(t);
      if(t>t1+step/(div*2))break;
      if(mi%div===0)continue; // 主刻度位置跳過，下方另行繪製
      const x=timeToX(t); if(x<0||x>vw)continue;
      ctx.moveTo(x,RULER_H-4);ctx.lineTo(x,RULER_H);
    }
    ctx.stroke();
  }

  // 主刻度 + 時間標籤（同樣用整數索引）
  ctx.beginPath();ctx.strokeStyle='#d8dde5';
  ctx.fillStyle='#f2f4f7';ctx.font='600 11px Consolas,"Courier New",monospace';ctx.textBaseline='middle';
  const firstMajorIdx=Math.ceil(t0/step);
  for(let mi=firstMajorIdx;;mi++){
    let t=mi*step;
    t = snapFrame(t);
    if(t>t1+step*0.01)break;
    const x=timeToX(t);
    ctx.moveTo(x,RULER_H-9);ctx.lineTo(x,RULER_H);
    ctx.fillText(fmtTick(t,step),x+3,RULER_H/2);
  }
  ctx.stroke();

  // 備忘標記（可點擊橘色三角）
  if(State.notes.length){
    for(const n of State.notes){
      const nx=timeToX(n.time); if(nx<-10||nx>vw+10)continue;
      ctx.fillStyle='#f0a030';
      ctx.beginPath();ctx.moveTo(nx,RULER_H);ctx.lineTo(nx-8,RULER_H-14);ctx.lineTo(nx+8,RULER_H-14);ctx.closePath();ctx.fill();
      ctx.strokeStyle='#ffcc60';ctx.lineWidth=1;ctx.stroke();
    }
  }
  // 輸出範圍標記
  if(State.exportIn != null || State.exportOut != null){
    const inX = State.exportIn != null ? timeToX(State.exportIn) : 0;
    const outX = State.exportOut != null ? timeToX(State.exportOut) : vw;
    ctx.fillStyle = 'rgba(60, 140, 255, 0.2)';
    if (outX > inX) {
      const sx = Math.max(0, inX), ex = Math.min(vw, outX);
      if (ex > sx) ctx.fillRect(sx, 0, ex - sx, RULER_H);
    }
    ctx.strokeStyle = '#3c8cff'; ctx.lineWidth = 2;
    if(State.exportIn != null && inX >= -10 && inX <= vw + 10){
      ctx.beginPath(); ctx.moveTo(inX, 0); ctx.lineTo(inX, RULER_H); ctx.stroke();
      ctx.fillStyle = '#3c8cff';
      ctx.beginPath(); ctx.moveTo(inX, RULER_H); ctx.lineTo(inX+6, RULER_H-6); ctx.lineTo(inX, RULER_H-12); ctx.fill();
    }
    if(State.exportOut != null && outX >= -10 && outX <= vw + 10){
      ctx.beginPath(); ctx.moveTo(outX, 0); ctx.lineTo(outX, RULER_H); ctx.stroke();
      ctx.fillStyle = '#3c8cff';
      ctx.beginPath(); ctx.moveTo(outX, RULER_H); ctx.lineTo(outX-6, RULER_H-6); ctx.lineTo(outX, RULER_H-12); ctx.fill();
    }
  }
  ctx.restore();
}
function niceStep(s){ // 給定目標秒數，回傳漂亮刻度間隔（次秒用格對齊步距）
  const fps=State.fps||25;
  let exactFps = getExactFps(fps);
  const f=1/exactFps;
  // 次秒範圍：用格倍數確保刻度落在格邊界
  if(s<0.95){
    for(const n of[1,2,3,5,6,10,12,15,20,24,25,30]){
      const step=n*f; if(step>0.95)break; if(step>=s)return step;
    }
  }
  for(const v of[1,2,5,10,15,30,60,120,300,600,1800,3600])if(v>=s)return v;
  return 3600;
}
// FPS-SYNC（詳見 FPS_時碼一致性.md）：時間軸刻度標籤，依縮放層級自動選擇精度。
// 時:分:秒:格 一律走 encoreParts（與播放器同一套數影格換算），
// 確保刻度標籤與播放器時碼完全一致 —— 29.97 非DF 等漂移情況也對得上。
// 格對齊步距（step*fps≈整數 且 step<1）→ SS:FF；step>=1 → SS s / M:SS / H:MM:SS
function fmtTick(s, step){
  const fps=State.fps||25;
  const p=encoreParts(s, fps, State.dropFrame);
  // 格精度：step<1 且為格倍數（允許浮點誤差 1%）
  if(step!=null&&step<1&&Math.abs(step*fps-Math.round(step*fps))<0.01){
    const fr=pad(p.ff);
    if(p.hh>0)return`${p.hh}:${pad(p.mm)}:${pad(p.ss)}:${fr}`;
    if(p.mm>0)return`${p.mm}:${pad(p.ss)}:${fr}`;
    return`${p.ss}:${fr}`;
  }
  if(p.hh>0)return`${p.hh}:${pad(p.mm)}:${pad(p.ss)}`;
  if(p.mm>0)return`${p.mm}:${pad(p.ss)}`;
  return`${p.ss}s`;
}
/* 專案 bus 的波形是 DOM 區塊內的小 canvas；保留此入口，讓既有的縮放、捲動與媒體載入重繪路徑繼續有效。 */
function drawWave(){
  renderAudioTrackRows();
}
function renderTrackRows(){
  tlTracks.innerHTML='';
  const gut=$('tlGutterTracks'); if(gut)gut.innerHTML='';
  for(let tk=0;tk<State.trackCount;tk++){
    const vis=trackVisible(tk);
    const row=document.createElement('div');
    row.className='tl-track'+(vis?'':' hidden-tk')+(tk===State.listTrack?' tl-active':''); row.style.height=trackH(tk)+'px'; row.dataset.track=tk;
    tlTracks.appendChild(row);
    if(gut){
      const g=document.createElement('div');
      g.className='tl-gtrack'+(vis?'':' hidden-tk')+(tk===State.listTrack?' tl-active':''); g.style.height=trackH(tk)+'px'; g.dataset.track=tk;
      const isLocked=!!State.tracks[tk].locked;
      g.innerHTML=`<span class="drag-handle" title="拖曳重排">⠿</span>`+
        `<button class="eye" title="顯示/隱藏此軌">${vis?'👁':'<svg viewBox="0 0 640 512" width="13" height="13" fill="currentColor" style="vertical-align:-2px"><path d="M38.8 5.1C28.4-3.1 13.3-1.2 5.1 9.2S-1.2 34.7 9.2 42.9l592 464c10.4 8.2 25.5 6.3 33.7-4.1s6.3-25.5-4.1-33.7L525.6 386.7c39.6-40.6 66.4-86.1 79.9-118.4c3.3-7.9 3.3-16.7 0-24.6c-14.9-35.7-46.2-87.7-93-131.1C465.5 68.8 400.8 32 320 32c-68.2 0-125 26.3-169.3 60.8L38.8 5.1zM223.1 149.5C248.6 126.2 282.7 112 320 112c79.5 0 144 64.5 144 144c0 24.9-6.3 48.3-17.4 68.7L408 294.5c8.4-19.3 10.6-41.4 4.8-63.3c-11.1-41.5-47.8-69.4-88.6-71.1c-5.8-.2-9.2 6.1-7.4 11.7c2.1 6.4 3.3 13.2 3.3 20.3c0 10.2-2.4 19.8-6.6 28.3l-90.3-70.8zM373 389.9c-16.4 6.5-34.3 10.1-53 10.1c-79.5 0-144-64.5-144-144c0-6.9 .5-13.6 1.4-20.2L83.1 161.5C60.3 191.2 44 220.8 34.5 243.7c-3.3 7.9-3.3 16.7 0 24.6c14.9 35.7 46.2 87.7 93 131.1C174.5 443.2 239.2 480 320 480c47.8 0 89.9-12.9 126.2-32.5L373 389.9z"/></svg>'}</button>`+
        `<span class="gname" contenteditable="false" spellcheck="false">${escapeHTML(State.tracks[tk].name)}</span>`+
        `<button class="gdel" title="刪除此軌">✕</button>`+
        `<button class="glock${isLocked?' locked':''}" title="${isLocked?'解鎖':'鎖定'}此軌">${isLocked?'🔒':'🔓'}</button>`;
      g.querySelector('.eye').onclick=(e)=>{
        e.stopPropagation();
        updateTimelineTrack({kind:'subtitle',index:tk,field:'visible',value:!vis});
      };
      g.addEventListener('click', e => {
        if (e.target.closest('.eye,.glock,.gdel,.drag-handle') || nm.contentEditable === 'true') return;
        e.stopPropagation();
        setSelection({ kind: 'sub', ids: [] });   // 切到字幕軌並清空三種選取（互斥由 setSelection 保證）
        focusTrackKind('sub', tk);                // 焦點類別＋哪一軌一次寫入（同一條不變量）
        refreshSelectionUI();
        renderClipBlocks();
        const sel = $('listTrackSel'); if (sel) sel.value = String(tk);
        emit('render:trackStyle');
        emit('render:all');
        refreshTrackGutterActive();
        const stSel = $('stSel'); if (stSel) stSel.textContent = '已切換至字幕軌：' + (State.tracks[tk]?.name || ('軌道 ' + (tk + 1)));
      });
      const nm = g.querySelector('.gname');
      nm.addEventListener('mousedown',e=>{
        if(e.detail>=2){
          e.preventDefault(); nm.contentEditable='true'; nm.focus();
          try{const r=document.createRange(),s=window.getSelection();r.selectNodeContents(nm);s.removeAllRanges();s.addRange(r);}catch(_){}
        }
      });
      nm.onkeydown=(e)=>{ e.stopPropagation(); if(e.key==='Enter'){e.preventDefault();nm.blur();} else if(e.key==='Escape'){e.preventDefault();nm.innerText=State.tracks[tk].name;nm.blur();} };
      nm.onblur=()=>{
        nm.contentEditable='false';
        updateTimelineTrack({kind:'subtitle',index:tk,field:'name',value:nm.innerText});
      };
      g.querySelector('.glock').onclick=(e)=>{
        e.stopPropagation();
        updateTimelineTrack({kind:'subtitle',index:tk,field:'locked',value:!State.tracks[tk].locked});
      };
      g.querySelector('.gdel').onclick=(e)=>{e.stopPropagation();removeTrack(tk);};
      // 高度縮放把手
      const resH=document.createElement('div');
      resH.className='tl-resize-handle';
      resH.addEventListener('mousedown',e=>{
        e.preventDefault();e.stopPropagation();
        const now=performance.now();
        if(_lastHandleClick.tk===tk && now-_lastHandleClick.t<400){
          _lastHandleClick={tk:-1,t:0};
          updateTimelineTrack({kind:'subtitle',index:tk,field:'height',value:undefined});
          return;
        }
        _lastHandleClick={tk,t:now};
        _rowResize={type:'track',tk,startY:e.clientY,startH:trackH(tk),
          edit:beginTimelineTrackEdit({kind:'subtitle',index:tk,field:'height'})};
        document.addEventListener('mousemove',_onRowResizeMove);
        document.addEventListener('mouseup',_onRowResizeUp,{once:true});
      });
      g.appendChild(resH);
      // 拖曳重排
      g.querySelector('.drag-handle').addEventListener('mousedown',e=>{
        e.preventDefault(); e.stopPropagation();
        _trackDrag={fromTk:tk,g,gut:gut};
        g.classList.add('tl-dragging');
        document.addEventListener('mousemove',_onTrackDragMove);
        document.addEventListener('mouseup',_onTrackDragUp,{once:true});
      });
      gut.appendChild(g);
    }
  }
  if(gut)gut.scrollTop=tlTracks.scrollTop;
  renderCueBlocks();
}
function refreshTrackGutterActive(){
  const gut=$('tlGutterTracks');
  if(gut) {
    gut.querySelectorAll('.tl-gtrack').forEach(g=>{
      g.classList.toggle('tl-active', State.activeTrackKind === 'sub' && +g.dataset.track===State.listTrack);
    });
  }
  
  const vgut=$('tlGutterVtracks');
  if(vgut) {
    vgut.querySelectorAll('.vgtrack').forEach(g=>{
      g.classList.toggle('tl-active', State.activeTrackKind === 'video' && +g.dataset.vtrack===State.activeVtrack);
    });
  }
  
  const agut=$('tlGutterAtracks');
  if(agut) {
    agut.querySelectorAll('.agtrack').forEach(g=>{
      g.classList.toggle('tl-active', State.activeTrackKind === 'audio' && g.dataset.audioSourceId===String(State.activeAudioTrackId));
    });
  }
  
  tlTracks.querySelectorAll('.tl-track').forEach(r=>{
    r.classList.toggle('tl-active', State.activeTrackKind === 'sub' && +r.dataset.track===State.listTrack);
  });
}

/* 軌道拖曳重排 */
let _trackDrag=null;
function _onTrackDragMove(e){
  if(!_trackDrag)return;
  const gut=_trackDrag.gut;
  const gutRect=gut.getBoundingClientRect();
  const relY=e.clientY-gutRect.top;
  let targetTk=clamp(yToTrack(relY),0,State.trackCount-1);
  gut.querySelectorAll('.tl-gtrack').forEach((g,i)=>{
    g.classList.toggle('tl-drag-target',i===targetTk&&i!==_trackDrag.fromTk);
  });
  _trackDrag.toTk=targetTk;
}
function _onTrackDragUp(){
  document.removeEventListener('mousemove',_onTrackDragMove);
  if(!_trackDrag)return;
  const {fromTk,toTk}=_trackDrag;
  _trackDrag.g.classList.remove('tl-dragging');
  const gut=_trackDrag.gut;
  gut.querySelectorAll('.tl-gtrack').forEach(g=>g.classList.remove('tl-drag-target'));
  _trackDrag=null;
  if(toTk!==undefined && toTk!==fromTk){
    // 重排 tracks 陣列
    const [moved]=State.tracks.splice(fromTk,1);
    State.tracks.splice(toTk,0,moved);
    // 重新對應字幕的 track 索引
    for(const c of State.cues){
      const tk=c.track||0;
      if(fromTk<toTk){ if(tk===fromTk)c.track=toTk; else if(tk>fromTk&&tk<=toTk)c.track=tk-1; }
      else { if(tk===fromTk)c.track=toTk; else if(tk>=toTk&&tk<fromTk)c.track=tk+1; }
    }
    // listTrack 也用同一套規則重對應——否則列表會停在「舊索引位置」上、顯示成搬進來的另一條軌
    { const lt=State.listTrack;
      if(lt===fromTk) State.listTrack=toTk;
      else if(fromTk<toTk && lt>fromTk && lt<=toTk) State.listTrack=lt-1;
      else if(fromTk>toTk && lt>=toTk && lt<fromTk) State.listTrack=lt+1; }
    syncTrackCount(); recordHistory('軌道重排'); emit('render:all'); emit('render:listTrackSel'); drawTimeline();
  }
}

/* 軌道/波形高度拖曳縮放 */
let _rowResize=null;
let _lastHandleClick={tk:-1,t:0};
function _doResize(type,tk){
  // .cue-block uses top:4px;bottom:4px, .cue-overlap uses top:0;bottom:0 →
  // both auto-scale with row height via CSS — no renderCueBlocks() needed during drag.
  // Playhead is left-positioned, unaffected by height changes.
  if(type==='vtrack' || type==='atrack'){
    // 視訊與音訊軌高度改變會牽動整體佈局與波形繪製 → 直接整體重繪
    drawTimeline();
  }else{
    const h=trackH(tk);
    const rows=tlTracks.querySelectorAll('.tl-track'); if(rows[tk])rows[tk].style.height=h+'px';
    const gRows=$('tlGutterTracks')?.querySelectorAll('.tl-gtrack'); if(gRows&&gRows[tk])gRows[tk].style.height=h+'px';
  }
}
function _onRowResizeMove(e){
  if(!_rowResize)return;
  const {type,tk,startY,startH}=_rowResize;
  const dy=e.clientY-startY;
  if(type==='vtrack') _rowResize.edit?.preview(Math.max(24,startH+dy));
  else if(type==='atrack') _rowResize.edit?.preview(Math.max(32,startH+dy));
  else _rowResize.edit?.preview(Math.max(20,startH+dy));
  if(!_rowResize._raf){
    _rowResize._raf=requestAnimationFrame(()=>{ _rowResize&&(_rowResize._raf=null); _doResize(type,tk); });
  }
}
function _onRowResizeUp(){
  document.removeEventListener('mousemove',_onRowResizeMove);
  const resize=_rowResize;
  if(resize?._raf){ cancelAnimationFrame(resize._raf); resize._raf=null; }
  _rowResize=null;
  if(resize?.edit) resize.edit.commit();
  else drawTimeline();
}
/* 影片序列：把各段畫進「對應視訊軌列」（各軌獨立成列，比照字幕軌）。
   先在 tlVtracks 內建立每軌的列 .vtrack-row（由上而下：最高軌在最上面），再把片段放入其列。
   片段位置＝offset、寬＝修剪後長度；拖曳移動、拖邊緣修剪、右鍵選單。 */
function renderClipBlocks(){
  if(!tlVtracks) return;
  if(!Seq.active()){
    paintClipBlocks(tlVtracks, { rows: [], clips: [] });
    return;
  }
  const N = vtrackCount();
  const displayList = { rows: [], clips: [] };
  
  for(let disp=0; disp<N; disp++){
    const v = N - 1 - disp;
    displayList.rows.push({
      vtrack: v,
      top: vtrackTop(v),
      height: vtrackH(v),
      visible: videoTrackVisible(v)
    });
  }

  const vw = viewportW();
  const t0 = State.viewStart;
  const t1 = State.viewStart + vw / State.pxPerSec;

  for(const c of State.clips){
    const s = c.offset, e = Seq.clipEnd(c);
    if(e < t0 || s > t1) continue;
    const v = c.vtrack || 0;
    
    displayList.clips.push({
      id: c.id,
      vtrack: v,
      active: c.id === Media.activeClipId,
      selected: c.id === State.selectedClipId,
      locked: !!State.videoTracks[v]?.locked,
      x: timeToX(s),
      w: timeToX(e) - timeToX(s),
      trimmed: c.in > 0.01 || c.out < c.dur - 0.01,
      hasFade: c.fadeIn > 0 || c.fadeOut > 0,
      isImg: c.type === 'image',
      name: c.name,
      escapedName: escapeHTML(c.name || ''),
      trackName: State.videoTracks[v]?.name || ('視訊軌 V' + (v+1)),
      timeRangeStr: secToEncore(s, State.fps, State.dropFrame) + ' → ' + secToEncore(e, State.fps, State.dropFrame),
      inStr: Number(c.in).toFixed(2),
      outStr: Number(c.out).toFixed(2),
      durStr: Number(c.dur).toFixed(2)
    });
  }
  paintClipBlocks(tlVtracks, displayList);
}
/* 在片段區塊內畫該段音波：畫布覆蓋片段的【可視範圍】，x0abs＝畫布左緣的絕對時間軸 px；
   逐畫布像素以 xToTime 反推來源時間 → 取 peaks（縮放時畫布寬≤視窗，不會超過 canvas 上限）。 */
function _drawClipWave(cv, c, pk, cvw, Hpx, x0abs){
  const res = Wave.resolution, n = pk.length / 2;
  const timeToXMap = new Float64Array(cvw + 1);
  for (let cx = 0; cx <= cvw; cx++) {
    timeToXMap[cx] = c.in + (xToTime(x0abs + cx) - c.offset);
  }
  
  const displayList = {
    Hpx, cvw, res, n, pk, 
    startIn: c.in, startOffset: c.offset, x0abs,
    dpr: devicePixelRatio,
    timeToXMap
  };
  paintClipWave(cv.getContext('2d'), displayList);
}
/* ===== 專案音訊 bus（來源路由＋時間軸） ==================================
   clip.audioSourceId 是可儲存的來源識別；audioSrc 是舊版即時播放識別，兩者並存時以前者為準。
   sourceMaps[sourceId].channels 的每一筆可將一個來源聲道送到多個 bus。 */
function clipAudioSourceId(c){
  if(!c) return null;
  return c.audioSourceId || c.audioSrc || (c.primary ? 'video' : ('clip:'+c.id));
}
/* audioSourceId 是專案檔中穩定的配線 ID，audioSrc 才是目前播放器內
   Media.tracks 使用的 source ID。時間軸上的喇叭需要操作後者；遇到舊專案或
   尚在載入中的來源時，依序嘗試所有合理的 runtime ID，避免按鈕變成裝飾。 */
function runtimeAudioSourceId(source,fallbackSourceId=null){
  const candidates=[
    source?.audioSrc,
    source?.source,
    source?.primary ? 'video' : null,
    source?.id && !String(source.id).startsWith('external:') ? ('clip:'+source.id) : null,
    fallbackSourceId
  ].filter((id,index,list)=>typeof id==='string'&&id&&list.indexOf(id)===index);
  if(typeof Media?.sourceChannels==='function'){
    for(const id of candidates){
      try{ if(Media.sourceChannels(id).length) return id; }catch(_){}
    }
  }
  return candidates[0]||null;
}
function timelineSourceMuted(source,external,fallbackSourceId=null){
  if(external) return source?.enabled===false;
  if(source?.muted) return true;
  const runtimeId=runtimeAudioSourceId(source,fallbackSourceId);
  try{ return !!(runtimeId&&typeof Media?.sourceMuted==='function'&&Media.sourceMuted(runtimeId)); }
  catch(_){ return false; }
}
function muteButtonMarkup(muted,scope='素材'){
  const action=muted?'開啟':'關閉';
  const title=`${action}此${scope}聲音（目前${muted?'已關閉':'已開啟'}）`;
  return `<button type="button" class="audio-clip-mute${muted?' on':''}" aria-pressed="${muted?'true':'false'}" aria-label="${title}" title="${title}">${muted?'🔇':'🔊'}</button>`;
}
function toggleTimelineSourceMute(source,{external=false,fallbackSourceId=null,select=false}={}){
  if(external){
    if(select) selectExternalAudioClip(source.id,{redraw:false});
    return runExternalAudioAction('toggleExternalAudioEnabled',[source.id]);
  }
  const runtimeId=runtimeAudioSourceId(source,fallbackSourceId);
  let channels=[];
  try{ channels=runtimeId&&typeof Media?.sourceChannels==='function' ? Media.sourceChannels(runtimeId) : []; }catch(_){}
  if(!runtimeId||!channels.length||typeof Media?.toggleSourceMute!=='function'){
    showToast('此素材的音訊仍在準備中');
    return false;
  }
  Media.toggleSourceMute(runtimeId);
  drawTimeline();
  return true;
}
function openAudioRoutingForSource(source){
  if(!source) return;
  const isExternal=source.kind==='external-audio';
  const detail={
    ...(isExternal?{}:{clipId:source.id}),
    audioSourceId:clipAudioSourceId(source),
    audioSrc:source.audioSrc||null
  };
  const routing=typeof window!=='undefined' ? window.AudioRouting : null;
  if(routing){
    if(isExternal && typeof routing.openForSource==='function'){
      routing.openForSource(detail.audioSourceId); return;
    }
    if(!isExternal && typeof routing.openForClip==='function'){
      routing.openForClip(source.id); return;
    }
  }
  if(typeof window!=='undefined' && typeof window.CustomEvent==='function'){
    window.dispatchEvent(new CustomEvent('audio-routing:open',{detail}));
  }
}
function openAudioRoutingForClip(c){ openAudioRoutingForSource(c); }
function externalAudioTimelineEntries(){
  const assets=Media.externalAudio?.list?.() || [];
  // 靜音只影響預覽／輸出，不能把素材從剪輯時間軸藏掉；否則使用者無法再開回來。
  return assets.filter(asset=>asset).map(asset=>{
    const start=Math.max(0,Number(asset.offset)||0);
    const inPoint=Math.max(0,Number(asset.in)||0);
    const rawOut=Number(asset.out??asset.duration);
    const outPoint=Number.isFinite(rawOut)?Math.max(inPoint,rawOut):inPoint;
    return {source:asset,start,end:start+Math.max(0,outPoint-inPoint),external:true};
  }).filter(entry=>entry.end>entry.start);
}
function audioTimelineEntries(){
  return [
    // 已解除影音連結的影片只保留畫面；它的聲音已成為可獨立編輯的 external audio block。
    ...State.clips.filter(clip=>!clip.audioDetached && clip.type !== 'image').map(clip=>({source:clip,start:clip.offset,end:Seq.clipEnd(clip),external:false})),
    ...externalAudioTimelineEntries()
  ];
}
function audioSourceLanes(){
  const lanes=new Map();
  let orderCounter=0;
  for(const entry of audioTimelineEntries()){
    const source=entry.source;
    const sourceId=clipAudioSourceId(source);
    if(!sourceId) continue;
    // 一個外部音檔被切開後，為了能讓兩段同時播放，runtime 會給每段獨立的
    // audioSourceId／AudioElement；但在剪輯介面上它們仍應留在同一條「素材列」。
    // timelineLaneId 只影響顯示分列，不影響來源聲道路由或輸出。
    const laneId=entry.external && source.timelineLaneId ? String(source.timelineLaneId) : sourceId;
    let lane=lanes.get(laneId);
    if(!lane){
      lane={
        laneId,
        sourceId,
        source,
        height: source.height,
        external:!!entry.external,
        label:source.name||(entry.external?'外部音檔':'影音素材'),
        order: orderCounter++,
        entries:[]
      };
      lanes.set(laneId,lane);
    }
    lane.entries.push(entry);
  }
  return [...lanes.values()].sort((a,b)=>a.order-b.order);
}
function sourceWaveFallback(source,external){
  if(source?.peaks) return source.peaks;
  if(!external&&(source?.primary||source?.audioSrc==='video'||source?.audioSourceId==='video')) return Wave.peaks||null;
  return null;
}
function sourceWaveDetail(source,external){
  const fallback=sourceWaveFallback(source,external);
  if(typeof Wave.getSourceWaveform==='function') return Wave.getSourceWaveform(source,fallback);
  return {peaks:fallback,selection:'mix',fallback:false};
}
function sourceWaveLabel(source,selection){
  if(typeof Wave.getSourceWaveOptions!=='function') return selection==='mix'?'MIX':'Ch';
  const option=Wave.getSourceWaveOptions(source).find(item=>item.id===selection);
  return option?.label||'MIX（所有聲道）';
}
/* 外部音檔是可獨立剪輯的素材。selectedAudioClipId 只保存 runtime 選取狀態，
   不與影片 clip / 字幕選取混用，讓 Delete 與右鍵操作可明確知道目標。 */
let _ignoreAudioClickUntil=0;
function selectExternalAudioClip(assetId,{seek=false,redraw=true}={}){
  if(!assetId) return;
  setSelection({ kind:'audio', ids:assetId });
  refreshSelectionUI();
  const asset=Media.externalAudio?.get?.(assetId) || null;
  if(asset) focusTrackKind('audio', asset.audioSourceId || asset.audioSrc || asset.id);
  refreshTrackGutterActive();
  const label=asset?.name||'音訊素材';
  const status=$('stSel'); if(status) status.textContent='已選音訊：'+label;
  if(seek&&asset) Media.seek(Math.max(0,Number(asset.offset)||0));
  if(redraw) drawTimeline();
}
function runExternalAudioAction(method,args=[],{clearSelection=false}={}){
  const fn=Media?.[method];
  if(typeof fn!=='function'){
    showToast('音訊素材編輯功能尚未準備完成');
    return false;
  }
  let result;
  try{ result=fn.apply(Media,args); }
  catch(err){ console.warn('external audio '+method+':',err); showToast('無法更新音訊素材'); return false; }
  Promise.resolve(result).then(value=>{
    if(value===false||value==null){ drawTimeline(); return; }
    if(clearSelection) deselect('audio');
    drawTimeline();
    emit('render:videoSub'); emit('mpv:refreshSubs');
  }).catch(err=>{
    console.warn('external audio '+method+':',err);
    showToast('無法更新音訊素材');
  });
  return true;
}
function seekLockedMediaAtClientX(clientX){
  const rect=tlLayer.getBoundingClientRect();
  requestPointerSeek(xToTime(clientX-rect.left));
  updatePlayhead();
  emit('render:videoSub');
}
function beginLockedMediaScrub(ev){
  if(drag) cancelTimelineDrag();
  seekLockedMediaAtClientX(ev.clientX);
  drag={
    mode:'scrub',
    snaps:[],
    gesture:beginRendererGesture('scrub',{context:{
      startPoint:{x:ev.clientX,y:ev.clientY},
      modifiers:{alt:ev.altKey,ctrl:ev.ctrlKey||ev.metaKey,shift:ev.shiftKey},
    }}),
  };
  ev.preventDefault();
  ev.stopPropagation();
}
function beginExternalAudioDrag(ev,asset,entry,block){
  if(ev.button!==0 || ev.target.closest('button')) return;
  if(drag) cancelTimelineDrag();
  const assetId=asset?.id||asset?.audioSourceId||asset?.audioSrc;
  if(!assetId) return;
  const mode=ev.target.classList.contains('edge')
    ? (ev.target.classList.contains('l')?'audio-l':'audio-r') : 'audio-move';
  selectExternalAudioClip(assetId,{redraw:false});
  block.classList.add('selected');
  const inPoint=Math.max(0,Number(asset.in)||0);
  const rawOut=Number(asset.out??asset.duration);
  const outPoint=Math.max(inPoint,Number.isFinite(rawOut)?rawOut:inPoint);
  drag={
    mode, audioAssetId:assetId, audioEl:block,
    pointerId:block._audioPointerId,
    startX:ev.clientX,startY:ev.clientY,startScroll:tlScroll.scrollLeft,
    os:entry.start,oin:inPoint,oout:outPoint,duration:Math.max(outPoint,Number(asset.duration)||0),
    preview:{offset:entry.start,in:inPoint,out:outPoint},
    snaps:snapTargets(new Set()),
    gesture:beginRendererGesture(mode,{context:{
      startPoint:{x:ev.clientX,y:ev.clientY},
      modifiers:{alt:ev.altKey,ctrl:ev.ctrlKey||ev.metaKey,shift:ev.shiftKey},
    }}),
  };
  jklReset();
  ev.preventDefault(); ev.stopPropagation();
}
function renderAudioTrackRows(){
  if(!tlAtracks) return;
  const rows=audioRowLayout();
  const oldScroll=tlAtracks.scrollTop;
  tlAtracks.innerHTML='';
  if(!rows.length) return;


  const content=document.createElement('div');
  content.className='audio-project-content';
  content.style.height=audioRowsHeight()+'px';
  tlAtracks.appendChild(content);

  const vw=viewportW(), t0=State.viewStart, t1=State.viewStart+vw/State.pxPerSec;
  for(const row of rows){
    const {sourceId,h}=row;
    const rowEl=document.createElement('div');
    rowEl.className='audio-project-row'+(row.source?.locked?' locked':'');
    rowEl.style.height=h+'px'; rowEl.dataset.audioSourceId=sourceId;
    rowEl.dataset.audioKind=row.external?'external':'clip';
    rowEl.dataset.audioAssetId=row.external?(row.source?.id||row.source?.audioSourceId||row.source?.audioSrc||''):'';
    rowEl.dataset.clipId=row.external?'':(row.source?.id||'');
    rowEl.dataset.audioSrc=row.source?.audioSrc||'';
    rowEl.dataset.audioSourceName=row.label||row.source?.name||'';
    content.appendChild(rowEl);
    for(const entry of row.entries){
      const c=entry.source;
      const {external}=entry;
      const s=entry.start, e=entry.end;
      if(e<t0||s>t1) continue;
      const x1=timeToX(s), x2=timeToX(e);
      const muted=timelineSourceMuted(c,external,sourceId);
      const externalSelected=external&&State.selectedAudioClipId===c.id;
      const block=document.createElement('div');
      const isLocked=!!c.locked;
      block.className='audio-clip-block'+(external?' external-audio-block':'')+(!external&&c.id===State.selectedClipId?' selected':'')+(external&&(externalSelected||Media.activeSource===c.audioSrc)?' selected':'')+(muted?' muted':'')+(isLocked?' locked':'');
      block.style.left=x1+'px'; block.style.width=Math.max(6,x2-x1)+'px';
      block.dataset.clipId=c.id||'';
      block.dataset.audioAssetId=external?(c.id||c.audioSourceId||c.audioSrc||''):'';
      block.dataset.audioSourceId=clipAudioSourceId(c)||'';
      block.dataset.audioSrc=c.audioSrc||'';
      block.dataset.audioKind=external?'external':'clip';
      block.dataset.audioStart=String(s);
      block.dataset.audioEnd=String(e);
      block.dataset.audioEnabled=String(!muted);
      block.dataset.audioSourceName=c.name||row.label||'';
      const wave=sourceWaveDetail(c,external);
      block.dataset.waveSelection=wave.selection||'mix';
      block.innerHTML=`${external?'<div class="edge l" title="修剪音訊開頭"></div>':''}<span class="audio-clip-label">${escapeHTML(c.name||'')}</span>${external?'<div class="edge r" title="修剪音訊結尾"></div>':''}`;
      const peak=wave.peaks;
      if(peak && peak.length){
        const vx0=Math.max(0,x1), vx1=Math.min(vw,x2), cvw=Math.round(vx1-vx0);
        if(cvw>=1){
          const Hpx=Math.max(10,h-6);
          const cv=document.createElement('canvas'); cv.className='audio-clip-wave';
          cv.width=Math.max(1,Math.round(cvw*devicePixelRatio)); cv.height=Math.max(1,Math.round(Hpx*devicePixelRatio));
          cv.style.left=(vx0-x1)+'px'; cv.style.width=cvw+'px';
          _drawClipWave(cv,c,peak,cvw,Hpx,vx0);
          block.insertBefore(cv,block.firstChild);
        }
      }
      // 音檔拖到區塊外（甚至快速移過其他 DOM）時仍保有事件目標，避免拖曳中途失效。
      if(external){
        block.addEventListener('pointerdown',ev=>{
          if(ev.button!==0||ev.target.closest('button')) return;
          if(c.locked) return;
          try{ block.setPointerCapture(ev.pointerId); block._audioPointerId=ev.pointerId; }catch(_){}
        });
      }
      block.addEventListener('mousedown',ev=>{
        if(c.locked){
          beginLockedMediaScrub(ev);
          return;
        }
        if(external){ beginExternalAudioDrag(ev,c,entry,block); return; }
        ev.stopPropagation();
      });
      block.addEventListener('click',ev=>{
        if(performance.now()<_ignoreAudioClickUntil) return;
        ev.preventDefault();
        if(c.locked){ ev.stopPropagation(); return; }
        if(external) selectExternalAudioClip(c.id);
        else selectClip(c.id);
        if(!external) renderAudioTrackRows();
      });
      rowEl.appendChild(block);
    }
  }
  tlAtracks.scrollTop=oldScroll;
}
/* 由 tlVtracks 內的 y 座標推算滑鼠所在的 vtrack（由上而下逐列量測，支援各軌不同高度） */
function clipTrackFromY(clientY){
  if(!tlVtracks) return 0;
  const rect=tlVtracks.getBoundingClientRect();
  const N=vtrackCount();
  let y=clientY-rect.top; if(y<0)y=0;
  let acc=0;
  for(let disp=0; disp<N; disp++){ const v=N-1-disp; const h=vtrackH(v); if(y<acc+h) return v; acc+=h; }
  return 0; // 落在最底層
}

/* 視訊軌列頭：只處理影像軌的可見、鎖定與排序；音訊 M/S/音量已移到中間的專案 bus 區。 */
function renderVtrackGutter(){
  const gut=$('tlGutterVtracks'); if(!gut) return;
  const toggle=$('btnToggleVtracks');
  if(toggle) toggle.style.opacity=State.vtracksCollapsed?'0.4':'1';
  gut.innerHTML='';
  if(!Seq.active() || State.vtracksCollapsed) { gut.style.display = 'none'; return; }
  gut.style.display = 'block';
  const N=vtrackCount();
  for(let disp=0; disp<N; disp++){
    const v=N-1-disp;
    const meta=State.videoTracks[v]||(State.videoTracks[v]={name:'視訊軌 '+(v+1),visible:true,locked:false});
    const vis=videoTrackVisible(v);
    const g=document.createElement('div');
    g.className='vgtrack'+(vis?'':' hidden-tk'); g.style.height=vtrackH(v)+'px'; g.dataset.vtrack=v;
    const isLocked = !!meta.locked;
    const lockBtn = `<button class="glock${isLocked?' locked':''}" title="${isLocked?'解鎖此軌':'鎖定此軌（禁止移動／修剪／切割／選取片段）'}">${isLocked?'🔒':'🔓'}</button>`;
    g.innerHTML=`<div class="vgrow1">`+
        `<span class="vlabel">V${v+1}</span>`+
        `<button class="eye" title="顯示/隱藏此軌（預覽）">${vis?'👁':'🚫'}</button>`+
        `<span class="gname" contenteditable="false" spellcheck="false" title="${escapeHTML(meta.name)}">${escapeHTML(meta.name)}</span>`+
        `<button class="gadd" title="在上方新增軌">＋</button>`+
        `<button class="gdel" title="刪除此軌">✕</button>`+
        lockBtn+
      `</div>`;
    g.addEventListener('click', e => {
      if (e.target.closest('.eye,.glock,.gdel,.gadd') || g.querySelector('.gname')?.contentEditable === 'true') return;
      setSelection({ kind: 'video', ids: [] });
      focusTrackKind('video', v);
      refreshSelectionUI();
      renderClipBlocks();
      renderAudioTrackRows();
      refreshTrackGutterActive();
      const stSel = $('stSel'); if (stSel) stSel.textContent = '已切換至視訊軌：' + (meta.name || ('視訊軌 ' + (v + 1)));
    });
    g.querySelector('.eye').onclick=(e)=>{
      e.stopPropagation();
      updateTimelineTrack({kind:'video',index:v,field:'visible',value:!vis});
    };
    const nm=g.querySelector('.gname');
    nm.addEventListener('mousedown',e=>{
      if(e.detail>=2){ e.preventDefault(); nm.contentEditable='true'; nm.focus();
        try{const r=document.createRange(),s=window.getSelection();r.selectNodeContents(nm);s.removeAllRanges();s.addRange(r);}catch(_){}
      }
    });
    nm.onkeydown=(e)=>{ e.stopPropagation(); if(e.key==='Enter'){e.preventDefault();nm.blur();} else if(e.key==='Escape'){e.preventDefault();nm.innerText=meta.name;nm.blur();} };
    nm.onblur=()=>{
      nm.contentEditable='false';
      updateTimelineTrack({kind:'video',index:v,field:'name',value:nm.innerText});
    };
    g.querySelector('.glock').onclick=(e)=>{
      e.stopPropagation();
      updateTimelineTrack({kind:'video',index:v,field:'locked',value:!meta.locked});
    };
    g.querySelector('.gadd').onclick=(e)=>{ e.stopPropagation(); addVideoTrack(v+1); };
    g.querySelector('.gdel').onclick=(e)=>{ e.stopPropagation(); removeVideoTrack(v); };
    const resH=document.createElement('div');
    resH.className='tl-resize-handle';
    resH.addEventListener('mousedown',e=>{
      e.preventDefault();e.stopPropagation();
      const now=performance.now();
      if(_lastHandleClick.tk==='v'+v && now-_lastHandleClick.t<400){
        _lastHandleClick={tk:-1,t:0};
        updateTimelineTrack({kind:'video',index:v,field:'height',value:undefined});
        return;
      }
      _lastHandleClick={tk:'v'+v,t:now};
      _rowResize={type:'vtrack',tk:v,startY:e.clientY,startH:vtrackH(v),
        edit:beginTimelineTrackEdit({kind:'video',index:v,field:'height'})};
      document.addEventListener('mousemove',_onRowResizeMove);
      document.addEventListener('mouseup',_onRowResizeUp,{once:true});
    });
    g.appendChild(resH);
    gut.appendChild(g);
  }
}
/* 在指定索引插入一條新視訊軌（idx＝插入位置；原本 vtrack≥idx 的片段整體上移一軌） */
function addVideoTrack(idx){
  idx=clamp(idx==null?State.videoTracks.length:idx, 0, State.videoTracks.length);
  State.videoTracks.splice(idx,0,newVideoTrack());
  for(const c of State.clips){ if((c.vtrack||0)>=idx) c.vtrack=(c.vtrack||0)+1; }
  Seq.sort(); drawTimeline(); recordHistory('新增視訊軌'); emit('render:videoSub');
}
/* 刪除指定視訊軌（連同其片段）；畫面列至少保留一軌，但主影片素材本身可被刪除。 */
function removeVideoTrack(v){
  if(State.videoTracks.length<=1){ showToast('至少保留一條視訊軌'); return; }
  const clipsOn=State.clips.filter(c=>(c.vtrack||0)===v);
  const doRemove=()=>{
    for(const c of clipsOn) Media.removeClip(c.id);         // removeClip 會處理 Seq 與音軌清理
    for(const c of State.clips){ if((c.vtrack||0)>v) c.vtrack=(c.vtrack||0)-1; } // 上方軌下移一軌
    State.videoTracks.splice(v,1);
    if(!State.videoTracks.length) resetVideoTracks();
    Seq.sort(); Seq.recomputeDuration();
    drawTimeline(); recordHistory('刪除視訊軌'); emit('render:videoSub'); emit('mpv:refreshSubs');
  };
  if(clipsOn.length){
    openModal(`刪除視訊軌「${escapeHTML(State.videoTracks[v].name)}」`,
      `<p>此視訊軌有 <b>${clipsOn.length}</b> 段影片，刪除後一併移除。確定繼續？</p>`,
      [{label:'取消',act:closeModal},
       {label:'確定刪除',primary:true,act:()=>{ closeModal(); doRemove(); }}]);
  } else doRemove();
}

/* 圖片大小與位置（v4.7）：預覽拖曳之外的數值備援。
   ── 之前唯一入口是在預覽畫面拖四角把手，一旦把手抓不到（框畫錯、被播放列蓋住…）
      就完全無法調整。數值輸入不依賴任何命中測試，永遠可用，也方便精確對位。
   ── 單位刻意用「％」：scale 是相對輸出畫框的比例，位置是畫面上的百分比座標，
      與匯出 filtergraph（electron/main.js 圖片分支）同一組語意。 */
/* 大小與位置（圖片與影片共用）。v5.7.0 起影片也適用：
   逐片段幾何在匯出（export-plan.js）、WebCodecs 合成器（decode/player.js）
   三路都已支援，所以這個對話框對影片不再是空的。 */
/* 素材音訊列頭：每個檔案只出現一次；M/S/音量是 project bus 的 mixer 職責。
   右側 block 的右鍵選單切換波形後，這裡同步顯示目前的 MIX / Ch 選擇。 */
function renderAtrackGutter(){
  const gut=$('tlGutterAtracks'); if(!gut) return;
  const rows=audioRowLayout();
  const oldScroll=gut.scrollTop;
  gut.innerHTML='';
  if(!rows.length) return;

  for(const row of rows){
    const g=document.createElement('div');
    const source=row.source;
    const waveSelection=typeof Wave.getSourceWaveSelection==='function'
      ? Wave.getSourceWaveSelection(source) : 'mix';
    const waveLabel=sourceWaveLabel(source,waveSelection);
    const muted=timelineSourceMuted(source,row.external,row.sourceId);
    const selected=row.external&&State.selectedAudioClipId===source.id;
    const isLocked=!!source.locked;
    g.className='agtrack'+(row.external?' external-audio-gutter':'')+(muted?' muted':'')+(selected?' selected':'')+(isLocked?' locked':'');
    g.style.height=row.h+'px';
    g.dataset.audioSourceId=row.sourceId;
    g.dataset.audioAssetId=row.external?(source.id||source.audioSourceId||source.audioSrc||''):'';
    g.dataset.audioKind=row.external?'external':'clip';
    g.dataset.clipId=row.external?'':(source.id||'');
    g.dataset.audioSrc=source.audioSrc||'';
    g.dataset.audioSourceName=row.label||source.name||'';
    g.title=`${row.label}\n聲音：${muted?'已關閉':'已開啟'}（點喇叭按鈕切換）\n波形：${waveLabel}\n在右側素材區塊按右鍵切換 MIX／來源聲道`;
    g.innerHTML=`<span class="alabel">S${row.index+1}</span>`+
      muteButtonMarkup(muted,row.external?'音檔':'影音素材')+
      `<span class="aname" title="${escapeHTML(row.label)}">${escapeHTML(row.label)}</span>`+
      `<span class="audio-clip-route">${escapeHTML(waveLabel)}</span>`+
      `<button class="alock${isLocked?' locked':''}" title="${isLocked?'解鎖此軌':'鎖定此軌'}">${isLocked?'🔒':'🔓'}</button>`;
    g.addEventListener('click', ev => {
      if (ev.target.closest('.audio-clip-mute,.alock')) return;
      setSelection({ kind: 'audio', ids: [] });
      focusTrackKind('audio', row.sourceId);
      refreshSelectionUI();
      renderClipBlocks();
      renderAudioTrackRows();
      refreshTrackGutterActive();
      const stSel = $('stSel'); if (stSel) stSel.textContent = '已切換至音訊軌：' + row.label;
    });
    const mute=g.querySelector('.audio-clip-mute');
    mute?.addEventListener('mousedown',ev=>{ ev.preventDefault(); ev.stopPropagation(); });
    mute?.addEventListener('click',ev=>{
      ev.preventDefault(); ev.stopPropagation();
      toggleTimelineSourceMute(source,{external:row.external,fallbackSourceId:row.sourceId,select:row.external});
    });
    const lockBtn=g.querySelector('.alock');
    lockBtn?.addEventListener('mousedown',ev=>{ ev.preventDefault(); ev.stopPropagation(); });
    lockBtn?.addEventListener('click',ev=>{
      ev.preventDefault(); ev.stopPropagation();
      const newState=!source.locked;
      if(row.external){
        Media.setExternalAudioLocked(row.sourceId, newState);
      } else {
        for(const c of State.clips){
          if(clipAudioSourceId(c)===row.sourceId){
            c.locked=newState;
          }
        }
        source.locked=newState;
      }
      recordHistory((newState?'鎖定':'解鎖')+'音訊軌：'+row.label);
      drawTimeline();
    });

    // 高度縮放把手
    const resH=document.createElement('div');
    resH.className='tl-resize-handle';
    resH.addEventListener('mousedown',e=>{
      e.preventDefault(); e.stopPropagation();
      const now=performance.now();
      const applyAudioHeight = (val) => {
        if (row.external) {
          Media.setExternalAudioHeight(row.sourceId, val === ABSENT ? undefined : val);
        } else {
          for (const c of State.clips) {
            if (clipAudioSourceId(c) === row.sourceId) {
              if (val === ABSENT) delete c.height;
              else c.height = val;
            }
          }
        }
      };
      if(_lastHandleClick.tk===row.sourceId && now-_lastHandleClick.t<400){
        _lastHandleClick={tk:-1,t:0};
        updateTimelineTrack({
          kind:'audio',
          id:row.sourceId,
          field:'height',
          value:undefined,
          onApply:applyAudioHeight
        });
        drawTimeline(); return;
      }
      _lastHandleClick={tk:row.sourceId,t:now};
      const audioTarget = row.external
        ? (Media.externalAudio?.find?.(row.sourceId) || source)
        : source;
      _rowResize={
        type:'atrack',
        tk:row.sourceId,
        startY:e.clientY,
        startH:row.h,
        edit:beginTimelineTrackEdit({
          kind:'audio',
          id:row.sourceId,
          field:'height',
          target:audioTarget,
          onApply:applyAudioHeight
        })
      };
      document.addEventListener('mousemove',_onRowResizeMove);
      document.addEventListener('mouseup',_onRowResizeUp,{once:true});
    });
    g.appendChild(resH);

    gut.appendChild(g);
  }
  gut.scrollTop=oldScroll;
}
/* 右側 bus 波形與左側控制列各自捲動，但必須保持同一列對齊。 */
let _syncingAudioScroll=false;
function syncAudioScroll(from,to){
  if(_syncingAudioScroll || !from || !to) return;
  _syncingAudioScroll=true; to.scrollTop=from.scrollTop; _syncingAudioScroll=false;
}
if(tlAtracks){
  tlAtracks.addEventListener('scroll',()=>syncAudioScroll(tlAtracks,$('tlGutterAtracks')),{passive:true});
}
const _audioGutter=$('tlGutterAtracks');
if(_audioGutter){
  _audioGutter.addEventListener('scroll',()=>syncAudioScroll(_audioGutter,tlAtracks),{passive:true});
}
function renderCueBlocks(){
  renderClipBlocks();
  const rows = [...tlTracks.querySelectorAll('.tl-track')];
  const vw = viewportW();
  const t0 = State.viewStart, t1 = State.viewStart + vw / State.pxPerSec;
  
  const displayList = { cues: [], overlaps: [] };
  const byTrack = new Map();
  const trackIndices = new Map();
  const trackTotals = new Map();
  
  for(const c of State.cues){
    const tk = c.track || 0;
    trackTotals.set(tk, (trackTotals.get(tk) || 0) + 1);
  }
  
  for(const c of State.cues){
    const tk = c.track || 0;
    let idx = trackIndices.get(tk) || 0;
    trackIndices.set(tk, idx + 1);
    const cueIndex = idx + 1;

    if(c.timed === false) continue;
    let arr = byTrack.get(tk);
    if(!arr){ arr = []; byTrack.set(tk, arr); }
    arr.push(c);
    
    if(c.end < t0 || c.start > t1) continue;
    
    displayList.cues.push({
      id: c.id,
      track: tk,
      selected: isSel(c.id),
      selectedMulti: isSel(c.id) && State.selectedIds.length > 1,
      primary: c.id === State.selectedId,
      x: timeToX(c.start),
      w: timeToX(c.end) - timeToX(c.start),
      hasStyle: !!c.style,
      htmlText: escapeHTMLWithSpaces(c.text || '').replace(/\n/g, '<br>'),
      cueIndex: cueIndex,
      isLast: cueIndex === trackTotals.get(tk)
    });
  }
  
  for(const [tk, tc] of byTrack){
    tc.sort((a,b) => a.start - b.start);
    for(let i=0; i<tc.length-1; i++){
      for(let j=i+1; j<tc.length; j++){
        if(tc[j].start >= tc[i].end - 0.001) break;
        const os = tc[j].start, oe = Math.min(tc[i].end, tc[j].end);
        if(oe <= t0 || os >= t1) continue;
        const vs = Math.max(os, t0), ve = Math.min(oe, t1);
        
        displayList.overlaps.push({
          track: tk,
          x: timeToX(vs),
          w: timeToX(ve) - timeToX(vs),
          id1: tc[i].id,
          id2: tc[j].id
        });
      }
    }
  }
  
  paintSubtitleBlocks(rows, displayList);
}
/* y 座標 -> 軌道索引（含垂直捲動位移） */



/* 把選取的字幕移到指定軌道（或位移 delta） */


function updatePlayhead(){
  let t = Media.displayTime();
  const x=timeToX(t);
  $('tlPlayhead').style.left=x+'px';
  if(State.inPoint!=null){ const ip=$('tlInpoint'); ip.style.display='block'; ip.style.left=timeToX(State.inPoint)+'px'; }
  else $('tlInpoint').style.display='none';
}
function drawTimeline(){
  syncVideoTracks(); layoutTimeline(); drawRuler(); drawWave(); renderVtrackGutter(); renderAtrackGutter(); renderTrackRows(); updatePlayhead();
}
/* 時間軸捲動 */
tlScroll.addEventListener('scroll',()=>{
  State.viewStart=tlScroll.scrollLeft/State.pxPerSec;
  drawRuler();drawWave();
  // 重新定位 layer 內容（sticky 已固定，重畫即可）
  tlTracks.style.left='0px';
  renderCueBlocks();updatePlayhead();
},{passive:true});

/* 時間軸縮放 */




/* 點擊任何地方都會確認正在編輯的軌道名稱（capture 階段先於 preventDefault） */
document.addEventListener('mousedown',e=>{
  const gn=document.querySelector('.gname[contenteditable="true"]');
  if(gn&&!gn.contains(e.target)) gn.blur();
},true);

/* 時間軸滑鼠互動：時間尺拖曳=移動播放點 / 軌道空白拖曳=框選 / 拖區塊=移動換軌或縮放 */
let drag=null;
let _noteClickState=null; // 備註標記雙擊偵測 { id, t }

/* Gesture module 擁有 start／preview／commit／cancel 的順序；這裡只提供
   timeline 專屬的 model 與 DOM adapters。 */
function beginRendererGesture(mode,{targets=[],context={}}={}){
  return beginTimelineGestureLifecycle({
    mode,targets,context,
    effects:{
      clearSnapGuide:()=>updateSnapGuide(null),
      stopAutoScroll:stopTimelineAutoScroll,
      hideRubberBand:()=>{ $('tlRubber').style.display='none'; },
      releaseAudioPointer:pending=>{
        try{
          if(pending.pointerId!=null&&pending.audioEl?.hasPointerCapture?.(pending.pointerId)) pending.audioEl.releasePointerCapture(pending.pointerId);
        }catch(_){ }
      },
      restoreClipMapping:()=>{
        Seq.sort(); Seq.recomputeDuration();
        Media.seek(Math.min(Media.displayTime(),State.duration||0));
      },
      redraw:drawTimeline,
      refreshPreview:()=>{ emit('render:videoSub'); emit('mpv:refreshSubs'); },
      refreshSelection:refreshSelectionUI,
    },
  });
}

tlScroll.addEventListener('mousedown',e=>{
  if(e.button!==0)return;
  if(drag) cancelTimelineDrag();
  hideCtx();
  /* 影片序列區塊：拖曳=移動 offset、拖左右邊緣=修剪 in/out（不可與相鄰影片重疊） */
  const clipEl=e.target.closest('.clip-block');
  if(clipEl){
    const c=Seq.byId(clipEl.dataset.clipId); if(!c)return;
    if(State.videoTracks[c.vtrack||0]?.locked){
      beginLockedMediaScrub(e);
      return;
    } // 鎖定軌：保留選取、不允許編輯，但仍可點擊定位播放點
    const mode=e.target.classList.contains('edge')?(e.target.classList.contains('l')?'clip-l':'clip-r'):'clip-move'; // 需在 selectClip 重繪前判斷（用 e.target 的 class）
    selectClip(c.id); // 點擊即選取（非破壞性，先做——不受存檔守衛擋住）
    if(!isProjectGuardDone()){ ensureProjectSaved(); e.preventDefault(); return; } // 拖曳/修剪前先存檔
    if(e.detail<2) jklReset(); // 播放中拖動影片區塊 → 先暫停（映射不可邊播邊變）
    const nb=Seq.neighborBounds(c);
    // selectClip 內 renderClipBlocks() 已把原 clipEl 重建成新節點；必須重抓，否則拖曳更新的是脫離 DOM 的孤兒（框不動、只有波形動）
    const liveEl=(tlVtracks&&tlVtracks.querySelector(`.clip-block[data-clip-id="${c.id}"]`))||clipEl;
    drag={mode, clip:c, clipEl:liveEl, startX:e.clientX, startY:e.clientY, startScroll:tlScroll.scrollLeft,
      os:c.offset, oin:c.in, oout:c.out, ov:c.vtrack||0,
      leftLim:nb.lo, rightLim:(nb.hi===Infinity?Infinity:nb.hi+(c.out-c.in)), // 右鄰左緣（時間軸）
      nb, snaps:[...snapTargets(new Set()), ...Seq.snapEdges(c.id)],
      gesture:beginRendererGesture(mode,{targets:[{target:c,fields:['offset','in','out','vtrack']}],context:{
        startPoint:{x:e.clientX,y:e.clientY},
        modifiers:{alt:e.altKey,ctrl:e.ctrlKey||e.metaKey,shift:e.shiftKey},
      }}),};
    e.preventDefault(); return;
  }
  const overlap=e.target.closest('.cue-overlap');
  let block=e.target.closest('.cue-block');
  
  if(overlap){
    const id1 = overlap.dataset.id1;
    const id2 = overlap.dataset.id2;
    const idx1 = State.cues.findIndex(c=>c.id===id1);
    const idx2 = State.cues.findIndex(c=>c.id===id2);
    const bottomId = idx1 < idx2 ? id1 : id2;
    const topId = idx1 < idx2 ? id2 : id1;
    
    let targetId = bottomId;
    if(State.selectedId === bottomId) targetId = topId;
    else if(State.selectedId === topId) targetId = bottomId;
    
    block = tlTracks.querySelector(`.cue-block[data-id="${targetId}"]`);
  }

  const rect=tlLayer.getBoundingClientRect();
  const x=e.clientX-rect.left, y=e.clientY-rect.top;
  if(block){
    const c=State.cues.find(z=>z.id===block.dataset.id); if(!c)return;
    if(e.detail>=2 && !e.shiftKey){ selectCue(c.id); emit('cue:openEdit', c); e.preventDefault(); return; }
    const mode = e.target.classList.contains('edge')? (e.target.classList.contains('l')?'l':'r') : 'move';
    const isCtrl = e.ctrlKey||e.metaKey;
    const isPlainClick = !isCtrl && !e.shiftKey && !e.altKey;
    // 第一次拖曳前的儲存守衛（同步，不 await，避免拖曳殘留問題）。選取本身
    // 不會修改專案，所以要先反映；否則第一次點擊只會開提示，看起來像沒點中。
    if(!isProjectGuardDone()){
      if(isPlainClick) selectCue(c.id);
      ensureProjectSaved(); e.preventDefault(); return;
    }
    if(State.tracks[c.track||0]?.locked){
      // 鎖定軌道：僅允許選取，不允許拖曳移動
      if(isPlainClick || !isSel(c.id)) selectCue(c.id); e.preventDefault(); return;
    }
    if(e.shiftKey && State.selectedId){
      // 同軌道範圍多選
      const tk=c.track||0;
      const anchor=State.cues.find(z=>z.id===State.selectedId);
      if(anchor&&(anchor.track||0)===tk){
        const list=State.cues.filter(z=>(z.track||0)===tk);
        const ai=list.findIndex(z=>z.id===State.selectedId), bi=list.findIndex(z=>z.id===c.id);
        if(ai>=0&&bi>=0){
          const lo=Math.min(ai,bi), hi=Math.max(ai,bi);
          // primary 明確保留錨點（範圍多選不換主選取）
          setSelection({ kind:'sub', ids:list.slice(lo,hi+1).map(z=>z.id), primary:State.selectedId });
          State.activeEdge='start';
          refreshSelectionUI();
          e.preventDefault(); return;
        }
      }
      // 不同軌道：保持現有選取不變
      e.preventDefault(); return;
    }
    // Ctrl/Cmd 已有複製行為；Alt 拖曳字幕區塊也複製，但不影響邊緣修剪。
    const isCopyDrag = mode==='move' && (e.altKey||isCtrl);
    // 已選中的字幕要等 mouseup 才判定是點擊或拖曳：多選時點擊會收斂成
    // 單選；已是單選時也要重新揭示列表列，避免使用者捲走後再點時間軸卻
    // 看不到該句。拖曳、修剪與修飾鍵操作都不走這條。
    const selectOnPlainClickRelease = mode==='move' && isPlainClick && isSel(c.id);
    if(isCtrl && mode!=='move'){ selectCue(c.id,{additive:true}); if(!isSel(c.id)){ e.preventDefault(); return; } }
    else if(!isCtrl && !isSel(c.id)) selectCue(c.id);
    const grpIds = (mode==='move' && isSel(c.id) && State.selectedIds.length>1) ? State.selectedIds : [c.id];
    const grpCues = grpIds.map(id => State.cues.find(z => z.id === id)).filter(Boolean);
    if(grpCues.some(cc => State.tracks[cc.track || 0]?.locked)){
      // 群組中包含鎖定軌道：僅允許選取，不允許拖曳移動
      e.preventDefault(); return;
    }
    const exSet=new Set(grpIds);
    const grp=grpIds.map(id=>State.cues.find(z=>z.id===id)).filter(Boolean)
      .map(cc=>{ const b=cueNeighborBounds(cc.start,cc.end,cc.track||0,exSet); return {c:cc,el:tlTracks.querySelector(`.cue-block[data-id="${cc.id}"]`),os:cc.start,oe:cc.end,ot:cc.track||0,prevEnd:b.prevEnd,nextStart:b.nextStart,origStyle:cc.style ? {...cc.style} : undefined}; }); // P3：快取區塊 element 參照
    const selectionBefore={ids:[...State.selectedIds],primary:State.selectedId,activeEdge:State.activeEdge};
    const gesture=beginRendererGesture(mode,{
      targets:grp.map(item=>({target:item.c,fields:['start','end','track','style']})),
      context:{isCopyDrag,startPoint:{x:e.clientX,y:e.clientY},modifiers:{alt:e.altKey,ctrl:isCtrl,shift:e.shiftKey}},
    });
    // renderSubRow is part of the drag preview.  Cancellation must refresh the
    // same rows after model rollback, otherwise their TC/duration stays stale.
    const previewRowIds=grp.map(item=>item.c.id);
    gesture.addCancelEffect(()=>previewRowIds.forEach(renderSubRow));
    drag={c,mode,startX:e.clientX,startY:e.clientY,startScroll:tlScroll.scrollLeft,os:c.start,oe:c.end,ot:c.track||0,grp,
      snaps:snapTargets(exSet), isCtrl,isCopyDrag,selectOnPlainClickRelease,selectionBefore,
      gesture};
    tlTracks.querySelectorAll('.cue-overlap').forEach(el=>el.style.display='none'); // P3：拖曳開始隱藏重疊一次（拖曳期間不重建），免每 frame 全掃
    e.preventDefault(); return;
  }
  if(y<tracksTop()){ // 時間尺 + 波形帶：拖曳移動播放點
    // 備註標記點擊偵測（時間尺範圍內 ±9px）
    if(y<=RULER_H && State.notes.length){
      const hitNote=State.notes.find(n=>Math.abs(timeToX(n.time)-x)<=9);
      if(hitNote){
        const now=performance.now();
        if(_noteClickState&&_noteClickState.id===hitNote.id&&now-_noteClickState.t<400){
          emit('note:openInPanel', hitNote); _noteClickState=null;
        } else {
          _noteClickState={id:hitNote.id,t:now};
        }
        requestPointerSeek(hitNote.time); updatePlayhead(); emit('render:videoSub'); emit('playhead:ensure');
        e.preventDefault(); return;
      }
    }
    const snaps = snapTargets(new Set());
    const currentThr = e.altKey ? 0 : 8/State.pxPerSec;
    const t = xToTime(x);
    const sn = snapVal(t, snaps, currentThr);
    requestPointerSeek(sn !== t ? sn : snapFrame(t)); updatePlayhead(); emit('render:videoSub');
    drag={mode:'scrub', snaps, gesture:beginRendererGesture('scrub',{context:{
      modifiers:{alt:e.altKey,ctrl:e.ctrlKey||e.metaKey,shift:e.shiftKey},
    }})}; e.preventDefault(); return;
  }
  drag={mode:'rubber',startX:e.clientX,startY:e.clientY,startScroll:tlScroll.scrollLeft,x0:x,y0:y,additive:e.ctrlKey||e.metaKey,
    gesture:beginRendererGesture('rubber',{context:{startPoint:{x:e.clientX,y:e.clientY},modifiers:{ctrl:e.ctrlKey||e.metaKey}}})};
  e.preventDefault();
});
let _autoScrollId = null;

function stopTimelineAutoScroll(){
  if(_autoScrollId) { cancelAnimationFrame(_autoScrollId); _autoScrollId = null; }
}

/* blur / pointercancel has no mouseup.  Preview edits must never escape that
   lifecycle: restore the captured fields, remove copy-drag clones, and redraw
   without recording history. */
function cancelTimelineDrag(){
  if(!drag) return;
  const pending=drag;
  try{
    pending.gesture?.cancel(pending);
  }finally{
    drag=null;
  }
}

const _handleDragUpdate = (e) => {
  if(!drag)return;
  const rect=tlLayer.getBoundingClientRect();
  const currentThr = drag.gesture.intent.modifiers.alt ? 0 : 8 / State.pxPerSec;
  const frameStep = 1 / getExactFps(State.fps || 24);
  if(drag.mode==='scrub'){
    drag.gesture.preview(()=>{
      const t = xToTime(e.clientX-rect.left);
      const sn = snapVal(t, drag.snaps, currentThr);
      requestPointerSeek(sn !== t ? sn : snapFrame(t));
      updatePlayhead(); emit('render:videoSub');
      updateSnapGuide(null);
    });
    return;
  }
  // scrub 已在上方返回；rubber、字幕、影片與音訊都由同一門檻開始 preview lifecycle。
  if (!drag.gesture.hasMoved()) {
    drag.gesture.acceptSample({x:e.clientX,y:e.clientY},()=>{
      if (!(drag.isCopyDrag && drag.mode === 'move' && drag.grp)) return;
        // Clone cues
        const newIds = [];
        const copied = new Set();
        drag.grp.forEach(it => {
           const cloned = { ...it.c, id: newId(), style: it.c.style ? JSON.parse(JSON.stringify(it.c.style)) : undefined };
           State.cues.push(cloned);
           copied.add(cloned);
           newIds.push(cloned.id);
           it.c = cloned;
        });
        const before=drag.selectionBefore;
        drag.gesture.addRollback(()=>{
          State.cues=State.cues.filter(cue=>!copied.has(cue));
          setSelection({kind:'sub',ids:before.ids,primary:before.primary});
          State.activeEdge=before.activeEdge;
        });
        setSelection({ kind:'sub', ids:newIds });
        State.activeEdge = 'start';
        // Re-render blocks so drag can update their DOM elements
        drawTimeline();
        drag.grp.forEach(it => {
           it.el = tlTracks.querySelector(`.cue-block[data-id="${it.c.id}"]`);
        });
      refreshSelectionUI();
    });
  }
  if(drag.gesture.kind==='rubber'){
    drag.gesture.preview(()=>{
      const currentX0 = drag.x0 - (tlScroll.scrollLeft - drag.startScroll);
      const x1=clamp(e.clientX-rect.left,0,viewportW()), y1=clamp(e.clientY-rect.top,0,tlLayer.clientHeight);
      const rb=$('tlRubber'); rb.style.display='block';
      rb.style.left=Math.min(currentX0,x1)+'px'; rb.style.top=Math.min(drag.y0,y1)+'px';
      rb.style.width=Math.abs(x1-currentX0)+'px'; rb.style.height=Math.abs(y1-drag.y0)+'px';
    });
    return;
  }
  if(!drag.gesture.hasMoved()) return; // 未超過門檻：單擊不應移動/縮放字幕
  drag.gesture.preview(()=>{
  let dt=(e.clientX-drag.startX + (tlScroll.scrollLeft - drag.startScroll))/State.pxPerSec;
  /* ---- 影片序列區塊拖曳 ---- */
  if(drag.gesture.kind==='clip'){
    const c=drag.clip;
    const targetTrack=clipTrackFromY(e.clientY);
    const plan=planClipGesturePreview({
      mode:drag.mode,
      original:{
        offset:drag.os,in:drag.oin,out:drag.oout,
        duration:c.dur,type:c.type,vtrack:drag.ov,
      },
      deltaTime:dt,
      targetTrack,
      targetTrackLocked:!!State.videoTracks[targetTrack]?.locked,
      snaps:drag.snaps,
      snapThreshold:currentThr,
      snapFrame,
      frameStep,
      leftLimit:drag.leftLim,
      rightLimit:drag.rightLim,
    });
    c.offset=plan.offset;
    c.in=plan.in;
    c.out=plan.out;
    c.vtrack=plan.vtrack;
    updateSnapGuide(plan.snapTarget);
    const x1=timeToX(c.offset), x2=timeToX(Seq.clipEnd(c));
    drag.clipEl.style.left=x1+'px'; drag.clipEl.style.width=Math.max(6,x2-x1)+'px';
    if(drag.mode==='clip-move'&&tlVtracks){
      const row=tlVtracks.querySelector(`.vtrack-row[data-vtrack="${c.vtrack||0}"]`);
      if(row&&drag.clipEl.parentElement!==row) row.appendChild(drag.clipEl);
    }
    drawWave();
    return;
  }
  /* ---- 外部音訊素材拖曳 ----
     拖曳中只更新 DOM 預覽，放開時才寫回 Media；這樣不會每一個 mousemove 都重建
     AudioNode / cache，也避免波形在拖曳期間閃爍。 */
  if(drag.gesture.kind==='audio'){
    const plan=planAudioGesturePreview({
      mode:drag.mode,
      original:{offset:drag.os,in:drag.oin,out:drag.oout,duration:drag.duration},
      deltaTime:dt,
      snaps:drag.snaps,
      snapThreshold:currentThr,
      snapFrame,
      frameStep,
    });
    drag.preview={offset:plan.offset,in:plan.in,out:plan.out};
    updateSnapGuide(plan.snapTarget);
    const x1=timeToX(plan.offset), x2=timeToX(plan.offset+Math.max(0,plan.out-plan.in));
    drag.audioEl.style.left=x1+'px';
    drag.audioEl.style.width=Math.max(6,x2-x1)+'px';
    drag.audioEl.classList.add('dragging');
    return;
  }
  const cuePlan=planCueGesturePreview({
    mode:drag.mode,
    originals:drag.grp.map(item=>({
      start:item.os,end:item.oe,track:item.ot,
      prevEnd:item.prevEnd,nextStart:item.nextStart,
    })),
    deltaTime:dt,
    targetTrackDelta:trackFromY(e.clientY)-drag.ot,
    trackCount:State.trackCount,
    lockedTracks:State.tracks.map(track=>!!track?.locked),
    overwriteMode:State.overwriteMode,
    snaps:drag.snaps,
    snapThreshold:currentThr,
    snapFrame,
    frameStep,
  });
  updateSnapGuide(cuePlan.snapTarget);
  drag.grp.forEach((item,index)=>{
    const next=cuePlan.items[index];
    if(!next)return;
    item.c.start=next.start;
    item.c.end=next.end;
    item.c.track=next.track;
    if(next.track!==item.ot){
      const oldEffStyle=effStyle({style:item.origStyle},State.tracks[item.ot]);
      const stylePlan=planCueStyleAssignment({
        cue:{style:item.origStyle},
        targetTrack:State.tracks[next.track],
        desiredStyle:oldEffStyle,
      });
      item.c.style=stylePlan.style;
    }else{
      item.c.style=item.origStyle;
    }
  });
  
  // P3：拖曳期間只更新樣式，用 mousedown 快取的 element 參照（免每 frame 字串選擇器、免全掃 overlap）
  const rows = tlTracks.querySelectorAll('.tl-track');
  for (const it of drag.grp) {
    const el = it.el;
    if (el) {
      const x1 = timeToX(it.c.start);
      const x2 = timeToX(it.c.end);
      el.style.left = x1 + 'px';
      el.style.width = Math.max(2, x2 - x1) + 'px';
      const targetRow = rows[Math.min(it.c.track || 0, rows.length - 1)];
      if (targetRow && el.parentElement !== targetRow) {
        targetRow.appendChild(el);
      }
    }
  }
  if(drag.c) renderSubRow(drag.c.id);
  });
};

function updateSnapGuide(snTime = null) {
  const sg = document.getElementById('tlSnapGuide');
  if(!sg) return;
  if(snTime !== null) {
    sg.style.display = 'block';
    sg.style.left = timeToX(snTime) + 'px';
  } else {
    sg.style.display = 'none';
  }
}

tlLayer.addEventListener('mousemove', e => {
  if (drag) return; // dragging handles its own snap guide
  const rect = tlLayer.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const t = xToTime(x);
  const currentThr = e.altKey ? 0 : 8 / State.pxPerSec;
  const snaps = snapTargets(new Set());
  const sn = snapVal(t, snaps, currentThr);
  if (sn !== t) updateSnapGuide(sn);
  else updateSnapGuide(null);
});
tlLayer.addEventListener('mouseleave', () => {
  if (!drag) updateSnapGuide(null);
});

window.addEventListener('mousemove',e=>{
  if(!drag)return;
  drag.lastEvent = e;
  drag.lastClientX = e.clientX;
  _handleDragUpdate(e);
  if(!_autoScrollId) {
    const _autoScroll = () => {
      if(!drag) { _autoScrollId = null; return; }
      const r = tlScroll.getBoundingClientRect();
      const cx = drag.lastClientX;
      let dx = 0;
      if (cx < r.left + 60) dx = -Math.min(80, Math.max(20, (r.left + 60 - cx)));
      else if (cx > r.right - 60) dx = Math.min(80, Math.max(20, (cx - (r.right - 60))));
      if (dx !== 0) {
        tlScroll.scrollLeft += dx;
        if(drag.lastEvent) _handleDragUpdate(drag.lastEvent);
      }
      _autoScrollId = requestAnimationFrame(_autoScroll);
    };
    _autoScrollId = requestAnimationFrame(_autoScroll);
  }
});

window.addEventListener('mouseup',e=>{
  if(!drag)return;
  const pending=drag;
  try{
  pending.gesture.commit(()=>{
  updateSnapGuide(null);
  stopTimelineAutoScroll();
  if(drag.gesture.kind==='rubber'){
    $('tlRubber').style.display='none';
    const rect=tlLayer.getBoundingClientRect();
    if(drag.gesture.hasMoved()){
      const currentX0 = drag.x0 - (tlScroll.scrollLeft - drag.startScroll);
      const x1=clamp(e.clientX-rect.left,0,viewportW()), y1=e.clientY-rect.top;
      const ta=xToTime(Math.min(currentX0,x1)), tb=xToTime(Math.max(currentX0,x1));
      const sc=tracksScrollTop();
      const rowA=yToTrack(Math.max(0,Math.min(drag.y0,y1)-tracksTop()+sc));
      const rowB=yToTrack(Math.max(0,Math.max(drag.y0,y1)-tracksTop()+sc));
      const hit=State.cues.filter(c=>c.timed!==false&&(c.track||0)>=rowA&&(c.track||0)<=rowB&&c.end>=ta&&c.start<=tb).map(c=>c.id);
      const picked = drag.additive
        ? [...State.selectedIds, ...hit.filter(id=>!State.selectedIds.includes(id))]
        : hit;
      setSelection({ kind:'sub', ids:picked });
      State.activeEdge='start';
      refreshSelectionUI();
    }else{
      // 點時間軸空白：跳轉（Shift 時保留選取）
      const sc=tracksScrollTop();
      const tkIdx=yToTrack(Math.max(0,drag.y0-tracksTop()+sc));
      if(tkIdx>=0){ focusTrackKind('sub', tkIdx); } // 類別與「哪一軌」是同一條不變量，一次寫入
      
      requestPointerSeek(xToTime(e.clientX-rect.left)); updatePlayhead(); emit('render:videoSub');
      if(!e.shiftKey){
        deselect('sub'); State.activeEdge='start';
        clearClipSelection();
        refreshSelectionUI(); $('stSel').textContent='';
      }
    }
    refreshTrackGutterActive();
    if(drag.gesture.hasMoved()) clearClipSelection(); // 框選字幕時取消影片段選取
  }else if(drag.gesture.kind==='clip'){
    const moved=drag.gesture.hasMoved(), m=drag.mode, c=drag.clip;
    if(!moved){ selectClip(c.id); return; } // 未拖動＝點選該影片段（高亮，供上下鍵/Del）
    if(m==='clip-move'){ Seq.resolveOverlaps(c); Seq.compact(); } // 自由拖放：同軌連鎖右推；收斂空的頂部視訊軌
    Seq.sort(); Seq.recomputeDuration();
    recordHistory(m==='clip-move'?('移動影片：'+c.name):('修剪影片：'+c.name));
    // 幾何變了 → 以目前播放頭重新解析映射（active clip 可能移走/縮短成間隙）
    Media.seek(Math.min(Media.displayTime(), State.duration||0));
    emit('render:videoSub'); emit('mpv:refreshSubs');
    drawTimeline();
  }else if(drag.gesture.kind==='audio'){
    const moved=drag.gesture.hasMoved(), mode=drag.mode, assetId=drag.audioAssetId, preview=drag.preview;
    try{
      if(drag.pointerId!=null&&drag.audioEl?.hasPointerCapture?.(drag.pointerId)) drag.audioEl.releasePointerCapture(drag.pointerId);
    }catch(_){}
    _ignoreAudioClickUntil=performance.now()+350;
    if(!moved){ selectExternalAudioClip(assetId); return; }
    if(mode==='audio-move'){
      runExternalAudioAction('moveExternalAudio',[assetId,preview.offset]);
    }else if(mode==='audio-l'){
      runExternalAudioAction('trimExternalAudio',[assetId,'start',preview.offset]);
    }else{
      runExternalAudioAction('trimExternalAudio',[assetId,'end',preview.offset+Math.max(0,preview.out-preview.in)]);
    }
  }else if(drag.mode!=='scrub'){
    const moved=drag.gesture.hasMoved(), m=drag.mode;
    if (!moved && drag.selectOnPlainClickRelease) {
      selectCue(drag.c.id);
    } else if (!moved && drag.isCtrl && m==='move') {
      selectCue(drag.c.id, {additive:true});
    } else if (moved) {
      sweepContainedCues(drag.grp.map(x=>x.c));
      sortCues(); emit('render:all');
      recordHistory(drag.isCopyDrag ? `複製字幕` : (m==='move'?(drag.grp.length>1?`移動字幕 (${drag.grp.length}句)`:'移動字幕'+cueSuffix(drag.c)):'調整字幕時間'+cueSuffix(drag.c)));
    }
  }
  });
  }finally{
    drag=null;
  }
});

window.addEventListener('blur',cancelTimelineDrag);
window.addEventListener('pointercancel',cancelTimelineDrag,true);

/* 滾輪縮放（Ctrl）/ 平移 / 逐格 */
tlScroll.addEventListener('wheel',e=>{
  if(e.ctrlKey||e.metaKey){
    e.preventDefault();
    const factor = Math.pow(2, -e.deltaY / 500);
    setZoom(State.pxPerSec * factor);
  } else if(e.shiftKey) {
    e.preventDefault();
    tlScroll.scrollLeft += (e.deltaY || e.deltaX);
  } else if(Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    // 原生觸控板水平滑動，讓瀏覽器自然處理平移
  } else {
    e.preventDefault();
    const frames = e.deltaY > 0 ? 1 : -1;
    nudge(frames / (State.fps || 30));
  }
},{passive:false});

/* ===== 磁吸 / 防重疊 工具（時間軸拖曳專用） ===== */

/* 這些操作和渲染共用同一份座標、縮放與重繪語意；保留在同一個時間軸引擎，
   避免 renderer ↔ mutator 相互 import 而形成循環依賴。 */
export function trackFromY(clientY){
  const rect=tlLayer.getBoundingClientRect();
  const y=clientY-rect.top-tracksTop()+tracksScrollTop();
  return yToTrack(Math.max(0,y));
}

export function addTrack(){ State.tracks.push(newTrack()); syncTrackCount(); drawTimeline(); emit('render:listTrackSel'); recordHistory('新增軌道'); }

export function removeTrack(i){
  if(trackLocked(i, '刪除軌道')) return;
  const n=State.cues.filter(c=>(c.track||0)===i).length;
  const doRemove=()=>{
    State.cues=State.cues.filter(c=>(c.track||0)!==i);
    State.cues.forEach(c=>{ if((c.track||0)>i)c.track=(c.track||0)-1; });
    State.tracks.splice(i,1); syncTrackCount();
    if(State.listTrack===i)State.listTrack=-1; else if(State.listTrack>i)State.listTrack--;
    if(!State.cues.some(c=>c.id===State.selectedId)) State.activeEdge='start';
    pruneSelection();
    emit('render:listTrackSel'); emit('render:all'); drawTimeline(); recordHistory('刪除軌道');
  };
  if(n>0){
    openModal(`刪除軌道「${escapeHTML(State.tracks[i].name)}」`,
      `<p>此軌道有 <b>${n}</b> 條字幕，刪除後一併移除。確定繼續？</p>`,
      [{label:'取消',act:closeModal},
       {label:'確定刪除',primary:true,act:()=>{ closeModal(); doRemove(); }}]);
  } else { doRemove(); }
}

export function moveSelectedToTrack(target){
  const ids=State.selectedIds.length?State.selectedIds:[State.selectedId].filter(Boolean);
  if(!ids.length)return;
  const targetTk=clamp(target,0,State.trackCount-1);
  if(trackLocked(targetTk, '移動至此軌道')) return;
  const cues=ids.map(id=>State.cues.find(x=>x.id===id)).filter(Boolean);
  const fromLocked=cues.find(c=>State.tracks[c.track||0]?.locked);
  if(fromLocked && cueTrackLocked(fromLocked, '移動字幕')) return;
  for(const c of cues){ c.track=targetTk; }
  emit('render:all'); drawTimeline(); recordHistory('移動至軌道');
}

export function setZoom(px,centerTime){
  const c = centerTime!=null?centerTime:Media.displayTime();
  State.pxPerSec=clamp(px,0.1,4000);
  $('zoomBar').value=clamp(State.pxPerSec,0.1,4000);
  layoutTimeline();
  const target=c*State.pxPerSec - viewportW()/2;
  tlScroll.scrollLeft=clamp(target,0,Math.max(0,tlTotal()*State.pxPerSec-viewportW()));
  State.viewStart=tlScroll.scrollLeft/State.pxPerSec;
  drawTimeline();
}

export function zoomFit(){
  const vw=viewportW(); if(!vw) return;
  const timed=State.cues.filter(c=>c.timed!==false&&c.end>c.start);
  let t0,t1;
  if(timed.length){
    t0=Math.min(...timed.map(c=>c.start));
    t1=Math.max(...timed.map(c=>c.end));
  } else {
    t0=0; t1=State.duration>0?State.duration:1;
  }
  const dur=t1-t0; if(dur<=0)return;
  const MIN_PPS=Math.round(80*Math.pow(1.3,4));
  const ideal=(vw-40)/dur;
  const pps=clamp(Math.max(ideal,MIN_PPS),4,800);
  const vt=Media.displayTime();
  const center=clamp(vt,t0,t1);
  setZoom(pps,center);
}

export function zoomFitVideo(){
  const vw=viewportW(); if(!vw) return;
  const dur=State.duration>0?State.duration:1;
  const pps=(vw-40)/dur;
  setZoom(pps, dur/2);
}



export { RULER_H, ROW_H, tracksTop, tracksScrollTop, viewportW, 
  layoutTimeline, drawTimeline, drawRuler, niceStep, fmtTick, drawWave, renderTrackRows, renderCueBlocks,
  updatePlayhead,
  refreshTrackGutterActive,
  renderClipBlocks };
