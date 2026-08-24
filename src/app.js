import { startAppTicker } from './app-ticker.js';
import { StylePanelController } from './ui/style-panel-controller.js';
import { bindNumberInputWheel } from './number-input-wheel.js';
import { initMediaView } from './media-view.js';
/* ==============================================================================
   SUB Tool — 應用程式協調層與 UI 進入點 (App Layer / Entry Point)
   ==============================================================================
   
   【架構與職責總覽】
   本檔案 (app.js) 是本專案最頂層的協調與 UI 接線層。
   為了避免循環依賴 (Circular Dependency) 導致模組掛點，所有子模組 (如 media,
   subtitles, timeline) 均「不可直接 import app.js」。
   
   1. 單向事件綁定與派發
      各子模組透過 `events.js` 以 `emit(...)` 發送狀態變更；
      本檔透過 `on(...)` 訂閱並負責串接對應的渲染函式或邏輯。
      
   2. DOM 與全域事件管理
      負責初始化使用者介面、快捷鍵、頂層對話框與 Electron 事件接線。
      時間軸手勢、播放器指標互動與樣式面板各自位於專責模組。
      
   3. 跨進程介面介接 (Electron Bridge)
      當運行於桌面版 (DESK = true) 時，本檔會監聽來自 `main.js` 的 IPC 推播
      （如: mpv:event），將播放器事件映射回前端 DOM 的行為。

   【維護鐵律】
   - 切勿在此檔案中直接修改底層的 State (應交由 state.js 或 subtitles.js 提供之 Action)。
   - 新增功能時，繪圖進 `painters/` 或對應 renderer，資料規則進純領域模組；
     `subio.js` 只保留字幕 I/O 與匯出對話框協調。保持 app.js 單純負責「接線」。
============================================================================== */
"use strict";
import { refreshMpvSubs, renderVideoSub, _syncMpvPanel, renderImageOverlays, _selectImageClip, _imageBoxOf, _stageRect, drawSafeFrame, renderTimecodeWatermark, _setSubtitleHover, previewDrag, _firstLoad, setFirstLoad } from './video-renderer.js';
const _videoSub = document.getElementById('videoSub');
const _videoWrap = document.getElementById('videoWrap');
import _logoUrl from './logo.png';
import { clamp, pad, decodeText, encodeUTF16LE, downloadBytes, readFile, pickFile, b64ToBytes, bytesToB64, baseName, escapeHTML } from './util.js';
import { fmtClock, secToSRT, secToASS, secToEncore, getExactFps, srtToSec, assToSec, encoreToSec, snapTimeToFrame } from './time.js';
import { SubFormats, splitN } from './formats.js';
import { $, video, tlScroll, tlLayer, tlTracks, rulerCv, sublist } from './dom.js';
import { createCommands } from './commands.js';
import { renderPointerSeekControl, requestPointerSeek } from './pointer-seek-control.js';
import { togglePanel } from './ui.js';
import { applyCueStylePatch } from './style-commands.js';
import { State, syncTrackCount, FPS_SET, snapFps, setFps, ensureTrackCount, trackVisible, videoTrackVisible, newId, DESK, IS_DESKTOP, isSel, cueSuffix, loadConfig, saveConfig, loadKeys, saveKeys, clearSelection, setSelection, deselect } from './state.js';
import { Media, Wave } from './media.js';
import { AudioRouting } from './audio-routing.js';
import { RULER_H, ROW_H, tracksTop, tracksScrollTop, viewportW, timeToX, xToTime, layoutTimeline, drawRuler, niceStep, fmtTick, drawWave, renderTrackRows, renderCueBlocks, trackFromY, addTrack, removeTrack, moveSelectedToTrack, updatePlayhead, drawTimeline, setZoom, zoomFit, zoomFitVideo, refreshTrackGutterActive, snapTargets, snapVal, cueNeighborBounds } from './timeline.js';
import { renderSubList, renderCheckPanel, renderSubRow, selectCue, selectCueSingle, refreshSelectionUI, updateTlSel, deleteSelected, refreshStyleSummaries, updateSearchCount } from './subtitles.js';
import { addCue, addCueRelative, deleteCue, sortCues, trimTrackSpaces, snapAllCuesToFrames } from './subtitle-model.js';
import { searchUpdate, searchNav, searchReplace, searchSelectAll } from './subtitle-search.js';
import { initRecentProjects } from './recent-projects.js';
import { setIn, setOut, nudge, stepBoundary } from './keyboard.js';
import { Project, isProjectDirty, confirmDiscardUnsaved } from './project.js';
import { Seq } from './sequence.js';
import { showCtx, hideCtx, showCueMenu, showPlayerMenu } from './menus.js';
import { History, recordHistory, renderHistory, syncCompareSnapshot } from './history.js';
import { pocTest as _wcPocTest, demuxFile as _wcDemux, TrackDecoder as _wcTrackDecoder, demuxIndex as _wcDemuxIndex, SampleReader as _wcSampleReader } from './decode/diagnostics.js'; // WebCodecs 診斷入口（掛 window.SUB.WC）
import { WCPreview } from './decode/player.js'; // 階段1：WebCodecs 接管原生預覽畫面（rafLoop 每幀 tick）
import { effStyle, styleToCss, verticalChars, STYLE_DEFAULTS, CUE_STYLE_KEYS, ASS_PLAY_RES, loadPresets, getPresets, getAllPresets, BUILTIN_PRESETS, isBuiltinPresetName, savePresets, styleSnapshot, loadFonts, getFonts, posToPx, anchorPct, styleMatchesPreset, pruneRedundantCueStyle } from './substyle.js'; // v4.23 字幕樣式系統
import { closeSubtitleCompareSession, configureSubtitleCompareSession, handleSubtitleCompareCommand } from './subtitle-compare-session.js';
import { addNote, renderNotes, setNoteActive, updateNoteActive } from './notes.js';
import { createPreviewDrag } from './pointer-interaction.js';
import { setStatus, showToast, showOsd, openModal, closeModal, promptModal, closeMenus, openMenu } from './ui.js';
import { renderAudioTracks, renderMixer, updateMeters } from './mixer.js';
import { applyDurAdjPct, toASSFromState } from './subio.js';
import { parseTimecodeInput, setupTimecodeInput } from './tcparse.js';
import { imageBoxOnStage } from './image-geometry.js'; // v4.7 圖片疊層幾何：預覽／mpv guide／匯出 共用同一組公式
import { fadeAlphaAtTimeline } from './clip-fade.js'; // v5.9 淡入淡出：預覽與匯出共用同一份規格
import { presetExportRelativePath } from './export-name-safety.js';
import { renderSeekBar } from './seekbar.js';
import { on, emit } from './events.js';
import { setTimelineToolbarCollapsed, toggleTimelineToolbar } from './timeline-toolbar.js';

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
on('render:trackStyle', StylePanelController.renderTrackStyle); // 換選取字幕 → 樣式面板換對象（v4.31）
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
   日後若真需要跨模組開面板，請【同時】加上發送端，不要只留一半（見 docs/技術架構說明.md 的 events.js 章節）。 */
