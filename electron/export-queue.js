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
   - 實際跑 ffmpeg 的 _runJobLogic 留在 main.js，由 runJob 注入——
     它牽涉 spawn、log 檔、進度回報，是另一項職責。
   - 准入政策在 export-admission.js。

   【相依一律注入】不 require electron，也不直接碰 BrowserWindow，
   所以起得了 vitest。
============================================================================== */

/**
 * @param {object} deps 全部由呼叫端注入
 * @param {()=>string|null} deps.dir            佇列資料夾（app ready 後才知道）
 * @param {object} [deps.state]                 ExportQueueState 實例（測試可注入）
 * @param {()=>object} [deps.createState]       正式執行時建立狀態的工廠
 * @param {object} deps.store                   QueueStore
 * @param {object} deps.history                 QueueHistory
 * @param {object} deps.JOB_STATUS
 * @param {(s:string)=>boolean} deps.isLiveWork
 * @param {(s:string)=>boolean} deps.reservesOutput
 * @param {(s:string)=>boolean} [deps.isRetryable]
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
    dir, store, history, JOB_STATUS, isLiveWork, reservesOutput,
    admission, grantPersistedCapabilities, canReadSource, canWriteDelivery,
    isFile, runJob, onChanged, onJobFailed, isRetryable, prepareDeliveryUpdate,
  } = deps;
  const state = deps.state || deps.createState?.();
  if (!state) throw new TypeError('匯出佇列需要 ExportQueueState');
  const activeJobs = deps.activeJobs || new Map();

  const log = (msg, err) => console.error(`[Queue] ${msg}`, err ?? '');

  /* 佇列自己的狀態。以前是 main.js 的四個模組層 let。 */
  let paused = false;
  let concurrency = 1;
  let activeCount = 0;

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
       （送出前的授權檢查、_runJobLogic 開跑前再確認一次）。 */
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
        /* 已完成的工作由 history 保存；交給 persistJob 只會寫完再刪（tombstone），
           白費一次磁碟往返。 */
        if (job.status === JOB_STATUS.DONE) continue;
        store.persistJob(d, job, order++);
      }
    },

    /* 完成紀錄若不一起刪，清掉的工作下次啟動又會回來。 */
    forgetHistory(jobId) {
      const d = dir();
      if (!d) return;
      try { history.remove(d, jobId); } catch (e) { log(`無法從完成紀錄移除 ${jobId}：`, e); }
    },

    removeArtifacts(job, { removeAss = true } = {}) {
      const d = dir();
      if (!job || !d) return;
      try { store.removeJobFile(d, job.id); } catch (e) { log(`無法刪除工作 ${job.id} 的快照：`, e); }
      if (removeAss && job.assRef) {
        try { store.removeAssFile(d, job.assRef); } catch (e) { log(`無法刪除工作 ${job.id} 的字幕暫存：`, e); }
      }
      try { store.removeLogFile(d, job.id); } catch (e) { log(`無法刪除工作 ${job.id} 的失敗記錄：`, e); }
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
      const inspected = this.inspectSources(job);
      if (!inspected.ok) return false;
      try { admission.assertOutputAvailable(job); } catch (error) { return false; }
      const committed = mutatePersistedJob(jobId, current => {
        current.sourcePaths = inspected.sourcePaths;
        return state.retry(current.id);
      });
      if (!committed.ok) {
        if (committed.error) log(`無法保存重試工作 ${jobId}：`, committed.error);
        return false;
      }
      onChanged();
      this.processQueue();
      return true;
    },

    stopJob(jobId) {
      const job = state.get(jobId);
      if (!job) return false;
      if (job.status === JOB_STATUS.QUEUED) {
        const committed = mutatePersistedJob(jobId, current => state.stop(current.id));
        if (!committed.ok) {
          if (committed.error) log(`無法保存工作 ${jobId} 的停止狀態：`, committed.error);
          return false;
        }
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
      this.removeArtifacts(job);
      this.forgetHistory(jobId);
      state.remove(jobId);
      onChanged();
      return true;
    },

    clearCompleted() {
      const completed = state.jobs().filter(job => job.status === JOB_STATUS.DONE);
      for (const job of completed) {
        this.removeArtifacts(job);
        state.remove(job.id);
      }
      try { history.clear?.(dir()); } catch (error) { log('無法清除完成紀錄：', error); }
      if (completed.length) onChanged();
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
      if (data.done) {
        if (!state.setStatus(jobId, JOB_STATUS.DONE)) return false;
        if (!Number.isFinite(job.completedAt) || job.completedAt <= 0) job.completedAt = Date.now();
      } else if (data.error) {
        if (!state.setStatus(jobId, JOB_STATUS.FAILED, { errorMsg: data.errorMsg })) return false;
        if (onJobFailed) { try { onJobFailed(job); } catch (error) {} }
      } else if (data.stopped) {
        if (!state.setStatus(jobId, JOB_STATUS.STOPPED)) return false;
      } else {
        job.pct = data.pct;
        job.elapsedMs = data.elapsedMs;
        job.etaS = data.etaS;
      }
      onChanged();
      return true;
    },

    /* ── 重啟後恢復 ─────────────────────────────────────────────────── */
    restoreJobs() {
      const d = this.ensureDir();
      const { jobs, warnings } = store.loadJobs(d);
      state.load([]);
      for (const job of jobs) {
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
            state.setStatus(job.id, JOB_STATUS.FAILED, { errorMsg: error.message || String(error) });
          }
        }
      }
      /* 只有「還能執行的工作」才需要開機暫停等使用者確認；完成紀錄不該讓佇列開機即暫停。
         這一行在完成紀錄載回來之前算，順序不可對調。 */
      paused = jobs.length > 0;
      /* 完成紀錄以 done 身分放回同一個 collection，讓監控畫面重啟後看起來和關閉前一樣。
         它們沒有 payload.clips / audioPlan，nextQueued() 也永遠不會選到 done，
         因此不可能被重跑——queue-store 的 terminal tombstone 安全性質不受影響。 */
      try {
        for (const entry of history.load(d)) {
          if (state.get(entry.id)) continue;
          state.add({ ...entry, senderId: null, pct: 100, etaS: null, errorMsg: null });
        }
      } catch (e) { log('無法載入完成紀錄：', e); }
      for (const warning of warnings) {
        log(`略過無法恢復的工作 ${warning.filePath}：${warning.message}`);
      }
      try {
        store.cleanupOrphanAssFiles(d, jobs.map(job => job.assRef).filter(Boolean));
        this.persistAll(); // running 一律落回 queued，並保存最新 missing-source 檢查結果。
      } catch (e) { log('整理恢復後的工作失敗：', e); }
    },

    /* ── 關機收尾 ───────────────────────────────────────────────────── */
    prepareForShutdown() {
      if (this.shutdownPromise) return this.shutdownPromise;
      this.shuttingDown = true;
      paused = true;
      const closingProcesses = [];
      for (const job of state.jobs()) {
        if (!isLiveWork(job.status)) continue;
        if (job.status === JOB_STATUS.RUNNING) {
          state.setStatus(job.id, JOB_STATUS.QUEUED, {
            pct: 0,
            elapsedMs: 0,
            etaS: null,
            errorMsg: null,
          });
        }
        const active = activeJobs.get(job.id);
        if (!active?.p) continue;
        active.shutdown = true;
        if (typeof active.stop === 'function') {
          try { active.stop('shutdown'); } catch (e) {}
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
            else { try { active.p.kill(); } catch (e) { done(); } }
          }));
        }
      }
      try { this.persistAll(); } catch (e) {
        // 即使磁碟暫時不可寫，也必須繼續等待 ffmpeg 關閉並清掉半成品。
        log('關閉前無法更新工作快照：', e);
      }
      this.shutdownPromise = (async () => { await Promise.all(closingProcesses); })();
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

        (async () => {
          try {
            await runJob(job);
          } catch (e) {
            log(`Job ${job.id} error:`, e);
            if (!(this.shuttingDown && (job.status === JOB_STATUS.QUEUED || job.status === JOB_STATUS.STOPPING))) {
              const status = e.code === 'MISSING_SOURCE' ? JOB_STATUS.MISSING_SOURCE : JOB_STATUS.FAILED;
              if (state.setStatus(job.id, status, { errorMsg: e.message || String(e) })) {
                if (onJobFailed) { try { onJobFailed(job); } catch (e2) {} }
              }
            }
          } finally {
            activeCount--;
            try {
              this.persistJob(job);
              if (job.status === JOB_STATUS.DONE) {
                // 半成品與字幕暫存照樣清掉；只把「這份交付完成過」這件事留成紀錄。
                this.removeArtifacts(job);
                try { history.append(dir(), job); } catch (historyError) {
                  log(`無法寫入完成紀錄 ${job.id}：`, historyError);
                }
              }
            } catch (e) { log(`無法更新工作 ${job.id} 的持久化狀態：`, e); }
            if (!this.shuttingDown) {
              onChanged();
              this.processQueue();
            }
          }
        })();
      }
    },
  };

  return queue;
}

module.exports = { createExportQueue };
