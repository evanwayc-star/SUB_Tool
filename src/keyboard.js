/* SUB Tool — 鍵盤快捷鍵 + I/O 上字幕 + 邊界步進 + JKL 穿梭輪 */
import { $, video, sublist } from './dom.js';
import { State, cueSuffix } from './state.js';
import { clamp } from './util.js';
import { fmtClock, secToEncore, snapTimeToFrame, getExactFps } from './time.js';
import { Media } from './media.js';
import { Seq } from './sequence.js';
import { addCue, selectCue, selectCueSingle, commitCueTimeEdit, deleteSelected, addCueRelative, sortCues, cancelSwapMode, refreshSelectionUI, copyCues, pasteCues } from './subtitles.js';
import { updatePlayhead, zoomFit, zoomFitVideo, setZoom, drawTimeline, deleteSelectedClip, clearClipSelection, closeClipGapLeft } from './timeline.js';
import { Project, ensureProjectSaved } from './project.js';
import { History, recordHistory, renderHistory } from './history.js';
import { addNote, renderNotes, updateNoteActive } from './notes.js';
import { emit } from './events.js';
import { setStatus, closeModal, showOsd } from './ui.js';

/* ===== JKL 穿梭輪 ======================================================= */
/* _jklSpeed: 0=暫停, 1=正常播放, 2=2x播放, -1=1x倒帶, -2=2x倒帶 */
let _jklSpeed = 0;
let _jklTimer = null;

function jklClear(){
  if(_jklTimer){ clearInterval(_jklTimer); _jklTimer=null; }
}
function updateSpeedIndicator(){
  const el = document.getElementById('speedIndicator');
  if(!el) return;
  if (_jklSpeed === 0 || _jklSpeed === 1) {
    el.textContent = '1x';
    el.style.color = 'var(--text-faint)';
  } else if (_jklSpeed < 0) {
    el.textContent = _jklSpeed + 'x';
    el.style.color = '#ff4444';
  } else {
    el.textContent = _jklSpeed + 'x';
    el.style.color = '#44ff44';
  }
}
function resetPlaybackSpeed(){
  jklClear();
  _jklSpeed=0;
  Media.setRate(1);
  updateSpeedIndicator();
}
function jklApply(){
  jklClear();
  if(_jklSpeed===0){
    Media.pause();
    Media.setRate(1);
  } else if(_jklSpeed>0){
    Media.setRate(_jklSpeed);
    if(!Media.playing) Media.play();
  } else {
    // 負速度：暫停影片，用 interval 逐格倒退
    Media.pause();
    Media.setRate(1);
    const fps=30, step=Math.abs(_jklSpeed)/fps;
    const capturedSpeed=_jklSpeed;
    _jklTimer=setInterval(()=>{
      if(_jklSpeed!==capturedSpeed){ jklClear(); return; }
      const t=Media.vTime();
      if(t<=0){ jklClear(); _jklSpeed=0; setStatus('已到開頭',''); return; }
      const newT = Math.max(0,t-step);
      Media.seek(newT);
      updatePlayhead();
      emit('playhead:ensure');
      emit('render:videoSub');
      if(!video.src){
        $('tcCur').textContent=secToEncore(Media.vTime(),State.fps,State.dropFrame);
        $('seekBar').value=Math.round(Media.vTime()*1000);
      }
      Media.scrubAudio(newT, Math.max(step, 0.08));
    }, 1000/fps);
  }
  const spd=Math.abs(_jklSpeed);
  const label=_jklSpeed===0?'暫停':(_jklSpeed>0?`▶ ${spd}x 正播`:`◀ ${spd}x 倒帶`);
  const osd=_jklSpeed===0?'⏸':(_jklSpeed>0?`▶ ${spd}×`:`◀ ${spd}×`);
  setStatus(label, _jklSpeed!==0?'ok':'');
  showOsd(osd);
  updateSpeedIndicator();
}
/* 停止並重置 JKL（從外部呼叫，例如時間軸拖曳） */
function jklReset(){
  jklClear();
  _jklSpeed=0;
  Media.pause();
  Media.setRate(1);
  updateSpeedIndicator();
}

