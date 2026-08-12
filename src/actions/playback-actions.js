import { State, IS_DESKTOP, DESK } from '../state.js';
import { Media } from '../media.js';
import { fmtClock } from '../time.js';
import { setStatus, showToast } from '../ui.js';
import { drawTimeline } from '../timeline.js';
import { recordHistory } from '../history.js';
import { nudge, setIn, setOut, resetPlaybackSpeed } from '../keyboard.js';
import { AudioRouting } from '../audio-routing.js';

export function togglePlayPause() {
  resetPlaybackSpeed();
  Media.toggle();
  setStatus(Media.playing ? '▶ 正播' : '⏸ 暫停', Media.playing ? 'ok' : '');
}

export function back1() { nudge(-1); }
export function fwd1() { nudge(1); }
export function frameBack() { nudge(-1 / State.fps); }
export function frameFwd() { nudge(1 / State.fps); }
export function setInPoint() { setIn(); }
export function setOutPoint() { setOut(); }

export function setExportIn() {
  State.exportIn = Media.displayTime();
  drawTimeline();
  recordHistory('設定輸出起點 [In]');
  setStatus(`輸出起點已設為 ${fmtClock(State.exportIn)}`, 'ok');
}

export function setExportOut() {
  State.exportOut = Media.displayTime();
  drawTimeline();
  recordHistory('設定輸出終點 [Out]');
  setStatus(`輸出終點已設為 ${fmtClock(State.exportOut)}`, 'ok');
}

export function clearExport() {
  State.exportIn = null;
  State.exportOut = null;
  drawTimeline();
  recordHistory('清除輸出範圍');
  setStatus('輸出範圍已清除', 'ok');
}

export function openQueueMonitor() {
  if (!IS_DESKTOP || typeof DESK.openQueueMonitor !== 'function') { showToast('匯出佇列只在桌面版提供'); return; }
  DESK.openQueueMonitor();
}

export function openAudioProjectSettings() {
  AudioRouting.openOutputSettings();
}

export function splitClip() {
  if (State.selectedAudioClipId && typeof Media.splitExternalAudio === 'function')
    void Media.splitExternalAudio(State.selectedAudioClipId, Media.displayTime());
  else Media.splitClipAt(Media.displayTime());
}

export function unlinkClipAudio() {
  const id = State.selectedClipId || Media.activeClip?.()?.id;
  if (!id) { showToast('請先選取要解除連結的影片段'); return; }
  if (typeof Media.detachClipAudio !== 'function') { showToast('影音解除連結功能尚未就緒'); return; }
  void Media.detachClipAudio(id);
}
