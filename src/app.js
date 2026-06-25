/* SUB Tool — 協調層 / 進入點（非 hub）
   職責：載入並組裝各模組、訂閱事件匯流排(events.js)、處理影片事件、指令分派(doAction)、
   面板與選單接線、初始化(init/initDesktop)。
   架構重點：其他模組「不再 import app.js」——它們以 emit(...) 發送事件，由本檔以 on(...) 訂閱
   後呼叫對應的渲染/指令函式（renderAll、renderVideoSub、onDurationKnown、doAction… 見下方註冊區）。
   渲染協調函式(renderAll/renderVideoSub/ensurePlayheadVisible…)仍定義於此並供本檔內部直接呼叫。 */
"use strict";
import _logoUrl from './logo.png';
import { clamp, pad, decodeText, encodeUTF16LE, downloadBytes, readFile, pickFile, b64ToBytes, bytesToB64, baseName, escapeHTML } from './util.js';
import { fmtClock, secToSRT, secToASS, secToEncore, srtToSec, assToSec, encoreToSec, snapTimeToFrame } from './time.js';
import { SubFormats, splitN } from './formats.js';
import { $, video, tlScroll, tlLayer, tlTracks, rulerCv, waveCv, sublist } from './dom.js';
import { State, newTrack, syncTrackCount, FPS_SET, snapFps, setFps, ensureTrackCount, trackVisible, newId, DESK, IS_DESKTOP, isSel, cueSuffix } from './state.js';
import { Media, Wave } from './media.js';
import { RULER_H, WAVE_H, ROW_H, tracksTop, tracksScrollTop, viewportW, timeToX, xToTime, layoutTimeline, drawRuler, niceStep, fmtTick, drawWave, renderTrackRows, renderCueBlocks, trackFromY, addTrack, removeTrack, moveSelectedToTrack, updatePlayhead, drawTimeline, setZoom, zoomFit, zoomFitVideo, refreshTrackGutterActive, snapTargets, snapVal, neighborBounds } from './timeline.js';
import { renderSubList, renderCheckPanel, buildSubRow, renderSubRow, selectCue, selectCueSingle, refreshSelectionUI, updateTlSel, addCue, addCueAfter, addCueRelative, deleteSelected, deleteCue, sortCues, searchUpdate, searchNav, searchReplace, searchSelectAll, trimTrackSpaces } from './subtitles.js';
import { setIn, setOut, nudge, stepBoundary, resetPlaybackSpeed } from './keyboard.js';
import { Project, ensureProjectSaved, resetProject } from './project.js';
import { showCtx, hideCtx, showCueMenu, showPlayerMenu } from './menus.js';
import { History, recordHistory, renderHistory } from './history.js';
import { addNote, renderNotes, exportNotes, setNoteActive, updateNoteActive, clearAllNotes } from './notes.js';
import { setStatus, showToast, showOsd, openModal, closeModal } from './ui.js';
import { renderAudioTracks, renderMixer, mixerReset, mixerMuteAll, updateMeters } from './mixer.js';
import { showHelp } from './help.js';
import { importSub, showExportDialog, exportSub, showFpsConvertDialog, applyTcShift, applyDurAdjTc, applyDurAdjPct, toASSFromState } from './subio.js';
import { parseTimecodeInput } from './tcparse.js';
import { on } from './events.js';

/* app.js 為協調層：訂閱各模組發送的事件並呼叫對應的渲染/指令函式。
   各模組只 emit、不再反向 import app.js，藉此切斷雙向相依。
   （函式宣告會被 hoist，於此處註冊安全；emit 為同步呼叫，語意不變。） */
on('render:all', renderAll);
on('render:videoSub', renderVideoSub);
on('render:listTrackSel', renderListTrackSel);
on('render:trackStyle', renderTrackStyle);
on('playhead:ensure', ensurePlayheadVisible);
on('duration:known', onDurationKnown);
on('mpv:refreshSubs', refreshMpvSubs);
on('panel:toggle', togglePanel);
on('note:openInPanel', openNoteInPanel);
on('cue:openEdit', openCueEditModal);
on('action', doAction);
// A1：fps 變更後的 DOM 同步（原本在 state.setFps 內，現下沉到此處，state.js 不再相依 DOM）
on('fps:changed', ()=>{
  const sel=$('fpsSel'); if(sel) sel.value=State.dropFrame?String(State.fps)+'df':String(State.fps);
  $('tcCur').textContent=secToEncore(video.currentTime||0,State.fps,State.dropFrame);
  $('tcDur').textContent=secToEncore(State.duration,State.fps,State.dropFrame);
});

/* ============================================================================
   SUB TOOL — 線上上字幕工具  (single-file, vanilla JS)
   區段：
     0. 全域狀態
     1. 工具函式（時間/編碼/檔案）
     2. 字幕格式 解析 / 序列化  (SRT / ASS / Encore / TXT)
     3. 媒體引擎（影片 + Web Audio 多音軌混音 + ffmpeg.wasm）
     4. 波形
     5. 時間軸 渲染 / 互動
     6. 字幕列表
     7. 鍵盤 (I/O 上字幕)
     8. 專案 存/讀 (.subtool)
     9. UI 接線 / 初始化
   ============================================================================ */

/* ===== 0. 全域狀態 ===================================================== */







/* 工具/時間/格式 已拆分至 util.js / time.js / formats.js */





/* ===== 9. UI 接線 / 渲染 / 初始化 ==================================== */
function renderAll(){ renderSubList(); renderCueBlocks(); renderVideoSub(); updateTlSel(); refreshMpvSubs(); }
/* mpv 嵌入模式：字幕改由 mpv/libass 渲染（DOM 疊層被覆蓋）。cue 變動時重建 .ass 餵給 mpv（防抖） */
let _mpvSubT=null;
let _firstLoad=true; // 第一次載入影片或字幕時自動 zoomFitVideo；新專案後重置
function refreshMpvSubs(){
  if(!Media.mpvMode || !window.subtool?.mpv) return;
  clearTimeout(_mpvSubT);
  _mpvSubT=setTimeout(()=>{
    try{ window.subtool.mpv.subSet(toASSFromState(State.cues)).catch(()=>{}); }catch(e){}
  },150);
}
/* mpv 是 OS 層子視窗，無法被 HTML z-index 蓋過。
   只在浮動面板/搜尋視窗「實際重疊」影片區域時才隱藏 mpv，不重疊時影片繼續顯示。 */
