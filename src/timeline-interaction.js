import { State } from './state.js';
import { Media } from './media.js';
import { detectWaveformTransients, findNearestWaveformSnap } from './waveform-snapping-engine.js';

export { detectWaveformTransients, findNearestWaveformSnap };

export function timeToX(t, viewStart = State.viewStart, pxPerSec = State.pxPerSec) {
  return (t - viewStart) * pxPerSec;
}

export function xToTime(x, viewStart = State.viewStart, pxPerSec = State.pxPerSec) {
  return viewStart + x / pxPerSec;
}

export function snapTargets(excludeIds, extraSnapPoints = []) {
  let t = [0, State.duration > 0 ? State.duration : 1];
  for (const c of State.cues) {
    if (excludeIds && (excludeIds.has ? excludeIds.has(c.id) : excludeIds.includes(c.id))) continue;
    if (c.timed === false) continue;
    t.push(c.start); t.push(c.end);
  }
  if (Media.mpvMode) t.push(Media.displayTime());
  if (Array.isArray(extraSnapPoints)) {
    for (const p of extraSnapPoints) {
      if (typeof p === 'number' && Number.isFinite(p)) t.push(p);
      else if (typeof p?.time === 'number' && Number.isFinite(p.time)) t.push(p.time);
    }
  }
  return t;
}


export function snapVal(t, targets, thr) {
  let best = t, bd = thr;
  for (const x of targets) {
    const d = Math.abs(x - t);
    if (d < bd) {
      bd = d;
      best = x;
    }
  }
  return best;
}

export function cueNeighborBounds(os, oe, track, excludeIds) {
  let prevEnd = 0, nextStart = Infinity;
  const oMid = (os + oe) / 2;
  for (const c of State.cues) {
    if (c.timed === false || 
        (excludeIds && (excludeIds.has ? excludeIds.has(c.id) : excludeIds.includes(c.id))) || 
        (c.track || 0) !== track) {
      continue;
    }
    const cMid = (c.start + c.end) / 2;
    if (cMid < oMid) {
      if (c.end > prevEnd) prevEnd = c.end;
    } else {
      if (c.start < nextStart) nextStart = c.start;
    }
  }
  return { prevEnd, nextStart };
}
