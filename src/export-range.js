/* ==============================================================================
   SUB Tool — 專案輸出範圍標記核心 (Export Range Module)
   ==============================================================================
   深層模組：負責管理時間軸輸出 In/Out 範圍標記。
   時間點一律經由 snapTimeToFrame 吸附影格格網，並以 fmtClock 呈現。
   ============================================================================== */
import { State } from './state.js';
import { Media } from './media.js';
import { fmtClock, snapTimeToFrame } from './time.js';
import { drawTimeline } from './timeline.js';
import { recordHistory } from './history.js';
import { setStatus } from './ui.js';

export function setExportIn() {
  State.exportIn = snapTimeToFrame(Media.displayTime(), State.fps, State.dropFrame);
  drawTimeline();
  recordHistory('設定輸出起點 [In]');
  setStatus(`輸出起點已設為 ${fmtClock(State.exportIn)}`, 'ok');
}

export function setExportOut() {
  State.exportOut = snapTimeToFrame(Media.displayTime(), State.fps, State.dropFrame);
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
