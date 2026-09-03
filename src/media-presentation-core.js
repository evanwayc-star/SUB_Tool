/* ==============================================================================
   SUB Tool — 媒體實際呈現協調核心 ("src/media-presentation-core.js")
   ==============================================================================
   深層模組：把時間軸目標交給 HTML5／mpv／WebCodecs presenter，並以實際
   呈現回報作為提交點。它只容許一個 in-flight 請求，忙碌時只保留最新目標。
   ============================================================================== */
import { clamp } from './util.js';

/**
 * 建立「要求位置」與「實際呈現位置」之間的單一協調核心。
 *
 * presentTarget 只負責把命令送到目前的 renderer；命令成功不代表畫面已完成。
 * renderer 必須以 correlated Promise 或帶 requestId 的 observe() 回報實際畫格。
 */
export function createMediaPresentationCore({
  presentTarget,
  getTolerance = () => 1.5 / 30,
  timeoutMs = 500,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (typeof presentTarget !== 'function') throw new TypeError('presentTarget must be a function');

  let active = null;
  let pending = null;
  let lastPresentedTime = null;
  let nextId = 1;

  function requestTolerance(request) {
    const value = Number(request?.options?.tolerance);
    return request?.options?.tolerance != null && Number.isFinite(value)
      ? Math.max(0, value)
      : null;
  }

  function canSharePresentation(left, right) {
    return Math.abs(left.requestedTime - right.requestedTime) < 1e-9
      && requestTolerance(left) === requestTolerance(right);
  }

  function makeRequest(targetTime, options) {
    const requestedTime = Math.max(0, Number(targetTime) || 0);
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return {
      id: nextId++, requestedTime, options: options || {}, promise, resolve,
      timer: null, settled: false,
      controller: typeof AbortController !== 'undefined' ? new AbortController() : null,
    };
  }

  function finish(request, result) {
    if (!request || request.settled) return;
    request.settled = true;
    if (request.timer != null) clearTimeoutFn(request.timer);
    request.timer = null;
    if (result?.status !== 'presented') request.controller?.abort?.(result?.reason || result?.status);
    request.resolve({ requestedTime: request.requestedTime, ...result });
  }

  function startNext() {
    if (active || !pending) return;
    const next = pending;
    pending = null;
    start(next);
  }

  function releaseActive(request, result) {
    if (active !== request) return;
    active = null;
    finish(request, result);
    startNext();
  }

  function start(request) {
    active = request;
    const requestTimeout = Number(request.options.timeoutMs ?? timeoutMs);
    if (Number.isFinite(requestTimeout) && requestTimeout > 0) {
      request.timer = setTimeoutFn(() => {
        releaseActive(request, { status: 'timeout', presentedTime: lastPresentedTime });
      }, requestTimeout);
    }

    let outbound;
    try {
      const requestedTolerance = Number(request.options.tolerance);
      const hasRequestedTolerance = request.options.tolerance != null
        && Number.isFinite(requestedTolerance);
      outbound = presentTarget(request.requestedTime, {
        requestId: request.id,
        signal: request.controller?.signal || null,
        isLatestRequest: () => active === request && pending == null,
        ...(hasRequestedTolerance
          ? { tolerance: Math.max(0, requestedTolerance) }
          : {}),
      });
    } catch (error) {
      releaseActive(request, { status: 'failed', error });
      return;
    }

    Promise.resolve(outbound).then(result => {
      if (active !== request || request.settled) return;
      const presentedTime = typeof result === 'number' ? result : result?.presentedTime;
      if (!Number.isFinite(Number(presentedTime))) return;
      lastPresentedTime = Math.max(0, Number(presentedTime));
      const source = result?.source || result?.backend;
      releaseActive(request, {
        status: 'presented',
        presentedTime: lastPresentedTime,
        ...(source ? { source } : {}),
      });
    }).catch(error => {
      releaseActive(request, { status: 'failed', error });
    });
  }

  function request(targetTime, options = {}) {
    const next = makeRequest(targetTime, options);
    if (!active) {
      start(next);
      return next.promise;
    }
    // 相同時間但不同容差是不同呈現契約：逐格的嚴格請求不可共用先前的一般 seek，
    // 否則一般容差內的舊畫格可能讓逐格請求提早完成。
    if (canSharePresentation(active, next)) {
      if (pending) {
        finish(pending, { status: 'superseded', presentedTime: lastPresentedTime });
        pending = null;
      }
      return active.promise;
    }
    if (pending && canSharePresentation(pending, next)) return pending.promise;
    if (pending) finish(pending, { status: 'superseded', presentedTime: lastPresentedTime });
    pending = next;
    return next.promise;
  }

  function observe(presentedTime, details = {}) {
    const observed = Number(presentedTime);
    if (!Number.isFinite(observed)) return false;
    lastPresentedTime = Math.max(0, observed);
    if (!active || details?.requestId !== active.id) return false;
    const requestedTolerance = Number(active.options.tolerance);
    const tolerance = active.options.tolerance != null && Number.isFinite(requestedTolerance)
      ? Math.max(0, requestedTolerance)
      : Math.max(0, Number(getTolerance(active.requestedTime, details)) || 0);
    if (Math.abs(lastPresentedTime - active.requestedTime) > tolerance) return false;
    const source = details?.source;
    releaseActive(active, {
      status: 'presented',
      presentedTime: lastPresentedTime,
      ...(source ? { source } : {}),
    });
    return true;
  }

  function cancel(reason = 'cancelled') {
    const current = active;
    const queued = pending;
    active = null;
    pending = null;
    finish(current, { status: 'cancelled', reason, presentedTime: lastPresentedTime });
    finish(queued, { status: 'cancelled', reason, presentedTime: lastPresentedTime });
  }

  return {
    request,
    observe,
    cancel,
    presentedTime() { return lastPresentedTime; },
    isPending() { return !!active; },
  };
}

/**
 * 播放呈現工作的完整 session。
 *
 * core 擁有 request 排程；session 再把 WebCodecs takeover 與合成畫格 waiter
 * 收進同一個 lifecycle，避免 Media 同時維護 core、Map 與 takeover 三份狀態。
 */
export function createMediaPresentationSession(options = {}) {
  // FPS-SYNC (I4a)：容差永遠由呼叫端的專案精確 FPS 提供；session 不自行猜測影格率。
  const getTolerance = options.getTolerance;
  const timeline = options.timeline || {};
  const player = options.player || {};
  const playback = options.playback || {};
  const commitPresented = options.commitPresented;
  if (typeof getTolerance !== 'function') throw new TypeError('getTolerance must be a function');
  if (typeof timeline.normalizeTarget !== 'function') throw new TypeError('timeline.normalizeTarget must be a function');
  if (typeof player.adapter !== 'function') throw new TypeError('player.adapter must be a function');
  if (typeof commitPresented !== 'function') throw new TypeError('commitPresented must be a function');
  const compositeWaiters = new Map();
  let webCodecsTakeover = false;
  let wantsPlayback = false;
  let playbackPending = false;
  let playbackRunning = false;
  let playbackRequestToken = 0;

  function waitForWebCodecsPresentation(targetTime, { requestId, signal, tolerance: requestedTolerance } = {}) {
    const key = requestId ?? Symbol('webcodecs-presentation');
    const tolerance = requestedTolerance != null && Number.isFinite(Number(requestedTolerance))
      ? Math.max(0, Number(requestedTolerance))
      : Math.max(0, Number(getTolerance(targetTime, { source: 'webcodecs' })) || 0);
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        signal?.removeEventListener?.('abort', abort);
        compositeWaiters.delete(key);
      };
      const finish = value => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        const error = Object.assign(new Error('WebCodecs presentation aborted'), { name: 'AbortError' });
        reject(error);
      };

      if (signal?.aborted) {
        abort();
        return;
      }
      compositeWaiters.set(key, { targetTime, tolerance, finish, abort });
      signal?.addEventListener?.('abort', abort, { once: true });
    });
  }

  function reportWebCodecsPresentation(presentedTimelineTimes) {
    const times = (Array.isArray(presentedTimelineTimes) ? presentedTimelineTimes : [presentedTimelineTimes])
      .map(Number)
      .filter(Number.isFinite);
    if (!times.length) return false;
    let completed = false;
    for (const waiter of [...compositeWaiters.values()]) {
      if (!times.every(time => Math.abs(time - waiter.targetTime) <= waiter.tolerance)) continue;
      waiter.finish({ backend: 'webcodecs', presentedTime: times[times.length - 1] });
      completed = true;
    }
    return completed;
  }

  async function presentTimelineTarget(targetTime, {
    signal,
    requestId,
    tolerance: requestedTolerance,
    isLatestRequest,
  } = {}) {
    if (signal?.aborted) {
      throw Object.assign(new Error('media presentation aborted'), { name: 'AbortError' });
    }
    const commitIfLatest = presentedTime => (
      typeof isLatestRequest === 'function' && !isLatestRequest()
        ? presentedTime
        : commitPresented(presentedTime)
    );

    let clip = null;
    let sourceTarget = targetTime;
    if (timeline.hasSequence?.()) {
      clip = timeline.clipAt?.(targetTime) || null;
      if (!clip) {
        timeline.enterGap?.(targetTime);
        const committed = commitIfLatest(targetTime);
        return { presentedTime: committed, source: 'synthetic' };
      }
      sourceTarget = timeline.sourceTime?.(targetTime, clip);
      if (!Number.isFinite(Number(sourceTarget))) throw new Error('timeline source mapping is unavailable');
      if (timeline.requiresClip?.(clip)) {
        await timeline.ensureClip?.(clip, sourceTarget, false);
        if (signal?.aborted) {
          throw Object.assign(new Error('media presentation aborted'), { name: 'AbortError' });
        }
      }
      if (player.isNative?.()) player.configureNativeSeek?.(clip);
    } else if (timeline.isVirtual?.()) {
      timeline.seekVirtual?.(targetTime, { running: false });
      const committed = commitIfLatest(targetTime);
      return { presentedTime: committed, source: 'synthetic' };
    }

    const adapter = player.adapter();
    if (!adapter || typeof adapter.present !== 'function') throw new Error('player adapter is unavailable');
    const tolerance = requestedTolerance != null && Number.isFinite(Number(requestedTolerance))
      ? Math.max(0, Number(requestedTolerance))
      : Math.max(0, Number(getTolerance(targetTime, { source: adapter.type })) || 0);
    const webCodecsPending = webCodecsTakeover
      ? waitForWebCodecsPresentation(targetTime, { signal, requestId, tolerance })
      : null;
    webCodecsPending?.catch(() => {});
    const presentationTarget = Number(player.presentationTarget?.(sourceTarget, clip) ?? sourceTarget);
    if (!Number.isFinite(presentationTarget)) throw new Error('player presentation target is unavailable');
    const result = await adapter.present(presentationTarget, {
      signal,
      exact: !!(player.isNative?.() && player.exactSeek?.()),
      tolerance,
    });
    const actualSource = Number(result?.presentedSourceTime);
    if (!Number.isFinite(actualSource)) throw new Error('player did not acknowledge a presented frame');
    let presentedTimeline = clip
      ? Number(timeline.timelineTime?.(actualSource, clip))
      : actualSource;
    if (!Number.isFinite(presentedTimeline)) throw new Error('timeline presentation mapping is unavailable');
    let source = result.backend || adapter.type;
    if (webCodecsPending) {
      const composited = await webCodecsPending;
      presentedTimeline = composited.presentedTime;
      source = composited.backend;
    }
    if (player.isNative?.()) player.setPresentedSourceTime?.(actualSource);
    commitIfLatest(presentedTimeline);
    return { presentedTime: presentedTimeline, source };
  }

  const core = createMediaPresentationCore({
    getTolerance,
    timeoutMs: options.timeoutMs,
    setTimeoutFn: options.setTimeoutFn,
    clearTimeoutFn: options.clearTimeoutFn,
    presentTarget: presentTimelineTarget,
  });

  function invokePlayback(name, ...args) {
    const effect = playback[name];
    if (typeof effect !== 'function') return;
    try {
      const result = effect(...args);
      result?.catch?.(() => {});
    } catch (error) {}
  }

  function requestPlayback(targetTime, requestOptions) {
    const token = ++playbackRequestToken;
    if (!playbackPending && playbackRunning) {
      invokePlayback('suspend');
      playbackRunning = false;
    }
    playbackPending = true;
    const pending = core.request(timeline.normalizeTarget(targetTime), requestOptions);
    pending.then(result => {
      if (token !== playbackRequestToken) return;
      playbackPending = false;
      if (result?.status === 'presented') {
        if (!wantsPlayback) return;
        invokePlayback('resume');
        playbackRunning = true;
        return;
      }
      if ((result?.status === 'timeout' || result?.status === 'failed') && wantsPlayback) {
        wantsPlayback = false;
        playbackRunning = false;
        invokePlayback('fail', result);
      }
    });
    return pending;
  }

  function setPlaybackIntent(value) {
    wantsPlayback = !!value;
    if (!wantsPlayback) {
      if (playbackRunning) invokePlayback('suspend');
      playbackRunning = false;
      return false;
    }
    if (playbackPending) return true;
    if (!playbackRunning) invokePlayback('resume');
    playbackRunning = true;
    return false;
  }

  /* 播放器 adapter 回報的是已發生的狀態，不可再呼叫 resume/suspend 形成回授。
     呈現 transition 期間的 pause 是 session 主動 suspend 的 acknowledgement；
     只更新 running，不可清掉使用者最新的播放意圖。 */
  function observePlaybackState(value, detail = {}) {
    const running = !!value;
    if (playbackPending) {
      // present() 期間的 pause 是 session 主動 suspend 的 acknowledgement，
      // 必須保留最新播放意圖；error／end-file 則是 presenter 真正終止，
      // 不可等 timeout 後又 resume 一個已失敗或已播完的來源。
      if (running || detail?.reason === 'pause') {
        if (running) invokePlayback('suspend');
        playbackRunning = false;
        return false;
      }
      const reason = detail?.reason || 'stopped';
      clearPlaybackTransition();
      core.cancel(`player-${reason}`);
      invokePlayback('commit', false, detail);
      return true;
    }
    wantsPlayback = running;
    playbackRunning = running;
    invokePlayback('commit', running, detail);
    return true;
  }

  function clearPlaybackTransition() {
    playbackRequestToken += 1;
    playbackPending = false;
    wantsPlayback = false;
    if (playbackRunning) invokePlayback('suspend');
    playbackRunning = false;
  }

  function cancel(reason = 'cancelled') {
    clearPlaybackTransition();
    core.cancel(reason);
  }

  function reset(reason = 'media-reset') {
    clearPlaybackTransition();
    core.cancel(reason);
    for (const waiter of [...compositeWaiters.values()]) waiter.abort();
    compositeWaiters.clear();
    webCodecsTakeover = false;
  }

  const session = {
    request(targetTime, requestOptions) {
      return core.request(timeline.normalizeTarget(targetTime), requestOptions);
    },
    requestPlayback,
    setPlaybackIntent,
    observePlaybackState,
    isPlaybackPending() { return playbackPending; },
    playbackIntent() { return wantsPlayback; },
    observe: core.observe,
    cancel,
    presentedTime: core.presentedTime,
    isPending: core.isPending,
    reportWebCodecsPresentation,
    setWebCodecsTakeover(value) { webCodecsTakeover = !!value; },
    webCodecsTakeover() { return webCodecsTakeover; },
    reset,
  };
  return session;
}