/* ===== 7. 鍵盤 (I/O 上字幕) =========================================== */
/* I = 設定目前被選字幕的「開始點」為播放點；無選取則新建一條 */
async function setIn(){
  await ensureProjectSaved();
  if(State.selectedIds.length>1){ setStatus('多選模式 — 請用 P 鍵整體位移','err'); return; }
  let t=snapTimeToFrame(Media.displayTime(), State.fps, State.dropFrame);
  let c=State.cues.find(x=>x.id===State.selectedId);
  if(!c){ c=addCue(t,snapTimeToFrame(t+2, State.fps, State.dropFrame),'',0); selectCue(c.id); recordHistory('新增字幕(I)'); setStatus('已新增字幕，起點 '+fmtClock(t),'ok'); return; }
  const wasUntimed = c.timed === false;
  c.start=t; 
  if (State.subMode) {
    // 先清理其他 _tempEnd 字幕（確保同一時間最多一條帶 _tempEnd）
    State.cues.forEach(cue => {
      if (cue._tempEnd && cue.id !== c.id) {
        cue.end = Math.min(cue.start + 2.0, (State.duration || Infinity));
        delete cue._tempEnd;
      }
    });
    c.end = (State.duration && State.duration > c.start) ? State.duration : c.start + 3600;
    c._tempEnd = true;
    // 記錄此字幕曾被 I 鍵設定，用於退出 subMode 時安全網清理
    if (!State._subModeTouchedIds) State._subModeTouchedIds = new Set();
    State._subModeTouchedIds.add(c.id);
  } else if(wasUntimed || c.end<=c.start) {
    c.end=snapTimeToFrame(c.start+0.5, State.fps, State.dropFrame);
  }
  c.timed=true;
  commitCueTimeEdit(c,'start'); // 局部更新（順序不變時不重建整列）
  recordHistory('設定起點 I'+cueSuffix(c)); setStatus('起點 '+fmtClock(t),'ok');
}
/* O = 設定目前被選字幕的「結束點」為播放點 */
async function setOut(){
  await ensureProjectSaved();
  if(State.selectedIds.length>1){ setStatus('多選模式 — 請用 P 鍵整體位移','err'); return; }
  let t=snapTimeToFrame(Media.displayTime(), State.fps, State.dropFrame);
  const c=State.cues.find(x=>x.id===State.selectedId);
  if(!c){ setStatus('請先選擇字幕（或按 I 新建）','err'); return; }
  
  const wasUntimed = c.timed === false;
  if (wasUntimed) {
    c.end = t;
    c.start = snapTimeToFrame(Math.max(0, t - 0.5), State.fps, State.dropFrame);
  } else {
    if(t<=c.start){ setStatus('終點不得早於或等於起點','err'); return; }
    c.end = t;
  }
  
  c.timed=true;
  delete c._tempEnd;
  commitCueTimeEdit(c,'end'); // 局部更新（end 不影響排序，必走局部）
  recordHistory('設定終點 O'+cueSuffix(c)); setStatus('終點 '+fmtClock(c.end),'ok');
  autoAdvanceSubMode();
}
/* 上字幕模式：O 後自動選取下一句，全部完成則關閉模式 */
function autoAdvanceSubMode(){
  if(!State.subMode || !State._subModeSequence) return;
  
  const seq = State._subModeSequence;
  const currIdx = seq.indexOf(State.selectedId);
  
  if (currIdx >= 0) {
    let nextIdx = currIdx + 1;
    while (nextIdx < seq.length) {
      const nextId = seq[nextIdx];
      // 確保該 ID 仍存在，並且與當前選擇同軌道
      const nextCue = State.cues.find(c => c.id === nextId);
      const currCue = State.cues.find(c => c.id === State.selectedId);
      if (nextCue && currCue && (nextCue.track || 0) === (currCue.track || 0)) {
        selectCueSingle(nextId, false);
        setStatus(`🎯 上字幕 (依原順序) — 按 I 設起點`,'ok');
        return;
      }
      nextIdx++;
    }
  }

  selectCueSingle(null);
  setStatus('🎯 上字幕模式：已無下一句，取消選取 ✓','ok');
}

/* ===== 媒體片段邊界步進 =================================================
   上／下箭頭用於播放頭在影像、外部音訊片段的頭尾間跳轉。字幕邊界仍保留給
   預設的 E / D（或使用者自行重新綁定的快捷鍵），因此不會混淆兩種剪輯操作。 */
const MEDIA_BOUNDARY_EPS = 1e-4;

function finiteTimelineTime(value, fallback=0){
  const n=Number(value);
  return Number.isFinite(n) ? Math.max(0,n) : fallback;
}

