/* ==============================================================================
   SUB Tool — 播放控制器與時鐘穿梭核心 (Transport Controller)
   ==============================================================================
   
   【架構與職責】
   深層模組：封裝播放狀態、JKL 穿梭速率計算、反向逐格定時器、
   時間軸微調 (Nudge)、邊界步進、字幕 In/Out 點設定與輸出範圍標記。
   
   對外提供小介面，完全隱藏定時器與跨領域同步細節。
   ============================================================================== */
import { $, video } from './dom.js';
import { State, cueSuffix, deselect, focusTrackKind } from './state.js';
import { fmtClock, secToEncore, snapTimeToFrame, getExactFps } from './time.js';
import { Media } from './media.js';
import { Seq } from './sequence.js';
import { selectCueSingle, commitCueTimeEdit } from './subtitles.js';
import { addCue, cueTrackLocked, sortCues } from './subtitle-model.js';
import { updatePlayhead, drawTimeline } from './timeline.js';
import { ensureProjectSaved } from './project.js';
import { recordHistory } from './history.js';
import { updateNoteActive } from './notes.js';
import { emit, on } from './events.js';
import { setStatus, showOsd } from './ui.js';
import { getNoteJump, getFirstLastCue, getAdjacentCue, getCueInMinusFrames, getBoundaryStep } from './timeline-navigation.js';
import { createReverseShuttleSession } from './shuttle-runtime.js';

/* ===== JKL 穿梭輪狀態與定時器 ============================================== */
let _jklSpeed = 0;

const _reverseSession = createReverseShuttleSession({
  media: Media,
  presentation: {
    request: targetTime => Media.requestPresentation(targetTime),
    cancel: reason => Media.cancelPresentation(reason),
    presentedTime: () => Media.presentedTime(),
  },
  getExactFps: () => getExactFps(State.fps || 30),
  onPresented() {
    updatePlayhead();
    emit('playhead:ensure');
    emit('render:videoSub');
    if (!video.src) {
      const displayT = Media.displayTime();
      const tc = $('tcCur'); if (tc) tc.textContent = secToEncore(displayT, State.fps, State.dropFrame);
      const sb = $('seekBar'); if (sb) sb.value = Math.round(displayT * 1000);
    }
  },
  onReachedStart() {
    _jklSpeed = 0;
    setStatus('已到開頭', '');
    updateSpeedIndicator();
  },
});

function jklClear() {
  return _reverseSession.stop();
}

function updateSpeedIndicator() {
  const el = document.getElementById('speedIndicator');
  if (!el) return;
  if (_jklSpeed === 0 || _jklSpeed === 1) {
    const rate = Math.round((video.playbackRate || 1) * 100) / 100;
    el.textContent = rate + 'x';
    el.style.color = Math.abs(rate - 1) < 0.001 ? 'var(--text-faint)' : 'var(--accent)';
  } else if (_jklSpeed < 0) {
    el.textContent = _jklSpeed + 'x';
    el.style.color = '#ff4444';
  } else {
    el.textContent = _jklSpeed + 'x';
    el.style.color = '#44ff44';
  }
}

function getJklSpeed() {
  return _jklSpeed;
}

function setJklSpeed(speed) {
  _jklSpeed = speed;
}

function resetPlaybackSpeed() {
  jklClear();
  _jklSpeed = 0;
  Media.setRate(1);
  updateSpeedIndicator();
}

function jklReset() {
  resetPlaybackSpeed();
}

// 方向鍵長按是暫時性的逐格 shuttle，不同於 J/K 的持續穿梭：實體按鍵放開時
// 必須停在目前畫格。只在它真的已啟動時才暫停，避免單次逐格的 keyup 影響播放狀態。
function stopFrameShuttle() {
  if (_jklSpeed === 0) return false;
  _jklSpeed = 0;
  jklApply();
  return true;
}

