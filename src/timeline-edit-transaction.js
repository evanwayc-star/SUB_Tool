/* ==============================================================================
   SUB Tool — 時間軸軌道編輯交易（Timeline Track Edit Transaction）
   ==============================================================================
   軌道列頭的可見、名稱、鎖定與高度都是可序列化專案狀態，也都在 History 快照內。
   若 gutter 直接改 State 卻沒有立刻建立歷史邊界，下一個無關操作會把它一起收進快照，
   Ctrl+Z 便一次倒退兩件事。

   這裡是軌道 metadata 的唯一 mutation seam：單次按鈕操作立即 commit；高度拖曳可
   preview 多次、mouseup 只 commit 一次。模組不碰 DOM，畫面更新與 History 透過同步
   events 交給協調層，因此不會形成 timeline-renderer ↔ history 的新循環相依。
============================================================================== */

import { State, deselect } from './state.js';
import { emit } from './events.js';

const ALLOWED_FIELDS = new Set(['visible', 'name', 'locked', 'height']);
const KIND_LABEL = { subtitle: '字幕軌', video: '視訊軌' };
const ABSENT = Symbol('absent');

function trackAt(kind, index){
  if (!Number.isInteger(index) || index < 0) return null;
  if (kind === 'subtitle') return State.tracks?.[index] || null;
  if (kind === 'video') return State.videoTracks?.[index] || null;
  return null;
}

function normalizedValue(kind, index, field, value){
  if (field === 'visible' || field === 'locked') return !!value;
  if (field === 'name') {
    const fallback = kind === 'video' ? `視訊軌 ${index + 1}` : `軌道 ${index + 1}`;
    return String(value ?? '').trim() || fallback;
  }
  if (field === 'height') {
    if (value == null) return ABSENT;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return ABSENT;
    return Math.max(kind === 'video' ? 24 : 20, numeric);
  }
  return value;
}

function readValue(target, field){
  return Object.prototype.hasOwnProperty.call(target, field) ? target[field] : ABSENT;
}

function writeValue(target, field, value){
  if (value === ABSENT) delete target[field];
  else target[field] = value;
}

function defaultLabel({ kind, field, before, after, target }){
  const type = KIND_LABEL[kind];
  const name = field === 'name'
    ? String(after === ABSENT ? target.name : after)
    : String(target.name || type);
  if (field === 'visible') return `${after ? '顯示' : '隱藏'}${type}：${name}`;
  if (field === 'locked') return `${after ? '鎖定' : '解鎖'}${type}：${name}`;
  if (field === 'name') return `重新命名${type}：${before === ABSENT ? '' : before} → ${name}`;
  return `調整${type}高度：${name}`;
}

function notify(kind, index, field, phase, selectionChanged = false){
  emit('timeline:invalidate', { kind, index, field, phase });
  if (field === 'visible') {
    emit('render:videoSub');
    if (kind === 'subtitle') emit('mpv:refreshSubs');
  }
  if (kind === 'subtitle' && field === 'name') emit('render:listTrackSel');
  if (selectionChanged) emit('render:all');
}

function beginTimelineTrackEdit({ kind, index, field, label = null } = {}){
  if (!KIND_LABEL[kind] || !ALLOWED_FIELDS.has(field)) return null;
  const target = trackAt(kind, index);
  if (!target) return null;
  const before = readValue(target, field);
  let latest = before;
  let active = true;

  const live = () => active && trackAt(kind, index) === target;
  const apply = (value, phase) => {
    if (!live()) return false;
    const next = normalizedValue(kind, index, field, value);
    if (Object.is(latest, next)) return false;
    writeValue(target, field, next);
    latest = next;
    if (phase) notify(kind, index, field, phase);
    return true;
  };
  // 拖曳預覽由 renderer 在 requestAnimationFrame 內局部更新；完整重繪只在 commit。
  const preview = value => apply(value, null);

  const commit = (...args) => {
    if (!live()) return false;
    if (args.length) apply(args[0], null);
    if (!live() || Object.is(before, latest)) {
      active = false;
      return false;
    }
    let selectionChanged = false;
    let clearedClipId = null;
    if (kind === 'video' && field === 'locked' && latest === true) {
      const selected = State.clips?.find(clip => clip?.id === State.selectedClipId);
      if (selected && (selected.vtrack || 0) === index) {
        deselect('video', selected.id);
        selectionChanged = true;
        clearedClipId = selected.id;
      }
    }
    active = false;
    if (clearedClipId) emit('selection:clipCleared', { id: clearedClipId, reason: 'track-locked' });
    notify(kind, index, field, 'commit', selectionChanged);
    emit('history:record', label || defaultLabel({ kind, field, before, after: latest, target }));
    return true;
  };

  const cancel = () => {
    if (!live()) return false;
    const changed = !Object.is(before, latest);
    if (changed) {
      writeValue(target, field, before);
      notify(kind, index, field, 'cancel');
    }
    active = false;
    return changed;
  };

  return Object.freeze({ preview, commit, cancel });
}

function updateTimelineTrack(options){
  const edit = beginTimelineTrackEdit(options);
  if (!edit) return false;
  return edit.commit(options?.value);
}

export { beginTimelineTrackEdit, updateTimelineTrack };