function _syncMpvPanel(){
  if(!Media.mpvMode || !window.subtool?.mpv) return;
  const modalOpen=!!$('modalBg')?.classList.contains('show');
  let hides=modalOpen;
  if(!hides){
    const vr=$('videoWrap')?.getBoundingClientRect();
    if(vr){
      const ov=(r)=>!(r.right<=vr.left||r.left>=vr.right||r.bottom<=vr.top||r.top>=vr.bottom);
      for(const p of document.querySelectorAll('.float-panel.show')){
        if(ov(p.getBoundingClientRect())){hides=true;break;}
      }
      if(!hides){
        const sd=$('searchDialog');
        if(sd&&(sd.style.display||'none')!=='none'&&ov(sd.getBoundingClientRect()))hides=true;
      }
    }
  }
  window.subtool.mpv.show(!hides).catch(()=>{});
}
const _videoSub = $('videoSub');
const _videoWrap = $('videoWrap');
let _videoSubSig = '';
function renderVideoSub(){
  const t=Media.vTime();
  // 每個可見軌道各依其 posPct 疊加顯示（高度由使用者自行調整）
  const baseFs = Math.max(14, Math.min(36, Math.round((_videoWrap?.clientWidth||1000) * 0.025)));
  let html='', sig='';
  for(let tk=0; tk<State.trackCount; tk++){
    if(!trackVisible(tk))continue;
    const cur=State.cues.filter(c=>(c.track||0)===tk && c.timed!==false && (t+0.001)>=c.start && (t+0.001)<c.end);
    if(!cur.length)continue;
    const st=State.tracks[tk]||{};
    const pct=st.posPct!=null?st.posPct:10, fs=st.fontScale||1, al=st.align||'center', col=st.color||'#ffffff';
    const fsPx = Math.round(baseFs * fs);
    sig+=tk+'|'+fsPx+'|'+col+'|'+pct+'|'+al+'|'+cur.map(c=>c.id+'='+c.text).join(',')+';';
    html+=`<div class="vsub-track" style="bottom:${pct}%;text-align:${al};letter-spacing:1px;font-weight:500;font-family:'思源黑體', 'Noto Sans TC', 'Source Han Sans TC', sans-serif;">`+
      cur.map((c,i)=>`<span class="line" style="font-size:${fsPx}px;color:${i===0?col:'#ff4444'}">${escapeHTML(c.text||'').replace(/\n/g,'<br>')}</span>`).join('<br>')+
      `</div>`;
  }
  if(sig===_videoSubSig) return;
  _videoSubSig=sig;
  _videoSub.innerHTML=html;
}


/* ===== 快取管理對話框（桌面版） ===== */
function _fmtBytes(n){ n=+n||0; if(n<1024)return n+' B'; const u=['KB','MB','GB','TB']; let i=-1; do{n/=1024;i++;}while(n>=1024&&i<u.length-1); return n.toFixed(n<10?1:0)+' '+u[i]; }
let _cacheDlgGen=0;
async function openCacheDialog(){
  const DESK=window.subtool;
  if(!DESK||!DESK.cacheInfo){ showToast('快取管理僅在桌面版可用'); return; }
  const myGen=++_cacheDlgGen;
  openModal('🗂 轉檔快取','<div style="padding:6px 2px">讀取中…</div>',[{label:'關閉',primary:true,act:closeModal}]);
  let info; try{ info=await DESK.cacheInfo(); }catch(e){ info={folders:0,bytes:0,root:''}; }
  // 使用者在讀取期間已關閉（或又開了別的對話框）就不要把對話框彈回來
  if(myGen!==_cacheDlgGen || !$('modalBg').classList.contains('show')) return;
  const html=
    `<div style="padding:4px 2px;line-height:1.9">`+
    `<div>中央快取：<b>${info.folders}</b> 個項目，共 <b>${_fmtBytes(info.bytes)}</b></div>`+
    `<div style="font-size:11px;color:var(--muted);word-break:break-all;margin-top:2px">${escapeHTML(info.root||'')}</div>`+
    `<div style="font-size:12px;color:var(--muted);margin-top:8px">說明：開啟影片時會把每個聲道與波形轉存到「影片同資料夾的 <code>.subtool_Cache</code>」內，其他電腦讀取同一個檔案時可直接沿用、不必重算。此處管理的是本機的中央快取。</div>`+
    `</div>`;
  const buttons=[
    {label:'清理孤兒檔',act:async()=>{ const r=await DESK.cacheCleanOrphans(); showToast(`已清理 ${r.removed} 個無效項目，釋放 ${_fmtBytes(r.bytes)}`); openCacheDialog(); }},
    {label:'全部清除',act:()=>{
      openModal('確認清除','<div style="padding:6px 2px">將刪除所有中央快取，以及目前開啟影片旁的 .subtool_Cache 資料夾。<br>下次開啟同檔需重新轉檔。確定？</div>',
        [{label:'確定清除',primary:true,act:async()=>{ const r=await DESK.cacheClearAll(State.mediaPath||null); showToast(`已清除快取，釋放 ${_fmtBytes(r.bytes)}`); closeModal(); }},{label:'取消',act:openCacheDialog}]);
    }},
    {label:'關閉',primary:true,act:closeModal},
  ];
  openModal('🗂 轉檔快取',html,buttons);
}
function onDurationKnown(){
  $('tcDur').textContent=secToEncore(State.duration,State.fps,State.dropFrame);
  $('seekBar').max=Math.max(1,Math.round(State.duration*1000));
  $('stMedia').textContent=State.mediaName?(State.mediaName+(State.mediaSize?(' · '+(State.mediaSize/1e6).toFixed(1)+'MB'):'')):'';
  const vw=viewportW();
  if(vw && State.duration>0){
    const minPps = (vw-40)/State.duration;
    $('zoomBar').min = Math.min(10, minPps).toFixed(3);
  }
  if(_firstLoad && State.duration>0){ zoomFitVideo(); _firstLoad=false; }
  else if(State.pxPerSec*State.duration < vw) zoomFitVideo();
  else drawTimeline();
}
function ensurePlayheadVisible(){
  const t=Media.vTime();
  const vw=viewportW();
  if(!vw) return;
  const x=timeToX(t);
  if(x<40 || x>vw-40){
    const newLeft=Math.max(0, t*State.pxPerSec - vw*0.3);
    tlScroll.scrollLeft=newLeft;
    State.viewStart=tlScroll.scrollLeft/State.pxPerSec; // read back actual (browser may clamp)
    drawRuler(); drawWave(); renderCueBlocks(); updatePlayhead(); // sync immediately; don't wait for passive scroll event
  }
}