/* 「跳轉暫停」只在互動發生當下停止已在運作的 transport。
   反向 seek fallback 期間 Media.playing=false，但 _jklSpeed 仍非 0，
   所以不能只看 Media.playing，否則計時器會在滑鼠定位後繼續往回拉。 */
function pauseForPointerSeek() {
  if (!Media.playing && _jklSpeed === 0) return false;
  resetPlaybackSpeed();
  if (Media.playing) Media.pause();
  return true;
}

on('transport:pointerSeekPause', pauseForPointerSeek);


function setManualPlaybackSpeed(rate) {
  jklClear();
  _jklSpeed = 0;
  Media.setRate(rate);
  updateSpeedIndicator();
}

function jklApply() {
  if (_jklSpeed === 0) {
    if (!jklClear()) Media.pause();
    Media.setRate(1);
  } else if (_jklSpeed > 0) {
    jklClear();
    Media.setRate(_jklSpeed);
    if (!Media.playing) Media.play();
  } else {
    _reverseSession.start(_jklSpeed).catch(() => {});
  }
  const spd = Math.abs(_jklSpeed);
  const label = _jklSpeed === 0 ? '暫停' : (_jklSpeed > 0 ? `▶ ${spd}x 正播` : `◀ ${spd}x 倒帶`);
  const osd = _jklSpeed === 0 ? '⏸' : (_jklSpeed > 0 ? `▶ ${spd}×` : `◀ ${spd}×`);
  setStatus(label, _jklSpeed !== 0 ? 'ok' : '');
  showOsd(osd);
  updateSpeedIndicator();
}

function shuttleRewind() {
  if (_jklSpeed >= 0) _jklSpeed = -1;
  else _jklSpeed = Math.max(-5, _jklSpeed - 0.5);
  jklApply();
}

function shuttlePause() {
  _jklSpeed = 0;
  jklApply();
}

function shuttleForward() {
  if (_jklSpeed <= 0) _jklSpeed = 1;
  else _jklSpeed = Math.min(5, _jklSpeed + 0.5);
  jklApply();
}

function togglePlayPause() {
  const wasPlaying = Media.playing;
  const wasShuttling = _jklSpeed !== 0;
  resetPlaybackSpeed();
  // 原生倒播的 reset 會先暫停並恢復 forward；此時不能再 toggle 一次，否則
  // 空白鍵會從「倒播」意外變成「立刻正播」。
  if (wasPlaying || wasShuttling) {
    if (Media.playing) Media.pause();
  } else {
    Media.play();
  }
  setStatus(Media.playing ? '▶ 正播' : '⏸ 暫停', Media.playing ? 'ok' : '');
}

function stepFrame(dir, repeat = false) {
  // OS auto-repeat 只是「仍按住」的通知；同方向的 shuttle 已在跑時不可每次都
  // 暫停再播放，否則 mpv/HTML 都會產生可見卡頓。
  if (repeat && _jklSpeed === dir) return;
  if (Media.playing || _jklSpeed !== 0) {
    jklClear();
    _jklSpeed = 0;
    if (Media.playing) Media.pause();
    setStatus('⏸ 暫停', '');
  }
  if (repeat) {
    if (dir < 0 && _jklSpeed >= 0) { _jklSpeed = -1; jklApply(); }
    else if (dir > 0 && _jklSpeed <= 0) { _jklSpeed = 1; jklApply(); }
  } else {
    nudge(dir / getExactFps(State.fps || 30));
  }
}

/* ===== 播放頭微調 (Nudge) ================================================= */
function nudge(d) {
  if (Media.playing || _jklSpeed !== 0) {
    jklClear();
    _jklSpeed = 0;
    if (Media.playing) Media.pause();
    setStatus('⏸ 暫停', '');
  }
  // FPS-SYNC（詳見 FPS_時碼一致性.md）：以權威播放點為基準，並精確吸附至影格格網
  const currentT = Media.displayTime();
  const rawTarget = currentT + d;
  const t = snapTimeToFrame(rawTarget, State.fps, State.dropFrame);
  Media.seek(t);
  updatePlayhead();
  emit('playhead:ensure');
  updateNoteActive(t);
  if (!Media.playing && Math.abs(d) < 0.2) {
    Media.scrubAudio(t, 0.08);
  }
}

