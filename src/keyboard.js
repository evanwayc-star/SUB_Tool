/* ==============================================================================
   SUB Tool — 快捷鍵控制與防抖攔截模組 (Keyboard Layer)
   ==============================================================================
   
   【架構與職責總覽】
   本檔案 (keyboard.js) 是全站的鍵盤事件集散地。
   負責：快捷鍵映射 (Key Mapping)、打字輸入防抖 (Typing Debounce)、
   以及按鍵事件的分派。
   
   所有播放控制、JKL 穿梭定時器與時碼導航邏輯，均封裝在 transport-controller 模組中。
   ============================================================================== */
import { $ } from './dom.js';
import { State, setSelection, deselect } from './state.js';
import { Media } from './media.js';
import { selectCueSingle, deleteSelected, cancelSwapMode, refreshSelectionUI } from './subtitles.js';
import { sortCues, copyCues, pasteCues } from './subtitle-model.js';
import { updatePlayhead, zoomFit, zoomFitVideo, setZoom, drawTimeline, deleteSelectedClip, clearClipSelection, closeClipGapLeft } from './timeline.js';
import { Project } from './project.js';
import { History, recordHistory } from './history.js';
import { addNote } from './notes.js';
import { emit } from './events.js';
import { setStatus, closeModal } from './ui.js';
import { matchAction } from './keybinding.js';
import {
  jklClear,
  jklApply,
  jklReset,
  getJklSpeed,
  setJklSpeed,
  shuttleRewind,
  shuttlePause,
  shuttleForward,
  togglePlayPause,
  stepFrame,
  resetPlaybackSpeed,
  setManualPlaybackSpeed,
  updateSpeedIndicator,
  nudge,
  seekHome,
  seekEnd,
  jumpToNote,
  jumpToFirstLastCue,
  jumpToAdjacentCue,
  jumpToCueInMinusFrames,
  stepBoundary,
  stepMediaBoundary,
  setIn,
  setOut,
} from './transport-controller.js';

const _keysPressed = new Set();
window.addEventListener('keyup', e => {
  _keysPressed.delete(e.key.toLowerCase());
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    if (getJklSpeed() !== 0) jklReset();
  }
});

