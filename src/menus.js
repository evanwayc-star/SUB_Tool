/* SUB Tool — 右鍵選單（播放窗音軌/速度、字幕移軌） */
import { $, video, tlScroll, tlLayer } from './dom.js';
import { escapeHTML } from './util.js';
import { State, isSel } from './state.js';
import { Media } from './media.js';
import { addCue, addCueRelative, deleteSelected, clearSelectedCuesTime, selectCue, refreshSelectionUI, shiftTextsDown, shiftTextsUp, enterSwapMode, swapAdjacentCues, mergeAdjacentCues, copyCues, pasteCues } from './subtitles.js';
import { moveSelectedToTrack, xToTime, trackFromY, tracksTop, drawTimeline } from './timeline.js';
import { Seq } from './sequence.js';
import { showToast } from './ui.js';
import { recordHistory } from './history.js';
import { emit } from './events.js';
import { renderAudioTracks, renderMixer } from './mixer.js';

/* ===== 右鍵選單 ===== */
const ctx=$('ctxmenu');
function hideCtx(){
  const was=ctx.classList.contains('show');
  ctx.classList.remove('show'); ctx.innerHTML='';
  if(was) emit('mpv:sync'); // 選單若曾讓 mpv 讓位，關閉時恢復（僅在真的有開過才發，避免每次 mousedown 都打 IPC）
}
function showCtx(x,y,items){
  ctx.innerHTML='';
  for(const it of items){
    let d;
    if(it.sep){ d=document.createElement('div'); d.className='msep'; }
    else if(it.heading){ d=document.createElement('div'); d.className='lbl'; d.textContent=it.label; }
    else { d=document.createElement('div'); d.className='ci'; d.setAttribute('role','menuitem');
      let icon = '';
      let text = it.label;
      const match = text.match(/^([⬆⬇⇄⇅→⏱🗑✂↓↑])\s*(.*)$/u);
      if (match) { icon = match[1]; text = match[2]; }
      d.innerHTML=`<span class="c-icon">${icon}</span><span class="c-text">${escapeHTML(text)}</span>`+(it.checked?'<span class="chk">✓</span>':'');
      d.onclick=()=>{ hideCtx(); it.act&&it.act(); }; }
    ctx.appendChild(d);
  }
  ctx.setAttribute('role','menu');
  ctx.classList.add('show');
  const w=ctx.offsetWidth,h=ctx.offsetHeight;
  ctx.style.left=Math.max(6,Math.min(x,window.innerWidth-w-6))+'px';
  ctx.style.top=Math.max(6,Math.min(y,window.innerHeight-h-6))+'px';
  emit('mpv:sync'); // 定位完成後重算：選單若與影片重疊，讓 mpv 讓位（否則 mpv 為 OS 子視窗會蓋住選單）
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

  // 文字交換與合併
  if(State.selectedId){
    const selCue=State.cues.find(c=>c.id===State.selectedId);
    if(selCue){
      const tk=selCue.track||0;
      const list=State.cues.filter(c=>(c.track||0)===tk);
      const i=list.findIndex(c=>c.id===State.selectedId);
      const hasPrev = i > 0;
      const hasNext = i >= 0 && i < list.length - 1;
      
      if (hasPrev || hasNext) {
        if (hasPrev) {
          items.push({label:'↑ 與上句合併',act:()=>mergeAdjacentCues(selCue.id, -1)});
        }
        if (hasNext) {
          items.push({label:'↓ 與下句合併',act:()=>mergeAdjacentCues(selCue.id, 1)});
        }
        items.push({sep:true});
      }
      
      items.push({label:'⇄ 文字交換',act:()=>enterSwapMode(State.selectedId)});
      
      if (hasPrev || hasNext) {
        items.push({sep:true});
        if (hasPrev) {
          items.push({label:'⇅ 與上一句相鄰換位',act:()=>swapAdjacentCues(selCue.id, -1)});
        }
        if (hasNext) {
          items.push({label:'⇅ 與下一句相鄰換位',act:()=>swapAdjacentCues(selCue.id, 1)});
        }
      }
    }
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
  items.push({sep:true});
  items.push({label:'⏱ 清除字幕時間點',act:()=>clearSelectedCuesTime()});
  items.push({sep:true});
  items.push({label:'🗑 刪除字幕',act:()=>deleteSelected()});
  showCtx(x,y,items);
}
/* 時間軸區塊右鍵 / 空白軌道區右鍵 */
tlScroll.addEventListener('contextmenu',e=>{
  /* 影片序列區塊右鍵 */
  const clipEl=e.target.closest('.clip-block');
  if(clipEl){
    e.preventDefault();
    const c=Seq.byId(clipEl.dataset.clipId); if(!c)return;
    const trimmed=c.in>0.01||c.out<c.dur-0.01;
    const items=[{heading:true,label:'🎬 '+c.name}];
    // 播放頭在此段內 → 可就地切割（等同 Ctrl+K）
    const pt=Media.displayTime();
    if(Seq.clipAt(pt)===c) items.push({label:'✂ 在播放點切割（Ctrl+K）',act:()=>{ Media.splitClipAt(pt); }});
    items.push({label:'⏱ 播放頭移到此段開頭',act:()=>{ Media.seek(c.offset); emit('playhead:ensure'); }});
    // 相鄰段交換（依時間軸順序；保留兩段之間的間距）
    const sorted=[...State.clips].sort((a,b)=>a.offset-b.offset);
    const idx=sorted.indexOf(c);
    const swap=(a,b)=>{ // a=前段 b=後段
      const gap=b.offset-Seq.clipEnd(a), start=a.offset;
      b.offset=start; a.offset=start+Seq.len(b)+gap;
      Seq.sort(); Seq.recomputeDuration();
      recordHistory('影片段交換');
      Media.seek(Math.min(Media.displayTime(), State.duration||0));
      drawTimeline(); emit('render:videoSub'); emit('mpv:refreshSubs');
    };
    if(idx>0) items.push({label:'◀ 與前一段交換',act:()=>swap(sorted[idx-1], c)});
    if(idx<sorted.length-1) items.push({label:'▶ 與後一段交換',act:()=>swap(c, sorted[idx+1])});
    if(trimmed) items.push({label:'↺ 重設修剪（還原完整長度）',act:()=>{
      const save={in:c.in,out:c.out};
      c.in=0; c.out=c.dur;
      const ov=State.clips.some(o=>o!==c && o.offset < Seq.clipEnd(c) - 1e-6 && Seq.clipEnd(o) > c.offset + 1e-6);
      if(ov){ c.in=save.in; c.out=save.out; showToast('還原完整長度會與相鄰影片重疊，請先移開再重設'); return; }
      Seq.recomputeDuration(); recordHistory('重設修剪：'+c.name); drawTimeline();
    }});
    if(State.clips.length>1){
      items.push({sep:true});
      items.push({label:'🗑 從序列移除',act:()=>{
        if(Media.removeClip(c.id)){ recordHistory('移除影片段：'+c.name); drawTimeline(); }
      }});
    }
    showCtx(e.clientX,e.clientY,items);
    return;
  }
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
