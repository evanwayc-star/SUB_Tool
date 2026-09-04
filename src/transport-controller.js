/* ==============================================================================
   SUB Tool — 播放控制器與時鐘穿梭核心 (Transport Controller)
   ==============================================================================
   
   【架構與職責】
   深層模組：封裝播放狀態、JKL 穿梭速率計算、反向逐格定時器、
   時間軸微調 (Nudge)、邊界步進、字幕 In/Out 點設定與輸出範圍標記。
   
   對外提供小介面，完全隱藏定時器與跨領域同步細節。
   ============================================================================== */
import { $, video } from './dom.js';
import { State, deselect, focusTrackKind, cueSuffix } from './state.js';
import { fmtClock, secToEncore, snapTimeToFrame, getExactFps } from './time.js';
import { Media } from './media.js';
import { Seq } from './sequence.js';
import { selectCueSingle, commitCueTimeEdit } from './subtitles.js';
import { addCue, cueTrackLocked } from './subtitle-model.js';
import { ensureProjectSaved } from './project.js';
import { updatePlayhead, drawTimeline } from './timeline-renderer.js';
import { recordHistory } from './history.js';
import { updateNoteActive } from './notes.js';
import { emit, on } from './events.js';
import { setStatus, showOsd } from './ui.js';

/* 倒帶工作階段：集中管理方向、速率、取消、呈現節流與持續健康檢查。
   對外與 presentation port 一律使用時間軸時間；播放器來源時間只存在 Media 邊界內。 */
