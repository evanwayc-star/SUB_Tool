/* ==============================================================================
   SUB Tool — 右鍵選單與互動對話框 ("src/menus.js")
   ============================================================================== */
import { $, video, tlScroll, tlLayer } from './dom.js';
import { escapeHTML } from './util.js';
import { State, isSel, setSelection, deselect, IS_DESKTOP } from './state.js';
import { Media, Wave } from './media.js';
import { selectCue, refreshSelectionUI, enterSwapMode, deleteSelected } from './subtitles.js';
import { addCue, addCueRelative, clearSelectedCuesTime, shiftTextsDown, shiftTextsUp, swapAdjacentCues, mergeAdjacentCues, copyCues, pasteCues } from './subtitle-model.js';
import { moveSelectedToTrack, trackFromY, tracksTop, drawTimeline } from './timeline-renderer.js';
import { xToTime } from './timeline-interaction-engine.js';
import { selectClip, fitClipToStage, crossfadeWithPrev } from './clip-model.js';
import { Seq } from './sequence.js';
import { showToast, promptModal, openModal, closeModal } from './ui.js';
import { secToEncore } from './time.js';
import { parseTimecodeInput, setupTimecodeInput } from './tcparse.js';
import { recordHistory } from './history.js';
import { emit } from './events.js';
import { AudioRouting } from './audio-routing.js';
import { setManualPlaybackSpeed } from './keyboard.js';
import { splitMenuLabel } from './menu-label.js';
import { copySelectedStyle, pasteStyleToSelected, hasClipboardStyle } from './subtitles.js';
import { openSpeechRecognitionDialog } from './speech-recognition.js';
import { openHardLimiterDialog } from './audio-normalizer-dialog.js';
import { requestPointerSeek } from './timeline-interaction-engine.js';
import {
  buildAudioClipMenu,
  buildAudioTrackMenu,
  buildVideoClipMenu,
  normalizeWaveOptions,
} from './timeline-context-menu-model.js';

/* ===== 右鍵選單 ===== */
const ctx=$('ctxmenu');
function hideCtx(){
  const was=ctx.classList.contains('show');
  ctx.classList.remove('show'); ctx.innerHTML='';
  if(was) { window._ctxOpen=false; emit('mpv:sync'); emit('render:videoSub'); } // 選單若曾讓 mpv 讓位，關閉時恢復（僅在真的有開過才發，避免每次 mousedown 都打 IPC）
}
function showCtx(x,y,items){
  ctx.innerHTML='';
  for(const it of items){
    let d;
    if(it.sep){ d=document.createElement('div'); d.className='msep'; }
    else if(it.heading){ d=document.createElement('div'); d.className='lbl'; d.textContent=it.label; }
    else if(it.note){
      d=document.createElement('div'); d.className='ctx-note'+(it.tone?' '+it.tone:''); d.setAttribute('role','status');
      const { icon, text } = splitMenuLabel(it.label);
      d.innerHTML=`<span class="c-icon">${icon}</span><span class="c-text">${escapeHTML(text)}</span>`;
    }
    else { d=document.createElement('div'); d.className='ci'; d.setAttribute('role','menuitem');
      const { icon, text } = splitMenuLabel(it.label);
      d.innerHTML=`<span class="c-icon">${icon}</span><span class="c-text">${escapeHTML(text)}</span>`+(it.checked?'<span class="chk">✓</span>':'');
      if(typeof it.act==='function') d.onclick=()=>{ hideCtx(); it.act(); };
      else { d.classList.add('disabled'); d.setAttribute('aria-disabled','true'); }
    }
    if(it.id) d.dataset.menuId=it.id;
    ctx.appendChild(d);
  }
  ctx.setAttribute('role','menu');
  ctx.classList.add('show');
  const w=ctx.offsetWidth,h=ctx.offsetHeight;
  ctx.style.left=Math.max(6,Math.min(x,window.innerWidth-w-6))+'px';
  ctx.style.top=Math.max(6,Math.min(y,window.innerHeight-h-6))+'px';
  window._ctxOpen=true;
  emit('mpv:sync'); // 定位完成後重算：選單若與影片重疊，讓 mpv 讓位（否則 mpv 為 OS 子視窗會蓋住選單）
  emit('render:videoSub');
}
if (typeof document !== 'undefined') {
  document.addEventListener('mousedown',e=>{ if(e.button===2)return; if(ctx && !ctx.contains(e.target))hideCtx(); },true);
  window.addEventListener('blur',hideCtx);
  window.addEventListener('resize',hideCtx);
}

