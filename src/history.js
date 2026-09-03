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
import { drawTimeline } from './timeline.js';
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
const History = {
  stack:[], hi:-1, max:120,
  // clipGeo：影片幾何；externalAudioState：外部音訊的可編輯純資料。
  // AudioElement、波形與快取檔都不入 undo，Media 會依這份純資料重用或重建 runtime asset。
  snap(){ return structuredClone({cues:State.cues,tracks:State.tracks,notes:State.notes,trackCount:State.trackCount,videoTracks:State.videoTracks,
    audioProject:normalizeAudioProject(State.audioProject),externalAudioState:State.externalAudioState||[],
    fps:State.fps,dropFrame:State.dropFrame,exportIn:State.exportIn??null,exportOut:State.exportOut??null,clipGeo:Seq.snapshot()}); },
  reset(){ this.stack=[{label:'初始',snap:this.snap()}]; this.hi=0; renderHistory(); syncCompareSnapshot(); },
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
  restore(i){
    if(i<0||i>=this.stack.length)return;
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