on('note:openInPanel', openNoteInPanel);
on('cue:openEdit', StylePanelController.openCueEditModal);
on('action', doAction);
on('mpv:sync', _syncMpvPanel); // 自訂視窗（快捷鍵設定、右鍵選單）開閉時重算 mpv 讓位
on('history:record', recordHistory); // 供 media.js 等低階模組記錄歷史（避免 media→history 循環相依）
on('project:relinkBrowserMedia', (generation, projectRestore)=>{
  void Commands.run('open-media', { relink: { generation, plan: projectRestore } })
    .catch(error=>console.warn('relink browser project media:',error));
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
    renderVideoSub(); refreshMpvSubs(false, true); StylePanelController.renderTrackStyle();
    return;
  }
  renderVideoSub(); refreshMpvSubs(); StylePanelController.renderTrackStyle(); refreshStyleSummaries();
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
window._ensurePlayheadVisible = ensurePlayheadVisible;
window._markActiveRow = markActiveRow;

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
$('seekBar').addEventListener('input',e=>{ renderSeekBar(e.target); const t=(+e.target.value)/1000; requestPointerSeek(t); updateNoteActive(t); });
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




// A4：純關閉面板的 case 改用資料表，消除重複的 classList.remove('show')+_syncMpvPanel()
/* 指令表住在 commands.js —— 82 個 case 的 switch 攤成一張可列舉的表之後，
   tests/commands.test.js 才有辦法回答「index.html 上這顆按鈕真的有實作嗎」。
   指令的 production actions 由 commands.js 直接組裝；app.js 只保留事件入口。 */
const Commands = createCommands();
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
  StylePanelController.renderTrackStyle();
  updateSearchCount();
}
/* 「編輯常用樣式」模式（v4.34.0）。
   做法：暫借目前軌道當草稿——把該常用樣式套上去，使用者就能用原本那套面板控制項邊調邊
   看即時預覽（三路照常運作，不必為編輯模式另做一份 UI）。按「完成」才寫回 preset。
   entry: { name, before, trackIdx, targets:{tracks:[i], cues:[cue]} }
   targets ＝【進入編輯前】就已符合舊樣式的軌與句，完成時一起改成新樣式（＝使用者說的
   「改完所有套用這個名字的也跟著變」）。名稱比對本來就是「樣式完全相符」，判準見
   substyle.js styleMatchesPreset()——所以這裡也只能用相符來判定，沒有存名稱的欄位。 */