/* 播放窗右鍵：播放速度。音訊素材波形改由時間軸素材區塊右鍵選擇，
   不能再用這裡切換唯一音源，否則會破壞專案 A bus 的混音。 */
function formatPlaybackRate(rate){ return (Math.round(rate * 100) / 100).toString() + 'x'; }
function setPlayerSpeed(rate){
  const value=Math.round(Number(rate)*100)/100;
  if(!Number.isFinite(value)||value<0.1||value>16){ showToast('播放速度需介於 0.1 和 16 之間'); return false; }
  setManualPlaybackSpeed(value);
  showToast('播放速度：'+formatPlaybackRate(value));
  return true;
}
async function setCustomPlayerSpeed(){
  const raw=await promptModal(
    '自訂播放速度',
    '輸入播放速度（0.1–16）',
    String(video.playbackRate||1),
    { placeholder:'例如 0.75、1.25 或 2', okLabel:'套用' }
  );
  if(raw==null) return;
  const value=Number(String(raw).replace(/[x×\s]/gi,''));
  setPlayerSpeed(value);
}
function showPlayerMenu(x,y){
  const items=[{heading:true,label:'播放速度'}];
  [0.25,0.5,0.75,1,1.25,1.5,2].forEach(r=>items.push({label:r+'×',
    checked:Math.abs((video.playbackRate||1)-r)<0.001,act:()=>setPlayerSpeed(r)}));
  items.push({sep:true},{label:'自訂速度…',act:setCustomPlayerSpeed});
  showCtx(x,y,items);
}
$('videoWrap')?.addEventListener('contextmenu',e=>{ e.preventDefault(); });
$('speedIndicator')?.addEventListener('contextmenu',e=>{ e.preventDefault(); e.stopPropagation(); showPlayerMenu(e.clientX,e.clientY); });

