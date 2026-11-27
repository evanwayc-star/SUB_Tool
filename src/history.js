/* ==============================================================================
   SUB Tool — Module Architecture Protection ("src/history.js")
   ==============================================================================
   【維護鐵律】本檔案已納入全專案終極防禦網。
   所有修改必須遵循專案的單向資料流與職責分離原則，嚴禁在此實作越權的 DOM 操作。
============================================================================== */
/* SUB Tool — 動作紀錄（復原 / 重做） */
import { State, syncTrackCount, setFps, normalizeAudioProject, registerAudioSource, pruneSelection } from './state.js';
import { Seq } from './sequence.js';
import { $ } from './dom.js';
import { escapeHTML } from './util.js';
import { drawTimeline } from './timeline-renderer.js';
import { renderNotes } from './notes.js';
import { emit, on } from './events.js';
import { setStatus } from './ui.js';
import { syncSubtitleCompareSession } from './subtitle-comparison-engine.js';

export function syncCompareSnapshot(){
  return syncSubtitleCompareSession({
    tracks: State.tracks,
    cues: State.cues,
    fps: State.fps,
    dropFrame: State.dropFrame,
  });
}

/* ===== 動作紀錄（復原 / 重做） ===== */
// 即時配線預覽仍供播放器讀 State；其他背景工作的快照只收已提交的配線。
// token 由 History 持有，舊編輯的解除函式不能移除較新的投影。
let audioPreview = null;
const editPreviews = new Set();
let historyEpoch = 0;
let projectRestore = null;
let externalAudioSnapshot = () => State.externalAudioState || [];
function cancelPreviews(){
  audioPreview?.cancel?.();
  for(const preview of [...editPreviews]) preview.cancel?.();
  audioPreview=null;editPreviews.clear();
}
function rebaseRestoredAudio({sourceId,channels,options={},project=State.audioProject}){
  if(!projectRestore?.sources.has(sourceId)) return;
  for(const entry of new Set([projectRestore.entry,...History.stack]))
    entry.snap.audioProject=registerAudioSource(entry.snap.audioProject,sourceId,channels,options,project);
}
function previewLocation(target){
  for (const [live, saved] of [['cues','cues'],['tracks','tracks'],['videoTracks','videoTracks'],['clips','clipGeo'],['externalAudioState','externalAudioState']]) {
    const index = State[live]?.indexOf(target) ?? -1;
    if (index >= 0) return { live, saved, index };
  }
  const index = State.audioProject?.buses?.indexOf(target) ?? -1;
  if (index >= 0) return { live: 'audioProject', saved: 'audioProject', collection: 'buses', index };
  return null;
}
function previewCollection(source, location, key){
  const value = source[key];
  return location.collection ? value?.[location.collection] : value;
}
function previewTargetPresent(entry){
  const list=previewCollection(State,entry.location,entry.location.live);
  const target=entry.resolveTarget ? entry.resolveTarget() : entry.target;
  if(!list) return false;
  return (target!=null && list[entry.location.index]===target) || list.includes(target);
}
function previewTargetIndex(list,target,location){
  // 大量字幕一起拖曳時，多數仍在按下滑鼠時的槽位。插入或重排後才依 ID 重找。
  if(location.live==='cues' && target.id && list[location.index]?.id===target.id) return location.index;
  if(location.live==='externalAudioState' && target.audioSourceId) return list.findIndex(item=>item.audioSourceId===target.audioSourceId);
  if(target.id) return list.findIndex(item=>item.id===target.id);
  return previewCollection(State,location,location.live).indexOf(target);
}
function projectEditPreviews(snapshot, collectionKeys={}){
  for (const preview of editPreviews) {
    if (!preview.current()) { editPreviews.delete(preview); continue; }
    for (const entry of preview.entries) {
      const list = previewCollection(snapshot, entry.location, collectionKeys[entry.location.saved] || entry.location.saved);
      if (!list) continue;
      const liveTarget=entry.resolveTarget ? entry.resolveTarget() : entry.target;
      const index=previewTargetIndex(list,liveTarget,entry.location);
      if (index < 0) continue;
      if (entry.added) { list.splice(index, 1); continue; }
      for (const { field, present, value } of entry.values) {
        if (entry.ownsField?.(field) === false) continue;
        // 複合欄位的預覽 owner 可只投影自己擁有的子欄位；History 不解讀領域內容。
        const projected=entry.projectField?.(field,{present,value,current:list[index][field]});
        if (projected) {
          if(projected.present) list[index][field]=structuredClone(projected.value);
          else delete list[index][field];
        } else if (present) list[index][field] = structuredClone(value);
        else delete list[index][field];
      }
    }
  }
  return snapshot;
}
function audioProjectForSnapshot(){
  if(audioPreview && !audioPreview.owns()) audioPreview=null;
  return audioPreview ? audioPreview.initial() : State.audioProject;
}

