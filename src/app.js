/* SUB Tool — 應用主程式（後續逐步拆成更多模組） */
"use strict";
import _logoUrl from './logo.png';
import { clamp, pad, decodeText, encodeUTF16LE, downloadBytes, readFile, pickFile, b64ToBytes, bytesToB64, baseName, escapeHTML } from './util.js';
import { fmtClock, secToSRT, secToASS, secToEncore, srtToSec, assToSec, encoreToSec } from './time.js';
import { SubFormats, splitN } from './formats.js';
import { $, video, tlScroll, tlLayer, tlTracks, rulerCv, waveCv, sublist } from './dom.js';
import { State, newTrack, syncTrackCount, FPS_SET, snapFps, setFps, ensureTrackCount, trackVisible, newId, DESK, IS_DESKTOP, isSel, cueSuffix } from './state.js';
import { Media, Wave } from './media.js';
import { RULER_H, WAVE_H, ROW_H, tracksTop, tracksScrollTop, viewportW, timeToX, xToTime, layoutTimeline, drawRuler, niceStep, fmtTick, drawWave, renderTrackRows, renderCueBlocks, trackFromY, addTrack, removeTrack, moveSelectedToTrack, updatePlayhead, drawTimeline, setZoom, zoomFit, zoomFitVideo, refreshTrackGutterActive } from './timeline.js';
import { renderSubList, renderCheckPanel, buildSubRow, renderSubRow, selectCue, selectCueSingle, refreshSelectionUI, updateTlSel, addCue, addCueAfter, addCueRelative, deleteSelected, deleteCue, sortCues, searchUpdate, searchNav, searchReplace, searchSelectAll } from './subtitles.js';
import { setIn, setOut, nudge, stepBoundary } from './keyboard.js';
import { Project, ensureProjectSaved, isProjectGuardDone, resetProject } from './project.js';
import { showCtx, hideCtx, showCueMenu, showPlayerMenu } from './menus.js';
import { History, recordHistory, renderHistory } from './history.js';
import { addNote, renderNotes, exportNotes, setNoteActive, updateNoteActive } from './notes.js';



