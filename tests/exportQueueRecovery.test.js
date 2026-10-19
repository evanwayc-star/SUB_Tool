import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const QueueStore = require('../electron/queue-store.js');
const { createExportQueue, ExportQueueState, JOB_STATUS } = require('../electron/export-queue.js');
const { FileAuthority } = require('../electron/file-authority.js');
const { createIpcGuards } = require('../electron/ipc-guards.js');

function makeQueue(queueDir, state, store = QueueStore, overrides = {}) {
  return createExportQueue({
    dir: () => queueDir,
    state,
    store,
    history: overrides.history || { append: () => {}, remove: () => {}, load: () => [] },
    admission: {
      sourcePathsOf: job => job.sourcePaths || job.payload?.sources || [],
      assertMasterMedia: () => {},
      assertOutputFormat: () => {},
      assertOutputAvailable: () => {},
      assertJobAdmissible: () => {},
    },
    grantPersistedCapabilities: overrides.grantPersistedCapabilities || (() => {}),
    grantCompletedOutputReveal: overrides.grantCompletedOutputReveal,
    canReadSource: overrides.canReadSource || (() => true),
    canWriteDelivery: overrides.canWriteDelivery || (() => true),
    isFile: overrides.isFile || (() => true),
    runJob: overrides.runJob || (async () => {}),
    onChanged: overrides.onChanged || (() => {}),
  });
}

function job(id, sourcePath, assRef) {
  return {
    id,
    status: JOB_STATUS.RUNNING,
    createdAt: 1234,
    attempt: 0,
    assRef,
    sourcePaths: [sourcePath],
    payload: {
      outPath: path.join(path.dirname(sourcePath), `${id}.mp4`),
      format: 'h264',
      sources: [sourcePath],
      clips: [{ path: sourcePath }],
    },
  };
}

