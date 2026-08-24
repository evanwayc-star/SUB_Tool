/* ==============================================================================
   SUB Tool — 媒體預覽與主時鐘核心引擎 ("src/media-presentation-core.js")
   ==============================================================================
   【架構與職責】
   純領域計算深層模組：統籌 Master Playback Clock 主時鐘計算、逐格步進
   (Step Frame)、音畫時鐘漂移量測 (Drift Measurement) 與多後端播放狀態協調，
   嚴格恪守 docs/FPS_時碼一致性.md 規範。
   ============================================================================== */

/**
 * 依據專案精確 FPS 計算指定時間（秒）對應的絕對影格序號 (Frame Index)。
 * 
 * @param {number} timeSec 時間（秒）
 * @param {number} fps 影格率 (例如 23.976, 24, 25, 29.97, 30, 60)
 * @returns {number} 影格序號（從 0 開始）
 */
export function timeToFrameIndex(timeSec, fps = 30) {
  const t = Math.max(0, Number(timeSec) || 0);
  const f = Math.max(1, Number(fps) || 30);
  return Math.round(t * f);
}

/**
 * 依據絕對影格序號換算精確時間（秒）。
 * 
 * @param {number} frameIndex 影格序號
 * @param {number} fps 影格率
 * @returns {number} 時間（秒）
 */
export function frameIndexToTime(frameIndex, fps = 30) {
  const idx = Math.max(0, Number(frameIndex) || 0);
  const f = Math.max(1, Number(fps) || 30);
  return idx / f;
}

/**
 * 計算逐格前後移動後的新時間碼點。
 * 
 * @param {number} currentTime 當前時間（秒）
 * @param {number} stepFrames 步進影格數（例如 +1, -1, +5, -5）
 * @param {number} fps 影格率
 * @param {number} [duration=Infinity] 媒體總長度上限
 * @returns {number} 步進後的時間點（秒）
 */
export function stepFrameTime(currentTime, stepFrames, fps = 30, duration = Infinity) {
  const curIdx = timeToFrameIndex(currentTime, fps);
  const targetIdx = Math.max(0, curIdx + (Number(stepFrames) || 0));
  const targetTime = frameIndexToTime(targetIdx, fps);
  return Math.min(duration > 0 ? duration : Infinity, targetTime);
}

/**
 * 量測視訊呈現時間與音訊時鐘之間的漂移量 (Drift)。
 * 
 * @param {number} videoTime 視訊當前呈現時間點（秒）
 * @param {number} audioTime 音訊基準時間點（秒）
 * @param {number} [driftTolerance=0.04] 允許之最大漂移容差（秒，約 1 格）
 * @returns {{drift: number, outOfSync: boolean, needsHardSeek: boolean}} 漂移診斷
 */
export function measureClockDrift(videoTime, audioTime, driftTolerance = 0.04) {
  const vt = Number(videoTime) || 0;
  const at = Number(audioTime) || 0;
  const drift = vt - at;
  const absDrift = Math.abs(drift);

  return {
    drift: Number(drift.toFixed(4)),
    outOfSync: absDrift > driftTolerance,
    needsHardSeek: absDrift > 0.3, // 漂移超過 300ms 必須強制 Hard Seek
  };
}

/**
 * 建立主時鐘控制器 (Master Playback Clock Controller)。
 * 
 * @param {object} [initialState]
 * @param {number} [initialState.time=0] 初始時間
 * @param {number} [initialState.speed=1.0] 初始播放速度
 * @param {number} [initialState.fps=30] 影格率
 * @returns {object} 主時鐘控制器實例
 */
export function createMasterClock({
  time = 0,
  speed = 1.0,
  fps = 30,
} = {}) {
  let _time = Math.max(0, Number(time) || 0);
  let _speed = Number(speed) || 1.0;
  let _fps = Number(fps) || 30;
  let _isPlaying = false;
  let _lastWallTime = null;

  return {
    getTime() { return _time; },
    setTime(t) {
      _time = Math.max(0, Number(t) || 0);
      _lastWallTime = performance.now();
      return _time;
    },
    getSpeed() { return _speed; },
    setSpeed(s) {
      _speed = Math.max(0.1, Math.min(16, Number(s) || 1.0));
      return _speed;
    },
    getFps() { return _fps; },
    setFps(f) {
      _fps = Math.max(1, Number(f) || 30);
      return _fps;
    },
    isPlaying() { return _isPlaying; },
    play() {
      _isPlaying = true;
      _lastWallTime = performance.now();
    },
    pause() {
      _isPlaying = false;
      _lastWallTime = null;
    },
    tick(nowWallTime = performance.now()) {
      if (!_isPlaying || _lastWallTime == null) return _time;
      const deltaSec = (nowWallTime - _lastWallTime) / 1000;
      _time += deltaSec * _speed;
      _lastWallTime = nowWallTime;
      return _time;
    },
    step(frameDelta) {
      _time = stepFrameTime(_time, frameDelta, _fps);
      _lastWallTime = performance.now();
      return _time;
    },
  };
}
