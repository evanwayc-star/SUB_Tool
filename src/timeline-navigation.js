/* ==============================================================================
   SUB Tool — 時間軸導航邏輯 (Timeline Navigation)
   ==============================================================================
   純數學與狀態推導模組。
   職責：根據當前的時間、選取狀態與方向，算出「下一個該跳往的時間或字幕」。
   鐵律：
   1. 零 DOM 操作、零全域狀態突變 (mutation)。
   2. 必須是 Pure Functions，以利完全獨立於播放器與 UI 進行測試。
============================================================================== */

export function getNoteJump({ notes, currentTime, dir }) {
  if (!notes || !notes.length) return null;
  const EPS = 1e-4;
  let target = null;
  if (dir > 0) {
    for (const n of notes) {
      if (n.time > currentTime + EPS && (target === null || n.time < target.time)) {
        target = n;
      }
    }
  } else {
    for (const n of notes) {
      if (n.time < currentTime - EPS && (target === null || n.time > target.time)) {
        target = n;
      }
    }
  }
  return target ? target.time : null;
}

export function getFirstLastCue({ cues, listTrack, dir }) {
  const list = cues.filter(c => (c.track || 0) === listTrack && c.timed !== false);
  if (!list.length) return null;
  return dir < 0 ? list[0] : list[list.length - 1];
}

export function getAdjacentCue({ cues, selectedId, listTrack, activeSubTrack, currentTime, isPlaying, dir }) {
  const sel = cues.find(c => c.id === selectedId);
  const track = sel ? (sel.track || 0) : (activeSubTrack !== undefined ? activeSubTrack : listTrack);
  const list = cues.filter(c => (c.track || 0) === track);
  if (!list.length) return null;

  let idx;
  if (sel) {
    idx = list.findIndex(c => c.id === sel.id) + dir;
  } else {
    if (dir < 0) {
      idx = list.filter(c => c.start < currentTime - 1e-4).length - 1;
      if (isPlaying) idx -= 1;
    } else {
      idx = list.findIndex(c => c.start > currentTime + 1e-4);
    }
  }

  idx = Math.max(0, Math.min(list.length - 1, idx));
  return list[idx] || null;
}

export function getCueInMinusFrames({ cues, selectedId, listTrack, currentTime, fps, dir, frames }) {
  const sel = cues.find(c => c.id === selectedId);
  const track = sel ? (sel.track || 0) : listTrack;
  const list = cues.filter(c => (c.track || 0) === track);
  if (!list.length) return null;

  let idx;
  if (sel) {
    idx = list.findIndex(c => c.id === sel.id) + dir;
  } else {
    if (dir < 0) {
      idx = list.filter(c => c.start < currentTime - 1e-4).length - 1;
    } else {
      idx = list.findIndex(c => c.start > currentTime + 1e-4);
    }
  }

  idx = Math.max(0, Math.min(list.length - 1, idx));
  const target = list[idx];
  if (!target) return null;

  const targetTime = Math.max(0, target.start - (frames / fps));
  return { targetCue: target, targetTime };
}

export function getBoundaryStep({ cues, selectedId, listTrack, currentTime, dir, eps = 0.05 }) {
  const timed = cues.filter(c => c.timed !== false && (c.track || 0) === listTrack);
  if (!timed.length) return null;

  const selIdx = timed.findIndex(c => c.id === selectedId);
  let c = selIdx >= 0 ? timed[selIdx] : null;
  let cIdx = selIdx;

  // 如果播放點已經不在被選取的字幕範圍內（包含邊界寬容度），代表被手動拖走了，改依時間尋找
  if (c && (currentTime < c.start - eps || currentTime > c.end + eps)) {
    c = null;
    cIdx = -1;
  }

  let targetId = null;
  let targetEdge = 'start';
  let targetTime = 0;

  if (dir > 0) {
    if (!c) {
      const bnd = [];
      for (const cue of timed) {
        bnd.push({ id: cue.id, edge: 'start', t: cue.start });
        bnd.push({ id: cue.id, edge: 'end', t: cue.end });
      }
      bnd.sort((a, b) => a.t - b.t);
      const nextBnd = bnd.find(b => b.t > currentTime + eps);
      if (nextBnd) { targetId = nextBnd.id; targetEdge = nextBnd.edge; targetTime = nextBnd.t; }
    } else {
      if (currentTime < c.start - eps) {
        targetId = c.id; targetEdge = 'start'; targetTime = c.start;
      } else if (currentTime < c.end - eps) {
        targetId = c.id; targetEdge = 'end'; targetTime = c.end;
      } else {
        if (cIdx < timed.length - 1) {
          const next = timed[cIdx + 1];
          targetId = next.id; targetEdge = 'start'; targetTime = next.start;
        } else {
          return null;
        }
      }
    }
  } else {
    if (!c) {
      const bnd = [];
      for (const cue of timed) {
        bnd.push({ id: cue.id, edge: 'start', t: cue.start });
        bnd.push({ id: cue.id, edge: 'end', t: cue.end });
      }
      bnd.sort((a, b) => a.t - b.t);
      let prevBnd = null;
      for (let i = bnd.length - 1; i >= 0; i--) {
        if (bnd[i].t < currentTime - eps) { prevBnd = bnd[i]; break; }
      }
      if (prevBnd) { targetId = prevBnd.id; targetEdge = prevBnd.edge; targetTime = prevBnd.t; }
    } else {
      if (currentTime > c.end + eps) {
        targetId = c.id; targetEdge = 'end'; targetTime = c.end;
      } else if (currentTime > c.start + eps) {
        targetId = c.id; targetEdge = 'start'; targetTime = c.start;
      } else {
        if (cIdx > 0) {
          const prev = timed[cIdx - 1];
          targetId = prev.id; targetEdge = 'end'; targetTime = prev.end;
        } else {
          return null;
        }
      }
    }
  }

  if (targetId) {
    return { targetId, targetEdge, targetTime };
  }
  return null;
}
