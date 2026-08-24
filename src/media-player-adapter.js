// media-player-adapter.js
// NativePreviewRuntime 是 renderer 的單一預覽 owner；HTML5／mpv transport adapters
// 留在模組內部，OS 視窗、guide 與 bounds 不會因 active transport 改變而掉進 no-op。

class Html5Transport {
  constructor(video) { this.video = video; }
  get type() { return 'html5'; }
  async play() {
    const result = this.video?.play?.();
    if (result?.catch) result.catch(() => {});
    return result;
  }
  async pause() { this.video?.pause?.(); }
  async seek(time) { if (this.video) this.video.currentTime = time; }
  async rate(value) {
    if (!this.video) return;
    this.video.playbackRate = value;
    if ('preservesPitch' in this.video) this.video.preservesPitch = value >= 0.25 && value <= 4;
  }
  supportsNativeReverse() { return false; }
  async direction() { return false; }
  async mute(value) { if (this.video) this.video.muted = !!value; }
}

class MpvTransport {
  constructor(mpv) { this.mpv = mpv; }
  get type() { return 'mpv'; }
  async play() { return this.mpv?.play?.(); }
  async pause() { return this.mpv?.pause?.(); }
  async seek(time) { return this.mpv?.seek?.(time); }
  async rate(value) { return this.mpv?.rate?.(value); }
  supportsNativeReverse() { return typeof this.mpv?.direction === 'function'; }
  async direction(value) {
    if (!this.supportsNativeReverse()) return false;
    return this.mpv.direction(value === 'backward' ? 'backward' : 'forward');
  }
  async mute(value) { return this.mpv?.mute?.(value); }
}

