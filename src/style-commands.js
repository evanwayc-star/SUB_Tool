/* ==============================================================================
   SUB Tool — 字幕樣式互動指令 (Style Commands & Application)
   ==============================================================================
   樣式操作之 UI/State 指令轉接層，核心樣式運算已深化至 src/subtitle-style-engine.js。
   ============================================================================== */

import { State } from './state.js';
import {
  planCueStyleAssignment,
  planTrackStyleAssignment,
  applyCueStyleAssignment,
  applyTrackStylePlan as applyTrackStylePlanEngine,
  hasClipboardStyle,
  copyCueStyle,
  pasteClipboardStyle,
} from './subtitle-style-engine.js';
import { showToast, setStatus } from './ui.js';
import { recordHistory } from './history.js';
import { emit } from './events.js';
import { cueTrackLocked, cuesTrackLocked, trackLocked } from './subtitle-model.js';

export function applyCueStylePatch(cue, desiredStyle, preserveKeys = []) {
  if (!cue) return false;
  if (cueTrackLocked(cue, '修改字幕樣式')) return false;
  const targetTrack = State?.tracks?.[cue?.track || 0] || null;
  const plan = planCueStyleAssignment({ cue, targetTrack, desiredStyle, preserveKeys });
  applyCueStyleAssignment(cue, plan);
  return plan.changed;
}

export function copySelectedStyle() {
  if (!State.selectedId) { showToast('請先選取一條字幕'); return; }
  const c = State.cues.find(x => x.id === State.selectedId);
  if (!c) return;
  const tk = State.tracks[c.track || 0];
  copyCueStyle(c, tk);
  setStatus('已拷貝字幕樣式', 'ok');
}

export function pasteStyleToSelected() {
  if (!hasClipboardStyle()) { showToast('尚未拷貝樣式'); return; }
  const ids = State.selectedIds.length ? State.selectedIds : [State.selectedId].filter(Boolean);
  if (!ids.length) { showToast('請先選取字幕'); return; }

  const selectedCues = ids.map(id => State.cues.find(x => x.id === id)).filter(Boolean);
  if (cuesTrackLocked(selectedCues, '貼上字幕樣式')) return;
  const changed = pasteClipboardStyle(selectedCues, State.tracks);

  if (changed) {
    recordHistory('貼上字幕樣式');
    emit('render:all');
    setStatus('已貼上樣式', 'ok');
  }
}

export function applyTrackStylePlan(track, cues, desiredStyle, preserveKeys = []) {
  const trackIndex = State.tracks.indexOf(track);
  if (trackIndex >= 0 ? trackLocked(trackIndex, '修改字幕樣式') : cuesTrackLocked(cues, '修改字幕樣式')) return false;
  return applyTrackStylePlanEngine(track, cues, desiredStyle, preserveKeys);
}

export {
  hasClipboardStyle,
};