/* 提供給子模組使用的膠合函式（app.js 為協調層） */
export { setStatus, showToast, showOsd, openModal, closeModal, onDurationKnown, renderAudioTracks, ensurePlayheadVisible, openNoteInPanel, openCueEditModal, detectFpsWeb, renderAll, renderVideoSub, renderListTrackSel, renderTrackStyle, snapTargets, snapVal, neighborBounds, parseTimecodeInput, togglePanel, renderMixer, doAction, refreshMpvSubs, ensureProjectSaved, isProjectGuardDone };

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
function refreshMpvSubs(){
  if(!Media.mpvMode || !window.subtool?.mpv) return;
  clearTimeout(_mpvSubT);
  _mpvSubT=setTimeout(()=>{
    try{ window.subtool.mpv.subSet(SubFormats.toASS(State.cues,State.fps,State.tracks)).catch(()=>{}); }catch(e){}
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
function renderVideoSub(){
  const t=Media.vTime();
  // 每個可見軌道各依其 posPct 疊加顯示（高度由使用者自行調整）
  let html='';
  for(let tk=0; tk<State.trackCount; tk++){
    if(!trackVisible(tk))continue;
    const cur=State.cues.filter(c=>(c.track||0)===tk && c.timed!==false && (t+0.001)>=c.start && (t+0.001)<c.end);
    if(!cur.length)continue;
    const st=State.tracks[tk]||{};
    const pct=st.posPct!=null?st.posPct:10, fs=st.fontScale||1, al=st.align||'center', col=st.color||'#ffffff';
    html+=`<div class="vsub-track" style="bottom:${pct}%;text-align:${al}">`+
      cur.map((c,i)=>`<span class="line" style="font-size:calc(${fs} * clamp(14px,2.5vw,36px));color:${i===0?col:'#ff4444'}">${escapeHTML(c.text||'')}</span>`).join('<br>')+
      `</div>`;
  }
  $('videoSub').innerHTML=html;
}
function renderAudioTracks(){
  const list=$('atList'); list.innerHTML='';
  const real=Media.tracks.filter(t=>t.kind==='buffer'||t.kind==='native'||t.kind==='nativeTrack'||t.kind==='element');
  // 準備中的占位推桿屬於影片音源；切到外部音源檢視時不顯示
  const _showPending=(Media.activeSource===null||Media.activeSource==='video');
  const pending=_showPending?(Media.pendingChannels||[]).filter(c=>!c.ready):[];
  if(real.length===0 && pending.length===0){ $('atHint').textContent='尚未載入音訊'; if($('mixerPanel')&&$('mixerPanel').classList.contains('show'))renderMixer(); return; }
  $('atHint').textContent=(real.length+pending.length)+' 條音軌'+(pending.length?'（準備中…）':'');
  for(const tr of real){
    const row=document.createElement('div');row.className='atrack';
    row.innerHTML=
      `<span class="nm">${escapeHTML(tr.name)}</span>`+
      `<button class="mini mute ${tr.muted?'on':''}" title="${tr.muted?'取消靜音':'靜音'}">${tr.muted?'🔇':'🔊'}</button>`+
      `<button class="mini solo ${tr.solo?'on':''}" title="${tr.solo?'取消獨奏':'獨奏'}">⊙</button>`+
      `<input type="range" min="0" max="1.5" step="0.01" value="${tr.volume}">`;
    const [muteBtn,soloBtn]=row.querySelectorAll('button');
    const vol=row.querySelector('input');
    muteBtn.onclick=()=>{tr.muted=!tr.muted;Media.applyGains();renderAudioTracks();};
    soloBtn.onclick=()=>{tr.solo=!tr.solo;Media.applyGains();renderAudioTracks();};
    vol.oninput=()=>{tr.volume=+vol.value;Media.applyGains();};
    list.appendChild(row);
  }
  for(const pc of pending){
    const row=document.createElement('div');row.className='atrack pending';
    row.innerHTML=`<span class="nm">${escapeHTML(pc.label)}</span><span class="prep"><span class="spin"></span>準備中</span>`;
    list.appendChild(row);
  }
  renderAudioSources();
  if($('mixerPanel')&&$('mixerPanel').classList.contains('show'))renderMixer();
}

function renderAudioSources(){
  const src=Media.activeSource;
  const sel=$('mixerSrcSel');
  const selWave=$('waveGlobalSrcSel');
  if(!sel && !selWave) return;
  const srcs=Media.getSources();
  const updateSel = (sNode) => {
    if(!sNode)return;
    if(srcs.length===0){ sNode.innerHTML='<option value="">(無音源)</option>'; sNode.disabled=true; }
    else {
      sNode.innerHTML='';
      for(const s of srcs){
        const opt=document.createElement('option');
        opt.value=s.id; opt.textContent=s.label;
        if(s.id===src) opt.selected=true;
        sNode.appendChild(opt);
      }
      sNode.disabled=false;
    }
  };
  updateSel(sel); updateSel(selWave);
}

/* ===== 混音器：逐聲道電平表 + 獨奏/靜音（浮動面板） ===== */
let _meterStrips=[];
function renderMixer(){
  const wrap=$('mixerStrips'); if(!wrap)return;
  _meterStrips=[];
  const src=Media.activeSource;

  const real=Media.tracks.filter(t=>{
    if(!(t.kind==='buffer'||t.kind==='native'||t.kind==='element'))return false;
    if(src!==null&&(t.source||'video')!==src)return false;
    return true;
  });
  const _showPending=(Media.activeSource===null||Media.activeSource==='video');
  const pending=_showPending?(Media.pendingChannels||[]).filter(c=>!c.ready):[];
  if(!real.length && !pending.length){ wrap.innerHTML='<div class="empty" style="padding:14px;white-space:nowrap">尚無音訊聲道</div>'; return; }
  wrap.innerHTML='';
  for(const tr of real){
    const strip=document.createElement('div'); strip.className='mx-strip';
    const vol=Math.round((tr.volume==null?1:tr.volume)*100);
    strip.innerHTML=
      `<div class="mx-meter"><div class="mx-mask"></div><div class="mx-peak"></div>`+
        `<input class="mx-fader" type="range" min="0" max="100" step="1" value="${vol}" title="音量 ${vol}%">`+
      `</div>`+
      `<div class="mx-name" title="${escapeHTML(tr.name)}">${escapeHTML(tr.name)}</div>`+
      `<div class="mx-btns">`+
        `<button class="mx-solo${tr.solo?' on':''}" title="${tr.solo?'取消獨奏':'獨奏'}">⊙ 獨奏</button>`+
        `<button class="mx-mute${tr.muted?' on':''}" title="${tr.muted?'取消靜音':'靜音'}">${tr.muted?'🔇':'🔊'} 靜音</button>`+
      `</div>`;
    const fader=strip.querySelector('.mx-fader');
    fader.oninput=()=>{ tr.volume=(+fader.value)/100; fader.title='音量 '+fader.value+'%'; Media.applyGains(); };
    fader.addEventListener('mousedown',e=>e.stopPropagation()); // 不要觸發面板拖移
    strip.querySelector('.mx-solo').onclick=()=>{ tr.solo=!tr.solo; Media.applyGains(); renderMixer(); renderAudioTracks(); };
    strip.querySelector('.mx-mute').onclick=()=>{ tr.muted=!tr.muted; Media.applyGains(); renderMixer(); renderAudioTracks(); };
    wrap.appendChild(strip);
    _meterStrips.push({tr, mask:strip.querySelector('.mx-mask'), peak:strip.querySelector('.mx-peak')});
  }
  for(const pc of pending){
    const strip=document.createElement('div'); strip.className='mx-strip pending';
    strip.innerHTML=
      `<div class="mx-meter"><div class="mx-prep"><span class="spin"></span></div></div>`+
      `<div class="mx-name" title="${escapeHTML(pc.label)}">${escapeHTML(pc.label)}</div>`+
      `<div class="mx-btns"><div class="mx-preplabel">準備中…</div></div>`;
    wrap.appendChild(strip);
  }
}
function _mixerTracks(){
  const src=Media.activeSource;
  return Media.tracks.filter(t=>{
    if(!(t.kind==='buffer'||t.kind==='native'||t.kind==='element'))return false;
    if(src!==null&&(t.source||'video')!==src)return false;
    return true;
  });
}
function mixerReset(){ for(const t of _mixerTracks()){ t.solo=false; t.muted=false; } Media.applyGains(); renderMixer(); renderAudioTracks(); }
function mixerMuteAll(){ for(const t of _mixerTracks()){ t.solo=false; t.muted=true; } Media.applyGains(); renderMixer(); renderAudioTracks(); }

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
    `<div style="font-size:12px;color:var(--muted);margin-top:8px">說明：開啟影片時會把每個聲道與波形轉存到「影片同資料夾的 <code>.cache</code>」內，其他電腦讀取同一個檔案時可直接沿用、不必重算。此處管理的是本機的中央快取。</div>`+
    `</div>`;
  const buttons=[
    {label:'清理孤兒檔',act:async()=>{ const r=await DESK.cacheCleanOrphans(); showToast(`已清理 ${r.removed} 個無效項目，釋放 ${_fmtBytes(r.bytes)}`); openCacheDialog(); }},
    {label:'全部清除',act:()=>{
      openModal('確認清除','<div style="padding:6px 2px">將刪除所有中央快取，以及目前開啟影片旁的 .cache 資料夾。<br>下次開啟同檔需重新轉檔。確定？</div>',
        [{label:'確定清除',primary:true,act:async()=>{ const r=await DESK.cacheClearAll(State.mediaPath||null); showToast(`已清除快取，釋放 ${_fmtBytes(r.bytes)}`); closeModal(); }},{label:'取消',act:openCacheDialog}]);
    }},
    {label:'關閉',primary:true,act:closeModal},
  ];
  openModal('🗂 轉檔快取',html,buttons);
}
function updateMeters(){
  const panel=$('mixerPanel'); if(!panel||!panel.classList.contains('show')||!_meterStrips.length)return;
  const now=performance.now();
  for(const s of _meterStrips){
    const tr=s.tr; let lvl=0;
    if(tr.analyser&&tr._mbuf){
      tr.analyser.getFloatTimeDomainData(tr._mbuf);
      let mx=0; const b=tr._mbuf; for(let i=0;i<b.length;i++){ const v=Math.abs(b[i]); if(v>mx)mx=v; }
      lvl=mx;
    }
    tr.level=Math.max(lvl,(tr.level||0)*0.82); // 平滑衰減
    const db=tr.level>1e-4?20*Math.log10(tr.level):-60;
    const h=Math.max(0,Math.min(100,(db+60)/60*100));
    s.mask.style.height=(100-h)+'%';
    if(h>=(tr._peakH||0)){ tr._peakH=h; tr.peakT=now; }
    else if(now-(tr.peakT||0)>900){ tr._peakH=Math.max(0,(tr._peakH||0)-1.6); }
    s.peak.style.bottom=(tr._peakH||0)+'%';
  }
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
  if(State.pxPerSec*State.duration < vw) zoomFitVideo(); else drawTimeline();
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
    drawRuler(); drawWave(); renderCueBlocks(); // sync immediately; don't wait for passive scroll event
  }
}

/* 影片事件 */
video.addEventListener('timeupdate',()=>{
  $('tcCur').textContent=secToEncore(video.currentTime,State.fps,State.dropFrame); // 時:分:秒:格
  $('seekBar').value=Math.round(video.currentTime*1000);
});
let rafOn=false, rafFrame=0, _rafLastIdx=0;
function rafLoop(){
  if(Media.playing){
    const t=Media.vTime();
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
  if(row){row.classList.add('active');row.scrollIntoView({block:'nearest'});}
}
video.addEventListener('play',()=>{Media.playing=true;$('playBtn').textContent='⏸';});
video.addEventListener('pause',()=>{$('playBtn').textContent='▶';});
video.addEventListener('seeked',()=>{updatePlayhead();renderVideoSub();updateNoteActive(video.currentTime);});
window.addEventListener('mpv:seeked',e=>{updatePlayhead();renderVideoSub();updateNoteActive(e.detail);});
video.addEventListener('ended',()=>{Media.pause();});

/* seek bar */
$('seekBar').addEventListener('input',e=>{ const t=(+e.target.value)/1000; Media.seek(t); updateNoteActive(t); });
// rateSel removed from UI — speed controlled via JKL keys
$('fpsSel').addEventListener('change',e=>{ const prev=State.fps,prevDf=State.dropFrame; setFps(e.target.value); renderSubList(); renderNotes(); recordHistory(`切換 FPS ${prevDf?prev+'df':prev}→${State.fps+(State.dropFrame?'df':'')}`); e.target.blur(); });
$('zoomBar').addEventListener('input',e=>setZoom(+e.target.value));

/* 狀態列 / toast / modal */
function setStatus(msg,kind){ $('stMsg').textContent=msg; const d=$('stDot'); d.className='dot'+(kind?(' '+kind):''); }
let toastT;
function showToast(msg){ const t=$('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'),3500); }
let _osdT;
function showOsd(text){ const el=$('speedOsd'); if(!el)return; el.textContent=text; el.classList.add('show'); clearTimeout(_osdT); _osdT=setTimeout(()=>el.classList.remove('show'),1000); }
function openModal(title,html,buttons){
  $('modalTitle').textContent=title; $('modalBody').innerHTML=html;
  const foot=$('modalFoot'); foot.innerHTML='';
  (buttons||[{label:'關閉',primary:true,act:closeModal}]).forEach(b=>{
    const btn=document.createElement('button'); btn.textContent=b.label; if(b.primary)btn.className='primary';
    btn.onclick=b.act; foot.appendChild(btn);
  });
  $('modalBg').classList.add('show');
  // mpv 覆蓋視窗會蓋住置中的對話框，開啟對話框時先隱藏
  if(Media.mpvMode && window.subtool?.mpv) window.subtool.mpv.show(false).catch(()=>{});
}
function closeModal(){
  $('modalBg').classList.remove('show');
  if(Media.mpvMode && window.subtool?.mpv) window.subtool.mpv.show(true).catch(()=>{});
}
$('modalBg').addEventListener('mousedown',e=>{if(e.target===$('modalBg'))closeModal();});
$('modalBg').addEventListener('keydown',e=>{
  if(e.key==='Enter' && e.target.tagName!=='TEXTAREA'){
    e.preventDefault(); e.stopPropagation();
    $('modalFoot')?.querySelector('button.primary')?.click();
  }
},true);


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
    case 'new': if(confirm('清空目前專案？字幕、備註與已載入的影音都將清除（未存檔的話）。')){
      State.cues=[];State.notes=[];State.selectedId=null;State.selectedIds=[];
      State.listTrack=0;State.tracks=[];syncTrackCount();
      State.subMode=false;const smb=$('subModeBtn');if(smb)smb.classList.remove('sub-active');
      History.reset();resetProject();
      // 清除影音
      video.pause(); video.src='';
      State.mediaName=''; State.mediaPath=''; State.mediaSize=0;
      Media.reset();
      const nv=$('noVideo'); if(nv) nv.style.display='';
      onDurationKnown(); renderAudioTracks();
      renderListTrackSel();renderAll();renderNotes();drawTimeline();
      setStatus('新專案','ok');
    } break;
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
    case 'playpause': Media.toggle(); break;
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
    case 'close-notes': $('notesPanel').classList.remove('show'); _syncMpvPanel(); break;
    case 'mixer': togglePanel('mixerPanel'); renderMixer(); break;
    case 'close-mixer': $('mixerPanel').classList.remove('show'); _syncMpvPanel(); break;
    case 'mixer-reset': mixerReset(); break;
    case 'mixer-muteall': mixerMuteAll(); break;
    case 'cache-manage': openCacheDialog(); break;
    case 'export-notes': exportNotes(); break;
    case 'toggle-all-vis': { const anyVis=State.tracks.some(t=>t.visible!==false); State.tracks.forEach(t=>t.visible=!anyVis); drawTimeline(); renderVideoSub(); } break;
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

/* // 或 \\ 換行符號轉換（匯入後套用） */
function convertLineBreaks(parsed){
  for(const p of parsed){ if(p.text) p.text=p.text.replace(/\/\//g,'\n').replace(/\\\\/g,'\n'); }
  return parsed;
}
/* 格式自動辨識 */
function detectSubFormat(text, ext){
  if(ext==='srt')return 'srt';
  if(ext==='ass'||ext==='ssa')return 'ass';
  if(/\[Script Info\]/i.test(text))return 'ass';
  if(/^\d+\r?\n\d{2}:\d{2}:\d{2}[,\.]\d{3}/m.test(text))return 'srt';
  if(/\d{1,2}:\d{2}:\d{2}:\d{2}[ \t]+\d{1,2}:\d{2}:\d{2}:\d{2}/m.test(text))return 'encore';
  return 'txt';
}
/* 匯入 / 匯出字幕 */
function _askFpsModal(){
  return new Promise(resolve=>{
    const FPS_OPTS=[
      {v:'23.976',l:'23.98'},{v:'24',l:'24'},{v:'25',l:'25'},
      {v:'29.97df',l:'29.97 (Drop-frame)'},{v:'29.97',l:'29.97 (Non-Drop-frame)'},{v:'30',l:'30'},
    ];
    const opts=FPS_OPTS.map(o=>`<option value="${o.v}"${o.v==='29.97'?' selected':''}>${o.l}</option>`).join('');
    openModal('選擇影格率 (FPS)',
      `<p style="margin:0 0 12px;font-size:13px;color:var(--text-faint)">尚未載入影片，請先設定字幕的影格率。</p>`+
      `<label>FPS：<select id="importFpsSel" style="margin-left:6px">${opts}</select></label>`,
      [{label:'確定',primary:true,act:()=>{ const val=$('importFpsSel').value; closeModal(); resolve(val); }},
       {label:'取消',act:()=>{ closeModal(); resolve(null); }}]
    );
  });
}
async function importSub(){
  let text, fileName='';
  if(IS_DESKTOP){
    const r=await DESK.importSub('any'); if(!r)return;
    text=decodeText(b64ToBytes(r.b64).buffer); fileName=r.name||'';
  }else{
    const f=await pickFile($('fileSub')); if(!f)return;
    const buf=await readFile(f); text=decodeText(buf); fileName=f.name;
  }
  if(!State.mediaName){
    const fpsVal=await _askFpsModal(); if(fpsVal===null)return;
    setFps(fpsVal);
  }
  const ext=(fileName.split('.').pop()||'').toLowerCase();
  const kind=detectSubFormat(text, ext);
  let parsed=[];
  try{
    if(kind==='srt')parsed=SubFormats.parseSRT(text);
    else if(kind==='ass')parsed=SubFormats.parseASS(text);
    else if(kind==='encore')parsed=SubFormats.parseEncore(text,State.fps,State.dropFrame);
    else parsed=SubFormats.parseTXT(text);
  }catch(e){ showToast('解析失敗：'+e.message); return; }
  if(parsed.length===0){ showToast('未解析到字幕（檢查格式/編碼）'); return; }
  convertLineBreaks(parsed);

  _openImportModal(`匯入字幕到哪個軌道？（已辨識為 ${kind.toUpperCase()}，${parsed.length} 條）`, parsed, kind);
}
function _openImportModal(title, parsed, kind){
  const trackOpts=State.tracks.map((tk,i)=>`<option value="${i}">軌道 ${i+1}：${escapeHTML(tk.name)}</option>`).join('');
  const suggestName=kind.toUpperCase()+' 字幕';
  openModal(title,
    `<label style="display:block;padding:8px 0">目標軌道：<select id="importTkSel" style="margin-left:6px">${trackOpts}<option value="new" selected>＋ 新增軌道…</option></select></label>`+
    `<div id="importNewTkRow" style="padding-bottom:8px">軌道名稱：<input type="text" id="importNewTkName" style="margin-left:6px;width:160px" value="${escapeHTML(suggestName)}"></div>`+
    `<label style="display:block;padding-bottom:8px"><input type="checkbox" id="importAppend"> 附加（保留現有字幕）</label>`,
    [{label:'匯入',primary:true,act:()=>{
      const selVal=$('importTkSel').value;
      let targetTk;
      if(selVal==='new'){
        const tkName=($('importNewTkName').value.trim())||('軌道 '+(State.tracks.length+1));
        State.tracks.push(newTrack(tkName)); syncTrackCount();
        targetTk=State.tracks.length-1;
      }else{ targetTk=+selVal; }
      const append=selVal==='new'||$('importAppend').checked;
      closeModal();
      const newCues=parsed.map(p=>({id:newId(),start:p.start||0,end:p.end||0,text:p.text||'',track:targetTk,
        timed:p.timed!==false&&!(p.start===0&&p.end===0&&kind==='txt')}));
      if(kind==='txt')newCues.forEach(c=>c.timed=false);
      if(append){ State.cues.push(...newCues); }
      else { State.cues=newCues; }
      State.listTrack=targetTk;
      State.selectedId=newCues[0]?.id||null; State.selectedIds=State.selectedId?[State.selectedId]:[];
      sortCues(); renderListTrackSel(); renderAll();
      { const maxEnd=State.cues.reduce((m,c)=>c.timed!==false?Math.max(m,c.end):m,0);
        if(maxEnd>State.duration){State.duration=maxEnd;onDurationKnown();}else drawTimeline(); }
      recordHistory('匯入字幕 '+kind.toUpperCase());
      setStatus(`已匯入 ${parsed.length} 條字幕到「${State.tracks[targetTk]?.name}」(${kind.toUpperCase()})`, 'ok');
      showToast(`匯入 ${parsed.length} 條字幕`);
    }},{label:'取消',act:closeModal}]);
  setTimeout(()=>{
    const sel=$('importTkSel'), row=$('importNewTkRow'), nm=$('importNewTkName');
    if(sel) sel.addEventListener('change',()=>{
      const isNew=sel.value==='new';
      row.style.display=isNew?'block':'none';
      if(isNew){ nm.focus(); nm.select(); }
    });
  },20);
}
function showExportDialog(){
  if(State.cues.length===0){ showToast('沒有字幕可匯出'); return; }
  const fmtOpts=[['SRT (.srt)','srt'],['ASS (.ass)','ass'],['Adobe Encore (.txt)','encore'],['純文字 (.txt)','txt']]
    .map(([label,val])=>`<option value="${val}">${label}</option>`).join('');
  if(State.trackCount>1){
    const trkBoxes='<div style="padding:6px 0 2px">選擇要匯出的軌道（每軌各自一個檔案）：</div>'+
      State.tracks.map((tk,i)=>`<label style="display:block;padding:3px 0"><input type="checkbox" data-tk="${i}" checked> ${escapeHTML(tk.name)} <span style="color:var(--text-faint)">(${State.cues.filter(c=>(c.track||0)===i).length} 條)</span></label>`).join('');
    openModal('匯出字幕',
      `<label style="display:block;padding:4px 0">格式：<select id="expFmtSel" style="margin-left:6px">${fmtOpts}</select></label>${trkBoxes}`,
      [{label:'匯出',primary:true,act:()=>{
        const kind=$('expFmtSel').value;
        const checked=[...document.querySelectorAll('#modalBody input[data-tk]')].filter(b=>b.checked).map(b=>+b.dataset.tk);
        closeModal();
        for(const i of checked){ const cues=State.cues.filter(c=>(c.track||0)===i); if(cues.length)doExport(kind,cues,State.tracks[i]?.name); }
      }},{label:'取消',act:closeModal}]);
  }else{
    openModal('匯出字幕',
      `<label style="display:block;padding:4px 0">格式：<select id="expFmtSel" style="margin-left:6px">${fmtOpts}</select></label>`,
      [{label:'匯出',primary:true,act:()=>{ closeModal(); doExport($('expFmtSel').value,State.cues); }},{label:'取消',act:closeModal}]);
  }
}
function showShiftTcDialog(){
  openModal('時間碼位移',
    `<div style="margin-bottom:8px">輸入位移量（<code>+</code> 往後、<code>-</code> 往前）<br>格式：±時:分:秒:格　例如 <code>+00:00:02:00</code> 或 <code>-1:30</code></div>`+
    `<input id="tcShiftInput" placeholder="+00:00:02:00" style="width:200px;font-family:monospace;font-size:14px"><br>`+
    `<label style="display:block;margin-top:8px">套用到：<select id="tcShiftSel" style="margin-left:6px">`+
    `<option value="sel">已選取的字幕</option>`+
    `<option value="track">目前軌道所有字幕</option>`+
    `<option value="all">全部軌道所有字幕</option>`+
    `</select></label>`,
    [{label:'套用',primary:true,act:()=>{
      const raw=$('tcShiftInput').value.trim();
      const sign=raw.startsWith('-')?-1:1;
      const t=parseTimecodeInput(raw.replace(/^[+-]/,''));
      if(t==null||isNaN(t)){ showToast('無法解析時間碼'); return; }
      const delta=sign*t;
      const scope=$('tcShiftSel').value;
      let cues;
      if(scope==='sel'){
        const ids=State.selectedIds.length?State.selectedIds:[State.selectedId].filter(Boolean);
        cues=ids.map(id=>State.cues.find(c=>c.id===id)).filter(c=>c&&c.timed!==false);
      }else if(scope==='track'){
        cues=State.cues.filter(c=>c.timed!==false&&(c.track||0)===State.listTrack);
      }else{
        cues=State.cues.filter(c=>c.timed!==false);
      }
      if(!cues.length){ showToast('沒有字幕可以位移'); return; }
      for(const c of cues){ c.start=Math.max(0,c.start+delta); c.end=Math.max(c.start+0.001,c.end+delta); }
      closeModal(); sortCues(); renderAll(); drawTimeline();
      recordHistory('時間碼位移');
      setStatus(`已位移 ${delta>=0?'+':''}${delta.toFixed(3)}s（共 ${cues.length} 條）`,'ok');
    }},{label:'取消',act:closeModal}]);
}
function exportSub(kind){
  if(State.cues.length===0){ showToast('沒有字幕可匯出'); return; }
  if(State.trackCount>1){
    for(let i=0;i<State.tracks.length;i++){
      const cues=State.cues.filter(c=>(c.track||0)===i); if(cues.length)doExport(kind,cues,State.tracks[i]?.name);
    }
  }else doExport(kind,State.cues);
}
function doExport(kind,cues,trackName){
  if(!cues.length){ showToast('所選軌道沒有字幕'); return; }
  const base=(State.mediaName? State.mediaName.replace(/\.[^.]+$/,'') : 'subtitle');
  const tkSuffix=trackName?'_'+trackName.replace(/[\\/:*?"<>|]/g,'_'):'';
  let text,ext;
  if(kind==='srt'){ text=SubFormats.toSRT(cues,State.fps); ext='.srt'; }
  else if(kind==='ass'){ text=SubFormats.toASS(cues,State.fps,State.tracks); ext='.ass'; }
  else if(kind==='encore'){ text=SubFormats.toEncore(cues,State.fps,State.dropFrame); ext='.txt'; }
  else { text=SubFormats.toTXT(cues); ext='.txt'; }
  const bytes=encodeUTF16LE(text);
  const fname=base+tkSuffix+(kind==='encore'?'_encore':'')+ext;
  if(IS_DESKTOP){
    DESK.exportSub(fname,bytesToB64(bytes),ext.replace('.','')).then(pth=>{ if(pth){setStatus('已匯出：'+pth,'ok');showToast('已匯出 '+baseName(pth));} });
  }else{
    downloadBytes(bytes, fname, 'text/plain;charset=utf-16le');
    setStatus(`已匯出 ${kind.toUpperCase()}（UTF-16 LE）`,'ok');
    showToast(`已匯出 ${fname}`);
  }
}

/* 拖放檔案 */
['dragover','dragenter'].forEach(ev=>document.addEventListener(ev,e=>{e.preventDefault();$('videoWrap').classList.add('dragover');}));
['dragleave','drop'].forEach(ev=>document.addEventListener(ev,e=>{e.preventDefault();if(ev!=='drop'&&e.relatedTarget)return;$('videoWrap').classList.remove('dragover');}));
document.addEventListener('drop',async e=>{
  e.preventDefault(); $('videoWrap').classList.remove('dragover');
  const f=e.dataTransfer.files[0]; if(!f)return;
  const ext=(f.name.split('.').pop()||'').toLowerCase();
  if(['subtool','json'].includes(ext))Project.load(f);
  else if(['srt','ass','ssa','txt'].includes(ext)){importDropped(f);}
  else Media.loadVideoFile(f);
});
async function importDropped(f){
  const buf=await readFile(f); const text=decodeText(buf);
  const ext=(f.name.split('.').pop()||'').toLowerCase();
  const kind=detectSubFormat(text,ext);
  let parsed;
  if(kind==='srt')parsed=SubFormats.parseSRT(text);
  else if(kind==='ass')parsed=SubFormats.parseASS(text);
  else if(kind==='encore')parsed=SubFormats.parseEncore(text,State.fps);
  else parsed=SubFormats.parseTXT(text);
  if(!parsed.length){showToast('未解析到字幕');return;}
  convertLineBreaks(parsed);
  _openImportModal(`拖入字幕（${kind.toUpperCase()}，${parsed.length} 條）`, parsed, kind);
}

/* 說明 */
function showHelp(){
  openModal('鍵盤快捷鍵 / 使用說明',
  `<b>三大區塊</b>：播放窗（左上）· 字幕列表（右）· 時間軸（下）。<br>`+
  `<b>上字幕流程</b>：選一條字幕 → 播到開始處按 <kbd>I</kbd>、播到結束處按 <kbd>O</kbd>。<br><br>`+
  `<b>▍播放控制</b>
  <table class="keys">
   <tr><td><kbd>Space</kbd></td><td>播放 / 暫停</td></tr>
   <tr><td><kbd>J</kbd></td><td>倒帶（每按一次加速：1× → 1.5× → 2× → 2.5× → 3× → 循環）</td></tr>
   <tr><td><kbd>K</kbd></td><td>停止 / 暫停</td></tr>
   <tr><td><kbd>L</kbd></td><td>正播加速（1× → 1.5× → 2× → 2.5× → 3× → 循環）</td></tr>
   <tr><td><kbd>←</kbd> / <kbd>→</kbd></td><td>前 / 後一格</td></tr>
   <tr><td><kbd>Shift</kbd>+<kbd>←</kbd><kbd>→</kbd></td><td>前 / 後 1 秒</td></tr>
   <tr><td><kbd>Ctrl</kbd>+<kbd>←</kbd><kbd>→</kbd></td><td>前 / 後 5 秒</td></tr>
   <tr><td>按住 <kbd>←</kbd> / <kbd>→</kbd></td><td>1× 速度連續倒帶 / 正播（放開停止）</td></tr>
   <tr><td><kbd>Home</kbd> / <kbd>Shift</kbd>+<kbd>↑</kbd></td><td>跳到開頭（00:00:00:00）</td></tr>
   <tr><td><kbd>End</kbd> / <kbd>Shift</kbd>+<kbd>↓</kbd></td><td>跳到片尾</td></tr>
  </table><br>`+
  `<b>▍字幕操作</b>
  <table class="keys">
   <tr><td><kbd>I</kbd></td><td>設定被選字幕的<b>起點</b>＝目前播放點（無選取則新增一條）</td></tr>
   <tr><td><kbd>O</kbd></td><td>設定被選字幕的<b>終點</b>＝目前播放點</td></tr>
   <tr><td><kbd>↑</kbd> / <kbd>↓</kbd></td><td>步進邊界點（起點 → 終點 → 下句起點…）</td></tr>
   <tr><td><kbd>Ctrl</kbd>+<kbd>↑</kbd></td><td>跳到<b>上一句</b>起點並選取</td></tr>
   <tr><td><kbd>Ctrl</kbd>+<kbd>↓</kbd></td><td>跳到<b>下一句</b>起點並選取</td></tr>
   <tr><td><kbd>Shift</kbd>+<kbd>Home</kbd></td><td>選取目前軌道<b>第一句</b>字幕，播放點跳到其起點</td></tr>
   <tr><td><kbd>Shift</kbd>+<kbd>End</kbd></td><td>選取目前軌道<b>最後一句</b>字幕，播放點跳到其起點</td></tr>
   <tr><td><kbd>P</kbd></td><td>將選取字幕整批位移到播放點</td></tr>
   <tr><td><kbd>Enter</kbd></td><td>開啟選取字幕的<b>文字編輯</b>視窗</td></tr>
   <tr><td><kbd>Del</kbd> / <kbd>Backspace</kbd></td><td>刪除選取（支援多選）</td></tr>
   <tr><td><kbd>Esc</kbd></td><td>取消所有選取 / 關閉上字幕模式</td></tr>
  </table><br>`+
  `<b>▍選取</b>
  <table class="keys">
   <tr><td><kbd>點選</kbd></td><td>選取單一字幕並跳到其起點；若已是單選且播放點在字幕範圍內，則不移動播放點</td></tr>
   <tr><td><kbd>Ctrl</kbd>+點</td><td>多選 / 取消單一</td></tr>
   <tr><td><kbd>Shift</kbd>+點</td><td>範圍選取（同軌道）</td></tr>
  </table><br>`+
  `<b>▍文字編輯（字幕列表內嵌 ＆ 編輯視窗）</b>
  <table class="keys">
   <tr><td><kbd>Enter</kbd></td><td>確認並離開編輯</td></tr>
   <tr><td><kbd>Shift</kbd>+<kbd>Enter</kbd></td><td>換行</td></tr>
   <tr><td><kbd>Ctrl</kbd>+<kbd>Enter</kbd></td><td><b>拆分字幕</b>：游標前文字留在原句（out 點 = 播放點），游標後文字移至新句（in 點 = 播放點）；播放點須在字幕起訖範圍內</td></tr>
   <tr><td><kbd>Esc</kbd></td><td>取消 / 關閉視窗</td></tr>
  </table><br>`+
  `<b>▍時間碼輸入</b><br>`+
  `所有時間輸入欄（字幕起訖點、播放點時間碼）皆支援以下格式：
  <table class="keys">
   <tr><td><code>01:23:45:12</code></td><td>絕對時間碼（時:分:秒:格）</td></tr>
   <tr><td><code>1234512</code></td><td>緊湊格式，系統自動補位（= 01:23:45:12）</td></tr>
   <tr><td><code>+100</code></td><td>相對<b>加</b>：在原時間上加 1 秒（100 = 1秒0格）</td></tr>
   <tr><td><code>-200</code></td><td>相對<b>減</b>：在原時間上減 2 秒（結果不可早於 00:00:00:00）</td></tr>
  </table><br>`+
  `<b>▍其他快捷</b>
  <table class="keys">
   <tr><td><kbd>Ctrl</kbd>+<kbd>Z</kbd></td><td>復原</td></tr>
   <tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd></td><td>重做</td></tr>
   <tr><td><kbd>Ctrl</kbd>+<kbd>S</kbd></td><td>儲存專案</td></tr>
   <tr><td><kbd>Ctrl</kbd>+<kbd>F</kbd></td><td>搜尋 / 取代</td></tr>
   <tr><td><kbd>Shift</kbd>+<kbd>Z</kbd></td><td>時間軸適配（顯示全部字幕）</td></tr>
   <tr><td><kbd>-</kbd> / <kbd>+</kbd></td><td>時間軸縮小 / 放大</td></tr>
  </table><br>`+
  `<b>▍介面說明</b><br>`+
  `<b>播放窗</b>：時間碼格式「時:分:秒:格」；<b>雙擊</b>時間數字可直接輸入（支援絕對時間碼或 +/- 相對位移）；<b>右鍵</b>時間數字可複製；畫面右鍵選音軌/速度；匯入影音時自動偵測 FPS（23.976/24/25/29.97/30）。<br>`+
  `<b>字幕列表</b>：上方下拉切換軌道；下方調整字幕大小／位置／顏色；<b>⬆＋ / ⬇＋</b> 在上/下方新增；右鍵選單可移軌道、調整選取範圍；雙擊字幕起訖時間碼可直接編輯（支援 +/- 相對位移）。<br>`+
  `<b>時間軸</b>：時間尺/波形區拖曳＝移動播放點；軌道空白區按住拖曳＝框選；拖字幕區塊＝移動（支援換軌、磁吸、防重疊）；拖邊緣＝調整起訖；雙擊字幕＝編輯文字；🔊 波形列右側下拉選單可切換顯示的音源聲道。<br>`+
  `<b>軌道</b>：＋軌道 新增、✕ 刪除、👁 顯示/隱藏；雙擊名稱改名；拖曳 ⠿ 重排順序；<b>拖曳軌道列或波形列底部邊框</b>可調整列高，雙擊邊框復位預設高度；匯出時多軌各自輸出獨立檔案。<br>`+
  `<b>🕘 紀錄 / 📌 備忘</b>：時間軸工具列開啟浮動面板；備忘可點時間跳轉；時間碼位移面板可對選取字幕批次加減時間。`);
}

/* ===== 播放窗：自動偵測 FPS（網頁版，播放時取樣） ===== */
function detectFpsWeb(){
  if(!('requestVideoFrameCallback' in HTMLVideoElement.prototype))return;
  let last=null, deltas=[], frames=0;
  const cb=(now,meta)=>{
    if(last!=null){ const d=meta.mediaTime-last; if(d>0.0005)deltas.push(d); }
    last=meta.mediaTime; frames++;
    if(deltas.length<12 && frames<60){ try{video.requestVideoFrameCallback(cb);}catch(e){} return; }
    if(deltas.length>=6){ deltas.sort((a,b)=>a-b); const med=deltas[deltas.length>>1]; const fps=Math.round(1/med);
      if(fps>=10&&fps<=120){ State.fps=snapFps(fps); $('fpsSel').value=State.dropFrame?String(State.fps)+'df':String(State.fps);
        $('tcDur').textContent=secToEncore(State.duration,State.fps,State.dropFrame); $('tcCur').textContent=secToEncore(video.currentTime||0,State.fps,State.dropFrame);
        setStatus('偵測到影片 FPS：'+fps,'ok'); } }
  };
  try{ video.requestVideoFrameCallback(cb); }catch(e){}
}

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
  $('tsColor').value=tk.color||'#ffffff';
  const szSel=$('tsSizeSel'); if(szSel){ const sv=String(sz); szSel.value=[...szSel.options].some(o=>o.value===sv)?sv:'1'; }
  const psSel=$('tsPosSel'); if(psSel){ const pv=String(pp); psSel.value=[...psSel.options].some(o=>o.value===pv)?pv:'10'; }
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
        `<div style="white-space:pre-wrap;font-size:14px;font-family:inherit;color:var(--text);user-select:text;cursor:text">${escapeHTML(text)}</div>`+
      `</div>`+
    `</div>`;

  const sibHtml=siblings.map(s=>mkBlock('軌道：'+s.trackName,s.text,'cueEditCopySib'+s.tkIdx)).join('');

  const doConfirm=()=>{
    const val=$('cueEditTa').value;
    c.text=val; closeModal(); renderAll(); renderVideoSub();
    if(val!==orig) recordHistory('編輯字幕文字'+cueSuffix(c));
  };
  openModal('修改字幕文字',
    `<div style="font-size:12px;color:var(--text-faint);margin-bottom:10px">${escapeHTML(trackName)} ｜ ${tc}</div>`+
    `<div style="max-height:58vh;overflow-y:auto;padding-right:2px">`+
    sibHtml+
    mkBlock('原文',orig,'cueEditCopy')+
    `<div style="font-size:12px;color:var(--text-faint);margin-bottom:4px">修改 <span style="font-size:10px;opacity:.5">（Enter 確認 · Shift+Enter 換行）</span></div>`+
    `<textarea id="cueEditTa" rows="4" style="width:100%;resize:vertical;font-size:14px;font-family:inherit;padding:6px;box-sizing:border-box"></textarea>`+
    `</div>`,
    [{label:'確認',primary:true,act:doConfirm},{label:'取消',act:closeModal}]);
  setTimeout(()=>{
    const ta=$('cueEditTa');
    if(ta){
      ta.value=orig; ta.focus(); ta.select();
      ta.addEventListener('keydown',e=>{
      if(e.key==='Enter'&&e.ctrlKey){
        e.preventDefault();
        const offset=ta.selectionStart;
        const full=ta.value;
        const textBefore=full.slice(0,offset);
        const textAfter=full.slice(offset);
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
  $('tsSize').addEventListener('input',e=>{ const i=State.listTrack; if(!State.tracks[i])return; State.tracks[i].fontScale=clamp(+e.target.value,0.5,3); renderVideoSub(); refreshMpvSubs(); });
  $('tsSize').addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key==='Escape'){e.preventDefault();e.target.blur();} });
  $('tsPos').addEventListener('input',e=>{ const i=State.listTrack; if(!State.tracks[i])return; State.tracks[i].posPct=clamp(+e.target.value,0,92); renderVideoSub(); refreshMpvSubs(); });
  $('tsPos').addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key==='Escape'){e.preventDefault();e.target.blur();} });
  $('tsColor').addEventListener('input',e=>{ const i=State.listTrack; if(!State.tracks[i])return; State.tracks[i].color=e.target.value; renderVideoSub(); refreshMpvSubs(); });
  $('tsSizeSel').addEventListener('change',e=>{ const v=+e.target.value; $('tsSize').value=v; const i=State.listTrack; if(State.tracks[i]){ State.tracks[i].fontScale=v; renderVideoSub(); refreshMpvSubs(); } e.target.blur(); });
  $('tsPosSel').addEventListener('change',e=>{ const v=+e.target.value; $('tsPos').value=v; const i=State.listTrack; if(State.tracks[i]){ State.tracks[i].posPct=v; renderVideoSub(); refreshMpvSubs(); } e.target.blur(); });
  // 字幕檢查：字數上限輸入
  $('cpLenInput').addEventListener('input',()=>{ renderCheckPanel(); renderSubList(); });
  $('cpLenInput').addEventListener('keydown',e=>e.stopPropagation());
  // 字幕檢查：包含文字輸入
  $('cpContainsInput').addEventListener('input',()=>{ renderCheckPanel(); renderSubList(); });
  $('cpContainsInput').addEventListener('keydown',e=>e.stopPropagation());
  // 搜尋浮動視窗
  $('searchInput').addEventListener('input',()=>searchUpdate());
  $('searchInput').addEventListener('keydown',e=>{ e.stopPropagation(); if(e.key==='Enter'){ searchNav(1); } else if(e.key==='Escape'){ $('searchInput').value=''; searchUpdate(); $('searchDialog').style.display='none'; _syncMpvPanel(); } });
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

/* ===== FPS 時間碼轉換 ===== */
function showFpsConvertDialog(){
  const tkIdx=State.listTrack;
  const tk=State.tracks[tkIdx];
  if(!tk){ showToast('請先選擇一個字幕軌道'); return; }
  const FPS_OPTS=[23.976,24,25,29.97,30];
  const opts=FPS_OPTS.map(f=>`<option value="${f}">${f===23.976?'23.976 (23.98)':f===29.97?'29.97':''+f}</option>`).join('');
  const curFps=State.fps;
  openModal('FPS 時間碼轉換',
    `<div style="margin-bottom:12px;font-size:13px;color:var(--text-faint)">軌道：<b>${escapeHTML(tk.name)}</b></div>`+
    `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">`+
      `<div><div style="font-size:11px;color:var(--text-faint);margin-bottom:4px">來源 FPS</div>`+
        `<select id="fpsFrom" style="font-size:14px;padding:4px 8px">${opts}</select></div>`+
      `<div style="padding-top:18px;display:flex;flex-direction:column;align-items:center;gap:2px"><span style="font-size:20px;color:var(--text-faint)">→</span><button id="fpsSwap" style="font-size:11px;padding:2px 6px;cursor:pointer" title="交換來源與目標">⇄ 交換</button></div>`+
      `<div><div style="font-size:11px;color:var(--text-faint);margin-bottom:4px">目標 FPS</div>`+
        `<select id="fpsTo" style="font-size:14px;padding:4px 8px">${opts}</select></div>`+
    `</div>`+
    `<div id="fpsPreview" style="margin-top:14px;font-size:12px;color:var(--text-faint)"></div>`,
    [{label:'轉換',primary:true,act:()=>{
      const from=+$('fpsFrom').value, to=+$('fpsTo').value;
      if(from===to){ closeModal(); return; }
      const ratio=from/to;
      const cues=State.cues.filter(c=>(c.track||0)===tkIdx);
      for(const c of cues){ c.start=Math.max(0,c.start*ratio); c.end=Math.max(c.start+0.001,c.end*ratio); }
      // 更新 State.duration 為 max(影片片長, 最後字幕 end)
      const maxEnd=State.cues.reduce((m,c)=>c.end>m?c.end:m, 0);
      if(maxEnd>State.duration){ State.duration=maxEnd; $('tcDur').textContent=secToEncore(maxEnd,State.fps,State.dropFrame); }
      closeModal(); sortCues(); renderAll(); layoutTimeline(); drawTimeline();
      recordHistory(`FPS 轉換 ${from}→${to}`);
      setStatus(`已將「${tk.name}」從 ${from}fps 轉換至 ${to}fps（${cues.length} 條）`,'ok');
    }},{label:'取消',act:closeModal}]);
  setTimeout(()=>{
    const fromSel=$('fpsFrom'), toSel=$('fpsTo');
    const nearest=FPS_OPTS.reduce((a,b)=>Math.abs(b-curFps)<Math.abs(a-curFps)?b:a);
    if(toSel) toSel.value=String(nearest);

    if (fromSel && toSel) {
      const setFromDefault = () => {
        const t = +toSel.value;
        if (t === 29.97) fromSel.value = "30";
        else if (t === 23.976) fromSel.value = "24";
        else if (t === 30) fromSel.value = "29.97";
        else if (t === 24) fromSel.value = "23.976";
      };
      setFromDefault();
      toSel.addEventListener('change', setFromDefault);
    }

    const updatePreview=()=>{
      const from=+fromSel?.value, to=+toSel?.value;
      const p=$('fpsPreview'); if(!p)return;
      if(from===to){ p.textContent='來源與目標相同，無需轉換。'; return; }
      const ratio=from/to;
      p.innerHTML=`比例 <b>${from}/${to} = ${ratio.toFixed(6)}</b>　·　例：1:00:00 → ${new Date(3600*ratio*1000).toISOString().slice(11,22)}`;
    };
    fromSel?.addEventListener('change',updatePreview);
    toSel?.addEventListener('change',updatePreview);
    $('fpsSwap')?.addEventListener('click',()=>{ const tmp=fromSel.value; fromSel.value=toSel.value; toSel.value=tmp; updatePreview(); });
    updatePreview();
  },30);
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

function snapTargets(excludeIds){
  const arr=[Media.vTime()];
  for(const c of State.cues){ if(c.timed===false||excludeIds.has(c.id))continue; arr.push(c.start,c.end); }
  for(const n of State.notes) arr.push(n.time);
  return arr;
}
function openNoteInPanel(n){
  $('notesPanel').classList.add('show');
  setNoteActive(n.id);
  renderNotes();
  setTimeout(()=>{
    $('notesList')?.querySelector(`[data-id="${n.id}"]`)?.scrollIntoView({block:'nearest'});
  },30);
}
function snapVal(t,targets,thr){ let best=t,bd=thr; for(const x of targets){const d=Math.abs(x-t); if(d<bd){bd=d;best=x;}} return best; }
function neighborBounds(os,oe,track,excludeIds){
  let prevEnd=0,nextStart=Infinity;
  for(const c of State.cues){
    if(c.timed===false||excludeIds.has(c.id)||(c.track||0)!==track)continue;
    if(c.start>=oe-1e-6){ if(c.start<nextStart)nextStart=c.start; }
    else if(c.end<=os+1e-6){ if(c.end>prevEnd)prevEnd=c.end; }
  }
  return {prevEnd,nextStart};
}




function applyTcShift(sign){
  const raw=($('tcShiftInput').value||'').trim().replace(/^[+-]/,'');
  const t=parseTimecodeInput(raw);
  if(t==null||isNaN(t)||t<=0){ showToast('請輸入有效的時間碼（例如 00:00:02:00）'); return; }
  const delta=sign*t;
  const scope=$('tcShiftSel').value;
  let cues;
  if(scope==='sel'){
    const ids=State.selectedIds.length?State.selectedIds:[State.selectedId].filter(Boolean);
    cues=ids.map(id=>State.cues.find(c=>c.id===id)).filter(c=>c&&c.timed!==false);
  }else if(scope==='track'){
    cues=State.cues.filter(c=>c.timed!==false&&(c.track||0)===State.listTrack);
  }else{
    cues=State.cues.filter(c=>c.timed!==false);
  }
  if(!cues.length){ showToast('沒有字幕可以位移'); return; }
  for(const c of cues){ c.start=Math.max(0,c.start+delta); c.end=Math.max(c.start+0.001,c.end+delta); }
  sortCues(); renderAll(); drawTimeline();
  recordHistory('時間碼位移');
  setStatus(`已位移 ${delta>=0?'+':''}${delta.toFixed(3)}s（共 ${cues.length} 條）`,'ok');
}
function _durAdjCues(){
  const scope=$('tcShiftSel').value;
  if(scope==='sel'){
    const ids=State.selectedIds.length?State.selectedIds:[State.selectedId].filter(Boolean);
    return ids.map(id=>State.cues.find(c=>c.id===id)).filter(c=>c&&c.timed!==false);
  }else if(scope==='track'){
    return State.cues.filter(c=>c.timed!==false&&(c.track||0)===State.listTrack);
  }else{
    return State.cues.filter(c=>c.timed!==false);
  }
}
function _nextInPoint(c){
  const track=c.track||0; let next=Infinity;
  for(const oc of State.cues){
    if(oc.timed===false||oc.id===c.id||(oc.track||0)!==track)continue;
    if(oc.start>c.start&&oc.start<next)next=oc.start;
  }
  return next;
}
function applyDurAdjTc(sign){
  const raw=($('durAdjTcInput').value||'').trim().replace(/^[+-]/,'');
  const t=parseTimecodeInput(raw);
  if(t==null||isNaN(t)||t<=0){ showToast('請輸入有效的時間碼（例如 00:00:01:00）'); return; }
  const delta=sign*t;
  const minDur=1/Math.max(State.fps||25,1);
  const cues=_durAdjCues();
  if(!cues.length){ showToast('沒有字幕可調整'); return; }
  for(const c of cues){
    const nextIn=_nextInPoint(c);
    let newEnd=c.end+delta;
    newEnd=Math.max(c.start+minDur,newEnd);
    newEnd=Math.min(nextIn,newEnd);
    c.end=newEnd;
  }
  sortCues(); renderAll(); drawTimeline();
  recordHistory('調整持續時間');
  setStatus(`已調整 ${cues.length} 條字幕的持續時間（${sign>0?'+':'−'}${t.toFixed(3)}s）`,'ok');
}
function applyDurAdjPct(){
  const pct=+($('durAdjPctInput').value||'100');
  if(isNaN(pct)||pct<=0){ showToast('請輸入有效的百分比（例如 150）'); return; }
  const ratio=pct/100;
  const minDur=1/Math.max(State.fps||25,1);
  const cues=_durAdjCues();
  if(!cues.length){ showToast('沒有字幕可調整'); return; }
  for(const c of cues){
    const nextIn=_nextInPoint(c);
    let newEnd=c.start+(c.end-c.start)*ratio;
    newEnd=Math.max(c.start+minDur,newEnd);
    newEnd=Math.min(nextIn,newEnd);
    c.end=newEnd;
  }
  sortCues(); renderAll(); drawTimeline();
  recordHistory('調整持續時間');
  setStatus(`已調整 ${cues.length} 條字幕的持續時間（${pct}%）`,'ok');
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
function parseTimecodeInput(str){
  str=String(str).trim(); if(!str)return null;
  let h=0,m=0,s=0,f=0;
  if(str.includes(':')||str.includes(';')){
    const p=str.split(/[:;]/).map(x=>parseInt(x,10)||0);
    // 由右至左：格, 秒, 分, 時
    f=p[p.length-1]||0; s=p[p.length-2]||0; m=p[p.length-3]||0; h=p[p.length-4]||0;
    if(State.dropFrame)
      return encoreToSec(`${pad(h)}:${pad(m)}:${pad(s)};${pad(f)}`,State.fps,true);
  }else{
    if(!/^\d+$/.test(str))return null;
    const g=[]; let r=str; while(r.length>2){ g.unshift(r.slice(-2)); r=r.slice(0,-2); } g.unshift(r);
    // g = [..., mm, ss, ff]  （由右至左對應 格/秒/分/時）
    f=+(g[g.length-1]||0); s=+(g[g.length-2]||0); m=+(g[g.length-3]||0); h=+(g[g.length-4]||0);
  }
  const fpsR=Math.round(State.fps)||24;
  return h*3600 + m*60 + s + Math.min(f,fpsR-1)/State.fps;
}
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
window.addEventListener('resize',()=>{clearTimeout(rzT);rzT=setTimeout(()=>drawTimeline(),120);});

/* 初始化 */
function init(){
  State.fps=+$('fpsSel').value||24;
  const brandLogo=$('brandLogo'); if(brandLogo) brandLogo.src=_logoUrl;
  initUI(); initExtras();
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
