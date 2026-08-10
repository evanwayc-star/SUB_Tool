/*
  Renderer-owned gestures may preview dozens of mutations before one mouseup
  commits history.  This module owns only the transaction lifecycle: capture
  primitive fields, track whether movement crossed the drag threshold, and
  restore every preview / copied-object rollback on cancellation.  It has no
  DOM, State, Media, or History dependency so the renderer remains the sole
  visual engine.
*/
const ABSENT = Symbol('absent');

function snapshotTarget(target, fields) {
  return {
    target,
    values: (Array.isArray(fields) ? fields : []).map(field => ({
      field,
      value: Object.prototype.hasOwnProperty.call(target || {}, field) ? target[field] : ABSENT,
    })),
  };
}

export function beginTimelineGesture({ targets = [] } = {}) {
  const snapshots = (Array.isArray(targets) ? targets : [])
    .filter(entry => entry?.target && Array.isArray(entry.fields))
    .map(entry => snapshotTarget(entry.target, entry.fields));
  const rollbacks = [];
  const cancelEffects = [];
  let active = true;
  let moved = false;

  const restore = () => {
    for (const { target, values } of snapshots) {
      for (const { field, value } of values) {
        if (value === ABSENT) delete target[field];
        else target[field] = value;
      }
    }
    for (let index = rollbacks.length - 1; index >= 0; index--) {
      try { rollbacks[index](); } catch (error) { console.warn('timeline gesture rollback failed', error); }
    }
  };

  return Object.freeze({
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