/* 影片事件 */
video.addEventListener('timeupdate',()=>{
  // FPS-SYNC（詳見 FPS_時碼一致性.md）：tcCur/seekBar/播放點都以 displayTime() 為唯一來源
  let t = Media.displayTime();
  $('tcCur').textContent=secToEncore(t,State.fps,State.dropFrame); // 時:分:秒:格
  $('seekBar').value=Math.round(t*1000);
  if(!Media.playing) updatePlayhead();
});
let rafOn=false, rafFrame=0, _rafLastIdx=0;
function rafLoop(){
  if(Media.playing){
    const t=Media.displayTime();
    // 無媒體時更新時間顯示
    if(!video.src){
      $('tcCur').textContent=secToEncore(t,State.fps,State.dropFrame);
      $('seekBar').value=Math.round(t*1000);
    }
    ensurePlayheadVisible(); // scroll viewport first so State.viewStart is current
    updatePlayhead(); renderVideoSub();
    if(Wave.live){ Wave.captureLive(); if((rafFrame++ % 6)===0) drawWave(); }
    // active 字幕（快取游標，O(1) 命中常見路徑）
    const _t=t+0.001;
    let act=null;
    if(_rafLastIdx>=0 && _rafLastIdx<State.cues.length){
      const lc=State.cues[_rafLastIdx];
      if(lc.timed!==false && _t>=lc.start && _t<=lc.end) act=lc;
    }
    if(!act){
      // 檢查相鄰 ±2 條
      const lo=Math.max(0,_rafLastIdx-2), hi=Math.min(State.cues.length-1,_rafLastIdx+2);
      for(let i=lo;i<=hi;i++){
        const c=State.cues[i]; if(c && c.timed!==false && _t>=c.start && _t<=c.end){ act=c; _rafLastIdx=i; break; }
      }
    }
    if(!act){
      // 完整搜尋（僅在跳轉等情境觸發）
      for(let i=0;i<State.cues.length;i++){
        const c=State.cues[i]; if(c.timed!==false && _t>=c.start && _t<=c.end){ act=c; _rafLastIdx=i; break; }
      }
    }
    if(act&&act.id!==State.activeId){ State.activeId=act.id; markActiveRow(act.id); }
    // active 備註
    if(State.notes.length&&$('notesPanel').classList.contains('show')) updateNoteActive(t);
    // buffer 音軌 drift 校正
    if(Media.ctx && Media.tracks.some(t=>t.kind==='buffer')){
      const expect=Media.startMediaTime+(Media.ctx.currentTime-Media.startCtxTime)*(video.playbackRate||1);
      if(Math.abs(expect-video.currentTime)>0.25){ Media.stopBufferSources(); Media.startBufferSources(video.currentTime); }
    }
    // element 音軌 drift 校正（多軌同步）
    for(const tr of Media.tracks){ if(tr.kind==='element'&&tr.el&&!tr.el.paused){
      const ref=Media.vTime(); // mpv 模式時取 _mpvTime，否則取 video.currentTime
      if(Math.abs(tr.el.currentTime - ref) > 0.12){ try{tr.el.currentTime=ref;}catch(e){} }
    }}
  }
  updateMeters();
  requestAnimationFrame(rafLoop);
}
function markActiveRow(id){
  sublist.querySelectorAll('.sub-row.active').forEach(r=>r.classList.remove('active'));
  const row=sublist.querySelector(`.sub-row[data-id="${id}"]`);
  if(row){
    row.classList.add('active');
    if(State.subMode){
      const rowH = row.offsetHeight || 30;
      sublist.scrollTop = row.offsetTop - rowH * 4;
    } else {
      row.scrollIntoView({block:'nearest'});
    }
  }
}
video.addEventListener('play',()=>{
  Media.playing=true;
  $('playBtn').textContent='⏸';
  if(!State.subMode){
    State.selectedIds=[];
    State.selectedId=null;
    refreshSelectionUI();
    const stSel = $('stSel');
    if(stSel) stSel.textContent='';
  }
});
video.addEventListener('pause',()=>{
  $('playBtn').textContent='▶';
  // FPS-SYNC（詳見 FPS_時碼一致性.md）：暫停時把時碼/seekBar 一併刷新為已對齊格的權威位置
  // （與播放點同源），避免殘留播放中最後一次未對齊的時間導致播放器比播放點多一格
  const t=Media.displayTime();
  $('tcCur').textContent=secToEncore(t,State.fps,State.dropFrame);
  $('seekBar').value=Math.round(t*1000);
  updatePlayhead();
});
video.addEventListener('seeked',()=>{updatePlayhead();renderVideoSub();updateNoteActive(video.currentTime);});
window.addEventListener('mpv:seeked',e=>{updatePlayhead();renderVideoSub();updateNoteActive(e.detail);});
video.addEventListener('ended',()=>{Media.pause();});

/* seek bar */
$('seekBar').addEventListener('input',e=>{ const t=(+e.target.value)/1000; Media.seek(t); updateNoteActive(t); });
// rateSel removed from UI — speed controlled via JKL keys
$('fpsSel').addEventListener('change',e=>{ const prev=State.fps,prevDf=State.dropFrame; setFps(e.target.value); renderSubList(); renderNotes(); recordHistory(`切換 FPS ${prevDf?prev+'df':prev}→${State.fps+(State.dropFrame?'df':'')}`); e.target.blur(); });
$('zoomBar').addEventListener('input',e=>setZoom(+e.target.value));