function seekHome() {
  Media.seek(0);
  updatePlayhead();
  emit('playhead:ensure');
  updateNoteActive(0);
}

function seekEnd() {
  const t = State.duration || 0;
  Media.seek(t);
  updatePlayhead();
  emit('playhead:ensure');
  updateNoteActive(t);
}

/* ===== 備註與字幕跳轉 ===================================================== */
function jumpToNote(dir) {
  const targetTime = getNoteJump({ notes: State.notes, currentTime: Media.displayTime(), dir });
  if (targetTime === null) return;
  Media.seek(targetTime);
  updatePlayhead();
  emit('playhead:ensure');
  updateNoteActive(targetTime);
}

function jumpToFirstLastCue(dir) {
  const target = getFirstLastCue({ cues: State.cues, listTrack: State.listTrack, dir });
  if (!target) return;
  selectCueSingle(target.id, false);
  Media.seek(target.start);
  updatePlayhead();
  emit('playhead:ensure');
}

function jumpToAdjacentCue(dir) {
  const target = getAdjacentCue({
    cues: State.cues,
    selectedId: State.selectedId,
    listTrack: State.listTrack,
    activeSubTrack: State.activeSubTrack,
    currentTime: Media.displayTime(),
    isPlaying: Media.playing,
    dir,
  });
  if (!target) return;
  if (Media.playing) {
    deselect('sub');
    emit('render:selection');
    const stSel = document.getElementById('stSel');
    if (stSel) stSel.textContent = '';
  } else {
    selectCueSingle(target.id, false);
  }
  Media.seek(target.start);
  updatePlayhead();
  emit('playhead:ensure');
}

function jumpToCueInMinusFrames(dir, frames) {
  const result = getCueInMinusFrames({
    cues: State.cues,
    selectedId: State.selectedId,
    listTrack: State.listTrack,
    currentTime: Media.displayTime(),
    fps: State.fps,
    dir,
    frames,
  });
  if (!result) return;
  selectCueSingle(result.targetCue.id, false);
  Media.seek(result.targetTime);
  updatePlayhead();
  emit('playhead:ensure');
}

function stepBoundary(dir) {
  focusTrackKind('sub');
  const result = getBoundaryStep({
    cues: State.cues,
    selectedId: State.selectedId,
    listTrack: State.listTrack,
    currentTime: Media.displayTime(),
    dir,
    eps: 0.05,
  });

  if (result) {
    selectCueSingle(result.targetId);
    State.activeEdge = result.targetEdge;
    Media.seek(result.targetTime);
    emit('playhead:ensure');
    updatePlayhead();
  }
}

/* ===== 媒體片段邊界步進 =================================================== */
const MEDIA_BOUNDARY_EPS = 0.05;

function finiteTimelineTime(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : fallback;
}

function externalPlacementBoundaries(asset) {
  if (!asset || asset.timelineVisible === false) return [];
  const placements = Array.isArray(asset.placements) && asset.placements.length ? asset.placements : [asset];
  const points = [];
  for (const placement of placements) {
    if (!placement || placement.timelineVisible === false) continue;
    const start = finiteTimelineTime(placement.offset ?? asset.offset);
    const inPoint = finiteTimelineTime(placement.in ?? asset.in);
    const duration = finiteTimelineTime(placement.duration ?? asset.duration);
    const rawOut = Number(placement.out ?? asset.out);
    const outPoint = Number.isFinite(rawOut) && rawOut >= inPoint ? rawOut : duration;
    const end = start + Math.max(0, outPoint - inPoint);
    points.push(start);
    if (end > start + MEDIA_BOUNDARY_EPS) points.push(end);
  }
  return points;
}

