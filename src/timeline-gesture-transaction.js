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

const CLIP_MODES = new Set(['clip-move', 'clip-l', 'clip-r']);
const AUDIO_MODES = new Set(['audio-move', 'audio-l', 'audio-r']);

/* blur／pointercancel 沒有 mouseup。所有 preview-only 狀態必須依固定順序收尾：
   清除輔助 UI → 停止輸入 → 回復 model／copy → 重算片段映射 → 重繪 → 同步 selection。
   renderer 只提供 DOM／播放 adapters，不再自己決定這個順序。 */
function cancelTimelineGesture(pending, effects = {}) {
  if (!pending) return { cancelled: false, restored: false };

  effects.clearSnapGuide?.(pending);
  effects.stopAutoScroll?.(pending);
  if (pending.mode === 'rubber') effects.hideRubberBand?.(pending);
  if (AUDIO_MODES.has(pending.mode)) effects.releaseAudioPointer?.(pending);

  const hasTransaction = !!pending.transaction;
  const restored = !!pending.transaction?.cancel?.();
  if (hasTransaction) {
    if (restored && CLIP_MODES.has(pending.mode)) effects.restoreClipMapping?.(pending);
    effects.redraw?.(pending);
    effects.refreshPreview?.(pending);
    if (pending.isCopyDrag) effects.refreshSelection?.(pending);
  }

  return { cancelled: true, restored };
}

export { beginTimelineGesture, cancelTimelineGesture, ABSENT };