async function doAction(act){
  switch(act){
    case 'open-media':
      if(IS_DESKTOP){ const p=await DESK.openMedia(); if(p)Media.loadDesktopMedia(p); }
      else { const f=await pickFile($('fileMedia')); if(f)Media.loadVideoFile(f); } break;
    case 'add-audio':
      if(IS_DESKTOP){ const ps=await DESK.openAudio(); for(const p of (ps||[]))await Media.addAudioFileDesktop(p); }
      else { const f=await pickFile($('fileAudio')); if(f)Media.addAudioFile(f); } break;
    case 'open-project':
      if(IS_DESKTOP){ const r=await DESK.openProject(); if(r)Project.loadDesktop(r); }
      else { const f=await pickFile($('fileProject')); if(f)Project.load(f); } break;
    case 'save-project': Project.save(); break;
    case 'new':
      // Fix #15 同款：破壞性動作改用 openModal，風格一致且 Electron 不會截取原生 confirm
      openModal('開新專案',
        '<p>確定清空目前專案？字幕、備註與已載入的影音都將清除（未存檔的話）。</p>',
        [{label:'取消',act:closeModal},
         {label:'確定清空',primary:true,act:()=>{
           closeModal();
           State.cues=[];State.notes=[];State.selectedId=null;State.selectedIds=[];
           State.listTrack=0;State.tracks=[];ensureTrackCount(1);
           State.subMode=false;const smb=$('subModeBtn');if(smb)smb.classList.remove('sub-active');
           History.reset();resetProject();_firstLoad=true;
           // 清除影音
           video.pause(); video.src='';
           State.mediaName=''; State.mediaPath=''; State.mediaSize=0;
           Media.reset();
           const nv=$('noVideo'); if(nv) nv.style.display='';
           onDurationKnown(); renderAudioTracks();
           renderListTrackSel();renderAll();renderNotes();drawTimeline();
           setStatus('新專案','ok');
         }}]);
      break;
    case 'imp-auto': importSub(); break;
    case 'exp-dialog': showExportDialog(); break;
    case 'exp-srt': exportSub('srt'); break;
    case 'exp-ass': exportSub('ass'); break;
    case 'exp-encore': exportSub('encore'); break;
    case 'exp-txt': exportSub('txt'); break;
    case 'fps-convert': showFpsConvertDialog(); break;
    case 'shift-tc': togglePanel('shiftPanel'); break;
    case 'close-shift': $('shiftPanel').classList.remove('show'); _syncMpvPanel(); break;
    case 'shift-back': applyTcShift(-1); break;
    case 'shift-fwd': applyTcShift(1); break;
    case 'dur-adj-sub': applyDurAdjTc(-1); break;
    case 'dur-adj-add': applyDurAdjTc(1); break;
    case 'dur-adj-pct': applyDurAdjPct(); break;
    case 'sub-mode':
      State.subMode=!State.subMode;
      { const smb=$('subModeBtn'); if(smb)smb.classList.toggle('sub-active',State.subMode); }
      if(State.subMode){ Media.play(); setStatus('🎯 上字幕模式 ON — 播放中，I 設起點，O 設終點後自動前進','ok'); }
      else { Media.pause(); setStatus('上字幕模式 OFF',''); }
      break;
    case 'playpause':
      resetPlaybackSpeed(); // 重置 JKL 穿梭速度回 1x（清掉殘留的倍率）
      Media.toggle();
      setStatus(Media.playing?'▶ 正播':'⏸ 暫停', Media.playing?'ok':''); // 狀態列同步播放/暫停（非僅 JKL）
      break;
    case 'seek-start': Media.seek(0); break;
    case 'back5': nudge(-5); break;
    case 'back1': nudge(-1); break;
    case 'fwd1': nudge(1); break;
    case 'fwd5': nudge(5); break;
    case 'frame-back': nudge(-1/State.fps); break;
    case 'frame-fwd': nudge(1/State.fps); break;
    case 'set-in': setIn(); break;
    case 'set-out': setOut(); break;
    case 'add-cue': addCueRelative(1); break;
    case 'add-cue-above': addCueRelative(-1); break;
    case 'add-cue-below': addCueRelative(1); break;
    case 'del-cue': deleteSelected(); break;
    case 'add-track': addTrack(); break;
    case 'zoom-in': setZoom(State.pxPerSec*1.3); break;
    case 'zoom-out': setZoom(State.pxPerSec*0.77); break;
    case 'zoom-fit': zoomFit(); break;
    case 'undo': History.undo(); break;
    case 'redo': History.redo(); break;
    case 'history': togglePanel('historyPanel'); renderHistory(); break;
    case 'close-history': $('historyPanel').classList.remove('show'); _syncMpvPanel(); break;
    case 'notes': togglePanel('notesPanel'); renderNotes(); break;
    case 'add-note': addNote(); break;
    case 'clear-notes': clearAllNotes(); break;
    case 'close-notes': $('notesPanel').classList.remove('show'); _syncMpvPanel(); break;
    case 'mixer': togglePanel('mixerPanel'); renderMixer(); break;
    case 'close-mixer': $('mixerPanel').classList.remove('show'); _syncMpvPanel(); break;
    case 'mixer-reset': mixerReset(); break;
    case 'mixer-muteall': mixerMuteAll(); break;
    case 'cache-manage': openCacheDialog(); break;
    case 'export-notes': exportNotes(); break;
    case 'toggle-all-vis': { const anyVis=State.tracks.some(t=>t.visible!==false); State.tracks.forEach(t=>t.visible=!anyVis); drawTimeline(); renderVideoSub(); refreshMpvSubs(); } break;
    case 'toggle-all-lock': { const anyUnlocked=State.tracks.some(t=>!t.locked); State.tracks.forEach(t=>t.locked=anyUnlocked); drawTimeline(); } break;
    case 'copy-track': doCopyTrack(); break;
    case 'check-panel': { const btn=$('checkPanelBtn'); const willShow=!$('checkPanel').classList.contains('show'); togglePanel('checkPanel'); if(btn)btn.classList.toggle('sub-active',willShow); if(willShow)renderCheckPanel(); } break;
    case 'close-check': { $('checkPanel').classList.remove('show'); const btn=$('checkPanelBtn'); if(btn)btn.classList.remove('sub-active'); _syncMpvPanel(); } break;
    case 'search-open': { const sd=$('searchDialog'); if(sd){ const show=sd.style.display==='none'||!sd.style.display; sd.style.display=show?'flex':'none'; if(show)setTimeout(()=>$('searchInput')?.focus(),20); _syncMpvPanel(); } } break;
    case 'search-close': { const sd=$('searchDialog'); if(sd){ sd.style.display='none'; _syncMpvPanel(); } } break;
    case 'search-next': searchNav(1); break;
    case 'search-prev': searchNav(-1); break;
    case 'search-clear': { $('searchInput').value=''; searchUpdate(); $('searchInput').focus(); } break;
    case 'search-select-all': searchSelectAll(); break;
    case 'replace-one': searchReplace(false); break;
    case 'replace-all': searchReplace(true); break;
    case 'trim-track': trimTrackSpaces(); break;
    case 'help': showHelp(); break;
    case 'modal-close': closeModal(); break;
  }
}
let _repTimer=null, _repInterval=null, _repFired=false;
const REP_ACTS=['back5','back1','frame-back','frame-fwd','fwd1','fwd5'];
document.addEventListener('mousedown',e=>{
  if(e.button!==0)return;
  const b=e.target.closest('[data-act]');
  if(b && REP_ACTS.includes(b.dataset.act)){
    _repFired=false;
    _repTimer=setTimeout(()=>{
      _repInterval=setInterval(()=>{ doAction(b.dataset.act); _repFired=true; }, 100);
    }, 400);
  }
});
const stopRep=()=>{ clearTimeout(_repTimer); clearInterval(_repInterval); };
document.addEventListener('mouseup', stopRep);
document.addEventListener('mouseout', e=>{ if(e.target.closest&&e.target.closest('[data-act]'))stopRep(); });

document.addEventListener('click',e=>{
  const b=e.target.closest('[data-act]');
  if(b){
    b.blur();
    if(_repFired && REP_ACTS.includes(b.dataset.act)){ _repFired=false; return; }
    doAction(b.dataset.act);
  }
  // 關閉下拉選單
  document.querySelectorAll('.menu.open').forEach(m=>{ if(!m.contains(e.target))m.classList.remove('open'); });
});
document.querySelectorAll('.menu>button').forEach(btn=>{
  btn.addEventListener('click',e=>{
    e.stopPropagation();
    const m=btn.parentElement; const wasOpen=m.classList.contains('open');
    document.querySelectorAll('.menu.open').forEach(x=>x.classList.remove('open'));
    if(!wasOpen)m.classList.add('open');
  });
});
// 選單項目點擊後關閉
document.querySelectorAll('.menu .items button').forEach(b=>b.addEventListener('click',()=>{
  b.closest('.menu').classList.remove('open');
}));


/* ===== 字幕列表：軌道切換下拉 + 樣式面板 ===== */
function renderListTrackSel(){
  const sel=$('listTrackSel'); if(!sel)return;
  const prev=clamp(State.listTrack,0,State.tracks.length-1);
  State.listTrack=prev;
  sel.innerHTML=State.tracks.map((t,i)=>`<option value="${i}">${escapeHTML(t.name)}</option>`).join('');
  sel.value=String(prev);
  renderTrackStyle();
}
function renderTrackStyle(){
  const panel=$('trackStyle'); const i=State.listTrack;
  if(!State.tracks[i]){ panel.classList.add('disabled'); $('tsTitle').textContent='軌道樣式'; return; }
  panel.classList.remove('disabled');
  const tk=State.tracks[i];
  $('tsTitle').textContent='「'+tk.name+'」樣式';
  const sz=tk.fontScale||1; $('tsSize').value=sz;
  const pp=tk.posPct!=null?tk.posPct:10; $('tsPos').value=pp;
  const col=(tk.color||'#ffffff').toLowerCase(); $('tsColor').value=col;
  panel.querySelectorAll('.ts-preset[data-ts-size]').forEach(b=>b.classList.toggle('active',+b.dataset.tsSize===sz));
  panel.querySelectorAll('.ts-preset[data-ts-pos]').forEach(b=>b.classList.toggle('active',+b.dataset.tsPos===pp));
  panel.querySelectorAll('.ts-clr').forEach(b=>b.classList.toggle('active',b.dataset.color===col));
}

