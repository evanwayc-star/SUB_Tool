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
import { ProjectMediaRestoration } from './project-media-restore.js';

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
  if (sourceTrackIndexes.some(index => !Number.isSafeInteger(index) ||
      index < 0 || index >= metadata.tracks.length)) {
    return standardPlan(parsed, fps);
  }

  const sourceTrackCount = sourceTrackIndexes.length;
  const sourceTrackIndex = sourceTrackCount === 1 ? sourceTrackIndexes[0] : null;
  const sourceTrack = sourceTrackIndex == null ? null : copyTrack(metadata.tracks[sourceTrackIndex]);
  const useFrameTiming = canUseFrameTiming(metadata, fps);
  const exactFps = useFrameTiming ? getExactFps(fps) : null;
  // 合併檔仍匯入單一目的軌；各來源軌的繼承值須落到逐句覆蓋，不能因為
  // 無法選出一份 trackPatch 就捨棄原稿、未定時字幕及精確影格中繼資料。
  const preserveEffectiveStyle = target === 'existing' || sourceTrackCount > 1;
  const cues = metadata.cues.map(sourceCue => {
    const start = useFrameTiming ? sourceCue.startFrame / exactFps : sourceCue.start;
    const end = useFrameTiming ? sourceCue.endFrame / exactFps : sourceCue.end;
    const cue = {
      start,
      end: Math.max(start, end),
      text: sourceCue.text,
      timed: sourceCue.timed !== false,
    };
    if (preserveEffectiveStyle) {
      cue.style = styleSnapshot(effStyle({ style: sourceCue.style || {} }, metadata.tracks[sourceCue.track]));
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
    sourceTrackCount,
    trackPatch: preserveEffectiveStyle ? null : sourceTrack,
    cues,
  };
}

export class ProjectRestorePlan {
  #clips;
  #handedOffClips = new Set();
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
  replaceClips(clips) {
    this.#clips = Array.isArray(clips) ? clips : [];
    const pending=new Set(this.#clips);
    for(const clip of this.#handedOffClips) if(!pending.has(clip)) this.#handedOffClips.delete(clip);
  }
  // 批次仍保留原文供後續復原；已交給 runtime 的 placement 由使用者與 History
  // 管理，存檔不能再加入原文，否則分割或刪除後會把原 placement 補回。
  // 以原 record 身分交接，不能依 path 去重，因同一檔可有多個合法剪接片段。
  materializeClip(saved, clip) {
    if(this.#clips.includes(saved)&&clip?.id){
      this.#handedOffClips.add(saved);
    }
  }
  pendingClipsForSave() {
    return this.#clips.filter(clip=>!this.#handedOffClips.has(clip));
  }

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
  #mediaRestoration;
  #mediaRuns = new WeakMap();

  constructor(mediaAdapters = null) {
    this.#mediaRestoration = mediaAdapters ? new ProjectMediaRestoration(mediaAdapters) : null;
  }

  get activePlan() { return this.#activePlan; }
  get generation() { return this.#generation; }

  begin({ preserveMaterial = false } = {}) {
    const previous = preserveMaterial ? this.#activePlan : null;
    this.#generation += 1;
    this.#activePlan = null;
    if (previous) {
      // 撤銷舊工作，持久資料則交給新 plan；不得靠重啟舊 owner 恢復取消的 I/O。
      const plan = this.createRestorePlan(this.#generation, structuredClone({
        clips: previous.pendingClipsForSave(),
        externalAudioSources: previous.pendingExternalAudioSources(),
        playhead: previous.peekPlayhead(),
        mediaRelink: previous.needsMediaRelink(),
      }));
      this.#mediaRestoration?.inheritPlanProgress(previous, plan);
    }
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

  // 同一 seam 用於桌面主素材、browser File relink、圖片專案與稍後重連。
  // caller 只描述媒體目前的狀態，不需要知道 pending/audio/playhead/baseline 順序。
  restoreMedia(generation, request = {}) {
    const plan = this.#activePlan;
    const owns = () => this.isCurrent(generation) && this.#activePlan === plan && !!plan?.owns();
    if (!owns()) return Promise.resolve(false);
    if (!this.#mediaRestoration) throw new Error('project media restoration adapters are unavailable');
    let runs = this.#mediaRuns.get(plan);
    if (!runs) { runs = new Map(); this.#mediaRuns.set(plan, runs); }
    const key = JSON.stringify([request.kind || 'images', request.path || null]);
    if (runs.has(key)) return runs.get(key);
    const work = this.#mediaRestoration.restore(plan, request, owns);
    runs.set(key, work);
    // Only in-flight work is shared. A missing source can become available later
    // in the same plan, so successful partial restores must also be retryable.
    const release = () => { if (runs.get(key) === work) runs.delete(key); };
    void work.then(release, release);
    return work;
  }

  clearPlan(plan = null) {
    if (!plan || this.#activePlan === plan) this.#activePlan = null;
  }
}