function mediaBoundaryPoints() {
  const points = [];
  
  const onlyVideo = State.activeTrackKind === 'video';
  const vtrackIdx = onlyVideo ? (State.selectedClipId ? (Seq.byId(State.selectedClipId)?.vtrack || 0) : State.activeVtrack) : null;

  const onlyAudio = State.activeTrackKind === 'audio';
  const selectedAudioId = onlyAudio ? (State.selectedAudioClipId || State.activeAudioTrackId) : null;

  const onlySub = State.activeTrackKind === 'sub';
  const subTrackIdx = onlySub ? State.listTrack : null;

  if (onlySub) {
    for (const cue of State.cues) {
      if ((cue.track || 0) !== subTrackIdx) continue;
      if (cue.timed === false) continue;
      points.push(cue.start);
      points.push(cue.end);
    }
  } else {
    for (const clip of State.clips) {
      if (!clip || clip.timelineVisible === false) continue;
      if (onlyVideo && vtrackIdx != null && (clip.vtrack || 0) !== vtrackIdx) continue;
      if (onlyAudio) {
        if (clip.type === 'image' || clip.audioDetached) continue;
        const srcId = clip.audioSourceId || clip.audioSrc || (clip.primary ? 'video' : ('clip:' + clip.id));
        if (selectedAudioId != null && srcId !== selectedAudioId) continue;
      }
      const start = finiteTimelineTime(clip.offset);
      const end = Number(Seq.clipEnd(clip));
      points.push(start);
      if (Number.isFinite(end) && end > start + MEDIA_BOUNDARY_EPS) points.push(end);
    }
    
    for (const asset of (Media.externalAudio?.list?.() || [])) {
      if (onlyVideo) continue;
      if (onlyAudio && selectedAudioId != null && asset.id !== selectedAudioId && asset.audioSourceId !== selectedAudioId && asset.audioSrc !== selectedAudioId) continue;
      points.push(...externalPlacementBoundaries(asset));
    }
  }

  points.sort((a, b) => a - b);
  return points.reduce((unique, point) => {
    if (!Number.isFinite(point)) return unique;
    if (!unique.length || Math.abs(point - unique[unique.length - 1]) > MEDIA_BOUNDARY_EPS) unique.push(point);
    return unique;
  }, []);
}

function stepMediaBoundary(dir) {
  const points = mediaBoundaryPoints();
  if (!points.length) return false;
  const current = Media.displayTime();
  const target = dir > 0
    ? points.find(point => point > current + MEDIA_BOUNDARY_EPS)
    : [...points].reverse().find(point => point < current - MEDIA_BOUNDARY_EPS);
  if (target == null) return false;
  Media.seek(target);
  updatePlayhead();
  emit('playhead:ensure');
  updateNoteActive(target);
  emit('render:videoSub');
  return true;
}

/* ===== 字幕 I/O 上字幕控制 ================================================ */
async function setIn() {
  await ensureProjectSaved();
  if (State.selectedIds.length > 1) { setStatus('多選模式 — 請用 P 鍵整體位移', 'err'); return; }
  let t = snapTimeToFrame(Media.displayTime(), State.fps, State.dropFrame);
  let c = State.cues.find(x => x.id === State.selectedId);
  if (!c) {
    const tk = State.tracks.length === 0 ? 0 : Math.min(State.tracks.length - 1, Math.max(0, State.listTrack));
    c = addCue(t, snapTimeToFrame(t + 2, State.fps, State.dropFrame), '', tk, { historyLabel: '新增字幕(I)' });
    if (!c) return;
    setStatus('已新增字幕，起點 ' + fmtClock(t), 'ok');
    return;
  }
  if (cueTrackLocked(c, '調整字幕起點')) return;
  const wasUntimed = c.timed === false;
  c.start = t;
  if (State.subMode) {
    State.cues.forEach(cue => {
      if (cue._tempEnd && cue.id !== c.id) {
        cue.end = Math.min(cue.start + 2.0, (State.duration || Infinity));
        delete cue._tempEnd;
      }
    });
    c.end = (State.duration && State.duration > c.start) ? State.duration : c.start + 3600;
    c._tempEnd = true;
    if (!State._subModeTouchedIds) State._subModeTouchedIds = new Set();
    State._subModeTouchedIds.add(c.id);
  } else if (wasUntimed || c.end <= c.start) {
    c.end = snapTimeToFrame(c.start + 0.5, State.fps, State.dropFrame);
  }
  c.timed = true;
  commitCueTimeEdit(c, 'start');
  recordHistory('設定起點 I' + cueSuffix(c)); setStatus('起點 ' + fmtClock(t), 'ok');
}

