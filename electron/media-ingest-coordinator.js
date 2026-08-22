/* ==============================================================================
   SUB Tool — 媒體轉檔快取排程協調器 (Media Ingest Coordinator)
   ==============================================================================
   【架構與職責】
   協調 Proxy 視訊轉檔、逐聲道音訊抽取、波形計算與中繼資料快取之寫入通道。
   
   【核心排程不變量】
   1. 串流轉檔（Streaming Ingest）：Proxy 視訊達到可播放狀態（First Playable Bytes）即先
      回應 Renderer（`response` 解析），但 FFmpeg 背景程序仍會持續寫入其餘快取檔案。
   2. 通道序列化（Lane Serialization）：只有當前轉檔的背景寫入完全完成（`completion` 達成），
      才釋放並交棒給下一個快取寫入工作，避免多個 FFmpeg 程序爭搶同一目錄的 meta.json。
   3. 取代機制（Supersede）：當使用者切換媒體載入新檔案時，舊的轉檔工作立即中止並拋出
      `IngestSupersededError`，釋放系統 CPU 與 I/O。
   ============================================================================== */
'use strict';

/**
 * 轉檔被較新工作取代之自訂錯誤類型。
 */
class IngestSupersededError extends Error {
  constructor() {
    super('媒體轉檔已被較新的載入取代');
    this.name = 'IngestSupersededError';
    this.code = 'INGEST_SUPERSEDED';
  }
}

/**
 * 建立媒體轉檔排程協調器。
 * 
 * @param {object} [options]
 * @param {Function} [options.killProcess] 終止行程函式注入
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

          // 若等待期間已被取代，拒絕 resolve 舊回應
          if (lease.cancelled) {
            ticket.reject(new IngestSupersededError());
          } else {
            ticket.resolve(response);
          }

          // 背景寫入完成前，保持通道鎖定以確保快取寫入順序
          if (completion) {
            await Promise.resolve(completion).catch(() => undefined);
          }
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
    /** 取代目前所有等待與執行中的轉檔工作，優先執行新任務 */
    replace: work => submit(work, { replace: true }),
    /** 將新轉檔工作依序加入排隊佇列 */
    enqueue: work => submit(work),
  });
}

module.exports = { createMediaIngestCoordinator, IngestSupersededError };
