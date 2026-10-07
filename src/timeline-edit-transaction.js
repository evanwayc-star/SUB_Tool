/* ==============================================================================
   SUB Tool — 時間軸軌道與幾何編輯交易（Timeline Edit Transaction）
   ==============================================================================
   軌道列頭的可見、名稱、鎖定與高度都是可序列化專案狀態，也都在 History 快照內。
   若 gutter 直接改 State 卻沒有立刻建立歷史邊界，下一個無關操作會把它一起收進快照，
   Ctrl+Z 便一次倒退兩件事。

   這裡是軌道 metadata 的唯一 mutation seam：單次按鈕操作立即 commit；高度拖曳可
   preview 多次、mouseup 只 commit 一次。模組不碰 DOM，畫面更新與 History 透過同步
   events 交給協調層，因此不會形成 timeline-renderer ↔ history 的新循環相依。
   幾何視窗與預覽拖曳共用欄位 owner，保存與取消都依同一份最後寫入證據投影。
============================================================================== */

import { State, deselect } from './state.js';
import { emit } from './events.js';

const ALLOWED_FIELDS = new Set(['visible', 'name', 'locked', 'height']);
const KIND_LABEL = { subtitle: '字幕軌', video: '視訊軌', audio: '音訊軌' };
const ABSENT = Symbol('absent');

function trackAt(kind, index, id){
  if (kind === 'subtitle') {
    if (!Number.isInteger(index) || index < 0) return null;
    return State.tracks?.[index] || null;
  }
  if (kind === 'video') {
    if (!Number.isInteger(index) || index < 0) return null;
    return State.videoTracks?.[index] || null;
  }
  if (kind === 'audio') {
    const key = id ?? index;
    if (key == null || key === '') return null;
    const strKey = String(key);
    if (Array.isArray(State.externalAudioState)) {
      const found = State.externalAudioState.find(a =>
        a && (a.id === strKey || a.audioSourceId === strKey || a.audioSrc === strKey || a.source === strKey || a.timelineLaneId === strKey)
      );
      if (found) return found;
    }
    if (Array.isArray(State.clips)) {
      const foundClip = State.clips.find(c =>
        c && (c.id === strKey || c.audioSourceId === strKey || c.audioSrc === strKey || String(c.audioSourceId || c.id || c.audioSrc || '') === strKey)
      );
      if (foundClip) return foundClip;
    }
  }
  return null;
}

