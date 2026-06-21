/* SUB Tool — 時間軸：渲染（尺/波形/軌道/區塊）與互動（拖曳/框選/縮放） */
import { $, video, tlScroll, tlLayer, tlTracks, rulerCv, waveCv } from './dom.js';
import { State, trackVisible, newTrack, syncTrackCount, isSel } from './state.js';
import { clamp, pad, escapeHTML } from './util.js';
import { Media, Wave } from './media.js';
import { selectCue, refreshSelectionUI, renderSubRow, sortCues } from './subtitles.js';
import { renderAll, renderVideoSub, renderListTrackSel, renderTrackStyle, showToast, snapTargets, snapVal, neighborBounds, ensurePlayheadVisible, openNoteInPanel, openCueEditModal } from './app.js';
import { jklReset } from './keyboard.js';
import { recordHistory } from './history.js';
import { hideCtx, showCueMenu } from './menus.js';

/* ===== 5. 時間軸 ====================================================== */
const RULER_H=24, WAVE_H=48, ROW_H=40;
function tracksTop(){return RULER_H+WAVE_H;}
let trackRowH=()=>ROW_H;
function tracksScrollTop(){ return tlTracks?tlTracks.scrollTop:0; }

function viewportW(){return tlScroll.clientWidth;}
function timeToX(t){return (t-State.viewStart)*State.pxPerSec;}
function xToTime(x){return State.viewStart + x/State.pxPerSec;}

