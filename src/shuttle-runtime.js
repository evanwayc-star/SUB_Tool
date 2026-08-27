/* 倒帶 shuttle 的可取消執行狀態。時間一律是時間軸時間。 */
export function createShuttleRuntime({
  media,
  getExactFps,
  onFallbackFrame,
  onReachedStart,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  let speed = 0;
  let fallbackTimer = null;
  let nativeStallTimer = null;
  let nativeReverse = false;
  let epoch = 0;

  function clear() {
    if (fallbackTimer) { clearIntervalFn(fallbackTimer); fallbackTimer = null; }
    if (nativeStallTimer) { clearTimeoutFn(nativeStallTimer); nativeStallTimer = null; }
  }

  function beginEpoch() { epoch += 1; return epoch; }
  function getSpeed() { return speed; }
  function setSpeed(next) { speed = next; }
  function isNativeReverse() { return nativeReverse; }
  function setNativeReverse(active) { nativeReverse = !!active; }

  function leaveNativeReverse() {
    if (!nativeReverse) return false;
    nativeReverse = false;
    media.pause();
    Promise.resolve(media.setPlaybackDirection?.('forward')).catch(() => {});
    return true;
  }

  function startReverseSeekFallback(capturedSpeed) {
    media.pause();
    media.setRate(1);
    const fps = 30;
    const step = Math.abs(capturedSpeed) / fps;
    fallbackTimer = setIntervalFn(() => {
      if (speed !== capturedSpeed) { clear(); return; }
      const time = media.displayTime();
      if (time <= 0) {
        clear();
        speed = 0;
        onReachedStart?.();
        return;
      }
      const nextTime = Math.max(0, time - step);
      media.seek(nextTime);
      onFallbackFrame?.(nextTime, step);
      media.scrubAudio(nextTime, Math.max(step, 0.08));
    }, 1000 / fps);
  }

  function watchNativeReverseProgress(capturedSpeed, capturedEpoch, onStall) {
    const initialTime = media.displayTime();
    const minimumProgress = 0.25 / getExactFps();
    nativeStallTimer = setTimeoutFn(() => {
      nativeStallTimer = null;
      if (capturedEpoch !== epoch || speed !== capturedSpeed || !nativeReverse) return;
      if (media.displayTime() < initialTime - minimumProgress) return;
      nativeReverse = false;
      media.pause();
      onStall?.();
    }, 400);
  }

  return {
    clear, beginEpoch, getSpeed, setSpeed, isNativeReverse, setNativeReverse,
    leaveNativeReverse, startReverseSeekFallback, watchNativeReverseProgress,
  };
}
