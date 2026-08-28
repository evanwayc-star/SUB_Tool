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

/**
 * 一次 renderer 手勢的完整生命週期。
 *
 * renderer 提供 model／DOM adapters，但只能透過這個 interface 開始 preview、
 * finalize 或 rollback；因此 pointerup、blur 與 pointercancel 不會各自維護一套
 * transaction ordering。
 */
function beginTimelineGestureLifecycle({ mode, targets = [], context = {}, effects = {} } = {}) {
  const transaction = beginTimelineGesture({ targets });
  const kind = gestureKind(mode);
  let active = true;

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

  function commit(commitEffect) {
    if (!active) return { committed: false, moved: false };
    if (typeof commitEffect === 'function') commitEffect({ mode, moved: transaction.hasMoved() });
    const moved = transaction.commit();
    active = false;
    return { committed: true, moved };
  }

  function cancel(extraContext = {}) {
    if (!active) return { cancelled: false, restored: false };
    const result = cancelTimelineGesture(
      { ...context, ...extraContext, mode, kind, transaction },
      effects,
    );
    active = false;
    return result;
  }

  return Object.freeze({
    kind,
    startPreview,
    preview,
    commit,
    cancel,
    addRollback: rollback => transaction.addRollback(rollback),
    addCancelEffect: effect => transaction.addCancelEffect(effect),
    hasMoved: () => transaction.hasMoved(),
    isActive: () => active,
  });
}

export { beginTimelineGesture, beginTimelineGestureLifecycle, ABSENT };