function externalPlacementBoundaries(asset){
  if(!asset || asset.timelineVisible===false) return [];
  // 支援目前的一來源一片段格式，也預留給同一音源被切成多個 placement 的格式。
  const placements=Array.isArray(asset.placements)&&asset.placements.length ? asset.placements : [asset];
  const points=[];
  for(const placement of placements){
    if(!placement || placement.timelineVisible===false) continue;
    const start=finiteTimelineTime(placement.offset ?? asset.offset);
    const inPoint=finiteTimelineTime(placement.in ?? asset.in);
    const duration=finiteTimelineTime(placement.duration ?? asset.duration);
    const rawOut=Number(placement.out ?? asset.out);
    const outPoint=Number.isFinite(rawOut) && rawOut>=inPoint ? rawOut : duration;
    const end=start+Math.max(0,outPoint-inPoint);
    points.push(start);
    if(end>start+MEDIA_BOUNDARY_EPS) points.push(end);
  }
  return points;
}

function mediaBoundaryPoints(){
  const points=[];
  for(const clip of State.clips){
    if(!clip || clip.timelineVisible===false) continue;
    const start=finiteTimelineTime(clip.offset);
    const end=Number(Seq.clipEnd(clip));
    points.push(start);
    if(Number.isFinite(end) && end>start+MEDIA_BOUNDARY_EPS) points.push(end);
  }
  for(const asset of Media.getExternalAudioSources()) points.push(...externalPlacementBoundaries(asset));

  points.sort((a,b)=>a-b);
  // 同一時間點可同時是數個影像／音訊片段邊界；按一次只需停一次。
  return points.reduce((unique,point)=>{
    if(!Number.isFinite(point)) return unique;
    if(!unique.length || Math.abs(point-unique[unique.length-1])>MEDIA_BOUNDARY_EPS) unique.push(point);
    return unique;
  },[]);
}

function stepMediaBoundary(dir){
  const points=mediaBoundaryPoints();
  if(!points.length) return false;
  const current=Media.displayTime();
  const target=dir>0
    ? points.find(point=>point>current+MEDIA_BOUNDARY_EPS)
    : [...points].reverse().find(point=>point<current-MEDIA_BOUNDARY_EPS);
  if(target==null) return false;
  Media.seek(target);
  updatePlayhead();
  emit('playhead:ensure');
  updateNoteActive(target);
  emit('render:videoSub');
  return true;
}

