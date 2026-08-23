/* ==============================================================================
   SUB Tool — Project Intake Engine ("src/project-intake-engine.js")
   ==============================================================================
   深層專案導入、復原計畫與字幕格式匯入引擎 (Project Intake Engine)。
   提供專案工作階段隔離、復原資料所有權管理與 ASS 無損往返規劃：
   1. 專案載入工作階段與所有權守衛 (ProjectLoadSession / ProjectRestorePlan)
   2. ASS 自產與標準字幕匯入計畫規劃 (buildSubtitleImportPlan - ADR-0002)
   ============================================================================== */

import { getExactFps } from './time.js';
import { CUE_STYLE_KEYS, effStyle, styleSnapshot } from './substyle.js';

const TRACK_KEYS = ['name', 'visible', 'locked', 'posPct', ...CUE_STYLE_KEYS];

function copyStyle(style) {
  const out = {};
  if (!style || typeof style !== 'object') return out;
  for (const key of CUE_STYLE_KEYS) {
    if (style[key] != null) out[key] = style[key];
  }
  return out;
}

function copyTrack(track) {
  const out = {};
  if (!track || typeof track !== 'object') return out;
  for (const key of TRACK_KEYS) {
    if (track[key] != null) out[key] = track[key];
  }
  return out;
}

function restoreLegacySubtoolAssTime(value, fps) {
  const seconds = Number(value);
  const exactFps = getExactFps(fps);
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(exactFps) || exactFps <= 0) return 0;
  return Math.ceil(seconds * exactFps + 0.5 - 1e-9) / exactFps;
}

function standardPlan(parsed, fps) {
  const useLegacyTiming = parsed?.subtoolLegacy === true && Number.isFinite(Number(fps)) && Number(fps) > 0;
  const cues = Array.isArray(parsed) ? parsed.map(cue => {
    const rawStart = Number.isFinite(Number(cue?.start)) ? Number(cue.start) : 0;
    const rawEnd = Number.isFinite(Number(cue?.end)) ? Number(cue.end) : rawStart;
    const start = useLegacyTiming ? restoreLegacySubtoolAssTime(rawStart, fps) : rawStart;
    const end = Math.max(start, useLegacyTiming ? restoreLegacySubtoolAssTime(rawEnd, fps) : rawEnd);
    const out = { start, end, text: String(cue?.text || ''), timed: cue?.timed !== false };
    const style = copyStyle(cue?.style);
    if (Object.keys(style).length) out.style = style;
    return out;
  }) : [];
  return { usedMetadata: false, usedFrameTiming: false, usedLegacyTiming: useLegacyTiming, trackPatch: null, cues };
}

function canUseFrameTiming(metadata, targetFps) {
  const source = Number(metadata?.fps);
  const target = Number(targetFps);
  return Number.isFinite(source) && source > 0 && Number.isFinite(target) && target > 0 &&
    Math.abs(getExactFps(source) - getExactFps(target)) < 0.000001;
}

export function buildSubtitleImportPlan(parsed, { fps, target = 'new' } = {}) {
  const metadata = parsed?.subtool;
  if (!metadata || !Array.isArray(metadata.tracks) || !Array.isArray(metadata.cues) || !metadata.cues.length) {
    return standardPlan(parsed, fps);
  }

  const sourceTrackIndexes = [...new Set(metadata.cues.map(cue => cue?.track))];
  if (sourceTrackIndexes.length !== 1 || !Number.isSafeInteger(sourceTrackIndexes[0]) ||
      sourceTrackIndexes[0] < 0 || sourceTrackIndexes[0] >= metadata.tracks.length) {
    return standardPlan(parsed, fps);
  }

  const sourceTrackIndex = sourceTrackIndexes[0];
  const sourceTrack = copyTrack(metadata.tracks[sourceTrackIndex]);
  const useFrameTiming = canUseFrameTiming(metadata, fps);
  const exactFps = useFrameTiming ? getExactFps(fps) : null;
  const importIntoExistingTrack = target === 'existing';
  const cues = metadata.cues.map(sourceCue => {
    const start = useFrameTiming ? sourceCue.startFrame / exactFps : sourceCue.start;
    const end = useFrameTiming ? sourceCue.endFrame / exactFps : sourceCue.end;
    const cue = {
      start,
      end: Math.max(start, end),
      text: sourceCue.text,
      timed: sourceCue.timed !== false,
    };
    if (importIntoExistingTrack) {
      cue.style = styleSnapshot(effStyle({ style: sourceCue.style || {} }, sourceTrack));
    } else {
      const style = copyStyle(sourceCue.style);
      if (Object.keys(style).length) cue.style = style;
    }
    return cue;
  });

  return {
    usedMetadata: true,
    usedFrameTiming: useFrameTiming,
    sourceTrackIndex,
    trackPatch: importIntoExistingTrack ? null : sourceTrack,
    cues,
  };
}

export class ProjectRestorePlan {
  #clips;
  #externalAudioSources;
  #playhead;
  #mediaRelink;
  #owns;

  constructor({ clips = [], externalAudioSources = [], playhead = null, mediaRelink = false } = {}, { owns = () => true } = {}) {
    this.#clips = Array.isArray(clips) ? clips : [];
    this.#externalAudioSources = Array.isArray(externalAudioSources) ? externalAudioSources : [];
    this.#playhead = Number.isFinite(playhead) ? Math.max(0, playhead) : null;
    this.#mediaRelink = mediaRelink === true;
    this.#owns = typeof owns === 'function' ? owns : () => true;
  }

  owns() { return this.#owns(); }

  pendingClips() { return this.#clips; }
  replaceClips(clips) { this.#clips = Array.isArray(clips) ? clips : []; }

  pendingExternalAudioSources() { return this.#externalAudioSources; }
  replaceExternalAudioSources(sources) {
    this.#externalAudioSources = Array.isArray(sources) ? sources : [];
  }

  peekPlayhead() { return this.#playhead; }
  clearPlayhead() { this.#playhead = null; }

  consumeMediaRelink() {
    const relink = this.#mediaRelink;
    this.#mediaRelink = false;
    return relink;
  }

  needsMediaRelink() { return this.#mediaRelink; }
}

export class ProjectLoadSession {
  #generation = 0;
  #tail = Promise.resolve();
  #activePlan = null;

  get activePlan() { return this.#activePlan; }
  get generation() { return this.#generation; }

  begin() {
    this.#generation += 1;
    this.#activePlan = null;
    return this.#generation;
  }

  isCurrent(generation) { return generation === this.#generation; }

  append(generation, work) {
    const result = this.#tail.catch(() => {}).then(() => {
      if (!this.isCurrent(generation)) return undefined;
      return work();
    });
    this.#tail = result.catch(() => {});
    return result;
  }

  createRestorePlan(generation, material) {
    if (generation != null && !this.isCurrent(generation)) return null;
    let plan = null;
    plan = new ProjectRestorePlan(material, {
      owns: () => this.isCurrent(generation) && this.#activePlan === plan,
    });
    this.#activePlan = plan;
    return plan;
  }

  clearPlan(plan = null) {
    if (!plan || this.#activePlan === plan) this.#activePlan = null;
  }
}