/* 字幕右鍵：移到軌道 / 上下新增 / 刪除 */
function showCueMenu(x,y){
  const n=State.selectedIds.length||(State.selectedId?1:0);
  const items=[{heading:true,label:`已選 ${n} 條字幕`}];
  items.push({label:`複製 ${n} 條字幕`,act:()=>copyCues()});
  if(State.clipboard?.length) items.push({label:`貼上 ${State.clipboard.length} 條字幕`,act:()=>pasteCues()});
  items.push({sep:true});
  items.push({label:`<svg viewBox="0 0 512 512" width="13" height="13" fill="currentColor" style="vertical-align:-2px"><path d="M204.3 5C104.9 24.4 24.8 104.3 5.2 203.4c-37 187 131.7 326.4 258.8 306.7 41.2-6.4 61.4-54.6 42.5-91.7-23.1-45.4 9.9-98.4 60.5-98.4h79.7c75.8 0 137.2-61.4 137.2-137.2 0-97-75.1-177.3-172-181.7-68.5-3.1-135.5-2.6-207.6 3.9zM104 224c-22.1 0-40-17.9-40-40s17.9-40 40-40 40 17.9 40 40-17.9 40-40 40zm104-72c-22.1 0-40-17.9-40-40s17.9-40 40-40 40 17.9 40 40-17.9 40-40 40zm128 0c-22.1 0-40-17.9-40-40s17.9-40 40-40 40 17.9 40 40-17.9 40-40 40zm88 96c-22.1 0-40-17.9-40-40s17.9-40 40-40 40 17.9 40 40-17.9 40-40 40z"/></svg> 拷貝樣式`,act:()=>copySelectedStyle()});
  if(hasClipboardStyle()) items.push({label:`<svg viewBox="0 0 384 512" width="13" height="13" fill="currentColor" style="vertical-align:-2px"><path d="M336 64h-80c0-35.3-28.7-64-64-64s-64 28.7-64 64H48C21.5 64 0 85.5 0 112v352c0 26.5 21.5 48 48 48h288c26.5 0 48-21.5 48-48V112c0-26.5-21.5-48-48-48zM192 40c13.3 0 24 10.7 24 24s-10.7 24-24 24-24-10.7-24-24 10.7-24 24-24zm144 418c0 3.3-2.7 6-6 6H54c-3.3 0-6-2.7-6-6V118c0-3.3 2.7-6 6-6h42v36c0 6.6 5.4 12 12 12h168c6.6 0 12-5.4 12-12v-36h42c3.3 0 6 2.7 6 6v340z"/></svg> 貼上樣式`,act:()=>pasteStyleToSelected()});
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
          setSelection({ kind:'sub', ids, primary:_c.id }); State.activeEdge='start';
          refreshSelectionUI();
        }}); addedSel=true;
      }
      if(_i>=0 && _i<_list.length-1){
        items.push({label:'⬇ 將以下字幕選取',act:()=>{
          const ids=_list.slice(_i).map(c=>c.id);
          setSelection({ kind:'sub', ids, primary:_c.id }); State.activeEdge='start';
          refreshSelectionUI();
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
  setSelection({ kind:'audio', ids:assetId });
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
    if(clearSelection) deselect('audio');
    drawTimeline(); emit('render:videoSub'); emit('mpv:refreshSubs');
  }).catch(err=>{
    console.warn('external audio '+method+':',err);
    showToast('無法更新音訊素材');
  });
}

function clipSourcePath(clip){
  if(typeof clip?.path==='string'&&clip.path) return clip.path;
  return clip?.primary&&typeof State.mediaPath==='string'&&State.mediaPath ? State.mediaPath : null;
}

function revealSourceInFolder(filePath){
  if(!IS_DESKTOP||!filePath) return;
  Promise.resolve(window.subtool?.showSourceInFolder?.(filePath)).catch(err=>{
    console.warn(err);
    showToast('無法顯示檔案位置');
  });
}

function sourceIdMatches(source, sourceId){
  if(!source||!sourceId) return false;
  return [source.id,source.audioSourceId,source.audioSrc,source.timelineLaneId]
    .some(value=>value!=null&&String(value)===String(sourceId));
}

function audioMenuContext(audioEl){
  const declaredExternal=audioEl.dataset.audioKind==='external';
  const assetId=audioEl.dataset.audioAssetId||'';
  const sourceId=audioEl.dataset.audioSourceId||audioEl.dataset.sourceId||'';
  const clipId=audioEl.dataset.clipId||'';
  let source=null;
  if(declaredExternal||assetId){
    source=Media.getExternalAudioSource?.(assetId||sourceId)
      || State.externalAudioState?.find(item=>sourceIdMatches(item,assetId||sourceId))
      || null;
  }else{
    source=State.clips?.find(item=>item.id===clipId)
      || State.clips?.find(item=>sourceIdMatches(item,sourceId))
      || null;
  }
  const external=declaredExternal||source?.kind==='external-audio';
  const runtimeSourceId=audioEl.dataset.audioSrc||source?.audioSrc||sourceId;
  const sourceName=(audioEl.dataset.audioSourceName||source?.name||audioEl.querySelector('.audio-clip-label')?.textContent||'音訊素材')
    .trim().replace(/^[🔊🎵🔇]\s*/u,'');
  return {
    source,
    external,
    assetId:assetId||source?.id||sourceId,
    sourceId:sourceId||source?.audioSourceId||source?.audioSrc||'',
    runtimeSourceId,
    sourceName,
    filePath:clipSourcePath(source),
    locked:source?.locked===true,
  };
}

function sourceWaveMenuState(sourceId){
  const rawOptions=typeof Wave.getSourceWaveOptions==='function' ? Wave.getSourceWaveOptions(sourceId) : [];
  const selected=typeof Wave.getSourceWaveSelection==='function' ? Wave.getSourceWaveSelection(sourceId) : 'mix';
  return {options:normalizeWaveOptions(rawOptions),selected};
}

function selectSourceWave(sourceId,selection){
  const changed=Wave.setSourceWaveSelection?.(sourceId,selection);
  Promise.resolve(changed).then(()=>drawTimeline()).catch(err=>{
    console.warn('source wave selection:',err);
    showToast('無法載入此聲道的波形');
  });
}
/* 時間軸區塊右鍵 / 空白軌道區右鍵 */
tlScroll?.addEventListener?.('contextmenu', tlContextMenuHandler);
tlLayer?.addEventListener?.('contextmenu', tlContextMenuHandler);
$('tlAtracks')?.addEventListener?.('contextmenu', tlContextMenuHandler);
$('tlGutterAtracks')?.addEventListener?.('contextmenu', tlContextMenuHandler);

function tlContextMenuHandler(e){
  /* 音訊素材區塊：一個檔案／來源一列。這裡只決定該素材要監看 MIX 還是哪個來源聲道；
     專案輸出 bus 的配線與 M/S/音量都在各自的工具中，不能混為同一件事。 */
  const audioEl=e.target.closest('.audio-clip-block');
  if(audioEl){
    e.preventDefault();
    const context=audioMenuContext(audioEl);
    const {source,external,assetId,sourceId,runtimeSourceId,sourceName,filePath,locked}=context;
    if(external) selectExternalAudioForMenu(assetId,sourceName);
    const recognitionTracks=typeof Media.sourceChannels==='function' ? Media.sourceChannels(runtimeSourceId) : [];
    const start=Math.max(0,Number(audioEl.dataset.audioStart)||0);
    const end=Math.max(start,Number(audioEl.dataset.audioEnd)||start);
    const playhead=Media.displayTime();
    const enabled=source?.enabled!==false&&audioEl.dataset.audioEnabled!=='false';
    const wave=sourceWaveMenuState(sourceId);
    const recognitionSource=source ? {...source,recognitionTracks} : {
      id:external?assetId:'primary-audio',
      name:sourceName||State.mediaName||'主要音訊',
      in:external?start:0,
      out:external?end:State.duration,
      dur:external?Math.max(0,end-start):State.duration,
      offset:external?start:0,
      primary:!external,
      path:filePath||State.mediaPath||State.clips?.[0]?.path||null,
      blob:State.mediaFile||State.mediaBlob||State.clips?.[0]?.blob||null,
      recognitionTracks,
    };
    const resolvedTarget = external
      ? (Media.externalAudio?.find?.(assetId) || (State.externalAudioState || []).find(a => a.id === assetId))
      : (source || State.clips?.find(c => c.id === assetId || c.primary || c.audioSrc === 'video') || State.clips?.[0]);
    const hasLimiter = Boolean(resolvedTarget?.hasAudioLimiter || audioEl.classList.contains('has-limiter'));
    const limiterLabel = resolvedTarget?.audioLimiterLabel || '';
    const items=buildAudioClipMenu({
      name:sourceName,
      external,
      locked,
      canReveal:IS_DESKTOP&&!!filePath,
      canSplit:external&&playhead>start+0.0001&&playhead<end-0.0001,
      enabled,
      waveOptions:wave.options,
      selectedWave:wave.selected,
      hasLimiter,
      limiterLabel,
    },{
      revealSource:()=>revealSourceInFolder(filePath),
      openSpeechRecognition:()=>openSpeechRecognitionDialog(recognitionSource),
      openHardLimiter:()=>openHardLimiterDialog({
        id:assetId,
        path:filePath,
        name:sourceName,
        duration:end-start,
        asset:external ? resolvedTarget : null,
        target:resolvedTarget,
        isPrimary:!external,
      }),
      seekStart:()=>{ requestPointerSeek(start); emit('playhead:ensure'); },
      splitAtPlayhead:()=>runExternalAudioMenuAction('splitExternalAudio',[assetId,playhead]),
      toggleAudio:()=>runExternalAudioMenuAction('toggleExternalAudioEnabled',[assetId]),
      openAudioRouting:()=>AudioRouting.openForSource(sourceId),
      selectWave:selection=>selectSourceWave(sourceId,selection),
      removeAudio:()=>runExternalAudioMenuAction('removeExternalAudio',[assetId],{clearSelection:true}),
    });
    showCtx(e.clientX,e.clientY,items);
    return;
  }
  
  /* 音訊軌道空白處或標頭右鍵 */
  const audioRow=e.target.closest('.audio-project-row, .agtrack, .tl-source');
  if(audioRow && audioRow.dataset.audioSourceId){
    e.preventDefault();
    const context=audioMenuContext(audioRow);
    const {sourceId,sourceName,filePath,external,locked}=context;
    const wave=sourceWaveMenuState(sourceId);
    const resolvedTrackTarget = external
      ? (Media.externalAudio?.find?.(sourceId) || (State.externalAudioState || []).find(a => a.id === sourceId))
      : (State.clips?.find(c => c.primary || c.audioSrc === 'video' || c.id === sourceId) || State.clips?.[0]);
    const hasLimiter = Boolean(resolvedTrackTarget?.hasAudioLimiter);
    const limiterLabel = resolvedTrackTarget?.audioLimiterLabel || '';
    const items=buildAudioTrackMenu({
      name:sourceName,
      external,
      locked,
      canReveal:IS_DESKTOP&&!!filePath,
      waveOptions:wave.options,
      selectedWave:wave.selected,
      hasLimiter,
      limiterLabel,
    },{
      revealSource:()=>revealSourceInFolder(filePath),
      openHardLimiter:()=>openHardLimiterDialog({
        id:sourceId,
        path:filePath,
        name:sourceName,
        asset:external ? resolvedTrackTarget : null,
        target:resolvedTrackTarget,
        isPrimary:!external,
      }),
      openAudioRouting:()=>AudioRouting.openForSource(sourceId),
      selectWave:selection=>selectSourceWave(sourceId,selection),
    });
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
    const isImg = c.type==='image';
    const trimmed=c.in>0.01||c.out<c.dur-0.01;
    const pt=Media.displayTime();
    const filePath=clipSourcePath(c);
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
    const moveTrack=(dv)=>{
      const tv=(c.vtrack||0)+dv;
      if(State.videoTracks[tv]?.locked){ showToast('目標視訊軌已鎖定，無法移入'); return; }
      Seq.moveToTrack(c, tv);
      recordHistory('影片段移到 V'+((c.vtrack||0)+1));
      Media.seek(Math.min(Media.displayTime(), State.duration||0));
      drawTimeline(); emit('render:videoSub'); emit('mpv:refreshSubs');
    };
    const resetTrim=()=>{
      const save={in:c.in,out:c.out};
      c.in=0; c.out=c.dur;
      const overlaps=State.clips.some(other=>other!==c&&other.offset<Seq.clipEnd(c)-1e-6&&Seq.clipEnd(other)>c.offset+1e-6);
      if(overlaps){ c.in=save.in; c.out=save.out; showToast('還原完整長度會與相鄰影片重疊，請先移開再重設'); return; }
      Seq.recomputeDuration(); recordHistory('重設修剪：'+c.name); drawTimeline();
    };
    const items=buildVideoClipMenu({
      name:c.name,
      isImage:isImg,
      locked:isLocked,
      canReveal:IS_DESKTOP&&!!filePath,
      canSplit:Seq.clipAt(pt)===c,
      trimmed,
      audioDetached:!!c.audioDetached,
      trackIndex:c.vtrack||0,
      hasPrevious:idx>0,
      hasNext:idx>=0&&idx<sorted.length-1,
      hasFade:c.fadeIn>0||c.fadeOut>0,
      hasLimiter:Boolean(c.hasAudioLimiter),
      limiterLabel:c.audioLimiterLabel||'',
    },{
      revealSource:()=>revealSourceInFolder(filePath),
      seekStart:()=>{ requestPointerSeek(c.offset); emit('playhead:ensure'); },
      splitAtPlayhead:()=>{ Media.splitClipAt(pt); },
      editDuration:()=>showClipDuration(c),
      editGeometry:()=>showImageGeom(c),
      resetTrim,
      detachAudio:()=>{ void Media.detachClipAudio?.(c.id); },
      openHardLimiter:()=>openHardLimiterDialog({
        id:c.id,
        path:filePath,
        name:c.name,
        duration:c.dur,
        isPrimary:true,
      }),
      openAudioRouting:()=>AudioRouting.openForClip(c.id),
      moveTrackUp:()=>moveTrack(1),
      moveTrackDown:()=>moveTrack(-1),
      swapPrevious:()=>swap(sorted[idx-1],c),
      swapNext:()=>swap(c,sorted[idx+1]),
      editFade:()=>showClipFade(c),
      editCrossfade:()=>showCrossfade(c),
      removeClip:()=>{
        if(Media.removeClip(c.id)){ recordHistory('移除影片段：'+c.name); drawTimeline(); }
      },
    });
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
      addCue(t,t+1,'',tk,{ historyLabel:'右鍵新增字幕' });
    }}]);
    return;
  }
  e.preventDefault();
  if(!isSel(block.dataset.id))selectCue(block.dataset.id);
  else { setSelection({ kind:'sub', ids:State.selectedIds, primary:block.dataset.id }); refreshSelectionUI(); }
  showCueMenu(e.clientX,e.clientY);
}

