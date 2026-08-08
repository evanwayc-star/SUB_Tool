/* ==============================================================================
   SUB Tool — 字幕比對 session
   ============================================================================== */
/*
   這個 module 擁有比對視窗的 open state、revision、snapshot 與 command contract。
   Electron IPC 是 port adapter；測試以 in-memory port 觀察同一個 interface。
*/
import { buildSubtitleComparisonPlan } from './subtitle-comparison.js';

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
