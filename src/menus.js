/* SUB Tool — 右鍵選單（播放窗音軌/速度、字幕移軌） */
import { $, video, tlScroll, tlLayer } from './dom.js';
import { escapeHTML } from './util.js';
import { State, isSel } from './state.js';
import { Media, Wave } from './media.js';
import { addCue, addCueRelative, deleteSelected, clearSelectedCuesTime, selectCue, refreshSelectionUI, shiftTextsDown, shiftTextsUp, enterSwapMode, swapAdjacentCues, mergeAdjacentCues, copyCues, pasteCues } from './subtitles.js';
import { moveSelectedToTrack, xToTime, trackFromY, tracksTop, drawTimeline, selectClip, showClipFade, showCrossfade } from './timeline.js';
import { Seq } from './sequence.js';
import { showToast } from './ui.js';
import { recordHistory } from './history.js';
import { emit } from './events.js';

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

/* 播放窗右鍵：播放速度。音訊素材波形改由時間軸素材區塊右鍵選擇，
   不能再用這裡切換唯一音源，否則會破壞專案 A bus 的混音。 */
function showPlayerMenu(x,y){
  const items=[{heading:true,label:'播放速度'}];
  [0.25,0.5,0.75,1,1.25,1.5,2].forEach(r=>items.push({label:r+'×',
    checked:(video.playbackRate||1)===r,act:()=>Media.setRate(r)}));
  showCtx(x,y,items);
}
$('videoWrap').addEventListener('contextmenu',e=>{ e.preventDefault(); });

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
          $('stSel').textContent=ids.length?('已選 '+ids.length+' 條'):'';
        }}); addedSel=true;
      }
      if(_i>=0 && _i<_list.length-1){
        items.push({label:'⬇ 將以下字幕選取',act:()=>{
          const ids=_list.slice(_i).map(c=>c.id);
          State.selectedIds=ids; State.selectedId=_c.id; State.activeEdge='start';
          refreshSelectionUI();
          $('stSel').textContent=ids.length?('已選 '+ids.length+' 條'):'';
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
/* 外部音訊素材的幾何與播放狀態都由 Media 持有。選單只負責意圖／重繪，
   以支援 split 的非同步載入流程，也不重複記錄 History。 */
function selectExternalAudioForMenu(assetId,label){
  if(!assetId) return;
  State.selectedAudioClipId=assetId;
  State.selectedClipId=null;
  State.selectedId=null; State.selectedIds=[];
  refreshSelectionUI();
  const status=$('stSel'); if(status) status.textContent='已選音訊：'+(label||'音訊素材');
}
function runExternalAudioMenuAction(method,args=[],{clearSelection=false}={}){
  const fn=Media?.[method];
  if(typeof fn!=='function') { showToast('音訊素材編輯功能尚未準備完成'); return; }
  let result;
  try{ result=fn.apply(Media,args); }
  catch(err){ console.warn('external audio '+method+':',err); showToast('無法更新音訊素材'); return; }
  Promise.resolve(result).then(value=>{
    if(value===false||value==null) return;
    if(clearSelection) State.selectedAudioClipId=null;
    drawTimeline(); emit('render:videoSub'); emit('mpv:refreshSubs');
  }).catch(err=>{
    console.warn('external audio '+method+':',err);
    showToast('無法更新音訊素材');
  });
}
/* 時間軸區塊右鍵 / 空白軌道區右鍵 */
tlScroll.addEventListener('contextmenu',e=>{
  /* 音訊素材區塊：一個檔案／來源一列。這裡只決定該素材要監看 MIX 還是哪個來源聲道；
     專案輸出 bus 的配線與 M/S/音量都在各自的工具中，不能混為同一件事。 */
  const audioEl=e.target.closest('.audio-clip-block');
  if(audioEl){
    e.preventDefault();
    const isExternal=audioEl.dataset.audioKind==='external';
    const assetId=audioEl.dataset.audioAssetId||audioEl.dataset.audioSourceId||audioEl.dataset.audioSrc||'';
    const sourceId=audioEl.dataset.audioSourceId||audioEl.dataset.sourceId||'';
    const sourceName=(audioEl.dataset.audioSourceName||audioEl.querySelector('.audio-clip-label')?.textContent||'音訊素材')
      .trim().replace(/^[🔊🎵🔇]\s*/u,'');
    if(isExternal) selectExternalAudioForMenu(assetId,sourceName);
    const rawOptions=typeof Wave.getSourceWaveOptions==='function' ? Wave.getSourceWaveOptions(sourceId) : [];
    const selected=typeof Wave.getSourceWaveSelection==='function' ? Wave.getSourceWaveSelection(sourceId) : 'mix';
    const options=(Array.isArray(rawOptions)?rawOptions:[]).map((item,index)=>{
      if(typeof item==='string') return {selection:item,label:item==='mix'?'MIX（所有聲道）':item};
      const selection=item?.selection??item?.id??item?.value??(index===0?'mix':'');
      return {selection:String(selection),label:item?.label||(selection==='mix'?'MIX（所有聲道）':String(selection)),ready:item?.ready!==false};
    }).filter(item=>item.selection);
    const items=[{heading:true,label:(isExternal?'🎵 ':'🔊 ')+sourceName}];
    if(isExternal){
      const start=Math.max(0,Number(audioEl.dataset.audioStart)||0);
      const end=Math.max(start,Number(audioEl.dataset.audioEnd)||start);
      const playhead=Media.displayTime();
      const enabled=audioEl.dataset.audioEnabled!=='false';
      if(playhead>start+0.0001&&playhead<end-0.0001){
        items.push({label:'✂ 在播放點切割',act:()=>runExternalAudioMenuAction('splitExternalAudio',[assetId,playhead])});
      }
      items.push({label:'⏱ 播放頭移到音檔開頭',act:()=>{ Media.seek(start); emit('playhead:ensure'); }});
      items.push({label:enabled?'🔇 關閉此音檔聲音':'🔊 開啟此音檔聲音',act:()=>runExternalAudioMenuAction('toggleExternalAudioEnabled',[assetId])});
      items.push({label:'🗑 從時間軸移除音檔',act:()=>runExternalAudioMenuAction('removeExternalAudio',[assetId],{clearSelection:true})});
      items.push({sep:true});
    }
    if(!options.length){
      items.push({label:'波形正在準備中…'});
    }else{
      items.push({heading:true,label:'顯示此素材的波形'});
      for(const option of options){
        const label=option.ready?option.label:`${option.label}（準備中）`;
        items.push({label,checked:String(selected||'mix')===option.selection,act:()=>{
          const changed=Wave.setSourceWaveSelection?.(sourceId,option.selection);
          Promise.resolve(changed).then(()=>drawTimeline()).catch(err=>{
            console.warn('source wave selection:',err);
            showToast('無法載入此聲道的波形');
          });
        }});
      }
    }
    showCtx(e.clientX,e.clientY,items);
    return;
  }
  /* 影片序列區塊右鍵 */
  const clipEl=e.target.closest('.clip-block');
  if(clipEl){
    e.preventDefault();
    const c=Seq.byId(clipEl.dataset.clipId); if(!c)return;
    const isLocked = State.videoTracks[c.vtrack||0]?.locked;
    if(!isLocked) selectClip(c.id); // 右鍵即選取（高亮，之後可直接 Del / 上下鍵切換）

    const items = isLocked ? [{label:'🔒 此視訊軌已鎖定'}] : [{heading:true,label:'🎬 '+c.name}];
    
    if(!isLocked){
      const trimmed=c.in>0.01||c.out<c.dur-0.01;
      // 播放頭在此段內 → 可就地切割（等同 Ctrl+K）
      const pt=Media.displayTime();
      if(Seq.clipAt(pt)===c) items.push({label:'✂ 在播放點切割（Ctrl+K）',act:()=>{ Media.splitClipAt(pt); }});
      if(c.audioDetached) items.push({label:'🔇 此影片原音已解除連結'});
      else items.push({label:'🔗✂ 解除影音連結',act:()=>{ void Media.detachClipAudio?.(c.id); }});
      items.push({label:'⏱ 播放頭移到此段開頭',act:()=>{ Media.seek(c.offset); emit('playhead:ensure'); }});
      // 移到上／下一層視訊軌（多軌疊層：上層覆蓋下層）
      const moveTrack=(dv)=>{
        const tv=(c.vtrack||0)+dv;
        if(State.videoTracks[tv]?.locked){ showToast('目標視訊軌已鎖定，無法移入'); return; }
        Seq.moveToTrack(c, tv);
        recordHistory('影片段移到 V'+((c.vtrack||0)+1));
        Media.seek(Math.min(Media.displayTime(), State.duration||0));
        drawTimeline(); emit('render:videoSub'); emit('mpv:refreshSubs');
      };
      items.push({label:`⬆ 移到上層視訊軌（V${(c.vtrack||0)+2}）`,act:()=>moveTrack(1)});
      if((c.vtrack||0)>0) items.push({label:`⬇ 移到下層視訊軌（V${(c.vtrack||0)}）`,act:()=>moveTrack(-1)});
      items.push({label:`🎞 淡入淡出（轉場）${(c.fadeIn>0||c.fadeOut>0)?' ✓':''}…`,act:()=>showClipFade(c)});
      items.push({label:`🔀 與前一段交叉溶接…`,act:()=>showCrossfade(c)});
      // 相鄰段交換（同一視訊軌內、依時間軸順序；保留兩段之間的間距）
      const sorted=Seq.trackClips(c.vtrack||0).sort((a,b)=>a.offset-b.offset);
      const idx=sorted.indexOf(c);
      const swap=(a,b)=>{ // a=前段 b=後段
        const gap=b.offset-Seq.clipEnd(a), start=a.offset;
        b.offset=start; a.offset=start+Seq.len(b)+gap;
        Seq.sort(); Seq.recomputeDuration();
        recordHistory('影片段交換');
        Media.seek(Math.min(Media.displayTime(), State.duration||0));
        drawTimeline(); emit('render:videoSub'); emit('mpv:refreshSubs');
      };
      if(idx>0) items.push({label:'◀ 與前一段交換（同軌）',act:()=>swap(sorted[idx-1], c)});
      if(idx<sorted.length-1) items.push({label:'▶ 與後一段交換（同軌）',act:()=>swap(c, sorted[idx+1])});
      if(trimmed) items.push({label:'↺ 重設修剪（還原完整長度）',act:()=>{
        const save={in:c.in,out:c.out};
        c.in=0; c.out=c.dur;
        const ov=State.clips.some(o=>o!==c && o.offset < Seq.clipEnd(c) - 1e-6 && Seq.clipEnd(o) > c.offset + 1e-6);
        if(ov){ c.in=save.in; c.out=save.out; showToast('還原完整長度會與相鄰影片重疊，請先移開再重設'); return; }
        Seq.recomputeDuration(); recordHistory('重設修剪：'+c.name); drawTimeline();
      }});
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
