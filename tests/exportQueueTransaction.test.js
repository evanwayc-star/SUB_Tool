import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createExportQueue } = require('../electron/export-queue.js');
const { ExportQueueState } = require('../electron/export-queue-state.js');
const { JOB_STATUS, isLiveWork, isRetryable, reservesOutput } = require('../electron/export-job-status.js');

function make({ persistJob = () => {}, activeJobs, runJob = async () => {}, prepareDeliveryUpdate } = {}) {
  const state = new ExportQueueState();
  const onChanged = vi.fn();
  const queue = createExportQueue({
    dir: () => 'D:/queue',
    state,
    store: {
      ensureDir: () => {}, persistJob,
      removeJobFile: () => {}, removeAssFile: () => {}, removeLogFile: () => {},
      collectSourcePaths: payload => payload?.sources || [],
      safeAssPath: (dir, ref) => dir + '/' + ref,
      loadJobs: () => ({ jobs: [], warnings: [] }), cleanupOrphanAssFiles: () => {},
    },
    history: { append: () => {}, remove: () => {}, load: () => [] },
    JOB_STATUS, isLiveWork, isRetryable, reservesOutput,
    admission: {
      sourcePathsOf: job => job.sourcePaths || job.payload?.sources || [],
      assertMasterMedia: () => {}, assertOutputFormat: () => {}, assertOutputAvailable: () => {}, assertJobAdmissible: () => {},
    },
    grantPersistedCapabilities: () => {},
    canReadSource: () => true, canWriteDelivery: () => true, isFile: () => true,
    runJob, onChanged, activeJobs, prepareDeliveryUpdate,
  });
  return { queue, state, onChanged };
}

function job(id, status) {
  return {
    id, status, pct: 40, elapsedMs: 2000, etaS: 5, errorMsg: 'old failure', completedAt: 123,
    payload: { outPath: 'D:/out/' + id + '.mp4', format: 'h264', sources: ['D:/source.mxf'] },
  };
}

describe('匯出佇列 transaction seam', () => {
  it('重試持久化失敗時回復原本終態，不通知或排程半套結果', () => {
    const { queue, state, onChanged } = make({ persistJob: () => { throw new Error('disk full'); } });
    state.add(job('failed-job', JOB_STATUS.FAILED));

    expect(queue.retryJob('failed-job')).toBe(false);
    expect(state.get('failed-job')).toMatchObject({
      status: JOB_STATUS.FAILED, pct: 40, elapsedMs: 2000, etaS: 5, errorMsg: 'old failure', completedAt: 123,
    });
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('開始執行前若無法把 running 狀態落盤，就不啟動 ffmpeg', async () => {
    const runJob = vi.fn(async () => {});
    const { queue, state, onChanged } = make({ persistJob: () => { throw new Error('disk full'); }, runJob });
    state.add(job('queued-job', JOB_STATUS.QUEUED));

    await queue.processQueue();

    expect(runJob).not.toHaveBeenCalled();
    expect(state.get('queued-job').status).toBe(JOB_STATUS.QUEUED);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('停止中的狀態若未保存成功，不會先對仍在跑的 ffmpeg 發送停止訊號', () => {
    const stop = vi.fn();
    const activeJobs = new Map([['running-job', { p: { kill: vi.fn() }, stop }]]);
    const { queue, state, onChanged } = make({ persistJob: () => { throw new Error('disk full'); }, activeJobs });
    state.add(job('running-job', JOB_STATUS.RUNNING));

    expect(queue.stopJob('running-job')).toBe(false);
    expect(state.get('running-job').status).toBe(JOB_STATUS.RUNNING);
    expect(stop).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('交付設定持久化失敗時不改 payload，也不先擴張交付檔案能力', () => {
    const onCommitted = vi.fn();
    const { queue, state, onChanged } = make({
      persistJob: () => { throw new Error('disk full'); },
      prepareDeliveryUpdate: current => ({
        payload: { ...current.payload, outPath: 'D:/out/new.mov', format: 'prores' },
        result: { outPath: 'D:/out/new.mov', format: 'prores' },
        onCommitted,
      }),
    });
    state.add(job('queued-job', JOB_STATUS.QUEUED));

    expect(() => queue.updateDelivery('queued-job', { format: 'prores' })).toThrow('disk full');
    expect(state.get('queued-job').payload).toMatchObject({
      outPath: 'D:/out/queued-job.mp4', format: 'h264',
    });
    expect(onCommitted).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('重排持久化失敗時回復原本順序，不通知假的新順序', () => {
    const { queue, state, onChanged } = make({ persistJob: () => { throw new Error('disk full'); } });
    state.add(job('first', JOB_STATUS.QUEUED));
    state.add(job('second', JOB_STATUS.QUEUED));

    expect(queue.reorderJob('second', 0)).toBe(false);
    expect(state.jobs().map(item => item.id)).toEqual(['first', 'second']);
    expect(onChanged).not.toHaveBeenCalled();
  });
});