window.addEventListener('keydown',e=>{
  if($('modalBg').classList.contains('show')){ if(e.key==='Escape')closeModal(); return; }
  // 快捷鍵設定是獨立於 modalBg 的自訂對話框：開啟期間全域快捷鍵一律不作用（避免 Enter/Space 在背後觸發播放）
  if(document.getElementById('settingsModal'))return;
  if(e.isComposing || e.target.tagName==='INPUT'||e.target.tagName==='SELECT'||e.target.tagName==='TEXTAREA')return;
  if(document.activeElement?.isContentEditable){
    // 任何 contenteditable 編輯中（字幕列表 .txt、修改字幕視窗、軌道名稱、備註等）
    // 皆交由編輯器自身處理，全域快捷鍵不作用
    return;
  }
  // 影片段已選取：Del 刪除、Backspace 關閉前方空白、Esc 取消。
  // 上下鍵統一交給「媒體片段邊界」快捷鍵，讓已選取影片時也能跳到音訊片段邊界。
  if(State.selectedClipId!=null){
    const k=e.key;
    if(k==='Backspace'){ e.preventDefault(); closeClipGapLeft(); return; } // 移到前一段結尾／序列開頭
    if(k==='Delete'){ e.preventDefault(); deleteSelectedClip(); return; }
    if(k==='Escape'){ e.preventDefault(); clearClipSelection(); return; }
  }
  // 外部音訊素材與影片段同樣可直接刪除；選取狀態由 timeline 的音訊 block 維護。
  if(State.selectedAudioClipId!=null){
    const k=e.key;
    if(k==='Delete' || k==='Backspace'){
      e.preventDefault();
      const id=State.selectedAudioClipId;
      if(Media.removeExternalAudio?.(id)){
        State.selectedAudioClipId=null;
        const status=$('stSel'); if(status) status.textContent='';
        drawTimeline(); emit('render:videoSub');
      }
      return;
    }
    if(k==='Escape'){
      e.preventDefault(); State.selectedAudioClipId=null;
      const status=$('stSel'); if(status) status.textContent='';
      drawTimeline(); return;
    }
  }
  function matchAction(ev) {
    const key = ev.key.toLowerCase();
    const code = ev.code;
    const ctrl = ev.ctrlKey || ev.metaKey;
    const shift = ev.shiftKey;
    const alt = ev.altKey;
    // 數字鍵盤（NumLock 開）的字元鍵 key 值與主鍵盤相同（Numpad2 → '2'），
    // 若允許命中 key 綁定，會先撞上主鍵盤數字的動作（如 zoom_in 的 '2'）。
    // 故：數字鍵盤字元鍵只能以 code 綁定；key.length>1 的（NumpadEnter→'enter'、
    // NumLock 關時 Numpad2→'arrowdown'）不受限，照常走 key 綁定。
    const numpadChar = code && code.startsWith('Numpad') && key.length === 1;

    for (const [action, binds] of Object.entries(State.keymap)) {
      if (!binds) continue;
      for (const bind of binds) {
        if (!!bind.ctrl !== ctrl) continue;
        if (!!bind.shift !== shift) continue;
        if (!!bind.alt !== alt) continue;
        if (bind.code) { if (bind.code === code) return action; continue; } // 含 code 的綁定只比對 code
        if (numpadChar) continue;
        if (bind.key && bind.key === key) return action;
      }
    }
    return null;
  }

  const action = matchAction(e);
  if (!action) return;

  switch(action) {
    case 'toggle_play_pause':
      e.preventDefault();
      jklClear(); _jklSpeed=0; Media.setRate(1); updateSpeedIndicator();
      Media.toggle();
      setStatus(Media.playing?'▶ 正播':'⏸ 暫停', Media.playing?'ok':'');
      break;
    case 'rewind':
      e.preventDefault();
      if(_jklSpeed>=0) _jklSpeed=-1;
      else _jklSpeed=Math.max(-5, _jklSpeed-0.5);
      jklApply(); break;
    case 'pause':
      e.preventDefault(); _jklSpeed=0; jklApply(); break;
    case 'forward':
      e.preventDefault();
      if(_jklSpeed<=0) _jklSpeed=1;
      else _jklSpeed=Math.min(5, _jklSpeed+0.5);
      jklApply(); break;
    case 'zoom_out': e.preventDefault(); setZoom(State.pxPerSec*0.77); break;
    case 'zoom_in': e.preventDefault(); setZoom(State.pxPerSec*1.3); break;
    case 'zoom_fit':
      e.preventDefault();
      if(window._lastZoomMode === 'fit') { zoomFitVideo(); window._lastZoomMode = 'video'; }
      else { zoomFit(); window._lastZoomMode = 'fit'; }
      break;
    case 'prev_cue_5f': e.preventDefault(); jumpToCueInMinusFrames(-1, 5); break;
    case 'next_cue_5f': e.preventDefault(); jumpToCueInMinusFrames(1, 5); break;
    case 'toggle_history': e.preventDefault(); emit('action', 'history'); break;
    case 'toggle_notes': e.preventDefault(); emit('action', 'notes'); break;
    case 'toggle_check_panel': e.preventDefault(); emit('action', 'check-panel'); break;
    case 'search':
      e.preventDefault();
      const sd=document.getElementById('searchDialog'); 
      if(sd){ const show=sd.style.display==='none'||!sd.style.display; sd.style.display=show?'flex':'none'; if(show)setTimeout(()=>document.getElementById('searchInput')?.focus(),20); }
      break;
    case 'toggle_sub_mode': e.preventDefault(); emit('action', 'sub-mode'); break;
    case 'set_in': e.preventDefault(); setIn(); break;
    case 'set_out': e.preventDefault(); setOut(); break;
    case 'nudge_left_1f':
      e.preventDefault();
      if(e.repeat){ if(_jklSpeed>=0){_jklSpeed=-1;jklApply();} }
      else nudge(-1/getExactFps(State.fps||30));
      break;
    case 'nudge_left_1s': e.preventDefault(); nudge(-1); break;
    case 'nudge_left_5s': e.preventDefault(); nudge(-5); break;
    case 'nudge_right_1f':
      e.preventDefault();
      if(e.repeat){ if(_jklSpeed<=0){_jklSpeed=1;jklApply();} }
      else nudge(1/getExactFps(State.fps||30));
      break;
    case 'nudge_right_1s': e.preventDefault(); nudge(1); break;
    case 'nudge_right_5s': e.preventDefault(); nudge(5); break;
    case 'prev_note': e.preventDefault(); jumpToNote(-1); break;
    case 'next_note': e.preventDefault(); jumpToNote(1); break;
    case 'seek_home': e.preventDefault(); seekHome(); break;
    case 'seek_end': e.preventDefault(); seekEnd(); break;
    case 'prev_frame': e.preventDefault(); if(Media.playing) Media.pause(); nudge(-1/getExactFps(State.fps||30)); break;
    case 'next_frame': e.preventDefault(); if(Media.playing) Media.pause(); nudge(1/getExactFps(State.fps||30)); break;
    case 'step_boundary_prev':
      e.preventDefault();
      if(Media.playing) Media.pause();
      // 預設的 ↑ / ↓ 是媒體剪輯點；E / D 仍維持字幕邊界步進。
      if(e.key==='ArrowUp' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) stepMediaBoundary(-1);
      else stepBoundary(-1);
      break;
    case 'step_boundary_next':
      e.preventDefault();
      if(Media.playing) Media.pause();
      if(e.key==='ArrowDown' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) stepMediaBoundary(1);
      else stepBoundary(1);
      break;
    case 'first_cue': e.preventDefault(); jumpToFirstLastCue(-1); break;
    case 'last_cue': e.preventDefault(); jumpToFirstLastCue(1); break;
    case 'prev_cue': e.preventDefault(); jumpToAdjacentCue(-1); break;
    case 'next_cue': e.preventDefault(); jumpToAdjacentCue(1); break;
    case 'jump_cue_start':
      e.preventDefault();
      if(State.selectedId){
        const c = State.cues.find(x => x.id === State.selectedId);
        if(c && c.timed !== false){ Media.seek(c.start); updatePlayhead(); emit('playhead:ensure'); emit('render:videoSub'); }
      }
      break;
    case 'jump_cue_end':
      e.preventDefault();
      if(State.selectedId){
        const c = State.cues.find(x => x.id === State.selectedId);
        if(c && c.timed !== false){ Media.seek(c.end); updatePlayhead(); emit('playhead:ensure'); emit('render:videoSub'); }
      }
      break;
    case 'select_all':
      e.preventDefault();
      const tkCues=State.cues.filter(c=>(c.track||0)===State.listTrack);
      if(tkCues.length){
        State.selectedIds=tkCues.map(c=>c.id);
        State.selectedId=tkCues[0].id;
        refreshSelectionUI();
        const stSel = document.getElementById('stSel');
        if(stSel) stSel.textContent = '已選 '+State.selectedIds.length+' 條';
      }
      break;
    case 'save_project': e.preventDefault(); Project.save(); break;
    case 'save_as': e.preventDefault(); Project.saveAs(); break;
    case 'delete_selected': if(State.selectedIds.length||State.selectedId){e.preventDefault();deleteSelected();} break;
    case 'cancel':
      cancelSwapMode();
      if(State.subMode){ e.preventDefault(); emit('action', 'sub-mode'); jklReset(); }
      if(State.selectedId||State.selectedIds.length){
        e.preventDefault();
        State.selectedId=null; State.selectedIds=[];
        refreshSelectionUI();
        const stSel = document.getElementById('stSel');
        if(stSel) stSel.textContent='';
      }
      break;
    case 'shift_timecode': e.preventDefault(); {
      const ids=State.selectedIds.length?State.selectedIds:[State.selectedId].filter(Boolean);
      if(!ids.length)break;
      const jCues=ids.map(id=>State.cues.find(c=>c.id===id)).filter(c=>c&&c.timed!==false);
      if(!jCues.length)break;
      const minStart=Math.min(...jCues.map(c=>c.start));
      const jt=Media.displayTime(), delta=jt-minStart;
      for(const jc of jCues){ jc.start=Math.max(0,jc.start+delta); jc.end=Math.max(jc.start+0.001,jc.end+delta); }
      // v4.2.0 政策：位移不自動裁切/刪除被重疊的鄰居（與 subio.js applyTcShift 一致）
      sortCues(); emit('render:all'); drawTimeline();
      recordHistory('時間碼位移 P');
      setStatus(`P 位移 ${delta>=0?'+':''}${delta.toFixed(3)}s（${jCues.length} 條）`,'ok');
    } break;
    case 'undo': e.preventDefault(); History.undo(); break;
    case 'redo': e.preventDefault(); History.redo(); break;
    case 'toggle_auto_select': e.preventDefault(); emit('action','toggle-auto-select'); break;
    case 'toggle_overwrite': e.preventDefault(); emit('action', 'toggle-overwrite'); break;
    case 'toggle_overwrite_keep': e.preventDefault(); emit('action', 'toggle-ow-keep'); break;
    case 'copy_cues': e.preventDefault(); copyCues(); break;
    case 'paste_cues': e.preventDefault(); pasteCues(); break;
    case 'select_current':
      e.preventDefault();
      const t = Media.displayTime();
      const tk = State.listTrack || 0;
      const cx = State.cues.find(cx => (cx.track || 0) === tk && cx.timed !== false && cx.start <= t && cx.end > t);
      if (cx) { selectCueSingle(cx.id, false); setStatus('已選取目前字幕', 'ok'); }
      else { setStatus('目前時間點沒有字幕', ''); }
      break;
    case 'add_note': e.preventDefault(); addNote(); break;
    case 'split_clip':
      e.preventDefault();
      if(State.selectedAudioClipId&&typeof Media.splitExternalAudio==='function') void Media.splitExternalAudio(State.selectedAudioClipId,Media.displayTime());
      else Media.splitClipAt(Media.displayTime());
      break;
  }
});
window.addEventListener('keyup',e=>{
  if(e.key==='ArrowLeft'||e.key==='ArrowRight'){ if(_jklSpeed!==0)jklReset(); }
});
function nudge(d){
  // FPS-SYNC（詳見 FPS_時碼一致性.md）：以權威播放點（暫停時為已對齊幀格的 _lastSeekTime）
  // 為基準，避免讀 video.currentTime 的浮點 ε 經 seek 重新 round 後被放大，
  // 造成逐格時跳兩格／退不動（29.97fps 尤甚）
  const t=Media.displayTime()+d;
  Media.seek(t);
  updatePlayhead(); 
  emit('playhead:ensure'); 
  updateNoteActive(t); 
  if (!Media.playing && Math.abs(d) < 0.2) {
    Media.scrubAudio(t);
  }
}
function seekHome(){ Media.seek(0); updatePlayhead(); emit('playhead:ensure'); updateNoteActive(0); }
function seekEnd(){ const t=State.duration||0; Media.seek(t); updatePlayhead(); emit('playhead:ensure'); updateNoteActive(t); }

