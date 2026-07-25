import { clamp, escapeHTML } from './util.js';
import { State, newTrack, syncTrackCount } from './state.js';
import { Media } from './media.js';
import { $, tlScroll } from './dom.js';
import { emit } from './events.js';
import { recordHistory } from './history.js';
import { openModal, closeModal } from './ui.js';
import { drawTimeline, layoutTimeline, viewportW, tlTotal, yToTrack } from './timeline-renderer.js';

export function trackFromY(y) {
  return yToTrack(y);
}

export function addTrack(){ State.tracks.push(newTrack()); syncTrackCount(); drawTimeline(); emit('render:listTrackSel'); recordHistory('新增軌道'); }

export function removeTrack(i){
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
  for(const id of ids){ const c=State.cues.find(x=>x.id===id); if(c)c.track=clamp(target,0,State.trackCount-1); }
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

export function snapTargets(excludeIds){
  let t = [0, State.duration>0?State.duration:1];
  for(const c of State.cues){
    if(excludeIds && (excludeIds.has ? excludeIds.has(c.id) : excludeIds.includes(c.id))) continue;
    if(c.timed===false) continue;
    t.push(c.start); t.push(c.end);
  }
  if(Media.mpvMode) t.push(Media.displayTime());
  return t;
}

export function snapVal(t,targets,thr){ let best=t,bd=thr; for(const x of targets){const d=Math.abs(x-t); if(d<bd){bd=d;best=x;}} return best; }

export function neighborBounds(os,oe,track,excludeIds){
  let maxStart=0, minEnd=999999;
  for(const c of State.cues){
    if(excludeIds && (excludeIds.has ? excludeIds.has(c.id) : excludeIds.includes(c.id))) continue;
    if((c.track||0)!==track || c.timed===false) continue;
    if(c.end<=os && c.end>maxStart) maxStart=c.end;
    if(c.start>=oe && c.start<minEnd) minEnd=c.start;
  }
  return {min:maxStart, max:minEnd};
}
