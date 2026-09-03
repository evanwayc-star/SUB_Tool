/* 倒帶工作階段：集中管理方向、速率、取消、呈現節流與持續健康檢查。
   對外與 presentation port 一律使用時間軸時間；播放器來源時間只存在 Media 邊界內。 */
export function createReverseShuttleSession({
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

  function stop() {
    if (!active && mode === 'idle') return false;
    const shouldRestoreDirection = mode === 'native' || mode === 'starting-native';
    active = false;
    generation += 1;
    clearTimers();
    presentation?.cancel?.('reverse-stopped');
    media?.pause?.();
    if (shouldRestoreDirection) restoreForwardDirection();
    media?.setRate?.(1);
    media?.setReverseShuttleMuted?.(false);
    mode = 'idle';
    return true;
  }

  return { start, update, stop };
}
