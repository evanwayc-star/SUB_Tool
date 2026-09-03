/* ==============================================================================
   SUB Tool — 匯出佇列（"electron/export-queue.js"）
   ==============================================================================

   排程、持久化、恢復、關機收尾。一份交付一個 ffmpeg 程序（ADR-0001），
   佇列決定「下一個跑誰、同時跑幾個、什麼時候寫回磁碟」。

   【為什麼要有這個接縫】
   這整段原本住在 electron/main.js 裡，而它需要的狀態是【模組層的 let】：
     let EXPORT_QUEUE_DIR, _queuePaused, _queueConcurrency, _activeQueueCount
   於是 main.js 成為唯一持有狀態的地方，而它同時還持有媒體快取、字型掃描、
   本機 HTTP 伺服器、mpv 整合⋯⋯十種互不相關的狀態。

   main.js 先前的抽取都是沿著「這段是不是純的」在切，所以純函式都出去了、
   有狀態的全部留下。本檔沿著「這是不是一項職責」切：**佇列自己擁有它的狀態**，
   外界要問就呼叫方法，要改就走 setPaused / setConcurrency。

   【什麼不在這裡】
   - 佇列監控【視窗】的生命週期（BrowserWindow、關閉確認）留在 main.js：
     那是視窗管理，不是排程。本檔只在狀態變動時呼叫注入的 onChanged()。
   - 實際跑 ffmpeg 的 delivery runner 由 runJob adapter 注入。
   - 准入政策在 export-admission.js。

   正式狀態語彙與 ExportQueueState 是本 module 的 implementation，不可由 caller
   置換；electron、filesystem、runner 等外部效果才透過 adapter 注入。
 ============================================================================== */

'use strict';

const path = require('path');

/**
 * 匯出工作狀態枚舉。
 * @readonly
 * @enum {string}
 */
const JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  STOPPING: 'stopping',
  DONE: 'done',
  FAILED: 'failed',
  STOPPED: 'stopped',
  MISSING_SOURCE: 'missing-source',
});

const ALL_STATUSES = Object.freeze(Object.values(JOB_STATUS));

const TERMINAL = new Set([
  JOB_STATUS.DONE,
  JOB_STATUS.FAILED,
  JOB_STATUS.STOPPED,
  JOB_STATUS.STOPPING,
]);

const RESTORABLE = new Set([
  JOB_STATUS.QUEUED,
  JOB_STATUS.RUNNING,
  JOB_STATUS.MISSING_SOURCE,
]);

const LIVE_WORK = new Set([
  JOB_STATUS.RUNNING,
  JOB_STATUS.STOPPING,
]);

const RETRYABLE = new Set([
  JOB_STATUS.FAILED,
  JOB_STATUS.STOPPED,
  JOB_STATUS.MISSING_SOURCE,
]);

const OUTPUT_RESERVED = new Set([
  JOB_STATUS.QUEUED,
  JOB_STATUS.RUNNING,
  JOB_STATUS.STOPPING,
  JOB_STATUS.MISSING_SOURCE,
]);

const TRANSITIONS = Object.freeze({
  [JOB_STATUS.QUEUED]: [
    JOB_STATUS.RUNNING,
    JOB_STATUS.STOPPED,
    JOB_STATUS.FAILED,
    JOB_STATUS.MISSING_SOURCE,
  ],
  [JOB_STATUS.RUNNING]: [
    JOB_STATUS.DONE,
    JOB_STATUS.FAILED,
    JOB_STATUS.STOPPING,
    JOB_STATUS.STOPPED,
    JOB_STATUS.QUEUED,
    JOB_STATUS.MISSING_SOURCE,
  ],
  [JOB_STATUS.STOPPING]: [
    JOB_STATUS.STOPPED,
    JOB_STATUS.FAILED,
    JOB_STATUS.DONE,
    JOB_STATUS.QUEUED,
  ],
  [JOB_STATUS.MISSING_SOURCE]: [
    JOB_STATUS.QUEUED,
    JOB_STATUS.STOPPED,
    JOB_STATUS.FAILED,
  ],
  [JOB_STATUS.FAILED]: [JOB_STATUS.QUEUED],
  [JOB_STATUS.STOPPED]: [JOB_STATUS.QUEUED],
  [JOB_STATUS.DONE]: [],
});

const isKnownStatus = s => ALL_STATUSES.includes(s);
const isTerminal = s => TERMINAL.has(s);
const isRestorable = s => RESTORABLE.has(s);
const isLiveWork = s => LIVE_WORK.has(s);
const isRetryable = s => RETRYABLE.has(s);
const reservesOutput = s => OUTPUT_RESERVED.has(s);

function canTransition(from, to) {
  if (!isKnownStatus(from) || !isKnownStatus(to)) return false;
  return (TRANSITIONS[from] || []).includes(to);
}

function assertJob(job) {
  if (!job || typeof job !== 'object' || typeof job.id !== 'string' || !job.id) {
    throw new TypeError('匯出工作缺少有效 id');
  }
  return job;
}

class ExportQueueState {
  constructor(jobs = []) {
    this._jobs = [];
    this.load(jobs);
  }

  load(jobs = []) {
    if (!Array.isArray(jobs)) throw new TypeError('匯出佇列必須是工作陣列');
    const ids = new Set();
    const next = jobs.map(job => {
      assertJob(job);
      if (ids.has(job.id)) throw new Error(`匯出工作 id 重複：${job.id}`);
      ids.add(job.id);
      return job;
    });
    this._jobs = next;
    return this.jobs();
  }

  jobs() {
    return this._jobs.slice();
  }

  get(jobId) {
    return this._jobs.find(job => job.id === jobId) || null;
  }

  add(job) {
    assertJob(job);
    if (this.get(job.id)) throw new Error(`匯出工作 id 重複：${job.id}`);
    this._jobs.push(job);
    return job;
  }

  nextQueued() {
    return this._jobs.find(job => job.status === JOB_STATUS.QUEUED) || null;
  }

  retry(jobId) {
    const job = this.get(jobId);
    if (!job || !isRetryable(job.status)) return null;
    const queued = this.setStatus(jobId, JOB_STATUS.QUEUED, {
      pct: 0,
      elapsedMs: 0,
      etaS: null,
      errorMsg: null,
    });
    if (!queued) return null;
    delete job.completedAt;
    return job;
  }

  setStatus(jobId, status, fields = null) {
    const job = this.get(jobId);
    if (!job || typeof status !== 'string' || !status) return null;
    if (job.status !== status && !canTransition(job.status, status)) return null;
    job.status = status;
    if (fields && typeof fields === 'object') Object.assign(job, fields);
    return job;
  }

  stop(jobId) {
    const job = this.get(jobId);
    if (!job) return null;
    if (job.status === JOB_STATUS.QUEUED) return this.setStatus(jobId, JOB_STATUS.STOPPED);
    if (job.status === JOB_STATUS.RUNNING) return this.setStatus(jobId, JOB_STATUS.STOPPING);
    return null;
  }