/* 動作分派 */

/* ==============================================================================
   視訊片段設定與轉場互動對話框 (Clip View Modals)
   ============================================================================== */

export function showImageGeom(c){
  if(!c) return;
  if(State.videoTracks[c.vtrack||0]?.locked){ showToast('此視訊軌已鎖定'); return; }
  const S=Math.round((c.scale??1)*100), X=Math.round((c.posX??0.5)*100), Y=Math.round((c.posY??0.5)*100);
  const row=(id,label,val,min,max,unit)=>
    `<div>${label}：<input type="range" id="ig${id}R" min="${min}" max="${max}" step="1" value="${val}" style="width:180px;vertical-align:middle">`+
    ` <input type="number" id="ig${id}" min="${min}" max="${max}" step="1" value="${val}" style="width:64px">${unit}</div>`;
  const snap={ scale:c.scale??1, posX:c.posX??0.5, posY:c.posY??0.5 };
  const restore=()=>{ c.scale=snap.scale; c.posX=snap.posX; c.posY=snap.posY;
    emit('media:timeline'); emit('render:videoSub'); };
  const commit=label=>{ closeModal({committed:true}); emit('media:timeline'); emit('render:videoSub'); recordHistory(label); };
  const syncInputs=()=>{
    const set=(id,val)=>{ const r=$('ig'+id+'R'), n=$('ig'+id); if(r)r.value=val; if(n)n.value=val; };
    set('S',Math.round((c.scale??1)*100)); set('X',Math.round((c.posX??0.5)*100)); set('Y',Math.round((c.posY??0.5)*100));
  };
  openModal(`${c.type==='image'?'圖片':'影片'}大小與位置 — ${escapeHTML(c.name||'')}`,
    `<div style="font-size:13px;line-height:2.2">`+
    row('S','大小',S,2,800,'%')+row('X','水平位置',X,0,100,'%')+row('Y','垂直位置',Y,0,100,'%')+
    `<div style="color:var(--text-faint);font-size:12px;margin-top:8px">`+
    `大小＝素材框佔軌影格的比例（素材依原始比例縮入該框）；位置＝素材<b>中心</b>在影格上的座標。`+
    `${c.natW>0?`原始尺寸 ${c.natW}×${c.natH}。`:''}預覽與匯出使用同一組數值。<br>`+
    `<b>符合視窗</b>＝維持目前位置，等比例放大到上下左右最先碰到的那個邊界為止。</div>`+
    `</div>`,
    [{label:'符合視窗',act:()=>{ fitClipToStage(c); syncInputs(); emit('render:videoSub'); }},
     {label:'重設',act:()=>{ c.scale=1; c.posX=0.5; c.posY=0.5; commit('重設大小與位置：'+(c.name||'')); }},
     {label:'取消',act:()=>{ closeModal(); }},
     {label:'套用',primary:true,act:()=>{
        const v=(id,d)=>{ const n=+($(('ig'+id))?.value); return Number.isFinite(n)?n:d; };
        c.scale=Math.max(0.02,Math.min(8, v('S',S)/100));
        c.posX =Math.max(0,Math.min(1, v('X',X)/100));
        c.posY =Math.max(0,Math.min(1, v('Y',Y)/100));
        commit('大小與位置：'+(c.name||''));
     }}],
    { onDismiss:restore });
  setTimeout(()=>{
    for(const id of ['S','X','Y']){
      const r=$('ig'+id+'R'), n=$('ig'+id); if(!r||!n) continue;
      const live=()=>{ const val=+n.value;
        if(id==='S') c.scale=Math.max(0.02,Math.min(8,val/100));
        else if(id==='X') c.posX=Math.max(0,Math.min(1,val/100));
        else c.posY=Math.max(0,Math.min(1,val/100));
        emit('render:videoSub'); };
      r.oninput=()=>{ n.value=r.value; live(); };
      n.oninput=()=>{ r.value=n.value; live(); };
    }
  },0);
}

