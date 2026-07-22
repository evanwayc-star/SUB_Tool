/* SUB Tool — 動作紀錄（復原 / 重做） */
import { State, syncTrackCount, setFps, normalizeAudioProject } from './state.js';
import { Seq } from './sequence.js';
import { $ } from './dom.js';
import { escapeHTML } from './util.js';
import { drawTimeline } from './timeline.js';
import { renderNotes } from './notes.js';
import { emit } from './events.js';
import { setStatus } from './ui.js';

/* ===== 動作紀錄（復原 / 重做） ===== */
const History = {
  stack:[], hi:-1, max:120,
  // clipGeo：影片幾何；externalAudioState：外部音訊的可編輯純資料。
  // AudioElement、波形與快取檔都不入 undo，Media 會依這份純資料重用或重建 runtime asset。
  snap(){ return structuredClone({cues:State.cues,tracks:State.tracks,notes:State.notes,trackCount:State.trackCount,videoTracks:State.videoTracks,
    audioProject:normalizeAudioProject(State.audioProject),externalAudioState:State.externalAudioState||[],
    fps:State.fps,dropFrame:State.dropFrame,exportIn:State.exportIn??null,exportOut:State.exportOut??null,clipGeo:Seq.snapshot()}); },
  reset(){ this.stack=[{label:'初始',snap:this.snap()}]; this.hi=0; renderHistory(); },
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
    if(!State.cues.some(c=>c.id===State.selectedId)){ State.selectedId=null; State.selectedIds=[]; }
    else State.selectedIds=State.selectedIds.filter(id=>State.cues.some(c=>c.id===id));
    this.hi=i; emit('render:listTrackSel'); emit('render:all'); drawTimeline(); renderNotes(); renderHistory();
  },
  undo(){ if(this.hi>0){ this.restore(this.hi-1); setStatus('已復原','ok'); } else setStatus('沒有可復原的動作',''); },
  redo(){ if(this.hi<this.stack.length-1){ this.restore(this.hi+1); setStatus('已重做','ok'); } else setStatus('沒有可重做的動作',''); },
};
function recordHistory(label){ History.record(label); }
function renderHistory(){
  const el=$('historyList'); if(!el)return;
  el.innerHTML=History.stack.map((h,i)=>
    `<div class="hist-item ${i===History.hi?'current':''} ${i>History.hi?'future':''}" data-hi="${i}"><span class="hi-idx">${i}</span><span>${escapeHTML(h.label)}</span></div>`
  ).join('');
  el.querySelectorAll('.hist-item').forEach(d=>d.onclick=()=>History.restore(+d.dataset.hi));
}

export { History, recordHistory, renderHistory };
