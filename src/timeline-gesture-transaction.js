/* ==============================================================================
   SUB Tool — Timeline Gesture Lifecycle
   ==============================================================================
   snapshot／rollback 由 timeline-edit-transaction.js 保存；這個 module 擁有
   renderer 手勢取消的 ordering constraint，讓 production 與測試跨同一個 interface。
   ============================================================================== */
import {
  beginTimelineGesture,
  ABSENT,
} from './timeline-edit-transaction.js';

const MODE_KIND = Object.freeze({
  'clip-move': 'clip', 'clip-l': 'clip', 'clip-r': 'clip',
  'audio-move': 'audio', 'audio-l': 'audio', 'audio-r': 'audio',
  move: 'cue', l: 'cue', r: 'cue',
  rubber: 'rubber', scrub: 'scrub',
});

function gestureKind(mode) {
  return MODE_KIND[mode] || 'unknown';
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function snapValue(value, targets = [], threshold = 0) {
  let best = value;
  let distance = Math.max(0, Number(threshold) || 0);
  for (const target of targets) {
    const nextDistance = Math.abs(Number(target) - value);
    if (Number.isFinite(nextDistance) && nextDistance < distance) {
      best = Number(target);
      distance = nextDistance;
    }
  }
  return best;
}

function frameSnapper(snapFrame) {
  return typeof snapFrame === 'function' ? snapFrame : value => value;
}

// FPS-SYNC：真正的格網仍由注入的 snapTimeToFrame 擁有；這裡只在逐格後
// 再檢查鄰居／素材邊界，必要時往範圍內的下一格收斂，避免吸附後重新重疊。
function snapFrameWithin(value, min, max, snapFrame, frameStep) {
  const frame = frameSnapper(snapFrame);
  const lower = Number.isFinite(min) ? min : -Infinity;
  const upper = Number.isFinite(max) ? max : Infinity;
  const bounded = clamp(value, lower, upper);
  let snapped = frame(bounded);
  const step = Number(frameStep);
  const epsilon = Number.isFinite(step) && step > 0 ? step * 1e-7 : 1e-9;
  if (snapped < lower - epsilon && Number.isFinite(step) && step > 0) {
    snapped = frame(lower + (step / 2) + epsilon);
  }
  if (snapped > upper + epsilon && Number.isFinite(step) && step > 0) {
    snapped = frame(upper - (step / 2) - epsilon);
  }
  if (snapped < lower - epsilon || snapped > upper + epsilon) return null;
  return snapped;
}

/** 純規則：影片片段移動／修剪，不接觸 State 或 DOM。 */
function planClipGesturePreview({
  mode,
  original = {},
  deltaTime = 0,
  targetTrack = original.vtrack || 0,
  targetTrackLocked = false,
  snaps = [],
  snapThreshold = 0,
  snapFrame,
  frameStep,
  leftLimit = 0,
  rightLimit = Infinity,
  minLength = 0.2,
} = {}) {
  const frame = frameSnapper(snapFrame);
  const offset = Number(original.offset) || 0;
  const inPoint = Number(original.in) || 0;
  const outPoint = Number(original.out) || 0;
  const duration = Number(original.duration ?? original.dur) || outPoint;
  const result = {
    offset,
    in: inPoint,
    out: outPoint,
    vtrack: Number(original.vtrack) || 0,
    snapTarget: null,
  };

  if (mode === 'clip-move') {
    let nextOffset = offset + deltaTime;
    const length = outPoint - inPoint;
    const atStart = snapValue(nextOffset, snaps, snapThreshold);
    const atEnd = snapValue(nextOffset + length, snaps, snapThreshold);
    if (atStart !== nextOffset) {
      nextOffset = atStart;
      result.snapTarget = atStart;
    } else if (atEnd !== nextOffset + length) {
      nextOffset = atEnd - length;
      result.snapTarget = atEnd;
    }
    result.offset = snapFrameWithin(nextOffset, 0, Infinity, frame, frameStep) ?? offset;
    if (!targetTrackLocked && Number.isInteger(targetTrack) && targetTrack >= 0) result.vtrack = targetTrack;
    return Object.freeze(result);
  }

  if (mode === 'clip-l') {
    const minDelta = original.type === 'image'
      ? leftLimit - offset
      : Math.max(-inPoint, leftLimit - offset);
    const maxDelta = (outPoint - minLength) - inPoint;
    let delta = clamp(deltaTime, minDelta, maxDelta);
    let left = offset + delta;
    const snapped = snapValue(left, snaps, snapThreshold);
    if (
      snapped !== left &&
      snapped >= leftLimit - 1e-9 &&
      snapped - offset >= minDelta - 1e-9 &&
      snapped - offset <= maxDelta + 1e-9
    ) {
      left = snapped;
      delta = snapped - offset;
      result.snapTarget = snapped;
    }
    left = snapFrameWithin(left, Math.max(0, leftLimit), offset + maxDelta, frame, frameStep);
    if (left == null) return Object.freeze(result);
    delta = left - offset;
    result.offset = left;
    if (original.type === 'image') result.out = outPoint - delta;
    else result.in = Math.max(0, inPoint + delta);
    return Object.freeze(result);
  }

  const minEdge = offset + minLength;
  const maxEdge = Math.min(rightLimit, offset + (duration - inPoint));
  let edge = clamp(offset + (outPoint + deltaTime - inPoint), minEdge, maxEdge);
  const snapped = snapValue(edge, snaps, snapThreshold);
  if (snapped !== edge && snapped >= minEdge - 1e-9 && snapped <= maxEdge + 1e-9) {
    edge = snapped;
    result.snapTarget = snapped;
  }
  edge = snapFrameWithin(edge, minEdge, maxEdge, frame, frameStep);
  if (edge == null) return Object.freeze(result);
  result.out = clamp(inPoint + (edge - offset), inPoint + minLength, duration);
  return Object.freeze(result);
}

/** 純規則：外部音訊只產生 provisional placement，不重建 Audio graph。 */
function planAudioGesturePreview({
  mode,
  original = {},
  deltaTime = 0,
  snaps = [],
  snapThreshold = 0,
  snapFrame,
  frameStep,
} = {}) {
  const frame = frameSnapper(snapFrame);
  const offset = Number(original.offset) || 0;
  const inPoint = Number(original.in) || 0;
  const outPoint = Number(original.out) || 0;
  const duration = Number(original.duration) || outPoint;
  const minLength = Math.min(0.2, Math.max(0.02, (outPoint - inPoint) / 2));
  const maxOut = Math.max(inPoint + minLength, duration);
  const result = { offset, in: inPoint, out: outPoint, snapTarget: null };

  if (mode === 'audio-move') {
    let nextOffset = Math.max(0, offset + deltaTime);
    const length = outPoint - inPoint;
    const atStart = snapValue(nextOffset, snaps, snapThreshold);
    const atEnd = snapValue(nextOffset + length, snaps, snapThreshold);
    if (atStart !== nextOffset) {
      nextOffset = atStart;
      result.snapTarget = atStart;
    } else if (atEnd !== nextOffset + length) {
      nextOffset = atEnd - length;
      result.snapTarget = atEnd;
    }
    result.offset = snapFrameWithin(nextOffset, 0, Infinity, frame, frameStep) ?? offset;
    return Object.freeze(result);
  }

  if (mode === 'audio-l') {
    const minLeft = Math.max(0, offset - inPoint);
    const maxLeft = offset + (outPoint - inPoint - minLength);
    let left = clamp(offset + deltaTime, minLeft, maxLeft);
    const snapped = snapValue(left, snaps, snapThreshold);
    if (snapped !== left && snapped >= minLeft - 1e-9 && snapped <= maxLeft + 1e-9) {
      left = snapped;
      result.snapTarget = snapped;
    }
    result.offset = snapFrameWithin(left, minLeft, maxLeft, frame, frameStep);
    if (result.offset == null) return Object.freeze({ offset, in: inPoint, out: outPoint, snapTarget: null });
    result.in = clamp(inPoint + (result.offset - offset), 0, outPoint - minLength);
    return Object.freeze(result);
  }

  const minRight = offset + minLength;
  const maxRight = offset + (maxOut - inPoint);
  let right = clamp(offset + (outPoint - inPoint) + deltaTime, minRight, maxRight);
  const snapped = snapValue(right, snaps, snapThreshold);
  if (snapped !== right && snapped >= minRight - 1e-9 && snapped <= maxRight + 1e-9) {
    right = snapped;
    result.snapTarget = snapped;
  }
  right = snapFrameWithin(right, minRight, maxRight, frame, frameStep);
  if (right == null) return Object.freeze(result);
  result.out = clamp(inPoint + (right - offset), inPoint + minLength, maxOut);
  return Object.freeze(result);
}

/** 純規則：字幕群組移動／單邊修剪，目的軌鎖定時保留原軌。 */
function planCueGesturePreview({
  mode,
  originals = [],
  deltaTime = 0,
  targetTrackDelta = 0,
  trackCount = 1,
  lockedTracks = [],
  overwriteMode = false,
  snaps = [],
  snapThreshold = 0,
  snapFrame,
  frameStep,
  minLength = 0.05,
} = {}) {
  const frame = frameSnapper(snapFrame);
  const source = originals.map(item => ({
    start: Number(item.start) || 0,
    end: Number(item.end) || 0,
    track: Number(item.track) || 0,
    prevEnd: Number(item.prevEnd) || 0,
    nextStart: Number.isFinite(item.nextStart) ? item.nextStart : Infinity,
  }));
  if (!source.length) return Object.freeze({ items: Object.freeze([]), snapTarget: null, trackDelta: 0 });
  let snapTarget = null;

  if (mode === 'move') {
    let delta = deltaTime;
    if (!overwriteMode) {
      for (const item of source) {
        delta = Math.max(delta, item.prevEnd - item.start);
        if (item.nextStart !== Infinity) delta = Math.min(delta, item.nextStart - item.end);
      }
    }
    const minimumStart = Math.min(...source.map(item => item.start));
    if (minimumStart + delta < 0) delta = -minimumStart;
    let snapAnchor = 'start';
    if (source.length === 1) {
      const item = source[0];
      const length = item.end - item.start;
      const nextStart = item.start + delta;
      const atStart = snapValue(nextStart, snaps, snapThreshold);
      const atEnd = snapValue(nextStart + length, snaps, snapThreshold);
      let snappedStart = nextStart;
      if (atStart !== nextStart) {
        snappedStart = atStart;
        snapTarget = atStart;
      } else if (atEnd !== nextStart + length) {
        snappedStart = atEnd - length;
        snapTarget = atEnd;
        snapAnchor = 'end';
      }
      let snappedDelta = snappedStart - item.start;
      if (!overwriteMode) {
        snappedDelta = Math.max(snappedDelta, item.prevEnd - item.start);
        if (item.nextStart !== Infinity) snappedDelta = Math.min(snappedDelta, item.nextStart - item.end);
      }
      if (item.start + snappedDelta < 0) snappedDelta = -item.start;
      delta = snappedDelta;
    }

    const minTrack = Math.min(...source.map(item => item.track));
    const maxTrack = Math.max(...source.map(item => item.track));
    const requestedTrackDelta = clamp(targetTrackDelta, -minTrack, Math.max(0, trackCount - 1 - maxTrack));
    const canChangeTrack = source.every(item => {
      const target = item.track + requestedTrackDelta;
      return target >= 0 && target < trackCount && !lockedTracks[target];
    });
    const trackDelta = canChangeTrack ? requestedTrackDelta : 0;
    const items = source.map(item => {
      const length = item.end - item.start;
      const minimum = overwriteMode ? 0 : Math.max(0, item.prevEnd);
      const maximum = overwriteMode ? Infinity : item.nextStart - length;
      const desiredStart = snapAnchor === 'end' ? item.end + delta - length : item.start + delta;
      const start = snapFrameWithin(desiredStart, minimum, maximum, frame, frameStep);
      if (start == null) return null;
      const end = snapFrameWithin(
        start + length,
        start + minLength,
        overwriteMode ? Infinity : item.nextStart,
        frame,
        frameStep,
      );
      if (end == null) return null;
      return Object.freeze({ start, end, track: item.track + trackDelta });
    });
    if (items.some(item => item == null)) {
      return Object.freeze({
        items: Object.freeze(source.map(item => Object.freeze({
          start: item.start, end: item.end, track: item.track,
        }))),
        snapTarget: null,
        trackDelta: 0,
      });
    }
    return Object.freeze({ items: Object.freeze(items), snapTarget, trackDelta });
  }

  const item = source[0];
  if (mode === 'l') {
    let start = overwriteMode
      ? Math.max(0, item.start + deltaTime)
      : clamp(item.start + deltaTime, item.prevEnd, item.end - minLength);
    const snapped = snapValue(start, snaps, snapThreshold);
    const valid = overwriteMode
      ? snapped >= 0 && snapped <= item.end - minLength
      : snapped >= item.prevEnd && snapped <= item.end - minLength;
    if (snapped !== start && valid) {
      start = snapped;
      snapTarget = snapped;
    }
    const boundedStart = snapFrameWithin(
      start,
      overwriteMode ? 0 : item.prevEnd,
      item.end - minLength,
      frame,
      frameStep,
    );
    return Object.freeze({
      items: Object.freeze([Object.freeze({ start: boundedStart ?? item.start, end: item.end, track: item.track })]),
      snapTarget,
      trackDelta: 0,
    });
  }

  let end = overwriteMode
    ? item.end + deltaTime
    : clamp(item.end + deltaTime, item.start + minLength, item.nextStart);
  const snapped = snapValue(end, snaps, snapThreshold);
  const valid = overwriteMode
    ? snapped >= item.start + minLength
    : snapped >= item.start + minLength && snapped <= item.nextStart;
  if (snapped !== end && valid) {
    end = snapped;
    snapTarget = snapped;
  }
  const boundedEnd = snapFrameWithin(
    end,
    item.start + minLength,
    overwriteMode ? Infinity : item.nextStart,
    frame,
    frameStep,
  );
  return Object.freeze({
    items: Object.freeze([Object.freeze({ start: item.start, end: boundedEnd ?? item.end, track: item.track })]),
    snapTarget,
    trackDelta: 0,
  });
}

function freezeIntent(mode, kind, targets, context) {
  const startPoint = context.startPoint
    ? Object.freeze({ x: Number(context.startPoint.x) || 0, y: Number(context.startPoint.y) || 0 })
    : null;
  const targetIds = Array.isArray(context.targetIds)
    ? [...context.targetIds]
    : targets.map(item => item?.target?.id).filter(Boolean);
  return Object.freeze({
    mode,
    kind,
    startPoint,
    thresholdPx: Number.isFinite(context.thresholdPx) ? Math.max(0, context.thresholdPx) : 3,
    targetIds: Object.freeze(targetIds),
    modifiers: Object.freeze({ ...(context.modifiers || {}) }),
    isCopyDrag: !!context.isCopyDrag,
  });
}

/* blur／pointercancel 沒有 mouseup。所有 preview-only 狀態必須依固定順序收尾：
   清除輔助 UI → 停止輸入 → 回復 model／copy → 重算片段映射 → 重繪 → 同步 selection。
   renderer 只提供 DOM／播放 adapters，不再自己決定這個順序。 */
function cancelTimelineGesture(pending, effects = {}) {
  if (!pending) return { cancelled: false, restored: false };

  effects.clearSnapGuide?.(pending);
  effects.stopAutoScroll?.(pending);
  const kind = pending.kind || gestureKind(pending.mode);
  if (kind === 'rubber') effects.hideRubberBand?.(pending);
  if (kind === 'audio') effects.releaseAudioPointer?.(pending);

  const hasTransaction = !!pending.transaction;
  const restored = !!pending.transaction?.cancel?.();
  if (hasTransaction) {
    if (restored && kind === 'clip') effects.restoreClipMapping?.(pending);
    effects.redraw?.(pending);
    effects.refreshPreview?.(pending);
    if (pending.isCopyDrag) effects.refreshSelection?.(pending);
  }

  return { cancelled: true, restored };
}

let activeLifecycle = null;

/**
 * 一次 renderer 手勢的完整生命週期。
 *
 * renderer 提供 model／DOM adapters，但只能透過這個 interface 開始 preview、
 * finalize 或 rollback；因此 pointerup、blur 與 pointercancel 不會各自維護一套
 * transaction ordering。
 */
function beginTimelineGestureLifecycle({ mode, targets = [], context = {}, effects = {} } = {}) {
  if (activeLifecycle?.isActive()) activeLifecycle.cancel({ cancelReason: 'replaced' });
  const transaction = beginTimelineGesture({ targets });
  const kind = gestureKind(mode);
  const intent = freezeIntent(mode, kind, targets, context);
  let active = true;
  let lifecycle = null;

  function startPreview(startEffect) {
    if (!active || transaction.hasMoved()) return false;
    transaction.markMoved();
    if (typeof startEffect === 'function') startEffect();
    return true;
  }

  function preview(previewEffect) {
    if (!active || typeof previewEffect !== 'function') return false;
    previewEffect();
    return true;
  }

  function acceptSample(point, startEffect) {
    if (!active) return { accepted: false, started: false };
    if (transaction.hasMoved()) return { accepted: true, started: false };
    if (!intent.startPoint) return { accepted: false, started: false };
    const x = Number(point?.x) || 0;
    const y = Number(point?.y) || 0;
    const crossed = Math.abs(x - intent.startPoint.x) > intent.thresholdPx ||
      Math.abs(y - intent.startPoint.y) > intent.thresholdPx;
    if (!crossed) return { accepted: false, started: false };
    return { accepted: startPreview(startEffect), started: true };
  }

  function commit(commitEffect) {
    if (!active) return { committed: false, moved: false };
    if (typeof commitEffect === 'function') commitEffect({ mode, moved: transaction.hasMoved() });
    const moved = transaction.commit();
    active = false;
    if (activeLifecycle === lifecycle) activeLifecycle = null;
    return { committed: true, moved };
  }

  function cancel(extraContext = {}) {
    if (!active) return { cancelled: false, restored: false };
    const result = cancelTimelineGesture(
      { ...context, ...extraContext, mode, kind, transaction },
      effects,
    );
    active = false;
    if (activeLifecycle === lifecycle) activeLifecycle = null;
    return result;
  }

  lifecycle = Object.freeze({
    kind,
    intent,
    acceptSample,
    startPreview,
    preview,
    commit,
    cancel,
    addRollback: rollback => transaction.addRollback(rollback),
    addCancelEffect: effect => transaction.addCancelEffect(effect),
    hasMoved: () => transaction.hasMoved(),
    isActive: () => active,
  });
  activeLifecycle = lifecycle;
  return lifecycle;
}

export {
  beginTimelineGesture,
  beginTimelineGestureLifecycle,
  planCueGesturePreview,
  planClipGesturePreview,
  planAudioGesturePreview,
  ABSENT,
};