export function showClipFade(c){
  if(!c) return;
  const len=Math.max(0.1, Seq.len(c));
  const maxF=Math.max(0.1, +len.toFixed(1));
  const fi=Math.min(+(c.fadeIn||0), maxF), fo=Math.min(+(c.fadeOut||0), maxF);
  openModal(`淡入淡出（轉場）— ${escapeHTML(c.name||'')}`,
    `<div style="font-size:13px;line-height:2.2">`+
    `<div>淡入：<input type="range" id="cfIn" min="0" max="${maxF}" step="0.001" value="${fi}" style="width:180px;vertical-align:middle"> <input type="text" id="cfInV" value="${secToEncore(fi, State.fps, State.dropFrame)}" style="width:100px;background:var(--bg-b);color:var(--text);border:1px solid var(--border);padding:2px 4px;border-radius:3px;text-align:center"></div>`+
    `<div>淡出：<input type="range" id="cfOut" min="0" max="${maxF}" step="0.001" value="${fo}" style="width:180px;vertical-align:middle"> <input type="text" id="cfOutV" value="${secToEncore(fo, State.fps, State.dropFrame)}" style="width:100px;background:var(--bg-b);color:var(--text);border:1px solid var(--border);padding:2px 4px;border-radius:3px;text-align:center"></div>`+
    `<div style="color:var(--text-faint);font-size:12px;margin-top:8px">淡入從透明漸顯、淡出漸隱到透明（露出下層／黑底），音訊同步淡變。<b>匯出時生效</b>。若此片段在上層視訊軌且與下層重疊，淡變即為<b>軌間溶接</b>。</div>`+
    `</div>`,
    [{label:'清除',act:()=>{ c.fadeIn=0; c.fadeOut=0; closeModal(); emit('media:timeline'); recordHistory('清除轉場：'+(c.name||'')); }},
     {label:'套用',primary:true,act:()=>{
        let vi = parseTimecodeInput($('cfInV').value);
        if(vi===null) vi = parseFloat($('cfInV').value);
        if(isNaN(vi)) vi = +$('cfIn').value;

        let vo = parseTimecodeInput($('cfOutV').value);
        if(vo===null) vo = parseFloat($('cfOutV').value);
        if(isNaN(vo)) vo = +$('cfOut').value;

        c.fadeIn=Math.max(0,Math.min(maxF,vi)); c.fadeOut=Math.max(0,Math.min(maxF,vo));
        closeModal(); emit('media:timeline'); recordHistory('轉場：'+(c.name||''));
     }}]);
  setTimeout(()=>{
    const a=$('cfIn'), b=$('cfOut'), aV=$('cfInV'), bV=$('cfOutV');
    if(aV) setupTimecodeInput(aV);
    if(bV) setupTimecodeInput(bV);
    if(a) a.oninput=()=>{ if(aV) aV.value=secToEncore(+a.value, State.fps, State.dropFrame); };
    if(b) b.oninput=()=>{ if(bV) bV.value=secToEncore(+b.value, State.fps, State.dropFrame); };
    if(aV) aV.onchange=()=>{
        let v = parseTimecodeInput(aV.value);
        if(v===null) v = parseFloat(aV.value);
        if(!isNaN(v)) { a.value = Math.max(0, Math.min(maxF, v)); aV.value = secToEncore(+a.value, State.fps, State.dropFrame); }
    };
    if(bV) bV.onchange=()=>{
        let v = parseTimecodeInput(bV.value);
        if(v===null) v = parseFloat(bV.value);
        if(!isNaN(v)) { b.value = Math.max(0, Math.min(maxF, v)); bV.value = secToEncore(+b.value, State.fps, State.dropFrame); }
    };
  },0);
}

