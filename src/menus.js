/* SUB Tool — 右鍵選單（播放窗音軌/速度、字幕移軌） */
import { $, video, tlScroll, tlLayer } from './dom.js';
import { escapeHTML } from './util.js';
import { State, isSel } from './state.js';
import { Media } from './media.js';
import { addCue, addCueRelative, deleteSelected, selectCue, refreshSelectionUI, shiftTextsDown, shiftTextsUp, enterSwapMode, copyCues, pasteCues } from './subtitles.js';
import { moveSelectedToTrack, xToTime, trackFromY, tracksTop } from './timeline.js';
import { recordHistory } from './history.js';
import { emit } from './events.js';
import { renderAudioTracks, renderMixer } from './mixer.js';

/* ===== 右鍵選單 ===== */
const ctx=$('ctxmenu');
function hideCtx(){ ctx.classList.remove('show'); ctx.innerHTML=''; }
function showCtx(x,y,items){
  ctx.innerHTML='';
  for(const it of items){
    let d;
    if(it.sep){ d=document.createElement('div'); d.className='msep'; }
    else if(it.heading){ d=document.createElement('div'); d.className='lbl'; d.textContent=it.label; }
    else { d=document.createElement('div'); d.className='ci';
      d.innerHTML=escapeHTML(it.label)+(it.checked?'<span class="chk">✓</span>':'');
      d.onclick=()=>{ hideCtx(); it.act&&it.act(); }; }
    ctx.appendChild(d);
  }
  ctx.classList.add('show');
  const w=ctx.offsetWidth,h=ctx.offsetHeight;
  ctx.style.left=Math.max(6,Math.min(x,window.innerWidth-w-6))+'px';
  ctx.style.top=Math.max(6,Math.min(y,window.innerHeight-h-6))+'px';
}
document.addEventListener('mousedown',e=>{ if(e.button===2)return; if(!ctx.contains(e.target))hideCtx(); },true);
window.addEventListener('blur',hideCtx);
window.addEventListener('resize',hideCtx);

/* 播放窗右鍵：音訊來源切換 + 播放速度 */
function showPlayerMenu(x,y){
  const srcs=Media.getSources();
  const active=Media.activeSource;
  const items=[{heading:true,label:'音訊來源'}];
  if(srcs.length===0){
    items.push({label:'（尚未載入音訊）'});
  } else {
    for(const s of srcs)
      items.push({label:s.label,checked:active===s.id,
        act:()=>{ Media.switchSource(s.id); renderMixer(); }});
  }
  items.push({sep:true});
  items.push({label:'🔊 載入外部音檔…',act:()=>emit('action','add-audio')});
  items.push({sep:true},{heading:true,label:'播放速度'});
  [0.25,0.5,0.75,1,1.25,1.5,2].forEach(r=>items.push({label:r+'×',
    checked:(video.playbackRate||1)===r,act:()=>Media.setRate(r)}));
  showCtx(x,y,items);
}
$('videoWrap').addEventListener('contextmenu',e=>{ e.preventDefault(); showPlayerMenu(e.clientX,e.clientY); });

