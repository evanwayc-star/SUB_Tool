/* SUB Tool — 時間軸：渲染（尺/波形/軌道/區塊）與互動（拖曳/框選/縮放） */
import { $, video, tlScroll, tlLayer, tlTracks, rulerCv, waveCv } from './dom.js';
import { State, trackVisible, newTrack, syncTrackCount, isSel, cueSuffix, newVideoTrack, ensureVideoTrackCount, videoTrackVisible, resetVideoTracks, newId } from './state.js';
import { clamp, pad, escapeHTML } from './util.js';
import { Media, Wave } from './media.js';
import { encoreParts } from './time.js';
import { selectCue, refreshSelectionUI, renderSubRow, sortCues, sweepContainedCues } from './subtitles.js';
import { snapTimeToFrame } from './time.js';
import { emit } from './events.js';
import { ensureProjectSaved, isProjectGuardDone } from './project.js';
import { fmtClock, secToSRT, secToASS, secToEncore, getExactFps } from './time.js';
import { showToast, openModal, closeModal } from './ui.js';
import { jklReset, nudge } from './keyboard.js';
import { recordHistory } from './history.js';
import { hideCtx, showCueMenu } from './menus.js';
import { Seq } from './sequence.js';

/* ===== 5. 時間軸 ====================================================== */
const RULER_H=24, WAVE_H=64, ROW_H=64;  // default/min values; actual stored in State

/* 影片序列：獨立視訊軌列容器（在專案音訊軌上方），與字幕軌列同一套「列＋列頭」機制。
   容器 pointer-events:none、片段本身 auto——空白處仍可拖曳捲動/框選。 */
const tlVtracks=document.getElementById('tlVtracks');
const tlAtracks=document.getElementById('tlAtracks');
const VROW_H=44;  // 視訊軌列預設高度（影像與音訊分離後，不再內嵌波形）
function waveH(){ return State.waveH||WAVE_H; }
function trackH(tk){ return State.tracks[tk]?.height||ROW_H; }
function _tracksHeight(){ let h=0; for(let i=0;i<State.trackCount;i++)h+=trackH(i); return h; }
function yToTrack(y){ let c=0; for(let i=0;i<State.trackCount;i++){ c+=trackH(i); if(y<c)return i; } return State.trackCount-1; }
/* 視訊軌：數量、每軌高度、總高（無影片序列時為 0＝不佔空間，維持純字幕版面）。
   顯示由上而下：disp0＝最高軌（vtrack 最大）；vtrackTop 回傳某軌在容器內的 y。 */
function vtrackCount(){ return Math.max(1, State.videoTracks.length); }
function vtrackH(v){ return State.videoTracks[v]?.height||VROW_H; }
function vtracksHeight(){ if(!Seq.active())return 0; let h=0; const N=vtrackCount(); for(let v=0;v<N;v++)h+=vtrackH(v); return h; }
function vtrackTop(v){ const N=vtrackCount(); let top=0; for(let disp=0;disp<N;disp++){ const vv=N-1-disp; if(vv===v)return top; top+=vtrackH(vv); } return 0; }
/* 補足 videoTracks 以涵蓋現有片段的最高軌（只增不減；每次全繪前呼叫，確保軌列與片段一致） */
function syncVideoTracks(){ let m=0; for(const c of State.clips) m=Math.max(m,(c.vtrack||0)+1); ensureVideoTrackCount(m); }
/* 音訊時間軸：一個匯入素材＝一條可視音訊軌；專案 A bus 只留在 mixer／配線資料。
   這樣 8 聲道素材不會在 A1～A8 複製出八張一樣的波形。右鍵可決定這條素材
   顯示 MIX 或任一來源聲道；大量素材仍以獨立捲動區避免擠掉字幕。 */
const AROW_H=48, AUDIO_HEAD_H=0, AUDIO_MAX_VIEW_H=216, AUDIO_MIN_SUB_H=72;
function sourceAudioRowH(row){
  const h=Number(row?.height);
  return Number.isFinite(h) ? clamp(h,32,160) : ROW_H;
}
function audioRowsHeight(){ return audioRowLayout().reduce((sum,row)=>sum+row.h,0); }
function audioViewportH(){
  const full=audioRowsHeight();
  if(!full) return 0;
  // tlLayer 的高度就是目前可見的時間軸 body；至少留字幕可操作的高度。
  const layerH=tlLayer?.clientHeight||tlScroll?.clientHeight||0;
  const room=layerH ? layerH-RULER_H-vtracksHeight()-AUDIO_HEAD_H-AUDIO_MIN_SUB_H : AUDIO_MAX_VIEW_H;
  const cap=Math.max(36,Math.min(AUDIO_MAX_VIEW_H,room));
  return Math.min(full,cap);
}
/* 每列為一個實際匯入的影音／音檔 source；同一檔切成多段仍共用同一列。 */
function audioRowLayout(){
  let y0=0;
  return audioSourceLanes().map((lane,index)=>{
    const h=sourceAudioRowH(lane);
    const row={...lane,kind:'source',index,y0,h}; y0+=h; return row;
  });
}
function atracksHeight(){ return audioRowLayout().length ? AUDIO_HEAD_H+audioViewportH() : 0; }
function tracksTop(){return RULER_H+vtracksHeight()+atracksHeight();}
function tracksScrollTop(){ return tlTracks?tlTracks.scrollTop:0; }

