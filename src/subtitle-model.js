import { State, newId, setSelection, pruneSelection, ensureTrackCount, cueSuffix } from './state.js';
import { emit } from './events.js';
import { burnedSubtitleTrackNames } from './subtitle-track-names.js';
import { Media } from './media.js';
import { snapTimeToFrame } from './time.js';
import { recordHistory } from './history.js';
import { showToast, openModal, closeModal } from './ui.js';

export function snapAllCuesToFrames() {
  if (!State.fps) return false;
  let changed = false;
  for (const c of State.cues) {
    if (c.timed === false) continue;
    const ns = snapTimeToFrame(c.start, State.fps, State.dropFrame);
    const ne = snapTimeToFrame(c.end, State.fps, State.dropFrame);
    if (Math.abs(ns - c.start) > 1e-6 || Math.abs(ne - c.end) > 1e-6) {
      c.start = ns; c.end = ne;
      changed = true;
    }
  }
  return changed;
}

export function swapAdjacentCues(id, dir){
  const cue = State.cues.find(c => c.id === id);
  if (!cue) return;
  const tk = cue.track || 0;
  const list = State.cues.filter(c => (c.track || 0) === tk);
  const idx = list.findIndex(c => c.id === id);
  if (idx < 0) return;
  
  let targetIdx = idx + dir;
  if (targetIdx < 0 || targetIdx >= list.length) return;
  
  const targetCue = list[targetIdx];
  if (cue.timed === false || targetCue.timed === false) {
    const tmp = cue.text; cue.text = targetCue.text; targetCue.text = tmp;
    emit('render:all'); recordHistory('相鄰換位');
    return;
  }
  
  const cue1 = dir === -1 ? targetCue : cue;
  const cue2 = dir === -1 ? cue : targetCue;
  
  const dur1 = cue1.end - cue1.start;
  const dur2 = cue2.end - cue2.start;
  const gap = cue2.start - cue1.end;
  
  const newStart2 = cue1.start;
  const newEnd2 = newStart2 + dur2;
  const newStart1 = newEnd2 + gap;
  const newEnd1 = newStart1 + dur1;
  
  cue2.start = newStart2;
  cue2.end = newEnd2;
  
  cue1.start = newStart1;
  cue1.end = newEnd1;
  
  sortCues();
  emit('render:all');
  recordHistory('相鄰換位');
}

export function mergeAdjacentCues(id, dir){
  const cue = State.cues.find(c => c.id === id);
  if (!cue) return;
  const tk = cue.track || 0;
  const list = State.cues.filter(c => (c.track || 0) === tk);
  const idx = list.findIndex(c => c.id === id);
  if (idx < 0) return;
  
  let targetIdx = idx + dir;
  if (targetIdx < 0 || targetIdx >= list.length) return;
  
  const targetCue = list[targetIdx];
  const cue1 = dir === -1 ? targetCue : cue;
  const cue2 = dir === -1 ? cue : targetCue;
  
  const t1 = (cue1.text || '').trim();
  const t2 = (cue2.text || '').trim();
  const newText = t1 && t2 ? `${t1} ${t2}` : `${t1}${t2}`;

  cue1.text = newText;
  
  if (cue1.timed !== false && cue2.timed !== false) {
    cue1.end = cue2.end;
  }
  
  const idx2 = State.cues.findIndex(c => c.id === cue2.id);
  if (idx2 >= 0) State.cues.splice(idx2, 1);
  
  if (State.selectedId === cue2.id) {
    setSelection({ kind:'sub', ids:[cue1.id] });
  } else if (State.selectedIds.includes(cue2.id)) {
    const kept = State.selectedIds.filter(x => x !== cue2.id);
    if (!kept.includes(cue1.id)) kept.push(cue1.id);
    setSelection({ kind:'sub', ids:kept, primary:State.selectedId });
  }

  sortCues();
  emit('render:all');
  recordHistory('合併字幕');
}

export function detectOverlaps(cues, eps=0.001){
  const set=new Set();
  const sorted=cues.filter(c=>c.timed!==false).slice().sort((a,b)=>a.start-b.start);
  for(let i=0;i<sorted.length;i++){
    for(let j=i+1;j<sorted.length;j++){
      if(sorted[j].start >= sorted[i].end - eps) break;
      set.add(sorted[i].id); set.add(sorted[j].id);
    }
  }
  return set;
}