function createReverseShuttleSession({
  media,
  presentation,
  getExactFps,
  onPresented,
  onReachedStart,
  now = () => performance.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  nativeStallMs = 400,
  nativeStartupGraceMs = 1200,
  snapFrame,
} = {}) {
  let active = false;
  let mode = 'idle';
  let rate = 1;
  let generation = 0;
  let fallbackTimer = null;
  let healthTimer = null;
  let anchorTime = 0;
  let anchorWallTime = 0;
  let lastNativePresented = null;
  let lastNativeProgressAt = 0;
  let nativeProgressSeen = false;

  function exactFps() {
    return Math.max(1, Number(getExactFps?.()) || 30);
  }

  function normalizedRate(value) {
    return Math.min(5, Math.max(0.1, Math.abs(Number(value) || 1)));
  }

  function clearTimers() {
    if (fallbackTimer != null) clearIntervalFn(fallbackTimer);
    if (healthTimer != null) clearIntervalFn(healthTimer);
    fallbackTimer = null;
    healthTimer = null;
  }

  function latestPresentedTime({ allowDisplayFallback = true } = {}) {
    const rawObserved = presentation?.presentedTime?.();
    const observed = Number(rawObserved);
    if (rawObserved != null && rawObserved !== '' && Number.isFinite(observed)) return Math.max(0, observed);
    if (!allowDisplayFallback) return null;
    return Math.max(0, Number(media?.displayTime?.()) || 0);
  }

  function restoreForwardDirection() {
    return Promise.resolve(media?.setPlaybackDirection?.('forward')).catch(() => false);
  }

  function finishAtStart(token, presentedTime) {
    if (!active || token !== generation) return;
    onPresented?.(presentedTime);
    stop();
    onReachedStart?.();
  }

  function requestFallbackFrame(token) {
    if (!active || token !== generation || mode !== 'fallback') return;
    const fps = exactFps();
    const elapsedSeconds = Math.max(0, (now() - anchorWallTime) / 1000);
    const rawTarget = Math.max(0, anchorTime - elapsedSeconds * rate);
    // FPS-SYNC (I3): 依格網吸附，若提供 snapFrame 則使用其精確 frame metadata
    const targetTime = Math.max(0, typeof snapFrame === 'function' ? snapFrame(rawTarget) : (Math.round(rawTarget * fps) / fps));
    Promise.resolve(presentation.request(targetTime)).then(result => {
      if (!active || token !== generation || mode !== 'fallback') return;
      if (result?.status !== 'presented') return;
      const presentedTime = Number(result.presentedTime);
      if (!Number.isFinite(presentedTime)) return;
      if (presentedTime <= 0.5 / fps && targetTime === 0) {
        finishAtStart(token, Math.max(0, presentedTime));
        return;
      }
      onPresented?.(presentedTime);
    }).catch(() => {});
  }

  function beginFallback(token, { restoreDirection = false } = {}) {
    if (!active || token !== generation) return;
    if (healthTimer != null) clearIntervalFn(healthTimer);
    healthTimer = null;
    if (restoreDirection) {
      media?.pause?.();
      restoreForwardDirection();
    } else {
      media?.pause?.();
    }
    media?.setRate?.(1);
    media?.setReverseShuttleMuted?.(true);
    presentation?.cancel?.('reverse-fallback-start');
    mode = 'fallback';
    anchorTime = latestPresentedTime();
    anchorWallTime = now();
    const frameInterval = 1000 / Math.min(60, exactFps());
    fallbackTimer = setIntervalFn(() => requestFallbackFrame(token), frameInterval);
  }

  function monitorNative(token) {
    if (!active || token !== generation || mode !== 'native') return;
    const observed = latestPresentedTime({ allowDisplayFallback: false });
    const currentWallTime = now();
    const minimumProgress = 0.25 / exactFps();
    if (observed != null && (lastNativePresented == null || observed < lastNativePresented - minimumProgress)) {
      lastNativePresented = observed;
      lastNativeProgressAt = currentWallTime;
      nativeProgressSeen = true;
      if (observed <= 0.5 / exactFps()) finishAtStart(token, Math.max(0, observed));
      return;
    }
    const allowedStall = nativeProgressSeen ? nativeStallMs : nativeStartupGraceMs;
    if (currentWallTime - lastNativeProgressAt >= allowedStall) {
      beginFallback(token, { restoreDirection: true });
    }
  }

  async function start(nextRate = -1) {
    if (active) return update(nextRate);
    active = true;
    rate = normalizedRate(nextRate);
    const token = ++generation;
    mode = 'starting';
    clearTimers();
    presentation?.cancel?.('reverse-started');
    media?.setReverseShuttleMuted?.(true);
    media?.pause?.();

    if (!media?.supportsNativeReverse?.()) {
      beginFallback(token);
      return false;
    }

    mode = 'starting-native';
    let enabled = false;
    try {
      enabled = await media.setPlaybackDirection('backward');
    } catch (error) {
      enabled = false;
    }
    if (!active || token !== generation) {
      if (enabled !== false) await restoreForwardDirection();
      return false;
    }
    if (enabled === false) {
      beginFallback(token);
      return false;
    }

    mode = 'native';
    media.setRate?.(rate);
    media.play?.();
    lastNativePresented = latestPresentedTime();
    lastNativeProgressAt = now();
    nativeProgressSeen = false;
    healthTimer = setIntervalFn(() => monitorNative(token), 100);
    return true;
  }

  function update(nextRate) {
    if (!active) return start(nextRate);
    rate = normalizedRate(nextRate);
    if (mode === 'native') {
      media?.setRate?.(rate);
    } else if (mode === 'fallback') {
      presentation?.cancel?.('reverse-speed-changed');
      anchorTime = latestPresentedTime();
      anchorWallTime = now();
    }
    return Promise.resolve(mode === 'native');
  }

  let lastStopPromise = null;

  function stop() {
    if (!active && mode === 'idle') return false;
    const shouldRestoreDirection = mode === 'native' || mode === 'starting-native';
    active = false;
    generation += 1;
    clearTimers();
    presentation?.cancel?.('reverse-stopped');
    media?.pause?.();
    lastStopPromise = shouldRestoreDirection
      ? Promise.resolve(restoreForwardDirection()).catch(() => false)
      : Promise.resolve(true);
    media?.setRate?.(1);
    media?.setReverseShuttleMuted?.(false);
    mode = 'idle';
    return true;
  }

  function isActive() {
    return active || mode !== 'idle';
  }

  function stopPromise() {
    return lastStopPromise || Promise.resolve(true);
  }

  return { start, update, stop, isActive, stopPromise };
}

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
  snapFrame: t => snapTimeToFrame(t, State.fps, State.dropFrame),
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
    const wasReversing = _reverseSession.isActive?.() ?? false;
    jklClear();
    Media.setRate(_jklSpeed);
    if (!Media.playing) {
      if (wasReversing) {
        Promise.resolve(_reverseSession.stopPromise?.()).then(() => {
          if (_jklSpeed > 0 && !Media.playing) Media.play();
        }).catch(() => {
          if (_jklSpeed > 0 && !Media.playing) Media.play();
        });
      } else {
        Media.play();
      }
    }
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

let _lastRepeatDir = 0;
let _lastRepeatTime = 0;

function stepFrame(dir, repeat = false) {
  if (Media.playing || _jklSpeed !== 0) {
    jklClear();
    _jklSpeed = 0;
    if (Media.playing) Media.pause({ seekOnPause: false });
    setStatus('⏸ 暫停', '');
  }

  // 方向鍵長按 (repeat=true) 維持純粹的連續逐格步進，節流在 50ms（約 20fps），
  // 嚴禁切換成 JKL 倒帶/快轉穿梭，徹底消除誤轉倒播與放開按鍵時 loadfile 造成的劇烈抖動。
  if (repeat) {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (dir === _lastRepeatDir && now - _lastRepeatTime < 50) return;
    _lastRepeatDir = dir;
    _lastRepeatTime = now;
  } else {
    _lastRepeatDir = 0;
  }

  // FPS-SYNC (I5): 以目前權威呈現位置 displayTime() 的整數影格為基準加減整數格
  // 嚴禁從浮點相加微小殘差，徹底防止右鍵跳兩格或左鍵不動
  const exactFps = getExactFps(State.fps || 30);
  const currentT = Media.displayTime();
  const currentFrame = Math.round(currentT * exactFps);
  const targetFrame = Math.max(0, currentFrame + dir);
  const t = snapTimeToFrame(targetFrame / exactFps, State.fps, State.dropFrame);
  const frameDuration = 1 / exactFps;
  Media.seek(t, { presentationTolerance: 0.45 * frameDuration });
  updatePlayhead();
  emit('playhead:ensure');
  updateNoteActive(t);
  // 長按連續逐格（repeat=true）期間專注於畫面極速切換，不堆疊音訊切片；
  // 單次按鍵逐格（repeat=false）保留 0.08 秒短促 scrub 音訊反饋。
  if (!Media.playing && !repeat) {
    Media.scrubAudio(t, 0.08);
  }
}

