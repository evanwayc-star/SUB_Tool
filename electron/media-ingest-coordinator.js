'use strict';

class IngestSupersededError extends Error {
  constructor() {
    super('媒體轉檔已被較新的載入取代');
    this.name = 'IngestSupersededError';
    this.code = 'INGEST_SUPERSEDED';
  }
}

/*
  Proxy、逐聲道 AAC、波形與 meta.json 都落在同一份 per-source cache。  Streaming
  ingest 在 proxy 可播放後就回應 renderer，但 ffmpeg 還會繼續寫其餘 cache；因此
  "request resolved" 不能當作 lane 已空。  此 coordinator 讓 response 和 completion
  分開，只有 completion 才會交棒給下一個 cache writer。
*/
function createMediaIngestCoordinator({ killProcess } = {}) {
  const kill = typeof killProcess === 'function'
    ? killProcess
    : process => { try { process?.kill?.(); } catch (error) {} };
  const pending = [];
  let active = null;
  let draining = false;

  const cancel = lease => {
    if (!lease || lease.cancelled) return;
    lease.cancelled = true;
    if (lease.process) kill(lease.process);
  };

  const asWorkResult = value => {
    if (value && typeof value === 'object'
      && (Object.prototype.hasOwnProperty.call(value, 'response')
        || Object.prototype.hasOwnProperty.call(value, 'completion'))) {
      return { response: value.response, completion: value.completion };
    }
    return { response: value, completion: null };
  };

  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (pending.length) {
        const ticket = pending.shift();
        const lease = { cancelled: false, process: null };
        active = lease;
        try {
          const value = await ticket.work({
            setProcess(process) {
              lease.process = process || null;
              if (lease.cancelled && lease.process) kill(lease.process);
            },
            isCancelled: () => lease.cancelled,
          });
          const { response, completion } = asWorkResult(value);
          // A replacement may arrive while a work function is still waiting for
          // its first playable bytes.  Do not let that late response revive an
          // already-superseded renderer load; still await completion below to
          // serialize cache writers before handing the lane over.
          if (lease.cancelled) ticket.reject(new IngestSupersededError());
          else ticket.resolve(response);
          /* A failed background streaming job reports its error via the ingest
             job / task-progress channel.  It still must release this lane so a
             later cache task can make progress. */
          if (completion) await Promise.resolve(completion).catch(() => undefined);
        } catch (error) {
          ticket.reject(error);
        } finally {
          if (active === lease) active = null;
        }
      }
    } finally {
      draining = false;
      if (pending.length) void drain();
    }
  };

  const submit = (work, { replace = false } = {}) => new Promise((resolve, reject) => {
    if (typeof work !== 'function') {
      reject(new TypeError('media ingest work must be a function'));
      return;
    }
    if (replace) {
      const superseded = new IngestSupersededError();
      while (pending.length) pending.shift().reject(superseded);
      cancel(active);
    }
    const ticket = { work, resolve, reject };
    if (replace) pending.unshift(ticket);
    else pending.push(ticket);
    void drain();
  });

  return Object.freeze({
    replace: work => submit(work, { replace: true }),
    enqueue: work => submit(work),
  });
}

module.exports = { createMediaIngestCoordinator, IngestSupersededError };