/* Ctrl+左/右：跳到上一個/下一個備註時間點 */
function jumpToNote(dir){
  if(!State.notes.length) return;
  const t=Media.displayTime(), EPS=1e-4;
  let target=null;
  if(dir>0){ for(const n of State.notes){ if(n.time>t+EPS&&(target===null||n.time<target.time))target=n; } }
  else      { for(const n of State.notes){ if(n.time<t-EPS&&(target===null||n.time>target.time))target=n; } }
  if(!target) return;
  Media.seek(target.time); updatePlayhead(); emit('playhead:ensure'); updateNoteActive(target.time);
}

/* Shift+Home/End：跳到同軌第一句 / 最後一句並選取 */
function jumpToFirstLastCue(dir){
  const list=State.cues.filter(c=>(c.track||0)===State.listTrack&&c.timed!==false);
  if(!list.length)return;
  const target=dir<0?list[0]:list[list.length-1];
  selectCueSingle(target.id,false);
  Media.seek(target.start);
  updatePlayhead();emit('playhead:ensure');
}

/* Ctrl+上/下：跳到同軌上一句/下一句的起點並選取 */
function jumpToAdjacentCue(dir){
  const sel=State.cues.find(c=>c.id===State.selectedId);
  const track=sel?(sel.track||0):State.listTrack;
  const list=State.cues.filter(c=>(c.track||0)===track);
  if(!list.length) return;
  let idx;
  if(sel){
    idx=list.findIndex(c=>c.id===sel.id)+dir;
  } else {
    const t=Media.displayTime();
    if(dir<0){
      idx=list.filter(c=>c.start<t-1e-4).length-1;
      if(Media.playing) idx -= 1;
    }
    else      idx=list.findIndex(c=>c.start>t+1e-4);
  }
  idx=Math.max(0,Math.min(list.length-1,idx));
  const target=list[idx];
  if(!target) return;
  if(Media.playing){
    State.selectedId=null;
    State.selectedIds=[];
    refreshSelectionUI();
    const stSel = document.getElementById('stSel');
    if(stSel) stSel.textContent='';
  } else {
    selectCueSingle(target.id, false);
  }
  Media.seek(target.start);
  updatePlayhead(); emit('playhead:ensure');
}