/* ===== 播放頭微調 (Nudge) ================================================= */
function nudge(d) {
  if (Media.playing || _jklSpeed !== 0) {
    jklClear();
    _jklSpeed = 0;
    if (Media.playing) Media.pause({ seekOnPause: false });
    setStatus('⏸ 暫停', '');
  }
  // FPS-SYNC（詳見 FPS_時碼一致性.md）：以權威播放點為基準，並精確吸附至影格格網
  const exactFps = getExactFps(State.fps || 30);
  const currentT = Media.displayTime();
  const rawTarget = currentT + d;
  const t = snapTimeToFrame(rawTarget, State.fps, State.dropFrame);
  const frameDuration = 1 / exactFps;
  const frameDistance = Math.abs(t - currentT) * exactFps;
  const isSingleFrame = frameDistance > 0.5 && frameDistance <= 1.01;
  if (isSingleFrame) {
    // 單格微調的上一格距目標只有一格；一般 seek 的 1.5 格完成容差會讓 mpv
    // 偶爾把舊畫格誤判成新目標。縮到半格內，必須真的跨到目標格才算完成。
    Media.seek(t, { presentationTolerance: 0.45 * frameDuration });
  } else {
    Media.seek(t);
  }
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
    dropFrame: State.dropFrame,
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

/**
 * 設定字幕起點（In 點）或於當前播放點新建字幕。
 * 
 * 【時間碼精確度保證】
 * 在函式進入點第一時間同步凍結按鍵當下的 Media.displayTime()，
 * 徹底杜絕任何 ensureProjectSaved() 非同步微任務或彈窗延遲所造成的時碼漂移。
 */
async function setIn() {
  const capturedTime = Media.displayTime();
  await ensureProjectSaved();
  if (State.selectedIds.length > 1) { setStatus('多選模式 — 請用 P 鍵整體位移', 'err'); return; }
  let t = snapTimeToFrame(capturedTime, State.fps, State.dropFrame);
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

/**
 * 設定字幕終點（Out 點）。
 * 
 * 【時間碼精確度保證】
 * 同步捕獲按鍵當下的 Media.displayTime()，杜絕邊播邊聽打點時的非同步微任務時間漂移。
 */
async function setOut() {
  const capturedTime = Media.displayTime();
  await ensureProjectSaved();
  if (State.selectedIds.length > 1) { setStatus('多選模式 — 請用 P 鍵整體位移', 'err'); return; }
  let t = snapTimeToFrame(capturedTime, State.fps, State.dropFrame);
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

function setExportIn() {
  State.exportIn = snapTimeToFrame(Media.displayTime(), State.fps, State.dropFrame);
  drawTimeline();
  recordHistory('設定輸出起點 [In]');
  setStatus(`輸出起點已設為 ${fmtClock(State.exportIn)}`, 'ok');
}

function setExportOut() {
  State.exportOut = snapTimeToFrame(Media.displayTime(), State.fps, State.dropFrame);
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
  createReverseShuttleSession,
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
  autoAdvanceSubMode,
  setExportIn,
  setExportOut,
  clearExport,
};

/* ==============================================================================
   時間軸導航計算純函式 (Timeline Navigation Logic)
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

export function getCueInMinusFrames({ cues, selectedId, listTrack, currentTime, fps, dropFrame = false, dir, frames }) {
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

  // FPS-SYNC (I3): 以精確 FPS 計算倒退秒數並吸附至影格格網
  const exactFps = getExactFps(fps || 30);
  const rawTarget = Math.max(0, target.start - (frames / exactFps));
  const targetTime = snapTimeToFrame(rawTarget, fps || 30, dropFrame || false);
  return { targetCue: target, targetTime };
}

export function getBoundaryStep({ cues, selectedId, listTrack, currentTime, dir, eps = 0.05 }) {
  const timed = cues.filter(c => c.timed !== false && (c.track || 0) === listTrack);
  if (!timed.length) return null;

  const selIdx = timed.findIndex(c => c.id === selectedId);
  let c = selIdx >= 0 ? timed[selIdx] : null;
  let cIdx = selIdx;

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
