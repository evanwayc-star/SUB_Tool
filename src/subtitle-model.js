import { State, newId, setSelection, pruneSelection, ensureTrackCount, cueSuffix, saveConfig } from './state.js';
import { emit } from './events.js';
import { Media } from './media.js';
import { snapTimeToFrame, getExactFps } from './time.js';
import { History, recordHistory } from './history.js';
import { showToast, openModal, closeModal, setStatus } from './ui.js';
import { planCueStyleAssignment } from './subtitle-style-engine.js';
import { effStyle, trackStyleSnapshot, CUE_STYLE_KEYS } from './substyle.js';
import { Project } from './project.js';

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
  if (cueTrackLocked(cue, '交換字幕順序')) return;
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
  if (cueTrackLocked(cue, '合併字幕')) return;
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

export { detectOverlaps } from './subtitle-audit.js';

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

export function addCue(start, end, text, track, { historyLabel = '新增字幕' } = {}){
  const targetTrack = track || 0;
  if (trackLocked(targetTrack, '在此軌新增字幕')) return null;
  const added = ensureTrackCount(targetTrack + 1);
  /* 'render:timeline' 沒有任何訂閱者（註解說「using general timeline event」，
     但通用的那個叫 'timeline:invalidate'，app.js 有訂閱→drawTimeline）。
     新增軌道後不重繪時間軸，新軌的軌列不會出現。改用既有名稱，
     不再替 drawTimeline 增加第三個別名。 */
  if(added){ emit('timeline:invalidate'); emit('render:listTrackSel'); }
  const c={id:newId(),start:start||0,end:end!=null?end:(start||0),text:text||'',track:targetTrack,timed:(start!=null&&end!=null)};
  State.cues.push(c);
  sortCues();
  setSelection({ kind:'sub', ids:[c.id] });
  State.activeEdge='start';
  emit('render:all');
  emit('render:selection');
  recordHistory(historyLabel);
  return c;
}