/* ===== 時間軸：雙擊字幕區塊內嵌編輯文字 ===== */
async function startInlineEdit(block,c){
  await ensureProjectSaved();
  hideCtx();
  const ed=document.createElement('textarea'); ed.className='cue-inline-edit'; ed.value=c.text||'';
  const r=block.getBoundingClientRect(), lr=tlLayer.getBoundingClientRect();
  ed.style.left=(r.left-lr.left)+'px'; ed.style.top=(r.top-lr.top)+'px';
  ed.style.width=Math.max(90,r.width)+'px'; ed.style.minHeight=r.height+'px';
  tlLayer.appendChild(ed); ed.focus(); ed.select();
  let done=false; const orig=c.text||'';
  const commit=(save)=>{ if(done)return; done=true; if(save)c.text=ed.value; ed.remove(); renderAll(); renderVideoSub(); if(save&&(c.text||'')!==orig)recordHistory('編輯字幕文字'+cueSuffix(c)); };
  ed.addEventListener('keydown',ev=>{ ev.stopPropagation();
    if(ev.key==='Enter'&&!ev.shiftKey){ ev.preventDefault(); commit(true); }
    else if(ev.key==='Escape'){ ev.preventDefault(); commit(false); } });
  ed.addEventListener('blur',()=>commit(true));
  ed.addEventListener('mousedown',ev=>ev.stopPropagation());
  ed.addEventListener('dblclick',ev=>ev.stopPropagation());
}

async function openCueEditModal(c){
  await ensureProjectSaved();
  const orig=c.text||'';
  const trackIdx=c.track||0;
  const trackName=State.tracks[trackIdx]?.name||'';
  const tc=`${secToEncore(c.start,State.fps,State.dropFrame)} → ${secToEncore(c.end,State.fps,State.dropFrame)}`;

  // 找同 in 點的其他軌道字幕（容差 1 格）
  const TOL=1/Math.max(State.fps||25,1);
  const siblings=[];
  State.tracks.forEach((tk,i)=>{
    if(i===trackIdx)return;
    const match=State.cues.find(oc=>(oc.track||0)===i&&Math.abs(oc.start-c.start)<=TOL);
    if(match)siblings.push({trackName:tk.name,text:match.text||'',tkIdx:i});
  });

  const mkBlock=(label,text,btnId)=>
    `<div style="margin-bottom:12px">`+
      `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">`+
        `<span style="font-size:12px;color:var(--text-faint)">${label}</span>`+
        `<button id="${escapeHTML(btnId)}" style="font-size:11px;padding:1px 7px">複製</button>`+
      `</div>`+
      `<div style="background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:8px 10px;min-height:2.2em">`+
        `<div id="${btnId==='cueEditCopy'?'cueEditOrig':''}" style="white-space:pre-wrap;font-size:14px;font-family:inherit;color:var(--text);user-select:text;cursor:text">${escapeHTML(text).replace(/\n/g, '<br>')}</div>`+
      `</div>`+
    `</div>`;

  const sibHtml=siblings.map(s=>mkBlock('軌道：'+s.trackName,s.text,'cueEditCopySib'+s.tkIdx)).join('');

  const doConfirm=()=>{
    const ta=$('cueEditTa');
    if(!ta) return;
    let val=ta.innerText;
    if(val.endsWith('\n') && !orig.endsWith('\n')) val=val.slice(0,-1);
    c.text=val; closeModal(); renderAll(); renderVideoSub();
    if(val!==orig) recordHistory('編輯字幕文字'+cueSuffix(c));
  };
  openModal('修改字幕文字',
    `<div style="font-size:12px;color:var(--text-faint);margin-bottom:10px">${escapeHTML(trackName)} ｜ ${tc}</div>`+
    `<div style="max-height:58vh;overflow-y:auto;padding-right:2px">`+
    sibHtml+
    mkBlock('原文',orig,'cueEditCopy')+
    `<div style="font-size:12px;color:var(--text-faint);margin-bottom:4px">修改 <span style="font-size:10px;opacity:.5">（Enter 確認 · Shift+Enter 換行）</span></div>`+
    `<div id="cueEditTa" contenteditable="true" style="width:100%;min-height:5em;border:1px solid var(--border);border-radius:4px;background:var(--bg);font-size:14px;font-family:inherit;padding:6px;box-sizing:border-box;color:var(--text);overflow-y:auto;outline:none"></div>`+
    `</div>`,
    [{label:'確認',primary:true,act:doConfirm},{label:'取消',act:closeModal}]);
  setTimeout(()=>{
    const ta=$('cueEditTa');
    if(ta){
      ta.dataset.orig=orig;
      ta.innerHTML=escapeHTML(orig).replace(/\n/g, '<br>');
      ta.focus();
      try { const r = document.createRange(), s = window.getSelection(); r.selectNodeContents(ta); s.removeAllRanges(); s.addRange(r); } catch (_) {}
      
      ta.addEventListener('keydown',e=>{
      if(e.key==='Enter'&&e.ctrlKey){
        e.preventDefault();
        const sel=window.getSelection();
        if(!sel.rangeCount)return;
        const range=sel.getRangeAt(0).cloneRange();
        range.collapse(true);
        const MARK='\x01';
        const markerNode=document.createTextNode(MARK);
        range.insertNode(markerNode);
        let raw=ta.innerText;
        markerNode.parentNode.removeChild(markerNode);
        let markerPos=raw.indexOf(MARK);
        if(markerPos<0) markerPos=raw.length;
        let full=raw.replace(MARK,'');
        if(full.endsWith('\n')&&!orig.endsWith('\n')){
          full=full.slice(0,-1);
          if(markerPos>full.length) markerPos=full.length;
        }
        const textBefore=full.slice(0,markerPos);
        const textAfter=full.slice(markerPos);
        const origEnd=c.end;
        const isTimed=c.timed!==false;
        if(isTimed){ const pt=Media.vTime(); if(pt<=c.start||pt>=c.end){ showToast('播放點必須在字幕的起訖時間內才能拆句'); return; } }
        let splitTime=0;
        if(isTimed){ splitTime=Media.vTime(); c.end=splitTime; }
        c.text=textBefore;
        const nc={id:newId(),start:isTimed?splitTime:0,end:isTimed?origEnd:0,
          text:textAfter,track:c.track||0,timed:isTimed};
        const cidx=State.cues.indexOf(c);
        if(cidx>=0)State.cues.splice(cidx+1,0,nc); else State.cues.push(nc);
        closeModal(); sortCues(); renderAll(); recordHistory('拆分字幕');
        selectCue(nc.id,{seek:false});
        setTimeout(()=>{
          const nr=sublist.querySelector(`.sub-row[data-id="${nc.id}"]`);
          if(nr)nr.dispatchEvent(new MouseEvent('dblclick',{bubbles:false,cancelable:true,view:window}));
        },30);
      } else if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();doConfirm();}
    });
    }
    siblings.forEach(s=>{
      const btn=$('cueEditCopySib'+s.tkIdx);
      if(btn) btn.addEventListener('click',()=>{ navigator.clipboard.writeText(s.text).then(()=>{btn.textContent='已複製';setTimeout(()=>btn.textContent='複製',1500);}); });
    });
    const copyBtn=$('cueEditCopy');
    if(copyBtn) copyBtn.addEventListener('click',()=>{ navigator.clipboard.writeText(orig).then(()=>{copyBtn.textContent='已複製';setTimeout(()=>copyBtn.textContent='複製',1500);}); });
  },30);
}