export function showClipDuration(c){
  if(!c) return;
  if(State.videoTracks[c.vtrack||0]?.locked){ showToast('此視訊軌已鎖定'); return; }
  const isImg = c.type === 'image';
  const cur = Seq.len(c);
  const maxBySource = Math.max(0.001, (+c.dur || 0) - (+c.in || 0));
  const maxByNeighbor = Seq.maxLengthOnTrack(c);
  const maxLen = Math.min(maxBySource, maxByNeighbor);
  const limitNote = maxByNeighbor < maxBySource
    ? '（受同軌下一段起點限制）'
    : (isImg ? '（圖片可自由延長）' : '（受來源素材長度限制）');

  openModal(`修改持續時間 — ${escapeHTML(c.name||'')}`,
    `<div style="font-size:13px;line-height:2.2">`+
    `<div>持續時間：<input type="text" id="cdVal" value="${secToEncore(cur, State.fps, State.dropFrame)}" `+
    `style="width:120px;background:var(--bg-b);color:var(--text);border:1px solid var(--border);padding:3px 4px;border-radius:3px;text-align:center;font-family:'Cascadia Mono','JetBrains Mono',Consolas,monospace"></div>`+
    `<div style="color:var(--text-faint);font-size:12px;margin-top:8px">`+
    `最長 <b>${secToEncore(Math.min(maxLen, 359999.9), State.fps, State.dropFrame)}</b> ${limitNote}<br>`+
    `可直接輸入時碼，或用上下方向鍵微調。起點不變，只調整這一段播多久。</div>`+
    `</div>`,
    [{label:'取消',act:()=>{ closeModal(); }},
     {label:'套用',primary:true,act:()=>{
        let v = parseTimecodeInput($('cdVal').value);
        if(v===null) v = parseFloat($('cdVal').value);
        if(!Number.isFinite(v) || v<=0){ showToast('請輸入有效的持續時間'); return; }
        const clamped = Math.min(v, maxLen);
        c.out = (+c.in || 0) + clamped;
        Seq.recomputeDuration();
        closeModal({committed:true});
        Media.seek(Math.min(Media.displayTime(), State.duration||0));
        emit('media:timeline'); emit('render:videoSub'); emit('mpv:refreshSubs');
        recordHistory('修改持續時間：'+(c.name||''));
        if(clamped < v - 1e-6) showToast(`已設為可用的最長 ${secToEncore(clamped, State.fps, State.dropFrame)}${limitNote}`);
     }}]);
  setTimeout(()=>{ const el=$('cdVal'); if(el){ setupTimecodeInput(el); el.focus(); el.select(); } },0);
}