  remove(jobId) {
    const index = this._jobs.findIndex(job => job.id === jobId);
    if (index < 0) return null;
    return this._jobs.splice(index, 1)[0];
  }

  reorder(jobId, newIndex) {
    const oldIndex = this._jobs.findIndex(job => job.id === jobId);
    if (oldIndex < 0) return null;
    const [job] = this._jobs.splice(oldIndex, 1);
    const rawIndex = Number(newIndex);
    const target = Number.isFinite(rawIndex) ? Math.trunc(rawIndex) : this._jobs.length;
    this._jobs.splice(Math.max(0, Math.min(this._jobs.length, target)), 0, job);
    return job;
  }

  liveWorkCount() {
    return this._jobs.filter(job => isLiveWork(job.status)).length;
  }

  statusSnapshot(isPaused = false) {
    return {
      waitingCount: this._jobs.filter(job => job.status === 'queued').length,
      missingCount: this._jobs.filter(job => job.status === 'missing-source').length,
      liveCount: this.liveWorkCount(),
      isPaused: !!isPaused,
    };
  }
}

/**
 * @param {object} deps 全部由呼叫端注入
 * @param {()=>string|null} deps.dir            佇列資料夾（app ready 後才知道）
 * @param {object} [deps.state]                 僅供 recovery 測試注入正式 ExportQueueState
 * @param {object} deps.store                   QueueStore
 * @param {object} deps.history                 QueueHistory
 * @param {object} deps.admission               export-admission 實例
 * @param {(job:object)=>void} deps.grantPersistedCapabilities  恢復時重新授予檔案能力
 * @param {(p:string)=>boolean} deps.canReadSource
 * @param {(p:string)=>boolean} deps.canWriteDelivery
 * @param {(p:string)=>boolean} deps.isFile     同步存在性檢查（恢復時用）
 * @param {(job:object)=>Promise} deps.runJob   實際跑 ffmpeg
 * @param {()=>void} deps.onChanged             狀態變動 → 廣播給視窗
 * @param {(job:object)=>void} [deps.onJobFailed]
 * @param {Map} [deps.activeJobs]               測試可注入的執行中程序表
 * @param {(job:object, patch:object)=>{payload:object,result:object,onCommitted?:()=>void}} [deps.prepareDeliveryUpdate]
 */