export class ResetEpoch {
  constructor() { this.generation = 0; }

  capture(identity = null, owns = null) {
    return Object.freeze({
      generation: this.generation,
      identity,
      upstreamOwns: typeof owns === 'function' ? owns : null,
    });
  }

  owns(token) {
    if (!token || token.generation !== this.generation) return false;
    try { return !token.upstreamOwns || token.upstreamOwns(); }
    catch (error) { return false; }
  }

  invalidate() {
    this.generation += 1;
    return this.generation;
  }
}

function requirePort(port) {
  for (const name of ['clock', 'sequence', 'audio', 'actions']) {
    if (!port?.[name]) throw new TypeError(`PlaybackSyncEngine 缺少 ${name} port`);
  }
  return port;
}

export class PlaybackSyncEngine {
  constructor(port) {
    this.port = requirePort(port);
    this._externalActivityKey = null;
  }

  syncSequenceElements(t) {
    const { audio } = this.port;
    for (const track of audio.tracks()) {
      if (track.kind !== 'element' || !track.el) continue;
      if (track._srcHidden || (track.source || '').startsWith('ext-')) continue;
      const localTime = audio.sourceLocalTime(track.source || 'video', t);
      if (localTime == null) continue;
      try { track.el.currentTime = clamp(localTime, 0, track.el.duration || localTime); } catch (error) {}
    }
  }