// 字幕、樣式與逐字辨識結果都是純資料。即時編輯會原地修改巢狀欄位，
// 因此必須核對內容，不能只依 cue 身分或 id 判斷它有沒有改過。
function sameCueData(a,b){
  if(a===b) return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object') return false;
  if(Array.isArray(a)) return Array.isArray(b)&&a.length===b.length&&a.every((item,i)=>sameCueData(item,b[i]));
  if(Array.isArray(b)||Object.prototype.toString.call(a)!=='[object Object]'||Object.prototype.toString.call(b)!=='[object Object]') return false;
  const keys=Object.keys(a);
  return keys.length===Object.keys(b).length && keys.every(key=>Object.hasOwn(b,key)&&sameCueData(a[key],b[key]));
}

function snapshotCues(cues,previous){
  let byId;
  return cues.map((cue,i)=>{
    let saved=previous[i];
    if(saved?.id!==cue.id){
      byId??=new Map(previous.map(item=>[item.id,item]));
      saved=byId.get(cue.id);
    }
    return sameCueData(cue,saved)?saved:structuredClone(cue);
  });
}

function sameHistorySnapshot(a,b){
  const {cues:first,...otherFirst}=a, {cues:second,...otherSecond}=b;
  // 未設定與 undefined 沿用既有 JSON 判準，拖曳回原點等操作不留下空步驟。
  return first.length===second.length && first.every((cue,i)=>cue===second[i]||JSON.stringify(cue)===JSON.stringify(second[i]))
    && JSON.stringify(otherFirst)===JSON.stringify(otherSecond);
}