function createExportQueue(deps) {
  const {
    dir, store, history,
    admission, grantPersistedCapabilities, canReadSource, canWriteDelivery,
    isFile, runJob, onChanged, onJobFailed, prepareDeliveryUpdate, shutdownRunnerTimeoutMs,
  } = deps;
  const state = deps.state || new ExportQueueState();
  if (!(state instanceof ExportQueueState)) throw new TypeError('匯出佇列只接受正式 ExportQueueState');
  const activeJobs = deps.activeJobs || new Map();

  const log = (msg, err) => console.error(`[Queue] ${msg}`, err ?? '');

  /* 佇列自己的狀態。以前是 main.js 的四個模組層 let。 */
  let paused = false;
  let concurrency = 1;
  let activeCount = 0;
  /* journal 已提交的終態等候 runner finally 清理；journal 寫失敗的終態則留在
     記憶體待重試。在後者成功前 scheduler 必須整體停住，不能讓下一份工作越過它。 */
  const persistedTerminalJobs = new Set();
  const pendingTerminalMutations = new Map();
  const pendingTerminalRunnerExited = new Set();
  /* watchdog 的 completion 只代表 child 已結束；delivery runner 還可能在寫 log、發 terminal
     progress，必須另外保有 queue runner promise，關機時才不會搶在終態前降回 queued。 */
  const activeQueueRunners = new Map();
  /* 關機開始時已存在的 runner 必須自行收尾，或由它的 finally 以 durable snapshot
     轉回 queued；在此集合清空前，scheduler 不能開新工作。 */
  const shutdownPendingRunners = new Set();
  const runnerShutdownTimeoutMs = Number.isFinite(Number(shutdownRunnerTimeoutMs))
    ? Math.max(1, Number(shutdownRunnerTimeoutMs))
    : 5000;

  /* 所有會改 job 的 IPC 操作都先走這裡：先保留完整快照、再持久化，只有成功後
     才廣播和排程。這避免「畫面顯示 queued、磁碟仍是 failed」這種半套交易。 */
  const cloneJob = job => {
    if (typeof structuredClone === 'function') return structuredClone(job);
    return JSON.parse(JSON.stringify(job));
  };
  const restoreJob = (job, snapshot) => {
    for (const key of Object.keys(job)) delete job[key];
    Object.assign(job, snapshot);
  };
  const mutatePersistedJob = (jobId, mutate) => {
    const job = state.get(jobId);
    if (!job) return { ok: false, job: null, error: null };
    const snapshot = cloneJob(job);
    let changed;
    try { changed = mutate(job); } catch (error) { return { ok: false, job, error }; }
    if (!changed) return { ok: false, job, error: null };
    try {
      queue.persistJob(job);
      return { ok: true, job, error: null };
    } catch (error) {
      restoreJob(job, snapshot);
      return { ok: false, job, error };
    }
  };
  const journalledTerminal = status => [JOB_STATUS.DONE, JOB_STATUS.FAILED, JOB_STATUS.STOPPED].includes(status);
  const retainsRetryRecord = status => [JOB_STATUS.FAILED, JOB_STATUS.STOPPED].includes(status);
  const attemptOf = job => {
    const attempt = Number(job?.attempt);
    return Number.isSafeInteger(attempt) && attempt >= 0 ? attempt : 0;
  };
  const hasPendingJournalledTerminal = () =>
    Array.from(pendingTerminalMutations.values()).some(pending => journalledTerminal(pending.status));
  const unsafeShutdownError = () => new Error(
    '終態 outcome journal 尚未保存；為避免重複執行或覆寫已交付輸出，已取消安全關閉。',
  );
  const unsafeShutdownSnapshotError = () => new Error(
    '無法保存關機中的 queued snapshot；為避免遺失可恢復工作，已取消安全關閉。',
  );
  const unsafeShutdownRunnerError = () => new Error(
    'queue runner 尚未在關機期限內收尾；為避免遺失終態，已取消安全關閉。',
  );
  const rememberPendingTerminal = (jobId, status, fields, error) => {
    if (error) pendingTerminalMutations.set(jobId, { status, fields: fields ? cloneJob(fields) : null });
  };
  const persistTerminalStatus = (jobId, status, fields = null) => {
    /* missing-source 是可恢復的診斷狀態，不是 runner 終態墓碑；維持既有 job snapshot
       路徑，讓使用者重啟後仍能修來源再重試。 */
    if (!journalledTerminal(status)) {
      const committed = mutatePersistedJob(jobId, current => state.setStatus(current.id, status, fields));
      if (committed.ok) pendingTerminalMutations.delete(jobId);
      else rememberPendingTerminal(jobId, status, fields, committed.error);
      return committed;
    }

    const job = state.get(jobId);
    if (!job) return { ok: false, job: null, error: null };
    const snapshot = cloneJob(job);
    try {
      if (!state.setStatus(jobId, status, fields)) return { ok: false, job, error: null };
      if (status === JOB_STATUS.DONE && (!Number.isFinite(job.completedAt) || job.completedAt <= 0)) {
        job.completedAt = Date.now();
      }
      /* 終態的 durable commit 是 journal，不是可能在 Windows 被鎖住的舊 job JSON。
         因此 journal 寫成功後，就算 cleanup 暫時失敗也可在重啟時阻止 running 重跑。 */
      store.stageTerminalOutcome(dir(), job);
    } catch (error) {
      restoreJob(job, snapshot);
      rememberPendingTerminal(jobId, status, fields, error);
      return { ok: false, job, error };
    }
    pendingTerminalMutations.delete(jobId);
    persistedTerminalJobs.add(jobId);
    return { ok: true, job, error: null };
  };
  const requeueInterruptedShutdownJob = jobId => {
    const committed = mutatePersistedJob(jobId, current => state.setStatus(current.id, JOB_STATUS.QUEUED, {
      pct: 0,
      elapsedMs: 0,
      etaS: null,
      errorMsg: null,
    }));
    if (committed.ok) shutdownPendingRunners.delete(jobId);
    return committed;
  };

  const queue = {
    shuttingDown: false,
    shutdownPromise: null,

    /* ── 狀態查詢／設定（以前是直接讀寫 main.js 的模組層變數） ────────── */
    get isPaused() { return paused; },
    get concurrency() { return concurrency; },
    jobs() { return state.jobs(); },
    get(jobId) { return state.get(jobId); },
    statusSnapshot() { return state.statusSnapshot(paused); },
    liveWorkCount() { return state.liveWorkCount(); },

    /* 這些只讀／程序表入口讓 runJob adapter 不必碰 main.js 的第二份 Map。 */
    activeJob(jobId) { return activeJobs.get(jobId) || null; },
    activeJobIds() { return Array.from(activeJobs.keys()); },
    registerActiveJob(jobId, active) {
      if (!state.get(jobId) || !active) return false;
      activeJobs.set(jobId, active);
      return true;
    },
    clearActiveJob(jobId) { return activeJobs.delete(jobId); },
    /* 視窗剛完成載入時重送既有快照；這不是狀態變動，不能被 IPC mutation 濫用。 */
    refreshViews() { onChanged(); },

    /* 准入檢查的轉呼叫。主行程在【入列以外】的地方也要跑它
       （送出前的授權檢查、delivery runner 開跑前再確認一次）。 */
    assertJobCapabilities(job) { return admission.assertJobAdmissible(job); },

    setPaused(v) {
      paused = !!v;
      onChanged();
      if (!paused) this.processQueue();
    },
    setConcurrency(c) {
      concurrency = Math.max(1, Math.min(3, parseInt(c, 10) || 1));
      onChanged();
      this.processQueue();
    },

    ensureDir() {
      const d = dir();
      if (!d) throw new Error('匯出佇列目錄尚未初始化');
      store.ensureDir(d);
      return d;
    },

    /* ── 持久化 ─────────────────────────────────────────────────────── */
    persistJob(job) {
      const d = dir();
      if (!d || !job) return;
      const jobs = state.jobs();
      const order = jobs.indexOf(job);
      store.persistJob(d, job, order < 0 ? jobs.length : order);
    },

    persistAll() {
      const d = dir();
      if (!d) return;
      let order = 0;
      for (const job of state.jobs()) {
        /* 已完成工作由 history 保存；failed/stopped 則由 outcome journal 保存完整快照。
           兩者交給 persistJob 都只會寫完再刪 terminal tombstone，白費磁碟往返。 */
        if (job.status === JOB_STATUS.DONE || retainsRetryRecord(job.status)) continue;
        store.persistJob(d, job, order++);
      }
    },

    /* 完成紀錄若不一起刪，清掉的工作下次啟動又會回來。 */
    forgetHistory(jobId) {
      const d = dir();
      if (!d) return false;
      try {
        history.remove(d, jobId);
        return true;
      } catch (e) {
        log(`無法從完成紀錄移除 ${jobId}：`, e);
        return false;
      }
    },

    removeArtifacts(job, { removeAss = true, removeLog = true } = {}) {
      const d = dir();
      if (!job || !d) return false;
      try { store.removeJobFile(d, job.id); } catch (e) {
        log(`無法刪除工作 ${job.id} 的快照：`, e);
        return false;
      }
      if (removeAss && job.assRef) {
        try { store.removeAssFile(d, job.assRef); } catch (e) {
          log(`無法刪除工作 ${job.id} 的字幕暫存：`, e);
          return false;
        }
      }
      if (removeLog) {
        try { store.removeLogFile(d, job.id); } catch (e) {
          log(`無法刪除工作 ${job.id} 的失敗記錄：`, e);
          return false;
        }
      }
      return true;
    },

    /* 終態 journal 的收尾：done 先寫不可執行的完成紀錄，再清工作檔；任一步失敗
       都保留 journal，下一次啟動會重試，而且永遠不會把舊 running snapshot 拿去排程。 */
    finalizeTerminalOutcome(job) {
      const d = dir();
      if (!job || !d) return false;
      if (job.status === JOB_STATUS.DONE) {
        try { history.append(d, job); } catch (error) {
          log(`無法寫入完成紀錄 ${job.id}：`, error);
          return false;
        }
      }
      /* D3/D8：failed/stopped 的 outcome 本身就是跨重啟的可重試記錄；保留 frozen
         ASS／完整 log／journal，只有成功交付可以連同 outcome 一起刪掉。 */
      const delivered = job.status === JOB_STATUS.DONE;
      if (!this.removeArtifacts(job, { removeAss: delivered, removeLog: delivered })) return false;
      if (retainsRetryRecord(job.status)) return true;
      try {
        store.resolveTerminalOutcomes(d, [job.id]);
        return true;
      } catch (error) {
        log(`無法結清工作 ${job.id} 的終態 journal：`, error);
        return false;
      }
    },

    recoverTerminalOutcomes(loadedJobs = [], journalOutcomes = null) {
      const d = dir();
      const outcomes = Array.isArray(journalOutcomes) ? journalOutcomes : store.loadTerminalOutcomes(d);
      const newestPersistedJob = new Map();
      for (const job of loadedJobs) {
        const previous = newestPersistedJob.get(job.id);
        if (!previous || attemptOf(job) > attemptOf(previous)) newestPersistedJob.set(job.id, job);
      }
      const activeOutcomes = [];
      for (const outcome of outcomes) {
        const newer = newestPersistedJob.get(outcome.id);
        /* 重試的新 snapshot 先成功原子寫入、後面才清舊 outcome；若剛好在兩步中斷，
           generation 較大的 queued attempt 必須贏，否則舊 tombstone 會吃掉新工作。 */
        if (newer && attemptOf(newer) > attemptOf(outcome)) {
          try { store.resolveTerminalOutcomes(d, [outcome.id]); } catch (error) {
            log(`無法結清舊 attempt ${outcome.id} 的終態 journal：`, error);
          }
          continue;
        }
        this.finalizeTerminalOutcome(outcome);
        activeOutcomes.push(outcome);
      }
      return activeOutcomes;
    },

    recoverPendingDeletes() {
      const d = dir();
      const deletes = store.loadPendingDeletes(d);
      /* 使用者明確清除優先於尚未收尾的 done outcome：先取消 outcome journal，避免
         下一次重啟又把完成紀錄補回來。刪除 intent 本身已落盤，取消失敗就保留它重試。 */
      const terminalOutcomes = new Map(store.loadTerminalOutcomes(d).map(outcome => [outcome.id, outcome]));
      const ids = new Set(deletes.map(entry => entry.id));
      const resolved = [];
      for (const entry of deletes) {
        const outcome = terminalOutcomes.get(entry.id);
        /* history 還原的 done card 不含 assRef；若它和未收尾 outcome 同時存在，
           要先把原本的 ASS 參照升級寫回 delete journal，才能在 Windows 鎖檔後重啟續刪。 */
        let cleanupEntry = entry;
        if (!cleanupEntry.assRef && outcome?.assRef) {
          cleanupEntry = { ...entry, assRef: outcome.assRef };
          try {
            store.stagePendingDeletes(d, [cleanupEntry]);
          } catch (error) {
            log(`無法補強工作 ${entry.id} 的待刪除 journal：`, error);
            continue;
          }
        }
        if (outcome) {
          try {
            store.resolveTerminalOutcomes(d, [entry.id]);
            terminalOutcomes.delete(entry.id);
          } catch (error) {
            log(`無法取消工作 ${entry.id} 的終態 journal：`, error);
            continue;
          }
        }
        if (this.removeArtifacts(cleanupEntry) && this.forgetHistory(entry.id)) resolved.push(entry.id);
      }
      if (resolved.length) {
        try { store.resolvePendingDeletes(d, resolved); } catch (error) {
          /* 即使 journal 自身暫時無法清空，已完成的刪除仍可安全重做；不可把 State 加回去。 */
          log('無法結清待刪除 journal：', error);
        }
      }
      return ids;
    },

    stageDeletion(jobs) {
      const d = dir();
      if (!d || !Array.isArray(jobs) || !jobs.length) return false;
      try { store.stagePendingDeletes(d, jobs); } catch (error) {
        log('無法保存待刪除 journal：', error);
        return false;
      }
      for (const job of jobs) state.remove(job.id);
      try { this.recoverPendingDeletes(); } catch (error) {
        /* 清理可延後；stagePendingDeletes 已是對使用者可見的 durable commit。 */
        log('無法立即清理待刪除工作：', error);
      }
      return true;
    },

    /* ── 執行前的來源檢查 ───────────────────────────────────────────── */
    inspectSources(job) {
      const d = dir();
      const sourcePaths = admission.sourcePathsOf(job);
      const missing = sourcePaths.filter(sourcePath => {
        try {
          if (!canReadSource(sourcePath)) return true;
          if (!isFile(sourcePath)) return true;
          admission.assertMasterMedia(sourcePath, '匯出來源');
          return false;
        } catch (e) { return true; }
      });
      if (job.assRef) {
        const assPath = store.safeAssPath(d, job.assRef);
        try {
          if (!assPath || !isFile(assPath)) missing.push(assPath || job.assRef);
        } catch (e) { missing.push(assPath || job.assRef); }
      }
      if (missing.length) {
        return {
          ok: false, sourcePaths, status: JOB_STATUS.MISSING_SOURCE,
          errorMsg: `找不到或未授權的來源檔：\n${missing.join('\n')}`,
        };
      }
      try {
        admission.assertOutputFormat(job);
      } catch (error) {
        return { ok: false, sourcePaths, status: JOB_STATUS.FAILED, errorMsg: error.message || String(error) };
      }
      if (!canWriteDelivery(job?.payload?.outPath)) {
        return {
          ok: false, sourcePaths, status: JOB_STATUS.FAILED,
          errorMsg: `匯出輸出位置未經授權：${job?.payload?.outPath || ''}`,
        };
      }
      return { ok: true, sourcePaths, status: null, errorMsg: null };
    },

    /* 僅供 scheduler／restore 使用。retry 只檢查而不改終態，避免失敗重試把原本
       的 failed/missing-source 改成另一個錯誤，使用者就看不到真正原因。 */
    validateSources(job) {
      const inspected = this.inspectSources(job);
      if (inspected.ok) {
        job.sourcePaths = inspected.sourcePaths;
        return true;
      }
      /* 不能執行的交付格式／輸出能力是可重試的 failed，而不是普通 job JSON 的墓碑。
         它和 runner 回報的 failed 一樣必須先寫 outcome，否則 queue-store 會清掉 terminal
         JSON，重啟後這筆失敗列便消失。missing-source 仍走一般 snapshot，讓使用者補回來源。 */
      if (inspected.status === JOB_STATUS.FAILED) {
        const committed = persistTerminalStatus(job.id, JOB_STATUS.FAILED, {
          sourcePaths: inspected.sourcePaths,
          errorMsg: inspected.errorMsg,
        });
        if (!committed.ok) {
          if (committed.error) log(`無法保存工作 ${job.id} 的來源檢查失敗：`, committed.error);
          return false;
        }
        /* 這條路沒有 runner finally；journal 已是 durable commit，接著只盡力清舊 JSON。
           即使 Windows 暫時鎖住，retryJob 仍會以 journal fence 重試收尾。 */
        if (!this.finalizeTerminalOutcome(committed.job)) {
          log(`無法收尾工作 ${job.id} 的來源檢查失敗 outcome`);
        }
        persistedTerminalJobs.delete(job.id);
        return false;
      }
      const committed = mutatePersistedJob(job.id, current => {
        current.sourcePaths = inspected.sourcePaths;
        return state.setStatus(current.id, inspected.status, { errorMsg: inspected.errorMsg });
      });
      if (!committed.ok && committed.error) log(`無法保存工作 ${job.id} 的來源檢查結果：`, committed.error);
      return false;
    },

    /* ── 對外的工作交易 ───────────────────────────────────────────── */
    retryJob(jobId) {
      if (this.shuttingDown) return false;
      const job = state.get(jobId);
      if (!job || typeof isRetryable !== 'function' || !isRetryable(job.status)) return false;
      /* outcome journal 還在時，舊 attempt 的 tombstone 仍會在重啟時壓過同 id 的
         queued snapshot。先清好舊 artifacts，再以遞增 attempt 原子寫入新 snapshot；
         journal 清理失敗也不會造成 ABA，因為啟動時 generation 較新的工作必須勝出。 */
      if (persistedTerminalJobs.has(jobId)) return false;
      let outcome;
      try {
        outcome = store.loadTerminalOutcomes(dir()).find(entry => entry.id === jobId) || null;
      } catch (error) {
        log(`無法讀取重試工作 ${jobId} 的終態 journal：`, error);
        return false;
      }
      if (outcome) {
        if (outcome.status !== job.status || !this.finalizeTerminalOutcome(outcome)) return false;
      }
      const nextAttempt = Math.max(attemptOf(job), attemptOf(outcome)) + 1;
      const inspected = this.inspectSources(job);
      if (!inspected.ok) return false;
      try { admission.assertOutputAvailable(job); } catch (error) { return false; }
      const committed = mutatePersistedJob(jobId, current => {
        current.sourcePaths = inspected.sourcePaths;
        current.attempt = nextAttempt;
        return state.retry(current.id);
      });
      if (!committed.ok) {
        if (committed.error) log(`無法保存重試工作 ${jobId}：`, committed.error);
        return false;
      }
      if (outcome) {
        try { store.resolveTerminalOutcomes(dir(), [jobId]); } catch (error) {
          /* 新 attempt 已落盤；保留舊 journal 也安全，restore 會由較大的 attempt 收斂它。 */
          log(`無法結清重試工作 ${jobId} 的舊終態 journal：`, error);
        }
      }
      onChanged();
      this.processQueue();
      return true;
    },

    stopJob(jobId) {
      const job = state.get(jobId);
      if (!job) return false;
      if (job.status === JOB_STATUS.QUEUED) {
        /* queued→stopped 沒有 runner finally 可替它補 journal；同樣要走終態交易，
           才能跨重啟留下可重試的 frozen snapshot。 */
        const committed = persistTerminalStatus(jobId, JOB_STATUS.STOPPED);
        if (!committed.ok) {
          if (committed.error) log(`無法保存工作 ${jobId} 的停止狀態：`, committed.error);
          return false;
        }
        this.finalizeTerminalOutcome(committed.job);
        persistedTerminalJobs.delete(jobId);
        onChanged();
        this.processQueue();
        return true;
      }
      if (job.status !== JOB_STATUS.RUNNING) return false;
      const active = activeJobs.get(jobId);
      if (!active?.p) return false;
      const committed = mutatePersistedJob(jobId, current => state.stop(current.id));
      if (!committed.ok) {
        if (committed.error) log(`無法保存工作 ${jobId} 的停止狀態：`, committed.error);
        return false;
      }
      active.stopped = true;
      try {
        if (typeof active.stop === 'function') active.stop('user-stop');
        else active.p.kill();
      } catch (error) {
        log(`無法停止工作 ${jobId} 的 ffmpeg：`, error);
      }
      onChanged();
      return true;
    },

    reorderJob(jobId, index) {
      const previous = state.jobs();
      if (!state.reorder(jobId, index)) return false;
      try { this.persistAll(); } catch (error) {
        state.load(previous);
        /* QueueStore 的每個 job snapshot 都是單檔原子寫入；若中途某一檔失敗，
           立即把已寫入的前段補回原本順序。補償也失敗時不廣播，磁碟恢復時仍以
           最後成功快照為準，不會讓畫面先宣稱重排完成。 */
        try { this.persistAll(); } catch (rollbackError) {
          log(`無法回復工作 ${jobId} 的原本順序：`, rollbackError);
        }
        log(`無法保存工作 ${jobId} 的新順序：`, error);
        return false;
      }
      onChanged();
      return true;
    },

    clearJob(jobId) {
      const job = state.get(jobId);
      if (!job || isLiveWork(job.status)) return false;
      if (!this.stageDeletion([job])) return false;
      onChanged();
      return true;
    },

    clearCompleted() {
      const completed = state.jobs().filter(job => job.status === JOB_STATUS.DONE);
      if (!completed.length || !this.stageDeletion(completed)) return 0;
      onChanged();
      return completed.length;
    },

    updateDelivery(jobId, patch) {
      const job = state.get(jobId);
      if (!job) throw new Error('找不到這份匯出工作');
      if (job.status !== JOB_STATUS.QUEUED) throw new Error('只有等待中的工作可以修改交付設定');
      if (typeof prepareDeliveryUpdate !== 'function') throw new Error('匯出佇列未設定交付更新規則');
      const prepared = prepareDeliveryUpdate(job, patch);
      if (!prepared || !prepared.payload || !prepared.result) throw new Error('交付更新規則回傳無效結果');
      const committed = mutatePersistedJob(jobId, current => {
        current.payload = prepared.payload;
        return true;
      });
      if (!committed.ok) {
        throw committed.error || new Error('無法保存交付設定');
      }
      try { prepared.onCommitted?.(); } catch (error) { log(`無法授予工作 ${jobId} 的交付能力：`, error); }
      onChanged();
      return prepared.result;
    },

    reportProgress(jobId, data = {}) {
      const job = state.get(jobId);
      if (!job) return false;
      const terminal = data.done ? JOB_STATUS.DONE
        : data.error ? JOB_STATUS.FAILED
          : data.stopped ? JOB_STATUS.STOPPED
            : null;

      /* 進度是短生命的 UI 資料；終態卻會決定重啟恢復、輸出 lease 與下一份工作，
      因此必須和所有其他 mutation 一樣先落盤。runJob 的 finally 仍負責完成紀錄
         與 artifacts 清理，但監控視窗絕不能先看見尚未保存的 done／failed／stopped。 */
      if (terminal) {
        const fields = terminal === JOB_STATUS.FAILED ? { errorMsg: data.errorMsg } : null;
        const committed = persistTerminalStatus(jobId, terminal, fields);
        if (!committed.ok) {
          if (committed.error) log(`無法保存工作 ${jobId} 的終態：`, committed.error);
          return false;
        }
        if (terminal === JOB_STATUS.FAILED && onJobFailed) { try { onJobFailed(job); } catch (error) {} }
      } else {
        job.pct = data.pct;
        job.elapsedMs = data.elapsedMs;
        job.etaS = data.etaS;
      }
      onChanged();
      return true;
    },

    retryPendingTerminalMutations({ terminalOnly = false } = {}) {
      const pendingEntries = Array.from(pendingTerminalMutations.entries())
        .filter(([, pending]) => !terminalOnly || journalledTerminal(pending.status));
      if (!pendingEntries.length) return true;
      for (const [jobId, pending] of pendingEntries) {
        const runnerExited = pendingTerminalRunnerExited.delete(jobId);
        const committed = persistTerminalStatus(jobId, pending.status, pending.fields);
        if (!committed.ok) {
          if (runnerExited) pendingTerminalRunnerExited.add(jobId);
          if (committed.error) log(`無法重試保存工作 ${jobId} 的終態：`, committed.error);
          return false;
        }
        if (pending.status === JOB_STATUS.FAILED && onJobFailed) { try { onJobFailed(committed.job); } catch (error) {} }
        if (journalledTerminal(pending.status) && runnerExited) {
          /* 原 runner 的 finally 已提前退出；現在由這裡做收尾。無論 cleanup 是否暫時
             失敗，都釋放 lifecycle marker，讓 retryJob 以 journal fence 再次嘗試。 */
          this.finalizeTerminalOutcome(committed.job);
          persistedTerminalJobs.delete(jobId);
          shutdownPendingRunners.delete(jobId);
        }
      }
      onChanged();
      return true;
    },

    /* timeout 後 runner 已經結束、但第一次 queued fallback 寫入失敗時，不能只等下一次
       關機才再試。這個小恢復步驟在 scheduler 入口先跑；未結束的 runner 仍保留 fence。 */
    retryShutdownSnapshots() {
      for (const jobId of Array.from(shutdownPendingRunners)) {
        const job = state.get(jobId);
        if (!job || job.status !== JOB_STATUS.STOPPING) {
          shutdownPendingRunners.delete(jobId);
          continue;
        }
        if (activeQueueRunners.has(jobId)) continue;
        const committed = requeueInterruptedShutdownJob(jobId);
        if (!committed.ok) {
          if (committed.error) log(`無法重試保存工作 ${jobId} 的 queued snapshot：`, committed.error);
          return false;
        }
      }
      return true;
    },

    /* ── 重啟後恢復 ─────────────────────────────────────────────────── */
    restoreJobs() {
      const d = this.ensureDir();
      let jobs;
      let warnings;
      let journalOutcomes;
      let terminalOutcomes;
      let pendingDeleteIds;
      try {
        pendingDeleteIds = this.recoverPendingDeletes();
        /* 先驗 journal 再讀 terminal JSON：若 stopping tombstone 與 stopped outcome 共用
           ASS，queue-store 必須知道這份 ASS 正受 journal 保護，不能提早清掉。 */
        journalOutcomes = store.loadTerminalOutcomes(d);
        ({ jobs, warnings } = store.loadJobs(d, {
          protectedAssRefs: journalOutcomes.map(outcome => outcome.assRef).filter(Boolean),
        }));
        terminalOutcomes = this.recoverTerminalOutcomes(jobs, journalOutcomes);
      } catch (error) {
        /* journal 損毀時不知道哪些工作已被清除或已完成；不猜、更不能讓它們重跑。 */
        state.load([]);
        paused = true;
        log('無法恢復匯出交易 journal，已安全停止排程：', error);
        return;
      }
      const terminalOutcomeIds = new Set(terminalOutcomes.map(outcome => outcome.id));
      const suppressedIds = new Set([...terminalOutcomeIds, ...pendingDeleteIds]);
      state.load([]);
      let restorableCount = 0;
      for (const job of jobs) {
        if (suppressedIds.has(job.id)) continue;
        delete job._persistOrder;
        grantPersistedCapabilities(job);
        /* 依持久化順序逐一加入，才能在碰到舊版重複輸出路徑時保留第一份、
           將後續工作標為 failed（而不是讓兩份彼此衝突後同時失敗）。 */
        state.add(job);
        if (job.status === JOB_STATUS.QUEUED) this.validateSources(job);
        if (reservesOutput(job.status)) {
          try {
            admission.assertOutputAvailable(job);
          } catch (error) {
            /* 還原時才發現的 output collision 也是可重試 failed；不能直接改 State，
               否則 persistAll 會略過 terminal JSON，下一次重啟這筆列就不見。 */
            const committed = persistTerminalStatus(job.id, JOB_STATUS.FAILED, {
              errorMsg: error.message || String(error),
            });
            if (!committed.ok) {
              if (committed.error) log(`無法保存恢復工作 ${job.id} 的輸出衝突：`, committed.error);
            } else {
              if (!this.finalizeTerminalOutcome(committed.job)) {
                log(`無法收尾恢復工作 ${job.id} 的輸出衝突 outcome`);
              }
              persistedTerminalJobs.delete(job.id);
            }
          }
        }
        /* 來源缺失仍要讓使用者看見開機暫停；但剛轉成 failed 的 outcome 已不可排程，
           不該讓它單獨把佇列鎖在「等待繼續」的假狀態。 */
        if (job.status === JOB_STATUS.QUEUED || job.status === JOB_STATUS.MISSING_SOURCE) restorableCount += 1;
      }
      /* failed/stopped 不是可排程 snapshot，卻是 D3/D8 的可操作失敗紀錄：journal 裡
         保留完整 payload/ASS 參照，重啟後也必須回到同一個 State collection，才能重試、
         清除與開啟完整 log。 */
      for (const outcome of terminalOutcomes) {
        if (pendingDeleteIds.has(outcome.id) || !retainsRetryRecord(outcome.status) || state.get(outcome.id)) continue;
        grantPersistedCapabilities(outcome);
        state.add({ ...outcome, senderId: null, pct: 0, etaS: null });
      }
      /* 只有「還能執行的工作」才需要開機暫停等使用者確認；完成紀錄不該讓佇列開機即暫停。
         這一行在完成紀錄載回來之前算，順序不可對調。 */
      paused = restorableCount > 0 || pendingTerminalMutations.size > 0;
      /* 完成紀錄以 done 身分放回同一個 collection，讓監控畫面重啟後看起來和關閉前一樣。
         它們沒有 payload.clips / audioPlan，nextQueued() 也永遠不會選到 done，
         因此不可能被重跑——queue-store 的 terminal tombstone 安全性質不受影響。 */
      try {
        for (const entry of history.load(d)) {
          if (pendingDeleteIds.has(entry.id)) continue;
          if (state.get(entry.id)) continue;
          state.add({ ...entry, senderId: null, pct: 100, etaS: null, errorMsg: null });
        }
      } catch (e) { log('無法載入完成紀錄：', e); }
      for (const warning of warnings) {
        log(`略過無法恢復的工作 ${warning.filePath}：${warning.message}`);
      }
      try {
        store.cleanupOrphanAssFiles(d, state.jobs().map(job => job.assRef).filter(Boolean));
        this.persistAll(); // running 一律落回 queued，並保存最新 missing-source 檢查結果。
      } catch (e) { log('整理恢復後的工作失敗：', e); }
    },

    /* ── 關機收尾 ───────────────────────────────────────────────────── */
    prepareForShutdown() {
      if (this.shutdownPromise) return this.shutdownPromise;
      /* runner 已經報告 done／failed／stopped 卻暫時寫不進 journal 時，RAM 內的
         pending intent 是唯一知道「輸出可能已交付」的證據。關機若把它降成 queued，
         下次啟動會以 -y 重跑並覆寫成品；先重試，仍失敗就拒絕退出。 */
      if (hasPendingJournalledTerminal() && !this.retryPendingTerminalMutations({ terminalOnly: true })) {
        paused = true;
        onChanged();
        return Promise.reject(unsafeShutdownError());
      }
      this.shuttingDown = true;
      paused = true;
      const closingProcesses = [];
      const closingRunners = [];
      for (const job of state.jobs()) {
        if (!isLiveWork(job.status)) continue;
        shutdownPendingRunners.add(job.id);
        /* shutdown 的中斷期保持 stopping：晚到的 done／failed 仍可合法寫入 outcome，
           而 queue runner catch 也知道這不是使用者要求的 failed。確認程序結束且沒有
           pending terminal 後，才在下方把它落回 queued。 */
        if (job.status === JOB_STATUS.RUNNING) {
          state.setStatus(job.id, JOB_STATUS.STOPPING);
        }
        const runner = activeQueueRunners.get(job.id);
        if (runner) closingRunners.push(Promise.resolve(runner).catch(() => {}));
        const active = activeJobs.get(job.id);
        if (!active?.p) continue;
        const alreadyStopped = !!active.stopped;
        if (!alreadyStopped) active.shutdown = true;
        if (typeof active.stop === 'function') {
          if (!alreadyStopped) {
            try { active.stop('shutdown'); } catch (e) {}
          }
          const completion = Promise.resolve(active.completion).catch(() => {});
          closingProcesses.push(Promise.race([
            completion,
            new Promise(resolve => setTimeout(resolve, 5000)),
          ]));
        } else {
          closingProcesses.push(new Promise(resolve => {
            let settled = false;
            const done = () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve();
            };
            const timer = setTimeout(done, 3000);
            active.p.once('close', done);
            if (active.p.exitCode !== null) done();
            else if (!alreadyStopped) { try { active.p.kill(); } catch (e) { done(); } }
          }));
        }
      }
      const shutdown = (async () => {
        await Promise.all(closingProcesses);
        /* watchdog controller 關閉後，delivery runner 仍可能 await finishLog() 才 dispatch done。
           必須等 queue runner 的 finally 也結束，否則 STOPPING→QUEUED 會讓晚到 done
           變成非法轉移、遺失唯一的 terminal intent。 */
        if (closingRunners.length) {
          let runnerTimer;
          const runnersSettled = await Promise.race([
            Promise.all(closingRunners).then(() => true, () => false),
            new Promise(resolve => { runnerTimer = setTimeout(() => resolve(false), runnerShutdownTimeoutMs); }),
          ]);
          clearTimeout(runnerTimer);
          if (!runnersSettled) throw unsafeShutdownRunnerError();
        }
        if (hasPendingJournalledTerminal() && !this.retryPendingTerminalMutations({ terminalOnly: true })) {
          throw unsafeShutdownError();
        }
        for (const job of state.jobs()) {
          if (!shutdownPendingRunners.has(job.id)) continue;
          if (job.status !== JOB_STATUS.STOPPING) {
            shutdownPendingRunners.delete(job.id);
            continue;
          }
          const committed = requeueInterruptedShutdownJob(job.id);
          if (!committed.ok) {
            if (committed.error) log(`關閉前無法保存工作 ${job.id} 的 queued snapshot：`, committed.error);
            throw unsafeShutdownSnapshotError();
          }
        }
        try { this.persistAll(); } catch (e) {
          /* 已確認沒有未保存的終態，仍不能把沒有 snapshot 的 stopping tombstone 留給重啟。
             只有 queued fallback durable 後才可退出；否則這筆被中斷工作會整筆消失。 */
          log('關閉前無法更新工作快照：', e);
          throw unsafeShutdownSnapshotError();
        }
      })();
      this.shutdownPromise = shutdown;
      shutdown.catch(() => {
        if (this.shutdownPromise !== shutdown) return;
        /* 保持 pause，讓使用者恢復磁碟後可再次嘗試；不能留下 shuttingDown 鎖死 UI。 */
        this.shutdownPromise = null;
        this.shuttingDown = false;
        paused = true;
        onChanged();
      });
      return this.shutdownPromise;
    },

    /* ── 入列與排程 ─────────────────────────────────────────────────── */
    addJob(job) {
      if (this.shuttingDown) throw new Error('程式正在關閉，無法再加入匯出工作');
      const d = this.ensureDir();
      job.sourcePaths = store.collectSourcePaths(job.payload);
      admission.assertJobAdmissible(job);
      admission.assertOutputAvailable(job);
      state.add(job);
      try { store.persistJob(d, job, state.jobs().length - 1); } catch (error) {
        state.remove(job.id);
        throw error;
      }
      onChanged();
      this.processQueue();
    },

    async processQueue() {
      if (paused || this.shuttingDown) return;
      if (!this.retryPendingTerminalMutations()) return;
      if (!this.retryShutdownSnapshots()) return;
      /* timeout 後仍要先允許既有 terminal journal recovery 清掉 fence；但在仍有
         未收尾 runner 時，不能開始任何新工作。 */
      if (shutdownPendingRunners.size) return;
      while (activeCount < concurrency) {
        const job = state.nextQueued();
        if (!job) break;
        if (!this.validateSources(job)) {
          /* 來源檢查成功寫成 terminal error 後才廣播；持久化失敗則保持 queued
             並停止本輪，避免同一份工作在 while 裡無限重試。 */
          if (state.get(job.id)?.status !== JOB_STATUS.QUEUED) {
            onChanged();
            continue;
          }
          return;
        }
        const started = mutatePersistedJob(job.id, current =>
          state.setStatus(current.id, JOB_STATUS.RUNNING));
        if (!started.ok) {
          if (started.error) log(`無法保存工作 ${job.id} 的執行狀態：`, started.error);
          return;
        }
        activeCount++;
        onChanged();

        const runner = (async () => {
          try {
            await runJob(job);
          } catch (e) {
            log(`Job ${job.id} error:`, e);
            const alreadyTerminal = [JOB_STATUS.DONE, JOB_STATUS.FAILED, JOB_STATUS.STOPPED, JOB_STATUS.MISSING_SOURCE]
              .includes(job.status);
            if (!alreadyTerminal && !(this.shuttingDown && (job.status === JOB_STATUS.QUEUED || job.status === JOB_STATUS.STOPPING))) {
              const status = e.code === 'MISSING_SOURCE' ? JOB_STATUS.MISSING_SOURCE : JOB_STATUS.FAILED;
              const committed = persistTerminalStatus(job.id, status, { errorMsg: e.message || String(e) });
              if (!committed.ok) {
                if (committed.error) log(`無法保存工作 ${job.id} 的終態：`, committed.error);
              } else if (status === JOB_STATUS.FAILED) {
                if (onJobFailed) { try { onJobFailed(job); } catch (e2) {} }
              }
            }
          } finally {
            activeCount--;
            /* reportProgress(done) 後 runner 仍可能在收尾；使用者此時已明確清除，
               pending-delete journal 優先，不能讓晚到 finally 再寫回 history。 */
            if (!state.get(job.id)) {
              persistedTerminalJobs.delete(job.id);
              pendingTerminalMutations.delete(job.id);
              pendingTerminalRunnerExited.delete(job.id);
              shutdownPendingRunners.delete(job.id);
              if (!this.shuttingDown) this.processQueue();
              return;
            }
            /* 終態的 rollback 代表磁碟仍是 running；此時廣播或排下一份都會讓 UI／
               排程宣稱不存在的交易已完成。保留該筆工作，待磁碟可寫或重啟後再恢復。 */
            if (pendingTerminalMutations.has(job.id)) {
              pendingTerminalRunnerExited.add(job.id);
              return;
            }
            try {
              /* reportProgress／catch 的終態已先記入 journal；finally 只做可重試清理。
                 舊 adapter 若直接 mutation，仍保守保留原本的 job snapshot 行為。 */
              if (persistedTerminalJobs.delete(job.id)) {
                this.finalizeTerminalOutcome(job);
                shutdownPendingRunners.delete(job.id);
              }
              /* prepareForShutdown 會在所有 runner 收尾後才把 stopping 落回 queued。
                 此刻若交給 queue-store 寫 stopping，terminal tombstone 規則可能先刪掉
                 唯一的 running snapshot；強制中止時便會讓工作無從恢復。 */
              else if (shutdownPendingRunners.has(job.id) && job.status === JOB_STATUS.STOPPING) {
                /* runner 一旦真正結束，就已沒有晚到 terminal 的窗口；無論關機 promise
                   是否剛 timeout，都由它自己原子寫回 queued，不能持久化 stopping tombstone。 */
                const committed = requeueInterruptedShutdownJob(job.id);
                if (!committed.ok) {
                  paused = true;
                  if (committed.error) log(`無法保存工作 ${job.id} 的延後 queued snapshot：`, committed.error);
                }
              } else this.persistJob(job);
            } catch (e) {
              log(`無法更新工作 ${job.id} 的持久化狀態：`, e);
              return;
            }
            if (!this.shuttingDown) {
              onChanged();
              this.processQueue();
            }
          }
        })();
        activeQueueRunners.set(job.id, runner);
        /* 即使 runner 在第一個 await 前同步失敗，then 也會在本輪結束後清掉 map；
           prepareForShutdown 同時持有自己的 snapshot，因此不會漏等已開始的收尾。 */
        runner.then(
          () => { if (activeQueueRunners.get(job.id) === runner) activeQueueRunners.delete(job.id); },
          () => { if (activeQueueRunners.get(job.id) === runner) activeQueueRunners.delete(job.id); },
        );
      }
    },
  };

  return queue;
}

