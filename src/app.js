import { initMediaView } from './media-view.js';
/* ==============================================================================
   SUB Tool — 應用程式協調層與 UI 進入點 (App Layer / Entry Point)
   ==============================================================================
   
   【架構與職責總覽】
   本檔案 (app.js) 是本專案最頂層的「巨型協調者」。
   為了避免循環依賴 (Circular Dependency) 導致模組掛點，所有子模組 (如 media,
   subtitles, timeline) 均「不可直接 import app.js」。
   
   1. 單向事件綁定與派發
      各子模組透過 `events.js` 以 `emit(...)` 發送狀態變更；
      本檔透過 `on(...)` 訂閱並負責串接對應的渲染函式或邏輯。
      
   2. DOM 與全域事件管理
      負責初始化使用者介面 (如設定快捷鍵、綁定滑鼠與觸控事件、管理視窗對話框)。
      包含了所有複雜的「拖曳狀態 (Pointer Dragging)」管理，特別是字幕框與圖片的
      DOM 幾何轉換 (將游標座標映射回 16:9 / 2.35:1 的影片絕對比例座標)。
      
   3. 跨進程介面介接 (Electron Bridge)
      當運行於桌面版 (DESK = true) 時，本檔會監聽來自 `main.js` 的 IPC 推播
      (如: mpv:event, mpv:imagePointer)，將 mpv 子視窗原生事件映射回前端 DOM 的行為。

   【維護鐵律】
   - 切勿在此檔案中直接修改底層的 State (應交由 state.js 或 subtitles.js 提供之 Action)。
   - 新增功能時，若是與特定的繪圖有關 (如 Canvas)，請寫在 timeline.js；
     若是與資料解析有關，請寫在 subio.js。保持 app.js 單純負責「接線」的職責。
============================================================================== */
"use strict";
import { refreshMpvSubs, renderVideoSub, _syncMpvPanel, renderImageOverlays, _selectImageClip, _imageBoxOf, _stageRect, drawSafeFrame, renderTimecodeWatermark, toggleSafeFrame, toggleTimecodeWatermark, _setSubtitleHover, previewDrag, _firstLoad, setFirstLoad } from './video-renderer.js';
const _videoSub = document.getElementById('videoSub');
const _videoWrap = document.getElementById('videoWrap');
import _logoUrl from './logo.png';
import { clamp, pad, decodeText, encodeUTF16LE, downloadBytes, readFile, pickFile, b64ToBytes, bytesToB64, baseName, escapeHTML } from './util.js';
import { fmtClock, secToSRT, secToASS, secToEncore, getExactFps, srtToSec, assToSec, encoreToSec, snapTimeToFrame } from './time.js';
import { SubFormats, splitN } from './formats.js';
import { $, video, tlScroll, tlLayer, tlTracks, rulerCv, sublist } from './dom.js';
import { createCommands } from './commands.js';
import { State, newTrack, syncTrackCount, FPS_SET, snapFps, setFps, ensureTrackCount, trackVisible, videoTrackVisible, newId, DESK, IS_DESKTOP, isSel, cueSuffix, loadConfig, saveConfig, loadKeys, saveKeys, clearSelection, setSelection, deselect } from './state.js';
import { Media, Wave } from './media.js';
import { getPlayerAdapter } from './media-player-adapter.js';
import { AudioRouting } from './audio-routing.js';
import { RULER_H, ROW_H, tracksTop, tracksScrollTop, viewportW, timeToX, xToTime, layoutTimeline, drawRuler, niceStep, fmtTick, drawWave, renderTrackRows, renderCueBlocks, trackFromY, addTrack, removeTrack, moveSelectedToTrack, updatePlayhead, drawTimeline, setZoom, zoomFit, zoomFitVideo, refreshTrackGutterActive, snapTargets, snapVal, cueNeighborBounds } from './timeline.js';
import { renderSubList, renderCheckPanel, renderSubRow, selectCue, selectCueSingle, refreshSelectionUI, updateTlSel, addCue, addCueRelative, deleteSelected, deleteCue, sortCues, searchUpdate, searchNav, searchReplace, searchSelectAll, trimTrackSpaces, snapAllCuesToFrames, refreshStyleSummaries, updateSearchCount } from './subtitles.js';
import { initRecentProjects } from './recent-projects.js';
import { setIn, setOut, nudge, stepBoundary, resetPlaybackSpeed } from './keyboard.js';
import { Project, ensureProjectSaved, resetProject, isProjectDirty, getProjectDir, confirmDiscardUnsaved } from './project.js';
import { Seq } from './sequence.js';
import { showCtx, hideCtx, showCueMenu, showPlayerMenu } from './menus.js';
import { History, recordHistory, renderHistory } from './history.js';
import { pocTest as _wcPocTest, demuxFile as _wcDemux, TrackDecoder as _wcTrackDecoder, demuxIndex as _wcDemuxIndex, SampleReader as _wcSampleReader } from './decode/poc.js'; // 階段0 PoC：WebCodecs 解碼驗證（掛 window.SUB.WC）
import { WCPreview } from './decode/player.js'; // 階段1：WebCodecs 接管原生預覽畫面（rafLoop 每幀 tick）
import { effStyle, styleToCss, verticalChars, STYLE_DEFAULTS, CUE_STYLE_KEYS, ASS_PLAY_RES, loadPresets, getPresets, getAllPresets, BUILTIN_PRESETS, isBuiltinPresetName, savePresets, styleSnapshot, trackStyleSnapshot, loadFonts, getFonts, posToPx, anchorPct, styleMatchesPreset, pruneRedundantCueStyle } from './substyle.js'; // v4.23 字幕樣式系統
import { addNote, renderNotes, exportNotes, setNoteActive, updateNoteActive, clearAllNotes } from './notes.js';
import { createPreviewDrag } from './pointer-interaction.js';
import { setStatus, showToast, showOsd, openModal, closeModal, promptModal, closeMenus, openMenu } from './ui.js';
import { renderAudioTracks, renderMixer, mixerReset, mixerMuteAll, updateMeters } from './mixer.js';
import { showSettingsModal } from './settings.js';
import { importSub, showExportDialog, showFpsConvertDialog, applyTcShift, applyDurAdjTc, applyDurAdjPct, toASSFromState, showExportVideoDialog } from './subio.js';
import { parseTimecodeInput, setupTimecodeInput } from './tcparse.js';
import { imageBoxOnStage } from './imagegeom.js'; // v4.7 圖片疊層幾何：預覽／mpv 命中區／匯出 共用同一組公式
import { fadeAlphaAtTimeline } from './clip-fade.js'; // v5.9 淡入淡出：預覽與匯出共用同一份規格
import { timecodeSuffix, screenshotDir, fallbackScreenshotName } from './screenshot-target.js';
import { presetExportRelativePath } from './export-name-safety.js';
import { renderSeekBar } from './seekbar.js';
import { on, emit } from './events.js';

if (typeof __APP_VERSION__ !== 'undefined') {
  const el = document.getElementById('appVersion');
  if (el) el.textContent = 'v' + __APP_VERSION__;
}

/* app.js 為協調層：訂閱各模組發送的事件並呼叫對應的渲染/指令函式。
   各模組只 emit、不再反向 import app.js，藉此切斷雙向相依。
   （函式宣告會被 hoist，於此處註冊安全；emit 為同步呼叫，語意不變。） */
on('render:all', renderAll);
on('render:videoSub', renderVideoSub);
on('render:listTrackSel', renderListTrackSel);
on('render:trackStyle', renderTrackStyle); // 換選取字幕 → 樣式面板換對象（v4.31）
/* ── 以下四條原本【只有發送端、沒有訂閱者】────────────────────────────
   events.js 的 emit 在沒有 handler 時是靜默 no-op，eslint 看不到字串、
   rollup 沒有模組邊，所以半條邊不會有任何徵兆。實際後果：
     render:searchCount → #searchCount 永遠不更新（搜尋結果計數是死的）
     render:subList     → 搜尋後字幕列不重繪，.search-match 高亮出不來
     render:selection   → 刪除／貼上後選取列的 UI 不同步
     render:checkPanel  → Trim 後字元檢查面板不刷新
   由 tests/eventBusContract.test.js 擋住往後再出現半條邊。 */
on('render:subList', renderSubList);
on('render:searchCount', updateSearchCount);
on('render:selection', refreshSelectionUI);
on('render:checkPanel', renderCheckPanel);
on('timeline:invalidate', drawTimeline); // 軌道 metadata 交易只發事件，不反向 import renderer
on('selection:clipCleared', ()=>{ const el=$('stSel'); if(el) el.textContent=''; });
on('playhead:ensure', ensurePlayheadVisible);
on('duration:known', onDurationKnown);
on('mpv:refreshSubs', refreshMpvSubs);
/* 這裡曾有 on('panel:toggle', togglePanel)，但全專案零個 emit——收了沒人發的死訂閱。
   面板開關實際是 doAction() 直接呼叫 togglePanel()（見 'history'／'notes'／'mixer' 等 case）。
   日後若真需要跨模組開面板，請【同時】加上發送端，不要只留一半（見 docs/開發與驗證.md 的事件表）。 */