function viewportW(){return tlScroll.clientWidth;}
function snapFrame(t){
  return snapTimeToFrame(t, State.fps, State.dropFrame);
}
function timeToX(t){ return (t - State.viewStart)*State.pxPerSec; }
function xToTime(x){return State.viewStart + x/State.pxPerSec;}

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
  rulerCv.width=vw*devicePixelRatio; rulerCv.height=RULER_H*devicePixelRatio;
  rulerCv.style.width=vw+'px'; rulerCv.style.height=RULER_H+'px';
  const vh=vtracksHeight();
  const ah=atracksHeight();
  // waveCanvas 保留給舊 DOM/模組參照；專案音訊改用可獨立捲動的 DOM 軌列，以免 bus 很多時把字幕區擠走。
  waveCv.width=1; waveCv.height=1;
  waveCv.style.width='1px'; waveCv.style.height='1px'; waveCv.style.display='none';
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
  ctx.fillStyle='#1d1d20';ctx.fillRect(0,0,vw,RULER_H);
  const targetPx=80;
  const step=niceStep(targetPx/State.pxPerSec);
  const t0=State.viewStart, t1=State.viewStart+vw/State.pxPerSec;
  ctx.lineWidth=1;

  // 次刻度（用整數索引避免浮點累積誤差）
  const div=minorDiv(step);
  if(div>1){
    ctx.beginPath();ctx.strokeStyle='#2a2a30';
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
  ctx.beginPath();ctx.strokeStyle='#3a3a40';
  ctx.fillStyle='#8a8a92';ctx.font='10px Consolas,"Courier New",monospace';ctx.textBaseline='middle';
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
        `<button class="glock${isLocked?' locked':''}" title="${isLocked?'解鎖':'鎖定'}此軌">${isLocked?'🔒':'🔓'}</button>`+
        `<button class="gdel" title="刪除此軌">✕</button>`;
      g.querySelector('.eye').onclick=(e)=>{e.stopPropagation();State.tracks[tk].visible=!vis;drawTimeline();emit('render:videoSub');emit('mpv:refreshSubs');};
      g.addEventListener('click', e => {
        if (e.target.closest('.eye,.glock,.gdel,.drag-handle') || nm.contentEditable === 'true') return;
        e.stopPropagation();
        State.activeTrackKind = 'sub';
        State.listTrack = tk;
        State.selectedIds = []; State.selectedId = null; State.selectedClipId = null; State.selectedAudioClipId = null;
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
      nm.onblur=()=>{ nm.contentEditable='false'; State.tracks[tk].name=nm.innerText.trim()||('軌道 '+(tk+1)); emit('render:listTrackSel'); };
      g.querySelector('.glock').onclick=(e)=>{e.stopPropagation();State.tracks[tk].locked=!State.tracks[tk].locked;renderTrackRows();};
      g.querySelector('.gdel').onclick=(e)=>{e.stopPropagation();removeTrack(tk);};
      // 高度縮放把手
      const resH=document.createElement('div');
      resH.className='tl-resize-handle';
      resH.addEventListener('mousedown',e=>{
        e.preventDefault();e.stopPropagation();
        const now=performance.now();
        if(_lastHandleClick.tk===tk && now-_lastHandleClick.t<400){
          _lastHandleClick={tk:-1,t:0};
          if(State.tracks[tk])delete State.tracks[tk].height;
          drawTimeline(); return;
        }
        _lastHandleClick={tk,t:now};
        _rowResize={type:'track',tk,startY:e.clientY,startH:trackH(tk)};
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
  const gut=$('tlGutterTracks'); if(!gut) return;
  gut.querySelectorAll('.tl-gtrack').forEach(g=>{
    g.classList.toggle('tl-active', +g.dataset.track===State.listTrack);
  });
  tlTracks.querySelectorAll('.tl-track').forEach(r=>{
    r.classList.toggle('tl-active', +r.dataset.track===State.listTrack);
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
  if(type==='wave'){
    const wh=waveH();
    const gutWave=document.querySelector('.tl-gutter-wave');
    if(gutWave)gutWave.style.height=wh+'px';
    waveCv.height=wh*devicePixelRatio; waveCv.style.height=wh+'px';
    tlTracks.style.top=tracksTop()+'px';
    drawWave();
  }else if(type==='vtrack'){
    // 視訊軌高度改變會牽動波形與字幕軌位置 → 直接整體重繪
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
  if(type==='wave')State.waveH=Math.max(24,startH+dy);
  else if(type==='vtrack'){ if(State.videoTracks[tk])State.videoTracks[tk].height=Math.max(24,startH+dy); }
  else if(State.tracks[tk])State.tracks[tk].height=Math.max(20,startH+dy);
  if(!_rowResize._raf){
    _rowResize._raf=requestAnimationFrame(()=>{ _rowResize&&(_rowResize._raf=null); _doResize(type,tk); });
  }
}
function _onRowResizeUp(){
  document.removeEventListener('mousemove',_onRowResizeMove);
  _rowResize=null;
  drawTimeline();
}
// 波形列 resize handle（一次性）
(()=>{
  const gutWave=document.querySelector('.tl-gutter-wave'); if(!gutWave)return;
  const h=document.createElement('div');
  h.className='tl-resize-handle';
  h.addEventListener('mousedown',e=>{
    e.preventDefault();e.stopPropagation();
    _rowResize={type:'wave',tk:-1,startY:e.clientY,startH:waveH()};
    document.addEventListener('mousemove',_onRowResizeMove);
    document.addEventListener('mouseup',_onRowResizeUp,{once:true});
  });
  h.addEventListener('dblclick',e=>{ e.preventDefault();e.stopPropagation(); State.waveH=WAVE_H; drawTimeline(); });
  gutWave.appendChild(h);
})();

/* 影片序列：把各段畫進「對應視訊軌列」（各軌獨立成列，比照字幕軌）。
   先在 tlVtracks 內建立每軌的列 .vtrack-row（由上而下：最高軌在最上面），再把片段放入其列。
   片段位置＝offset、寬＝修剪後長度；拖曳移動、拖邊緣修剪、右鍵選單。 */
function renderClipBlocks(){
  if(!tlVtracks) return;
  tlVtracks.innerHTML='';
  if(!Seq.active()) return;
  const N=vtrackCount();
  // 每軌一列（top→bottom：disp0＝最高軌 vtrack=N-1）
  const rowByV=[];
  for(let disp=0; disp<N; disp++){
    const v=N-1-disp;
    const row=document.createElement('div');
    row.className='vtrack-row'+(videoTrackVisible(v)?'':' hidden-tk');
    row.style.top=vtrackTop(v)+'px'; row.style.height=vtrackH(v)+'px'; row.dataset.vtrack=v;
    tlVtracks.appendChild(row); rowByV[v]=row;
  }
  // 片段進列
  const vw=viewportW(); const t0=State.viewStart, t1=State.viewStart+vw/State.pxPerSec;
  for(const c of State.clips){
    const s=c.offset, e=Seq.clipEnd(c);
    if(e<t0||s>t1) continue;
    const v=c.vtrack||0; const row=rowByV[v]||rowByV[0]; if(!row) continue;
    const el=document.createElement('div');
    el.className='clip-block'+(c.id===Media.activeClipId?' active':'')+(c.id===State.selectedClipId?' selected':'')+(State.videoTracks[v]?.locked?' locked':'');
    const x1=timeToX(s), x2=timeToX(e);
    el.style.left=x1+'px'; el.style.width=Math.max(6,x2-x1)+'px';
    el.dataset.clipId=c.id; el.dataset.vtrack=v;
    const trimmed=c.in>0.01||c.out<c.dur-0.01;
    const hasFade=(c.fadeIn>0||c.fadeOut>0);
    try {
      const isImg = c.type === 'image';
      const icon = isImg ? '🖼️' : '🎬';
      const typeLabel = isImg ? '圖片' : '影片';
      el.innerHTML=`<div class="edge l"></div><div class="clip-label">${icon} ${escapeHTML(c.name||'')}${trimmed?' ✂':''}${hasFade?' ⌁':''}</div><div class="edge r"></div>`;
      el.title=`${c.name}（${State.videoTracks[v]?.name||('視訊軌 V'+(v+1))}）\n位置 ${secToEncore(s,State.fps,State.dropFrame)} → ${secToEncore(e,State.fps,State.dropFrame)}`+
        `\n修剪 in ${Number(c.in).toFixed(2)}s / out ${Number(c.out).toFixed(2)}s（來源長 ${Number(c.dur).toFixed(2)}s）`+
        `\n拖曳＝移動（上下拖可換視訊軌）｜拖左右邊緣＝修剪\n${isImg ? '在預覽畫面可直接縮放與移動圖片位置' : ''}`;
      row.appendChild(el);
    } catch(err) {
      console.error('renderClipBlocks error on clip', c, err);
      // Fallback text
      el.innerHTML=`<div class="edge l"></div><div class="clip-label">⚠️ ERROR</div><div class="edge r"></div>`;
      row.appendChild(el);
    }
  }
}
/* 在片段區塊內畫該段音波：畫布覆蓋片段的【可視範圍】，x0abs＝畫布左緣的絕對時間軸 px；
   逐畫布像素以 xToTime 反推來源時間 → 取 peaks（縮放時畫布寬≤視窗，不會超過 canvas 上限）。 */
function _drawClipWave(cv, c, pk, cvw, Hpx, x0abs){
  const ctx=cv.getContext('2d'); const dpr=devicePixelRatio;
  ctx.save(); ctx.scale(dpr,dpr);
  const mid=Hpx/2, amp=Hpx*1.2, res=Wave.resolution, n=pk.length/2;
  ctx.strokeStyle='rgba(190,230,255,.5)'; ctx.lineWidth=1; ctx.beginPath();
  for(let cx=0; cx<cvw; cx++){
    const bT=c.in+(xToTime(x0abs+cx)-c.offset);
    const b=Math.floor(bT*res); if(b<0||b>=n) continue;
    let mn=pk[b*2], mx=pk[b*2+1];
    const b2=Math.min(n-1, Math.floor((c.in+(xToTime(x0abs+cx+1)-c.offset))*res));
    for(let k=b+1;k<=b2;k++){ if(pk[k*2]<mn)mn=pk[k*2]; if(pk[k*2+1]>mx)mx=pk[k*2+1]; }
    ctx.moveTo(cx+0.5, mid-mx*amp); ctx.lineTo(cx+0.5, mid-mn*amp);
  }
  ctx.stroke(); ctx.restore();
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
function sourceMapForClip(c){
  const maps=State.audioProject?.sourceMaps;
  if(!maps || typeof maps!=='object') return null;
  const sourceId=clipAudioSourceId(c);
  const get=(key)=>maps instanceof Map ? maps.get(key) : maps[key];
  return get(sourceId) || (c?.audioSrc && c.audioSrc!==sourceId ? get(c.audioSrc) : null) || null;
}
function sourceRoutingSummary(c){
  const routes=sourceMapForClip(c)?.channels;
  if(!Array.isArray(routes)||!routes.length) return '尚未配線';
  const buses=State.audioProject?.buses||[];
  const byId=new Map(buses.map((bus,index)=>[String(bus.id),bus?.name||`A${index+1}`]));
  const ids=[];
  for(const route of routes){
    if(!route||route.enabled===false) continue;
    for(const id of (Array.isArray(route.busIds)?route.busIds:[route.busIds])){
      if(id!=null&&!ids.includes(String(id))) ids.push(String(id));
    }
  }
  if(!ids.length) return '未送往專案音軌';
  const labels=ids.map((id,index)=>byId.get(id)||`A${index+1}`);
  return `→ ${labels.length<=4?labels.join('、'):`${labels.slice(0,4).join('、')} +${labels.length-4}`}`;
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
  const assets=typeof Media.getExternalAudioSources==='function' ? Media.getExternalAudioSources() : [];
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
        external:!!entry.external,
        label:source.name||(entry.external?'外部音檔':'影音素材'),
        firstStart:entry.start,
        entries:[]
      };
      lanes.set(laneId,lane);
    }
    lane.entries.push(entry);
    lane.firstStart=Math.min(lane.firstStart,entry.start);
  }
  return [...lanes.values()].sort((a,b)=>a.firstStart-b.firstStart||a.label.localeCompare(b.label));
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
  State.selectedAudioClipId=assetId;
  State.selectedClipId=null;
  State.selectedId=null;
  State.selectedIds=[];
  refreshSelectionUI();
  const asset=typeof Media.getExternalAudioSource==='function' ? Media.getExternalAudioSource(assetId) : null;
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
    if(clearSelection) State.selectedAudioClipId=null;
    drawTimeline();
    emit('render:videoSub'); emit('mpv:refreshSubs');
  }).catch(err=>{
    console.warn('external audio '+method+':',err);
    showToast('無法更新音訊素材');
  });
  return true;
}
function beginExternalAudioDrag(ev,asset,entry,block){
  if(ev.button!==0 || ev.target.closest('button')) return;
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
    startX:ev.clientX,startY:ev.clientY,startScroll:tlScroll.scrollLeft,moved:false,
    os:entry.start,oin:inPoint,oout:outPoint,duration:Math.max(outPoint,Number(asset.duration)||0),
    preview:{offset:entry.start,in:inPoint,out:outPoint},
    snaps:snapTargets(new Set())
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
    rowEl.className='audio-project-row';
    rowEl.style.height=h+'px'; rowEl.dataset.audioSourceId=sourceId;
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
      const wave=sourceWaveDetail(c,external);
      const waveLabel=sourceWaveLabel(c,wave.selection);
      const routeText=sourceRoutingSummary(c);
      block.dataset.waveSelection=wave.selection||'mix';
      block.title=`${c.name||(external?'外部音檔':'影音片段')}\n聲音：${muted?'已關閉':'已開啟'}（右鍵選單切換）\n波形：${waveLabel}${wave.fallback?'（暫以 MIX 顯示）':''}\n${external?'拖曳＝移動｜拖左右邊緣＝修剪｜右鍵＝切割、刪除、靜音與波形':'右鍵：切換 MIX／來源聲道'}\n${routeText}`;
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
          try{ block.setPointerCapture(ev.pointerId); block._audioPointerId=ev.pointerId; }catch(_){}
        });
      }
      block.addEventListener('mousedown',ev=>{
        if(c.locked) return;
        if(external){ beginExternalAudioDrag(ev,c,entry,block); return; }
        ev.stopPropagation();
      });
      block.addEventListener('click',ev=>{
        if(performance.now()<_ignoreAudioClickUntil) return;
        ev.preventDefault();
        if(external) selectExternalAudioClip(c.id,{seek:true});
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
  gut.innerHTML='';
  if(!Seq.active()) return;
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
      State.activeTrackKind = 'video';
      State.activeVtrack = v;
      State.selectedId = null; State.selectedIds = []; State.selectedClipId = null; State.selectedAudioClipId = null;
      refreshSelectionUI();
      renderClipBlocks();
      renderAudioTrackRows();
      refreshTrackGutterActive();
      const stSel = $('stSel'); if (stSel) stSel.textContent = '已切換至視訊軌：' + (meta.name || ('視訊軌 ' + (v + 1)));
    });
    g.querySelector('.eye').onclick=(e)=>{ e.stopPropagation(); meta.visible=!vis; drawTimeline(); emit('render:videoSub'); };
    const nm=g.querySelector('.gname');
    nm.addEventListener('mousedown',e=>{
      if(e.detail>=2){ e.preventDefault(); nm.contentEditable='true'; nm.focus();
        try{const r=document.createRange(),s=window.getSelection();r.selectNodeContents(nm);s.removeAllRanges();s.addRange(r);}catch(_){}
      }
    });
    nm.onkeydown=(e)=>{ e.stopPropagation(); if(e.key==='Enter'){e.preventDefault();nm.blur();} else if(e.key==='Escape'){e.preventDefault();nm.innerText=meta.name;nm.blur();} };
    nm.onblur=()=>{ nm.contentEditable='false'; meta.name=nm.innerText.trim()||('視訊軌 '+(v+1)); };
    g.querySelector('.glock').onclick=(e)=>{ e.stopPropagation(); meta.locked=!meta.locked; if(meta.locked){ const sc=Seq.byId(State.selectedClipId); if(sc&&(sc.vtrack||0)===v) clearClipSelection(); } drawTimeline(); };
    g.querySelector('.gadd').onclick=(e)=>{ e.stopPropagation(); addVideoTrack(v+1); };
    g.querySelector('.gdel').onclick=(e)=>{ e.stopPropagation(); removeVideoTrack(v); };
    const resH=document.createElement('div');
    resH.className='tl-resize-handle';
    resH.addEventListener('mousedown',e=>{
      e.preventDefault();e.stopPropagation();
      _rowResize={type:'vtrack',tk:v,startY:e.clientY,startH:vtrackH(v)};
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
function showImageGeom(c){
  if(!c || c.type!=='image') return;
  if(State.videoTracks[c.vtrack||0]?.locked){ showToast('此視訊軌已鎖定'); return; }
  const S=Math.round((c.scale??1)*100), X=Math.round((c.posX??0.5)*100), Y=Math.round((c.posY??0.5)*100);
  const row=(id,label,val,min,max,unit)=>
    `<div>${label}：<input type="range" id="ig${id}R" min="${min}" max="${max}" step="1" value="${val}" style="width:180px;vertical-align:middle">`+
    ` <input type="number" id="ig${id}" min="${min}" max="${max}" step="1" value="${val}" style="width:64px">${unit}</div>`;
  openModal(`圖片大小與位置 — ${escapeHTML(c.name||'')}`,
    `<div style="font-size:13px;line-height:2.2">`+
    row('S','大小',S,2,800,'%')+row('X','水平位置',X,0,100,'%')+row('Y','垂直位置',Y,0,100,'%')+
    `<div style="color:var(--text-faint);font-size:12px;margin-top:8px">`+
    `大小＝圖片框佔畫面的比例（圖片依原始比例縮入該框）；位置＝圖片<b>中心</b>在畫面上的座標。`+
    `${c.natW>0?`原始尺寸 ${c.natW}×${c.natH}。`:''}預覽與匯出使用同一組數值。</div>`+
    `</div>`,
    [{label:'重設',act:()=>{ c.scale=1; c.posX=0.5; c.posY=0.5; closeModal(); drawTimeline(); emit('render:videoSub'); recordHistory('重設圖片大小與位置'); }},
     {label:'套用',primary:true,act:()=>{
        const v=(id,d)=>{ const n=+($(('ig'+id))?.value); return Number.isFinite(n)?n:d; };
        c.scale=Math.max(0.02,Math.min(8, v('S',S)/100));
        c.posX =Math.max(0,Math.min(1, v('X',X)/100));
        c.posY =Math.max(0,Math.min(1, v('Y',Y)/100));
        closeModal(); drawTimeline(); emit('render:videoSub'); recordHistory('圖片大小與位置：'+(c.name||''));
     }}]);
  // 滑桿與數字框雙向同步，並即時預覽（不入 undo，套用時才記一筆）
  setTimeout(()=>{
    for(const id of ['S','X','Y']){
      const r=$('ig'+id+'R'), n=$('ig'+id); if(!r||!n) continue;
      const live=()=>{ const val=+n.value;
        if(id==='S') c.scale=Math.max(0.02,Math.min(8,val/100));
        else if(id==='X') c.posX=Math.max(0,Math.min(1,val/100));
        else c.posY=Math.max(0,Math.min(1,val/100));
        emit('render:videoSub'); };
      r.oninput=()=>{ n.value=r.value; live(); };
      n.oninput=()=>{ r.value=n.value; live(); };
    }
  },0);
}

/* 影片段轉場（階段5）：淡入／淡出（秒）——匯出時影像 alpha 淡變＋音訊 afade 同步。
   淡到透明會露出下層／黑底；上層片段與下層重疊時的淡變即為軌間溶接（crossfade）。 */
function showClipFade(c){
  if(!c) return;
  const len=Math.max(0.1, Seq.len(c));
  const maxF=Math.max(0.1, Math.min(5, +len.toFixed(1)));
  const fi=Math.min(+(c.fadeIn||0), maxF), fo=Math.min(+(c.fadeOut||0), maxF);
  openModal(`淡入淡出（轉場）— ${escapeHTML(c.name||'')}`,
    `<div style="font-size:13px;line-height:2.2">`+
    `<div>淡入：<input type="range" id="cfIn" min="0" max="${maxF}" step="0.1" value="${fi}" style="width:180px;vertical-align:middle"> <span id="cfInV">${fi.toFixed(1)}s</span></div>`+
    `<div>淡出：<input type="range" id="cfOut" min="0" max="${maxF}" step="0.1" value="${fo}" style="width:180px;vertical-align:middle"> <span id="cfOutV">${fo.toFixed(1)}s</span></div>`+
    `<div style="color:var(--text-faint);font-size:12px;margin-top:8px">淡入從透明漸顯、淡出漸隱到透明（露出下層／黑底），音訊同步淡變。<b>匯出時生效</b>。若此片段在上層視訊軌且與下層重疊，淡變即為<b>軌間溶接</b>。</div>`+
    `</div>`,
    [{label:'清除',act:()=>{ c.fadeIn=0; c.fadeOut=0; closeModal(); drawTimeline(); recordHistory('清除轉場：'+(c.name||'')); }},
     {label:'套用',primary:true,act:()=>{
        c.fadeIn=Math.max(0,Math.min(maxF,+$('cfIn').value)); c.fadeOut=Math.max(0,Math.min(maxF,+$('cfOut').value));
        closeModal(); drawTimeline(); recordHistory('轉場：'+(c.name||''));
     }}]);
  setTimeout(()=>{
    const a=$('cfIn'), b=$('cfOut');
    if(a) a.oninput=()=>{ const e=$('cfInV'); if(e)e.textContent=(+a.value).toFixed(1)+'s'; };
    if(b) b.oninput=()=>{ const e=$('cfOutV'); if(e)e.textContent=(+b.value).toFixed(1)+'s'; };
  },0);
}
/* 交叉溶接（階段5.1）：把此片段移到上一層視訊軌、提前與「同軌前一段」尾端重疊 T 秒，
   前段淡出／此段淡入＝交叉溶接。完全複用「多軌 overlay＋淡變」的匯出（不改 filtergraph）。 */
function _prevTrackClip(c){
  return Seq.trackClips(c.vtrack||0).filter(x=>x!==c && x.offset < c.offset - 1e-4).sort((a,b)=>b.offset-a.offset)[0] || null;
}
function crossfadeWithPrev(c, T){
  const prev=_prevTrackClip(c);
  if(!prev){ showToast('前面沒有可溶接的片段（同一視訊軌）'); return; }
  T=Math.max(0.1, Math.min(T, Seq.len(c), Seq.len(prev)));
  const prevEnd=Seq.clipEnd(prev);
  const nv=(c.vtrack||0)+1; c.vtrack=nv; ensureVideoTrackCount(nv+1);
  c.offset=Math.max(0, prevEnd - T);
  // 只淡入上層（此段）：下層(前段)維持不透明當底，重疊處 50%A+50%B＝乾淨溶接（避免經過黑而變暗）
  c.fadeIn=T;
  Seq.sort(); Seq.recomputeDuration();
  recordHistory('交叉溶接：'+(prev.name||'')+'→'+(c.name||''));
  Media.seek(Math.min(Media.displayTime(), State.duration||0));
  drawTimeline(); emit('render:videoSub'); emit('mpv:refreshSubs');
  showToast(`已建立交叉溶接 ${T.toFixed(1)}s（${prev.name} → ${c.name}）`);
}
function showCrossfade(c){
  if(!c) return;
  const prev=_prevTrackClip(c);
  if(!prev){ showToast('前面沒有可溶接的片段（同一視訊軌）'); return; }
  const maxT=Math.max(0.2, Math.min(3, Seq.len(c), Seq.len(prev)));
  const defT=Math.min(1, maxT);
  openModal(`交叉溶接 — ${escapeHTML(prev.name||'')} → ${escapeHTML(c.name||'')}`,
    `<div style="font-size:13px;line-height:2.1">`+
    `<div>溶接時間：<input type="range" id="xfT" min="0.2" max="${maxT.toFixed(1)}" step="0.1" value="${defT.toFixed(1)}" style="width:180px;vertical-align:middle"> <span id="xfTV">${defT.toFixed(1)}s</span></div>`+
    `<div style="color:var(--text-faint);font-size:12px;margin-top:8px">會把此片段移到<b>上一層視訊軌</b>並提前與前一段尾端重疊，兩段在重疊處淡出／淡入＝交叉溶接（匯出時合成）。</div>`+
    `</div>`,
    [{label:'取消',act:closeModal},
     {label:'建立溶接',primary:true,act:()=>{ const T=+$('xfT').value; closeModal(); crossfadeWithPrev(c, T); }}]);
  setTimeout(()=>{ const s=$('xfT'); if(s)s.oninput=()=>{ const e=$('xfTV'); if(e)e.textContent=(+s.value).toFixed(1)+'s'; }; },0);
}

/* ===== 影片段選取（點選高亮、上下鍵切換、Del 刪除；行為比照字幕列） ===== */
function selectClip(id, opts={}){
  const c=Seq.byId(id); if(!c) return;
  if(!opts.force && State.videoTracks[c.vtrack||0]?.locked) return; // 鎖定軌：不可選取中間的影像片段
  State.selectedClipId=id;
  State.activeTrackKind='video';
  State.selectedAudioClipId=null;
  State.selectedId=null; State.selectedIds=[]; // 與字幕選取互斥（避免 Del/上下鍵語意衝突）
  refreshSelectionUI(); // 清除字幕列高亮
  $('stSel').textContent='已選影片段：'+c.name;
  if(opts.seek){ Media.seek(c.offset); emit('playhead:ensure'); emit('render:videoSub'); }
  renderClipBlocks();
}
function clearClipSelection(){
  if(State.selectedClipId==null) return;
  State.selectedClipId=null;
  $('stSel').textContent='';
  renderClipBlocks();
}
/* 上/下鍵：切換到上一段/下一段（依時間軸順序），選取並把播放頭移到段首。
   邊界延續（v4.23.x）：已在第一段再按上＝跳到影片頭（該段開頭）；已在最後一段再按下＝跳到影片尾（序列結尾）。 */
function navigateClip(dir){
  const sorted=[...State.clips].sort((a,b)=>a.offset-b.offset).filter(c=>!State.videoTracks[c.vtrack||0]?.locked); // 跳過鎖定軌
  if(!sorted.length) return;
  let idx=sorted.findIndex(c=>c.id===State.selectedClipId);
  if(idx<0){ // 尚無選取：從播放頭所在（或最接近）的段開始
    const t=Media.displayTime();
    idx=sorted.findIndex(c=>c.id===Media.activeClipId);
    if(idx<0){ idx=0; for(let i=0;i<sorted.length;i++){ if(sorted[i].offset<=t+1e-4) idx=i; } }
    selectClip(sorted[idx].id, {seek:true});
    return;
  }
  const ni=idx+dir;
  if(ni<0){ Media.seek(sorted[0].offset); emit('playhead:ensure'); emit('render:videoSub'); return; } // 第一段再上＝影片頭
  if(ni>=sorted.length){ // 最後段再下＝影片尾（序列結尾；退一格避免落在結尾外）
    const end=Math.max(0, Seq.end() - 1/(State.fps||25));
    Media.seek(end); emit('playhead:ensure'); emit('render:videoSub'); return;
  }
  selectClip(sorted[ni].id, {seek:true});
}
/* 關閉選取影片段「前方」的空白：把它往左移到緊貼前一段結尾；前面沒有素材則移到 00:00:00:00 */
function closeClipGapLeft(){
  const id=State.selectedClipId; if(id==null) return;
  const c=Seq.byId(id); if(!c) return;
  const sorted=Seq.trackClips(c.vtrack||0).sort((a,b)=>a.offset-b.offset); // 同一視訊軌內
  const idx=sorted.findIndex(x=>x.id===id);
  const target = idx>0 ? Seq.clipEnd(sorted[idx-1]) : 0; // 前一段（同軌）結尾，或軌道開頭
  if(Math.abs(c.offset - target) < 1e-4) return; // 已無空白
  c.offset = target;
  Seq.sort(); Seq.recomputeDuration();
  recordHistory('關閉前方空白：'+c.name);
  Media.seek(Math.min(Media.displayTime(), State.duration||0)); // 幾何變了→重新解析映射
  drawTimeline(); emit('render:videoSub'); emit('mpv:refreshSubs');
}
/* 刪除選取的影片段（至少保留一段），並選取相鄰段方便連續刪除 */
function deleteSelectedClip(){
  const id=State.selectedClipId; if(id==null) return;
  const sorted=[...State.clips].sort((a,b)=>a.offset-b.offset);
  const idx=sorted.findIndex(c=>c.id===id);
  const c=Seq.byId(id);
  if(c && State.videoTracks[c.vtrack||0]?.locked){ showToast('此視訊軌已鎖定，無法刪除片段'); return; }
  if(Media.removeClip(id)){
    recordHistory('刪除影片段：'+(c?c.name:''));
    const rest=[...State.clips].sort((a,b)=>a.offset-b.offset);
    const next=rest[Math.min(idx, rest.length-1)];
    if(next){ State.selectedClipId=next.id; $('stSel').textContent='已選影片段：'+next.name; }
    else State.selectedClipId=null;
    drawTimeline();
  }
}

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
    g.title=`${row.label}\n聲音：${muted?'已關閉':'已開啟'}（點喇叭按鈕切換）\n波形：${waveLabel}\n在右側素材區塊按右鍵切換 MIX／來源聲道`;
    g.innerHTML=`<span class="alabel">S${row.index+1}</span>`+
      muteButtonMarkup(muted,row.external?'音檔':'影音素材')+
      `<span class="aname" title="${escapeHTML(row.label)}">${escapeHTML(row.label)}</span>`+
      `<span class="audio-clip-route">${escapeHTML(waveLabel)}</span>`+
      `<button class="alock${isLocked?' locked':''}" title="${isLocked?'解鎖此軌':'鎖定此軌'}">${isLocked?'🔒':'🔓'}</button>`;
    g.addEventListener('click', ev => {
      if (ev.target.closest('.audio-clip-mute,.alock')) return;
      State.activeTrackKind = 'audio';
      State.selectedId = null; State.selectedIds = []; State.selectedClipId = null; State.selectedAudioClipId = null;
      refreshSelectionUI();
      renderClipBlocks();
      renderAudioTrackRows();
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
      source.locked=!source.locked;
      drawTimeline();
    });
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
  renderClipBlocks(); // 波形列上的影片區塊與字幕區塊同步重繪（捲動/縮放/全繪路徑共用此入口）
  tlTracks.querySelectorAll('.cue-block,.cue-overlap').forEach(e=>e.remove());
  const rows=[...tlTracks.querySelectorAll('.tl-track')];
  const vw=viewportW(); const t0=State.viewStart, t1=State.viewStart+vw/State.pxPerSec;
  // P2：單趟 O(N) 依「邏輯軌道」分桶（取代每軌各跑一次 State.cues.filter 的 O(tracks×N)），
  // 同一趟順便建立可見區塊。重疊掃描改用分桶結果。
  const byTrack=new Map();
  for(const c of State.cues){
    if(c.timed===false)continue;
    const tk=c.track||0;
    let arr=byTrack.get(tk); if(!arr){ arr=[]; byTrack.set(tk,arr); } arr.push(c);
    if(c.end<t0||c.start>t1)continue; // 視窗裁切後才建 DOM
    const row=rows[Math.min(tk,rows.length-1)]; if(!row)continue;
    const el=document.createElement('div');
    el.className='cue-block'+(isSel(c.id)?' sel':'')+(isSel(c.id)&&State.selectedIds.length>1?' multi':'')+(c.id===State.selectedId?' primary':'');
    const x1 = timeToX(c.start);
    const x2 = timeToX(c.end);
    el.style.left = x1 + 'px';
    el.style.width = Math.max(2, x2 - x1) + 'px';
    el.dataset.id=c.id;
    el.innerHTML='<div class="edge l"></div><div style="flex:1;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;line-height:1.2;pointer-events:none;">'+(c.style?'<span title="此句有樣式覆蓋" style="color:var(--accent)">✱ </span>':'')+escapeHTML(c.text||'').replace(/\n/g,'<br>')+'</div><div class="edge r"></div>';
    row.appendChild(el);
  }
  // 重疊區域：粉紅底色（用分桶結果，雙層 break；保留每桶排序以防 State.cues 暫時未排序）
  for(const [tk,tc] of byTrack){
    const row=rows[Math.min(tk,rows.length-1)]; if(!row)continue;
    tc.sort((a,b)=>a.start-b.start);
    for(let i=0;i<tc.length-1;i++){
      for(let j=i+1;j<tc.length;j++){
        if(tc[j].start>=tc[i].end - 0.001)break;
        const os=tc[j].start, oe=Math.min(tc[i].end,tc[j].end);
        if(oe<=t0||os>=t1)continue;
        const vs=Math.max(os,t0), ve=Math.min(oe,t1);
        const ov=document.createElement('div'); ov.className='cue-overlap';
        const x1 = timeToX(vs);
        const x2 = timeToX(ve);
        ov.style.left = x1 + 'px';
        ov.style.width = Math.max(2, x2 - x1) + 'px';
        ov.dataset.id1 = tc[i].id;
        ov.dataset.id2 = tc[j].id;
        row.appendChild(ov);
      }
    }
  }
}
/* y 座標 -> 軌道索引（含垂直捲動位移） */
function trackFromY(clientY){
  const rect=tlLayer.getBoundingClientRect();
  const y=clientY-rect.top-tracksTop()+tracksScrollTop();
  return yToTrack(Math.max(0,y));
}
function addTrack(){ State.tracks.push(newTrack()); syncTrackCount(); drawTimeline(); emit('render:listTrackSel'); recordHistory('新增軌道'); }
function removeTrack(i){
  const n=State.cues.filter(c=>(c.track||0)===i).length;
  const doRemove=()=>{
    State.cues=State.cues.filter(c=>(c.track||0)!==i);
    State.cues.forEach(c=>{ if((c.track||0)>i)c.track=(c.track||0)-1; });
    State.tracks.splice(i,1); syncTrackCount();
    if(State.listTrack===i)State.listTrack=-1; else if(State.listTrack>i)State.listTrack--;
    State.selectedIds=State.selectedIds.filter(id=>State.cues.some(c=>c.id===id));
    if(!State.cues.some(c=>c.id===State.selectedId)){State.selectedId=State.selectedIds[0]||null;State.activeEdge='start';}
    emit('render:listTrackSel'); emit('render:all'); drawTimeline(); recordHistory('刪除軌道');
  };
  // Fix #15：改用 openModal，避免 confirm() 在 Electron 中被截取或樣式不一致
  if(n>0){
    openModal(`刪除軌道「${escapeHTML(State.tracks[i].name)}」`,
      `<p>此軌道有 <b>${n}</b> 條字幕，刪除後一併移除。確定繼續？</p>`,
      [{label:'取消',act:closeModal},
       {label:'確定刪除',primary:true,act:()=>{ closeModal(); doRemove(); }}]);
  } else { doRemove(); }
}
/* 把選取的字幕移到指定軌道（或位移 delta） */
function moveSelectedToTrack(target){
  const ids=State.selectedIds.length?State.selectedIds:[State.selectedId].filter(Boolean);
  if(!ids.length)return;
  for(const id of ids){ const c=State.cues.find(x=>x.id===id); if(c)c.track=clamp(target,0,State.trackCount-1); }
  emit('render:all'); drawTimeline(); recordHistory('移動至軌道');
}

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
// Fix #9：不重建 renderTrackRows 的輕量版，供捲動/播放以外的重繪使用
function redrawTimeline(){
  drawRuler(); drawWave(); renderCueBlocks(); updatePlayhead();
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
function setZoom(px,centerTime){
  const c = centerTime!=null?centerTime:Media.displayTime();
  State.pxPerSec=clamp(px,0.1,4000);
  $('zoomBar').value=clamp(State.pxPerSec,0.1,4000);
  layoutTimeline();
  // 維持 center 在畫面內
  const target=c*State.pxPerSec - viewportW()/2;
  tlScroll.scrollLeft=clamp(target,0,Math.max(0,tlTotal()*State.pxPerSec-viewportW()));
  State.viewStart=tlScroll.scrollLeft/State.pxPerSec;
  drawTimeline();
}
function zoomFit(){
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
  const MIN_PPS=Math.round(80*Math.pow(1.3,4)); // ≈228：比預設最小值高 4 階
  const ideal=(vw-40)/dur;
  const pps=clamp(Math.max(ideal,MIN_PPS),4,800);
  // 以播放點為中心（夾在字幕範圍內）—— 確保播放點可見
  const vt=Media.displayTime();
  const center=clamp(vt,t0,t1);
  setZoom(pps,center);
}
function zoomFitVideo(){
  const vw=viewportW(); if(!vw) return;
  const dur=State.duration>0?State.duration:1;
  const pps=(vw-40)/dur;
  setZoom(pps, dur/2);
}

/* 點擊任何地方都會確認正在編輯的軌道名稱（capture 階段先於 preventDefault） */
document.addEventListener('mousedown',e=>{
  const gn=document.querySelector('.gname[contenteditable="true"]');
  if(gn&&!gn.contains(e.target)) gn.blur();
},true);

/* 時間軸滑鼠互動：時間尺拖曳=移動播放點 / 軌道空白拖曳=框選 / 拖區塊=移動換軌或縮放 */
let drag=null;
let _noteClickState=null; // 備註標記雙擊偵測 { id, t }
tlScroll.addEventListener('mousedown',e=>{
  if(e.button!==0)return;
  hideCtx();
  /* 影片序列區塊：拖曳=移動 offset、拖左右邊緣=修剪 in/out（不可與相鄰影片重疊） */
  const clipEl=e.target.closest('.clip-block');
  if(clipEl){
    const c=Seq.byId(clipEl.dataset.clipId); if(!c)return;
    if(State.videoTracks[c.vtrack||0]?.locked){ e.preventDefault(); return; } // 鎖定軌：禁止選取／移動／修剪
    const mode=e.target.classList.contains('edge')?(e.target.classList.contains('l')?'clip-l':'clip-r'):'clip-move'; // 需在 selectClip 重繪前判斷（用 e.target 的 class）
    selectClip(c.id); // 點擊即選取（非破壞性，先做——不受存檔守衛擋住）
    if(!isProjectGuardDone()){ ensureProjectSaved(); e.preventDefault(); return; } // 拖曳/修剪前先存檔
    if(e.detail<2) jklReset(); // 播放中拖動影片區塊 → 先暫停（映射不可邊播邊變）
    const nb=Seq.neighborBounds(c);
    // selectClip 內 renderClipBlocks() 已把原 clipEl 重建成新節點；必須重抓，否則拖曳更新的是脫離 DOM 的孤兒（框不動、只有波形動）
    const liveEl=(tlVtracks&&tlVtracks.querySelector(`.clip-block[data-clip-id="${c.id}"]`))||clipEl;
    drag={mode, clip:c, clipEl:liveEl, startX:e.clientX, startY:e.clientY, startScroll:tlScroll.scrollLeft, moved:false,
      os:c.offset, oin:c.in, oout:c.out,
      leftLim:nb.lo, rightLim:(nb.hi===Infinity?Infinity:nb.hi+(c.out-c.in)), // 右鄰左緣（時間軸）
      nb, snaps:[...snapTargets(new Set()), ...Seq.snapEdges(c.id)]};
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
    // 第一次拖曳前的儲存守衛（同步，不 await，避免拖曳殘留問題）
    if(!isProjectGuardDone()){ ensureProjectSaved(); e.preventDefault(); return; }
    if(State.tracks[c.track||0]?.locked){
      // 鎖定軌道：僅允許選取，不允許拖曳移動
      if(!isSel(c.id)) selectCue(c.id); e.preventDefault(); return;
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
          State.selectedIds=list.slice(lo,hi+1).map(z=>z.id);
          State.activeEdge='start';
          refreshSelectionUI(); $('stSel').textContent='已選 '+State.selectedIds.length+' 條';
          e.preventDefault(); return;
        }
      }
      // 不同軌道：保持現有選取不變
      e.preventDefault(); return;
    }
    const mode = e.target.classList.contains('edge')? (e.target.classList.contains('l')?'l':'r') : 'move';
    const isCtrl = e.ctrlKey||e.metaKey;
    // Ctrl/Cmd 已有複製行為；Alt 拖曳字幕區塊也複製，但不影響邊緣修剪。
    const isCopyDrag = mode==='move' && (e.altKey||isCtrl);
    if(isCtrl && mode!=='move'){ selectCue(c.id,{additive:true}); if(!isSel(c.id)){ e.preventDefault(); return; } }
    else if(!isCtrl && !isSel(c.id)) selectCue(c.id);
    const grpIds = (mode==='move' && isSel(c.id) && State.selectedIds.length>1) ? State.selectedIds : [c.id];
    const exSet=new Set(grpIds);
    const grp=grpIds.map(id=>State.cues.find(z=>z.id===id)).filter(Boolean)
      .map(cc=>{ const b=neighborBounds(cc.start,cc.end,cc.track||0,exSet); return {c:cc,el:tlTracks.querySelector(`.cue-block[data-id="${cc.id}"]`),os:cc.start,oe:cc.end,ot:cc.track||0,prevEnd:b.prevEnd,nextStart:b.nextStart}; }); // P3：快取區塊 element 參照
    drag={c,mode,startX:e.clientX,startY:e.clientY,startScroll:tlScroll.scrollLeft,os:c.start,oe:c.end,ot:c.track||0,grp,moved:false,
      snaps:snapTargets(exSet), isCtrl,isCopyDrag};
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
        Media.seek(hitNote.time); updatePlayhead(); emit('render:videoSub'); emit('playhead:ensure');
        e.preventDefault(); return;
      }
    }
    jklReset(); // 播放中拖曳時間尺 → 暫停
    const snaps = snapTargets(new Set());
    const currentThr = e.altKey ? 0 : 8/State.pxPerSec;
    const t = xToTime(x);
    const sn = snapVal(t, snaps, currentThr);
    Media.seek(sn !== t ? sn : snapFrame(t)); updatePlayhead(); emit('render:videoSub');
    drag={mode:'scrub', snaps}; e.preventDefault(); return;
  }
  drag={mode:'rubber',startX:e.clientX,startY:e.clientY,startScroll:tlScroll.scrollLeft,x0:x,y0:y,moved:false,additive:e.ctrlKey||e.metaKey};
  e.preventDefault();
});
let _autoScrollId = null;

