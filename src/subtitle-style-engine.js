/* ==============================================================================
   SUB Tool — Subtitle Style Engine ("src/subtitle-style-engine.js")
   ==============================================================================
   深層字幕樣式核心引擎 (Subtitle Style Engine)。
   純計算與樣式狀態轉換，零 DOM/UI 直接相依：
   1. 樣式最小差量規劃 (planCueStyleAssignment / planTrackStyleAssignment)
   2. 樣式套用 (applyCueStyleAssignment / applyCueStylePatch / applyTrackStylePlan)
   3. 樣式剪貼簿狀態 (hasClipboardStyle / getClipboardStyle / setClipboardStyle)
   4. 幾何鍵值常數 (GEOMETRY_STYLE_KEYS)
   ============================================================================== */

import { STYLE_DEFAULTS, effStyle } from './substyle.js';

export const GEOMETRY_STYLE_KEYS = Object.freeze(['posX', 'posY', 'align', 'valign', 'angle']);
const STYLE_KEYS = Object.freeze(Object.keys(STYLE_DEFAULTS));

function ownStyle(style) {
  return style && typeof style === 'object' ? { ...style } : {};
}

function styleObjectsEqual(first, second) {
  const firstKeys = Object.keys(first || {});
  const secondKeys = Object.keys(second || {});
  if (firstKeys.length !== secondKeys.length) return false;
  return firstKeys.every(key => Object.prototype.hasOwnProperty.call(second || {}, key) && first[key] === second[key]);
}

function desiredEffectiveStyle(cue, targetTrack, desiredStyle, preserveKeys) {
  const desired = { ...effStyle(cue, targetTrack) };
  const preserved = new Set(Array.isArray(preserveKeys) ? preserveKeys : []);
  for (const key of STYLE_KEYS) {
    if (preserved.has(key)) continue;
    if (desiredStyle && desiredStyle[key] != null) desired[key] = desiredStyle[key];
  }
  return desired;
}

/**
 * 回傳把 desired effective style 投影到 targetTrack 時，cue 必須保存的最小 style。
 */
export function planCueStyleAssignment({ cue, targetTrack, desiredStyle, preserveKeys = [] } = {}) {
  const existing = ownStyle(cue?.style);
  const next = {};
  for (const [key, value] of Object.entries(existing)) {
    if (!STYLE_KEYS.includes(key)) next[key] = value;
  }

  const baseline = effStyle(null, targetTrack);
  const desired = desiredEffectiveStyle(cue, targetTrack, desiredStyle, preserveKeys);
  for (const key of STYLE_KEYS) {
    if (desired[key] !== baseline[key]) next[key] = desired[key];
  }

  const style = Object.keys(next).length ? next : undefined;
  const changed = !styleObjectsEqual(existing, style || {});
  return { changed, style, desired };
}

/**
 * 規劃全軌樣式套用。
 */
export function planTrackStyleAssignment({ track, cues = [], desiredStyle, preserveKeys = [] } = {}) {
  const preserved = new Set(Array.isArray(preserveKeys) ? preserveKeys : []);
  const trackPatch = {};
  const currentTrackStyle = effStyle(null, track);
  for (const key of STYLE_KEYS) {
    if (preserved.has(key)) continue;
    trackPatch[key] = desiredStyle?.[key] != null ? desiredStyle[key] : currentTrackStyle[key];
  }
  const nextTrack = { ...(track || {}), ...trackPatch };
  const cuePatches = (Array.isArray(cues) ? cues : []).map(cue => {
    const original = effStyle(cue, track);
    const cueDesired = { ...desiredEffectiveStyle(cue, track, desiredStyle, []) };
    for (const key of preserved) cueDesired[key] = original[key];
    const plan = planCueStyleAssignment({ cue, targetTrack: nextTrack, desiredStyle: cueDesired });
    return { cue, ...plan };
  });
  const changed = Object.keys(trackPatch).some(key => track?.[key] !== trackPatch[key])
    || cuePatches.some(patch => patch.changed);
  return { changed, trackPatch, cuePatches };
}

export function applyCueStyleAssignment(cue, plan) {
  if (!cue || !plan?.changed) return false;
  if (plan.style) cue.style = { ...plan.style };
  else delete cue.style;
  return true;
}

export function applyCueStylePatch(cue, desiredStyle, targetTrack = null, preserveKeys = []) {
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
export function getClipboardStyle() { return _clipboardStyle ? JSON.parse(JSON.stringify(_clipboardStyle)) : null; }
export function setClipboardStyle(style) { _clipboardStyle = style ? JSON.parse(JSON.stringify(style)) : null; }

export function copyCueStyle(cue, track) {
  if (!cue) return null;
  const computed = JSON.parse(JSON.stringify(effStyle(cue, track)));
  _clipboardStyle = computed;
  return computed;
}

export function pasteClipboardStyle(cues = [], tracks = []) {
  if (!_clipboardStyle || !Array.isArray(cues) || !cues.length) return false;
  let changed = false;
  for (const c of cues) {
    if (!c) continue;
    const targetTrack = (Array.isArray(tracks) ? tracks[c.track || 0] : null) || null;
    const plan = planCueStyleAssignment({ cue: c, targetTrack, desiredStyle: _clipboardStyle });
    if (applyCueStyleAssignment(c, plan)) {
      changed = true;
    }
  }
  return changed;
}