function jumpToCueInMinusFrames(dir, frames){
  const sel=State.cues.find(c=>c.id===State.selectedId);
  const track=sel?(sel.track||0):State.listTrack;
  const list=State.cues.filter(c=>(c.track||0)===track);
  if(!list.length) return;
  let idx;
  if(sel){
    idx=list.findIndex(c=>c.id===sel.id)+dir;
  } else {
    const t=Media.displayTime();
    if(dir<0) idx=list.filter(c=>c.start<t-1e-4).length-1;
    else      idx=list.findIndex(c=>c.start>t+1e-4);
  }
  idx=Math.max(0,Math.min(list.length-1,idx));
  const target=list[idx];
  if(!target) return;
  selectCueSingle(target.id, false);
  const targetTime = Math.max(0, target.start - (frames / State.fps));
  Media.seek(targetTime);
  updatePlayhead(); emit('playhead:ensure');
}

function stepBoundary(dir){
  const t = Media.displayTime();
  const EPS = 0.05; // 50ms寬容度，避免播放器時間小數點誤差

  const selTrack = State.listTrack;
  const timed = State.cues.filter(c => c.timed !== false && (c.track || 0) === selTrack);
  if (!timed.length) return;

  const selIdx = timed.findIndex(c => c.id === State.selectedId);
  let c = selIdx >= 0 ? timed[selIdx] : null;
  let cIdx = selIdx;

  // 如果播放點已經不在被選取的字幕範圍內（包含邊界寬容度），代表被手動拖走了，這時放棄當前選取，改依時間 t 尋找
  if (c && (t < c.start - EPS || t > c.end + EPS)) {
    c = null;
    cIdx = -1;
  }

  let targetId = null;
  let targetEdge = 'start';
  let targetTime = 0;

  if (dir > 0) {
    if (!c) {
      const bnd = [];
      for (const cue of timed) { bnd.push({id: cue.id, edge: 'start', t: cue.start}); bnd.push({id: cue.id, edge: 'end', t: cue.end}); }
      bnd.sort((a,b) => a.t - b.t);
      const nextBnd = bnd.find(b => b.t > t + EPS);
      if (nextBnd) { targetId = nextBnd.id; targetEdge = nextBnd.edge; targetTime = nextBnd.t; }
    } else {
      if (t < c.start - EPS) {
        targetId = c.id; targetEdge = 'start'; targetTime = c.start;
      } else if (t < c.end - EPS) {
        targetId = c.id; targetEdge = 'end'; targetTime = c.end;
      } else {
        if (cIdx < timed.length - 1) {
          const next = timed[cIdx + 1];
          targetId = next.id; targetEdge = 'start'; targetTime = next.start;
        } else {
          return;
        }
      }
    }
  } else {
    if (!c) {
      const bnd = [];
      for (const cue of timed) { bnd.push({id: cue.id, edge: 'start', t: cue.start}); bnd.push({id: cue.id, edge: 'end', t: cue.end}); }
      bnd.sort((a,b) => a.t - b.t);
      let prevBnd = null;
      for (let i = bnd.length - 1; i >= 0; i--) {
        if (bnd[i].t < t - EPS) { prevBnd = bnd[i]; break; }
      }
      if (prevBnd) { targetId = prevBnd.id; targetEdge = prevBnd.edge; targetTime = prevBnd.t; }
    } else {
      if (t > c.end + EPS) {
        targetId = c.id; targetEdge = 'end'; targetTime = c.end;
      } else if (t > c.start + EPS) {
        targetId = c.id; targetEdge = 'start'; targetTime = c.start;
      } else {
        if (cIdx > 0) {
          const prev = timed[cIdx - 1];
          targetId = prev.id; targetEdge = 'end'; targetTime = prev.end;
        } else {
          return;
        }
      }
    }
  }

  if (targetId) {
    selectCueSingle(targetId);
    State.activeEdge = targetEdge;
    Media.seek(targetTime);
    emit('playhead:ensure');
    updatePlayhead();
  }
}

export { setIn, setOut, nudge, stepBoundary, stepMediaBoundary, jklReset, resetPlaybackSpeed };