async function setOut() {
  await ensureProjectSaved();
  if (State.selectedIds.length > 1) { setStatus('多選模式 — 請用 P 鍵整體位移', 'err'); return; }
  let t = snapTimeToFrame(Media.displayTime(), State.fps, State.dropFrame);
  const c = State.cues.find(x => x.id === State.selectedId);
  if (!c) { setStatus('請先選擇字幕（或按 I 新建）', 'err'); return; }
  if (cueTrackLocked(c, '調整字幕終點')) return;

  const wasUntimed = c.timed === false;
  if (wasUntimed) {
    c.end = t;
    c.start = snapTimeToFrame(Math.max(0, t - 0.5), State.fps, State.dropFrame);
  } else {
    if (t <= c.start) { setStatus('終點不得早於或等於起點', 'err'); return; }
    c.end = t;
  }

  c.timed = true;
  delete c._tempEnd;
  commitCueTimeEdit(c, 'end');
  recordHistory('設定終點 O' + cueSuffix(c)); setStatus('終點 ' + fmtClock(c.end), 'ok');
  autoAdvanceSubMode();
}

function autoAdvanceSubMode() {
  if (!State.subMode || !State._subModeSequence) return;

  const seq = State._subModeSequence;
  const currIdx = seq.indexOf(State.selectedId);

  if (currIdx >= 0) {
    let nextIdx = currIdx + 1;
    while (nextIdx < seq.length) {
      const nextId = seq[nextIdx];
      const nextCue = State.cues.find(c => c.id === nextId);
      const currCue = State.cues.find(c => c.id === State.selectedId);
      if (nextCue && currCue && (nextCue.track || 0) === (currCue.track || 0)) {
        selectCueSingle(nextId, false);
        setStatus(`🎯 上字幕 (依原順序) — 按 I 設起點`, 'ok');
        return;
      }
      nextIdx++;
    }
  }

  selectCueSingle(null);
  setStatus('🎯 上字幕模式：已無下一句，取消選取 ✓', 'ok');
}

/* ===== 輸出範圍標記 ======================================================== */
function setExportIn() {
  State.exportIn = Media.displayTime();
  drawTimeline();
  recordHistory('設定輸出起點 [In]');
  setStatus(`輸出起點已設為 ${fmtClock(State.exportIn)}`, 'ok');
}

function setExportOut() {
  State.exportOut = Media.displayTime();
  drawTimeline();
  recordHistory('設定輸出終點 [Out]');
  setStatus(`輸出終點已設為 ${fmtClock(State.exportOut)}`, 'ok');
}

function clearExport() {
  State.exportIn = null;
  State.exportOut = null;
  drawTimeline();
  recordHistory('清除輸出範圍');
  setStatus('輸出範圍已清除', 'ok');
}

export {
  jklClear,
  jklApply,
  jklReset,
  stopFrameShuttle,
  getJklSpeed,
  setJklSpeed,
  shuttleRewind,
  shuttlePause,
  shuttleForward,
  togglePlayPause,
  stepFrame,
  resetPlaybackSpeed,
  setManualPlaybackSpeed,
  updateSpeedIndicator,
  nudge,
  seekHome,
  seekEnd,
  jumpToNote,
  jumpToFirstLastCue,
  jumpToAdjacentCue,
  jumpToCueInMinusFrames,
  stepBoundary,
  stepMediaBoundary,
  setIn,
  setOut,
  setExportIn,
  setExportOut,
  clearExport,
};
