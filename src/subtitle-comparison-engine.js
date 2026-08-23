/* ==============================================================================
   SUB Tool — Subtitle Comparison & Text Engine ("src/subtitle-comparison-engine.js")
   ==============================================================================
   深層字幕比對、全文檢索與文本檢查引擎 (Subtitle Comparison & Text Engine)。
   提供文本比對 Diff、全文搜尋索引與多行排版字元品質驗證：
   1. 字幕比對與配對計畫 (pairSubtitleCues / subtitleFrameIndex / buildSubtitleComparisonPlan)
   2. 比對工作階段所有權守衛 (createSubtitleCompareSession / configureSubtitleCompareSession / openSubtitleCompareSession / syncSubtitleCompareSession / closeSubtitleCompareSession / handleSubtitleCompareCommand)
   3. 搜尋關鍵字高亮與正規表達式處理 (escRe / txtHTML / isSearchHit / getSearchCountText)
   ============================================================================== */

import { STYLE_DEFAULTS, effStyle } from './substyle.js';
import { getExactFps, secToEncore, snapTimeToFrame } from './time.js';
import { escapeHTMLWithSpaces } from './util.js';

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

function cloneSnapshot(snapshot = {}) {
  return {
    tracks: Array.isArray(snapshot.tracks) ? snapshot.tracks.map(track => ({ ...track })) : [],
    cues: Array.isArray(snapshot.cues) ? snapshot.cues.map(cue => ({
      ...cue,
      ...(cue?.style ? { style: { ...cue.style } } : {}),
    })) : [],
    fps: snapshot.fps,
    dropFrame: !!snapshot.dropFrame,
  };
}

function usablePort(port = {}) {
  return {
    open: typeof port.open === 'function' ? port.open : () => {},
    sync: typeof port.sync === 'function' ? port.sync : () => {},
    close: typeof port.close === 'function' ? port.close : () => {},
  };
}

function failed(reason) {
  return { accepted: false, reason };
}

export function createSubtitleCompareSession({
  port,
  buildPlan = buildSubtitleComparisonPlan,
  onSeek = () => true,
  onMatchStyle = () => true,
} = {}) {
  const bridge = usablePort(port);
  let isOpen = false;
  let revision = 0;
  let currentSnapshot = null;
  let selection = null;

  function payload() {
    const plan = buildPlan(currentSnapshot, selection || {}, { revision });
    selection = plan.selection ? { ...plan.selection, checks: { ...plan.checks } } : null;
    return { revision, plan };
  }

  function cueExists(cueId) {
    return typeof cueId === 'string' && currentSnapshot?.cues.some(cue => cue.id === cueId);
  }

  function open(snapshot, nextSelection) {
    currentSnapshot = cloneSnapshot(snapshot);
    selection = nextSelection || null;
    revision += 1;
    isOpen = true;
    bridge.open(payload());
    return true;
  }

  function sync(snapshot) {
    if (!isOpen) return false;
    currentSnapshot = cloneSnapshot(snapshot);
    revision += 1;
    bridge.sync(payload());
    return true;
  }

  function close() {
    if (!isOpen) return false;
    isOpen = false;
    currentSnapshot = null;
    selection = null;
    bridge.close();
    return true;
  }

  function handleCommand(command) {
    if (!isOpen) return failed('closed');
    if (!command || typeof command !== 'object') return failed('invalid-command');
    if (command.revision !== revision) return failed('stale-revision');

    if (command.type === 'select') {
      selection = {
        leftTrack: command.leftTrack,
        rightTrack: command.rightTrack,
        checks: command.checks,
      };
      bridge.sync(payload());
      return { accepted: true, revision };
    }

    if (command.type === 'seek') {
      if (!cueExists(command.cueId)) return failed('unknown-cue');
      return onSeek({ cueId: command.cueId, revision }) === false
        ? failed('seek-rejected')
        : { accepted: true, revision };
    }

    if (command.type === 'match-style') {
      if (!cueExists(command.targetCueId) || !cueExists(command.sourceCueId)) return failed('unknown-cue');
      return onMatchStyle({ targetCueId: command.targetCueId, sourceCueId: command.sourceCueId, revision }) === false
        ? failed('match-style-rejected')
        : { accepted: true, revision };
    }

    return failed('unknown-command');
  }

  return {
    open,
    sync,
    close,
    handleCommand,
    isOpen: () => isOpen,
    revision: () => revision,
  };
}

let activeSession = null;

export function configureSubtitleCompareSession(options) {
  activeSession = createSubtitleCompareSession(options);
  return activeSession;
}

export function openSubtitleCompareSession(snapshot, selection) {
  return activeSession?.open(snapshot, selection) || false;
}

export function syncSubtitleCompareSession(snapshot) {
  return activeSession?.sync(snapshot) || false;
}

export function closeSubtitleCompareSession() {
  return activeSession?.close() || false;
}

export function handleSubtitleCompareCommand(command) {
  return activeSession?.handleCommand(command) || failed('unavailable');
}

export function escRe(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function txtHTML(text, searchTerms = []) {
  const raw = text || '';
  const terms = Array.isArray(searchTerms) ? searchTerms.filter(Boolean) : [];
  if (!terms.length) return escapeHTMLWithSpaces(raw);
  const ranges = [];
  for (const term of terms) {
    if (!term) continue;
    const re = new RegExp(escRe(term), 'gi');
    let m;
    while ((m = re.exec(raw))) {
      if (!m[0].length) { re.lastIndex++; continue; }
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  if (!ranges.length) return escapeHTMLWithSpaces(raw);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [ranges[0].slice()];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    if (ranges[i][0] <= last[1]) last[1] = Math.max(last[1], ranges[i][1]);
    else merged.push(ranges[i].slice());
  }
  let out = '', pos = 0;
  for (const [s, e] of merged) {
    out += escapeHTMLWithSpaces(raw.slice(pos, s)) + `<span class="search-match">${escapeHTMLWithSpaces(raw.slice(s, e))}</span>`;
    pos = e;
  }
  return out + escapeHTMLWithSpaces(raw.slice(pos));
}