function tlTotal(){
  const maxCueEnd=State.cues.length?Math.max(...State.cues.map(c=>c.end)):0;
  const extra=Math.max(30,State.duration*0.15);
  return Math.max(State.duration,maxCueEnd,1)+extra;
}
function layoutTimeline(){
  const total=tlTotal();
  $('tlSpacer').style.width=(total*State.pxPerSec)+'px';
  const vw=viewportW();
  tlLayer.style.width=vw+'px';
  rulerCv.width=vw*devicePixelRatio; rulerCv.height=RULER_H*devicePixelRatio;
  rulerCv.style.width=vw+'px'; rulerCv.style.height=RULER_H+'px';
  waveCv.width=vw*devicePixelRatio; waveCv.height=WAVE_H*devicePixelRatio;
  waveCv.style.width=vw+'px'; waveCv.style.height=WAVE_H+'px'; waveCv.style.top=RULER_H+'px';
  tlTracks.style.top=tracksTop()+'px';
}
function drawRuler(){
  const ctx=rulerCv.getContext('2d'); const dpr=devicePixelRatio;
  ctx.save();ctx.scale(dpr,dpr);
  const vw=viewportW();
  ctx.clearRect(0,0,vw,RULER_H);
  ctx.fillStyle='#1d1d20';ctx.fillRect(0,0,vw,RULER_H);
  // 選擇刻度間隔
  const targetPx=80; let step=niceStep(targetPx/State.pxPerSec);
  const t0=State.viewStart, t1=State.viewStart+vw/State.pxPerSec;
  ctx.fillStyle='#8a8a92';ctx.font='10px Consolas,monospace';ctx.textBaseline='middle';
  ctx.strokeStyle='#3a3a40';ctx.beginPath();
  let first=Math.ceil(t0/step)*step;
  for(let t=first;t<=t1;t+=step){
    const x=timeToX(t);
    ctx.moveTo(x,RULER_H-7);ctx.lineTo(x,RULER_H);
    ctx.fillText(fmtTick(t),x+3,RULER_H/2);
    // 次刻度
  }
  ctx.stroke();
  // 備忘標記（可點擊橘色三角，較大）
  if(State.notes.length){
    for(const n of State.notes){
      const nx=timeToX(n.time); if(nx<-10||nx>vw+10)continue;
      ctx.fillStyle='#f0a030';
      ctx.beginPath();ctx.moveTo(nx,RULER_H);ctx.lineTo(nx-8,RULER_H-14);ctx.lineTo(nx+8,RULER_H-14);ctx.closePath();ctx.fill();
      ctx.strokeStyle='#ffcc60';ctx.lineWidth=1;ctx.stroke();
    }
  }
  ctx.restore();
}
function niceStep(s){ // 給定每像素秒數，回傳漂亮刻度秒
  const steps=[0.04,0.1,0.2,0.5,1,2,5,10,15,30,60,120,300,600,1800,3600];
  for(const v of steps)if(v>=s)return v; return 3600;
}
function fmtTick(s){
  if(s<60)return s.toFixed(s<10?(s%1?2:0):0).replace(/\.00$/,'')+'s';
  return `${pad(s/60)}:${pad(s%60)}`;
}
function drawWave(){
  const ctx=waveCv.getContext('2d');const dpr=devicePixelRatio;
  const vw=viewportW(); const h=waveCv.height/dpr;
  ctx.save();ctx.scale(dpr,dpr);
  ctx.clearRect(0,0,vw,h);
  ctx.fillStyle='#141416';ctx.fillRect(0,0,vw,h);
  // 影片長度底色
  if(State.duration>0){
    const dx0=Math.max(0,timeToX(0)), dx1=Math.min(vw,timeToX(State.duration));
    if(dx1>dx0){ ctx.fillStyle='#1a2530'; ctx.fillRect(dx0,0,dx1-dx0,h); }
  }
  if(!Wave.peaks){ctx.restore();return;}
  const mid=h/2, amp=h*0.46;
  ctx.strokeStyle='#3fa9f5';ctx.globalAlpha=0.9;ctx.beginPath();
  const res=Wave.resolution, peaks=Wave.peaks, n=peaks.length/2;
  for(let x=0;x<vw;x++){
    const t=xToTime(x); const b=Math.floor(t*res);
    if(b<0||b>=n)continue;
    let mn=peaks[b*2],mx=peaks[b*2+1];
    // 若一像素跨多桶，取極值
    const t2=xToTime(x+1); const b2=Math.min(n-1,Math.floor(t2*res));
    for(let k=b+1;k<=b2;k++){ if(peaks[k*2]<mn)mn=peaks[k*2]; if(peaks[k*2+1]>mx)mx=peaks[k*2+1]; }
    ctx.moveTo(x+0.5,mid-mx*amp);ctx.lineTo(x+0.5,mid-mn*amp);
  }
  ctx.stroke();
  ctx.globalAlpha=1;ctx.strokeStyle='#23232a';ctx.beginPath();ctx.moveTo(0,mid);ctx.lineTo(vw,mid);ctx.stroke();
  ctx.restore();
}
function renderTrackRows(){
  tlTracks.innerHTML='';
  const gut=$('tlGutterTracks'); if(gut)gut.innerHTML='';
  for(let tk=0;tk<State.trackCount;tk++){
    const vis=trackVisible(tk);
    const row=document.createElement('div');
    row.className='tl-track'+(vis?'':' hidden-tk')+(tk===State.listTrack?' tl-active':''); row.style.height=ROW_H+'px'; row.dataset.track=tk;
    tlTracks.appendChild(row);
    if(gut){
      const g=document.createElement('div');
      g.className='tl-gtrack'+(vis?'':' hidden-tk')+(tk===State.listTrack?' tl-active':''); g.style.height=ROW_H+'px'; g.dataset.track=tk;
      const isLocked=!!State.tracks[tk].locked;
      g.innerHTML=`<span class="drag-handle" title="拖曳重排">⠿</span>`+
        `<button class="eye" title="顯示/隱藏此軌">${vis?'👁':'🙈'}</button>`+
        `<span class="gname" contenteditable="false" spellcheck="false">${escapeHTML(State.tracks[tk].name)}</span>`+
        `<button class="glock${isLocked?' locked':''}" title="${isLocked?'解鎖':'鎖定'}此軌">${isLocked?'🔒':'🔓'}</button>`+
        `<button class="gdel" title="刪除此軌">✕</button>`;
      g.querySelector('.eye').onclick=(e)=>{e.stopPropagation();State.tracks[tk].visible=!vis;drawTimeline();renderVideoSub();};
      const nm=g.querySelector('.gname');
      nm.addEventListener('click',e=>{
        if(nm.contentEditable==='true') return;
        e.stopPropagation();
        State.listTrack=tk;
        if(!e.shiftKey){ State.selectedIds=[]; State.selectedId=null; $('stSel').textContent=''; }
        const sel=$('listTrackSel'); if(sel)sel.value=String(tk);
        renderTrackStyle();
        renderAll();
        refreshTrackGutterActive();
      });
      nm.addEventListener('mousedown',e=>{
        if(e.detail>=2){
          e.preventDefault(); nm.contentEditable='true'; nm.focus();
          try{const r=document.createRange(),s=window.getSelection();r.selectNodeContents(nm);s.removeAllRanges();s.addRange(r);}catch(_){}
        }
      });
      nm.onkeydown=(e)=>{ e.stopPropagation(); if(e.key==='Enter'){e.preventDefault();nm.blur();} else if(e.key==='Escape'){e.preventDefault();nm.innerText=State.tracks[tk].name;nm.blur();} };
      nm.onblur=()=>{ nm.contentEditable='false'; State.tracks[tk].name=nm.innerText.trim()||('軌道 '+(tk+1)); renderListTrackSel(); };
      g.querySelector('.glock').onclick=(e)=>{e.stopPropagation();State.tracks[tk].locked=!State.tracks[tk].locked;renderTrackRows();};
      g.querySelector('.gdel').onclick=(e)=>{e.stopPropagation();removeTrack(tk);};
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
  let targetTk=clamp(Math.floor(relY/ROW_H),0,State.trackCount-1);
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
    syncTrackCount(); recordHistory('軌道重排'); renderAll(); renderListTrackSel();
  }
}

function renderCueBlocks(){
  tlTracks.querySelectorAll('.cue-block,.cue-overlap').forEach(e=>e.remove());
  const rows=[...tlTracks.querySelectorAll('.tl-track')];
  const vw=viewportW(); const t0=State.viewStart, t1=State.viewStart+vw/State.pxPerSec;
  for(const c of State.cues){
    if(c.timed===false)continue;
    if(c.end<t0||c.start>t1)continue;
    const row=rows[Math.min(c.track||0,rows.length-1)]; if(!row)continue;
    const el=document.createElement('div');
    el.className='cue-block'+(isSel(c.id)?' sel':'')+(isSel(c.id)&&State.selectedIds.length>1?' multi':'')+(c.id===State.selectedId?' primary':'');
    el.style.left=timeToX(c.start)+'px';
    el.style.width=Math.max(2,(c.end-c.start)*State.pxPerSec)+'px';
    el.dataset.id=c.id;
    el.innerHTML='<div class="edge l"></div>'+escapeHTML((c.text||'').replace(/\n/g,' '))+'<div class="edge r"></div>';
    row.appendChild(el);
  }
  // 重疊區域：粉紅底色
  for(let tk=0;tk<State.trackCount;tk++){
    const row=rows[Math.min(tk,rows.length-1)]; if(!row)continue;
    const tc=State.cues.filter(c=>c.timed!==false&&(c.track||0)===tk);
    tc.sort((a,b)=>a.start-b.start);
    for(let i=0;i<tc.length-1;i++){
      for(let j=i+1;j<tc.length;j++){
        if(tc[j].start>=tc[i].end)break;
        const os=tc[j].start, oe=Math.min(tc[i].end,tc[j].end);
        if(oe<=t0||os>=t1)continue;
        const vs=Math.max(os,t0), ve=Math.min(oe,t1);
        const ov=document.createElement('div'); ov.className='cue-overlap';
        ov.style.left=timeToX(vs)+'px'; ov.style.width=Math.max(2,(ve-vs)*State.pxPerSec)+'px';
        row.appendChild(ov);
      }
    }
  }
}
/* y 座標 -> 軌道索引（含垂直捲動位移） */
function trackFromY(clientY){
  const rect=tlLayer.getBoundingClientRect();
  const y=clientY-rect.top-tracksTop()+tracksScrollTop();
  return clamp(Math.floor(y/ROW_H),0,State.trackCount-1);
}
function addTrack(){ State.tracks.push(newTrack()); syncTrackCount(); drawTimeline(); renderListTrackSel(); recordHistory('新增軌道'); }
function removeTrack(i){
  if(State.tracks.length<=1){ showToast('至少需保留一個軌道'); return; }
  const n=State.cues.filter(c=>(c.track||0)===i).length;
  if(n>0 && !confirm(`軌道「${State.tracks[i].name}」有 ${n} 條字幕，刪除軌道會一併刪除這些字幕，確定？`))return;
  State.cues=State.cues.filter(c=>(c.track||0)!==i);
  State.cues.forEach(c=>{ if((c.track||0)>i)c.track=(c.track||0)-1; });
  State.tracks.splice(i,1); syncTrackCount();
  if(State.listTrack===i)State.listTrack=-1; else if(State.listTrack>i)State.listTrack--;
  State.selectedIds=State.selectedIds.filter(id=>State.cues.some(c=>c.id===id));
  if(!State.cues.some(c=>c.id===State.selectedId)){State.selectedId=State.selectedIds[0]||null;State.activeEdge='start';}
  renderListTrackSel(); renderAll(); drawTimeline(); recordHistory('刪除軌道');
}
/* 把選取的字幕移到指定軌道（或位移 delta） */
function moveSelectedToTrack(target){
  const ids=State.selectedIds.length?State.selectedIds:[State.selectedId].filter(Boolean);
  if(!ids.length)return;
  for(const id of ids){ const c=State.cues.find(x=>x.id===id); if(c)c.track=clamp(target,0,State.trackCount-1); }
  renderAll(); drawTimeline(); recordHistory('移動至軌道');
}

function updatePlayhead(){
  const x=timeToX(Media.vTime());
  $('tlPlayhead').style.left=x+'px';
  if(State.inPoint!=null){ const ip=$('tlInpoint'); ip.style.display='block'; ip.style.left=timeToX(State.inPoint)+'px'; }
  else $('tlInpoint').style.display='none';
}
function drawTimeline(){
  layoutTimeline(); drawRuler(); drawWave(); renderTrackRows(); updatePlayhead();
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
  const c = centerTime!=null?centerTime:Media.vTime();
  State.pxPerSec=clamp(px,4,800);
  $('zoomBar').value=clamp(State.pxPerSec,10,400);
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
  const vt=Media.vTime();
  const center=clamp(vt,t0,t1);
  setZoom(pps,center);
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
  const block=e.target.closest('.cue-block');
  const rect=tlLayer.getBoundingClientRect();
  const x=e.clientX-rect.left, y=e.clientY-rect.top;
  if(block){
    const c=State.cues.find(z=>z.id===block.dataset.id); if(!c)return;
    if(e.detail>=2 && !e.shiftKey){ selectCue(c.id); openCueEditModal(c); e.preventDefault(); return; }
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
    if(e.ctrlKey||e.metaKey){ selectCue(c.id,{additive:true}); if(!isSel(c.id)){ e.preventDefault(); return; } } // 切換掉就不啟動拖曳
    else if(!isSel(c.id)) selectCue(c.id);
    const mode = e.target.classList.contains('edge')? (e.target.classList.contains('l')?'l':'r') : 'move';
    const grpIds = (mode==='move' && isSel(c.id) && State.selectedIds.length>1) ? State.selectedIds : [c.id];
    const exSet=new Set(grpIds);
    const grp=grpIds.map(id=>State.cues.find(z=>z.id===id)).filter(Boolean)
      .map(cc=>{ const b=neighborBounds(cc.start,cc.end,cc.track||0,exSet); return {c:cc,os:cc.start,oe:cc.end,ot:cc.track||0,prevEnd:b.prevEnd,nextStart:b.nextStart}; });
    drag={c,mode,startX:e.clientX,startY:e.clientY,os:c.start,oe:c.end,ot:c.track||0,grp,moved:false,
      snaps:snapTargets(exSet), thr:8/State.pxPerSec};
    e.preventDefault(); return;
  }
  if(y<tracksTop()){ // 時間尺 + 波形帶：拖曳移動播放點
    // 備忘錄標記點擊偵測（時間尺範圍內 ±9px）
    if(y<=RULER_H && State.notes.length){
      const hitNote=State.notes.find(n=>Math.abs(timeToX(n.time)-x)<=9);
      if(hitNote){
        const now=performance.now();
        if(_noteClickState&&_noteClickState.id===hitNote.id&&now-_noteClickState.t<400){
          openNoteInPanel(hitNote); _noteClickState=null;
        } else {
          _noteClickState={id:hitNote.id,t:now};
        }
        Media.seek(hitNote.time); updatePlayhead(); renderVideoSub(); ensurePlayheadVisible();
        e.preventDefault(); return;
      }
    }
    jklReset(); // 播放中拖曳時間尺 → 暫停
    Media.seek(xToTime(x)); updatePlayhead(); renderVideoSub();
    drag={mode:'scrub'}; e.preventDefault(); return;
  }
  drag={mode:'rubber',startX:e.clientX,startY:e.clientY,x0:x,y0:y,moved:false,additive:e.ctrlKey||e.metaKey};
  e.preventDefault();
});
window.addEventListener('mousemove',e=>{
  if(!drag)return;
  const rect=tlLayer.getBoundingClientRect();
  if(drag.mode==='scrub'){ Media.seek(xToTime(e.clientX-rect.left)); updatePlayhead(); renderVideoSub(); return; }
  if(Math.abs(e.clientX-drag.startX)>3||Math.abs(e.clientY-drag.startY)>3)drag.moved=true;
  if(drag.mode==='rubber'){
    const x1=clamp(e.clientX-rect.left,0,viewportW()), y1=clamp(e.clientY-rect.top,0,tlLayer.clientHeight);
    const rb=$('tlRubber'); rb.style.display='block';
    rb.style.left=Math.min(drag.x0,x1)+'px'; rb.style.top=Math.min(drag.y0,y1)+'px';
    rb.style.width=Math.abs(x1-drag.x0)+'px'; rb.style.height=Math.abs(y1-drag.y0)+'px';
    return;
  }
  if(!drag.moved) return; // 未超過門檻：單擊不應移動/縮放字幕
  let dt=(e.clientX-drag.startX)/State.pxPerSec;
  if(drag.mode==='move'){
    // 防重疊：限制 dt 使每條都不越過同軌鄰居
    for(const it of drag.grp){
      const minDt=it.prevEnd-it.os, maxDt=(it.nextStart===Infinity?Infinity:it.nextStart-it.oe);
      if(dt<minDt)dt=minDt; if(maxDt!==Infinity&&dt>maxDt)dt=maxDt;
    }
    const minOs=Math.min(...drag.grp.map(g=>g.os)); if(minOs+dt<0)dt=-minOs;
    // 磁吸（單選時依主字幕起/訖 → 播放點與其他字幕邊界）
    if(drag.grp.length===1){
      const it=drag.grp[0], len=it.oe-it.os, ns=it.os+dt;
      const s1=snapVal(ns,drag.snaps,drag.thr), s2=snapVal(ns+len,drag.snaps,drag.thr);
      let snapped=ns; if(s1!==ns)snapped=s1; else if(s2!==ns+len)snapped=s2-len;
      let sdt=snapped-it.os;
      const minDt=it.prevEnd-it.os, maxDt=(it.nextStart===Infinity?Infinity:it.nextStart-it.oe);
      if(sdt<minDt)sdt=minDt; if(maxDt!==Infinity&&sdt>maxDt)sdt=maxDt; if(it.os+sdt<0)sdt=-it.os;
      dt=sdt;
    }
    const minOt=Math.min(...drag.grp.map(g=>g.ot)), maxOt=Math.max(...drag.grp.map(g=>g.ot));
    const dTk=clamp(trackFromY(e.clientY)-drag.ot, -minOt, State.trackCount-1-maxOt);
    for(const it of drag.grp){ const len=it.oe-it.os; it.c.start=it.os+dt; it.c.end=it.c.start+len; it.c.track=it.ot+dTk; }
  }else if(drag.mode==='l'){
    const it=drag.grp[0];
    let ns=clamp(it.os+dt, it.prevEnd, drag.c.end-0.05);
    const sn=snapVal(ns,drag.snaps,drag.thr); if(sn>=it.prevEnd && sn<=drag.c.end-0.05) ns=sn;
    drag.c.start=ns;
  }else if(drag.mode==='r'){
    const it=drag.grp[0];
    let ne=clamp(drag.oe+dt, drag.c.start+0.05, it.nextStart);
    const sn=snapVal(ne,drag.snaps,drag.thr); if(sn>=drag.c.start+0.05 && sn<=it.nextStart) ne=sn;
    drag.c.end=ne;
  }
  renderCueBlocks(); if(drag.c)renderSubRow(drag.c.id);
});
window.addEventListener('mouseup',e=>{
  if(!drag)return;
  if(drag.mode==='rubber'){
    $('tlRubber').style.display='none';
    const rect=tlLayer.getBoundingClientRect();
    if(drag.moved){
      const x1=clamp(e.clientX-rect.left,0,viewportW()), y1=e.clientY-rect.top;
      const ta=xToTime(Math.min(drag.x0,x1)), tb=xToTime(Math.max(drag.x0,x1));
      const rh=trackRowH(), sc=tracksScrollTop();
      const rowA=clamp(Math.floor((Math.min(drag.y0,y1)-tracksTop()+sc)/rh),0,State.trackCount-1);
      const rowB=clamp(Math.floor((Math.max(drag.y0,y1)-tracksTop()+sc)/rh),0,State.trackCount-1);
      const hit=State.cues.filter(c=>c.timed!==false&&(c.track||0)>=rowA&&(c.track||0)<=rowB&&c.end>=ta&&c.start<=tb).map(c=>c.id);
      if(drag.additive){ for(const id of hit)if(!State.selectedIds.includes(id))State.selectedIds.push(id); }
      else State.selectedIds=hit;
      State.selectedId=State.selectedIds[State.selectedIds.length-1]||null; State.activeEdge='start';
      refreshSelectionUI(); $('stSel').textContent='已選 '+State.selectedIds.length+' 條';
    }else{
      // 點時間軸空白：跳轉（Shift 時保留選取）
      Media.seek(xToTime(e.clientX-rect.left)); updatePlayhead(); renderVideoSub();
      if(!e.shiftKey){
        State.selectedIds=[]; State.selectedId=null; State.activeEdge='start';
        refreshSelectionUI(); $('stSel').textContent='';
      }
    }
  }else if(drag.mode!=='scrub'){ const moved=drag.moved, m=drag.mode; sortCues(); renderAll(); if(moved)recordHistory(m==='move'?'移動字幕':'調整字幕時間'); }
  drag=null;
});

/* 滾輪縮放（Ctrl）/ 平移 */
tlScroll.addEventListener('wheel',e=>{
  if(e.ctrlKey||e.metaKey){
    e.preventDefault();
    const rect=tlLayer.getBoundingClientRect();
    const ct=xToTime(e.clientX-rect.left);
    setZoom(State.pxPerSec*(e.deltaY<0?1.15:0.87),ct);
  }
},{passive:false});

export { RULER_H, WAVE_H, ROW_H, tracksTop, trackRowH, tracksScrollTop, viewportW, timeToX, xToTime,
  layoutTimeline, drawRuler, niceStep, fmtTick, drawWave, renderTrackRows, renderCueBlocks, trackFromY,
  addTrack, removeTrack, moveSelectedToTrack, updatePlayhead, drawTimeline, setZoom, zoomFit,
  refreshTrackGutterActive };
