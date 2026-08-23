/* ==============================================================================
   SUB Tool — Timeline Selection & Focus Engine ("src/timeline-selection.js")
   ==============================================================================
   時間軸複合選取與焦點狀態引擎 (Timeline Selection Engine)。
   守護兩條核心不變量：
   1. 三種選取互斥：字幕 (sub)、視訊片段 (video)、音訊片段 (audio) 永不並存。
   2. 焦點軌別 (activeTrackKind) 與焦點索引 (listTrack/activeVtrack/activeAudioTrackId) 同步。
   ============================================================================== */

export const SELECTION_KINDS = new Set(['sub', 'video', 'audio']);
export const FOCUS_INDEX_FIELD = { sub: 'listTrack', video: 'activeVtrack', audio: 'activeAudioTrackId' };

/**
 * 套用選取狀態至專案 State。
 */
export function applySelection(state, { kind = null, ids = [], primary } = {}) {
  const k = SELECTION_KINDS.has(kind) ? kind : null;
  const list = Array.isArray(ids) ? ids.filter(v => v != null) : (ids == null ? [] : [ids]);

  state.selectedIds = k === 'sub' ? list : [];
  state.selectedId = k === 'sub' ? (primary !== undefined ? primary : (list.length ? list[list.length - 1] : null)) : null;
  state.selectedClipId = k === 'video' ? (list.length ? list[0] : null) : null;
  state.selectedAudioClipId = k === 'audio' ? (list.length ? list[0] : null) : null;

  if (k) state.activeTrackKind = k;
  return state;
}

/**
 * 放掉某一種選取狀態。
 */
export function deselectItem(state, kind, id) {
  if (!SELECTION_KINDS.has(kind)) return state;
  if (kind === 'sub') {
    if (id == null) {
      state.selectedIds = [];
      state.selectedId = null;
      return state;
    }
    if (!state.selectedIds.includes(id) && state.selectedId !== id) return state;
    state.selectedIds = state.selectedIds.filter(x => x !== id);
    if (state.selectedId === id) {
      state.selectedId = state.selectedIds[state.selectedIds.length - 1] ?? null;
    }
    return state;
  }

  const field = kind === 'video' ? 'selectedClipId' : 'selectedAudioClipId';
  if (id == null || state[field] === id) {
    state[field] = null;
  }
  return state;
}

/**
 * 修剪已不存在的選取 ID（在復原、重做、刪除或載入後維持不變量）。
 */
export function pruneSelections(state) {
  if (!state) return state;
  const aliveCues = new Set((state.cues || []).map(c => c?.id).filter(Boolean));
  const ids = (state.selectedIds || []).filter(id => aliveCues.has(id));
  state.selectedIds = ids;
  state.selectedId = aliveCues.has(state.selectedId) ? state.selectedId : (ids[0] ?? null);

  if (state.selectedClipId && !state.clips?.some(c => c?.id === state.selectedClipId)) {
    state.selectedClipId = null;
  }
  return state;
}

/**
 * 切換焦點軌道類別與索引。
 */
export function focusTrack(state, kind, index) {
  if (!SELECTION_KINDS.has(kind)) return state;
  state.activeTrackKind = kind;
  if (index !== undefined) {
    const field = FOCUS_INDEX_FIELD[kind];
    if (field) state[field] = index;
  }
  return state;
}