const History = {
  stack:[], hi:-1, max:120,
  // Project 持有尚未重新連結的來源；History 與存檔必須取同一份純資料。
  setExternalAudioSnapshotProvider(provider){
    externalAudioSnapshot=typeof provider==='function'?provider:()=>State.externalAudioState||[];
  },
  // 即時手勢可改 State 供預覽；背景紀錄只投影被手勢擁有的欄位，保留其他已提交編輯。
  // 結束函式必須在本次 commit 的 record 之前呼叫；reset/restore 會撤銷所有舊擁有者。
  beginPreview(targets, owns=()=>true, cancel=null){
    const preview = { entries: [], cancel, current: () => editPreviews.has(preview) && owns()
      && preview.entries.every(previewTargetPresent) };
    const add = (target, fields=[], { added=false, resolveTarget=null, ownsField=null, projectField=null }={}) => {
      const location = previewLocation(target);
      if (!location) return;
      // 外部音訊的 runtime asset 可維持 identity，但每次預覽會重新序列化純資料。
      // 該 adapter 可解析目前的純資料；是否仍屬於同一 asset 仍由 owns 判定。
      preview.entries.push({ target, location, added, resolveTarget, ownsField, projectField, values: fields.map(field => ({
        field, present:Object.hasOwn(target,field), value:structuredClone(target[field]),
      })) });
    };
    for (const entry of targets || []) add(entry.target, entry.fields, entry);
    editPreviews.add(preview);
    const release = () => editPreviews.delete(preview);
    release.isCurrent = preview.current;
    release.addTarget = add;
    return release;
  },
  beginAudioPreview(initial, owns=()=>true, cancel=null){
    const saved=typeof initial==='function'?null:structuredClone(initial);
    const token={initial:typeof initial==='function'?initial:()=>saved,owns,cancel};
    audioPreview=token;
    return ()=>{ if(audioPreview===token) audioPreview=null; };
  },
  // 在移除預覽目標前先讓整個交易撤回；否則多選手勢少一個成員後，
  // 其餘成員的暫時值可能被接下來的 History 或存檔當成已提交內容。
  cancelPreviewsForTargets(targets){
    const removed=new Set(targets||[]);
    for(const preview of [...editPreviews]){
      if(preview.entries.some(entry=>removed.has(entry.resolveTarget ? entry.resolveTarget() : entry.target))) preview.cancel?.();
    }
  },
  // clipGeo：影片幾何；externalAudioState：外部音訊的可編輯純資料。
  // AudioElement、波形與快取檔都不入 undo，Media 會依這份純資料重用或重建 runtime asset。
  // Project 可補入尚未重新連結的持久資料；預覽排除規則仍只有這一個 owner。
  committedSnapshot({clips=Seq.snapshot(), externalAudioState=State.externalAudioState||[]}={},previousCues=null){
    // 手勢投影會覆寫暫時欄位。只有無預覽的歷史步驟能共用先前的字幕。
    const reuse=previousCues && !editPreviews.size;
    const snapshot=structuredClone({cues:reuse?null:State.cues,tracks:State.tracks,notes:State.notes,trackCount:State.trackCount,videoTracks:State.videoTracks,
      audioProject:normalizeAudioProject(audioProjectForSnapshot()),externalAudioState,recognitionTerms:State.recognitionTerms || [],
      fps:State.fps,dropFrame:State.dropFrame,projectCanvas:State.projectCanvas??null,exportIn:State.exportIn??null,exportOut:State.exportOut??null,clips});
    if(reuse) snapshot.cues=snapshotCues(State.cues,previousCues);
    return projectEditPreviews(snapshot,{clipGeo:'clips'});
  },
  snap(previousCues=null){
    const {clips,...snapshot}=this.committedSnapshot({externalAudioState:externalAudioSnapshot()},previousCues);
    const saved={...snapshot,clipGeo:clips};
    // 純資料仍留在 History；Media 以此快照身分持有網頁 File 的 runtime 資格。
    emit('audio:externalSnapshot',{snapshot:saved});
    return saved;
  },
  // Undo/redo and reset replace the editing context; an unrelated new record
  // may truncate redo by replacing the array without replacing that context.
  captureOwnership(){ const epoch=historyEpoch; return ()=>epoch===historyEpoch; },
  reset(){
    // 切換基準前先讓原 owner 取消自己的欄位及 runtime；媒體 completion 不呼叫 reset。
    cancelPreviews();
    historyEpoch++; projectRestore=null;
    this.stack=[{label:'初始',snap:this.snap()}]; this.hi=0; renderHistory(); syncCompareSnapshot();
  },
  // 文件顯示後即提供 Undo；completion 清理未提交預覽，但不清除已提交歷史。
  beginProjectRestore({sourceIds=[]}={}){
    this.reset();
    const token={entry:this.stack[0],sources:new Set(sourceIds.filter(Boolean))};projectRestore=token;
    return ()=>{
      if(projectRestore!==token) return null;
      cancelPreviews();
      const live=new Map((State.externalAudioState||[]).map(source=>[source.audioSourceId,source]));
      for(const entry of new Set([token.entry,...this.stack])) for(const source of entry.snap.externalAudioState||[]){
        const restored=live.get(source.audioSourceId);
        if(restored){ source.duration=restored.duration;source.descriptors=structuredClone(restored.descriptors||[]); }
      }
      if(this.stack.length===1&&this.stack[0]===token.entry) token.entry.snap=this.snap();
      projectRestore=null;
      return structuredClone(token.entry.snap);
    };
  },
  /* 專案可先載入字幕、之後才重新連結媒體。媒體真正就緒時，把新出現的
     專案 clip 補進先前「尚無媒體」的歷史步驟，保留期間的字幕 Undo，
     同時避免任何一步復原後把剛重連的影片刪掉。 */
  rebaseSequence(list){
    if(!Array.isArray(list)||!list.length) return;
    for(const entry of new Set([...(projectRestore?[projectRestore.entry]:[]),...this.stack])){
      const existing=Array.isArray(entry?.snap?.clipGeo)?entry.snap.clipGeo:[];
      // 已經有影片的歷史屬於另一個完整 runtime，不可在「取代媒體」時把新舊主片合併。
      // rebase 只處理專案載入／第一支影片重連前尚無任何 video clip 的步驟。
      if(!projectRestore&&existing.some(clip=>clip?.type!=='image')) continue;
      const ids=new Set(existing.map(clip=>clip?.id).filter(Boolean));
      const merged=[...existing];
      for(const clip of list){
        if(clip?.id&&ids.has(clip.id)) continue;
        merged.push(structuredClone(clip));
        if(clip?.id) ids.add(clip.id);
      }
      entry.snap.clipGeo=merged;
    }
    renderHistory();
  },
  // A legacy browser project can acquire its first source ID only after the
  // user relinks its original clip. Replaying that source registration against
  // each history entry preserves that entry's own routing edits and bus IDs.
  rebaseRestoredSource(clipId,sourceId,{channels,options={},allocation=null}={}){
    if(!clipId||!sourceId) return;
    for(const entry of this.stack){
      if(!entry.snap.clipGeo?.some(clip=>clip.id===clipId&&clip.audioSourceId===sourceId)) continue;
      entry.snap.audioProject=registerAudioSource(entry.snap.audioProject,sourceId,channels,options,allocation);
    }
  },
  record(label){
    const old=this.stack[this.hi]?.snap;
    const newSnap=this.snap(old?.cues);
    if(old && sameHistorySnapshot(newSnap,old)) return;
    if(this.hi<this.stack.length-1)this.stack=this.stack.slice(0,this.hi+1);
    this.stack.push({label,snap:newSnap});
    if(this.stack.length>this.max){ this.stack.shift(); }
    this.hi=this.stack.length-1; renderHistory();
  },
  // 每次輸入立即留下 Undo；連續輸入只能改寫自己仍位於 head 的那一筆。
  // 其他編輯介入或 reset/restore 後，舊 token 不得把後來的工作合併掉。
  recordCoalesced(label, owner=null){
    if(owner?.epoch===historyEpoch && owner.entry===this.stack[this.hi]
      && owner.cues===State.cues && owner.tracks===State.tracks
      && owner.entry.label===label && this.hi===this.stack.length-1){
      const snapshot=this.snap(owner.entry.snap.cues);
      if(owner.baseline && this.stack[this.hi-1]===owner.baseline
        && sameHistorySnapshot(snapshot,owner.baseline.snap)){
        this.stack.pop(); this.hi--; renderHistory(); return null;
      }
      owner.entry.snap=snapshot; renderHistory(); return owner;
    }
    const previous=this.stack[this.hi];
    this.record(label);
    const entry=this.stack[this.hi];
    return entry===previous ? null : {entry,baseline:this.stack[this.hi-1]||null,epoch:historyEpoch,cues:State.cues,tracks:State.tracks};
  },
  restore(i){
    if(i<0||i>=this.stack.length)return;
    historyEpoch++;
    const d=structuredClone(this.stack[i].snap);
    // 必須在取消預覽或任何 State mutation 前保存位置；取消也可能改變 duration。
    emit('media:sequenceWillRestore');
    // 復原前結束手勢與配線的 runtime，不能只丟棄快照投影；否則指標
    // 擷取、拖曳狀態或尚在等待呈現的工作會繼續作用於已取代的資料。
    cancelPreviews();
    State.presetEdit=null;
    State.cues=d.cues; State.tracks=d.tracks; State.notes=d.notes||[]; syncTrackCount();
    State.videoTracks = (Array.isArray(d.videoTracks)&&d.videoTracks.length) ? d.videoTracks : [{name:'視訊軌 1',visible:true,locked:false}];
    State.audioProject=normalizeAudioProject(d.audioProject);
    State.projectCanvas=d.projectCanvas??null;
    State.recognitionTerms=[...(d.recognitionTerms || [])];
    // 專案音訊路由與 bus M/S/音量不只是畫面資料：還會決定 Web Audio 的實際 gain。
    // 還原快照後通知協調層重新套用，避免 Ctrl+Z/Redo 看起來已變、聲音卻維持舊設定。
    emit('audio:projectRestored', { audioProject: State.audioProject });
    State.externalAudioState=Array.isArray(d.externalAudioState)?d.externalAudioState:[];
    // Media 不反向由 History import；由快照身分取回 File 或依桌面路徑重建。
    emit('audio:externalRestored', { sources: State.externalAudioState, snapshot:this.stack[i].snap });
    Seq.restore(d.clipGeo); // 影片區塊幾何（位置/修剪）；compact 會補足 videoTracks 涵蓋現有片段
    if(d.fps) setFps(d.dropFrame?String(d.fps)+'df':d.fps);
    State.exportIn=d.exportIn??null;
    State.exportOut=d.exportOut??null;
    emit('media:sequenceRestored');
    pruneSelection(); // 還原後選取只留仍存在的字幕（三處各自寫過一次，現在同一條規則）
    this.hi=i; emit('render:listTrackSel'); emit('render:all'); drawTimeline(); renderNotes(); renderHistory();
    emit('project:canvasChanged');
    syncCompareSnapshot();
  },
  undo(){ if(this.hi>0){ this.restore(this.hi-1); setStatus('已復原','ok'); } else setStatus('沒有可復原的動作',''); },
  redo(){ if(this.hi<this.stack.length-1){ this.restore(this.hi+1); setStatus('已重做','ok'); } else setStatus('沒有可重做的動作',''); },
};
function recordHistory(label, { sync = true } = {}){
  History.record(label); 
  if(sync) syncCompareSnapshot();
}
function renderHistory(){
  const el=$('historyList'); if(!el)return;
  const focused=document.activeElement?.closest?.('.hist-item');
  const focusedIndex=focused?.parentElement===el?focused.dataset.hi:null;
  el.innerHTML=History.stack.map((h,i)=>
    `<button type="button" class="hist-item ${i===History.hi?'current':''} ${i>History.hi?'future':''}" data-hi="${i}"${i===History.hi?' aria-current="step"':''}>`+
    `<span class="hi-idx" aria-hidden="true">${i}</span><span class="hi-name">${escapeHTML(h.label)}</span>${i===History.hi?'<span class="hi-current">目前</span>':''}</button>`
  ).join('') || '<p class="empty">編輯後，變更紀錄會顯示在這裡。</p>';
  el.querySelectorAll('.hist-item').forEach(button=>{
    button.onclick=()=>History.restore(+button.dataset.hi);
    if(button.dataset.hi===focusedIndex) button.focus({preventScroll:true});
  });
}
on('media:projectReady',detail=>History.rebaseSequence(detail?.clips));
on('media:projectClipRestored',detail=>{
  if(!projectRestore) return;
  History.rebaseSequence(detail?.clips);
  for(const clip of detail?.clips||[]){
    const sourceId=clip.audioSourceId;
    if(!sourceId) continue;
    projectRestore.sources.add(sourceId);
    const map=State.audioProject?.sourceMaps?.[sourceId];
    if(map) rebaseRestoredAudio({sourceId,channels:map.channels});
  }
});
on('audio:sourceRegistered',rebaseRestoredAudio);

export { History, recordHistory, renderHistory };
