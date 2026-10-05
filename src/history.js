/* ==============================================================================
   SUB Tool — Module Architecture Protection ("src/history.js")
   ==============================================================================
   【維護鐵律】本檔案已納入全專案終極防禦網。
   所有修改必須遵循專案的單向資料流與職責分離原則，嚴禁在此實作越權的 DOM 操作。
============================================================================== */
/* SUB Tool — 動作紀錄（復原 / 重做） */
import { State, syncTrackCount, setFps, normalizeAudioProject, pruneSelection } from './state.js';
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
function previewLocation(target){
  for (const [live, saved] of [['cues','cues'],['tracks','tracks'],['videoTracks','videoTracks'],['clips','clipGeo'],['externalAudioState','externalAudioState']]) {
    const index = State[live]?.indexOf(target) ?? -1;
    if (index >= 0) return { live, saved, index };
  }
  return null;
}
function projectEditPreviews(snapshot, collectionKeys={}){
  for (const preview of editPreviews) {
    if (!preview.current()) { editPreviews.delete(preview); continue; }
    for (const entry of preview.entries) {
      const list = snapshot[collectionKeys[entry.location.saved] || entry.location.saved];
      const liveTarget=entry.resolveTarget ? entry.resolveTarget() : entry.target;
      const index = liveTarget.audioSourceId && entry.location.live === 'externalAudioState'
        ? list.findIndex(item => item.audioSourceId === liveTarget.audioSourceId)
        : liveTarget.id ? list.findIndex(item => item.id === liveTarget.id) : State[entry.location.live].indexOf(liveTarget);
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
  return audioPreview ? audioPreview.initial : State.audioProject;
}
const History = {
  stack:[], hi:-1, max:120,
  // 即時手勢可改 State 供預覽；背景紀錄只投影被手勢擁有的欄位，保留其他已提交編輯。
  // 結束函式必須在本次 commit 的 record 之前呼叫；reset/restore 會撤銷所有舊擁有者。
  beginPreview(targets, owns=()=>true){
    const preview = { entries: [], current: () => editPreviews.has(preview) && owns()
      && preview.entries.every(entry => State[entry.location.live]?.includes(entry.resolveTarget ? entry.resolveTarget() : entry.target)) };
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
  beginAudioPreview(initial, owns=()=>true){
    const token={initial:structuredClone(initial),owns};
    audioPreview=token;
    return ()=>{ if(audioPreview===token) audioPreview=null; };
  },
  // clipGeo：影片幾何；externalAudioState：外部音訊的可編輯純資料。
  // AudioElement、波形與快取檔都不入 undo，Media 會依這份純資料重用或重建 runtime asset。
  // Project 可補入尚未重新連結的持久資料；預覽排除規則仍只有這一個 owner。
  committedSnapshot({clips=Seq.snapshot(), externalAudioState=State.externalAudioState||[]}={}){
    return projectEditPreviews(structuredClone({cues:State.cues,tracks:State.tracks,notes:State.notes,trackCount:State.trackCount,videoTracks:State.videoTracks,
      audioProject:normalizeAudioProject(audioProjectForSnapshot()),externalAudioState,
      fps:State.fps,dropFrame:State.dropFrame,exportIn:State.exportIn??null,exportOut:State.exportOut??null,clips}), {clipGeo:'clips'});
  },
  snap(){ const {clips,...snapshot}=this.committedSnapshot(); return {...snapshot,clipGeo:clips}; },
  reset(){ historyEpoch++; audioPreview=null; editPreviews.clear(); this.stack=[{label:'初始',snap:this.snap()}]; this.hi=0; renderHistory(); syncCompareSnapshot(); },
  /* 專案可先載入字幕、之後才重新連結媒體。媒體真正就緒時，把新出現的
     專案 clip 補進先前「尚無媒體」的歷史步驟，保留期間的字幕 Undo，
     同時避免任何一步復原後把剛重連的影片刪掉。 */
  rebaseSequence(list){
    if(!Array.isArray(list)||!list.length) return;
    for(const entry of this.stack){
      const existing=Array.isArray(entry?.snap?.clipGeo)?entry.snap.clipGeo:[];
      // 已經有影片的歷史屬於另一個完整 runtime，不可在「取代媒體」時把新舊主片合併。
      // rebase 只處理專案載入／第一支影片重連前尚無任何 video clip 的步驟。
      if(existing.some(clip=>clip?.type!=='image')) continue;
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
  record(label){
    const newSnap = this.snap();
    if(this.hi >= 0) {
      const old = this.stack[this.hi].snap;
      // Fix #8：先做 O(1) 結構比對；只有結構相同時才 fallback 到深層 JSON 比對，
      // 避免千條字幕的大型專案在每次操作後序列化整個 State。
      const structSame = old.cues.length === newSnap.cues.length
        && old.tracks.length === newSnap.tracks.length
        && old.notes.length === newSnap.notes.length
        && (old.clipGeo?.length || 0) === (newSnap.clipGeo?.length || 0)
        && (old.videoTracks?.length || 0) === (newSnap.videoTracks?.length || 0)
        && (old.audioProject?.buses?.length || 0) === (newSnap.audioProject?.buses?.length || 0)
        && Object.keys(old.audioProject?.sourceMaps || {}).length === Object.keys(newSnap.audioProject?.sourceMaps || {}).length
        && (old.audioProject?.exportLayout?.streams?.length || 0) === (newSnap.audioProject?.exportLayout?.streams?.length || 0)
        && (old.externalAudioState?.length || 0) === (newSnap.externalAudioState?.length || 0)
        && old.fps === newSnap.fps
        && old.dropFrame === newSnap.dropFrame
        && old.exportIn === newSnap.exportIn
        && old.exportOut === newSnap.exportOut;
      if(!structSame){ /* 結構有變動，直接記錄 */ }
      else {
        const len = newSnap.cues.length;
        if(len > 300) {
          const firstOld = old.cues[0], firstNew = newSnap.cues[0];
          const lastOld = old.cues[len - 1], lastNew = newSnap.cues[len - 1];
          if(firstOld?.start !== firstNew?.start || firstOld?.end !== firstNew?.end || firstOld?.text !== firstNew?.text ||
             lastOld?.start !== lastNew?.start || lastOld?.end !== lastNew?.end || lastOld?.text !== lastNew?.text){
            // 抽樣不同，必然有變動，直接記錄
          } else if(JSON.stringify(newSnap) === JSON.stringify(old)) return;
        } else if(JSON.stringify(newSnap) === JSON.stringify(old)) return;
      }
    }
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
      const snapshot=this.snap();
      if(owner.baseline && this.stack[this.hi-1]===owner.baseline
        && JSON.stringify(snapshot)===JSON.stringify(owner.baseline.snap)){
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
    audioPreview=null;
    editPreviews.clear();
    State.presetEdit=null;
    const d=structuredClone(this.stack[i].snap);
    // 必須在任何 State mutation 前保存位置；音訊或 duration 還原也可能改變 tlTime。
    emit('media:sequenceWillRestore');
    State.cues=d.cues; State.tracks=d.tracks; State.notes=d.notes||[]; syncTrackCount();
    State.videoTracks = (Array.isArray(d.videoTracks)&&d.videoTracks.length) ? d.videoTracks : [{name:'視訊軌 1',visible:true,locked:false}];
    State.audioProject=normalizeAudioProject(d.audioProject);
    // 專案音訊路由與 bus M/S/音量不只是畫面資料：還會決定 Web Audio 的實際 gain。
    // 還原快照後通知協調層重新套用，避免 Ctrl+Z/Redo 看起來已變、聲音卻維持舊設定。
    emit('audio:projectRestored', { audioProject: State.audioProject });
    State.externalAudioState=Array.isArray(d.externalAudioState)?d.externalAudioState:[];
    // Media 不反向由 History import；用事件讓它重用現存音源、或在桌面版依路徑重建。
    emit('audio:externalRestored', { sources: State.externalAudioState });
    Seq.restore(d.clipGeo); // 影片區塊幾何（位置/修剪）；compact 會補足 videoTracks 涵蓋現有片段
    if(d.fps) setFps(d.dropFrame?String(d.fps)+'df':d.fps);
    State.exportIn=d.exportIn??null;
    State.exportOut=d.exportOut??null;
    emit('media:sequenceRestored');
    pruneSelection(); // 還原後選取只留仍存在的字幕（三處各自寫過一次，現在同一條規則）
    this.hi=i; emit('render:listTrackSel'); emit('render:all'); drawTimeline(); renderNotes(); renderHistory();
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
  el.innerHTML=History.stack.map((h,i)=>
    `<div class="hist-item ${i===History.hi?'current':''} ${i>History.hi?'future':''}" data-hi="${i}"><span class="hi-idx">${i}</span><span>${escapeHTML(h.label)}</span></div>`
  ).join('');
  el.querySelectorAll('.hist-item').forEach(d=>d.onclick=()=>History.restore(+d.dataset.hi));
}
on('media:projectReady',detail=>History.rebaseSequence(detail?.clips));

export { History, recordHistory, renderHistory };
