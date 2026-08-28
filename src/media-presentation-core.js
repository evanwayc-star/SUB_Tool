/* ==============================================================================
   SUB Tool — 媒體實際呈現協調核心 ("src/media-presentation-core.js")
   ==============================================================================
   深層模組：把時間軸目標交給 HTML5／mpv／WebCodecs presenter，並以實際
   呈現回報作為提交點。它只容許一個 in-flight 請求，忙碌時只保留最新目標。
   ============================================================================== */

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
      outbound = presentTarget(request.requestedTime, {
        requestId: request.id,
        signal: request.controller?.signal || null,
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
    if (Math.abs(active.requestedTime - next.requestedTime) < 1e-9) return active.promise;
    if (pending && Math.abs(pending.requestedTime - next.requestedTime) < 1e-9) return pending.promise;
    if (pending) finish(pending, { status: 'superseded', presentedTime: lastPresentedTime });
    pending = next;
    return next.promise;
  }

  function observe(presentedTime, details = {}) {
    const observed = Number(presentedTime);
    if (!Number.isFinite(observed)) return false;
    lastPresentedTime = Math.max(0, observed);
    if (!active || details?.requestId !== active.id) return false;
    const tolerance = Math.max(0, Number(getTolerance(active.requestedTime, details)) || 0);
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
  const getTolerance = typeof options.getTolerance === 'function'
    ? options.getTolerance
    : () => 1.5 / 30;
  const presentTarget = options.presentTarget;
  if (typeof presentTarget !== 'function') throw new TypeError('presentTarget must be a function');
  let session = null;
  const core = createMediaPresentationCore({
    ...options,
    presentTarget: (targetTime, request) => presentTarget(targetTime, request, session),
  });
  const compositeWaiters = new Map();
  let webCodecsTakeover = false;

  function waitForWebCodecsPresentation(targetTime, { requestId, signal } = {}) {
    const key = requestId ?? Symbol('webcodecs-presentation');
    const tolerance = Math.max(0, Number(getTolerance(targetTime, { source: 'webcodecs' })) || 0);
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

  function reset(reason = 'media-reset') {
    core.cancel(reason);
    for (const waiter of [...compositeWaiters.values()]) waiter.abort();
    compositeWaiters.clear();
    webCodecsTakeover = false;
  }

  session = {
    request: core.request,
    observe: core.observe,
    cancel: core.cancel,
    presentedTime: core.presentedTime,
    isPending: core.isPending,
    waitForWebCodecsPresentation,
    reportWebCodecsPresentation,
    setWebCodecsTakeover(value) { webCodecsTakeover = !!value; },
    webCodecsTakeover() { return webCodecsTakeover; },
    reset,
    snapshot() {
      return {
        pending: core.isPending(),
        presentedTime: core.presentedTime(),
        webCodecsTakeover,
        compositeWaiterCount: compositeWaiters.size,
      };
    },
  };
  return session;
}