/* 字幕右鍵：移到軌道 / 上下新增 / 刪除 */
function showCueMenu(x,y){
  const n=State.selectedIds.length||(State.selectedId?1:0);
  const items=[{heading:true,label:`已選 ${n} 條字幕`}];
  items.push({label:`複製 ${n} 條字幕`,act:()=>copyCues()});
  if(State.clipboard?.length) items.push({label:`貼上 ${State.clipboard.length} 條字幕`,act:()=>pasteCues()});
  items.push({sep:true});

  // 單選空白字幕時，顯示文字位移選項
  if(n===1 && State.selectedId){
    const selCue=State.cues.find(c=>c.id===State.selectedId);
    if(selCue && !(selCue.text||'').trim()){
      const tk=selCue.track||0;
      const list=State.cues.filter(c=>(c.track||0)===tk);
      const i=list.findIndex(c=>c.id===State.selectedId);
      const hasAbove=i>0&&!!(list[i-1].text||'').trim();
      const hasBelow=i<list.length-1&&!!(list[i+1].text||'').trim();
      if(hasAbove){
        const raw=(list[i-1].text||'').trim();
        const preview=raw.length>8?raw.slice(0,8)+'…':raw;
        items.push({label:`↓ 上方「${preview}」往下移動`,act:()=>shiftTextsDown(selCue.id)});
      }
      if(hasBelow){
        const raw=(list[i+1].text||'').trim();
        const preview=raw.length>8?raw.slice(0,8)+'…':raw;
        items.push({label:`↑ 下方「${preview}」往上移動`,act:()=>shiftTextsUp(selCue.id)});
      }
      if(hasAbove||hasBelow)items.push({sep:true});
    }
  }

  // 將以上 / 以下字幕選取
  if(State.selectedId){
    const _c=State.cues.find(c=>c.id===State.selectedId);
    if(_c){
      const _tk=_c.track||0;
      const _list=State.cues.filter(c=>(c.track||0)===_tk);
      const _i=_list.findIndex(c=>c.id===State.selectedId);
      let addedSel=false;
      if(_i>0){
        items.push({label:'⬆ 將以上字幕選取',act:()=>{
          const ids=_list.slice(0,_i+1).map(c=>c.id);
          State.selectedIds=ids; State.selectedId=_c.id; State.activeEdge='start';
          refreshSelectionUI();
          $('stSel').textContent='已選 '+ids.length+' 條';
        }}); addedSel=true;
      }
      if(_i>=0 && _i<_list.length-1){
        items.push({label:'⬇ 將以下字幕選取',act:()=>{
          const ids=_list.slice(_i).map(c=>c.id);
          State.selectedIds=ids; State.selectedId=_c.id; State.activeEdge='start';
          refreshSelectionUI();
          $('stSel').textContent='已選 '+ids.length+' 條';
        }}); addedSel=true;
      }
      if(addedSel)items.push({sep:true});
    }
  }

  // 字幕對調
  if(State.selectedId){
    items.push({label:'⇄ 字幕對調',act:()=>enterSwapMode(State.selectedId)});
    items.push({sep:true});
  }

  if(State.trackCount>1){
    if(!State.selectedId) items.push({sep:true});
    items.push({heading:true,label:'移動到軌道'});
    State.tracks.forEach((tk,i)=>items.push({label:'→ '+tk.name,act:()=>moveSelectedToTrack(i)}));
    items.push({sep:true});
  }
  items.push({label:'⬆ 上方新增空白字幕',act:()=>addCueRelative(-1)});
  items.push({label:'⬇ 下方新增空白字幕',act:()=>addCueRelative(1)});
  items.push({sep:true},{label:'🗑 刪除選取',act:()=>deleteSelected()});
  showCtx(x,y,items);
}
/* 時間軸區塊右鍵 / 空白軌道區右鍵 */
tlScroll.addEventListener('contextmenu',e=>{
  const block=e.target.closest('.cue-block');
  const rect=tlLayer.getBoundingClientRect();
  const y=e.clientY-rect.top;
  if(!block){
    // 在軌道行點右鍵（y > tracksTop()）→ 生成空白字幕
    if(y<tracksTop())return;
    e.preventDefault();
    const t=xToTime(e.clientX-rect.left);
    const tk=trackFromY(e.clientY);
    if(State.tracks[tk]?.locked){ showCtx(e.clientX,e.clientY,[{label:'🔒 此軌道已鎖定'}]); return; }
    showCtx(e.clientX,e.clientY,[{label:`＋ 新增空白字幕（1 秒）`,act:()=>{
      const c=addCue(t,t+1,'',tk); selectCue(c.id); recordHistory('右鍵新增字幕');
    }}]);
    return;
  }
  e.preventDefault();
  if(!isSel(block.dataset.id))selectCue(block.dataset.id);
  else { State.selectedId=block.dataset.id; refreshSelectionUI(); }
  showCueMenu(e.clientX,e.clientY);
});

/* 動作分派 */

export { hideCtx, showCtx, showPlayerMenu, showCueMenu };