/* 樣式面板的編輯對象（v4.31）：【選取中的那一句】；沒選任何句子時才退回整軌。
   ── 使用者要的是「改樣式只影響這一句，要套到全部才按『全軌統一』」。 */
/* 面板要改的對象。
   cues＝【本軌所有被選取的句子】——多選時樣式要全部一起改（v4.34.0 前只改到 selectedId
   那一句，使用者多選了三句卻只有第一句變）；cue＝其中第一句，只作為面板顯示的代表值。
   完全沒選任何句子時 cues 為空陣列 ＝ 改的是整軌。 */




/* ===== 時間軸：雙擊字幕區塊內嵌編輯文字 ===== */


let _covCleared=false; // 本次開窗有沒有按過「清除全部覆蓋」（決定要不要連座標／角度一起清）


/* ===== UI 接線（區塊切換 / 樣式 / 分隔線 / 捲動同步 / 雙擊） ===== */
function initUI(){
  // 軌道切換下拉
  $('listTrackSel').addEventListener('change',e=>{ State.listTrack=+e.target.value; deselect('sub'); $('stSel').textContent=''; searchUpdate(); renderSubList(); StylePanelController.renderTrackStyle(); refreshSelectionUI(); refreshTrackGutterActive(); });
  const sf = $('subStyleFilter');
  if (sf) {
    sf.addEventListener('change', () => { deselect('sub'); $('stSel').textContent=''; renderSubList(); });
  }
  const waveGlobalSrcSel=$('waveGlobalSrcSel');
  if(waveGlobalSrcSel) waveGlobalSrcSel.addEventListener('change',e=>{ Media.switchSource(e.target.value==='__all__'?null:e.target.value); renderMixer(); e.target.blur(); });

  /* 唯一的樣式寫入點（v4.31）：有選取字幕 → 寫該句的逐句覆蓋；沒選 → 寫整軌。
     ── 面板九個控件本來各自 `State.tracks[i][k]=v`，等於「改樣式一律套全軌」。 */
    StylePanelController.bindStylePanelEvents({ renderAll, renderVideoSub, refreshMpvSubs, drawTimeline, refreshStyleSummaries, initPresetLibrary, styleChanged });
  ;
  // 字幕檢查：字數上限輸入
  $('cpLenInput').addEventListener('input',()=>{ renderCheckPanel(); renderSubList(); });
  $('cpLenInput').addEventListener('keydown',e=>e.stopPropagation());
  // 全域數值輸入框滾輪微調：每個欄位遵守自己的 step（行距＝0.1、字距＝0.5）。
  bindNumberInputWheel(document);
  // 字幕檢查：包含文字輸入
  $('cpContainsInput').addEventListener('input',()=>{ renderCheckPanel(); renderSubList(); });
  $('cpContainsInput').addEventListener('keydown',e=>e.stopPropagation());
  // 搜尋浮動視窗
  $('searchInput').addEventListener('input',()=>searchUpdate($('searchInput').value));
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
        tlSel.innerHTML = stSel.innerHTML;
        const isSingle = /已選(取)?\s*1\s*[句條]/.test(txt) ||
                         txt.startsWith('已選圖片') ||
                         txt.startsWith('已選音訊') ||
                         txt.startsWith('已選影片段') ||
                         txt.startsWith('已切換至');
        if(isSingle) {
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
      gw:gt?gt.style.width||'':'',
      tc:!!$('tlToolbarOptions')?.hidden
    }));
  };
  const loadLayout=()=>{
    try{
      const d=JSON.parse(localStorage.getItem(_LAYOUT_KEY)||'{}');
      if(d.rw) $('rightPanel').style.width=d.rw;
      if(d.th) $('timelinePanel').style.height=d.th;
      const gt=$('tlGutter'); if(d.gw&&gt) gt.style.width=d.gw;
      setTimelineToolbarCollapsed({ button:$('tlToolbarToggle'), options:$('tlToolbarOptions') }, d.tc===true);
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
  $('tlToolbarToggle')?.addEventListener('click',()=>{
    toggleTimelineToolbar({ button:$('tlToolbarToggle'), options:$('tlToolbarOptions') });
    saveLayout();
  });
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
    const t=StylePanelController.styleTarget(); if(!t){ showToast('沒有字幕軌可用來編輯'); return; }
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
    State.presetEdit=null; $('tsEditBar').hidden=true;      // 先清旗標，StylePanelController.styleTarget 才回正常行為
    if(!save || !draft){ styleChanged(); showToast('已取消編輯'); return; }
    const list=[...getPresets()]; const p=list[E.ui];
    if(p){ p.style=draft; savePresets(list); }
    // 同步：進入前就符合舊樣式的，一起換成新樣式
    let n=0;
    for(const i of E.targets.tracks){ if(State.tracks[i]){ Object.assign(State.tracks[i],draft); n++; } }
    for(const c of E.targets.cues){ applyCueStylePatch(c, draft); n++; }
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
      if(changed) { savePresets(l); StylePanelController.renderTrackStyle(); refreshStyleSummaries(); }
      openPresetMgr();
      return;
    }

    if(delGrpB){ 
      const grp = delGrpB.dataset.preDelGrp;
      if (confirm(`確定要刪除「${grp}」資料夾以及裡面所有的樣式嗎？\n\n（注意：刪除後無法復原）`)) {
        const l = getPresets().filter(p => p.group !== grp);
        savePresets(l); StylePanelController.renderTrackStyle(); _renderPresetMgr(); refreshStyleSummaries(); showToast('已刪除資料夾：' + grp);
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
        savePresets(list); _renderPresetMgr(); StylePanelController.renderTrackStyle(); refreshStyleSummaries();
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
    if(applyB){ const p=getAllPresets()[+applyB.dataset.preApply]; const t=StylePanelController.styleTarget();
      if(p&&t){
        if(t.cues.length){
          for(const c of t.cues){
            applyCueStylePatch(c, p.style);
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
            
            savePresets(l); StylePanelController.renderTrackStyle(); refreshStyleSummaries(); 
            openPresetMgr(); // 重新開啟管理視窗
          }},
          { label: '取消', act: openPresetMgr }
        ]
      );
      setTimeout(() => { const el = $('__presetNameRen'); if(el){ el.focus(); el.select(); } }, 30);
      return; 
    }
    if(delB){ const l=[...getPresets()]; l.splice(+delB.dataset.preDel,1); savePresets(l); StylePanelController.renderTrackStyle(); _renderPresetMgr(); refreshStyleSummaries(); showToast('已刪除'); }
  });
}