export function sweepContainedCues(changedCues) {
  if (!State.overwriteMode || State.overwriteKeep) return false;
  let changed = false;
  const snapF = (t) => snapTimeToFrame(t, State.fps, State.dropFrame);
  for (const c of changedCues) {
    if (!c || c.timed === false) continue;
    const tk = c.track || 0;
    for (let i = State.cues.length - 1; i >= 0; i--) {
      const b = State.cues[i];
      if (b.id === c.id || (b.track || 0) !== tk || b.timed === false) continue;
      
      if (b.end > c.start + 0.001 && b.start < c.end - 0.001) {
        if (b.start >= c.start - 0.001 && b.end <= c.end + 0.001) {
          State.cues.splice(i, 1);
          changed = true;
        } else if (b.start < c.start - 0.001 && b.end > c.end + 0.001) {
          const newB = JSON.parse(JSON.stringify(b));
          newB.id = newId();
          newB.start = snapF(c.end);
          b.end = snapF(c.start);
          State.cues.splice(i + 1, 0, newB);
          changed = true;
        } else if (b.end > c.start + 0.001 && b.start <= c.start + 0.001) {
          b.end = snapF(c.start);
          changed = true;
        } else if (b.start < c.end - 0.001 && b.end >= c.end - 0.001) {
          b.start = snapF(c.end);
          changed = true;
        }
      }
    }
  }
  if (changed) {
    pruneSelection();
    return true;
  }
  return false;
}

export function addCue(start, end, text, track, selectCueCb){
  const added = ensureTrackCount((track||0)+1);
  /* 'render:timeline' 沒有任何訂閱者（註解說「using general timeline event」，
     但通用的那個叫 'timeline:invalidate'，app.js 有訂閱→drawTimeline）。
     新增軌道後不重繪時間軸，新軌的軌列不會出現。改用既有名稱，
     不再替 drawTimeline 增加第三個別名。 */
  if(added){ emit('timeline:invalidate'); emit('render:listTrackSel'); }
  const c={id:newId(),start:start||0,end:end!=null?end:(start||0),text:text||'',track:track||0,timed:(start!=null&&end!=null)};
  State.cues.push(c); sortCues(); emit('render:all'); 
  if (selectCueCb) selectCueCb(c.id); 
  return c;
}

export function addCueRelative(dir, selectCueCb){
  const sel=State.cues.find(c=>c.id===State.selectedId);
  if(sel && sel.timed===false){
    const c={id:newId(),start:sel.start,end:sel.end,text:'',track:sel.track||0,timed:false};
    State.cues.splice(State.cues.indexOf(sel)+(dir>0?1:0),0,c);
    emit('render:all'); 
    if (selectCueCb) selectCueCb(c.id); 
    recordHistory('新增空白字幕');
    return c;
  }
  const tk=sel?(sel.track||0):0;
  let start,end;
  if(sel){ if(dir>0){ start=sel.end; end=snapTimeToFrame(sel.end+2, State.fps, State.dropFrame); } else { end=sel.start; start=Math.max(0,snapTimeToFrame(sel.start-2, State.fps, State.dropFrame)); } }
  else { start=snapTimeToFrame(Media.displayTime(), State.fps, State.dropFrame); end=snapTimeToFrame(start+2, State.fps, State.dropFrame); }
  const c=addCue(start,end,'',tk, selectCueCb); recordHistory(dir>0?'下方新增字幕':'上方新增字幕');
  return c;
}

export function _doDeleteCues(ids){
  const idxs=ids.map(id=>State.cues.findIndex(c=>c.id===id)).filter(i=>i>=0);
  const firstIdx=idxs.length?Math.min(...idxs):0;
  State.cues=State.cues.filter(c=>!ids.includes(c.id));
  const next=State.cues[Math.min(firstIdx,State.cues.length-1)]?.id||null;
  setSelection({ kind:'sub', ids:next?[next]:[] }); State.activeEdge='start';
  emit('render:all'); emit('render:selection'); recordHistory('刪除字幕');
}

export function trackLocked(tk, action = '修改'){
  const t = State.tracks[tk || 0];
  if(!t?.locked) return false;
  showToast(`🔒「${t.name || ('軌道 ' + ((tk || 0) + 1))}」已鎖定，無法${action}`);
  return true;
}

export function cueTrackLocked(c, action = '修改'){ 
  return trackLocked(c?.track || 0, action); 
}

export function deleteSelectedCues(ids){
  if(!ids || !ids.length) return;
  _doDeleteCues(ids);
}

export function deleteCue(id){ 
  if(id) setSelection({ kind:'sub', ids:[id] }); 
  const ids = State.selectedIds.length ? State.selectedIds.slice() : [State.selectedId].filter(Boolean);
  deleteSelectedCues(ids);
}

export function clearSelectedCuesTime() {
  const ids=State.selectedIds.length?State.selectedIds.slice():[State.selectedId].filter(Boolean);
  if(!ids.length)return;
  let changed = false;
  ids.forEach(id => {
    const c = State.cues.find(x => x.id === id);
    if (c && c.timed !== false) {
      c.timed = false;
      changed = true;
    }
  });
  if (changed) {
    emit('render:all');
    recordHistory('清除字幕時間點');
  }
}