function normalizedValue(kind, index, field, value){
  if (field === 'visible' || field === 'locked') return !!value;
  if (field === 'name') {
    const fallback = kind === 'video' ? `視訊軌 ${index + 1}` : (kind === 'audio' ? `音訊軌 ${index + 1}` : `軌道 ${index + 1}`);
    return String(value ?? '').trim() || fallback;
  }
  if (field === 'height') {
    if (value == null) return ABSENT;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return ABSENT;
    const minH = kind === 'video' ? 24 : (kind === 'audio' ? 32 : 20);
    const maxH = kind === 'audio' ? 160 : Infinity;
    return Math.min(maxH, Math.max(minH, numeric));
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

function beginTimelineTrackEdit({ kind, index, id, field, label = null, target: providedTarget = null, expectedTarget = null, onApply = null, beginPreview = null } = {}){
  if (!KIND_LABEL[kind] || !ALLOWED_FIELDS.has(field)) return null;
  const target = providedTarget || trackAt(kind, index, id);
  if (!target || (expectedTarget && target!==expectedTarget)) return null;
  const before = readValue(target, field);
  let latest = before;
  let active = true;
  const ownsField = () => Object.is(readValue(target, field), latest);
  const endPreview=beginPreview?.([{target,fields:[field],ownsField}]);

  const live = () => active && (!endPreview || endPreview.isCurrent()) && (providedTarget ? true : trackAt(kind, index, id) === target);
  const apply = (value, phase) => {
    if (!live() || !ownsField()) return false;
    const next = normalizedValue(kind, index, field, value);
    if (Object.is(latest, next)) return false;
    writeValue(target, field, next);
    latest = next;
    if (typeof onApply === 'function') onApply(next, target);
    if (phase) notify(kind, index ?? id, field, phase);
    return true;
  };
  // 拖曳預覽由 renderer 在 requestAnimationFrame 內局部更新；完整重繪只在 commit。
  const preview = value => {
    if (!live() || !ownsField()) { cancel(); return false; }
    return apply(value, null);
  };

  const commit = (...args) => {
    if (!live() || !ownsField()) { endPreview?.(); active=false; return false; }
    if (args.length) apply(args[0], null);
    if (!live() || Object.is(before, latest)) {
      endPreview?.();
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
    endPreview?.();
    if (clearedClipId) emit('selection:clipCleared', { id: clearedClipId, reason: 'track-locked' });
    notify(kind, index ?? id, field, 'commit', selectionChanged);
    emit('history:record', label || defaultLabel({ kind, field, before, after: latest, target }));
    return true;
  };

  const cancel = () => {
    if (!live()) { endPreview?.(); active=false; return false; }
    const changed = !Object.is(before, latest);
    const restored=changed && ownsField();
    if (restored) {
      writeValue(target, field, before);
      if (typeof onApply === 'function') onApply(before, target);
      notify(kind, index ?? id, field, 'cancel');
    }
    active = false;
    endPreview?.();
    return restored;
  };

  return Object.freeze({ preview, commit, cancel });
}

function updateTimelineTrack(options){
  const edit = beginTimelineTrackEdit(options);
  if (!edit) return false;
  return edit.commit(options?.value);
}

function cloneFieldValue(value) {
  return value === ABSENT ? ABSENT : structuredClone(value);
}

function sameFieldValue(left, right) {
  if (Object.is(left, right)) return true;
  return !!(left !== ABSENT && right !== ABSENT && left && right
    && typeof left === 'object' && typeof right === 'object'
    && JSON.stringify(left) === JSON.stringify(right));
}

/* 最後寫入證據同時決定持久快照與 cancel 的投影，避免兩條路各自猜欄位 owner。 */
function capturePreviewFields(read, fields) {
  const original = new Map(fields.map(field => [field, cloneFieldValue(readValue(read(), field))]));
  let latest = new Map(original);
  const ownsField = field => latest.has(field) && sameFieldValue(readValue(read(), field), latest.get(field));
  return {
    ownsField,
    isCurrent: () => fields.every(ownsField),
    hasOwnedChanges: () => fields.some(field => ownsField(field) && !sameFieldValue(latest.get(field), original.get(field))),
    remember() { latest = new Map(fields.map(field => [field, cloneFieldValue(readValue(read(), field))])); },
    project(current) {
      const value = { ...current };
      for (const field of fields) if (ownsField(field)) writeValue(value, field, cloneFieldValue(original.get(field)));
      return value;
    },
    restore(write, force = false) {
      for (const field of fields) if (force || ownsField(field)) write(field, cloneFieldValue(original.get(field)));
    },
    changed: () => fields.some(field => !sameFieldValue(readValue(read(), field), original.get(field))),
  };
}

/* 幾何預覽的兩個 model adapters：片段頂層欄位、字幕 style 子欄位。
   draft 使用頂層欄位但不進 History；owner 由常用樣式編輯持有。 */
function geometryAdapter(kind, target, owns) {
  const nested = kind === 'cue';
  const originalStyle = nested ? cloneFieldValue(readValue(target, 'style')) : ABSENT;
  const sourceTrack = kind === 'clip' ? State.videoTracks[target.vtrack || 0]
    : nested ? State.tracks[target.track || 0] : null;
  const read = () => nested ? target.style || {} : target;
  const current = () => owns() && (kind === 'draft' || (!!sourceTrack && (kind === 'clip'
    ? State.clips.find(item => item.id === target.id) === target && State.videoTracks[target.vtrack || 0] === sourceTrack
    : State.cues.find(item => item.id === target.id) === target && State.tracks[target.track || 0] === sourceTrack)));
  const locked = () => !!sourceTrack?.locked || (kind === 'clip' && !!target.locked);
  const write = (field, value) => writeValue(nested ? target.style ||= {} : target, field, value);
  const projectStyle = (owner, currentStyle) => {
    const value = owner.project(currentStyle || {});
    if (Object.keys(value).length) return { present: true, value };
    // 貼上字幕可帶 own undefined；只有仍屬於本次預覽的子欄位才可還原原空包。
    // 背景整包清空後已失去該 ownership，必須保留它目前的空包型態。
    const style = owner.hasOwnedChanges() ? originalStyle : readValue(target, 'style');
    return { present: style !== ABSENT, value: style == null ? style : value };
  };
  return {
    read, current, locked, write,
    previewTarget(owner, fields) {
      return nested ? { target, fields: ['style'], projectField: (_field, { current: style }) => projectStyle(owner, style) }
        : { target, fields, ownsField: owner.ownsField };
    },
    restore(owner) {
      if (!nested) { owner.restore(write); return; }
      const projected = projectStyle(owner, read());
      if (projected.present) target.style = projected.value;
      else delete target.style;
    },
  };
}

/* modal 與 pointer adapters 只提供幾何數值；本交易擁有 model owner、草稿投影、
   同欄位衝突、取消回復與 release-before-record。鎖定阻止寫入但不阻止 cancel。 */
function beginGeometryEdit({ kind = 'clip', target, fields, owns = () => true, beginPreview = null, recordHistory = null } = {}) {
  const allowed = kind === 'cue' || kind === 'draft' ? ['posX', 'posY', 'angle'] : ['posX', 'posY', 'scale'];
  if (!target || !['clip', 'cue', 'draft'].includes(kind)) return null;
  fields = [...new Set(fields || allowed)].filter(field => allowed.includes(field));
  if (!fields.length) return null;
  const adapter = geometryAdapter(kind, target, owns);
  if (!adapter.current() || adapter.locked()) return null;
  const owner = capturePreviewFields(adapter.read, fields);
  const release = kind === 'draft' ? null : beginPreview?.([adapter.previewTarget(owner, fields)], adapter.current);
  let active = true;
  const current = () => active && adapter.current() && (!release || release.isCurrent());
  const editable = () => current() && !adapter.locked() && owner.isCurrent();
  const cancel = () => {
    if (!active) return false;
    const owned = current();
    const restored = owned && owner.changed();
    if (owned) adapter.restore(owner);
    active = false;
    release?.();
    return restored;
  };
  const preview = patch => {
    if (!editable()) { cancel(); return false; }
    if (typeof patch === 'function') patch();
    else for (const field of fields) if (Object.hasOwn(patch || {}, field)) adapter.write(field, patch[field]);
    owner.remember();
    return true;
  };
  const commit = (label, patch = null) => {
    if (!editable()) { cancel(); return false; }
    if (patch && !preview(patch)) return false;
    if (!editable()) { cancel(); return false; }
    const changed = owner.changed();
    active = false;
    release?.();
    if (kind !== 'draft' && changed && label) {
      if (recordHistory) recordHistory(label);
      else emit('history:record', label);
    }
    return true;
  };
  return Object.freeze({ isCurrent: editable, preview, commit, cancel });
}

function beginTimelineGesture({ targets = [] } = {}) {
  const snapshots = (Array.isArray(targets) ? targets : [])
    .filter(entry => entry?.target && Array.isArray(entry.fields))
    .map(({ target, fields }) => ({ target, fields, owner: capturePreviewFields(() => target, fields) }));
  const rollbacks = [];
  const cancelEffects = [];
  const ownersByTarget = new Map();
  for (const {target,fields,owner} of snapshots) {
    const indexed=ownersByTarget.get(target) || new Map();
    for (const field of fields) indexed.set(field,owner);
    ownersByTarget.set(target,indexed);
  }
  let active = true;
  let moved = false;
  let hasPreviewValues = false;

  // 回復及持久快照共用這份最後寫入證據；背景工作改寫的同欄位不再屬於手勢。
  const ownsField = (target, field) => {
    if (!hasPreviewValues) return true;
    return !!ownersByTarget.get(target)?.get(field)?.ownsField(field);
  };

  const restore = () => {
    for (const { target, owner } of snapshots) owner.restore((field, value) => writeValue(target, field, value), !hasPreviewValues);
    for (let index = rollbacks.length - 1; index >= 0; index--) {
      try { rollbacks[index](); } catch (error) { console.warn('timeline gesture rollback failed', error); }
    }
  };

  return Object.freeze({
    ownsField,
    isCurrent() {
      return !hasPreviewValues || snapshots.every(({ owner }) => owner.isCurrent());
    },
    rememberPreview() {
      if (!active) return false;
      for (const { owner } of snapshots) owner.remember();
      hasPreviewValues = true;
      return true;
    },
    markMoved() {
      if (!active) return false;
      moved = true;
      return true;
    },
    addRollback(rollback) {
      if (!active || typeof rollback !== 'function') return false;
      rollbacks.push(rollback);
      return true;
    },
    addCancelEffect(effect) {
      if (!active || typeof effect !== 'function') return false;
      cancelEffects.push(effect);
      return true;
    },
    isActive() { return active; },
    hasMoved() { return moved; },
    commit() {
      if (!active) return false;
      active = false;
      return moved;
    },
    cancel() {
      if (!active) return false;
      restore();
      active = false;
      for (const effect of cancelEffects) {
        try { effect(); } catch (error) { console.warn('timeline gesture cancel effect failed', error); }
      }
      return moved;
    },
  });
}

export { beginTimelineTrackEdit, updateTimelineTrack, beginTimelineGesture, beginGeometryEdit, ABSENT };