/**
 * @param {object} deps 全部由呼叫端注入——本模組不 require electron、不碰檔案系統
 * @param {(format:string)=>string} deps.expectedExtensionFor  format → 預期副檔名（不含點）
 * @param {(outPath:string)=>string} deps.outputKeyFor         輸出路徑 → 佔用鍵（大小寫／路徑正規化）
 * @param {(payload:object, sourcePaths:string[])=>string[]} deps.mergeSourcePaths
 * @param {()=>Array} deps.currentJobs                         目前佇列裡的工作
 * @param {(status:string)=>boolean} deps.reservesOutput       這個狀態算不算佔用輸出
 * @param {(file:string)=>boolean} deps.canReadSource
 * @param {(file:string)=>boolean} deps.canWriteDelivery
 * @param {(file:string)=>boolean} deps.isPreviewCacheMedia    §0.8：是不是播放快取
 */
function createExportAdmission(deps) {
  const {
    expectedExtensionFor, outputKeyFor, mergeSourcePaths, currentJobs,
    reservesOutput: depsReservesOutput, canReadSource, canWriteDelivery, isPreviewCacheMedia,
  } = deps;

  const activeReservesOutput = typeof depsReservesOutput === 'function' ? depsReservesOutput : reservesOutput;

  const fail = (message, code) => {
    const error = new Error(message);
    error.code = code;
    return error;
  };

  /** 輸出路徑 → 佔用鍵。缺路徑就是資料有問題，不可以靜靜放過。 */
  function outputKey(job) {
    const outPath = job?.payload?.outPath;
    if (typeof outPath !== 'string' || !outPath.trim()) {
      throw fail('匯出工作缺少有效的輸出路徑', 'INVALID_OUTPUT_PATH');
    }
    return outputKeyFor(outPath);
  }

  /* renderer 用一份 format→副檔名的表組出 outPath，主程序用另一份驗它。
     兩份目前只靠人工維持一致；這裡是它們真正相遇的地方。 */
  function assertOutputFormat(job) {
    const outPath = job?.payload?.outPath;
    const expected = expectedExtensionFor(job?.payload?.format);
    const actual = typeof outPath === 'string' ? path.extname(outPath).slice(1).toLowerCase() : '';
    if (actual === expected) return expected;
    throw fail(
      `匯出格式 ${job?.payload?.format || '(empty)'} 必須使用 .${expected} 副檔名`,
      'INVALID_OUTPUT_EXTENSION',
    );
  }

  /* 同一個輸出檔同時被兩份交付寫入＝後者覆蓋前者，而兩邊都會回報成功。
     注意這是【入列時】的檢查；export-watchdog 那邊另有一道磁碟上的 lease，
     在真正 spawn 前再擋一次。兩道時機不同，都需要。 */
  function assertOutputAvailable(job, excludeId = job?.id) {
    const key = outputKey(job);
    for (const existing of currentJobs()) {
      if (!existing || existing.id === excludeId || !activeReservesOutput(existing.status)) continue;
      let existingKey;
      try { existingKey = outputKey(existing); } catch (error) { continue; }
      if (existingKey !== key) continue;
      const error = fail(`同一個輸出檔案已在匯出佇列中：${job.payload.outPath}`, 'OUTPUT_BUSY');
      error.conflictingJobId = existing.id;
      throw error;
    }
    return key;
  }

  /* 匯出 payload 是 renderer 的資料快照，不能因為進了佇列就自動升格成檔案能力。 */
  function sourcePathsOf(job) {
    return mergeSourcePaths(job?.payload, job?.sourcePaths);
  }

  /** 鐵律 §0.8：交付只准讀母素材，絕不可回退播放快取（proxy.mp4／chNN.m4a）。 */
  function assertMasterMedia(file, kind) {
    if (isPreviewCacheMedia(file)) {
      throw fail(`${kind} 匯出不能使用 Proxy 或播放快取。請重新連結母素材後再匯出。`, 'PREVIEW_CACHE_MEDIA');
    }
  }

  /**
   * 入列前的完整檢查。通過才可以進佇列。
   * @returns {string[]} 這份工作實際需要讀取的來源路徑
   */
  function assertJobAdmissible(job) {
    assertOutputFormat(job);
    const sourcePaths = sourcePathsOf(job);
    for (const sourcePath of sourcePaths) {
      if (!canReadSource(sourcePath)) {
        throw fail(`匯出來源未經授權：${sourcePath}`, 'UNAUTHORIZED_PATH');
      }
      assertMasterMedia(sourcePath, '匯出來源');
    }
    if (!canWriteDelivery(job?.payload?.outPath)) {
      throw fail(`匯出輸出位置未經授權：${job?.payload?.outPath}`, 'UNAUTHORIZED_OUTPUT_PATH');
    }
    return sourcePaths;
  }

  return {
    outputKey, assertOutputFormat, assertOutputAvailable,
    sourcePathsOf, assertMasterMedia, assertJobAdmissible,
  };
}

module.exports = {
  createExportQueue,
  createExportAdmission,
  ExportQueueState,
  JOB_STATUS,
  ALL_STATUSES,
  TRANSITIONS,
  isKnownStatus,
  isTerminal,
  isRestorable,
  isLiveWork,
  isRetryable,
  reservesOutput,
  canTransition,
};