  seqTick() {
    const { clock, sequence, audio, actions } = this.port;
    if (!clock.isPlaying() || clock.isSwitching() || clock.presenterMoving() === false) return;

    if (sequence.audioOnly()) {
      const time = clock.timelineTime();
      this._syncExternalElementActivity(time);
      if (time >= Math.max(0, sequence.duration()) - 0.02) {
        actions.pause();
        actions.seek(sequence.duration());
      }
      return;
    }
    if (!sequence.enabled()) return;

    const time = clock.timelineTime();
    if (!sequence.inGap() && !sequence.activeClip() && !sequence.clipAt(time)) this._enterGap(time);
    this._syncExternalElementActivity(time);

    const videoClips = sequence.videoClips();
    const onlyClip = videoClips[0];
    if (videoClips.length === 1 && onlyClip && !sequence.inGap()
      && onlyClip.offset === 0 && onlyClip.in === 0
      && Math.abs(onlyClip.out - onlyClip.dur) < 0.05
      && sequence.activeClipId() === onlyClip.id) return;

    if (sequence.inGap()) {
      const hit = sequence.clipAt(time);
      if (hit) {
        actions.ensureClip(hit, sequence.sourceTime(time, hit), true);
        return;
      }
      if (!sequence.nextAfter(time) && time >= Math.max(0, sequence.duration()) - 0.02) actions.pause();
      return;
    }

    const clip = sequence.activeClip();
    if (!clip) {
      const hit = sequence.clipAt(time);
      if (hit) actions.ensureClip(hit, sequence.sourceTime(time, hit), true);
      else this._enterGap(time);
      return;
    }

    const overlapKey = sequence.clipsAt(time)
      .filter(item => item.type !== 'image')
      .map(item => item.id)
      .join('|');
    if (overlapKey !== actions.overlapKey()) {
      actions.setOverlapKey(overlapKey);
      actions.applyClipAudio(clip, time);
      actions.startElementSources(clock.sourceTime(), time);
      actions.stopBufferSources();
      if (audio.tracks().some(track => track.kind === 'buffer' && !track._srcHidden)) {
        actions.startBufferSources(clock.sourceTime());
      }
    }

    const end = sequence.clipEnd(clip);
    if (time < end - 0.02) return;
    const next = sequence.clipAt(end + 0.001);
    if (next) actions.ensureClip(next, sequence.sourceTime(end, next), true);
    else if (sequence.nextAfter(end)) this._enterGap(end);
    else if (sequence.duration() > end + 0.001) {
      this._enterGap(end);
      actions.startElementSources(end, end);
    } else {
      actions.pause();
      actions.seek(end);
    }
  }

