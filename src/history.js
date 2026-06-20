/* SUB Tool — 動作紀錄（復原 / 重做） */
import { State, syncTrackCount } from './state.js';
import { $ } from './dom.js';
import { escapeHTML } from './util.js';
import { drawTimeline } from './timeline.js';
import { renderNotes } from './notes.js';
import { renderListTrackSel, renderAll, setStatus } from './app.js';

/* ===== 動作紀錄（復原 / 重做） ===== */
const History = {
  stack:[], hi:-1, max:120,
  snap(){ return JSON.stringify({cues:State.cues,tracks:State.tracks,notes:State.notes,trackCount:State.trackCount}); },
  reset(){ this.stack=[{label:'初始',snap:this.snap()}]; this.hi=0; renderHistory(); },
  record(label){
    if(this.hi<this.stack.length-1)this.stack=this.stack.slice(0,this.hi+1); // 截斷未來
    this.stack.push({label,snap:this.snap()});
    if(this.stack.length>this.max){ this.stack.shift(); }
    this.hi=this.stack.length-1; renderHistory();
  },
  restore(i){
    if(i<0||i>=this.stack.length)return;
    const d=JSON.parse(this.stack[i].snap);
    State.cues=d.cues; State.tracks=d.tracks; State.notes=d.notes||[]; syncTrackCount();
    if(!State.cues.some(c=>c.id===State.selectedId)){ State.selectedId=null; State.selectedIds=[]; }
    else State.selectedIds=State.selectedIds.filter(id=>State.cues.some(c=>c.id===id));
    this.hi=i; renderListTrackSel(); renderAll(); drawTimeline(); renderNotes(); renderHistory();
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
