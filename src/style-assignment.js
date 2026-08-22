/* ==============================================================================
   SUB Tool — 生效樣式套用規則 (Style Assignment Engine)
   ============================================================================== */
/*
   所有「把某組生效樣式放到另一個 cue／軌道」的入口都必須經過這個純資料 seam。
   module 只規劃 patch，不記 History、不 render、也不直接改 State。
*/
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
 * existing unknown keys 不會被刪除，desiredStyle 的 unknown keys 也絕不會滲入。
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
 * 規劃「全軌套用」；preserveKeys 的值由每一個 cue 原本的生效樣式帶回。
 * caller 只需套 trackPatch 與 cuePatches，再記一次 History。
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