describe('匯出佇列 outcome 跨重啟復原', () => {
  it.each(['history', 'outcome'])('已完成 %s 復原只授權精確輸出定位，不能讀寫或重新執行', async origin => {
    const queueDir = mkdtempSync(path.join(tmpdir(), 'subtool-history-reveal-'));
    try {
      const sourcePath = path.join(queueDir, 'source.mxf'); writeFileSync(sourcePath, 'source');
      const completed = { ...job('completed', sourcePath, null), status: JOB_STATUS.DONE };
      writeFileSync(completed.payload.outPath, 'completed delivery');
      if (origin === 'history') QueueStore.QueueHistory.append(queueDir, completed);
      else QueueStore.stageTerminalOutcome(queueDir, completed);
      const authority = new FileAuthority(), guards = createIpcGuards(authority), calls = [];
      const state = new ExportQueueState();
      const queue = makeQueue(queueDir, state, QueueStore, {
        history: QueueStore.QueueHistory,
        grantCompletedOutputReveal: file => authority.grantDeliveryReveal(file),
        grantPersistedCapabilities: current => calls.push(['executable-grant', current.id]),
        runJob: async current => calls.push(['run', current.id]),
      });
      queue.restoreJobs();
      expect(state.get(completed.id)).toMatchObject({ status: JOB_STATUS.DONE });
      expect(() => guards.requirePermittedDeliveryRevealPath(completed.payload.outPath)).not.toThrow();
      for (const other of [sourcePath, path.dirname(completed.payload.outPath), path.join(queueDir, 'sibling.mp4')]) {
        expect(() => guards.requirePermittedDeliveryRevealPath(other)).toThrow();
      }
      expect(authority.canRead(completed.payload.outPath)).toBe(false);
      expect(authority.canWriteDelivery(completed.payload.outPath)).toBe(false);
      expect(queue.retryJob(completed.id)).toBe(false);
      await queue.processQueue(); expect(calls).toEqual([]);
    } finally { rmSync(queueDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  });

  it.each(['stopped', 'done'])('停止執行中的工作先保存意圖，原生 close 後才裁定 %s', async outcome => {
    const queueDir = mkdtempSync(path.join(tmpdir(), 'subtool-queue-stop-intent-'));
    let finish;
    const completion = new Promise(resolve => { finish = resolve; });
    let queue, runner;
    try {
      const sourcePath = path.join(queueDir, 'source.mxf'); writeFileSync(sourcePath, 'source');
      const assRef = 'frozen.ass'; QueueStore.writeAssFile(queueDir, assRef, 'frozen subtitles');
      const current = { ...job('held-native-stop', sourcePath, assRef), status: JOB_STATUS.QUEUED };
      const state = new ExportQueueState(); let stopCalls = 0;
      queue = makeQueue(queueDir, state, QueueStore, { runJob: async running => {
        queue.registerActiveJob(running.id, { stopped: false, completion, stop() { stopCalls++; } });
        await completion;
        queue.reportProgress(running.id, outcome === 'done' ? { done: true } : { stopped: true });
      } });
      queue.addJob(current);
      expect(state.get(current.id).status).toBe(JOB_STATUS.RUNNING);
      expect(queue.stopJob(current.id)).toBe(true);
      expect(stopCalls).toBe(1);
      expect(state.get(current.id).status).toBe(JOB_STATUS.STOPPING);
      expect(QueueStore.loadTerminalOutcomes(queueDir)).toEqual([
        expect.objectContaining({ id: current.id, status: JOB_STATUS.STOPPED, assRef, payload: current.payload }),
      ]);
      const restarted = new ExportQueueState(), calls = [];
      const restoredQueue = makeQueue(queueDir, restarted, QueueStore, { runJob: async item => calls.push(item.id) });
      restoredQueue.restoreJobs(); await restoredQueue.processQueue();
      expect(restarted.get(current.id)).toMatchObject({ status: JOB_STATUS.STOPPED, assRef, payload: current.payload });
      expect(readFileSync(path.join(queueDir, assRef), 'utf8')).toBe('frozen subtitles');
      expect(calls).toEqual([]);
      runner = queue.prepareForShutdown(); finish(); await runner;
      expect(state.get(current.id).status).toBe(outcome);
      expect(QueueStore.loadTerminalOutcomes(queueDir).map(item => item.status)).toEqual(outcome === 'done' ? [] : [outcome]);
    } finally {
      finish(); if (queue) await queue.prepareForShutdown().catch(() => {});
      rmSync(queueDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('停止意圖寫入失敗時保留 running snapshot，不送出原生停止', () => {
    const queueDir = mkdtempSync(path.join(tmpdir(), 'subtool-queue-stop-rollback-'));
    try {
      const sourcePath = path.join(queueDir, 'source.mxf'); writeFileSync(sourcePath, 'source');
      const current = job('stop-rollback', sourcePath, null), state = new ExportQueueState([current]);
      QueueStore.persistJob(queueDir, current);
      let stops = 0;
      const queue = makeQueue(queueDir, state, {
        ...QueueStore, stageTerminalOutcome() { throw new Error('journal locked'); },
      });
      queue.registerActiveJob(current.id, { stop() { stops++; }, completion: Promise.resolve() });
      expect(queue.stopJob(current.id)).toBe(false);
      expect(state.get(current.id).status).toBe(JOB_STATUS.RUNNING);
      expect(JSON.parse(readFileSync(QueueStore.jobPath(queueDir, current.id), 'utf8')).status).toBe(JOB_STATUS.RUNNING);
      expect(stops).toBe(0);
      expect(QueueStore.loadTerminalOutcomes(queueDir)).toEqual([]);
    } finally { rmSync(queueDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  });

  it.each([false, true])('取消已結束的 shutdown 釋放准入並保留原暫停意圖（paused=%s）', async initiallyPaused => {
    const queueDir = mkdtempSync(path.join(tmpdir(), 'subtool-queue-cancel-shutdown-'));
    try {
      const sourcePath = path.join(queueDir, 'source.mxf');
      writeFileSync(sourcePath, 'source');
      const calls = [];
      const state = new ExportQueueState();
      const queue = makeQueue(queueDir, state, QueueStore, { runJob: async current => { calls.push(current.id); } });
      queue.setPaused(initiallyPaused);
      const closing = queue.prepareForShutdown();
      await closing;
      expect(queue.shuttingDown).toBe(true);
      await expect(queue.cancelShutdown()).resolves.toBe(true);
      expect(queue.shuttingDown).toBe(false);
      expect(queue.shutdownPromise).toBeNull();
      expect(queue.isPaused).toBe(initiallyPaused);
      const fresh = { ...job('fresh-after-cancel', sourcePath, null), status: JOB_STATUS.QUEUED };
      expect(() => queue.addJob(fresh)).not.toThrow();
      expect(calls).toEqual(initiallyPaused ? [] : [fresh.id]);
      const nextClose = queue.prepareForShutdown();
      expect(nextClose).not.toBe(closing);
      await nextClose;
    } finally { rmSync(queueDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  });

  it('取消仍在收尾的 shutdown 等 close barrier，不自行重新執行被中止的工作', async () => {
    const queueDir = mkdtempSync(path.join(tmpdir(), 'subtool-queue-cancel-draining-'));
    let finish;
    const completion = new Promise(resolve => { finish = resolve; });
    try {
      const sourcePath = path.join(queueDir, 'source.mxf');
      writeFileSync(sourcePath, 'source');
      const interrupted = job('interrupted', sourcePath, null);
      const state = new ExportQueueState([interrupted]);
      const calls = [];
      const queue = makeQueue(queueDir, state, QueueStore, { runJob: async current => { calls.push(current.id); } });
      queue.registerActiveJob(interrupted.id, { stop() {}, completion });
      const closing = queue.prepareForShutdown();
      let reopened = false;
      const reopening = queue.cancelShutdown().then(result => { reopened = result; });
      await Promise.resolve();
      expect(reopened).toBe(false);
      const fresh = { ...job('fresh-while-draining', sourcePath, null), status: JOB_STATUS.QUEUED };
      expect(() => queue.addJob(fresh)).toThrow(/正在關閉/);
      finish();
      await Promise.all([closing, reopening]);
      expect(reopened).toBe(true);
      expect(queue.isPaused).toBe(true);
      expect(state.get(interrupted.id)).toMatchObject({ status: JOB_STATUS.QUEUED });
      expect(JSON.parse(readFileSync(QueueStore.jobPath(queueDir, interrupted.id), 'utf8'))).toMatchObject({ status: JOB_STATUS.QUEUED });
      expect(() => queue.addJob(fresh)).not.toThrow();
      await queue.processQueue();
      expect(calls).toEqual([]);
    } finally { finish(); rmSync(queueDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  });

  it('關閉期間較新的手動暫停不被取消退出時的舊暫停值覆蓋', async () => {
    const queueDir = mkdtempSync(path.join(tmpdir(), 'subtool-queue-cancel-pause-'));
    try {
      const queue = makeQueue(queueDir, new ExportQueueState());
      const closing = queue.prepareForShutdown();
      queue.setPaused(true);
      await closing;
      await queue.cancelShutdown();
      expect(queue.isPaused).toBe(true);
    } finally { rmSync(queueDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  });

  it('history 暫時讀不到時保留done journal，復原後合併舊紀錄而不重跑交付', () => {
    const queueDir = mkdtempSync(path.join(tmpdir(), 'subtool-history-read-recovery-'));
    try {
      const sourcePath = path.join(queueDir, 'source.mxf');
      writeFileSync(sourcePath, 'source');
      const completed = { ...job('new-completed', sourcePath, null), status: JOB_STATUS.DONE };
      QueueStore.QueueHistory.append(queueDir, { ...completed, id: 'old-completed' });
      QueueStore.stageTerminalOutcome(queueDir, completed);
      const historyPath = QueueStore.QueueHistory.historyPath(queueDir);
      const before = readFileSync(historyPath);
      const state = new ExportQueueState();
      state.add(completed);
      const queue = makeQueue(queueDir, state, QueueStore, { history: QueueStore.QueueHistory });
      const original = fs.readFileSync;
      fs.readFileSync = (file, ...args) => {
        if (file === historyPath) throw Object.assign(new Error('history temporarily locked'), { code: 'EACCES' });
        return original(file, ...args);
      };
      try { expect(queue.finalizeTerminalOutcome(completed)).toBe(false); }
      finally { fs.readFileSync = original; }
      expect(readFileSync(historyPath)).toEqual(before);
      expect(QueueStore.loadTerminalOutcomes(queueDir).map(item => item.id)).toEqual(['new-completed']);
      const restored = new ExportQueueState();
      makeQueue(queueDir, restored, QueueStore, { history: QueueStore.QueueHistory }).restoreJobs();
      expect(restored.jobs().map(item => [item.id, item.status])).toEqual(expect.arrayContaining([
        ['new-completed', JOB_STATUS.DONE], ['old-completed', JOB_STATUS.DONE],
      ]));
      expect(restored.jobs()).toHaveLength(2);
      expect(QueueStore.loadTerminalOutcomes(queueDir)).toEqual([]);
      expect(QueueStore.QueueHistory.load(queueDir).map(item => item.id)).toEqual(['old-completed', 'new-completed']);
    } finally { rmSync(queueDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  });

  it.each(['malformed', 'unknown-schema'])('history %s 備份失敗保留 done journal，重啟後只補記而不重跑交付', mode => {
    const queueDir = mkdtempSync(path.join(tmpdir(), 'subtool-history-backup-recovery-'));
    try {
      const sourcePath = path.join(queueDir, 'source.mxf'); writeFileSync(sourcePath, 'source');
      const completed = { ...job('new-completed', sourcePath, null), status: JOB_STATUS.DONE };
      const old = { ...completed, id: 'old-completed' };
      QueueStore.QueueHistory.append(queueDir, old);
      const file = QueueStore.QueueHistory.historyPath(queueDir), valid = readFileSync(file, 'utf8');
      const raw = Buffer.from(mode === 'malformed' ? valid.trimEnd().slice(0, -1) : valid.replace('"version": 1', '"version": 999'));
      writeFileSync(file, raw); QueueStore.stageTerminalOutcome(queueDir, completed);
      const state = new ExportQueueState(); state.add(completed);
      const queue = makeQueue(queueDir, state, QueueStore, { history: QueueStore.QueueHistory });
      const original = fs.writeFileSync;
      fs.writeFileSync = (target, ...args) => {
        if (String(target).startsWith(file + '.corrupt-')) throw Object.assign(new Error('backup temporarily locked'), { code: 'EACCES' });
        return original(target, ...args);
      };
      try { expect(queue.finalizeTerminalOutcome(completed)).toBe(false); }
      finally { fs.writeFileSync = original; }
      expect(readFileSync(file)).toEqual(raw);
      expect(QueueStore.loadTerminalOutcomes(queueDir).map(entry => entry.id)).toEqual(['new-completed']);
      let runs = 0;
      const restored = new ExportQueueState();
      makeQueue(queueDir, restored, QueueStore, { history: QueueStore.QueueHistory, runJob: async () => { runs++; } }).restoreJobs();
      expect(runs).toBe(0);
      expect(restored.jobs().map(entry => [entry.id, entry.status])).toEqual([['new-completed', JOB_STATUS.DONE]]);
      expect(QueueStore.loadTerminalOutcomes(queueDir)).toEqual([]);
      const backups = fs.readdirSync(queueDir).filter(name => name.startsWith('history.json.corrupt-'));
      expect(backups).toHaveLength(1);
      expect(readFileSync(path.join(queueDir, backups[0]))).toEqual(raw);
    } finally { rmSync(queueDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  });

  it('stopping tombstone 無法安全寫回 queued snapshot 時，關機會被拒絕直到可跨重啟恢復', async () => {
    const queueDir = mkdtempSync(path.join(tmpdir(), 'subtool-queue-shutdown-snapshot-'));
    try {
      const sourcePath = path.join(queueDir, 'source.mxf');
      writeFileSync(sourcePath, 'source', 'utf8');
      const interrupted = job('shutdown-snapshot', sourcePath, null);
      interrupted.status = JOB_STATUS.QUEUED;
      QueueStore.persistJob(queueDir, interrupted);
      /* queue-store 對 stopping 採 terminal tombstone；這正是關機轉回 queued 必須落盤的理由。 */
      QueueStore.persistJob(queueDir, { ...interrupted, status: JOB_STATUS.STOPPING });
      expect(existsSync(QueueStore.jobPath(queueDir, interrupted.id))).toBe(false);

      const state = new ExportQueueState();
      state.add({ ...interrupted, status: JOB_STATUS.STOPPING });
      let writable = false;
      const store = {
        ...QueueStore,
        persistJob: (dir, current, order) => {
          if (!writable) throw new Error('queue snapshot temporarily locked');
          return QueueStore.persistJob(dir, current, order);
        },
      };
      const queue = makeQueue(queueDir, state, store);

      await expect(queue.prepareForShutdown()).rejects.toThrow(/queued snapshot|安全關閉/);
      expect(queue.shuttingDown).toBe(false);
      expect(state.get(interrupted.id)).toMatchObject({ status: JOB_STATUS.STOPPING });
      expect(existsSync(QueueStore.jobPath(queueDir, interrupted.id))).toBe(false);

      writable = true;
      await queue.prepareForShutdown();
      const restartedState = new ExportQueueState();
      makeQueue(queueDir, restartedState).restoreJobs();
      expect(restartedState.get(interrupted.id)).toMatchObject({ status: JOB_STATUS.QUEUED });
    } finally {
      rmSync(queueDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('runner 結束後若終態 journal 仍無法落盤，關機會被拒絕而不把已知終態降回 queued', async () => {
    const queueDir = mkdtempSync(path.join(tmpdir(), 'subtool-queue-shutdown-fence-'));
    try {
      const sourcePath = path.join(queueDir, 'source.mxf');
      writeFileSync(sourcePath, 'source', 'utf8');
      const state = new ExportQueueState();
      const failedJob = job('shutdown-fence', sourcePath, null);
      failedJob.status = JOB_STATUS.QUEUED;
      state.add(failedJob);
      let writable = false;
      let queue;
      const store = {
        ...QueueStore,
        stageTerminalOutcome: (dir, outcome) => {
          if (!writable) throw new Error('journal temporarily locked');
          return QueueStore.stageTerminalOutcome(dir, outcome);
        },
      };
      queue = makeQueue(queueDir, state, store, {
        runJob: async current => {
          queue.reportProgress(current.id, { error: true, errorMsg: 'ffmpeg failed after delivery' });
        },
      });

      await queue.processQueue();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(state.get(failedJob.id)).toMatchObject({ status: JOB_STATUS.RUNNING });
      expect(queue.retryPendingTerminalMutations({ terminalOnly: true })).toBe(false);

      await expect(queue.prepareForShutdown()).rejects.toThrow(/終態.*journal|安全關閉/);
      expect(queue.shuttingDown).toBe(false);
      await queue.cancelShutdown();
      expect(queue.isPaused).toBe(true);
      expect(state.get(failedJob.id)).toMatchObject({ status: JOB_STATUS.RUNNING });
      expect(JSON.parse(readFileSync(QueueStore.jobPath(queueDir, failedJob.id), 'utf8'))).toMatchObject({
        status: JOB_STATUS.RUNNING,
      });

      writable = true;
      await queue.prepareForShutdown();
      const restartedState = new ExportQueueState();
      makeQueue(queueDir, restartedState).restoreJobs();
      expect(restartedState.get(failedJob.id)).toMatchObject({ status: JOB_STATUS.FAILED });
    } finally {
      rmSync(queueDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('失敗紀錄可跨重啟重試，較新的 attempt 不會被舊 outcome 壓掉', () => {
    const queueDir = mkdtempSync(path.join(tmpdir(), 'subtool-queue-outcome-'));
    try {
      const sourcePath = path.join(queueDir, 'source.mxf');
      const assRef = 'retryable.ass';
      writeFileSync(sourcePath, 'source', 'utf8');
      QueueStore.writeAssFile(queueDir, assRef, 'subtitle');

      const firstState = new ExportQueueState();
      const failedJob = job('retryable', sourcePath, assRef);
      firstState.add(failedJob);
      QueueStore.persistJob(queueDir, failedJob);
      const firstQueue = makeQueue(queueDir, firstState);
      expect(firstQueue.reportProgress(failedJob.id, { error: true, errorMsg: 'ffmpeg failed' })).toBe(true);
      expect(firstQueue.finalizeTerminalOutcome(failedJob)).toBe(true);

      const retryState = new ExportQueueState();
      const failResolveStore = {
        ...QueueStore,
        resolveTerminalOutcomes: () => { throw new Error('journal temporarily locked'); },
      };
      const retryQueue = makeQueue(queueDir, retryState, failResolveStore);
      retryQueue.restoreJobs();
      expect(retryState.get(failedJob.id)).toMatchObject({ status: JOB_STATUS.FAILED, attempt: 0 });

      retryQueue.setPaused(true);
      expect(retryQueue.retryJob(failedJob.id)).toBe(true);
      expect(retryState.get(failedJob.id)).toMatchObject({ status: JOB_STATUS.QUEUED, attempt: 1 });
      expect(QueueStore.loadTerminalOutcomes(queueDir)).toHaveLength(1);

      const restoredState = new ExportQueueState();
      const restoredQueue = makeQueue(queueDir, restoredState);
      restoredQueue.restoreJobs();

      expect(restoredState.get(failedJob.id)).toMatchObject({ status: JOB_STATUS.QUEUED, attempt: 1 });
      expect(QueueStore.loadTerminalOutcomes(queueDir)).toEqual([]);
      expect(existsSync(path.join(queueDir, assRef))).toBe(true);
    } finally {
      rmSync(queueDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('殘留 stopping JSON 不會刪掉同一 outcome 為 stopped 保留的 ASS snapshot', () => {
    const queueDir = mkdtempSync(path.join(tmpdir(), 'subtool-queue-stopping-'));
    try {
      const sourcePath = path.join(queueDir, 'source.mxf');
      const assRef = 'stopping.ass';
      writeFileSync(sourcePath, 'source', 'utf8');
      QueueStore.writeAssFile(queueDir, assRef, 'subtitle');
      const stopped = job('stopping-recovery', sourcePath, assRef);
      stopped.status = JOB_STATUS.STOPPED;
      QueueStore.persistJob(queueDir, { ...stopped, status: JOB_STATUS.QUEUED });
      const recordPath = QueueStore.jobPath(queueDir, stopped.id);
      const residual = JSON.parse(readFileSync(recordPath, 'utf8'));
      residual.status = JOB_STATUS.STOPPING;
      writeFileSync(recordPath, JSON.stringify(residual), 'utf8');
      QueueStore.stageTerminalOutcome(queueDir, stopped);

      const state = new ExportQueueState();
      makeQueue(queueDir, state).restoreJobs();

      expect(state.get(stopped.id)).toMatchObject({ status: JOB_STATUS.STOPPED, assRef });
      expect(existsSync(path.join(queueDir, assRef))).toBe(true);
    } finally {
      rmSync(queueDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