export function createNativePreviewRuntime({
  video,
  mpv,
  windowTarget = typeof window !== 'undefined' ? window : null,
  ResizeObserverCtor = typeof ResizeObserver !== 'undefined' ? ResizeObserver : null,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  let bridge = mpv || null;
  let mode = 'html5';
  let activeTransport = new Html5Transport(video);
  let nativeVisible = true;
  let subtitleGuideActive = false;
  let imageGuideActive = false;
  let boundsObserver = null;
  let boundsListener = null;
  let boundsTimer = null;
  let lastBounds = null;
  let generation = 0;

  const sameBounds = (left, right) => !!(left && right
    && left.x === right.x && left.y === right.y && left.w === right.w && left.h === right.h);

  function stopBoundsFeeder() {
    boundsObserver?.disconnect?.();
    boundsObserver = null;
    if (boundsListener) windowTarget?.removeEventListener?.('resize', boundsListener);
    boundsListener = null;
    if (boundsTimer != null) clearIntervalFn(boundsTimer);
    boundsTimer = null;
    lastBounds = null;
  }

  function startBoundsFeeder({ readBounds, boundsElement } = {}) {
    stopBoundsFeeder();
    if (typeof readBounds !== 'function' || !bridge?.setBounds) return;
    const send = () => {
      if (mode !== 'mpv') return;
      const next = readBounds();
      if (!next || sameBounds(lastBounds, next)) return;
      lastBounds = { ...next };
      Promise.resolve(bridge.setBounds(next)).catch(() => {});
    };
    boundsListener = send;
    if (ResizeObserverCtor && boundsElement) {
      try {
        boundsObserver = new ResizeObserverCtor(send);
        boundsObserver.observe(boundsElement);
      } catch (error) { boundsObserver = null; }
    }
    windowTarget?.addEventListener?.('resize', send);
    boundsTimer = setIntervalFn(send, 2000);
    send();
  }

  async function clearGuides() {
    subtitleGuideActive = false;
    imageGuideActive = false;
    await Promise.all([
      Promise.resolve(bridge?.setGuide?.(null)).catch(() => {}),
      Promise.resolve(bridge?.setImageGuide?.(null)).catch(() => {}),
    ]);
  }

  function selectHtml5(nextVideo = video) {
    generation += 1;
    mode = 'html5';
    activeTransport = new Html5Transport(nextVideo);
    nativeVisible = false;
    stopBoundsFeeder();
    subtitleGuideActive = false;
    imageGuideActive = false;
  }

  async function shutdownNative() {
    await clearGuides();
    return bridge?.quit ? bridge.quit() : false;
  }

  const runtime = {
    get type() { return activeTransport.type; },
    get isAvailable() { return mode === 'html5' || !!bridge; },
    get mode() { return mode; },

    async enterMpv({ src, bounds, audio, readBounds, boundsElement } = {}) {
      const token = ++generation;
      if (!bridge?.launch) throw new Error('mpv preview bridge is unavailable');
      let result;
      try {
        result = await bridge.launch({ src, bounds, audio });
      } catch (error) {
        if (token === generation) {
          selectHtml5(video);
          await Promise.resolve(shutdownNative()).catch(() => {});
        }
        throw error;
      }
      if (token !== generation) {
        await Promise.resolve(bridge.quit?.()).catch(() => {});
        return null;
      }
      mode = 'mpv';
      activeTransport = new MpvTransport(bridge);
      nativeVisible = true;
      startBoundsFeeder({ readBounds, boundsElement });
      return result;
    },

    async enterHtml5(nextVideo = video) {
      const nativeWasActive = mode === 'mpv';
      selectHtml5(nextVideo);
      if (nativeWasActive) await Promise.resolve(shutdownNative()).catch(() => {});
    },

    setMpvBridge(nextBridge) { bridge = nextBridge || null; },
    selectHtml5,
    shutdownNative,
    startBoundsFeeder,
    stopBoundsFeeder,
    async setNativeVisible(visible) {
      nativeVisible = !!visible;
      return bridge?.show ? bridge.show(nativeVisible) : false;
    },
    async setSubtitleGuide(guide) {
      subtitleGuideActive = !!guide;
      return bridge?.setGuide ? bridge.setGuide(guide || null) : false;
    },
    async setImageGuide(guide) {
      imageGuideActive = !!(guide && (guide.html || typeof guide === 'string'));
      return bridge?.setImageGuide ? bridge.setImageGuide(guide || null) : false;
    },
    async clearGuides() { return clearGuides(); },
    async play() { return activeTransport.play(); },
    async pause() { return activeTransport.pause(); },
    async seek(time) { return activeTransport.seek(time); },
    async rate(value) { return activeTransport.rate(value); },
    supportsNativeReverse() { return mode === 'mpv' && activeTransport.supportsNativeReverse(); },
    async direction(value) {
      if (!runtime.supportsNativeReverse()) return false;
      return activeTransport.direction(value);
    },
    async mute(value) { return activeTransport.mute(value); },
    brightness(value) {
      if (!bridge?.brightness) return false;
      try { return bridge.brightness(value); } catch (error) { return false; }
    },
    async loadfile(filePath) {
      if (mode !== 'mpv' || !bridge?.loadfile) return false;
      return bridge.loadfile(filePath);
    },
    async subSet(assText) {
      if (mode !== 'mpv' || !bridge?.subSet) return false;
      return bridge.subSet(assText);
    },
    async subVisible(visible) {
      if (mode !== 'mpv' || !bridge?.subVisible) return false;
      return bridge.subVisible(!!visible);
    },
    async screenshot(filePath) {
      if (mode !== 'mpv' || !bridge?.screenshot) return false;
      return bridge.screenshot(filePath);
    },
    async setTimecodeWatermark(payload) {
      if (!bridge?.setTimecodeWatermark) return false;
      return bridge.setTimecodeWatermark(payload || null);
    },
    async detect() { return bridge?.detect ? bridge.detect() : null; },
    onEvent(callback) { return bridge?.onEvent?.(callback); },
    async quit() {
      generation += 1;
      stopBoundsFeeder();
      await clearGuides();
      return bridge?.quit ? bridge.quit() : false;
    },
    async launch(options) {
      return runtime.enterMpv(options);
    },
    async setBounds(bounds) {
      if (!bridge?.setBounds) return false;
      return bridge.setBounds(bounds);
    },
    async setGuide(guide) { return runtime.setSubtitleGuide(guide); },
    async show(visible) { return runtime.setNativeVisible(visible); },
    snapshot() {
      return {
        mode,
        activeTransport: activeTransport.type,
        nativeVisible,
        subtitleGuideActive,
        imageGuideActive,
        boundsFeeding: !!(boundsObserver || boundsListener || boundsTimer != null),
      };
    },
  };

  return runtime;
}

let activeRuntime = null;

function _defaultVideo() {
  return typeof document !== 'undefined' ? document.getElementById('video') : null;
}

export function getPlayerAdapter() {
  if (!activeRuntime) {
    const desk = typeof window !== 'undefined' ? window.subtool : null;
    activeRuntime = createNativePreviewRuntime({ video: _defaultVideo(), mpv: desk?.mpv });
  }
  return activeRuntime;
}

export const getNativePreviewRuntime = getPlayerAdapter;

export function resetPlayerAdapter(desk = null, video = _defaultVideo()) {
  activeRuntime?.stopBoundsFeeder?.();
  activeRuntime = createNativePreviewRuntime({ video, mpv: desk?.mpv });
  return activeRuntime;
}

export function activateHtml5Transport(video = _defaultVideo()) {
  return getPlayerAdapter().enterHtml5(video);
}

export function activateMpvTransport(desk) {
  const runtime = getPlayerAdapter();
  runtime.setMpvBridge(desk?.mpv);
  return runtime;
}

export {
  timeToFrameIndex, frameIndexToTime, stepFrameTime, measureClockDrift, createMasterClock
} from './media-presentation-core.js';