export function showCrossfade(c){
  if(!c) return;
  const prev=Seq.trackClips(c.vtrack||0).filter(x=>x!==c && x.offset < c.offset - 1e-4).sort((a,b)=>b.offset-a.offset)[0] || null;
  if(!prev){ showToast('前面沒有可溶接的片段（同一視訊軌）'); return; }
  const maxT=Math.max(0.2, Math.min(Seq.len(c), Seq.len(prev)));
  const defT=Math.min(1, maxT);
  openModal(`交叉溶接 — ${escapeHTML(prev.name||'')} → ${escapeHTML(c.name||'')}`,
    `<div style="font-size:13px;line-height:2.1">`+
    `<div>溶接時間：<input type="range" id="xfT" min="0.001" max="${maxT.toFixed(3)}" step="0.001" value="${defT}" style="width:180px;vertical-align:middle"> <input type="text" id="xfTV" value="${secToEncore(defT, State.fps, State.dropFrame)}" style="width:100px;background:var(--bg-b);color:var(--text);border:1px solid var(--border);padding:2px 4px;border-radius:3px;text-align:center"></div>`+
    `<div style="color:var(--text-faint);font-size:12px;margin-top:8px">會把此片段移到<b>上一層視訊軌</b>並提前與前一段尾端重疊，兩段在重疊處淡出／淡入＝交叉溶接（匯出時合成）。</div>`+
    `</div>`,
    [{label:'取消',act:closeModal},
     {label:'建立溶接',primary:true,act:()=>{
         let T = parseTimecodeInput($('xfTV').value);
         if(T===null) T = parseFloat($('xfTV').value);
         if(isNaN(T)) T = +$('xfT').value;
         closeModal(); crossfadeWithPrev(c, T);
     }}]);
  setTimeout(()=>{
    const s=$('xfT'), sV=$('xfTV');
    if(sV) setupTimecodeInput(sV);
    if(s) s.oninput=()=>{ if(sV) sV.value=secToEncore(+s.value, State.fps, State.dropFrame); };
    if(sV) sV.onchange=()=>{
        let v = parseTimecodeInput(sV.value);
        if(v===null) v = parseFloat(sV.value);
        if(!isNaN(v)) { s.value = Math.max(0.001, Math.min(maxT, v)); sV.value = secToEncore(+s.value, State.fps, State.dropFrame); }
    };
  },0);
}

export {
  hideCtx,
  showCtx,
  showPlayerMenu,
  showCueMenu,
};