/* ===== UI 接線（區塊切換 / 樣式 / 分隔線 / 捲動同步 / 雙擊） ===== */
function initUI(){
  // 軌道切換下拉
  $('listTrackSel').addEventListener('change',e=>{ State.listTrack=+e.target.value; State.selectedIds=[]; State.selectedId=null; $('stSel').textContent=''; searchUpdate(); renderTrackStyle(); refreshSelectionUI(); refreshTrackGutterActive(); });
  // 混音器音源切換
  const mixerSrcSel=$('mixerSrcSel');
  if(mixerSrcSel) mixerSrcSel.addEventListener('change',e=>{ Media.switchSource(e.target.value); renderMixer(); e.target.blur(); });
  
  const waveGlobalSrcSel=$('waveGlobalSrcSel');
  if(waveGlobalSrcSel) waveGlobalSrcSel.addEventListener('change',e=>{ Media.switchSource(e.target.value); renderMixer(); e.target.blur(); });

  // 樣式控制（大小 / 位置 / 顏色）
  $('tsSize').addEventListener('input',e=>{ const i=State.listTrack; if(!State.tracks[i])return; State.tracks[i].fontScale=clamp(+e.target.value,0.5,5); renderVideoSub(); refreshMpvSubs(); renderTrackStyle(); });
  $('tsSize').addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key==='Escape'){e.preventDefault();e.target.blur();} });
  $('tsPos').addEventListener('input',e=>{ const i=State.listTrack; if(!State.tracks[i])return; State.tracks[i].posPct=clamp(+e.target.value,0,92); renderVideoSub(); refreshMpvSubs(); renderTrackStyle(); });
  $('tsPos').addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key==='Escape'){e.preventDefault();e.target.blur();} });
  $('tsColor').addEventListener('input',e=>{ const i=State.listTrack; if(!State.tracks[i])return; State.tracks[i].color=e.target.value; renderVideoSub(); refreshMpvSubs(); renderTrackStyle(); });
  // 預設按鈕（大小 / 位置 / 顏色）— 委派事件到面板
  $('trackStyle').addEventListener('click',e=>{
    const i=State.listTrack; if(!State.tracks[i])return;
    const sz=e.target.closest('.ts-preset[data-ts-size]');
    if(sz){ const v=+sz.dataset.tsSize; State.tracks[i].fontScale=v; $('tsSize').value=v; renderVideoSub(); refreshMpvSubs(); renderTrackStyle(); return; }
    const ps=e.target.closest('.ts-preset[data-ts-pos]');
    if(ps){ const v=+ps.dataset.tsPos; State.tracks[i].posPct=v; $('tsPos').value=v; renderVideoSub(); refreshMpvSubs(); renderTrackStyle(); return; }
    const cl=e.target.closest('.ts-clr');
    if(cl){ const v=cl.dataset.color; State.tracks[i].color=v; $('tsColor').value=v; renderVideoSub(); refreshMpvSubs(); renderTrackStyle(); }
  });
  // 字幕檢查：字數上限輸入
  $('cpLenInput').addEventListener('input',()=>{ renderCheckPanel(); renderSubList(); });
  $('cpLenInput').addEventListener('keydown',e=>e.stopPropagation());
  // 字幕檢查：包含文字輸入
  $('cpContainsInput').addEventListener('input',()=>{ renderCheckPanel(); renderSubList(); });
  $('cpContainsInput').addEventListener('keydown',e=>e.stopPropagation());
  // 搜尋浮動視窗
  $('searchInput').addEventListener('input',()=>searchUpdate());
  $('searchInput').addEventListener('keydown',e=>{ e.stopPropagation(); if(e.isComposing) return; if(e.key==='Enter'){ searchNav(1); } else if(e.key==='Escape'){ $('searchInput').value=''; searchUpdate(); $('searchDialog').style.display='none'; _syncMpvPanel(); } });
  $('replaceInput').addEventListener('keydown',e=>e.stopPropagation());
  // 搜尋視窗可拖曳
  { const head=$('searchDialogHead'), dlg=$('searchDialog');
    if(head&&dlg){ let ox=0,oy=0,sx=0,sy=0;
      head.addEventListener('mousedown',e=>{ e.preventDefault();
        const r=dlg.getBoundingClientRect(); ox=r.left; oy=r.top; sx=e.clientX; sy=e.clientY;
        const mv=e2=>{ dlg.style.left=(ox+e2.clientX-sx)+'px'; dlg.style.top=(oy+e2.clientY-sy)+'px'; dlg.style.right='auto'; };
        const up=()=>{ document.removeEventListener('mousemove',mv); document.removeEventListener('mouseup',up); };
        document.addEventListener('mousemove',mv); document.addEventListener('mouseup',up);
      });
    }
  }
  // 軌道區垂直捲動：時間軸 <-> 左欄 同步
  let _sync=false; const gt=$('tlGutterTracks');
  tlTracks.addEventListener('scroll',()=>{ if(_sync)return; _sync=true; gt.scrollTop=tlTracks.scrollTop; _sync=false; },{passive:true});
  gt.addEventListener('scroll',()=>{ if(_sync)return; _sync=true; tlTracks.scrollTop=gt.scrollTop; _sync=false; },{passive:true});
  // 區塊分隔線：拖曳調整 字幕列表寬度 / 時間軸高度
  const _LAYOUT_KEY='sub_layout_v2';
  const saveLayout=()=>{
    const gt=$('tlGutter');
    localStorage.setItem(_LAYOUT_KEY,JSON.stringify({
      rw:$('rightPanel').style.width||'',
      th:$('timelinePanel').style.height||'',
      gw:gt?gt.style.width||'':''
    }));
  };
  const loadLayout=()=>{
    try{
      const d=JSON.parse(localStorage.getItem(_LAYOUT_KEY)||'{}');
      if(d.rw) $('rightPanel').style.width=d.rw;
      if(d.th) $('timelinePanel').style.height=d.th;
      const gt=$('tlGutter'); if(d.gw&&gt) gt.style.width=d.gw;
    }catch(_){}
  };
  const dragSplit=(handle,onMove)=>{ handle.addEventListener('mousedown',e=>{ e.preventDefault();
    const mv=ev=>onMove(ev); const up=()=>{document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);drawTimeline();saveLayout();};
    document.addEventListener('mousemove',mv); document.addEventListener('mouseup',up); }); };
  const right=$('rightPanel'), tl=$('timelinePanel');
  dragSplit($('splitV'),ev=>{ right.style.width=clamp(window.innerWidth-ev.clientX-3,220,window.innerWidth-360)+'px'; });
  dragSplit($('splitH'),ev=>{ const r=tl.getBoundingClientRect(); tl.style.height=clamp(r.bottom-ev.clientY,140,window.innerHeight-200)+'px'; drawTimeline(); });
  // 軌道欄寬度調整
  { const sp=$('tlGutterSplitter'), gt=$('tlGutter');
    if(sp&&gt){ let sx=0,sw=0;
      sp.addEventListener('mousedown',e=>{ e.preventDefault(); sx=e.clientX; sw=gt.offsetWidth;
        const mv=ev=>{ gt.style.width=clamp(sw+(ev.clientX-sx),60,360)+'px'; drawTimeline(); };
        const up=()=>{ document.removeEventListener('mousemove',mv); document.removeEventListener('mouseup',up); saveLayout(); };
        document.addEventListener('mousemove',mv); document.addEventListener('mouseup',up); });
    }
  }
  loadLayout();
  renderListTrackSel();
  // 點擊時間軸時解除輸入框焦點
  $('timelinePanel').addEventListener('mousedown',()=>{ const ae=document.activeElement; if(ae&&(ae.tagName==='INPUT'||ae.tagName==='SELECT'))ae.blur(); },{capture:true});
  // 任何按鈕點擊後立即解除焦點，避免 Space/Enter 誤觸
  document.addEventListener('click',e=>{ const btn=e.target.closest('button'); if(btn)btn.blur(); },{capture:true});
}

