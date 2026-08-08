/* ==============================================================================
   SUB Tool — 字幕比對規則
   ============================================================================== */
/*
   比對視窗是 renderer 的一個 view adapter；配對、影格、時碼與生效樣式的判定
   必須在這個純資料 module 保持同一個 locality。這裡不碰 DOM、IPC 或 State。
*/
import { STYLE_DEFAULTS, effStyle } from './substyle.js';
import { getExactFps, secToEncore, snapTimeToFrame } from './time.js';

export const SUBTITLE_COMPARE_TOLERANCE_SECONDS = 1;

function asFiniteTime(value) {
  const time = Number(value);
  return Number.isFinite(time) ? time : 0;
}

function normaliseTrackIndex(value, fallback, trackCount) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed >= trackCount) return fallback;
  return parsed;
}

function normaliseChecks(checks = {}) {
  return {
    time: checks.time !== false,
    text: checks.text !== false,
    style: checks.style !== false,
  };
}

export function subtitleFrameIndex(time, fps, dropFrame = false) {
  const snapped = snapTimeToFrame(asFiniteTime(time), fps, dropFrame);
  return Math.round(snapped * getExactFps(fps));
}

function cueView(cue, trackIndex, fps, dropFrame) {
  if (!cue) return null;
  const start = asFiniteTime(cue.start);
  const end = asFiniteTime(cue.end);
  return {
    id: cue.id,
    track: trackIndex,
    start,
    end,
    text: cue.text || '',
    startTimecode: secToEncore(start, fps, dropFrame),
    endTimecode: secToEncore(end, fps, dropFrame),
  };
}

function styleDifference(leftCue, rightCue, leftTrack, rightTrack) {
  const leftStyle = effStyle(leftCue, leftTrack);
  const rightStyle = effStyle(rightCue, rightTrack);
  const keys = Object.keys(STYLE_DEFAULTS).filter(key => leftStyle[key] !== rightStyle[key]);
  return { changed: keys.length > 0, keys };
}

export function pairSubtitleCues(leftCues, rightCues, tolerance = SUBTITLE_COMPARE_TOLERANCE_SECONDS) {
  const left = Array.isArray(leftCues) ? leftCues.slice() : [];
  const right = Array.isArray(rightCues) ? rightCues.slice() : [];
  const safeTolerance = Number.isFinite(Number(tolerance)) ? Math.max(0, Number(tolerance)) : SUBTITLE_COMPARE_TOLERANCE_SECONDS;
  const pairs = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < left.length || rightIndex < right.length) {
    const leftCue = left[leftIndex] || null;
    const rightCue = right[rightIndex] || null;
    if (leftCue && rightCue) {
      if (Math.abs(asFiniteTime(leftCue.start) - asFiniteTime(rightCue.start)) <= safeTolerance) {
        pairs.push({ left: leftCue, right: rightCue, leftIndex: leftIndex + 1, rightIndex: rightIndex + 1 });
        leftIndex += 1;
        rightIndex += 1;
      } else if (asFiniteTime(leftCue.start) < asFiniteTime(rightCue.start)) {
        pairs.push({ left: leftCue, right: null, leftIndex: leftIndex + 1, rightIndex: null });
        leftIndex += 1;
      } else {
        pairs.push({ left: null, right: rightCue, leftIndex: null, rightIndex: rightIndex + 1 });
        rightIndex += 1;
      }
    } else if (leftCue) {
      pairs.push({ left: leftCue, right: null, leftIndex: leftIndex + 1, rightIndex: null });
      leftIndex += 1;
    } else {
      pairs.push({ left: null, right: rightCue, leftIndex: null, rightIndex: rightIndex + 1 });
      rightIndex += 1;
    }
  }
  return pairs;
}

function comparisonRow(pair, { leftTrack, rightTrack, tracks, fps, dropFrame, checks }) {
  const left = cueView(pair.left, leftTrack, fps, dropFrame);
  const right = cueView(pair.right, rightTrack, fps, dropFrame);
  const missing = !left || !right;
  const time = !missing && (
    subtitleFrameIndex(left.start, fps, dropFrame) !== subtitleFrameIndex(right.start, fps, dropFrame)
    || subtitleFrameIndex(left.end, fps, dropFrame) !== subtitleFrameIndex(right.end, fps, dropFrame)
  );
  const text = !missing && left.text !== right.text;
  const style = !missing
    ? styleDifference(pair.left, pair.right, tracks[leftTrack], tracks[rightTrack])
    : { changed: false, keys: [] };
  const raw = { missing, time, text, style: style.changed, styleKeys: style.keys };
  const active = {
    missing,
    time: checks.time && time,
    text: checks.text && text,
    style: checks.style && style.changed,
  };
  active.any = active.missing || active.time || active.text || active.style;
  return {
    left,
    right,
    leftIndex: pair.leftIndex,
    rightIndex: pair.rightIndex,
    difference: { ...raw, any: raw.missing || raw.time || raw.text || raw.style },
    active,
  };
}

/**
 * 將一個不可變的專案快照投影成 compare view 可直接渲染的 plain data。
 * 配對語意暫時維持舊 1 秒 greedy 規則；日後若產品要改配對演算法，只改這個 seam。
 */
export function buildSubtitleComparisonPlan(snapshot = {}, selection = {}, options = {}) {
  const tracks = Array.isArray(snapshot.tracks) ? snapshot.tracks : [];
  const cues = Array.isArray(snapshot.cues) ? snapshot.cues : [];
  const fps = Number(snapshot.fps) || 30;
  const dropFrame = !!snapshot.dropFrame;
  const checks = normaliseChecks(selection.checks || options.checks);
  if (tracks.length === 0) {
    return {
      revision: options.revision ?? null,
      tracks: [],
      selection: null,
      checks,
      rows: [],
    };
  }

  const leftTrack = normaliseTrackIndex(selection.leftTrack, 0, tracks.length);
  const rightFallback = tracks.length > 1 ? 1 : 0;
  const rightTrack = normaliseTrackIndex(selection.rightTrack, rightFallback, tracks.length);
  const sortByTime = (first, second) => asFiniteTime(first.start) - asFiniteTime(second.start);
  const leftCues = cues.filter(cue => (cue.track || 0) === leftTrack).sort(sortByTime);
  const rightCues = cues.filter(cue => (cue.track || 0) === rightTrack).sort(sortByTime);
  const tolerance = options.tolerance ?? SUBTITLE_COMPARE_TOLERANCE_SECONDS;
  const rows = pairSubtitleCues(leftCues, rightCues, tolerance)
    .map(pair => comparisonRow(pair, { leftTrack, rightTrack, tracks, fps, dropFrame, checks }));

  return {
    revision: options.revision ?? null,
    tracks: tracks.map((track, index) => ({ index, name: track?.name || `軌道 ${index + 1}` })),
    selection: { leftTrack, rightTrack },
    checks,
    rows,
    summary: {
      total: rows.length,
      missing: rows.filter(row => row.difference.missing).length,
      time: rows.filter(row => row.difference.time).length,
      text: rows.filter(row => row.difference.text).length,
      style: rows.filter(row => row.difference.style).length,
      active: rows.filter(row => row.active.any).length,
    },
  };
}