window.addEventListener('keydown', e => {
  _keysPressed.add(e.key.toLowerCase());
  if ($('modalBg').classList.contains('show')) { if (e.key === 'Escape') closeModal(); return; }
  // 快捷鍵設定是獨立於 modalBg 的自訂對話框：開啟期間全域快捷鍵一律不作用（避免 Enter/Space 在背後觸發播放）
  if (document.getElementById('settingsModal')) return;
  if (e.isComposing || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  if (document.activeElement?.isContentEditable) {
    // 任何 contenteditable 編輯中（字幕列表 .txt、修改字幕視窗、軌道名稱、備註等）
    // 皆交由編輯器自身處理，全域快捷鍵不作用
    return;
  }
  // 影片段已選取：Del 刪除、Backspace 關閉前方空白、Esc 取消。
  // 上下鍵統一交給「媒體片段邊界」快捷鍵，讓已選取影片時也能跳到音訊片段邊界。
  if (State.selectedClipId != null) {
    const k = e.key;
    if (k === 'Backspace') { e.preventDefault(); closeClipGapLeft(); return; } // 移到前一段結尾／序列開頭
    if (k === 'Delete') { e.preventDefault(); deleteSelectedClip(); return; }
    if (k === 'Escape') { e.preventDefault(); clearClipSelection(); return; }
  }
  // 外部音訊素材與影片段同樣可直接刪除；選取狀態由 timeline 的音訊 block 維護。
  if (State.selectedAudioClipId != null) {
    const k = e.key;
    if (k === 'Delete' || k === 'Backspace') {
      e.preventDefault();
      const id = State.selectedAudioClipId;
      if (Media.removeExternalAudio?.(id)) {
        deselect('audio', id);
        const status = $('stSel'); if (status) status.textContent = '';
        drawTimeline(); emit('render:videoSub');
      }
      return;
    }
    if (k === 'Escape') {
      e.preventDefault(); deselect('audio');
      const status = $('stSel'); if (status) status.textContent = '';
      drawTimeline(); return;
    }
  }

  const action = matchAction(State.keymap, e);
  if (!action) return;

  switch (action) {
    case 'toggle_play_pause':
      e.preventDefault();
      togglePlayPause();
      break;
    case 'rewind':
      e.preventDefault();
      shuttleRewind();
      break;
    case 'pause':
      e.preventDefault();
      shuttlePause();
      break;
    case 'forward':
      e.preventDefault();
      shuttleForward();
      break;
    case 'zoom_out': e.preventDefault(); setZoom(State.pxPerSec * 0.77); break;
    case 'zoom_in': e.preventDefault(); setZoom(State.pxPerSec * 1.3); break;
    case 'zoom_fit':
      e.preventDefault();
      if (window._lastZoomMode === 'fit') { zoomFitVideo(); window._lastZoomMode = 'video'; }
      else { zoomFit(); window._lastZoomMode = 'fit'; }
      break;
    case 'prev_cue_5f': e.preventDefault(); jumpToCueInMinusFrames(-1, 5); break;
    case 'next_cue_5f': e.preventDefault(); jumpToCueInMinusFrames(1, 5); break;
    case 'toggle_history': e.preventDefault(); emit('action', 'history'); break;
    case 'toggle_notes': e.preventDefault(); emit('action', 'notes'); break;
    case 'toggle_check_panel': e.preventDefault(); emit('action', 'check-panel'); break;
    case 'search':
      e.preventDefault();
      const sd = document.getElementById('searchDialog');
      if (sd) { const show = sd.style.display === 'none' || !sd.style.display; sd.style.display = show ? 'flex' : 'none'; if (show) setTimeout(() => document.getElementById('searchInput')?.focus(), 20); }
      break;
    case 'toggle_sub_mode': e.preventDefault(); emit('action', 'sub-mode'); break;
    case 'toggle_safe_frame': e.preventDefault(); emit('action', 'safe-frame'); break;
    case 'screenshot': e.preventDefault(); emit('action', 'screenshot'); break;
    case 'screenshot_tc': e.preventDefault(); emit('action', 'screenshot_tc'); break;
    case 'toggle_mixer': e.preventDefault(); emit('action', 'mixer'); break;
    case 'export_video': e.preventDefault(); emit('action', 'exp-video'); break;
    case 'open_queue_monitor': e.preventDefault(); emit('action', 'queue-monitor'); break;
    case 'set_in': e.preventDefault(); setIn(); break;
    case 'set_out': e.preventDefault(); setOut(); break;
    case 'nudge_left_1f':
      e.preventDefault();
      stepFrame(-1, e.repeat);
      break;
    case 'nudge_left_1s': e.preventDefault(); nudge(-1); break;
    case 'nudge_left_5s': e.preventDefault(); nudge(-5); break;
    case 'nudge_right_1f':
      e.preventDefault();
      stepFrame(1, e.repeat);
      break;
    case 'nudge_right_1s': e.preventDefault(); nudge(1); break;
    case 'nudge_right_5s': e.preventDefault(); nudge(5); break;
    case 'prev_note': e.preventDefault(); jumpToNote(-1); break;
    case 'next_note': e.preventDefault(); jumpToNote(1); break;
    case 'seek_home': e.preventDefault(); seekHome(); break;
    case 'seek_end': e.preventDefault(); seekEnd(); break;
    case 'prev_frame': e.preventDefault(); stepFrame(-1, false); break;
    case 'next_frame': e.preventDefault(); stepFrame(1, false); break;
    case 'step_boundary_prev':
      e.preventDefault();
      if (Media.playing) Media.pause();
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        stepMediaBoundary(-1);
      } else {
        stepBoundary(-1);
      }
      break;
    case 'step_boundary_next':
      e.preventDefault();
      if (Media.playing) Media.pause();
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        stepMediaBoundary(1);
      } else {
        stepBoundary(1);
      }
      break;
    case 'first_cue': e.preventDefault(); jumpToFirstLastCue(-1); break;
    case 'last_cue': e.preventDefault(); jumpToFirstLastCue(1); break;
    case 'prev_cue': e.preventDefault(); jumpToAdjacentCue(-1); break;
    case 'next_cue': e.preventDefault(); jumpToAdjacentCue(1); break;
    case 'jump_cue_start':
      e.preventDefault();
      if (State.selectedId) {
        const c = State.cues.find(x => x.id === State.selectedId);
        if (c && c.timed !== false) { Media.seek(c.start); updatePlayhead(); emit('playhead:ensure'); emit('render:videoSub'); }
      }
      break;
    case 'jump_cue_end':
      e.preventDefault();
      if (State.selectedId) {
        const c = State.cues.find(x => x.id === State.selectedId);
        if (c && c.timed !== false) { Media.seek(c.end); updatePlayhead(); emit('playhead:ensure'); emit('render:videoSub'); }
      }
      break;
    case 'select_all':
      e.preventDefault();
      const tkCues = State.cues.filter(c => (c.track || 0) === State.listTrack);
      if (tkCues.length) {
        setSelection({ kind: 'sub', ids: tkCues.map(c => c.id), primary: tkCues[0].id });
        refreshSelectionUI();
      }
      break;
    case 'copy_style':
      e.preventDefault();
      emit('action', 'copy-style');
      break;
    case 'paste_style':
      e.preventDefault();
      emit('action', 'paste-style');
      break;
    case 'save_project': e.preventDefault(); Project.save(); break;
    case 'save_as': e.preventDefault(); Project.saveAs(); break;
    case 'delete_selected': if (State.selectedIds.length || State.selectedId) { e.preventDefault(); deleteSelected(); } break;
    case 'cancel':
      cancelSwapMode();
      if (State.subMode) { e.preventDefault(); emit('action', 'sub-mode'); jklReset(); }
      if (State.selectedId || State.selectedIds.length) {
        e.preventDefault();
        deselect('sub');
        refreshSelectionUI();
        const stSel = document.getElementById('stSel');
        if (stSel) stSel.textContent = '';
      }
      break;
    case 'shift_timecode': e.preventDefault(); {
      const ids = State.selectedIds.length ? State.selectedIds : [State.selectedId].filter(Boolean);
      if (!ids.length) break;
      const jCues = ids.map(id => State.cues.find(c => c.id === id)).filter(c => c && c.timed !== false);
      if (!jCues.length) break;
      const minStart = Math.min(...jCues.map(c => c.start));
      const jt = Media.displayTime(), delta = jt - minStart;
      for (const jc of jCues) { jc.start = Math.max(0, jc.start + delta); jc.end = Math.max(jc.start + 0.001, jc.end + delta); }
      // v4.2.0 政策：位移不自動裁切/刪除被重疊的鄰居（與 subio.js applyTcShift 一致）
      sortCues(); emit('render:all'); drawTimeline();
      recordHistory('時間碼位移 P');
      setStatus(`P 位移 ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}s（${jCues.length} 條）`, 'ok');
    } break;
    case 'undo': e.preventDefault(); History.undo(); break;
    case 'redo': e.preventDefault(); History.redo(); break;
    case 'toggle_auto_select': e.preventDefault(); emit('action', 'toggle-auto-select'); break;
    case 'toggle_overwrite': e.preventDefault(); emit('action', 'toggle-overwrite'); break;
    case 'toggle_overwrite_keep': e.preventDefault(); emit('action', 'toggle-ow-keep'); break;
    case 'exp_in': 
      e.preventDefault(); 
      if (_keysPressed.has('[')) {
        if (_keysPressed.has(']')) emit('action', 'exp-clear');
        else emit('action', 'exp-in');
      }
      break;
    case 'exp_out': 
      e.preventDefault(); 
      if (_keysPressed.has(']')) {
        if (_keysPressed.has('[')) emit('action', 'exp-clear');
        else emit('action', 'exp-out');
      }
      break;
    case 'exp_clear': e.preventDefault(); emit('action', 'exp-clear'); break;
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
      if (State.selectedAudioClipId && typeof Media.splitExternalAudio === 'function') void Media.splitExternalAudio(State.selectedAudioClipId, Media.displayTime());
      else Media.splitClipAt(Media.displayTime());
      break;
  }
});

export {
  setIn,
  setOut,
  nudge,
  stepBoundary,
  stepMediaBoundary,
  jklReset,
  resetPlaybackSpeed,
  setManualPlaybackSpeed,
};