const _handleDragUpdate = (e) => {
  if(!drag)return;
  const rect=tlLayer.getBoundingClientRect();
  const currentThr = e.altKey ? 0 : 8 / State.pxPerSec;
  if(drag.mode==='scrub'){
    const t = xToTime(e.clientX-rect.left);
    const sn = snapVal(t, drag.snaps, currentThr);
    Media.seek(sn !== t ? sn : snapFrame(t));
    updatePlayhead(); emit('render:videoSub'); 
    updateSnapGuide(null); return;
  }
  if(drag.mode!=='scrub'){ // 含 cue 模式與 clip-move/clip-l/clip-r
    if (!drag.moved && (Math.abs(e.clientX-drag.startX)>3||Math.abs(e.clientY-drag.startY)>3)) {
      drag.moved = true;
      if (drag.isCopyDrag && drag.mode === 'move' && drag.grp) {
        // Clone cues
        const newIds = [];
        drag.grp.forEach(it => {
           const cloned = { ...it.c, id: newId(), style: it.c.style ? JSON.parse(JSON.stringify(it.c.style)) : undefined };
           State.cues.push(cloned);
           newIds.push(cloned.id);
           it.c = cloned;
        });
        State.selectedIds = newIds;
        State.selectedId = newIds[newIds.length - 1];
        State.activeEdge = 'start';
        // Re-render blocks so drag can update their DOM elements
        drawTimeline();
        drag.grp.forEach(it => {
           it.el = tlTracks.querySelector(`.cue-block[data-id="${it.c.id}"]`);
        });
        refreshSelectionUI();
      }
    }
  }
  if(drag.mode==='rubber'){
    const currentX0 = drag.x0 - (tlScroll.scrollLeft - drag.startScroll);
    const x1=clamp(e.clientX-rect.left,0,viewportW()), y1=clamp(e.clientY-rect.top,0,tlLayer.clientHeight);
    const rb=$('tlRubber'); rb.style.display='block';
    rb.style.left=Math.min(currentX0,x1)+'px'; rb.style.top=Math.min(drag.y0,y1)+'px';
    rb.style.width=Math.abs(x1-currentX0)+'px'; rb.style.height=Math.abs(y1-drag.y0)+'px';
    return;
  }
  if(!drag.moved) return; // 未超過門檻：單擊不應移動/縮放字幕
  let dt=(e.clientX-drag.startX + (tlScroll.scrollLeft - drag.startScroll))/State.pxPerSec;
  /* ---- 影片序列區塊拖曳 ---- */
  if(drag.mode==='clip-move'||drag.mode==='clip-l'||drag.mode==='clip-r'){
    const c=drag.clip, minL=0.2; // 最短保留 0.2s
    let tgt=null;
    if(drag.mode==='clip-move'){
      // 自由拖移（如一般剪輯軟體）：不受鄰居夾限，可放到時間軸任意位置；
      // 重疊在放開時由 Seq.resolveOverlaps 以插入語義解算（被壓到的段落連鎖右推）
      let no=drag.os+dt;
      const L=drag.oout-drag.oin;
      const s1=snapVal(no,drag.snaps,currentThr), s2=snapVal(no+L,drag.snaps,currentThr);
      if(s1!==no){ no=s1; tgt=s1; } else if(s2!==no+L){ no=s2-L; tgt=s2; }
      if(no<0)no=0;
      c.offset=snapFrame(no);
      // 上下拖曳＝換視訊軌（於現有軌間移動；要新增軌請用列頭的＋）
      const nv=clipTrackFromY(e.clientY);
      if(nv!==(c.vtrack||0) && !State.videoTracks[nv]?.locked) c.vtrack=nv; // 不可放入鎖定軌
    } else if(drag.mode==='clip-l'){
      // 修剪左緣：offset 與 in 同步位移 d；界線＝in≥0、留 minL、不越左鄰
      let d=dt;
      d=Math.max(d, -drag.oin, drag.leftLim-drag.os);
      d=Math.min(d, (drag.oout-minL)-drag.oin);
      let nl=drag.os+d;
      const sn=snapVal(nl,drag.snaps,currentThr);
      if(sn!==nl){ const cd=sn-drag.os;
        if(cd>=-drag.oin-1e-9 && cd<=(drag.oout-minL)-drag.oin+1e-9 && sn>=drag.leftLim-1e-9){ d=cd; nl=sn; tgt=sn; } }
      nl=snapFrame(Math.max(0,nl)); d=nl-drag.os;
      c.offset=nl; c.in=Math.max(0, drag.oin+d);
    } else {
      // 修剪右緣：out∈[in+minL, dur]；時間軸右緣不越右鄰
      let edge=drag.os+(drag.oout+dt-drag.oin); // 時間軸右緣
      const maxEdge=Math.min(drag.rightLim, drag.os+(c.dur-drag.oin));
      const minEdge=drag.os+minL;
      edge=clamp(edge,minEdge,maxEdge);
      const sn=snapVal(edge,drag.snaps,currentThr);
      if(sn!==edge && sn>=minEdge-1e-9 && sn<=maxEdge+1e-9){ edge=sn; tgt=sn; }
      edge=snapFrame(edge);
      c.out=clamp(drag.oin+(edge-drag.os), drag.oin+minL, c.dur);
    }
    updateSnapGuide(tgt);
    const x1=timeToX(c.offset), x2=timeToX(Seq.clipEnd(c));
    drag.clipEl.style.left=x1+'px'; drag.clipEl.style.width=Math.max(6,x2-x1)+'px';
    // 換軌時把片段移入對應視訊軌列（top/height 由 CSS 相對列自動決定）
    if(drag.mode==='clip-move' && tlVtracks){
      const row=tlVtracks.querySelector(`.vtrack-row[data-vtrack="${c.vtrack||0}"]`);
      if(row && drag.clipEl.parentElement!==row) row.appendChild(drag.clipEl);
    }
    drawWave(); // 波形跟著區塊走
    return;
  }
  /* ---- 外部音訊素材拖曳 ----
     拖曳中只更新 DOM 預覽，放開時才寫回 Media；這樣不會每一個 mousemove 都重建
     AudioNode / cache，也避免波形在拖曳期間閃爍。 */
  if(drag.mode==='audio-move'||drag.mode==='audio-l'||drag.mode==='audio-r'){
    const minL=Math.min(0.2,Math.max(0.02,(drag.oout-drag.oin)/2));
    const maxOut=Math.max(drag.oin+minL,drag.duration||drag.oout);
    let offset=drag.os, inPoint=drag.oin, outPoint=drag.oout, target=null;
    if(drag.mode==='audio-move'){
      let next=Math.max(0,drag.os+dt);
      const len=drag.oout-drag.oin;
      const atStart=snapVal(next,drag.snaps,currentThr);
      const atEnd=snapVal(next+len,drag.snaps,currentThr);
      if(atStart!==next){ next=atStart; target=atStart; }
      else if(atEnd!==next+len){ next=atEnd-len; target=atEnd; }
      offset=snapFrame(Math.max(0,next));
    }else if(drag.mode==='audio-l'){
      const minLeft=Math.max(0,drag.os-drag.oin);
      const maxLeft=drag.os+(drag.oout-drag.oin-minL);
      let next=clamp(drag.os+dt,minLeft,maxLeft);
      const snapped=snapVal(next,drag.snaps,currentThr);
      if(snapped>=minLeft-1e-9&&snapped<=maxLeft+1e-9&&snapped!==next){ next=snapped; target=snapped; }
      offset=snapFrame(next);
      inPoint=clamp(drag.oin+(offset-drag.os),0,drag.oout-minL);
    }else{
      const minRight=drag.os+minL;
      const maxRight=drag.os+(maxOut-drag.oin);
      let right=clamp(drag.os+(drag.oout-drag.oin)+dt,minRight,maxRight);
      const snapped=snapVal(right,drag.snaps,currentThr);
      if(snapped>=minRight-1e-9&&snapped<=maxRight+1e-9&&snapped!==right){ right=snapped; target=snapped; }
      right=snapFrame(right);
      outPoint=clamp(drag.oin+(right-drag.os),drag.oin+minL,maxOut);
    }
    drag.preview={offset,in:inPoint,out:outPoint};
    updateSnapGuide(target);
    const x1=timeToX(offset), x2=timeToX(offset+Math.max(0,outPoint-inPoint));
    drag.audioEl.style.left=x1+'px';
    drag.audioEl.style.width=Math.max(6,x2-x1)+'px';
    drag.audioEl.classList.add('dragging');
    return;
  }
  if(drag.mode==='move'){
    // 防重疊：限制 dt 使每條都不越過同軌鄰居
    if(!State.overwriteMode){
      for(const it of drag.grp){
        const minDt=it.prevEnd-it.os, maxDt=(it.nextStart===Infinity?Infinity:it.nextStart-it.oe);
        if(dt<minDt)dt=minDt; if(maxDt!==Infinity&&dt>maxDt)dt=maxDt;
      }
    }
    const minOs=Math.min(...drag.grp.map(g=>g.os)); if(minOs+dt<0)dt=-minOs;
    // 磁吸（單選時依主字幕起/訖 → 播放點與其他字幕邊界）
    let targetSn = null;
    let snapAnchor = 'start';
    if(drag.grp.length===1){
      const it=drag.grp[0], len=it.oe-it.os, ns=it.os+dt;
      const s1=snapVal(ns,drag.snaps,currentThr), s2=snapVal(ns+len,drag.snaps,currentThr);
      let snapped=ns; 
      if(s1!==ns) { snapped=s1; targetSn=s1; snapAnchor='start'; } 
      else if(s2!==ns+len) { snapped=s2-len; targetSn=s2; snapAnchor='end'; }
      let sdt=snapped-it.os;
      if(!State.overwriteMode){
        const minDt=it.prevEnd-it.os, maxDt=(it.nextStart===Infinity?Infinity:it.nextStart-it.oe);
        if(sdt<minDt)sdt=minDt; if(maxDt!==Infinity&&sdt>maxDt)sdt=maxDt;
      }
      if(it.os+sdt<0)sdt=-it.os;
      dt=sdt;
    }
    updateSnapGuide(targetSn);
    const minOt=Math.min(...drag.grp.map(g=>g.ot)), maxOt=Math.max(...drag.grp.map(g=>g.ot));
    const dTk=clamp(trackFromY(e.clientY)-drag.ot, -minOt, State.trackCount-1-maxOt);
    for(const it of drag.grp){
      const len=it.oe-it.os;
      if (snapAnchor === 'end') {
        it.c.end = snapFrame(it.oe+dt);
        it.c.start = snapFrame(it.c.end-len);
      } else {
        it.c.start = snapFrame(it.os+dt);
        it.c.end = snapFrame(it.c.start+len);
      }
      it.c.track=it.ot+dTk;
    }
  }else if(drag.mode==='l'){
    const it=drag.grp[0];
    let ns=State.overwriteMode ? Math.max(0, it.os+dt) : clamp(it.os+dt, it.prevEnd, drag.c.end-0.05);
    const sn=snapVal(ns,drag.snaps,currentThr);
    let targetSn = null;
    if(State.overwriteMode){ if(sn>=0 && sn<=drag.c.end-0.05) { ns=sn; targetSn=sn; } }
    else { if(sn>=it.prevEnd && sn<=drag.c.end-0.05) { ns=sn; targetSn=sn; } }
    drag.c.start=snapFrame(ns);
    updateSnapGuide(targetSn);
  }else if(drag.mode==='r'){
    const it=drag.grp[0];
    let ne=State.overwriteMode ? (drag.oe+dt) : clamp(drag.oe+dt, drag.c.start+0.05, it.nextStart);
    const sn=snapVal(ne,drag.snaps,currentThr);
    let targetSn = null;
    if(State.overwriteMode){ if(sn>=drag.c.start+0.05) { ne=sn; targetSn=sn; } }
    else { if(sn>=drag.c.start+0.05 && sn<=it.nextStart) { ne=sn; targetSn=sn; } }
    drag.c.end=snapFrame(ne);
    updateSnapGuide(targetSn);
  }
  
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
  updateSnapGuide(null);
  if(_autoScrollId) { cancelAnimationFrame(_autoScrollId); _autoScrollId = null; }
  if(drag.mode==='rubber'){
    $('tlRubber').style.display='none';
    const rect=tlLayer.getBoundingClientRect();
    if(drag.moved){
      const currentX0 = drag.x0 - (tlScroll.scrollLeft - drag.startScroll);
      const x1=clamp(e.clientX-rect.left,0,viewportW()), y1=e.clientY-rect.top;
      const ta=xToTime(Math.min(currentX0,x1)), tb=xToTime(Math.max(currentX0,x1));
      const sc=tracksScrollTop();
      const rowA=yToTrack(Math.max(0,Math.min(drag.y0,y1)-tracksTop()+sc));
      const rowB=yToTrack(Math.max(0,Math.max(drag.y0,y1)-tracksTop()+sc));
      const hit=State.cues.filter(c=>c.timed!==false&&(c.track||0)>=rowA&&(c.track||0)<=rowB&&c.end>=ta&&c.start<=tb).map(c=>c.id);
      if(drag.additive){ for(const id of hit)if(!State.selectedIds.includes(id))State.selectedIds.push(id); }
      else State.selectedIds=hit;
      State.selectedId=State.selectedIds[State.selectedIds.length-1]||null; State.activeEdge='start';
      refreshSelectionUI(); $('stSel').textContent='已選 '+State.selectedIds.length+' 條';
    }else{
      // 點時間軸空白：跳轉（Shift 時保留選取）
      Media.seek(xToTime(e.clientX-rect.left)); updatePlayhead(); emit('render:videoSub');
      if(!e.shiftKey){
        State.selectedIds=[]; State.selectedId=null; State.activeEdge='start';
        clearClipSelection();
        refreshSelectionUI(); $('stSel').textContent='';
      }
    }
    if(drag.moved) clearClipSelection(); // 框選字幕時取消影片段選取
  }else if(drag.mode==='clip-move'||drag.mode==='clip-l'||drag.mode==='clip-r'){
    const moved=drag.moved, m=drag.mode, c=drag.clip;
    if(!moved){ selectClip(c.id); drag=null; return; } // 未拖動＝點選該影片段（高亮，供上下鍵/Del）
    if(m==='clip-move'){ Seq.resolveOverlaps(c); Seq.compact(); } // 自由拖放：同軌連鎖右推；收斂空的頂部視訊軌
    Seq.sort(); Seq.recomputeDuration();
    recordHistory(m==='clip-move'?('移動影片：'+c.name):('修剪影片：'+c.name));
    // 幾何變了 → 以目前播放頭重新解析映射（active clip 可能移走/縮短成間隙）
    Media.seek(Math.min(Media.displayTime(), State.duration||0));
    emit('render:videoSub'); emit('mpv:refreshSubs');
    drawTimeline();
  }else if(drag.mode==='audio-move'||drag.mode==='audio-l'||drag.mode==='audio-r'){
    const moved=drag.moved, mode=drag.mode, assetId=drag.audioAssetId, preview=drag.preview;
    try{
      if(drag.pointerId!=null&&drag.audioEl?.hasPointerCapture?.(drag.pointerId)) drag.audioEl.releasePointerCapture(drag.pointerId);
    }catch(_){}
    _ignoreAudioClickUntil=performance.now()+350;
    if(!moved){ selectExternalAudioClip(assetId,{seek:true}); drag=null; return; }
    if(mode==='audio-move'){
      runExternalAudioAction('moveExternalAudio',[assetId,preview.offset]);
    }else if(mode==='audio-l'){
      runExternalAudioAction('trimExternalAudio',[assetId,'start',preview.offset]);
    }else{
      runExternalAudioAction('trimExternalAudio',[assetId,'end',preview.offset+Math.max(0,preview.out-preview.in)]);
    }
  }else if(drag.mode!=='scrub'){
    const moved=drag.moved, m=drag.mode;
    if (!moved && drag.isCtrl && m==='move') {
      selectCue(drag.c.id, {additive:true});
    } else if (moved) {
      sweepContainedCues(drag.grp.map(x=>x.c));
      sortCues(); emit('render:all');
      recordHistory(drag.isCopyDrag ? `複製字幕` : (m==='move'?(drag.grp.length>1?`移動字幕 (${drag.grp.length}條)`:'移動字幕'+cueSuffix(drag.c)):'調整字幕時間'+cueSuffix(drag.c)));
    }
  }
  drag=null;
});

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
function snapTargets(excludeIds){
  const arr=[snapFrame(Media.displayTime())];
  for(const c of State.cues){ if(c.timed===false||excludeIds.has(c.id))continue; arr.push(c.start,c.end); }
  for(const n of State.notes) arr.push(n.time);
  return arr;
}
function snapVal(t,targets,thr){ let best=t,bd=thr; for(const x of targets){const d=Math.abs(x-t); if(d<bd){bd=d;best=x;}} return best; }
function neighborBounds(os,oe,track,excludeIds){
  let prevEnd=0,nextStart=Infinity;
  const oMid = (os + oe) / 2;
  for(const c of State.cues){
    if(c.timed===false||excludeIds.has(c.id)||(c.track||0)!==track)continue;
    const cMid = (c.start + c.end) / 2;
    if(cMid < oMid){
      if(c.end > prevEnd) prevEnd = c.end;
    } else {
      if(c.start < nextStart) nextStart = c.start;
    }
  }
  return {prevEnd,nextStart};
}

export { RULER_H, WAVE_H, ROW_H, tracksTop, tracksScrollTop, viewportW, timeToX, xToTime,
  layoutTimeline, drawRuler, niceStep, fmtTick, drawWave, renderTrackRows, renderCueBlocks, trackFromY,
  addTrack, removeTrack, moveSelectedToTrack, updatePlayhead, drawTimeline, redrawTimeline, setZoom, zoomFit, zoomFitVideo,
  refreshTrackGutterActive, snapTargets, snapVal, neighborBounds,
  selectClip, clearClipSelection, navigateClip, deleteSelectedClip, closeClipGapLeft, showClipFade, showCrossfade, showImageGeom };