export function addCueRelative(dir){
  const sel=State.cues.find(c=>c.id===State.selectedId);
  const historyLabel=dir>0?'下方新增字幕':'上方新增字幕';
  if(sel && cueTrackLocked(sel, '新增字幕')) return null;
  if(sel && sel.timed===false){
    const c={id:newId(),start:sel.start,end:sel.end,text:'',track:sel.track||0,timed:false};
    State.cues.splice(State.cues.indexOf(sel)+(dir>0?1:0),0,c);
    setSelection({ kind:'sub', ids:[c.id] });
    State.activeEdge='start';
    emit('render:all');
    emit('render:selection');
    recordHistory(historyLabel);
    return c;
  }
  const tk=sel?(sel.track||0):0;
  let start,end;
  if(sel){ if(dir>0){ start=sel.end; end=snapTimeToFrame(sel.end+2, State.fps, State.dropFrame); } else { end=sel.start; start=Math.max(0,snapTimeToFrame(sel.start-2, State.fps, State.dropFrame)); } }
  else { start=snapTimeToFrame(Media.displayTime(), State.fps, State.dropFrame); end=snapTimeToFrame(start+2, State.fps, State.dropFrame); }
  return addCue(start,end,'',tk,{ historyLabel });
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

export function cuesTrackLocked(cues, action = '修改'){
  const lockedCue = (Array.isArray(cues) ? cues : []).find(c => State.tracks[c?.track || 0]?.locked);
  return lockedCue ? cueTrackLocked(lockedCue, action) : false;
}

export function deleteSelectedCues(ids){
  if(!ids || !ids.length) return false;
  const cues=ids.map(id=>State.cues.find(c=>c.id===id)).filter(Boolean);
  if(cuesTrackLocked(cues, '刪除字幕')) return false;
  _doDeleteCues(ids);
  return true;
}

/* 延遲刪除認的是確認當下的實際句子；Undo 可還原同 id 的另一個物件。 */
export function captureCueDeletion(ids){
  const targets=ids.map(id=>State.cues.find(c=>c.id===id)).filter(Boolean);
  const tracks=targets.map(c=>State.tracks[c.track||0]);
  const ownsWorkspace=Project.captureWorkspaceOwnership();
  return ()=>{
    if(!ownsWorkspace() || targets.length!==ids.length || !targets.every((c,i)=>
      State.cues.find(item=>item.id===c.id)===c && State.tracks[c.track||0]===tracks[i])) return false;
    return deleteSelectedCues(targets.map(c=>c.id));
  };
}

// 待定交換認實際來源與文字，不讓 Undo 的同 id 還原物件接手舊操作。
export function captureCueTextSwap(source){
  const track=State.tracks[source?.track||0], text=source?.text||'';
  const ownsWorkspace=Project.captureWorkspaceOwnership();
  let active=!!source && State.cues.includes(source);
  return Object.freeze({
    cancel(){ active=false; },
    commit(target){
      if(!active) return false;
      active=false;
      if(!ownsWorkspace() || !State.cues.includes(source) || State.tracks[source.track||0]!==track
        || (source.text||'')!==text || !State.cues.includes(target) || target===source) return false;
      if(cuesTrackLocked([source,target],'交換字幕文字')) return false;
      source.text=target.text||'';
      target.text=text;
      emit('render:all'); recordHistory('文字交換');
      return true;
    },
  });
}

export function deleteCue(id){ 
  if(id) setSelection({ kind:'sub', ids:[id] }); 
  const ids = State.selectedIds.length ? State.selectedIds.slice() : [State.selectedId].filter(Boolean);
  deleteSelectedCues(ids);
}

export function clearSelectedCuesTime() {
  const ids=State.selectedIds.length?State.selectedIds.slice():[State.selectedId].filter(Boolean);
  if(!ids.length)return;
  const cues=ids.map(id=>State.cues.find(c=>c.id===id)).filter(Boolean);
  if(cuesTrackLocked(cues, '清除字幕時間點')) return;
  let changed = false;
  cues.forEach(c => {
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
  if(cueTrackLocked(c, '移動字幕內容')) return;
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
  if(cueTrackLocked(c, '移動字幕內容')) return;
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

// FPS-SYNC：先將上下限收斂到合法格網，再 snap 與限制；不能在 snap 後加減 .001。
export function subtitleTimeOnFrame(value, min=0, max=Infinity, {fps=State.fps,dropFrame=State.dropFrame}={}) {
  const frame=1/getExactFps(fps || 25), epsilon=frame*1e-7;
  let lower=snapTimeToFrame(min,fps,dropFrame);
  if(lower<min-epsilon) lower=snapTimeToFrame(lower+frame,fps,dropFrame);
  let upper=max;
  if(Number.isFinite(max)) {
    upper=snapTimeToFrame(max,fps,dropFrame);
    if(upper>max+epsilon) upper=snapTimeToFrame(upper-frame,fps,dropFrame);
  }
  if(upper<lower-epsilon) return null;
  return Math.min(upper,Math.max(lower,snapTimeToFrame(value,fps,dropFrame)));
}

// FPS-SYNC：I、切換句子與退出上字幕模式共用暫存終點收尾；不要把合法格再限制回原秒數。
export function finalizeProvisionalCueEnds(exceptId=null, {history=true}={}) {
  const frame=1/getExactFps(State.fps || 25);
  let changed=false;
  for(const cue of State.cues){
    if(!cue._tempEnd || cue.id===exceptId || State.tracks[cue.track||0]?.locked) continue;
    const end=subtitleTimeOnFrame(cue.start+2,cue.start+frame,State.duration||Infinity);
    if(end!=null) cue.end=end;
    delete cue._tempEnd;
    changed=true;
  }
  if(changed && history){
    emit('render:videoSub'); emit('mpv:refreshSubs'); emit('render:all');
    recordHistory('完成暫存字幕時間');
  }
  return changed;
}

export function shiftCueTimes(cues, delta) {
  if(cuesTrackLocked(cues,'修改字幕時間')) return false;
  const frame=1/getExactFps(State.fps || 25);
  for(const c of cues) {
    if(c.timed===false) continue;
    c.start=subtitleTimeOnFrame(Math.max(0,c.start+delta));
    c.end=subtitleTimeOnFrame(c.end+delta,c.start+frame);
  }
  return true;
}

export function finalizeCueTimeEdit(cue, edge, {select=true,render=true}={}) {
  const track = cue.track || 0;
  sweepContainedCues([cue]);

  if (edge === 'start' || edge === 'both' || !edge) {
    const index = State.cues.indexOf(cue);
    let nextIndex = index + 1;
    let offset = 0.001;
    while (index >= 0 && nextIndex < State.cues.length) {
      const nextCue = State.cues[nextIndex];
      if ((nextCue.track || 0) !== track) { nextIndex += 1; continue; }
      if (nextCue.timed !== false) break;
      nextCue.start = cue.start + offset;
      nextCue.end = nextCue.start;
      offset += 0.001;
      nextIndex += 1;
    }
  }

  sortCues();
  if(select) {
    setSelection({ kind: 'sub', ids: [cue.id] });
    State.activeEdge = edge;
  }
  if(render) { emit('render:all'); emit('render:selection'); }
}

/* 一般字幕編輯的單一 public seam。UI adapter 只提供「要改什麼」；
   鎖軌、時間不變量、選取、History 與 invalidation 都在同一筆交易內完成。 */
export function editCue({ cueId, operation, value, baseline }) {
  const cue = State.cues.find(item => item.id === cueId);
  if (!cue) return { ok: false, reason: 'cue-not-found' };

  if (operation === 'text-preview' || operation === 'text') {
    if (cueTrackLocked(cue, '編輯字幕')) return { ok: false, reason: 'track-locked' };
    const nextText = String(value ?? '');
    const changed = operation === 'text'
      ? nextText !== String(baseline ?? cue.text ?? '')
      : nextText !== String(cue.text ?? '');
    cue.text = nextText;
    if (!changed) return { ok: true, changed: false, cue };
    if (operation === 'text-preview') {
      emit('render:videoSub');
      emit('mpv:refreshSubs');
    } else {
      emit('render:all');
      recordHistory('編輯字幕文字' + cueSuffix(cue));
    }
    return { ok: true, changed: true, cue };
  }

  if (operation === 'text-style') {
    if (cueTrackLocked(cue, '編輯字幕')) return { ok: false, reason: 'track-locked' };
    const nextText = String(value?.text ?? '');
    const nextStyle = value?.style && Object.keys(value.style).length
      ? structuredClone(value.style)
      : null;
    const originalText = String(baseline?.text ?? cue.text ?? '');
    const originalStyle = baseline?.style || null;
    const textChanged = nextText !== originalText;
    const styleChanged = JSON.stringify(nextStyle) !== JSON.stringify(originalStyle);
    cue.text = nextText;
    if (nextStyle) cue.style = nextStyle;
    else delete cue.style;
    if (!textChanged && !styleChanged) return { ok: true, changed: false, cue };
    emit('render:all');
    recordHistory('編輯字幕' + (styleChanged ? '（含樣式覆蓋）' : '文字') + cueSuffix(cue));
    return { ok: true, changed: true, cue, styleChanged };
  }

  if (operation === 'start' || operation === 'end') {
    const action = operation === 'start' ? '修改字幕起點' : '修改字幕終點';
    if (cueTrackLocked(cue, action)) return { ok: false, reason: 'track-locked' };
    const before = { start: cue.start, end: cue.end, timed: cue.timed !== false, temporary:!!cue._tempEnd };
    const frame=1/getExactFps(State.fps || 25);
    let edge = operation;
    if (value === null) {
      cue.timed = false;
      edge = 'both';
    } else if (operation === 'start') {
      const start=subtitleTimeOnFrame(Number(value)||0,0,cue.timed===false ? Infinity : cue.end-frame);
      if(start==null) return {ok:false,reason:'no-frame-room'};
      cue.start = start;
      if (cue.timed === false) {
        cue.end = subtitleTimeOnFrame(cue.start+1,cue.start+frame);
        cue.timed = true;
      }
    } else {
      cue.end = subtitleTimeOnFrame(Number(value)||0,cue.timed===false ? frame : (cue.start||0)+frame);
      if (cue.timed === false) {
        cue.start = subtitleTimeOnFrame(Math.max(0,cue.end-1),0,cue.end-frame);
        cue.timed = true;
        edge = 'both';
      }
    }
    const changed = cue.start !== before.start || cue.end !== before.end || (cue.timed !== false) !== before.timed || before.temporary;
    // 明確編輯時間後，舊 In 的暫存終點不得在下次選取時重新收尾。
    delete cue._tempEnd;
    if (!changed) return { ok: true, changed: false, cue };
    finalizeCueTimeEdit(cue, edge);
    const label = value === null ? '清除時間碼' : operation === 'start' ? '修改起點' : '修改終點';
    recordHistory(label + cueSuffix(cue));
    return { ok: true, changed: true, cue };
  }

  return { ok: false, reason: 'unsupported-operation' };
}

/* 文字草稿與 live preview 的 owner。回復與 History 投影都只認最後一次
   自己寫入的值；同物件上的背景合法提交不能被舊 editor 取消或確認蓋掉。 */
export function beginCueEdit(cue, { preview = false } = {}) {
  const track = State.tracks[cue?.track || 0];
  if (!cue || !State.cues.includes(cue) || cueTrackLocked(cue, '編輯字幕')) return null;
  const ownsWorkspace = Project.captureWorkspaceOwnership();
  const baseline = { text:String(cue.text || ''), style:structuredClone(cue.style || {}) };
  let active = true, latestText = baseline.text;
  const ownsIdentity = () => active && ownsWorkspace() && State.cues.includes(cue) && State.tracks[cue.track || 0] === track;
  let releasePreview=null;
  const isCurrent = () => ownsIdentity() && (!releasePreview || releasePreview.isCurrent());
  const ownsText = () => isCurrent() && String(cue.text || '') === latestText;
  releasePreview = preview ? History.beginPreview([
    {target:cue, fields:['text'], ownsField:ownsText},
  ], ownsIdentity) : null;
  const release = () => { releasePreview?.(); active=false; };
  const cancel = () => {
    if (preview && ownsText()) cue.text=baseline.text;
    release();
  };
  return Object.freeze({
    baseline, isCurrent,
    release, cancel,
    split({textBefore, textAfter, timelineTime, beforeCommit} = {}) {
      if (!isCurrent()) { release(); return {ok:false,reason:'stale-edit'}; }
      if (cueTrackLocked(cue,'拆分字幕')) { cancel(); return {ok:false,reason:'track-locked'}; }
      const nextText=String(textBefore ?? '')+String(textAfter ?? '');
      const currentText=String(cue.text || '');
      if ((preview && !ownsText()) || (!preview && currentText!==baseline.text && nextText!==currentText)) {
        if(preview) cancel();
        showToast('字幕已被其他編輯更新，請重新開啟編輯');
        return {ok:false,reason:'edit-conflict'};
      }
      return splitCue({cueId:cue.id,textBefore,textAfter,timelineTime,beforeCommit:()=>{release();beforeCommit?.();}});
    },
    previewText(value) {
      if (!isCurrent()) return {ok:false,reason:'stale-edit'};
      if (!ownsText()) { cancel(); return {ok:false,reason:'edit-conflict'}; }
      const result=editCue({cueId:cue.id,operation:'text-preview',value});
      if(result.ok) latestText=String(cue.text || '');
      else cancel();
      return result;
    },
    commit({text, style} = {}) {
      if (!isCurrent()) { release(); return {ok:false,reason:'stale-edit'}; }
      if (track?.locked) { cancel(); cueTrackLocked(cue,'編輯字幕'); return {ok:false,reason:'track-locked'}; }
      const currentText=String(cue.text || '');
      const nextText=String(text ?? baseline.text);
      if ((preview && !ownsText()) || (!preview && nextText!==baseline.text && currentText!==baseline.text && nextText!==currentText)) {
        if(preview) cancel();
        showToast('字幕已被其他編輯更新，請重新開啟編輯');
        return {ok:false,reason:'edit-conflict'};
      }
      const resolvedText=preview || nextText!==baseline.text ? nextText : currentText;
      const currentStyle=structuredClone(cue.style || {}), resolvedStyle={...currentStyle};
      if (style !== undefined) {
        for (const key of CUE_STYLE_KEYS) {
          const original=baseline.style[key], desired=style?.[key], current=currentStyle[key];
          if (Object.is(desired,original)) continue;
          if (!Object.is(current,original) && !Object.is(current,desired)) {
            showToast('字幕樣式已被其他編輯更新，請重新開啟編輯');
            return {ok:false,reason:'edit-conflict'};
          }
          if(desired==null) delete resolvedStyle[key]; else resolvedStyle[key]=desired;
        }
      }
      release();
      return editCue({cueId:cue.id, operation:style===undefined ? 'text' : 'text-style',
        value:style===undefined ? resolvedText : {text:resolvedText,style:resolvedStyle},
        baseline:style===undefined ? (preview ? baseline.text : currentText) : {text:currentText,style:currentStyle},
      });
    },
  });
}

export function splitCue({ cueId, textBefore, textAfter, timelineTime, beforeCommit }) {
  const cue = State.cues.find(c => c.id === cueId);
  if (!cue) return { ok: false, reason: 'cue-not-found' };
  if (cueTrackLocked(cue, '拆分字幕')) return { ok: false, reason: 'track-locked' };
  if (!String(textBefore ?? '').trim() || !String(textAfter ?? '').trim()) {
    showToast('不能在句首或句尾切分，以免產生空白字幕');
    return { ok: false, reason: 'blank-side' };
  }

  const isTimed = cue.timed !== false;
  const splitTime=isTimed ? snapTimeToFrame(timelineTime,State.fps,State.dropFrame) : 0;
  if (isTimed && (splitTime < cue.start + 0.05 || splitTime > cue.end - 0.05)) {
    showToast('切分點距離起訖太近，或是超出了字幕範圍');
    return { ok: false, reason: 'split-time-out-of-range' };
  }
  const originalEnd = cue.end;
  beforeCommit?.();
  cue.text = textBefore;
  if (isTimed) cue.end = splitTime;

  const newCue = {
    id: newId(),
    start: splitTime,
    end: isTimed ? originalEnd : 0,
    text: textAfter,
    track: cue.track || 0,
    timed: isTimed,
    ...(cue.style ? { style: structuredClone(cue.style) } : {}),
  };
  const index = State.cues.indexOf(cue);
  State.cues.splice(index + 1, 0, newCue);
  sortCues();
  setSelection({ kind: 'sub', ids: [newCue.id] });
  State.activeEdge = 'start';
  emit('render:all');
  emit('render:selection');
  recordHistory('拆分字幕');
  return { ok: true, cue: newCue };
}

const clipboardStyles = new WeakMap();
export function copyCues(){
  const ids=State.selectedIds.length?State.selectedIds:[State.selectedId].filter(Boolean);
  if(!ids.length){ showToast('沒有選取的字幕'); return; }
  State.clipboard=structuredClone(State.cues.filter(c=>ids.includes(c.id)));
  for(const cue of State.clipboard){
    const track=State.tracks[cue.track||0];
    clipboardStyles.set(cue,{track,style:structuredClone(effStyle(cue,track))});
  }
  showToast(`已複製 ${State.clipboard.length} 條字幕`);
}

export function pasteCues(){
  if(!State.clipboard?.length){ showToast('剪貼簿是空的'); return; }
  if(trackLocked(State.listTrack, '貼上字幕')) return;
  const timedClip=State.clipboard.filter(c=>c.timed!==false);
  const minStart=timedClip.length ? Math.min(...timedClip.map(c=>c.start)) : 0;
  const delta=Media.displayTime()-minStart;
  const newCues=State.clipboard.map(c=>{
    const oldTrack = c.track || 0;
    const newTrack = State.listTrack;
    let newStyle = c.style ? structuredClone(c.style) : undefined;
    const copied=clipboardStyles.get(c);
    
    if (copied ? copied.track !== State.tracks[newTrack] : oldTrack !== newTrack) {
      const oldEffStyle = copied?.style || effStyle({ style: newStyle }, State.tracks[oldTrack]);
      const plan = planCueStyleAssignment({
        cue: { style: newStyle },
        targetTrack: State.tracks[newTrack],
        desiredStyle: oldEffStyle
      });
      newStyle = plan.style;
    }
    
    if(c.timed===false) return {...c, id:newId(), track:newTrack, style: newStyle};
    const s=subtitleTimeOnFrame(Math.max(0,c.start+delta));
    const end=subtitleTimeOnFrame(c.end+delta,s+1/getExactFps(State.fps||25));
    const pasted={...c, id:newId(), track:newTrack, start:s, end, style:newStyle};
    delete pasted._tempEnd;
    return pasted;
  });
  State.cues.push(...newCues);
  sortCues();
  setSelection({ kind:'sub', ids:newCues.map(c=>c.id), primary:newCues[0].id });
  emit('render:all'); emit('render:selection'); recordHistory('貼上字幕');
  showToast(`已貼上 ${newCues.length} 條字幕`);
}

export function trimTrackSpaces() {
  if(trackLocked(State.listTrack, '整理字幕頭尾空白')) return;
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

export function currentSubtitleCompareSnapshot() {
  return {
    tracks: State.tracks,
    cues: State.cues,
    fps: State.fps,
    dropFrame: State.dropFrame,
  };
}

export function doCompareTrack() {
  if (State.tracks.length < 1) { showToast('沒有足夠的字幕軌道可供比對'); return; }
  const DESK = (typeof window !== 'undefined' && window.subtool) || null;
  if (DESK?.openCompareWindow) {
    import('./subtitle-comparison-engine.js').then(({ openSubtitleCompareSession }) => {
      openSubtitleCompareSession(currentSubtitleCompareSnapshot());
    });
  } else {
    showToast('此功能僅限桌面版使用');
  }
}

export function doCopyTrack() {
  const srcIdx = State.listTrack;
  const srcTrack = State.tracks[srcIdx];
  if (!srcTrack) { showToast('請先選擇一個字幕軌道'); return; }
  const srcCues = State.cues.filter(c => (c.track || 0) === srcIdx);
  const ownsWorkspace=Project.captureWorkspaceOwnership();
  const copy=withText=>{
    if(!session.isCurrent() || !ownsWorkspace()) return;
    const index=State.tracks.indexOf(srcTrack);
    if(index<0) return;
    const current=State.cues.filter(c=>(c.track||0)===index);
    if(current.length!==srcCues.length || !srcCues.every(c=>current.includes(c))){
      showToast('軌道內容已變更，請重新確認複製'); return;
    }
    session.close({committed:true});
    _execCopyTrack(index,withText);
  };
  const escapeHTML = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const session=openModal('複製字幕軌道',
    `<p>將 <b>${escapeHTML(srcTrack.name)}</b> 的 <b>${srcCues.length}</b> 條字幕複製到新軌道，請選擇複製方式：</p>`,
    [
      { label: '含文字內容', primary: true, act: () => copy(true) },
      { label: '僅複製時間點（文字清空）', act: () => copy(false) },
      { label: '取消', act: () => session.close() }
    ]
  );
}

function _execCopyTrack(srcIdx, withText) {
  const srcTrack = State.tracks[srcIdx]; if (!srcTrack) return;
  const base = srcTrack.name + '_複製';
  let name = base, n = 1;
  const names = State.tracks.map(t => t.name);
  while (names.includes(name)) name = base + (n++);
  
  const tk = { name, visible: true, locked: false, ...trackStyleSnapshot(srcTrack) };
  const newIdx = State.tracks.length;
  State.tracks.push(tk);
  ensureTrackCount(State.tracks.length);
  
  const srcCues = State.cues.filter(c => (c.track || 0) === srcIdx);
  for (const c of srcCues) {
    State.cues.push({ id: newId(), start: c.start, end: c.end, text: withText ? (c.text || '') : '', track: newIdx, timed: c.timed,
      ...(c.style ? { style: structuredClone(c.style) } : {}) });
  }
  
  sortCues();
  State.listTrack = newIdx;
  
  emit('render:all');
  emit('timeline:invalidate');
  emit('render:listTrackSel');
  
  recordHistory('複製字幕軌道');
  showToast(`已複製到「${name}」（${srcCues.length} 條）`);
}

export function removeSrtTags() {
  let changed = false;
  let skippedLocked = false;
  State.cues.forEach(c => {
    if (c.text) {
      const nt = c.text.replace(/<[^>]+>|\{\\[^}]+\}/g, '');
      if (nt !== c.text) {
        if (State.tracks[c.track || 0]?.locked) { skippedLocked = true; return; }
        c.text = nt; changed = true;
      }
    }
  });
  if (changed) {
    recordHistory('清除 SRT 標籤'); emit('render:all');
    setStatus(skippedLocked ? '已清除未鎖定軌標籤，並跳過鎖定軌' : '已清除所有標籤', 'ok');
  } else {
    setStatus(skippedLocked ? '未修改：已跳過鎖定軌字幕' : '未發現可清除的標籤', '');
  }
}

export function toggleSubMode(force = false) {
  State.subMode = !State.subMode;
  const smb = document.getElementById('subModeBtn');
  if (smb) smb.classList.toggle('sub-active', State.subMode);
  document.body.classList.toggle('sub-mode-on', State.subMode);
  
  if (State.subMode) {
    State._prevAutoSelect = State.autoSelect;
    State._prevOverwriteMode = State.overwriteMode;
    State._prevOverwriteKeep = State.overwriteKeep;
    if (State.autoSelect) toggleAutoSelect({ force: true });
    if (State.overwriteMode) toggleOverwriteMode({ force: true });
    if (!State.overwriteKeep) toggleOverwriteKeep({ force: true });

    State._subModeSequence = State.cues.map(c => c.id);
    setStatus('🎯 上字幕模式 ON — I 設起點，O 設終點後自動前進', 'ok');
  } else {
    if (State._prevAutoSelect !== undefined && State.autoSelect !== State._prevAutoSelect) toggleAutoSelect({ force: true });
    if (State._prevOverwriteMode !== undefined && State.overwriteMode !== State._prevOverwriteMode) toggleOverwriteMode({ force: true });
    if (State._prevOverwriteKeep !== undefined && State.overwriteKeep !== State._prevOverwriteKeep) toggleOverwriteKeep({ force: true });

    finalizeProvisionalCueEnds();
    delete State._subModeTouchedIds;
    sortCues();
    emit('render:all');
    Media.pause(); setStatus('上字幕模式 OFF', '');
  }
}

/**
 * 切換「播放時自動選取對應字幕」模式。
 * 
 * 附帶防禦：上字幕模式（subMode）期間強制關閉自動選取，避免按鍵與選取狀態互相干擾。
 * 
 * @param {object} [options]
 * @param {boolean} [options.force=false] 是否忽略 subMode 限制強制切換
 */
export function toggleAutoSelect({ force } = {}) {
  if (State.subMode && !force) { setStatus('上字幕模式中強制關閉自動選取', 'err'); return; }
  State.autoSelect = !State.autoSelect;
  document.querySelectorAll('.auto-select-btn').forEach(btn => {
    btn.textContent = State.autoSelect ? '自動選取' : '不自動選取';
    btn.classList.toggle('on', State.autoSelect);
  });
  setStatus(`播放時自動選取：${State.autoSelect ? '開' : '關'}`, 'ok');
  saveConfig();
}

/**
 * 切換「字幕覆蓋鎖定」模式（解鎖可自由重疊 vs 鎖定不可覆蓋）。
 * 
 * 附帶防禦：上字幕模式（subMode）期間強制鎖定為不可覆蓋。
 * 
 * @param {object} [options]
 * @param {boolean} [options.force=false] 是否忽略 subMode 限制強制切換
 */
export function toggleOverwriteMode({ force } = {}) {
  if (State.subMode && !force) { setStatus('上字幕模式中強制鎖定不可覆蓋', 'err'); return; }
  State.overwriteMode = !State.overwriteMode;
  document.querySelectorAll('.ow-toggle-btn').forEach(btn => {
    btn.textContent = State.overwriteMode ? '可覆蓋' : '不覆蓋';
    btn.classList.toggle('primary', State.overwriteMode);
  });
  document.querySelectorAll('.ow-keep-btn').forEach(btn => {
    btn.classList.toggle('inactive-mode', !State.overwriteMode);
  });
  setStatus(`覆蓋模式：${State.overwriteMode ? '解鎖 (可自由重疊)' : '鎖定 (不可覆蓋)'}`, 'ok');
  saveConfig();
}

/**
 * 切換字幕重疊時的行為（保留起點推移 vs 裁切直接截斷）。
 * 
 * 附帶防禦：上字幕模式（subMode）期間強制維持保留後方字幕。
 * 
 * @param {object} [options]
 * @param {boolean} [options.force=false] 是否忽略 subMode 限制強制切換
 */
export function toggleOverwriteKeep({ force } = {}) {
  if (State.subMode && !force) { setStatus('上字幕模式中強制保留後方字幕', 'err'); return; }
  State.overwriteKeep = !State.overwriteKeep;
  document.querySelectorAll('.ow-keep-btn').forEach(btn => {
    btn.textContent = State.overwriteKeep ? '保留' : '裁切';
    btn.classList.toggle('keep', State.overwriteKeep);
    btn.classList.toggle('del', !State.overwriteKeep);
  });
  setStatus(`重疊行為：${State.overwriteKeep ? '保留 (起點推移)' : '裁切 (直接截斷)'}`, 'ok');
  saveConfig();
}


export function burnedSubtitleTrackNames(tracks, cues = null) {
  const list = Array.isArray(tracks) ? tracks : [];
  const includedTracks = Array.isArray(cues)
    ? new Set(cues.map(cue => Number.isInteger(cue?.track) ? cue.track : 0))
    : null;
  const lastTrack = includedTracks?.size ? Math.max(...includedTracks) : list.length - 1;

  return Array.from({ length: Math.max(list.length, lastTrack + 1) }, (_, index) => {
    if (includedTracks && !includedTracks.has(index)) return null;
    const track = list[index];
    return (!track || track.visible !== false) ? (track?.name || `軌道 ${index + 1}`) : null;
  }).filter(Boolean);
}
