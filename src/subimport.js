/* ============================================================================
   SUB Tool — ASS 匯入資料規劃（純函式接縫）
   ============================================================================
   ASS 解析與 DOM modal 分開：本模組只把已驗證的格式資料轉成可寫入 State 的
   匯入計畫，讓「自產 ASS 無損往返」能用單元測試守住。
============================================================================ */
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
  // 舊 serializer：floor((frame/fps - 0.5/fps) * 100) / 100。反推候選格時用
  // ceil(encodedSeconds * fps + 0.5)；epsilon 避免浮點把剛好整數的候選推到下一格。
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

/**
 * Convert validated `SubFormats.parseASS(...).subtool` data into the data part
 * of a subtitle import. Standalone ASS export writes one source track per file;
 * a multi-track metadata document therefore deliberately falls back to standard
 * ASS rather than silently flattening different track styles into one target.
 */
function buildSubtitleImportPlan(parsed, { fps, target = 'new' } = {}) {
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
      // 既有軌的樣式屬於它原本的字幕。把來源的「生效樣式」寫成完整逐句覆蓋，
      // 才不會為了還原這次匯入而改掉既有字幕的外觀。
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

export { buildSubtitleImportPlan };