on('note:openInPanel', openNoteInPanel);
on('cue:openEdit', openCueEditModal);
on('action', doAction);
on('mpv:sync', _syncMpvPanel); // 自訂視窗（快捷鍵設定、右鍵選單）開閉時重算 mpv 讓位
on('history:record', recordHistory); // 供 media.js 等低階模組記錄歷史（避免 media→history 循環相依）
on('project:relinkBrowserMedia', (generation, projectRestore)=>{
  void Project.continueLoad(generation,async isCurrent=>{
    const files=await pickMediaFiles($('fileMedia'));
    if(!isCurrent()) return;
    await importBrowserMediaFiles(files,{generation,plan:projectRestore});
  }).catch(error=>console.warn('relink browser project media:',error));
});
// 還原專案音訊設定後，Web Audio 的實際 gain 與混音器 UI 也要回到同一份快照。
on('audio:projectRestored', ()=>{ Media.applyGains(); renderAudioTracks(); });
// A1：fps 變更後的 DOM 同步（原本在 state.setFps 內，現下沉到此處，state.js 不再相依 DOM）
on('fps:changed', ()=>{
  const sel=$('fpsSel'); if(sel) sel.value=State.dropFrame?String(State.fps)+'df':String(State.fps);
  const t=Media.displayTime();
  $('tcCur').textContent=secToEncore(t,State.fps,State.dropFrame);
  $('tcDur').textContent=secToEncore(State.duration,State.fps,State.dropFrame);
  renderTimecodeWatermark(t);
  
  setTimeout(() => {
    if(snapAllCuesToFrames()){
      renderSubList();
      drawTimeline();
    }
  }, 0);
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
/* render:trackStyle 的訂閱在上面（第 78 行附近），這裡曾經【又註冊一次】。
   events.js 的 on() 是 push、不去重，所以每次 emit 都會把整個樣式面板
   （含 preset 的 <optgroup> DOM）重建兩遍——選取一變更就發生，完全無徵兆。
   訂閱只留一處；重複訂閱由 tests/eventBusContract.test.js 擋住。 */
on('render:styleSummaries', () => { if(typeof refreshStyleSummaries === 'function') refreshStyleSummaries(); });
/* mpv 嵌入模式：字幕改由 mpv/libass 渲染（DOM 疊層被覆蓋）。cue 變動時重建 .ass 餵給 mpv（防抖） */
function styleChanged(){
  if(State.presetEdit){
    renderVideoSub(); refreshMpvSubs(false, true); renderTrackStyle();
    return;
  }
  renderVideoSub(); refreshMpvSubs(); renderTrackStyle(); refreshStyleSummaries();
}

/* 在預覽窗裡直接擺放【單一句】字幕（v4.30）：拖字幕＝移動、拖頂端把手＝旋轉（Shift 吸附 15°，Alt 直接旋轉）。
   ── 寫的是【該句的逐句覆蓋】(cue.style.posX/posY/angle)，不動軌道樣式：拖哪一句就只有那句跑，
      其餘不受影響（列表標 ✱ 自訂）。整軌的標準位置仍用面板的 X／Y。
   ── 換算基準是畫面實際顯示區 _stageRect()（非 videoWrap）：不同比例的片拖起來才等效。
   ── 旋轉支點取【錨點】而非方塊中心，與 ASS 的 \frz 繞 \org(=\pos) 同構（見 substyle.originOf）。 */
// subtitle dragging logic extracted to pointer-interaction.js
_videoSub?.addEventListener('contextmenu', e => {
  const subEl = e.target.closest('.vsub-track');
  if(!subEl) return;
  e.preventDefault();
  e.stopPropagation();
  const cid = subEl.dataset.cue;
  
  const items = [];
  items.push({label:'↔ 水平置中', act:()=>{
    let targetObj;
    if(State.presetEdit) targetObj = State.presetEdit.draft;
    else {
      const c = State.cues.find(cu=>cu.id===cid);
      if(c) targetObj = c.style = c.style || {};
    }
    if(targetObj) {
      targetObj.posX = 50;
      targetObj.align = 'center';
      styleChanged();
      recordHistory('字幕水平置中');
    }
  }});
  items.push({label:'↕ 垂直置中', act:()=>{
    let targetObj;
    if(State.presetEdit) targetObj = State.presetEdit.draft;
    else {
      const c = State.cues.find(cu=>cu.id===cid);
      if(c) targetObj = c.style = c.style || {};
    }
    if(targetObj) {
      targetObj.posY = 50;
      targetObj.valign = 'middle';
      styleChanged();
      recordHistory('字幕垂直置中');
    }
  }});
  
  showCtx(e.clientX, e.clientY, items);
});
_videoWrap?.addEventListener('pointermove', e => { if(!previewDrag.subtitleDrag()) _setSubtitleHover(e.target.closest?.('.vsub-track.drag')||null); });
_videoWrap?.addEventListener('pointerleave', () => { if(!previewDrag.subtitleDrag()) _setSubtitleHover(null); });

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
  renderSeekBar($('seekBar'), Media.displayTime());
  $('stMedia').textContent=State.mediaName?(State.mediaName+(State.mediaSize?(' · '+(State.mediaSize/1e6).toFixed(1)+'MB'):'')):'';
  const vw=viewportW();
  if(vw && State.duration>0){
    const minPps = (vw-40)/State.duration;
    $('zoomBar').min = Math.min(10, minPps).toFixed(3);
  }
  if(_firstLoad && State.duration>0){ zoomFitVideo(); setFirstLoad(false); }
  else if(State.pxPerSec*State.duration < vw) zoomFitVideo();
  else drawTimeline();
}
function ensurePlayheadVisible(){
  const t=Media.displayTime();
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
  renderSeekBar($('seekBar'), t);
  renderTimecodeWatermark(t);
  if(!Media.playing) updatePlayhead();
});
let rafOn=false, rafFrame=0, _rafLastIdx=0;
function rafLoop(){
  if(Media.playing){
    Media.seqTick(); // 影片序列：段尾切換 / 間隙進出 / 序列結尾停止
    const t=Media.displayTime();
    // 無媒體時更新時間顯示；序列間隙中影片暫停無 timeupdate，也由此更新
    if(!video.src || Media.inGap()){
      $('tcCur').textContent=secToEncore(t,State.fps,State.dropFrame);
      renderSeekBar($('seekBar'), t);
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

    // 自動選取邏輯
    if(State.autoSelect) {
      const tk = State.listTrack || 0;
      if (act && (act.track || 0) === tk && act.id !== State.selectedId) {
        const editing = document.activeElement && document.activeElement.classList.contains('txt') && document.activeElement.contentEditable === 'true';
        if (!editing) {
          selectCueSingle(act.id, false);
        }
      }
    }

    // active 備註
    if(State.notes.length&&$('notesPanel').classList.contains('show')) updateNoteActive(t);
    // buffer 音軌 drift 校正（序列間隙中不校正——影片已暫停，重啟音源會誤出聲）
    if(Media.ctx && !Media.inGap() && Media.tracks.some(t=>t.kind==='buffer'&&!t._srcHidden)){
      const expect=Media.startMediaTime+(Media.ctx.currentTime-Media.startCtxTime)*(video.playbackRate||1);
      if(Math.abs(expect-video.currentTime)>0.25){ Media.stopBufferSources(); Media.startBufferSources(video.currentTime); }
    }
    // element 音軌 drift 校正（多軌同步）：ext-* 參考音對「時間軸時間」；clip 綁定音軌對【各自音源】的來源時間
    // （疊合時各段 offset 不同，不能一律用 active clip 的 vTime，否則下層/主影片音軌會被拉到上層的來源時間）
    for(const tr of Media.tracks){ if(tr.kind==='element'&&tr.el&&!tr.el.paused){
      const s=tr.source||'';
      let ref;
      if(s.startsWith('ext-')) ref=Media.tlTime();
      else if(Media.seqOn()){ const lt=Media.sourceLocalTime(s||'video', Media.tlTime()); if(lt==null) continue; ref=lt; }
      else ref=Media.vTime();
      if(Math.abs(tr.el.currentTime - ref) > 0.12){ try{tr.el.currentTime=ref;}catch(e){} }
    }}
  }
  try{ WCPreview.tick(); }catch(e){} // WebCodecs 預覽畫面（每幀；未就緒/失敗自動 fallback 畫 video）
  try{ Media.applyPreviewFade(); }catch(e){} // 預覽淡出入黑提示（每幀；WC 真合成時被抑制——tick 先設旗標）
  updateMeters();
  requestAnimationFrame(rafLoop);
}
function markActiveRow(id){
  sublist.querySelectorAll('.sub-row.active').forEach(r=>r.classList.remove('active'));
  if (State.subMode) return;
  
  const row=sublist.querySelector(`.sub-row[data-id="${id}"]`);
  if(row){
    row.classList.add('active');
    row.scrollIntoView({block:'nearest'});
  }
}
video.addEventListener('play',()=>{
  Media.playing=true;
  $('playBtn').textContent='⏸';
  // 播放中不要取消目前選擇的字幕
});
video.addEventListener('pause',()=>{
  $('playBtn').textContent='▶';
  const t=Media.displayTime();
  $('tcCur').textContent=secToEncore(t,State.fps,State.dropFrame);
  renderSeekBar($('seekBar'), t);
  renderTimecodeWatermark(t);
  updatePlayhead();
  
  if (!State.subMode && State.selectedId) {
    const c = State.cues.find(x => x.id === State.selectedId);
    if (c) {
      const tkCues = State.cues.filter(x => (x.track || 0) === (c.track || 0));
      const idx = tkCues.findIndex(x => x.id === c.id);
      const nextCue = idx >= 0 && idx < tkCues.length - 1 ? tkCues[idx + 1] : null;
      const targetOut = nextCue ? nextCue.end : c.end;
      if (t > targetOut) {
        deselect('sub');
        refreshSelectionUI();
        const stSel = $('stSel');
        if(stSel) stSel.textContent='';
      }
    }
  }
});
video.addEventListener('seeked',()=>{updatePlayhead();renderVideoSub();updateNoteActive(Media.displayTime());});
window.addEventListener('mpv:seeked',e=>{updatePlayhead();renderVideoSub();updateNoteActive(e.detail);});
video.addEventListener('ended',()=>{ if(Media.seqContinueAtEnd()) return; Media.pause(); }); // 序列有後續→推進不暫停

/* 影片視窗與時間碼 滾輪逐格播放 */
['videoWrap', 'tcCur'].forEach(id => {
  $(id)?.addEventListener('wheel', e => {
    e.preventDefault();
    const frames = e.deltaY > 0 ? 1 : -1;
    nudge(frames / getExactFps(State.fps || 30));
  }, {passive: false});
});

/* seek bar */
$('seekBar').addEventListener('input',e=>{ renderSeekBar(e.target); const t=(+e.target.value)/1000; Media.seek(t); updateNoteActive(t); });
// rateSel removed from UI — speed controlled via JKL keys
$('fpsSel').addEventListener('change',e=>{
  const prev=State.fps,prevDf=State.dropFrame;
  setFps(e.target.value);
  State.cues.forEach(c => {
    c.start = snapTimeToFrame(c.start, State.fps, State.dropFrame);
    c.end = snapTimeToFrame(c.end, State.fps, State.dropFrame);
  });
  State.notes.forEach(n => {
    n.time = snapTimeToFrame(n.time, State.fps, State.dropFrame);
  });
  renderAll();
  renderNotes();
  Media.seek(Media.displayTime());
  drawTimeline();
  recordHistory(`切換 FPS ${prevDf?prev+'df':prev}→${State.fps+(State.dropFrame?'df':'')}`);
  e.target.blur();
});
$('zoomBar').addEventListener('input',e=>setZoom(+e.target.value));




const AUDIO_MEDIA_EXTENSIONS=new Set(['aac','aif','aiff','alac','flac','m4a','mka','mp3','oga','ogg','opus','wav','wma']);

function mediaFileKind(fileOrPath){
  const name=typeof fileOrPath==='string'?fileOrPath:(fileOrPath?.name||'');
  const type=typeof fileOrPath==='object'?(fileOrPath?.type||''):'';
  if(/^audio\//i.test(type)) return 'audio';
  if(/^video\//i.test(type)) return 'video';
  const ext=(name.split('.').pop()||'').toLowerCase();
  if(['jpg','jpeg','png'].includes(ext) || /^image\//i.test(type)) return 'image';
  return AUDIO_MEDIA_EXTENSIONS.has(ext)?'audio':'video';
}

function pickMediaFiles(input){
  return new Promise(resolve=>{
    input.value='';
    input.onchange=()=>resolve(Array.from(input.files||[]));
    input.click();
  });
}

async function importDesktopMediaFiles(value, explicitRelink=null){
  const relink=explicitRelink||Project.pendingMediaRelink?.()||null;
  const projectRestore=relink?.plan||null;
  const paths=(Array.isArray(value)?value:(value?[value]:[])).filter(path=>typeof path==='string'&&path);
  const videos=paths.filter(path=>mediaFileKind(path)==='video');
  const audios=paths.filter(path=>mediaFileKind(path)==='audio');
  const images=paths.filter(path=>mediaFileKind(path)==='image');
  let primaryLoaded=false;
  if(videos.length>1){
    // 多選影片的語意固定為「第一支建立／保留主序列，其餘加入序列」，避免連續跳出多個 modal。
    if(!Media.seqOn()) { await Media.loadDesktopMedia(videos.shift(),projectRestore); primaryLoaded=true; }
    for(const path of videos) await Media.addClipDesktop(path);
  }else if(videos.length===1){
    const path=videos[0];
    if(Media.seqOn()) Media.openIncoming({path});
    else { await Media.loadDesktopMedia(path,projectRestore); primaryLoaded=true; }
  }
  for(const path of audios) await Media.addAudioFileDesktop(path);
  for(const path of images) await Media.addImageDesktop(path);
  if(primaryLoaded&&relink) await Project.finishMediaRelink(relink.generation,projectRestore);
}

async function importBrowserMediaFiles(files, explicitRelink=null){
  const relink=explicitRelink||Project.pendingMediaRelink?.()||null;
  const projectRestore=relink?.plan||null;
  const list=Array.isArray(files)?files.filter(Boolean):[];
  const videos=list.filter(file=>mediaFileKind(file)==='video');
  const audios=list.filter(file=>mediaFileKind(file)==='audio');
  const images=list.filter(file=>mediaFileKind(file)==='image');
  let primaryLoaded=false;
  if(videos.length>1){
    if(!Media.seqOn()) { await Media.loadVideoFile(videos.shift(),projectRestore); primaryLoaded=true; }
    for(const file of videos) await Media.addClipWeb(file);
  }else if(videos.length===1){
    const file=videos[0];
    if(Media.seqOn()) Media.openIncoming({file});
    else { await Media.loadVideoFile(file,projectRestore); primaryLoaded=true; }
  }
  for(const file of audios) await Media.addAudioFile(file);
  for(const file of images) await Media.addImageWeb(file);
  if(primaryLoaded&&relink) await Project.finishMediaRelink(relink.generation,projectRestore);
}

// A4：純關閉面板的 case 改用資料表，消除重複的 classList.remove('show')+_syncMpvPanel()
/* 指令表住在 commands.js —— 82 個 case 的 switch 攤成一張可列舉的表之後，
   tests/commands.test.js 才有辦法回答「index.html 上這顆按鈕真的有實作嗎」。
   這裡只留下 app.js 自己才有的畫面接線，逐一具名注入。 */
const Commands = createCommands({
  togglePanel,
  syncMpvPanel: _syncMpvPanel,
  pickMediaFiles,
  importDesktopMediaFiles,
  importBrowserMediaFiles,
  resetFirstLoad: () => { setFirstLoad(true); },
  onDurationKnown,
  renderAll,
  renderListTrackSel,
  renderVideoSub,
  refreshMpvSubs,
  takeScreenshot,
  copySelectedStyle,
  pasteStyleToSelected,
  openCacheDialog,
  toggleSafeFrame,
  toggleTimecodeWatermark,
  doCopyTrack,
  doCompareTrack,
});
function doAction(act, force = false){ return Commands.run(act, { force }); }

let _repTimer=null, _repInterval=null, _repFired=false;
const REP_ACTS=['back1','frame-back','frame-fwd','fwd1'];
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
  closeMenus(e.target);
});
document.querySelectorAll('.menu>button').forEach(btn=>{
  btn.addEventListener('click',e=>{
    e.stopPropagation();
    const m=btn.parentElement;
    if(m.classList.contains('open')) closeMenus();
    else openMenu(m);
  });
});
// 選單項目點擊後關閉
document.querySelectorAll('.menu .items button').forEach(b=>b.addEventListener('click',()=>closeMenus()));


/* ===== 字幕列表：軌道切換下拉 + 樣式面板 ===== */
function renderListTrackSel(){
  const sel=$('listTrackSel'); if(!sel)return;
  const prev=clamp(State.listTrack,0,State.tracks.length-1);
  State.listTrack=prev;
  sel.innerHTML=State.tracks.map((t,i)=>`<option value="${i}">${escapeHTML(t.name)}</option>`).join('');
  sel.value=String(prev);
  renderTrackStyle();
}
/* 「編輯常用樣式」模式（v4.34.0）。
   做法：暫借目前軌道當草稿——把該常用樣式套上去，使用者就能用原本那套面板控制項邊調邊
   看即時預覽（三路照常運作，不必為編輯模式另做一份 UI）。按「完成」才寫回 preset。
   entry: { name, before, trackIdx, targets:{tracks:[i], cues:[cue]} }
   targets ＝【進入編輯前】就已符合舊樣式的軌與句，完成時一起改成新樣式（＝使用者說的
   「改完所有套用這個名字的也跟著變」）。名稱比對本來就是「樣式完全相符」，判準見
   substyle.js styleMatchesPreset()——所以這裡也只能用相符來判定，沒有存名稱的欄位。 */
State.presetEdit = null;
/* 樣式面板的編輯對象（v4.31）：【選取中的那一句】；沒選任何句子時才退回整軌。
   ── 使用者要的是「改樣式只影響這一句，要套到全部才按『全軌統一』」。 */
/* 面板要改的對象。
   cues＝【本軌所有被選取的句子】——多選時樣式要全部一起改（v4.34.0 前只改到 selectedId
   那一句，使用者多選了三句卻只有第一句變）；cue＝其中第一句，只作為面板顯示的代表值。
   完全沒選任何句子時 cues 為空陣列 ＝ 改的是整軌。 */
function styleTarget(){
  const i=State.listTrack, trk=State.tracks[i];
  if(!trk) return null;
  // 編輯常用樣式期間：攔截樣式目標，導向獨立的草稿 (draft)
  if(State.presetEdit) return { i: State.presetEdit.trackIdx, trk: State.presetEdit.draft, cues: [], cue: null };
  const ids=State.selectedIds && State.selectedIds.length ? State.selectedIds
          : (State.selectedId ? [State.selectedId] : []);
  const cues=ids.length ? State.cues.filter(c=>(c.track||0)===i && ids.includes(c.id)) : [];
  return { i, trk, cues, cue: cues[0] || null };
}

function renderTrackStyle(){
  const panel=$('trackStyle'); const t=styleTarget();
  if(!t){ panel.classList.add('disabled'); $('tsTitle').textContent='字幕樣式'; return; }
  panel.classList.remove('disabled');
  const { trk, cue, cues }=t;
  const idx=cue ? State.cues.filter(c=>(c.track||0)===State.listTrack).indexOf(cue)+1 : 0;
  const multi=cues.length>1;
  const editingPreset = State.presetEdit;
  const labelStr = editingPreset ? `✎ 編輯常用樣式：${editingPreset.name}`
                           : cue ? `第 ${idx} 句樣式` : `「${trk.name}」樣式`;
  $('tsTitle').textContent = labelStr;
  $('tsTitle').title = multi ? `改動會同時套用到選取的這 ${cues.length} 句（面板顯示的是第 ${idx} 句的值）`
                     : cue ? '改動只影響這一句；要套用到整軌請按「⇩ 全軌統一」'
                     : '沒有選取字幕 → 改動套用到整條軌道';
  panel.classList.toggle('per-cue', !!cue);
  const st=effStyle(cue, trk); // 生效值（缺欄位以預設後援）
  const setV=(id,v)=>{ const el=$(id); if(el&&document.activeElement!==el) el.value=v; };
  setV('tsSize',st.fontSize); setV('tsColor',(st.color||'#ffffff').toLowerCase());
  setV('tsPosX',(st.posX!=null?st.posX:STYLE_DEFAULTS.posX).toFixed(1)); setV('tsPosY',(st.posY!=null?st.posY:STYLE_DEFAULTS.posY).toFixed(1)); // 座標改為百分比呈現
  setV('tsAngle',st.angle);
  setV('tsOutline',st.outline); setV('tsOutlineColor',st.outlineColor); setV('tsShadow',st.shadow);
  setV('tsSpacing',st.letterSpacing); setV('tsLineSp',st.lineSpacing);
  setV('tsBgColor',st.bgColor); setV('tsBgAlpha',Math.round(st.bgAlpha*100));
  // 字型不在清單時動態補一個 option（舊專案存過已移除／改名的字型；不補的話下拉會顯示
  // 別的字型，看起來像被偷改）
  const fsel=$('tsFont');
  if(fsel){ if(![...fsel.options].some(o=>o.value===st.font||o.text===st.font)){
      const o=document.createElement('option'); o.text=st.font; o.value=st.font; fsel.appendChild(o); }
    if(document.activeElement!==fsel) fsel.value=st.font; }
  $('tsBold')?.classList.toggle('active',!!st.bold); $('tsItalic')?.classList.toggle('active',!!st.italic);
  $('tsVertical')?.classList.toggle('active',!!st.vertical); $('tsBgBox')?.classList.toggle('active',!!st.bgBox);
  panel.querySelectorAll('.ts-preset[data-ts-size]').forEach(b=>b.classList.toggle('active',+b.dataset.tsSize===st.fontSize));
  setV('tsAlign', st.align||'center'); setV('tsValign', st.valign||'bottom');
  // 底色未啟用時把色框/透明度變暗（消除「改了 bgColor 卻沒反應」的困惑——需先按「底」）
  const bgOn=!!st.bgBox; ['tsBgColor','tsBgAlpha'].forEach(id=>{ const el=$(id); if(el){ el.style.opacity=bgOn?'1':'.4'; el.title=(el.title||'').replace(/（未啟用.*$/,'')+(bgOn?'':'（未啟用：先按「底」）'); } });
  panel.querySelectorAll('.ts-clr').forEach(b=>b.classList.toggle('active',b.dataset.color===(st.color||'').toLowerCase()));
  // 常用樣式下拉重建
  const psel=$('tsPresetSel');
  if(psel){
    const cur=psel.value; 
    let html = '<option value="">— 套用 —</option>';
    const list = getAllPresets();
    const groups = {};
    const orphans = [];
    for (const p of list) {
      if (p.builtin) {
        orphans.push({ val: p.name, text: p.name });
        continue;
      }
      if (p.group) {
        if (!groups[p.group]) groups[p.group] = [];
        groups[p.group].push({ val: p.name, text: p.name });
      } else {
        orphans.push({ val: p.name, text: p.name });
      }
    }
    for (const o of orphans) html += `<option value="${escapeHTML(o.val)}">${escapeHTML(o.text)}</option>`;
    for (const g in groups) {
      html += `<optgroup label="📁 ${escapeHTML(g)}">`;
      for (const o of groups[g]) html += `<option value="${escapeHTML(o.val)}">${escapeHTML(o.text)}</option>`;
      html += `</optgroup>`;
    }
    psel.innerHTML = html; 
    psel.value=cur||''; 
  }
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

let _covCleared=false; // 本次開窗有沒有按過「清除全部覆蓋」（決定要不要連座標／角度一起清）
async function openCueEditModal(c){
  await ensureProjectSaved();
  _covCleared=false;
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

  // v4.23 逐句樣式覆蓋：欄位定義（key, 標籤, 類型）——bool 用 select(開/關)、其餘勾選＋輸入
  const COV_FIELDS=[
    ['color','顏色','color'],['fontSize','字級','num'],['bold','粗體','bool'],['italic','斜體','bool'],
    ['outline','框線','num'],['outlineColor','框線色','color'],['shadow','陰影','num'],
    ['letterSpacing','字距','num'],['lineSpacing','行距','num'],['font','字型','text'],['vertical','直書','bool'],
  ];
  const effNow=effStyle(c, State.tracks[trackIdx]||null);
  const covRow=([k,label,type])=>{
    const has=!!(c.style&&c.style[k]!=null);
    const v=has?c.style[k]:effNow[k];
    let inp;
    if(type==='color') inp=`<input type="color" id="covV_${k}" value="${v}" style="width:26px;height:20px;padding:0">`;
    else if(type==='num') inp=`<input type="number" id="covV_${k}" value="${v}" step="${k==='lineSpacing'?0.1:0.5}" style="width:56px">`;
    else if(type==='bool') inp=`<select id="covV_${k}"><option value="1"${v?' selected':''}>開</option><option value="0"${!v?' selected':''}>關</option></select>`;
    else inp=`<input type="text" id="covV_${k}" value="${escapeHTML(String(v))}" style="width:90px">`;
    return `<label style="display:flex;align-items:center;gap:4px;white-space:nowrap"><input type="checkbox" id="covK_${k}"${has?' checked':''}>${label}</label>${inp}`;
  };
  const covHtml=
    `<details id="cueStyleOv"${c.style?' open':''} style="margin-top:10px;border:1px solid var(--border);border-radius:4px;padding:6px 8px">`+
    `<summary style="cursor:pointer;font-size:12px;color:var(--text-faint)">✱ 樣式覆蓋（僅此句；未勾選＝繼承軌道樣式）</summary>`+
    `<div style="display:grid;grid-template-columns:auto auto auto auto;gap:8px 14px;padding:10px 2px 4px;font-size:12px;align-items:center">`+
    COV_FIELDS.map(covRow).join('')+
    `</div><button id="covClear" style="font-size:11px;margin-top:6px">清除全部覆蓋</button></details>`;
  const doConfirm=()=>{
    const ta=$('cueEditTa');
    if(!ta) return;
    let val=ta.innerText;
    if(val.endsWith('\n') && !orig.endsWith('\n')) val=val.slice(0,-1);
    // 收集樣式覆蓋（勾選的欄位）。
    // ── 這裡是把 c.style【整個重建】，所以本視窗沒有控件的覆蓋欄位必須先原樣搬過來：
    //    座標／角度是在預覽窗拖出來的，這裡沒有對應欄位，不保留的話「開一下視窗按確定」
    //    就會把拖好的位置與角度默默清掉（angle 自 v4.27 起即有此問題）。
    //    使用者若要清掉它們，走「清除全部覆蓋」（見下方 covClear，會連同這些一起清）。
    const style={}; const origStyle=JSON.stringify(c.style||null);
    const managed=new Set(COV_FIELDS.map(f=>f[0]));
    if(c.style && !_covCleared) for(const k of CUE_STYLE_KEYS){ if(!managed.has(k) && c.style[k]!=null) style[k]=c.style[k]; }
    for(const [k,,type] of COV_FIELDS){
      const on=$('covK_'+k), vi=$('covV_'+k);
      if(!on||!on.checked||!vi) continue;
      style[k]= type==='num' ? +vi.value : type==='bool' ? (vi.value==='1') : vi.value;
    }
    if(Object.keys(style).length) c.style=style; else delete c.style;
    const styleChanged=JSON.stringify(c.style||null)!==origStyle;
    c.text=val; closeModal(); renderAll(); renderVideoSub(); if(styleChanged) refreshMpvSubs();
    if(val!==orig||styleChanged) recordHistory('編輯字幕'+(styleChanged?'（含樣式覆蓋）':'文字')+cueSuffix(c));
  };
  openModal('修改字幕文字',
    `<div style="font-size:12px;color:var(--text-faint);margin-bottom:10px">${escapeHTML(trackName)} ｜ ${tc}</div>`+
    `<div style="max-height:58vh;overflow-y:auto;padding-right:2px">`+
    sibHtml+
    mkBlock('原文',orig,'cueEditCopy')+
    `<div style="font-size:12px;color:var(--text-faint);margin-bottom:4px">修改 <span style="font-size:10px;opacity:.5">（Enter 確認 · Shift+Enter 換行）</span></div>`+
    `<div id="cueEditTa" contenteditable="true" style="width:100%;min-height:5em;border:1px solid var(--border);border-radius:4px;background:var(--bg);font-size:14px;font-family:inherit;padding:6px;box-sizing:border-box;color:var(--text);overflow-y:auto;outline:none"></div>`+
    covHtml+
    `</div>`,
    [{label:'確認',primary:true,act:doConfirm},{label:'取消',act:closeModal}],
    { keepVideo:true }); // 對話框靠右停、遮罩透明、不隱藏 mpv → 編輯時看得到後面的畫面
  // seek 到這句的起點，讓後面顯示的正是這句對應的畫面（方便對著影像改字）
  try{ Media.seek(c.start); }catch(e){}
  setTimeout(()=>{
    const ta=$('cueEditTa');
    if(ta){
      ta.dataset.orig=orig;
      ta.innerHTML=escapeHTML(orig).replace(/\n/g, '<br>');
      ta.focus();
      try { const r = document.createRange(), s = window.getSelection(); r.selectNodeContents(ta); s.removeAllRanges(); s.addRange(r); } catch (_) {}
      
      ta.addEventListener('keydown',e=>{
      // Enter 系列一律擋住冒泡：確認/切分會同步關閉 modal，若讓事件繼續傳到 window 的
      // 快捷鍵處理器，modal 已不在、同一下 Enter 會再觸發 toggle_play_pause 造成雙重動作
      if(e.key==='Enter') e.stopPropagation();
      if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){
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
        if (!textBefore.trim() || !textAfter.trim()) { showToast('不能在句首或句尾切分，以免產生空白字幕'); return; }
        const origEnd=c.end;
        const isTimed=c.timed!==false;
        if(isTimed){ const pt=Media.displayTime(); if(pt < c.start + 0.05 || pt > c.end - 0.05){ showToast('切分點距離起訖太近，或是超出了字幕範圍'); return; } }
        let splitTime=0;
        if(isTimed){ splitTime=Media.displayTime(); c.end=splitTime; }
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
    // 樣式覆蓋區：清除鈕＋鍵盤事件不外洩（避免觸發全域快捷鍵）
    const ov=$('cueStyleOv');
    if(ov){
      ov.addEventListener('keydown',e=>e.stopPropagation());
      const cl=$('covClear');
      // 「清除全部覆蓋」＝連同本視窗沒有控件的座標／角度一起清（見存檔處的 _covCleared）
      if(cl) cl.addEventListener('click',e=>{ e.preventDefault(); _covCleared=true;
        ov.querySelectorAll('input[type=checkbox]').forEach(x=>x.checked=false); });
    }
  },30);
}

/* ===== UI 接線（區塊切換 / 樣式 / 分隔線 / 捲動同步 / 雙擊） ===== */
function initUI(){
  // 軌道切換下拉
  $('listTrackSel').addEventListener('change',e=>{ State.listTrack=+e.target.value; deselect('sub'); $('stSel').textContent=''; searchUpdate(); renderSubList(); renderTrackStyle(); refreshSelectionUI(); refreshTrackGutterActive(); });
  const waveGlobalSrcSel=$('waveGlobalSrcSel');
  if(waveGlobalSrcSel) waveGlobalSrcSel.addEventListener('change',e=>{ Media.switchSource(e.target.value==='__all__'?null:e.target.value); renderMixer(); e.target.blur(); });

  /* 唯一的樣式寫入點（v4.31）：有選取字幕 → 寫該句的逐句覆蓋；沒選 → 寫整軌。
     ── 面板九個控件本來各自 `State.tracks[i][k]=v`，等於「改樣式一律套全軌」。 */
  let _tsSetTimer = null;
  const tsSet=(k,v)=>{
    const t=styleTarget(); if(!t)return;
    if(t.cues.length) for(const c of t.cues){ c.style=c.style||{}; c.style[k]=v; }
    else t.trk[k]=v;
    styleChanged();
    clearTimeout(_tsSetTimer);
    _tsSetTimer = setTimeout(() => recordHistory('修改字幕樣式'), 500);
  };
  $('tsSize').addEventListener('input',e=>tsSet('fontSize', clamp(+e.target.value,10,300)));
  $('tsSize').addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key==='Escape'){e.preventDefault();e.target.blur();} });
  // 座標改為直接輸入百分比
  ['tsPosX','tsPosY'].forEach(id=>{
    const isX = id==='tsPosX', key = isX ? 'posX' : 'posY';
    $(id).addEventListener('input',e=>{
      tsSet(key, clamp(+e.target.value, 0, 100));
    });
    $(id).addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key==='Escape'){e.preventDefault();e.target.blur();} });
  });
  $('tsColor').addEventListener('input',e=>tsSet('color', e.target.value));
  const tsNum=(id,k,lo,hi)=>{ const el=$(id); if(!el)return;
    el.addEventListener('input',e=>tsSet(k, clamp(+e.target.value, lo, hi)));
    el.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key==='Escape'){e.preventDefault();e.target.blur();} }); };
  const tsToggle=(id,k)=>{ const el=$(id); if(!el)return;
    el.addEventListener('click',()=>{ const t=styleTarget(); if(!t)return; tsSet(k, !effStyle(t.cue, t.trk)[k]); }); };
  tsNum('tsOutline','outline',0,10); tsNum('tsShadow','shadow',0,10);
  tsNum('tsAngle','angle',-180,180); // 旋轉角度（度，順時針為正；繞錨點）
  tsNum('tsSpacing','letterSpacing',0,100); tsNum('tsLineSp','lineSpacing',1,100);
  $('tsOutlineColor').addEventListener('input',e=>tsSet('outlineColor',e.target.value));
  $('tsBgColor').addEventListener('input',e=>tsSet('bgColor',e.target.value));
  $('tsBgAlpha').addEventListener('input',e=>tsSet('bgAlpha', clamp(+e.target.value,0,100)/100));
  $('tsBgAlpha').addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key==='Escape'){e.preventDefault();e.target.blur();} });
  tsToggle('tsBold','bold'); tsToggle('tsItalic','italic');
  tsToggle('tsVertical','vertical'); tsToggle('tsBgBox','bgBox');
  // 字型只從 font/ 掃出來的清單選（v4.34.4 拿掉「自訂…」——手打系統字型名匯出時常配不到，
  // 見鐵律 §0.3；要多一個字型就往 font/ 放一個資料夾）
  $('tsFont').addEventListener('change', async e => {
    if (e.target.value === '__custom') {
      if (!window.subtool) {
        showToast('網頁版無法直接匯入字型檔案。請使用桌面版。');
        e.target.value = effStyle().font || STYLE_DEFAULTS.font;
        return;
      }
      const imported = await window.subtool.importFont();
      if (imported) {
        await loadFonts(true); // Reload fonts list
        // Update font select HTML
        const sel = $('tsFont');
        sel.innerHTML = getFonts().map(f=>`<option value="${escapeHTML(f.name)}">${escapeHTML(f.name)}</option>`).join('') + '<option value="__custom">匯入自訂字型...</option>';
        sel.value = imported;
        tsSet('font', imported);
        renderTrackStyle();
      } else {
        e.target.value = effStyle().font || STYLE_DEFAULTS.font;
      }
      return;
    }
    tsSet('font', e.target.value);
  });
  // 常用樣式庫：存 / 套用 / 管理（跨專案，存 config）
  // 存＝面板目前顯示的那組生效樣式（選取句 or 整軌）；套用＝同樣寫回面板當前的對象
  $('tsPresetSave').addEventListener('click',async()=>{
    const t=styleTarget(); if(!t)return;
    const curSt = effStyle(t.cue, t.trk);
    const isSameAsDefault = Object.keys(STYLE_DEFAULTS).every(k => 
      (STYLE_DEFAULTS[k]) === (curSt[k] != null ? curSt[k] : STYLE_DEFAULTS[k])
    );
    if (isSameAsDefault) {
      showToast('目前樣式與「預設」完全相同，無須儲存。');
      return;
    }
    
    function promptSaveModal(defGroup, defName) {
      return new Promise(resolve => {
        let done = false;
        const finish = (res) => { if(done)return; done = true; closeModal(); resolve(res); };
        
        const groups = [...new Set(getPresets().filter(p=>p.group).map(p=>p.group))];
        const groupOpts = groups.map(g => `<option value="${escapeHTML(g)}">`).join('');
        
        openModal('存為常用樣式',
          `<div style="font-size:13px;color:var(--text-dim);margin-bottom:4px">資料夾 (選填)</div>`+
          `<input type="text" id="__presetGroup" list="__presetGroupList" value="${escapeHTML(defGroup)}" style="width:100%;margin-bottom:12px;padding:7px;background:var(--bg2);color:var(--text);border:1px solid var(--border2);border-radius:4px;">`+
          `<datalist id="__presetGroupList">${groupOpts}</datalist>`+
          `<div style="font-size:13px;color:var(--text-dim);margin-bottom:4px">樣式名稱</div>`+
          `<input type="text" id="__presetName" value="${escapeHTML(defName)}" style="width:100%;margin-bottom:12px;padding:7px;background:var(--bg2);color:var(--text);border:1px solid var(--border2);border-radius:4px;">`,
          [
            { label: '儲存', primary: true, act: () => {
              const grp = ($('__presetGroup')?.value || '').trim();
              const nm = ($('__presetName')?.value || '').trim();
              if(!nm) { showToast('名稱不可為空'); return; }
              finish({ group: grp, name: nm });
            }},
            { label: '取消', act: () => finish(null) }
          ]
        );
        setTimeout(() => { const el = $('__presetName'); if(el){ el.focus(); el.select(); } }, 30);
      });
    }

    async function trySave(defGroup, defName) {
      const res = await promptSaveModal(defGroup, defName);
      if(!res) return;
      const { group: grp, name: nm } = res;
      if(isBuiltinPresetName(nm)){ showToast('這是內建樣式的保留名稱，請換一個'); return trySave(grp, defName); }
      
      const list=[...getPresets()];
      const exIdx = list.findIndex(p => p.name === nm && (p.group||'') === grp);
      
      const doSave = (finalGroup, finalName) => {
        const style=styleSnapshot(effStyle(t.cue, t.trk));
        const idx = list.findIndex(p => p.name === finalName && (p.group||'') === finalGroup);
        if(idx>=0) {
          list[idx] = Object.assign(list[idx], { name: finalName, group: finalGroup, style });
        } else {
          list.push({ name: finalName, group: finalGroup, style });
        }
        savePresets(list); renderTrackStyle(); refreshStyleSummaries(); showToast('已儲存常用樣式：'+finalName);
      };

      if(exIdx >= 0) {
        openModal('名稱已存在', `<div style="padding:6px 2px">「${escapeHTML(nm)}」已經存在此資料夾中，您要覆蓋現有的樣式，還是換別的名字？</div>`, [
          { label: '覆蓋', primary: true, act: () => { closeModal(); doSave(grp, nm); } },
          { label: '換別的名字', act: () => { closeModal(); trySave(grp, nm); } },
          { label: '取消', act: closeModal }
        ]);
      } else {
        doSave(grp, nm);
      }
    }
    
    trySave('', t.trk.name+' 樣式');
  });
  $('tsPresetSel').addEventListener('change',e=>{
    const t=styleTarget(), v=e.target.value; e.target.value='';
    if(!v||!t)return;
    const p=getAllPresets().find(x=>x.name===v); if(!p)return;
    if(t.cues.length){ for(const c of t.cues) c.style=Object.assign(c.style||{}, p.style); } // 只套選取的那幾句
    else Object.assign(t.trk, p.style);
    styleChanged(); recordHistory('套用常用樣式：'+v);
  });
  /* 常用樣式庫（管理視窗、編輯模式、匯入匯出）：見 initPresetLibrary()。
     這一段與樣式面板的接線互不相干，抽出來讓 initUI 只剩面板本身。 */
  initPresetLibrary();
  /* 全軌統一：清掉本軌所有「逐句樣式覆蓋」，讓每句都回到軌道樣式。
     ── 軌道樣式本來就是全軌生效；唯一會脫隊的就是設過覆蓋的句子（列表標 ✱ 自訂）。
        本鈕＝那些句子的一鍵歸隊，而非「把樣式複製到每一句」。 */
  $('tsUnify')?.addEventListener('click',()=>{
    const t=styleTarget(); if(!t)return;
    const { i, trk, cue }=t;
    const others=State.cues.filter(c=>(c.track||0)===i && c!==cue);
    const ovs=others.filter(c=>c.style && Object.keys(c.style).length).length;
    const st=effStyle(cue, trk);
    const idx=cue ? State.cues.filter(c=>(c.track||0)===i).indexOf(cue)+1 : 0;
    const 來源 = cue ? `第 ${idx} 句` : '目前';
    if(!others.length){ showToast('本軌只有這一句'); return; }
    openModal('⇩ 全軌統一', `<div style="font-size:13px;line-height:1.7">`+
      `把<b style="color:var(--accent)">${來源}的樣式</b>套用到「${escapeHTML(trk.name)}」的<b>全部 ${others.length+ (cue?1:0)} 句</b>。<br>`+
      (ovs ? `其中 <b style="color:var(--accent)">${ovs}</b> 句原本設過自己的樣式，會一併被覆蓋。<br>` : '')+
      `<span style="color:var(--text-faint)">位置與角度也會一起統一（可 <b>Ctrl+Z</b> 復原）。</span></div>`,
      [{label:'取消',act:closeModal},{label:`套用到全部 ${others.length+(cue?1:0)} 句`,primary:true,act:()=>{
        closeModal();
        // 生效樣式寫進軌道當共同基準，再清掉全軌的逐句覆蓋（含這一句）→ 每句都長一樣
        for(const k of Object.keys(STYLE_DEFAULTS)) trk[k]=st[k];
        for(const c of State.cues) if((c.track||0)===i) delete c.style;
        styleChanged(); drawTimeline(); // 摘要就地更新（捲動位置留在原處）；時間軸重畫掉 ✱ 標記
        recordHistory('全軌統一樣式（'+來源+' → 全軌）');
        showToast('已把'+來源+'的樣式套用到整條軌道');
      }}]);
  });
  // 大小快捷鈕 / 顏色色票 — 委派點擊；一律經 tsSet（選取句 or 整軌）
  $('trackStyle').addEventListener('click',e=>{
    const sz=e.target.closest('.ts-preset[data-ts-size]');
    if(sz){ tsSet('fontSize', +sz.dataset.tsSize); return; }
    const cl=e.target.closest('.ts-clr');
    if(cl) tsSet('color', cl.dataset.color);
  });
  // 對齊改下拉（v4.32.2）：左右／上下＝多行多句彼此的對齊方式；位置一律由 X/Y 數值決定
  $('tsAlign')?.addEventListener('change',e=>tsSet('align', e.target.value));
  $('tsValign')?.addEventListener('change',e=>tsSet('valign', e.target.value));
  // 字幕檢查：字數上限輸入
  $('cpLenInput').addEventListener('input',()=>{ renderCheckPanel(); renderSubList(); });
  $('cpLenInput').addEventListener('keydown',e=>e.stopPropagation());
  // 全域數值輸入框滾輪微調 (Wheel Scrubber) 手感支援
  document.addEventListener('wheel', (e) => {
    const el = e.target;
    if (el && el.tagName === 'INPUT' && (el.type === 'number' || el.classList.contains('num-scrubber'))) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dir = e.deltaY < 0 ? 1 : -1;
      const min = el.min !== '' ? parseFloat(el.min) : -Infinity;
      const max = el.max !== '' ? parseFloat(el.max) : Infinity;
      const cur = parseFloat(el.value) || 0;
      const next = Math.max(min, Math.min(max, cur + dir * step));
      el.value = next;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, { passive: false });
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
  // 同步右下角狀態列的選取狀態至中間時間軸工具列
  const stSel = $('stSel'), tlSel = $('tlSel');
  if(stSel && tlSel) {
    const updateTl = () => {
      const txt = stSel.textContent;
      if(!txt || txt==='未選取') {
        tlSel.textContent = '未選取';
        tlSel.className = 'sel-none';
        stSel.className = 'sel-none';
        if(txt !== '未選取') stSel.textContent = '未選取';
      } else {
        tlSel.textContent = txt;
        if(txt.includes('已選 1 條')) {
           tlSel.className = 'sel-one';
           stSel.className = 'sel-one';
        } else {
           tlSel.className = 'sel-multi';
           stSel.className = 'sel-multi';
        }
      }
    };
    new MutationObserver(updateTl).observe(stSel, { childList: true, characterData: true, subtree: true });
    updateTl(); // initial sync
  }
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

/* 常用樣式庫：管理視窗（列表／套用／改名／刪除／分組）、編輯模式，以及匯入匯出。
   從 initUI 抽出來的連續區塊——執行順序不變（initUI 在原位置呼叫它）。
   抽出的理由是責任分離：這一段與「樣式面板九個控件的接線」互不相干，
   混在同一支 565 行的函式裡讓兩邊都不好讀。 */
function initPresetLibrary(){
  /* 常用樣式管理：每列＝小色票預覽＋名稱＋套用/改名/刪除。事件用委派（一次綁在 modalBody），
     操作後就地重繪列表、不關視窗（可連續管理）。 */
  const _presetSwatch=st=>`<span style="display:inline-block;min-width:30px;padding:2px 7px;border-radius:4px;`+
    `font-size:12px;font-weight:${st.bold?700:400};font-style:${st.italic?'italic':'normal'};`+
    `background:${st.bgBox?st.bgColor:'#222'};color:${st.color};`+
    `border:1px solid rgba(255,255,255,.2);${st.outline>0?`text-shadow:0 0 2px ${st.outlineColor},0 0 2px ${st.outlineColor};`:''}">字</span>`;
  function _renderPresetMgr(){
    // 清單＝內建（第一筆，不可改名／刪除）＋使用者自訂
    const list=getAllPresets();
    const body=$('modalBody'); if(!body)return;
    
    // 分組
    const groups = {};
    const orphans = [];
    list.forEach((p, i) => {
      if (p.builtin) {
        orphans.push({ p, i, text: p.name });
        return;
      }
      if (p.group) {
        if (!groups[p.group]) groups[p.group] = [];
        groups[p.group].push({ p, i, text: p.name });
      } else {
        orphans.push({ p, i, text: p.name });
      }
    });

    const renderItem = (item, isGrouped) => {
      const { p, i, text } = item;
      const st=Object.assign({},STYLE_DEFAULTS,p.style||{});
      const ui=i-BUILTIN_PRESETS.length;
      return `<div style="display:flex;align-items:center;gap:10px;padding:7px 4px;border-bottom:1px solid var(--border);">`+
        _presetSwatch(st)+
        `<span style="flex:1;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHTML(text)}`+
        (p.builtin?`<span style="margin-left:6px;font-size:10px;padding:1px 5px;border-radius:8px;background:var(--panel3);color:var(--text-faint)">內建</span>`:'')+
        `</span>`+
        `<button class="ts-preset" data-pre-apply="${i}" title="套用到目前選取的字幕（或整軌）">套用</button>`+
        (p.builtin
          ? `<span style="font-size:11px;color:var(--text-faint);opacity:.6;padding:0 6px">不可修改</span>`
          : `<button class="ts-preset" data-pre-edit="${ui}" title="在樣式面板上修改這組樣式；完成後所有套用它的字幕一起變">修改參數</button>`+
            `<button class="ts-preset" data-pre-ren="${ui}" title="重新命名，或是將它移入/移出資料夾">改名 / 移動</button>`+
            `<button class="ts-preset" data-pre-del="${ui}" style="color:var(--red,#e66)">刪除</button>`)+
        `</div>`;
    };

    let itemsHtml = orphans.map(o => renderItem(o, false)).join('');
    for (const g in groups) {
      itemsHtml += `<div style="display:flex;align-items:center;gap:10px;padding:7px 4px;border-bottom:1px solid var(--border);cursor:pointer;" onclick="if(event.target.closest('button'))return; const c=this.nextElementSibling; const e=c.style.display==='none'; c.style.display=e?'block':'none';">`+
        `<span style="font-size:14px;color:#ffca28;min-width:30px;text-align:center;">📁</span>`+
        `<span style="flex:1;font-size:14px;font-weight:bold;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHTML(g)}</span>`+
        `<button class="ts-preset" data-pre-ren-grp="${escapeHTML(g)}">改名</button>`+
        `<button class="ts-preset" data-pre-del-grp="${escapeHTML(g)}" style="color:var(--red,#e66)">刪除</button>`+
        `</div>`;
      itemsHtml += `<div style="margin-left:15px; padding-left:10px; border-left:1px solid #444; display:block;">` + groups[g].map(o => renderItem(o, true)).join('') + `</div>`;
    }

    body.innerHTML=`<div style="display:flex;justify-content:flex-end;gap:10px;margin-bottom:10px;padding:0 4px">`+
      `<button class="btn" id="preExportBtn" title="把自訂樣式存成 .json 檔">⭳ 匯出</button>`+
      `<button class="btn" id="preImportBtn" title="讀取 .json 檔並加入樣式庫">⭱ 匯入</button>`+
      `</div>`+
      `<div style="max-height:360px;overflow:auto;display:flex;flex-direction:column;gap:2px">`+
      itemsHtml +
      (getPresets().length?'':`<div style="color:var(--text-faint);font-size:12px;padding:10px 2px">尚未建立自訂樣式——在樣式面板調好後按「☆ 存為常用」即可新增。</div>`)+
      `</div>`;
  }
  const openPresetMgr = () => {
    openModal('⚙ 常用樣式管理','',[{label:'關閉',primary:true,act:closeModal}]); // 內建那筆一定在，不再擋空清單
    _renderPresetMgr();
  };
  $('tsPresetMgr').addEventListener('click', openPresetMgr);
  /* 判準只有 substyle.js 的 styleMatchesPreset 一份（v5.9.1 起）。
     以前這裡自己寫一份、subtitles.js 另有兩份，靠註解維持同步；
     而那些註解指名的函式早就改名了，註解沒跟上——這正是為什麼不能靠註解。 */
  const _sameStyle=(st,ps)=>styleMatchesPreset(st,ps);
  function _presetEditBegin(ui){
    const p=getPresets()[ui]; if(!p)return;
    const t=styleTarget(); if(!t){ showToast('沒有字幕軌可用來編輯'); return; }
    const old=Object.assign({},STYLE_DEFAULTS,p.style||{});
    // 先掃出「進入編輯前就符合舊樣式」的軌與句——套上草稿之後就分不出來了
    const targets={ tracks:[], cues:[] };
    State.tracks.forEach((tk,i)=>{ if(tk && _sameStyle(effStyle(null,tk),old)) targets.tracks.push(i); });
    for(const c of State.cues) if(c.style && Object.keys(c.style).length &&
      _sameStyle(effStyle(c,State.tracks[c.track||0]||null),old)) targets.cues.push(c);
    State.presetEdit={ name:p.name, ui, trackIdx:t.i, targets, old, draft: Object.assign({}, old) };
    closeModal();
    $('tsEditBar').hidden=false; $('tsEditName').textContent=p.name;
    styleChanged();
  }
  function _presetEditEnd(save){
    const E=State.presetEdit; if(!E)return;
    const draft = E.draft;
    State.presetEdit=null; $('tsEditBar').hidden=true;      // 先清旗標，styleTarget 才回正常行為
    if(!save || !draft){ styleChanged(); showToast('已取消編輯'); return; }
    const list=[...getPresets()]; const p=list[E.ui];
    if(p){ p.style=draft; savePresets(list); }
    // 同步：進入前就符合舊樣式的，一起換成新樣式
    let n=0;
    for(const i of E.targets.tracks){ if(State.tracks[i]){ Object.assign(State.tracks[i],draft); n++; } }
    for(const c of E.targets.cues){ c.style=Object.assign({},draft); n++; }
    styleChanged(); recordHistory('編輯常用樣式：'+E.name);
    showToast(`已更新「${E.name}」` + (n?`，同步 ${n} 處`:'（目前沒有套用它的字幕）'));
  }
  /* 直接呼叫上面那兩個函式。原本寫的是 State.presetEditEnd(...)，但 State 上
     【從來沒有】這兩個成員（全 repo 只有讀、沒有任何一處賦值），於是「完成」
     「取消」「修改參數」三顆按鈕一按就丟 TypeError。State 是無型別的物件袋、
     no-undef 也不檢查成員存取，app.js 又沒有測試，三道防線同時看不到。 */
  $('tsEditDone')?.addEventListener('click',()=>_presetEditEnd(true));
  $('tsEditCancel')?.addEventListener('click',()=>_presetEditEnd(false));
  $('tsEditPreviewText')?.addEventListener('input', () => { if(State.presetEdit) { renderVideoSub(); refreshMpvSubs(false, true); } });
  $('tsEditPreviewText')?.addEventListener('keydown', e => { e.stopPropagation(); });
  $('modalBody').addEventListener('click',async e=>{
    const applyB=e.target.closest('[data-pre-apply]');
    const editB=e.target.closest('[data-pre-edit]');
    const renB=e.target.closest('[data-pre-ren]');
    const renGrpB=e.target.closest('[data-pre-ren-grp]');
    const delB=e.target.closest('[data-pre-del]');
    const delGrpB=e.target.closest('[data-pre-del-grp]');
    const expB=e.target.closest('#preExportBtn');
    const impB=e.target.closest('#preImportBtn');

    if(renGrpB) {
      const oldG = renGrpB.dataset.preRenGrp;
      const newG = await promptModal('資料夾改名', '新名稱', oldG);
      if(!newG || newG === oldG) { openPresetMgr(); return; }
      const l = [...getPresets()];
      let changed = false;
      for (const p of l) {
        if ((p.group||'') === oldG) { p.group = newG; changed = true; }
      }
      if(changed) { savePresets(l); renderTrackStyle(); refreshStyleSummaries(); }
      openPresetMgr();
      return;
    }

    if(delGrpB){ 
      const grp = delGrpB.dataset.preDelGrp;
      if (confirm(`確定要刪除「${grp}」資料夾以及裡面所有的樣式嗎？\n\n（注意：刪除後無法復原）`)) {
        const l = getPresets().filter(p => p.group !== grp);
        savePresets(l); renderTrackStyle(); _renderPresetMgr(); refreshStyleSummaries(); showToast('已刪除資料夾：' + grp);
      }
      return; 
    }

    function _importPresets(j){
      if(!Array.isArray(j)){ showToast('檔案格式不符：非樣式陣列'); return; }
      const list = [...getPresets()];
      let count = 0;
      j.forEach(p => {
        if(p.name && p.style && !isBuiltinPresetName(p.name)){
          const ex = list.findIndex(x=>x.name===p.name);
          if(ex>=0) list[ex]=p; else list.push(p);
          count++;
        }
      });
      if(count>0){
        savePresets(list); _renderPresetMgr(); renderTrackStyle(); refreshStyleSummaries();
        showToast(`已匯入 ${count} 組樣式`);
      }else{
        showToast('找不到可匯入的樣式');
      }
    }

    if(expB){
      const presets = getPresets(); // 只匯出自訂樣式
      if(!presets.length){ showToast('沒有自訂樣式可匯出'); return; }
      if (IS_DESKTOP && DESK.exportDirectory) {
        const files = presets.map(p => {
          // 淨化規則在 export-name-safety.js（跨行程契約的一側，見該檔頭註解）。
          // group 直接來自匯入的 .json 內容（見下方匯入分支，items 原封不動 push
          // 進來），未洗過的 "../.." 會讓主程序的 path.join 正規化後跳出使用者
          // 選定的資料夾，把檔案寫到磁碟上任意位置。
          const str = JSON.stringify([p], null, 2);
          const bytes = new TextEncoder().encode(str);
          return { name: presetExportRelativePath(p), b64: bytesToB64(bytes) };
        });
        DESK.exportDirectory(files).then(dir => {
          if (dir) showToast('已匯出至：' + dir.split(/[\\/]/).pop());
        });
      } else {
        const str = JSON.stringify(presets, null, 2);
        const bytes = new TextEncoder().encode(str);
        const name = `presets_${new Date().toISOString().replace(/\\D/g,'').slice(0,14)}.json`;
        downloadBytes(bytes, name, 'application/json'); showToast('已匯出樣式設定');
      }
      return;
    }
    if(impB){
      if(IS_DESKTOP && DESK.importDirectory){
        DESK.importDirectory().then(files => {
          if(!files || !files.length) return;
          const all = [];
          for (const f of files) {
            try { 
              const str = new TextDecoder().decode(b64ToBytes(f.b64));
              const j = JSON.parse(str); 
              
              // Extract OS folder from path if it exists
              // f.name is a relative path like "My Folder/style.json"
              const parts = (f.name || '').replace(/\\/g, '/').split('/');
              const osFolder = parts.length > 1 ? parts[0] : null;

              const items = Array.isArray(j) ? j : [j];
              items.forEach(p => {
                 if (osFolder) p.group = osFolder; // Map OS folder to UI folder
                 all.push(p);
              });
            } catch(e){}
          }
          if (all.length) _importPresets(all);
        });
      }else{
        const fi=document.createElement('input'); fi.type='file'; fi.accept='.json'; fi.multiple=true;
        fi.onchange=async()=>{
          if(!fi.files.length)return;
          const all = [];
          for (const f of Array.from(fi.files)) {
            try { const j = JSON.parse(await f.text()); if (Array.isArray(j)) all.push(...j); else all.push(j); } catch(e){}
          }
          if (all.length) _importPresets(all);
        };
        fi.click();
      }
      return;
    }
    if(editB){ _presetEditBegin(+editB.dataset.preEdit); return; }
    if(applyB){ const p=getAllPresets()[+applyB.dataset.preApply]; const t=styleTarget();
      if(p&&t){
        if(t.cues.length){
          for(const c of t.cues){
            c.style=Object.assign(c.style||{},p.style);
            /* 套用會把該樣式的每一個欄位都寫成逐句覆蓋。若這句所在的軌本來就是
               同一組樣式，那些覆蓋一個都沒改變外觀，卻會讓列表標上 ✱（有逐句覆蓋）
               ——使用者「改回預設」反而多一個記號。與軌道相同的欄位在這裡清掉，
               真正有差異的覆蓋一律保留。 */
            pruneRedundantCueStyle(c, State.tracks[c.track||0]||null);
          }
        } else Object.assign(t.trk,p.style);
        styleChanged(); recordHistory('套用常用樣式：'+p.name); showToast('已套用：'+p.name); } return; }
    if(renB){ 
      const l=[...getPresets()], p=l[+renB.dataset.preRen]; if(!p)return;
      const groups = [...new Set(l.filter(x=>x.group).map(x=>x.group))];
      const groupOpts = groups.map(g => `<option value="${escapeHTML(g)}">`).join('');
      
      openModal('編輯名稱與資料夾',
        `<div style="font-size:13px;color:var(--text-dim);margin-bottom:4px">資料夾 (選填，可直接修改)</div>`+
        `<input type="text" id="__presetGroupRen" list="__presetGroupListRen" value="${escapeHTML(p.group||'')}" style="width:100%;margin-bottom:12px;padding:7px;background:var(--bg2);color:var(--text);border:1px solid var(--border2);border-radius:4px;">`+
        `<datalist id="__presetGroupListRen">${groupOpts}</datalist>`+
        `<div style="font-size:13px;color:var(--text-dim);margin-bottom:4px">樣式名稱</div>`+
        `<input type="text" id="__presetNameRen" value="${escapeHTML(p.name)}" style="width:100%;margin-bottom:12px;padding:7px;background:var(--bg2);color:var(--text);border:1px solid var(--border2);border-radius:4px;">`,
        [
          { label: '儲存', primary: true, act: () => {
            const nn = ($('__presetNameRen')?.value || '').trim();
            const ng = ($('__presetGroupRen')?.value || '').trim();
            if(!nn) { showToast('名稱不可為空'); return; }
            if(isBuiltinPresetName(nn)){ showToast('這是內建樣式的保留名稱，請換一個'); return; }
            
            const ex = l.find(x => x !== p && x.name === nn && (x.group||'') === ng);
            if (ex) {
              showToast('該資料夾中已有同名的樣式，請換一個名稱');
              return; 
            }
            
            p.name=nn; 
            if(ng) p.group=ng; else delete p.group;
            
            savePresets(l); renderTrackStyle(); refreshStyleSummaries(); 
            openPresetMgr(); // 重新開啟管理視窗
          }},
          { label: '取消', act: openPresetMgr }
        ]
      );
      setTimeout(() => { const el = $('__presetNameRen'); if(el){ el.focus(); el.select(); } }, 30);
      return; 
    }
    if(delB){ const l=[...getPresets()]; l.splice(+delB.dataset.preDel,1); savePresets(l); renderTrackStyle(); _renderPresetMgr(); refreshStyleSummaries(); showToast('已刪除'); }
  });
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
  const tk={name,visible:true,locked:false,...trackStyleSnapshot(srcTrack)};
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
function doCompareTrack() {
  if (State.tracks.length < 1) { showToast('沒有足夠的字幕軌道可供比對'); return; }
  if (window.subtool && window.subtool.openCompareWindow) {
    const data = {
      tracks: State.tracks,
      cues: State.cues,
      fps: State.fps,
      dropFrame: State.dropFrame
    };
    window.subtool.openCompareWindow(data);
  } else {
    showToast('此功能僅限桌面版使用');
  }
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
  if(!Media.mpvMode || !getPlayerAdapter().isAvailable) return;
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
  const fin=(commit)=>{ if(done)return; done=true; inp.remove(); span.textContent=secToEncore(Media.displayTime(),State.fps,State.dropFrame);
    if(commit){
      const raw=inp.value.trim(); let t=null;
      if(raw.startsWith('+')||raw.startsWith('-')){
        const sign=raw.startsWith('-')?-1:1;
        const delta=parseTimecodeInput(raw.slice(1));
        if(delta!==null){ t=Media.displayTime()+sign*delta;
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
  const formatTcInput = (el) => {
    if(!el) return;
    const raw = el.value.trim().replace(/^[+-]/, '');
    const sign = el.value.trim().startsWith('-') ? '-' : (el.value.trim().startsWith('+') ? '+' : '');
    const t = parseTimecodeInput(raw);
    if (t !== null) el.value = sign + secToEncore(t, State.fps, State.dropFrame);
  };
  ['tcShiftInput', 'durAdjTcInput'].forEach(id => {
    const el = $(id);
    if(el) {
      el.addEventListener('blur', () => formatTcInput(el));
      setupTimecodeInput(el);
      el.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); formatTcInput(el); }
      });
    }
  });
  $('durAdjPctInput')?.addEventListener('keydown',e=>{ e.stopPropagation(); if(e.key==='Enter'){e.preventDefault();applyDurAdjPct();} });
  $('durAdjMode')?.addEventListener('keydown',e=>e.stopPropagation());
  $('waveSrcSel')?.addEventListener('change',e=>{ Wave.selectSource(+e.target.value); e.target.blur(); });
  $('tcCur').addEventListener('dblclick',e=>{ e.preventDefault(); startTimeEdit(); });
  $('tcCur').addEventListener('contextmenu',e=>{ e.preventDefault();
    try{ navigator.clipboard.writeText(secToEncore(Media.displayTime(),State.fps,State.dropFrame)); showToast('已複製時間碼'); }catch(err){} });
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

function updateConfigUI() {
  document.querySelectorAll('.auto-select-btn').forEach(btn => {
    btn.textContent = State.autoSelect ? '自動選取' : '不自動選取';
    btn.classList.toggle('on', State.autoSelect);
  });
  document.querySelectorAll('.ow-toggle-btn').forEach(btn => {
    btn.textContent = State.overwriteMode ? '🔓 可覆蓋' : '🔒 不覆蓋';
    btn.classList.toggle('primary', State.overwriteMode);
  });
  document.querySelectorAll('.ow-keep-btn').forEach(btn => {
    btn.classList.toggle('inactive-mode', !State.overwriteMode);
    btn.textContent = State.overwriteKeep ? '⚪ 保留' : '❌ 刪除';
    btn.classList.toggle('del', !State.overwriteKeep);
  });
}

async function init(){
  await loadConfig();
  await loadKeys();
  $('safeFrameBtn')?.classList.toggle('active', !!State.safeFrame); // 安全框開關狀態還原（v4.33）
  $('timecodeWatermarkBtn')?.classList.toggle('active', !!State.timecodeWatermark);
  $('timecodeWatermarkBtn')?.setAttribute('aria-pressed', String(!!State.timecodeWatermark));
  updateConfigUI();
  State.fps=+$('fpsSel').value||24;
  const brandLogo=$('brandLogo'); if(brandLogo) brandLogo.src=_logoUrl;
  initUI();
  initMediaView(); initExtras(); initRecentProjects(); applyAriaLabels();
  renderAll(); layoutTimeline(); drawTimeline(); rafLoop();
  loadPresets().then(()=>renderTrackStyle()).catch(()=>{}); // v4.23 常用樣式庫（config 持久化）
  // v4.25.4 字幕字型：掃 <專案根>/font/ → 注入 @font-face → 填字型下拉（預覽與匯出同一份字型）
  loadFonts().then(fonts=>{
    const sel=$('tsFont'); if(!sel) return;
    const cur=sel.value;
    let html = '';
    if(fonts.length){
      html = fonts.map(f=>`<option value="${escapeHTML(f.name)}">${escapeHTML(f.name)}</option>`).join('');
    } else {
      // 若 font/ 資料夾為空，保留預設選項
      html = '<option>更紗黑體</option><option>台北黑體</option><option>思源黑體</option><option>思源宋體</option><option>粉圓字體</option><option>標楷體</option>';
    }
    sel.innerHTML = html + '<option value="__custom">匯入自訂字型...</option>';
    if(cur && [...sel.options].some(o=>o.value===cur)) sel.value=cur;
    renderVideoSub(); renderTrackStyle();
  }).catch(()=>{});
  History.reset();
  if(IS_DESKTOP) initDesktop();
  else setStatus('就緒 — 匯入影音或字幕開始','ok');
}
async function initDesktop(){
  const brand=document.querySelector('.brand');
  if(brand && !brand.querySelector('small')){ const sm=document.createElement('small'); sm.style.cssText='opacity:.55;font-size:11px;margin-left:6px;vertical-align:middle'; sm.textContent='桌面版'; brand.appendChild(sm); }
  document.querySelectorAll('.desktop-only').forEach(el=>{ el.style.display=''; }); // 顯示桌面專屬功能（匯出影片等）
  const nv=$('noVideo'); if(nv) nv.innerHTML='<b>尚未載入影音</b>點 <kbd>🎬 影音</kbd> 匯入<br>桌面版支援 MP4 / MOV / <b>MXF</b> / MKV / 多音軌（ffmpeg）<br>多音軌可同時混音播放，每軌獨立音量／獨奏';
  try{
    const s=await DESK.status();
    const eng=$('stEngine');
    if(eng){
      const hasGpu = !!(s.venc && s.venc !== 'libx264');
      eng.innerHTML = '引擎：' + (s.ffmpeg
        ? 'ffmpeg ✓' + (hasGpu
            ? ` · <b style="color:var(--green)">GPU ${String(s.venc).replace('h264_','').toUpperCase()}</b>`
            : ' · <span style="color:var(--text-faint)">CPU 編碼</span>')
        : '⚠ 未偵測到 ffmpeg');
      eng.title = s.ffmpeg
        ? (hasGpu
            ? `已偵測到 GPU 編碼器：${s.venc}\n· MP4（H.264）匯出：使用 GPU 編碼\n· ProRes 422 HQ 匯出：CPU 編碼（ffmpeg 無 GPU ProRes 編碼器）\n· 來源解碼：嘗試硬體加速\n匯出完成後，狀態列會顯示本次「實際使用」的編碼器。`
            : '未偵測到 GPU 編碼器，H.264 將以 CPU（libx264）編碼。')
        : '未偵測到 ffmpeg';
    }
    if(!s.ffmpeg){
      const isMac=s.platform==='darwin';
      openModal('未偵測到 ffmpeg', isMac
        ? `目前的 Apple Silicon App 套件缺少或無法啟動內建 <b>ffmpeg</b>。<br><br>`+
          `請重新安裝 arm64 版 SUB Tool；開發測試版請回到專案執行 <code>npm ci</code> 與 <code>npm run dist:mac:test</code>。<br>`+
          `也可透過 Homebrew 安裝 ffmpeg，或設定環境變數 <code>FFMPEG_PATH</code> 後重新開啟程式。<br><br>`+
          `MXF、proxy、多音軌抽取與影片匯出在修復前無法使用。`
        : `目前的桌面版缺少或無法啟動內建 <b>ffmpeg</b>。<br><br>`+
          `請重新安裝 SUB Tool；也可把 ffmpeg 加入 PATH，或設定環境變數 <code>FFMPEG_PATH</code>。<br><br>`+
          `MXF、proxy、多音軌抽取與影片匯出在修復前無法使用。`);
    }
    setStatus(s.ffmpeg ? '就緒（桌面模式）— 可直接讀 MXF 與多音軌' : '桌面模式 — ffmpeg 無法使用',s.ffmpeg?'ok':'err');
  }catch(e){ setStatus('就緒（桌面模式）','ok'); }
  let _visibleExportJobId = null;
  if ($('stStopBtn')) $('stStopBtn').onclick = () => {
    if (DESK.stopExport) DESK.stopExport(_visibleExportJobId);
  };
  if ($('stResumeBtn')) $('stResumeBtn').onclick = () => { if (DESK.queueResume) DESK.queueResume(); };

  let _queueStatus = { waitingCount: 0, missingCount: 0, isPaused: false };
  if (DESK.onQueueStatus) {
    DESK.onQueueStatus(s => {
      _queueStatus = s;
      _updateQueueStatusUI();
    });
  }

  function _updateQueueStatusUI() {
    if (_queueStatus.missingCount > 0) {
      showToast(`佇列中有 ${_queueStatus.missingCount} 份工作來源遺失，已被中止`);
      _queueStatus.missingCount = 0; // only show once per update
    }
    
    // 如果沒有執行中的任務，但有等待中且暫停，就顯示在狀態列
    if (_queueStatus.isPaused && _queueStatus.waitingCount > 0) {
      setStatus(`佇列已暫停（還有 ${_queueStatus.waitingCount} 份等待中）`, '', 'unlock');
      if ($('stResumeBtn')) $('stResumeBtn').style.display = 'inline-block';
    } else {
      if ($('stResumeBtn')) $('stResumeBtn').style.display = 'none';
    }
  }

  const _taskStarts = {};
  DESK.onProgress(d=>{
    if (d.jobId && String(d.jobId).startsWith('export-')) {
      if (!d.error && !d.stopped && !d.done) _visibleExportJobId = d.jobId;
      else if (_visibleExportJobId === d.jobId) _visibleExportJobId = null;
      if (d.error) {
        if ($('stStopBtn')) $('stStopBtn').style.display = 'none';
        let msg = d.errorMsg || '';
        let logPath = null;
        const m = msg.match(/\[LOG_PATH\](.*?)\[\/LOG_PATH\]/);
        if (m) {
          logPath = m[1];
          msg = msg.replace(/\[LOG_PATH\].*?\[\/LOG_PATH\]/, '').trim();
        }
        setStatus(`匯出失敗`, '', 'unlock');
        let modalBody = `<div style="font-size:13px;line-height:1.6;white-space:pre-wrap;">${msg.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>`;
        if (logPath) {
          modalBody += `<div style="margin-top:16px"><button onclick="subtool.openPath('${logPath.replace(/\\/g, '\\\\')}')" style="padding:4px 8px;cursor:pointer">開啟完整記錄</button></div>`;
        }
        openModal(`匯出失敗`, modalBody, [{ label: '關閉', primary: true, act: closeModal }]);
        setTimeout(_updateQueueStatusUI, 100);
      } else if (d.stopped) {
        if ($('stStopBtn')) $('stStopBtn').style.display = 'none';
        setStatus('已停止匯出', '', 'unlock');
        showToast('已停止匯出，半成品已刪除');
        setTimeout(_updateQueueStatusUI, 100);
      } else if (d.done) {
        if ($('stStopBtn')) $('stStopBtn').style.display = 'none';
        const r = d.result;
        if (!r) return;
        const isWav = r.encoder === 'pcm_s24le';
        const kindLabel = isWav ? '音訊' : '影片';
        const acc = isWav ? `${r.audioChannels} 軌 ${r.encoder}` : (r.gpu ? `GPU ${r.encoder}` : `CPU ${r.encoder}`);
        const br = r.videoKbps ? `，${(r.videoKbps / 1000).toFixed(1)}Mbps` : '';
        const actualAbr = Array.isArray(r.audioActualBitrates) && r.audioActualBitrates.length
          ? r.audioActualBitrates.map(stream => stream?.kbps > 0 ? `${stream.kbps}k` : '?').join('/') : '';
        const targetAbr = Array.isArray(r.audioBitrates) && r.audioBitrates.length ? r.audioBitrates.join('/') : '';
        const abr = actualAbr ? `，音訊 AAC 實測 ${actualAbr}` : (targetAbr ? `，音訊 AAC 目標 ${targetAbr}` : '');
        const secs = (r.elapsedMs / 1000).toFixed(1);
        setStatus(`已匯出${kindLabel}（${acc}${br}${abr}，耗時 ${secs}s）`, 'ok', 'unlock');
        showToast(`${kindLabel}已匯出（${acc}${br}${abr}）`);
        setTimeout(_updateQueueStatusUI, 100);
      } else {
        if ($('stStopBtn')) $('stStopBtn').style.display = 'inline-block';
        let tStr = '';
        const elS = Math.floor((d.elapsedMs || 0) / 1000);
        const fmt = s => `${Math.floor(s/60).toString().padStart(2,'0')}:${(s%60).toString().padStart(2,'0')}`;
        if (d.etaS !== null && d.etaS !== undefined) {
           tStr = ` [已用 ${fmt(elS)} / 剩餘 ${fmt(Math.floor(d.etaS))}]`;
        } else {
           tStr = ` [已用 ${fmt(elS)} / 估算中]`;
        }
        setStatus((d.label || '匯出中') + '… ' + d.pct + '%' + tStr, 'busy');
      }
      return;
    }

    if (d.pct === 0 || !_taskStarts[d.jobId]) _taskStarts[d.jobId] = Date.now();
    if(!d.done && d.pct<100) {
      const elMs = Date.now() - _taskStarts[d.jobId];
      let tStr = '';
      if (d.pct > 0 && elMs > 1000) {
        const total = elMs / (d.pct / 100);
        const remS = Math.floor((total - elMs) / 1000);
        const elS = Math.floor(elMs / 1000);
        const fmt = s => `${Math.floor(s/60).toString().padStart(2,'0')}:${(s%60).toString().padStart(2,'0')}`;
        tStr = ` [已用 ${fmt(elS)} / 剩餘 ${fmt(remS)}]`;
      }
      setStatus((d.label||'處理中')+'… '+d.pct+'%'+tStr,'busy','lock');
      if ($('stMedia')) $('stMedia').style.display = 'none'; // 隱藏媒體名稱以騰出空間，避免擠壓進度文字
    }
    if(d.done) {
      delete _taskStarts[d.jobId];
      setStatus((d.label||'轉檔')+'完成', 'ok', 'unlock');
      if ($('stMedia')) $('stMedia').style.display = ''; // 恢復顯示
      window.dispatchEvent(new CustomEvent('desk:ingest-done',{detail:d}));
    }
  });
  
  /* fromLaunch=true 是「這個程式就是為了開這個檔而啟動的」（雙擊 .subtool 冷啟動），
     那時還沒有任何專案內容，不必問。fromLaunch=false 是程式已經開著時又收到一個
     檔案（Explorer 再雙擊另一個 .subtool → second-instance → app:open-file），
     這時目前的專案可能有未存檔的變更，必須先問過——原本這條路徑直接覆蓋掉，
     使用者連一句提示都看不到。 */
  const handleStartupFile = async (file, { fromLaunch = false } = {}) => {
    if (!file) return;
    if (!fromLaunch && !await confirmDiscardUnsaved()) return;
    try {
      const b64 = await DESK.readB64(file);
      if (b64) Project.loadDesktop({ path: file, b64 });
      else setStatus('無法讀取專案檔內容');
    } catch(e) { console.error(e); }
  };

  if (DESK.getStartupFile) {
    DESK.getStartupFile().then(file => handleStartupFile(file, { fromLaunch: true }));
  }
  if (DESK.onOpenFile) {
    DESK.onOpenFile(file => handleStartupFile(file));
  }
  if (DESK.onSeekMain) {
    DESK.onSeekMain((payload) => {
      if (typeof payload === 'number') {
        Media.seek(payload);
      } else if (payload && typeof payload === 'object') {
        if (payload.trackIdx !== undefined && State.listTrack !== payload.trackIdx) {
          State.listTrack = payload.trackIdx;
          renderListTrackSel();
          renderTrackStyle();
          refreshTrackGutterActive();
          renderSubList();
        }
        if (payload.cueId !== undefined) {
          selectCueSingle(payload.cueId, false);
        }
        if (payload.time !== undefined) {
          Media.seek(payload.time);
        }
      }
    });
  }
  if (DESK.onCompareApplyStyle) {
    DESK.onCompareApplyStyle((cueId, fallbackDataObj) => {
      const cue = State.cues.find(c => c.id === cueId);
      
      let sourceCue = null;
      let fallbackData = fallbackDataObj;
      
      if (typeof fallbackDataObj === 'string') {
        if (fallbackDataObj.startsWith('c')) {
          // Old legacy: passed the ID string directly
          sourceCue = State.cues.find(c => c.id === fallbackDataObj);
          fallbackData = null;
        } else {
          try { fallbackData = JSON.parse(fallbackDataObj); } catch (e) {}
        }
      }

      if (fallbackData && !sourceCue) {
        if (fallbackData.id) {
          sourceCue = State.cues.find(c => c.id === fallbackData.id);
        }
        if (!sourceCue && typeof fallbackData.track === 'number' && typeof fallbackData.start === 'number') {
          sourceCue = State.cues.find(c => (c.track || 0) === fallbackData.track && Math.abs(c.start - fallbackData.start) <= 0.5);
        }
      }

      if (cue && sourceCue) {
        const sourceTk = State.tracks[sourceCue.track || 0];
        const targetTk = State.tracks[cue.track || 0];
        const sourceComputed = effStyle(sourceCue, sourceTk);
        const targetTrackSt = effStyle(null, targetTk);
        
        const newCueStyle = { ...cue.style };
        
        for (const k of Object.keys(STYLE_DEFAULTS)) {
          if (sourceComputed[k] !== targetTrackSt[k]) {
            newCueStyle[k] = sourceComputed[k];
          } else {
            delete newCueStyle[k];
          }
        }
        
        if (Object.keys(newCueStyle).length) {
          cue.style = newCueStyle;
        } else {
          delete cue.style;
        }
        
        recordHistory('匹配樣式');
        renderAll(); // This will re-render main UI
        if (DESK.syncCompareWindow) {
          DESK.syncCompareWindow({
            tracks: State.tracks,
            cues: State.cues,
            fps: State.fps,
            dropFrame: State.dropFrame
          });
        }
      } else {
        showToast(`失敗! Target:${cueId}, FD:${JSON.stringify(fallbackDataObj)}`);
      }
    });
  }
  if (DESK.onAppRequestClose) {
    DESK.onAppRequestClose(() => {
      if (isProjectDirty()) {
        openModal('儲存變更', '關閉前是否要儲存專案？', [
          // 等儲存真正完成（拿到路徑）才關閉；使用者取消存檔對話框則回到編輯畫面，避免資料遺失
          {label: '儲存', primary: true, act: async () => { const pth = await Project.save(); if (pth) { closeModal(); DESK.closeApp(); } else closeModal(); }},
          {label: '不儲存', act: () => { closeModal(); DESK.closeApp(); }},
          {label: '取消', act: () => { closeModal(); }}
        ]);
      } else {
        DESK.closeApp();
      }
    });
  }
}

/* 除錯把手：一律暴露（單機工具無安全疑慮）。
   桌面版遇到問題時可開 DevTools 以 window.SUB 檢視狀態，遠端診斷也依賴它。 */
{
  window.SUB = { State, Media, Wave, SubFormats, Project,
    selectCue, selectCueSingle, refreshSelectionUI, isSel, stepBoundary, setIn, setOut,
    addCue, addCueRelative, deleteSelected, moveSelectedToTrack, addTrack, removeTrack,
    renderAll, drawTimeline, renderVideoSub, renderSubList, renderListTrackSel, renderTrackStyle,
    renderCueBlocks, trackFromY, secToEncore, secToSRT, secToASS, newId, ensureTrackCount,
    syncTrackCount, sortCues, onDurationKnown, setZoom, zoomFit, zoomFitVideo, showCueMenu, showPlayerMenu,
    History, recordHistory, renderHistory, addNote, renderNotes, togglePanel,
    parseTimecodeInput, snapVal, snapTargets, cueNeighborBounds, setFps, snapFps, FPS_SET,
    toASSFromState, _stageRect }; // 三路一致診斷：ASS 產出＋字幕層座標基準（畫面實際顯示區）
  window.SUB.WC = { pocTest: _wcPocTest, demuxFile: _wcDemux, TrackDecoder: _wcTrackDecoder, preview: WCPreview,
    demuxIndex: _wcDemuxIndex, SampleReader: _wcSampleReader }; // 階段0 PoC＋階段1 預覽＋v4.29 串流式 demux（驗證/診斷入口）
  window.SUB.SubStyle = { effStyle, styleToCss, styleMatchesPreset, pruneRedundantCueStyle, verticalChars, STYLE_DEFAULTS, CUE_STYLE_KEYS, ASS_PLAY_RES, loadPresets, getPresets, getAllPresets, BUILTIN_PRESETS, isBuiltinPresetName, savePresets, styleSnapshot, loadFonts, getFonts, anchorPct }; // v4.23 字幕樣式（驗證/診斷入口）
}

async function takeScreenshot(withTimecode = false) {
  if (!State.duration && !State.mediaPath) { showToast('尚未載入影音'); return; }

  // 存哪、叫什麼名字的規則在 screenshot-target.js（純函式，可測）；這裡只負責編排。
  const tcStr = withTimecode ? secToEncore(Media.displayTime(), State.fps, State.dropFrame) : '';
  const tcSuffix = withTimecode ? timecodeSuffix(tcStr) : '';
  const dir = screenshotDir({ projectDir: getProjectDir(), mediaPath: State.mediaPath });

  let fullPath = '';
  let name = '';
  if (dir && IS_DESKTOP && DESK?.reserveScreenshotPath) {
    try {
      const reserved = await DESK.reserveScreenshotPath(dir, tcSuffix);
      fullPath = reserved?.path || '';
      name = reserved?.name || '';
    } catch (e) { console.error('[screenshot] reserve path error:', e); }
  } else {
    name = fallbackScreenshotName(Media.displayTime(), tcSuffix);
  }

  // 若為 MPV 模式
  if (Media.mpvMode && IS_DESKTOP && DESK && getPlayerAdapter() && getPlayerAdapter().screenshot && fullPath) {
    if (!withTimecode) {
      // 不需時間碼，直接請 mpv 存檔
      try {
        await getPlayerAdapter().screenshot(fullPath);
        // mpv 非同步存檔，稍等一下讓它寫入
        await new Promise(r => setTimeout(r, 300));
        setStatus(`截圖已儲存：${name}`, 'ok');
      } catch (e) {
        console.error('[screenshot] mpv screenshot error:', e);
        showToast('截圖失敗');
      }
      return;
    } else {
      // 需時間碼：請 mpv 存到暫存檔，讀入 JS 加工
      const tempPath = dir + '/.subtool_temp_shot.jpg';
      try {
        await getPlayerAdapter().screenshot(tempPath);
        await new Promise(r => setTimeout(r, 300)); // 等待寫入
        
        const b64 = await DESK.readB64(tempPath);
        if (!b64) throw new Error('Cannot read temp screenshot');
        
        const img = new Image();
        await new Promise((res, rej) => {
          img.onload = res; img.onerror = rej;
          img.src = 'data:image/jpeg;base64,' + b64;
        });

        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        
        // 畫時間碼
        const fontSize = Math.floor(canvas.height * 0.05);
        ctx.font = 'bold ' + fontSize + 'px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        const x = canvas.width / 2;
        const y = canvas.height * 0.95;
        const textWidth = ctx.measureText(tcStr).width;
        
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillRect(x - textWidth / 2 - 10, y - fontSize - 5, textWidth + 20, fontSize + 10);
        ctx.fillStyle = '#fff';
        ctx.fillText(tcStr, x, y);
        
        const outB64 = await new Promise(r => {
          canvas.toBlob(b => {
            const reader = new FileReader();
            reader.onloadend = () => r(reader.result.split(',')[1]);
            reader.readAsDataURL(b);
          }, 'image/jpeg', 0.9);
        });
        
        const result = await DESK.writeScreenshot(fullPath, outB64);
        if (result) {
           setStatus(`截圖已儲存：${name}`, 'ok');
           // 清理暫存檔（嘗試刪除但忽略錯誤，因為沒有 expose unlink，此處留著會被覆蓋）
        } else {
           throw new Error('writeScreenshot failed');
        }
      } catch (e) {
        console.error('[screenshot] MPV timecode shot error:', e);
        showToast('截圖失敗');
      }
      return;
    }
  }

  // ================= 瀏覽器或非 MPV 模式 (HTML5 Video) =================
  const canvas = document.createElement('canvas');
  canvas.width = State.videoWidth || 1920;
  canvas.height = State.videoHeight || 1080;
  const ctx = canvas.getContext('2d');
  
  const vid = document.getElementById('video');
  if (vid && vid.readyState >= 2) {
    ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
  } else {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  
  if (withTimecode) {
    const fontSize = Math.floor(canvas.height * 0.05);
    ctx.font = 'bold ' + fontSize + 'px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const x = canvas.width / 2;
    const y = canvas.height * 0.95;
    
    const textWidth = ctx.measureText(tcStr).width;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(x - textWidth / 2 - 10, y - fontSize - 5, textWidth + 20, fontSize + 10);
    ctx.fillStyle = '#fff';
    ctx.fillText(tcStr, x, y);
  }
  
  canvas.toBlob(async (blob) => {
    try {
      if (fullPath && DESK) {
        const b64 = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result.split(',')[1]);
          reader.readAsDataURL(blob);
        });
        const result = await DESK.writeScreenshot(fullPath, b64);
        if (result) setStatus(`截圖已儲存：${name}`, 'ok');
        else showToast('截圖儲存失敗');
        return;
      }
      
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      setStatus(`截圖下載：${name}`, 'ok');
    } catch (e) {
      showToast('截圖失敗');
    }
  }, 'image/jpeg', 0.9);
}

let _clipboardStyle = null;
function copySelectedStyle() {
  if (!State.selectedId) { showToast('請先選取一條字幕'); return; }
  const c = State.cues.find(x => x.id === State.selectedId);
  if (!c) return;
  const tk = State.tracks[c.track || 0];
  _clipboardStyle = JSON.parse(JSON.stringify(effStyle(c, tk)));
  setStatus('已拷貝字幕樣式', 'ok');
}

function pasteStyleToSelected() {
  if (!_clipboardStyle) { showToast('尚未拷貝樣式'); return; }
  const ids = State.selectedIds.length ? State.selectedIds : [State.selectedId].filter(Boolean);
  if (!ids.length) { showToast('請先選取字幕'); return; }
  
  let changed = false;
  for (const id of ids) {
    const c = State.cues.find(x => x.id === id);
    if (!c) continue;
    const tk = State.tracks[c.track || 0];
    const trackSt = effStyle(null, tk);
    const newCueStyle = { ...c.style };
    
    for (const k of Object.keys(STYLE_DEFAULTS)) {
      if (_clipboardStyle[k] !== trackSt[k]) {
        newCueStyle[k] = _clipboardStyle[k];
      } else {
        delete newCueStyle[k];
      }
    }
    
    if (JSON.stringify(newCueStyle) !== JSON.stringify(c.style || {})) {
      c.style = Object.keys(newCueStyle).length ? newCueStyle : undefined;
      changed = true;
    }
  }
  
  if (changed) {
    recordHistory('貼上字幕樣式');
    renderAll();
    setStatus('已貼上樣式', 'ok');
  }
}

setTimeout(() => {
  const audioTracksCountInput = document.getElementById('projectAudioTracksCount');
  if (audioTracksCountInput) {
    audioTracksCountInput.addEventListener('change', () => {
      const val = parseInt(audioTracksCountInput.value, 10);
      if (val >= 1 && val <= 32) {
        if (typeof AudioRouting !== 'undefined' && AudioRouting.setBusCount) {
          if (AudioRouting.setBusCount(val)) {
            setStatus(`已將專案音軌數設定為 ${val}`, 'ok');
            if (typeof emit === 'function') emit('render:all');
            if (typeof renderMixer === 'function') renderMixer();
            if (typeof renderAudioTracks === 'function') renderAudioTracks();
          } else {
            audioTracksCountInput.value = State.audioProject?.buses?.length || 2;
          }
        }
      }
    });
  }
}, 500);

init();

