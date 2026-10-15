// media-player-adapter.js
// NativePreviewRuntime 是 renderer 的單一預覽 owner；HTML5／mpv transport adapters
// 留在模組內部，OS 視窗、guide 與 bounds 不會因 active transport 改變而掉進 no-op。
import { timestampOffset, sourceClockTime, playerClockTime } from '../shared/media-source-clock.cjs';

function presentationAbortError() {
  const error = new Error('media presentation aborted');
  error.name = 'AbortError';
  return error;
}

class Html5Transport {
  constructor(video, clockFor = () => null) { this.video = video; this.clockFor = clockFor; }
  clock() { return this.clockFor(this.video?.currentSrc || this.video?.src); }
  sourceTime(value = this.video?.currentTime || 0) { return sourceClockTime(value, this.clock()); }
  cancelPendingSeek() { this.pendingSeek?.cancel(); }
  setRawTime(target, signal, owns) {
    const video=this.video;
    if(!video) return;
    if(signal?.aborted||(owns&&!owns())) throw presentationAbortError();
    this.cancelPendingSeek();
    let attemptedDuration=video.duration;
    video.currentTime=target;
    // MOV 的首份 duration 可能只含 stream 長度，讀到實際 PTS 後才延長。
    // currentTime setter 已被舊片尾截斷時，在 duration 更新後重送原目標。
    if(!Number.isFinite(video.duration)||video.duration>=target
      ||Math.abs(video.currentTime-target)<1e-6||typeof video.addEventListener!=='function') return;
    const source=video.currentSrc||video.src;
    return new Promise((resolve,reject)=>{
      let settled=false,timer,ownershipTimer;
      const cleanup=()=>{
        clearTimeout(timer);
        clearInterval(ownershipTimer);
        for(const event of ['durationchange','loadeddata','seeked'])video.removeEventListener?.(event,retry);
        for(const event of ['emptied','error'])video.removeEventListener?.(event,cancel);
        signal?.removeEventListener?.('abort',cancel);
        if(this.pendingSeek===pending)this.pendingSeek=null;
      };
      const finish=(error)=>{if(settled)return;settled=true;cleanup();error?reject(error):resolve();};
      const cancel=()=>finish(presentationAbortError());
      const retry=()=>{
        if((video.currentSrc||video.src)!==source||signal?.aborted||(owns&&!owns())){cancel();return;}
        const availableDuration=video.duration;
        // 每次範圍真正擴大就重送：中間片尾也能促使 MOV 解碼後段 metadata。
        // 同一 duration 的連發事件不能反覆打斷 seek，原始目標仍保留到可達。
        if(availableDuration<target&&!(availableDuration>attemptedDuration))return;
        attemptedDuration=availableDuration;
        try{
          video.currentTime=target;
          if(availableDuration>=target||Math.abs(video.currentTime-target)<1e-6)finish();
        }catch(error){finish(error);}
      };
      const pending={cancel};this.pendingSeek=pending;
      for(const event of ['durationchange','loadeddata','seeked'])video.addEventListener(event,retry);
      for(const event of ['emptied','error'])video.addEventListener(event,cancel,{once:true});
      signal?.addEventListener?.('abort',cancel,{once:true});
      timer=setTimeout(()=>finish(new Error('HTML media duration did not reach the requested source time')),10000);
      if(owns)ownershipTimer=setInterval(()=>{if(!owns())cancel();},25);
      retry();
    });
  }
  get type() { return 'html5'; }
  async play() {
    const result = this.video?.play?.();
    if (result?.catch) result.catch(() => {});
    return result;
  }
  async pause() { this.video?.pause?.(); }
  async seek(time, {signal,owns}={}) { return this.setRawTime(Math.max(0,playerClockTime(time,this.clock())),signal,owns); }
  async present(time, { signal, owns, tolerance = 1.5 / 30, frameTarget = time, frameStart = null, frameDuration = 0 } = {}) {
    if (!this.video) throw new Error('HTML5 video element is unavailable');
    if (signal?.aborted||(owns&&!owns())) throw presentationAbortError();
    const target = Math.max(0, Number(time) || 0);
    const allowedDrift = Math.max(0, Number(tolerance) || 0);
    const knownFrame=frameStart!=null&&Number.isFinite(Number(frameStart))&&frameDuration>0
      &&frameTarget>=Number(frameStart)-1e-9&&frameTarget<Number(frameStart)+frameDuration-1e-9;
    const video = this.video;
    return new Promise((resolve, reject) => {
      let settled = false;
      let frameCallbackId = null;
      let seekedHandler = null;
      let rawSeek = null;

      const cleanup = () => {
        rawSeek?.cancel();
        if (frameCallbackId != null) video.cancelVideoFrameCallback?.(frameCallbackId);
        frameCallbackId = null;
        if (seekedHandler) video.removeEventListener?.('seeked', seekedHandler);
        seekedHandler = null;
        signal?.removeEventListener?.('abort', abort);
      };
      const finish = presentedSourceTime => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ backend: 'html5', presentedSourceTime,
          ...(knownFrame?{presentedSourceDuration:frameDuration}:{}),
        });
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(presentationAbortError());
      };
      const accept = value => {
        if(owns&&!owns()){abort();return true;}
        const presented = this.sourceTime(value);
        if (!Number.isFinite(presented) || (knownFrame
          ? Math.abs(presented-Number(frameStart))>2e-6
          : Math.abs(presented-target)>allowedDrift)) return false;
        finish(presented);
        return true;
      };
      const requestFrame = () => {
        if (settled) return;
        frameCallbackId = video.requestVideoFrameCallback((unusedNow, metadata) => {
          frameCallbackId = null;
          if (!accept(metadata?.mediaTime)) requestFrame();
        });
      };