/* ===== 磁吸 / 防重疊 工具 ===== */
/* ===== 複製軌道 ===== */
function doCopyTrack(){
  const srcIdx=State.listTrack;
  const srcTrack=State.tracks[srcIdx];
  if(!srcTrack){ showToast('請先選擇一個字幕軌道'); return; }
  const srcCues=State.cues.filter(c=>(c.track||0)===srcIdx);
  openModal('複製字幕軌道',
    `<p>將 <b>${escapeHTML(srcTrack.name)}</b> 的 <b>${srcCues.length}</b> 條字幕複製到新軌道，請選擇複製方式：</p>`,
    [
      { label:'含文字內容', primary:true, act:()=>{ closeModal(); _execCopyTrack(srcIdx,true); } },
      { label:'僅複製時間點（文字清空）', act:()=>{ closeModal(); _execCopyTrack(srcIdx,false); } },
      { label:'取消', act:closeModal }
    ]
  );
}
function _execCopyTrack(srcIdx, withText){
  const srcTrack=State.tracks[srcIdx]; if(!srcTrack)return;
  // 產生唯一軌道名稱
  const base=srcTrack.name+'_複製';
  let name=base, n=1;
  const names=State.tracks.map(t=>t.name);
  while(names.includes(name)) name=base+(n++);
  // 複製軌道屬性
  const tk={name, visible:true, fontScale:srcTrack.fontScale||1, posPct:srcTrack.posPct||10,
             align:srcTrack.align||'center', locked:false, color:srcTrack.color||'#ffffff'};
  const newIdx=State.tracks.length;
  State.tracks.push(tk); syncTrackCount();
  // 複製字幕
  const srcCues=State.cues.filter(c=>(c.track||0)===srcIdx);
  for(const c of srcCues)
    State.cues.push({id:newId(), start:c.start, end:c.end, text:withText?(c.text||''):'', track:newIdx, timed:c.timed});
  sortCues(); renderAll(); drawTimeline();
  State.listTrack=newIdx; renderListTrackSel(); renderSubList();
  recordHistory('複製字幕軌道');
  showToast(`已複製到「${name}」（${srcCues.length} 條）`);
}

function openNoteInPanel(n){
  $('notesPanel').classList.add('show');
  setNoteActive(n.id);
  renderNotes();
  setTimeout(()=>{
    $('notesList')?.querySelector(`[data-id="${n.id}"]`)?.scrollIntoView({block:'nearest'});
  },30);
}
/* 開啟浮動面板時，若面板與影片重疊就自動推到影片右側，避免開啟時畫面變黑 */
function _ensurePanelInRightArea(panel){
  if(!Media.mpvMode||!window.subtool?.mpv) return;
  const vr=$('videoWrap')?.getBoundingClientRect();
  if(!vr) return;
  const pr=panel.getBoundingClientRect();
  if(pr.left < vr.right + 4){
    panel.style.right='auto'; panel.style.bottom='auto';
    panel.style.left=(vr.right+8)+'px';
    panel.style.top=Math.max(50, Math.min(pr.top, window.innerHeight-120))+'px';
  }
}

function togglePanel(id){ const p=$(id); const willShow=!p.classList.contains('show');
  document.querySelectorAll('.float-panel.show').forEach(x=>x.classList.remove('show'));
  if(willShow){ p.classList.add('show'); setTimeout(()=>{ _ensurePanelInRightArea(p); _syncMpvPanel(); },0); }
  else _syncMpvPanel();
}