  seqContinueAtEnd() {
    const { clock, sequence, actions } = this.port;
    if (!sequence.enabled() || !clock.isPlaying() || clock.isSwitching()) return false;
    const clip = sequence.activeClip();
    if (!clip) return false;
    const end = sequence.clipEnd(clip);
    const next = sequence.clipAt(end + 0.001);
    if (next) {
      actions.ensureClip(next, sequence.sourceTime(end, next), true);
      return true;
    }
    if (sequence.nextAfter(end)) {
      this._enterGap(end);
      return true;
    }
    if (sequence.duration() > end + 0.001) {
      this._enterGap(end);
      actions.startElementSources(end, end);
      return true;
    }
    return false;
  }

  invalidateExternalActivity() {
    this._externalActivityKey = null;
  }

  _enterGap(time) {
    this.port.actions.enterGap(time);
    this.invalidateExternalActivity();
  }

  _syncExternalElementActivity(time) {
    const { clock, audio } = this.port;
    const active = [];
    for (const track of audio.tracks()) {
      if (track.kind !== 'element' || !track.el) continue;
      const source = track.source || '';
      if (!source.startsWith('ext-')) continue;
      active.push(`${source}:${!track._srcHidden && audio.externalSourceTime(source, time) != null ? '1' : '0'}`);
    }
    const key = active.join('|');
    if (key === this._externalActivityKey) return;
    this._externalActivityKey = key;

    for (const track of audio.tracks()) {
      if (track.kind !== 'element' || !track.el) continue;
      const source = track.source || '';
      if (!source.startsWith('ext-')) continue;
      const offset = !track._srcHidden ? audio.externalSourceTime(source, time) : null;
      try {
        if (offset == null) { track.el.pause(); continue; }
        track.el.currentTime = clamp(offset, 0, track.el.duration || offset);
        track.el.playbackRate = clock.playbackRate();
        if ('preservesPitch' in track.el) {
          track.el.preservesPitch = track.el.playbackRate >= 0.25 && track.el.playbackRate <= 4;
        }
        const result = track.el.play();
        if (result?.catch) result.catch(() => {});
      } catch (error) {}
    }
  }
}