      signal?.addEventListener?.('abort', abort, { once: true });
      // FPS-SYNC: seeked confirms a new source position, not a composited frame.
      // Chromium's frame callback is the presentation evidence when available.
      if (typeof video.requestVideoFrameCallback !== 'function' && typeof video.addEventListener === 'function') {
        seekedHandler = () => { accept(video.currentTime); };
        video.addEventListener('seeked', seekedHandler);
      }
      try {
        const pending=this.setRawTime(Math.max(0,playerClockTime(target,this.clock())),signal,owns);
        rawSeek=this.pendingSeek;
        pending?.catch(error=>{if(settled)return;settled=true;cleanup();reject(error);});
      } catch (error) { cleanup(); reject(error); return; }
      if (typeof video.requestVideoFrameCallback === 'function') {
        try { requestFrame(); } catch (error) { cleanup(); reject(error); }
      } else if (!seekedHandler) {
        queueMicrotask(() => accept(video.currentTime));
      }
    });
  }
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
  async seek(time, options) { return this.mpv?.seek?.(time, options); }
  async present(time, options = {}) {
    if (typeof this.mpv?.present !== 'function') throw new Error('mpv presentation acknowledgement is unavailable');
    const { signal, ...bridgeOptions } = options;
    if (signal?.aborted) throw presentationAbortError();
    const pending = Promise.resolve(this.mpv.present(time, bridgeOptions));
    if (!signal?.addEventListener) return pending;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal.removeEventListener?.('abort', abort);
      const abort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        Promise.resolve(this.mpv?.cancelPresent?.()).catch(() => {});
        reject(presentationAbortError());
      };
      signal.addEventListener('abort', abort, { once: true });
      pending.then(result => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      }, error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
    });
  }
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
  const sourceClocks = new Map();
  const elementTransports = new WeakMap();
  const clockFor = url => sourceClocks.get(url) || null;
  const html5For = element => {
    if(!element) return new Html5Transport(element,clockFor);
    let transport=elementTransports.get(element);
    if(!transport){transport=new Html5Transport(element,clockFor);elementTransports.set(element,transport);}
    return transport;
  };
  let activeTransport = html5For(video);
  let nativeVisible = true;
  let subtitleGuideActive = false;
  let imageGuideActive = false;
  let boundsObserver = null;
  let boundsListener = null;
  let boundsTimer = null;
  let lastBounds = null;
  let generation = 0;
  // Native resources exist while launch is pending, before mpv becomes the active transport.
  let nativeRequested = false;

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
    activeTransport.cancelPendingSeek?.();
    generation += 1;
    mode = 'html5';
    activeTransport = html5For(nextVideo);
    activeTransport.cancelPendingSeek();
    nativeVisible = false;
    stopBoundsFeeder();
    subtitleGuideActive = false;
    imageGuideActive = false;
  }

  async function shutdownNative() {
    const token = generation;
    await clearGuides();
    // A newer launch now owns the shared host. Old cleanup must never quit it.
    if (token !== generation) return false;
    nativeRequested = false;
    return bridge?.quit ? bridge.quit() : false;
  }

  const runtime = {
    get type() { return activeTransport.type; },
    get isAvailable() { return mode === 'html5' || !!bridge; },
    get mode() { return mode; },
    registerSourceClock(url, clock) {
      // 此 URL 時鐘供 HTML、WebCodecs 與原生音訊 element 使用；mpv
      // 另由 main 注入容器相對時鐘。舊 descriptor 仍保留既有偏移語意。
      const presentationOffset = clock?.presentationTimestampOffset;
      if (url) sourceClocks.set(url, Object.freeze({ timestampOffset:
        Number.isFinite(presentationOffset) ? presentationOffset : timestampOffset(clock) }));
    },
    sourceClock: clockFor,
    seekElement(element, sourceTime, {signal,owns}={}) {
      if(!element)return;
      const transport=html5For(element);
      return transport.setRawTime(Math.max(0,playerClockTime(sourceTime,transport.clock())),signal,owns);
    },
    presentElement(element, sourceTime, options) { return html5For(element).present(sourceTime,options); },
    cancelElementSeek(element) { elementTransports.get(element)?.cancelPendingSeek(); },
    sourceTime(value = video?.currentTime || 0, url = video?.currentSrc || video?.src) {
      return sourceClockTime(value, clockFor(url));
    },
    playerTime(value, url = video?.currentSrc || video?.src) {
      return playerClockTime(value, clockFor(url));
    },
    sourceDuration(value = video?.duration, url = video?.currentSrc || video?.src) {
      return Math.max(0, sourceClockTime(value, clockFor(url))) || 0;
    },

    async enterMpv({ src, bounds, audio, readBounds, boundsElement } = {}) {
      activeTransport.cancelPendingSeek?.();
      const token = ++generation;
      if (!bridge?.launch) throw new Error('mpv preview bridge is unavailable');
      nativeRequested = true;
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
        // The operation which superseded this launch owns shutdown/replacement.
        return null;
      }
      mode = 'mpv';
      activeTransport = new MpvTransport(bridge);
      nativeVisible = true;
      startBoundsFeeder({ readBounds, boundsElement });
      return result;
    },

    async enterHtml5(nextVideo = video) {
      const nativeWasActive = nativeRequested;
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
    async seek(time, options) { return activeTransport.seek(time, options); },
    async present(time, options) { return activeTransport.present(time, options); },
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
      selectHtml5(video);
      return shutdownNative();
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

export function bindPlayerFullscreen({
  element,
  documentTarget = typeof document !== 'undefined' ? document : null,
  onChange = () => {},
  onError = error => console.warn('[player] 無法切換全螢幕：', error),
} = {}) {
  if (!element?.addEventListener || !documentTarget?.addEventListener) {
    throw new TypeError('播放器全螢幕需要有效的 element 與 document');
  }

  let transition = Promise.resolve();
  const isActive = () => documentTarget.fullscreenElement === element;

  function toggle() {
    const operation = async () => {
      if (documentTarget.fullscreenElement) {
        if (typeof documentTarget.exitFullscreen !== 'function') return false;
        await documentTarget.exitFullscreen();
        return false;
      }
      if (typeof element.requestFullscreen !== 'function') return false;
      await element.requestFullscreen();
      return true;
    };
    const result = transition.then(operation, operation);
    transition = result.then(() => undefined, () => undefined);
    return result;
  }

  function handleDoubleClick(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    void toggle().catch(onError);
  }

  function handleFullscreenChange() {
    onChange(isActive());
  }

  element.addEventListener('dblclick', handleDoubleClick);
  documentTarget.addEventListener('fullscreenchange', handleFullscreenChange);

  return {
    isActive,
    toggle,
    dispose() {
      element.removeEventListener('dblclick', handleDoubleClick);
      documentTarget.removeEventListener('fullscreenchange', handleFullscreenChange);
    },
  };
}