/* ===== 播放時間數字：雙擊輸入 / 右鍵複製 ===== */
function startTimeEdit(){
  const span=$('tcCur'); if(span.querySelector('input'))return;
  const old=span.textContent;
  const inp=document.createElement('input'); inp.className='tc-edit'; inp.value=''; inp.placeholder=old;
  span.textContent=''; span.appendChild(inp); inp.focus();
  let done=false;
  const fin=(commit)=>{ if(done)return; done=true; inp.remove(); span.textContent=secToEncore(Media.vTime(),State.fps,State.dropFrame);
    if(commit){
      const raw=inp.value.trim(); let t=null;
      if(raw.startsWith('+')||raw.startsWith('-')){
        const sign=raw.startsWith('-')?-1:1;
        const delta=parseTimecodeInput(raw.slice(1));
        if(delta!==null){ t=Media.vTime()+sign*delta;
          if(t<0){ showToast('時間不能早於 00:00:00:00'); return; } }
      } else { t=parseTimecodeInput(raw); }
      if(t==null){ /* 空：不變 */ }
      else if(t>State.duration+1e-6){ showToast('超過片長'); }
      else { Media.seek(t); updatePlayhead(); ensurePlayheadVisible(); } } };
  inp.addEventListener('keydown',e=>{ e.stopPropagation(); if(e.key==='Enter'){e.preventDefault();fin(true);} else if(e.key==='Escape'){e.preventDefault();fin(false);} });
  inp.addEventListener('blur',()=>fin(true));
}
function initExtras(){
  // 調整面板：分頁切換
  document.querySelectorAll('.shift-tab').forEach(tab=>{
    tab.addEventListener('click',e=>{
      e.stopPropagation();
      document.querySelectorAll('.shift-tab').forEach(t=>t.classList.remove('active'));
      tab.classList.add('active');
      const isTc=tab.dataset.tab==='tc';
      $('shiftPageTc').style.display=isTc?'':'none';
      $('shiftPageDur').style.display=isTc?'none':'';
    });
  });
  // 調整持續時間：增減時長 vs 百分比 切換
  $('durAdjMode')?.addEventListener('change',()=>{
    const isTc=$('durAdjMode').value==='tc';
    $('durAdjTcRow').style.display=isTc?'':'none';
    $('durAdjPctRow').style.display=isTc?'none':'';
  });
  // 新輸入框鍵盤事件
  $('durAdjTcInput')?.addEventListener('keydown',e=>e.stopPropagation());
  $('durAdjPctInput')?.addEventListener('keydown',e=>{ e.stopPropagation(); if(e.key==='Enter'){e.preventDefault();applyDurAdjPct();} });
  $('durAdjMode')?.addEventListener('keydown',e=>e.stopPropagation());
  $('waveSrcSel')?.addEventListener('change',e=>{ Wave.selectSource(+e.target.value); e.target.blur(); });
  $('tcCur').addEventListener('dblclick',e=>{ e.preventDefault(); startTimeEdit(); });
  $('tcCur').addEventListener('contextmenu',e=>{ e.preventDefault();
    try{ navigator.clipboard.writeText(secToEncore(Media.vTime(),State.fps,State.dropFrame)); showToast('已複製時間碼'); }catch(err){} });
  // 浮動面板拖曳（拖 fp-head 移動整個面板）
  document.querySelectorAll('.float-panel').forEach(panel=>{
    const head=panel.querySelector('.fp-head'); if(!head)return;
    let ox=0,oy=0,sx=0,sy=0;
    head.addEventListener('mousedown',e=>{
      if(e.target.closest('button'))return;
      e.preventDefault();
      const r=panel.getBoundingClientRect();
      panel.style.right='auto'; panel.style.bottom='auto';
      panel.style.left=r.left+'px'; panel.style.top=r.top+'px';
      ox=r.left; oy=r.top; sx=e.clientX; sy=e.clientY;
      document.body.style.cursor='grabbing';
      const mv=e2=>{
        panel.style.left=clamp(ox+e2.clientX-sx,0,window.innerWidth-60)+'px';
        panel.style.top=clamp(oy+e2.clientY-sy,0,window.innerHeight-40)+'px';
        _syncMpvPanel();
      };
      const up=()=>{
        document.body.style.cursor='';
        document.removeEventListener('mousemove',mv);
        document.removeEventListener('mouseup',up);
        _syncMpvPanel();
      };
      document.addEventListener('mousemove',mv);
      document.addEventListener('mouseup',up);
    });
  });
}

/* resize */
let rzT;
window.addEventListener('resize',()=>{clearTimeout(rzT);rzT=setTimeout(()=>{drawTimeline();renderVideoSub();},120);});

/* 下拉選單/數字輸入選定後自動失焦，避免攔截鍵盤快捷鍵 */
document.addEventListener('change',(e)=>{
  const t=e.target;
  if(t.tagName==='SELECT' || (t.tagName==='INPUT' && t.type==='number')){
    setTimeout(()=>t.blur(),0);
  }
});

/* 初始化 */
function applyAriaLabels(){
  // X1：純圖示按鈕多半只有 title，報讀器在 button 模式下不穩定念出 title；
  // 啟動時把 title 複製成 aria-label，一次覆蓋整份靜態工具列。
  document.querySelectorAll('button[title]:not([aria-label])').forEach(b=>{
    const t=(b.getAttribute('title')||'').trim();
    if(t) b.setAttribute('aria-label', t);
  });
}
function init(){
  State.fps=+$('fpsSel').value||24;
  const brandLogo=$('brandLogo'); if(brandLogo) brandLogo.src=_logoUrl;
  ensureTrackCount(1);
  initUI(); initExtras(); applyAriaLabels();
  renderAll(); layoutTimeline(); drawTimeline(); rafLoop();
  History.reset();
  if(IS_DESKTOP) initDesktop();
  else setStatus('就緒 — 匯入影音或字幕開始','ok');
}
async function initDesktop(){
  const brand=document.querySelector('.brand');
  if(brand && !brand.querySelector('small')){ const sm=document.createElement('small'); sm.style.cssText='opacity:.55;font-size:11px;margin-left:6px;vertical-align:middle'; sm.textContent='桌面版'; brand.appendChild(sm); }
  const nv=$('noVideo'); if(nv) nv.innerHTML='<b>尚未載入影音</b>點 <kbd>🎬 影音</kbd> 匯入<br>桌面版支援 MP4 / MOV / <b>MXF</b> / MKV / 多音軌（系統 ffmpeg）<br>多音軌可同時混音播放，每軌獨立音量／獨奏';
  try{
    const s=await DESK.status();
    const eng=$('stEngine');
    if(eng){ const gpu=(s.venc&&s.venc!=='libx264')?(' · GPU '+String(s.venc).replace('h264_','').toUpperCase()):''; eng.textContent='引擎：'+(s.ffmpeg?'系統 ffmpeg ✓'+gpu:'⚠ 未偵測到 ffmpeg'); }
    if(!s.ffmpeg) openModal('未偵測到 ffmpeg',
      `桌面版的 MXF 轉檔與多音軌抽取需要系統安裝 <b>ffmpeg</b>。<br><br>`+
      `偵測位置：PATH、<code>C:\\Program Files\\FFMPEG\\bin\\</code> 等。<br>`+
      `可至 <b>ffmpeg.org</b> 下載後加入 PATH，或設環境變數 <code>FFMPEG_PATH</code>。<br><br>`+
      `原生 MP4/MOV/MP3/WAV 播放與字幕編輯不受影響。`);
    setStatus('就緒（桌面模式）— 可直接讀 MXF 與多音軌','ok');
  }catch(e){ setStatus('就緒（桌面模式）','ok'); }
  DESK.onProgress(d=>{
    if(!d.done && d.pct<100) setStatus((d.label||'處理中')+'… '+d.pct+'%','busy');
    if(d.done) window.dispatchEvent(new CustomEvent('desk:ingest-done',{detail:d}));
  });
}

/* 開發用除錯把手（正式打包 import.meta.env.DEV=false 時不會輸出） */
if (import.meta.env && import.meta.env.DEV) {
  window.SUB = { State, Media, Wave, SubFormats, Project,
    selectCue, selectCueSingle, refreshSelectionUI, isSel, stepBoundary, setIn, setOut,
    addCue, addCueRelative, deleteSelected, moveSelectedToTrack, addTrack, removeTrack,
    renderAll, drawTimeline, renderVideoSub, renderSubList, renderListTrackSel, renderTrackStyle,
    renderCueBlocks, trackFromY, secToEncore, secToSRT, secToASS, newId, ensureTrackCount,
    syncTrackCount, sortCues, onDurationKnown, setZoom, zoomFit, zoomFitVideo, showCueMenu, showPlayerMenu,
    History, recordHistory, renderHistory, addNote, renderNotes, togglePanel,
    parseTimecodeInput, snapVal, snapTargets, neighborBounds, setFps, snapFps, FPS_SET };
}

init();
