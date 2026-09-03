import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const QueueStore = require('../electron/queue-store.js');
const { createExportQueue, ExportQueueState, JOB_STATUS } = require('../electron/export-queue.js');

function makeQueue(queueDir, state, store = QueueStore, overrides = {}) {
  return createExportQueue({
    dir: () => queueDir,
    state,
    store,
    history: { append: () => {}, remove: () => {}, load: () => [] },
    admission: {
      sourcePathsOf: job => job.sourcePaths || job.payload?.sources || [],
      assertMasterMedia: () => {},
      assertOutputFormat: () => {},
      assertOutputAvailable: () => {},
      assertJobAdmissible: () => {},
    },
    grantPersistedCapabilities: () => {},
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
