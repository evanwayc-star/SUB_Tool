/* ==============================================================================
   SUB Tool — 字幕樣式互動指令 (Style Commands & Application)
   ============================================================================== */
import { State } from './state.js';
import { effStyle } from './substyle.js';
import { planCueStyleAssignment, planTrackStyleAssignment, applyCueStyleAssignment } from './style-assignment.js';
import { showToast, setStatus } from './ui.js';
import { recordHistory } from './history.js';
import { emit } from './events.js';

export function applyCueStylePatch(cue, desiredStyle, preserveKeys = []) {
  const targetTrack = State?.tracks?.[cue?.track || 0] || null;
  const plan = planCueStyleAssignment({ cue, targetTrack, desiredStyle, preserveKeys });
  applyCueStyleAssignment(cue, plan);
  return plan.changed;
}

export function applyTrackStylePlan(track, cues, desiredStyle, preserveKeys = []) {
  const plan = planTrackStyleAssignment({ track, cues, desiredStyle, preserveKeys });
  if (!plan.changed) return false;
  Object.assign(track, plan.trackPatch);
  for (const cuePatch of plan.cuePatches) applyCueStyleAssignment(cuePatch.cue, cuePatch);
  return true;
}

let _clipboardStyle = null;
export function hasClipboardStyle() { return !!_clipboardStyle; }

export function copySelectedStyle() {
  if (!State.selectedId) { showToast('請先選取一條字幕'); return; }
  const c = State.cues.find(x => x.id === State.selectedId);
  if (!c) return;
  const tk = State.tracks[c.track || 0];
  _clipboardStyle = JSON.parse(JSON.stringify(effStyle(c, tk)));
  setStatus('已拷貝字幕樣式', 'ok');
}

export function pasteStyleToSelected() {
  if (!_clipboardStyle) { showToast('尚未拷貝樣式'); return; }
  const ids = State.selectedIds.length ? State.selectedIds : [State.selectedId].filter(Boolean);
  if (!ids.length) { showToast('請先選取字幕'); return; }
  
  let changed = false;
  for (const id of ids) {
    const c = State.cues.find(x => x.id === id);
    if (!c) continue;
    const targetTrack = State.tracks[c.track || 0] || null;
    const plan = planCueStyleAssignment({ cue: c, targetTrack, desiredStyle: _clipboardStyle });
    applyCueStyleAssignment(c, plan);
    changed = plan.changed || changed;
  }
  
  if (changed) {
    recordHistory('貼上字幕樣式');
    emit('render:all');
    setStatus('已貼上樣式', 'ok');
  }
}