export function shiftTextsDown(id){
  const c=State.cues.find(x=>x.id===id); if(!c||(c.text||'').trim())return;
  const tk=c.track||0;
  const list=State.cues.filter(x=>(x.track||0)===tk);
  const i=list.findIndex(x=>x.id===id); if(i<=0||!(list[i-1].text||'').trim())return;
  let start=i-1;
  while(start>0&&(list[start-1].text||'').trim())start--;
  for(let j=i;j>start;j--)list[j].text=list[j-1].text;
  list[start].text='';
  emit('render:all'); recordHistory('上方字幕文字往下移動');
}

export function shiftTextsUp(id){
  const c=State.cues.find(x=>x.id===id); if(!c||(c.text||'').trim())return;
  const tk=c.track||0;
  const list=State.cues.filter(x=>(x.track||0)===tk);
  const i=list.findIndex(x=>x.id===id); if(i>=list.length-1||!(list[i+1].text||'').trim())return;
  let end=i+1;
  while(end<list.length-1&&(list[end+1].text||'').trim())end++;
  for(let j=i;j<end;j++)list[j].text=list[j+1].text;
  list[end].text='';
  emit('render:all'); recordHistory('下方字幕文字往上移動');
}

export function sortCues() {
  if (State.subMode) return;
  const trackTime = {};
  const anchorIdx = {};

  const mapped = State.cues.map((c, i) => {
    const tk = c.track || 0;
    if (c.timed !== false) {
      trackTime[tk] = c.start;
      anchorIdx[tk] = i;
    }
    const effectiveTime = trackTime[tk] !== undefined ? trackTime[tk] : -Infinity;
    const anchor = anchorIdx[tk] !== undefined ? anchorIdx[tk] : -1;
    return { c, i, effectiveTime, anchor };
  });

  mapped.sort((a, b) => {
    if (a.effectiveTime !== b.effectiveTime) return a.effectiveTime - b.effectiveTime;
    if (a.anchor !== b.anchor) {
      const anchorCueA = a.anchor === -1 ? null : State.cues[a.anchor];
      const anchorCueB = b.anchor === -1 ? null : State.cues[b.anchor];
      if (anchorCueA && anchorCueB && anchorCueA.start === anchorCueB.start) {
          return anchorCueA.id < anchorCueB.id ? -1 : 1;
      }
      return a.anchor - b.anchor;
    }
    return a.i - b.i;
  });

  for (let i = 0; i < mapped.length; i++) {
    State.cues[i] = mapped[i].c;
  }
}

export function copyCues(){
  const ids=State.selectedIds.length?State.selectedIds:[State.selectedId].filter(Boolean);
  if(!ids.length){ showToast('沒有選取的字幕'); return; }
  State.clipboard=State.cues.filter(c=>ids.includes(c.id)).map(c=>({...c}));
  showToast(`已複製 ${State.clipboard.length} 條字幕`);
}

export function pasteCues(selectCueCb){
  if(!State.clipboard?.length){ showToast('剪貼簿是空的'); return; }
  const timedClip=State.clipboard.filter(c=>c.timed!==false);
  const minStart=timedClip.length ? Math.min(...timedClip.map(c=>c.start)) : 0;
  const delta=Media.displayTime()-minStart;
  const newCues=State.clipboard.map(c=>{
    if(c.timed===false) return {...c, id:newId(), track:State.listTrack};
    const s=Math.max(0, c.start+delta);
    return {...c, id:newId(), track:State.listTrack, start:s, end:Math.max(s+0.001, c.end+delta)};
  });
  State.cues.push(...newCues);
  sortCues();
  setSelection({ kind:'sub', ids:newCues.map(c=>c.id), primary:newCues[0].id });
  emit('render:all'); emit('render:selection'); recordHistory('貼上字幕');
  showToast(`已貼上 ${newCues.length} 條字幕`);
}

export function trimTrackSpaces() {
  let changed = 0;
  State.cues.forEach(c => {
    if ((c.track || 0) === State.listTrack) {
      const orig = c.text || '';
      const trimmed = orig.replace(/^[ 　]+|[ 　]+$/gm, '');
      if (orig !== trimmed) {
        c.text = trimmed;
        changed++;
      }
    }
  });
  if (changed) {
    emit('render:all');
    emit('render:videoSub');
    recordHistory(`Trim頭尾空白 (${changed}條)`);
    emit('render:checkPanel');
  } else {
    showToast('目前軌道沒有需要 Trim 的空白');
  }
}

/* 相容既有 import；規則已移到 subtitle-track-names.js，交付對話框、ASS 與 queue payload
   都從同一份實際輸出 cues 推導。 */
export { burnedSubtitleTrackNames };