function openNoteInPanel(n){
  $('notesPanel').classList.add('show');
  setNoteActive(n.id);
  renderNotes();
  setTimeout(()=>{
    $('notesList')?.querySelector(`[data-id="${n.id}"]`)?.scrollIntoView({block:'nearest'});
  },30);
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
    btn.textContent = State.overwriteKeep ? '📌 保留' : '✂️ 裁切';
    btn.classList.toggle('keep', State.overwriteKeep);
    btn.classList.toggle('del', !State.overwriteKeep);
  });
  renderPointerSeekControl();

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
  renderAll(); layoutTimeline(); drawTimeline(); startAppTicker(renderVideoSub);
  loadPresets().then(()=>StylePanelController.renderTrackStyle()).catch(()=>{}); // v4.23 常用樣式庫（config 持久化）
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
    renderVideoSub(); StylePanelController.renderTrackStyle();
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
  const handleStartupFile = async (incoming, { fromLaunch = false } = {}) => {
    if (!incoming) return;
    if (!fromLaunch && !await confirmDiscardUnsaved()) return;
    try {
      const opened = typeof incoming === 'object' && typeof incoming.path === 'string'
        ? incoming
        : { path: incoming, b64: await DESK.readB64(incoming) };
      if (opened.b64) Project.loadDesktop(opened);
      else setStatus('無法讀取專案檔內容');
    } catch(e) { console.error(e); }
  };

  if (DESK.getStartupFile) {
    DESK.getStartupFile().then(file => handleStartupFile(file, { fromLaunch: true }));
  }
  if (DESK.onOpenFile) {
    DESK.onOpenFile(file => handleStartupFile(file));
  }
  configureSubtitleCompareSession({
    port: {
      open: payload => DESK.openCompareWindow(payload),
      sync: payload => DESK.syncCompareWindow(payload),
    },
    onSeek: ({ cueId }) => {
      const cue = State.cues.find(item => item.id === cueId);
      if (!cue) return false;
      const trackIndex = cue.track || 0;
      if (State.listTrack !== trackIndex) {
        State.listTrack = trackIndex;
        renderListTrackSel();
        StylePanelController.renderTrackStyle();
        refreshTrackGutterActive();
        renderSubList();
      }
      selectCueSingle(cueId, false);
      requestPointerSeek(cue.start);
      return true;
    },
    onMatchStyle: ({ targetCueId, sourceCueId }) => {
      const targetCue = State.cues.find(item => item.id === targetCueId);
      const sourceCue = State.cues.find(item => item.id === sourceCueId);
      if (!targetCue || !sourceCue) return false;
      const sourceStyle = effStyle(sourceCue, State.tracks[sourceCue.track || 0] || null);
      if (!applyCueStylePatch(targetCue, sourceStyle)) return true;
      recordHistory('匹配樣式');
      renderAll();
      return true;
    },
  });
  if (DESK.onCompareCommand) {
    DESK.onCompareCommand(command => {
      const result = handleSubtitleCompareCommand(command);
      if (!result.accepted) console.warn('[compare] command rejected:', result.reason);
    });
  }
  if (DESK.onCompareClosed) DESK.onCompareClosed(() => closeSubtitleCompareSession());
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
    renderAll, drawTimeline, renderVideoSub, renderSubList, renderListTrackSel, renderTrackStyle: StylePanelController.renderTrackStyle,
    renderCueBlocks, trackFromY, secToEncore, secToSRT, secToASS, newId, ensureTrackCount,
    syncTrackCount, sortCues, onDurationKnown, setZoom, zoomFit, zoomFitVideo, showCueMenu, showPlayerMenu,
    History, recordHistory, renderHistory, addNote, renderNotes, togglePanel,
    parseTimecodeInput, snapVal, snapTargets, cueNeighborBounds, setFps, snapFps, FPS_SET,
    toASSFromState, _stageRect }; // 三路一致診斷：ASS 產出＋字幕層座標基準（畫面實際顯示區）
  window.SUB.WC = { pocTest: _wcPocTest, demuxFile: _wcDemux, TrackDecoder: _wcTrackDecoder, preview: WCPreview,
    demuxIndex: _wcDemuxIndex, SampleReader: _wcSampleReader }; // 階段0 PoC＋階段1 預覽＋v4.29 串流式 demux（驗證/診斷入口）
  window.SUB.SubStyle = { effStyle, styleToCss, styleMatchesPreset, pruneRedundantCueStyle, verticalChars, STYLE_DEFAULTS, CUE_STYLE_KEYS, ASS_PLAY_RES, loadPresets, getPresets, getAllPresets, BUILTIN_PRESETS, isBuiltinPresetName, savePresets, styleSnapshot, loadFonts, getFonts, anchorPct }; // v4.23 字幕樣式（驗證/診斷入口）
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
