import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createExportQueue } = require('../electron/export-queue.js');
const { ExportQueueState } = require('../electron/export-queue-state.js');
const { JOB_STATUS, isLiveWork, isRetryable, reservesOutput } = require('../electron/export-job-status.js');

function make({
  persistJob = () => {}, activeJobs, runJob = async () => {}, onJobFailed, prepareDeliveryUpdate,
  removeJobFile = () => {}, removeAssFile = () => {}, removeLogFile = () => {}, historyRemove = () => {},
  historyAppend = () => {},
  stageTerminalOutcome, stagePendingDeletes, storedJobs = [], storedHistory = [],
  terminalOutcomes = [], pendingDeletes = [],
  grantPersistedCapabilities = () => {}, admissionOverrides = {}, shutdownRunnerTimeoutMs,
} = {}) {
  const state = new ExportQueueState();
  const onChanged = vi.fn();
  let terminalJournal = structuredClone(terminalOutcomes);
  let deleteJournal = structuredClone(pendingDeletes);
  const stageTerminal = stageTerminalOutcome || ((dir, nextJob) => {
    terminalJournal = terminalJournal.filter(outcome => outcome.id !== nextJob.id);
    terminalJournal.push(structuredClone(nextJob));
    return terminalJournal;
  });
  const stageDeletes = stagePendingDeletes || ((dir, jobs) => {
    for (const nextJob of jobs) {
      const index = deleteJournal.findIndex(entry => entry.id === nextJob.id);
      const assRef = (index >= 0 ? deleteJournal[index].assRef : null) || nextJob.assRef || null;
      if (index >= 0) deleteJournal[index] = { id: nextJob.id, assRef };
      else deleteJournal.push({ id: nextJob.id, assRef });
    }
    return deleteJournal;
  });
  const queue = createExportQueue({
    dir: () => 'D:/queue',
    state,
    store: {
      ensureDir: () => {}, persistJob,
      removeJobFile, removeAssFile, removeLogFile,
      collectSourcePaths: payload => payload?.sources || [],
      safeAssPath: (dir, ref) => dir + '/' + ref,
      loadJobs: () => ({ jobs: storedJobs, warnings: [] }), cleanupOrphanAssFiles: () => {},
      stageTerminalOutcome: stageTerminal,
      loadTerminalOutcomes: () => structuredClone(terminalJournal),
      resolveTerminalOutcomes: (dir, ids) => {
        const finished = new Set(ids);
        terminalJournal = terminalJournal.filter(outcome => !finished.has(outcome.id));
        return terminalJournal;
      },
      stagePendingDeletes: stageDeletes,
      loadPendingDeletes: () => structuredClone(deleteJournal),
      resolvePendingDeletes: (dir, ids) => {
        const finished = new Set(ids);
        deleteJournal = deleteJournal.filter(entry => !finished.has(entry.id));
        return deleteJournal;
      },
    },
    history: { append: historyAppend, remove: historyRemove, load: () => storedHistory },
    JOB_STATUS, isLiveWork, isRetryable, reservesOutput,
    admission: {
      sourcePathsOf: job => job.sourcePaths || job.payload?.sources || [],
      assertMasterMedia: () => {}, assertOutputFormat: () => {}, assertOutputAvailable: () => {}, assertJobAdmissible: () => {},
      ...admissionOverrides,
    },
    grantPersistedCapabilities,
    canReadSource: () => true, canWriteDelivery: () => true, isFile: () => true,
    runJob, onChanged, onJobFailed, activeJobs, prepareDeliveryUpdate,
    shutdownRunnerTimeoutMs,
  });
  return {
    queue, state, onChanged,
    terminalOutcomes: () => structuredClone(terminalJournal),
    pendingDeletes: () => structuredClone(deleteJournal),
  };
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

  it('未結清的 terminal outcome 先結清才可重試，避免重啟時吞掉新的 queued snapshot', () => {
    const persistJob = vi.fn();
    const terminal = { ...job('retry-fence', JOB_STATUS.FAILED), assRef: 'burn_retry.ass' };
    const retryable = { ...job('retry-fence', JOB_STATUS.FAILED), assRef: 'burn_retry.ass' };
    const { queue, state } = make({
      persistJob,
      storedJobs: [job('retry-fence', JOB_STATUS.RUNNING)],
      terminalOutcomes: [terminal],
      removeJobFile: () => { throw new Error('access denied'); },
    });
    state.add(retryable);

    expect(queue.retryJob('retry-fence')).toBe(false);
    expect(state.get('retry-fence')).toMatchObject({ status: JOB_STATUS.FAILED });
    expect(persistJob).not.toHaveBeenCalled();

    queue.restoreJobs();
    expect(state.get('retry-fence')).toMatchObject({ status: JOB_STATUS.FAILED, assRef: 'burn_retry.ass' });
  });

  it('failed outcome 結清後保留 frozen ASS，重試會以同一份快照重新入列', () => {
    const persistJob = vi.fn();
    const removeAssFile = vi.fn();
    const failed = { ...job('retry-snapshot', JOB_STATUS.FAILED), assRef: 'burn_retry.ass' };
    const { queue, state, terminalOutcomes } = make({
      persistJob,
      removeAssFile,
      terminalOutcomes: [failed],
    });
    state.add(failed);
    queue.setPaused(true);

    expect(queue.retryJob('retry-snapshot')).toBe(true);
    expect(state.get('retry-snapshot')).toMatchObject({ status: JOB_STATUS.QUEUED, assRef: 'burn_retry.ass' });
    expect(terminalOutcomes()).toEqual([]);
    expect(removeAssFile).not.toHaveBeenCalled();
    expect(persistJob).toHaveBeenCalled();
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

  it('runner 的終態先寫入 durable outcome journal，才通知監控視窗', () => {
    const calls = [];
    const { queue, state, onChanged } = make({ stageTerminalOutcome: () => calls.push('journal') });
    onChanged.mockImplementation(() => calls.push('notify'));
    state.add(job('running-job', JOB_STATUS.RUNNING));

    expect(queue.reportProgress('running-job', { done: true })).toBe(true);
    expect(state.get('running-job').status).toBe(JOB_STATUS.DONE);
    expect(calls).toEqual(['journal', 'notify']);
  });

  it('關機會等 queue runner 寫完晚到終態，不能在 watchdog completion 後先落回 queued', async () => {
    const activeJobs = new Map();
    const persistJob = vi.fn();
    let queue;
    let releaseRunner;
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const runJob = current => new Promise(resolve => {
      activeJobs.set(current.id, {
        p: {},
        stop: vi.fn(),
        completion: Promise.resolve(),
      });
      releaseRunner = () => {
        expect(queue.reportProgress(current.id, { done: true })).toBe(true);
        resolve();
      };
      markStarted();
    });
    const setup = make({ activeJobs, persistJob, runJob });
    ({ queue } = setup);
    setup.state.add(job('late-done', JOB_STATUS.QUEUED));

    await queue.processQueue();
    await started;
    const shutdown = queue.prepareForShutdown();
    let settled = false;
    shutdown.then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(settled).toBe(false);
    expect(setup.state.get('late-done')).toMatchObject({ status: JOB_STATUS.STOPPING });

    releaseRunner();
    await shutdown;

    expect(setup.state.get('late-done')).toMatchObject({ status: JOB_STATUS.DONE });
    expect(persistJob.mock.calls.map(([, current]) => current.status)).not.toContain(JOB_STATUS.QUEUED);
  });

  it('queue runner 逾時未收尾會取消退出，之後收尾才可安全寫回 queued', async () => {
    const activeJobs = new Map();
    let writable = true;
    const persistJob = vi.fn(() => {
      if (!writable) throw new Error('queued snapshot temporarily locked');
    });
    let queue;
    let releaseRunner;
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const runJob = current => new Promise(resolve => {
      activeJobs.set(current.id, {
        p: {},
        stop: vi.fn(),
        completion: Promise.resolve(),
      });
      releaseRunner = resolve;
      markStarted();
    });
    const setup = make({ activeJobs, persistJob, runJob, shutdownRunnerTimeoutMs: 1 });
    ({ queue } = setup);
    setup.state.add(job('runner-timeout', JOB_STATUS.QUEUED));

    await queue.processQueue();
    await started;
    writable = false;
    await expect(queue.prepareForShutdown()).rejects.toThrow(/runner|安全關閉/);
    expect(queue.shuttingDown).toBe(false);
    expect(setup.state.get('runner-timeout')).toMatchObject({ status: JOB_STATUS.STOPPING });

    releaseRunner();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(setup.state.get('runner-timeout')).toMatchObject({ status: JOB_STATUS.STOPPING });
    expect(queue.retryShutdownSnapshots()).toBe(false);

    writable = true;
    expect(queue.retryShutdownSnapshots()).toBe(true);
    expect(setup.state.get('runner-timeout')).toMatchObject({ status: JOB_STATUS.QUEUED });
  });

  it('開始前驗證發現無法交付時，也以 failed outcome 留下可重試紀錄', async () => {
    const { queue, state, terminalOutcomes } = make({
      admissionOverrides: {
        assertOutputFormat: () => { throw new Error('交付格式不合法'); },
      },
    });
    state.add(job('invalid-before-run', JOB_STATUS.QUEUED));

    await queue.processQueue();

    expect(state.get('invalid-before-run')).toMatchObject({
      status: JOB_STATUS.FAILED,
      errorMsg: '交付格式不合法',
    });
    expect(terminalOutcomes()).toEqual([
      expect.objectContaining({ id: 'invalid-before-run', status: JOB_STATUS.FAILED }),
    ]);

    const restored = make({ terminalOutcomes: terminalOutcomes() });
    restored.queue.restoreJobs();
    expect(restored.state.get('invalid-before-run')).toMatchObject({ status: JOB_STATUS.FAILED });
  });

  it('恢復時發現輸出路徑衝突，也以 failed outcome 保存而非遺失工作', () => {
    const first = job('first-output', JOB_STATUS.QUEUED);
    const conflicting = job('conflicting-output', JOB_STATUS.QUEUED);
    conflicting.payload.outPath = first.payload.outPath;
    const { queue, state, terminalOutcomes } = make({
      storedJobs: [first, conflicting],
      admissionOverrides: {
        assertOutputAvailable: current => {
          if (current.id === conflicting.id) throw new Error('輸出路徑已被保留');
        },
      },
    });

    queue.restoreJobs();

    expect(state.get(conflicting.id)).toMatchObject({
      status: JOB_STATUS.FAILED,
      errorMsg: '輸出路徑已被保留',
    });
    expect(terminalOutcomes()).toEqual([
      expect.objectContaining({ id: conflicting.id, status: JOB_STATUS.FAILED }),
    ]);

    const restored = make({ terminalOutcomes: terminalOutcomes() });
    restored.queue.restoreJobs();
    expect(restored.state.get(conflicting.id)).toMatchObject({ status: JOB_STATUS.FAILED });
  });

  it('failed outcome 收尾會刪可執行快照但保留完整失敗 log，直到使用者清除', () => {
    const removeLogFile = vi.fn();
    const removeAssFile = vi.fn();
    const { queue, state } = make({ removeLogFile, removeAssFile });
    const failed = job('failed-job', JOB_STATUS.FAILED);
    failed.assRef = 'burn_failed.ass';
    state.add(failed);

    expect(queue.reportProgress('failed-job', { error: true, errorMsg: 'ffmpeg failed' })).toBe(true);
    expect(queue.finalizeTerminalOutcome(failed)).toBe(true);
    expect(removeLogFile).not.toHaveBeenCalled();
    expect(removeAssFile).not.toHaveBeenCalled();
  });

  it('使用者明確清除 failed 工作時才刪除保留的失敗 log', () => {
    const removeLogFile = vi.fn();
    const { queue, state } = make({ removeLogFile });
    state.add(job('failed-job', JOB_STATUS.FAILED));

    expect(queue.clearJob('failed-job')).toBe(true);
    expect(removeLogFile).toHaveBeenCalledWith('D:/queue', 'failed-job');
  });

  it('尚未開始的工作停止也寫入可跨重啟的 stopped outcome', () => {
    const first = make();
    const queued = { ...job('queued-stop', JOB_STATUS.QUEUED), assRef: 'burn_stopped.ass' };
    first.state.add(queued);

    expect(first.queue.stopJob('queued-stop')).toBe(true);
    expect(first.terminalOutcomes()).toEqual([expect.objectContaining({
      id: 'queued-stop', status: JOB_STATUS.STOPPED, assRef: 'burn_stopped.ass',
    })]);

    const restored = make({ terminalOutcomes: first.terminalOutcomes() });
    restored.queue.restoreJobs();
    expect(restored.state.get('queued-stop')).toMatchObject({ status: JOB_STATUS.STOPPED, assRef: 'burn_stopped.ass' });
    restored.queue.setPaused(true);
    expect(restored.queue.retryJob('queued-stop')).toBe(true);
    expect(restored.state.get('queued-stop')).toMatchObject({ status: JOB_STATUS.QUEUED, attempt: 1 });
  });

  it('runner 終態無法落盤時回復原狀，不通知半套結果', () => {
    const { queue, state, onChanged } = make({ stageTerminalOutcome: () => { throw new Error('disk full'); } });
    state.add(job('running-job', JOB_STATUS.RUNNING));

    expect(queue.reportProgress('running-job', { error: true, errorMsg: 'ffmpeg failed' })).toBe(false);
    expect(state.get('running-job')).toMatchObject({ status: JOB_STATUS.RUNNING, errorMsg: 'old failure' });
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('失敗監控視窗只會在終態保存成功後才打開', () => {
    const onJobFailed = vi.fn();
    const { queue, state } = make({ onJobFailed });
    state.add(job('running-job', JOB_STATUS.RUNNING));

    expect(queue.reportProgress('running-job', { error: true, errorMsg: 'ffmpeg failed' })).toBe(true);
    expect(onJobFailed).toHaveBeenCalledWith(expect.objectContaining({
      id: 'running-job', status: JOB_STATUS.FAILED, errorMsg: 'ffmpeg failed',
    }));
  });

  it('runner 丟例外但終態無法落盤時，保留 running 並不通知或排程下一份', async () => {
    const runJob = vi.fn(async () => { throw new Error('ffmpeg ended unexpectedly'); });
    const onJobFailed = vi.fn();
    const { queue, state, onChanged } = make({
      stageTerminalOutcome: () => { throw new Error('disk full'); },
      runJob,
      onJobFailed,
    });
    state.add(job('first', JOB_STATUS.QUEUED));
    state.add(job('second', JOB_STATUS.QUEUED));

    await queue.processQueue();
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(runJob).toHaveBeenCalledTimes(1);
    expect(state.get('first').status).toBe(JOB_STATUS.RUNNING);
    expect(state.get('second').status).toBe(JOB_STATUS.QUEUED);
    expect(onJobFailed).not.toHaveBeenCalled();
    onChanged.mockClear();
    queue.setConcurrency(2);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('終態 journal 恢復可寫後，會先提交原 outcome 才恢復排程', async () => {
    let writable = false;
    const runJob = vi.fn(async () => {
      if (runJob.mock.calls.length === 1) throw new Error('ffmpeg ended unexpectedly');
    });
    const { queue, state } = make({
      stageTerminalOutcome: () => {
        if (!writable) throw new Error('disk full');
      },
      runJob,
    });
    state.add(job('first', JOB_STATUS.QUEUED));
    state.add(job('second', JOB_STATUS.QUEUED));

    await queue.processQueue();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(state.get('first').status).toBe(JOB_STATUS.RUNNING);
    expect(runJob).toHaveBeenCalledTimes(1);

    writable = true;
    await queue.processQueue();
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(state.get('first').status).toBe(JOB_STATUS.FAILED);
    expect(runJob).toHaveBeenCalledTimes(2);

    queue.setPaused(true);
    expect(queue.retryJob('first')).toBe(true);
    expect(state.get('first').status).toBe(JOB_STATUS.QUEUED);
  });

  it('清除意圖落盤後，即使 snapshots 清理失敗也不會留下可復活的工作', () => {
    const historyRemove = vi.fn();
    const { queue, state, onChanged, pendingDeletes } = make({
      removeJobFile: () => { throw new Error('access denied'); },
      historyRemove,
    });
    state.add(job('failed-job', JOB_STATUS.FAILED));

    expect(queue.clearJob('failed-job')).toBe(true);
    expect(state.get('failed-job')).toBeNull();
    expect(historyRemove).not.toHaveBeenCalled();
    expect(pendingDeletes()).toEqual([{ id: 'failed-job', assRef: null }]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('清除完成工作以單一 delete journal 提交，失敗 cleanup 留給重啟重試', () => {
    const historyRemove = vi.fn();
    const { queue, state, onChanged, pendingDeletes } = make({
      removeJobFile: (dir, id) => {
        if (id === 'blocked') throw new Error('access denied');
      },
      historyRemove,
    });
    state.add(job('cleared', JOB_STATUS.DONE));
    state.add(job('blocked', JOB_STATUS.DONE));

    expect(queue.clearCompleted()).toBe(2);
    expect(state.jobs()).toEqual([]);
    expect(historyRemove).toHaveBeenCalledTimes(1);
    expect(historyRemove).toHaveBeenCalledWith('D:/queue', 'cleared');
    expect(pendingDeletes()).toEqual([{ id: 'blocked', assRef: null }]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('前段 JSON 已刪但 ASS 清理失敗時，journal 仍會在重啟後阻止工作復活', () => {
    const pending = [{ id: 'partially-deleted', assRef: 'burn.ass' }];
    const { queue, state } = make({
      storedJobs: [job('partially-deleted', JOB_STATUS.QUEUED)],
      pendingDeletes: pending,
      removeAssFile: () => { throw new Error('access denied'); },
    });

    queue.restoreJobs();

    expect(state.get('partially-deleted')).toBeNull();
  });

  it('終態 journal 在重啟時優先於舊 running snapshot，避免完成工作重跑', () => {
    const historyAppend = vi.fn();
    const completed = job('already-finished', JOB_STATUS.DONE);
    const { queue, state } = make({
      storedJobs: [job('already-finished', JOB_STATUS.RUNNING)],
      terminalOutcomes: [completed],
      historyAppend,
    });

    queue.restoreJobs();

    expect(state.get('already-finished')).toBeNull();
    expect(historyAppend).toHaveBeenCalledWith('D:/queue', expect.objectContaining({
      id: 'already-finished', status: JOB_STATUS.DONE,
    }));
  });

  it('重啟後將 retained failed outcome 還原為可重試的非排程列', () => {
    const grantPersistedCapabilities = vi.fn();
    const failed = { ...job('persistent-failure', JOB_STATUS.FAILED), assRef: 'burn_persistent.ass', attempt: 0 };
    const { queue, state, terminalOutcomes } = make({ terminalOutcomes: [failed], grantPersistedCapabilities });

    queue.restoreJobs();

    expect(state.get('persistent-failure')).toMatchObject({
      status: JOB_STATUS.FAILED, assRef: 'burn_persistent.ass', attempt: 0,
    });
    expect(grantPersistedCapabilities).toHaveBeenCalledWith(expect.objectContaining({ id: 'persistent-failure' }));
    queue.setPaused(true);
    expect(queue.retryJob('persistent-failure')).toBe(true);
    expect(state.get('persistent-failure')).toMatchObject({ status: JOB_STATUS.QUEUED, attempt: 1 });
    expect(terminalOutcomes()).toEqual([]);
  });

  it('重啟後的 failed outcome 可由使用者清除，連同 journal、ASS 與 log 收尾', () => {
    const removeAssFile = vi.fn();
    const removeLogFile = vi.fn();
    const failed = { ...job('clear-persistent-failure', JOB_STATUS.FAILED), assRef: 'burn_clear.ass', attempt: 0 };
    const { queue, state, terminalOutcomes } = make({ terminalOutcomes: [failed], removeAssFile, removeLogFile });

    queue.restoreJobs();
    expect(queue.clearJob('clear-persistent-failure')).toBe(true);
    expect(state.get('clear-persistent-failure')).toBeNull();
    expect(terminalOutcomes()).toEqual([]);
    expect(removeAssFile).toHaveBeenCalledWith('D:/queue', 'burn_clear.ass');
    expect(removeLogFile).toHaveBeenCalledWith('D:/queue', 'clear-persistent-failure');
  });

  it('重啟時讓較新 retry attempt 勝過尚未結清的舊 outcome', () => {
    const oldOutcome = { ...job('retry-generation', JOB_STATUS.FAILED), assRef: 'burn_generation.ass', attempt: 0 };
    const newerQueued = { ...job('retry-generation', JOB_STATUS.QUEUED), assRef: 'burn_generation.ass', attempt: 1 };
    const { queue, state, terminalOutcomes } = make({
      storedJobs: [newerQueued],
      terminalOutcomes: [oldOutcome],
    });

    queue.restoreJobs();

    expect(state.get('retry-generation')).toMatchObject({ status: JOB_STATUS.QUEUED, attempt: 1 });
    expect(terminalOutcomes()).toEqual([]);
  });

  it('已提交的刪除 journal 優先於未收尾的 done outcome，不能在重啟時補回紀錄', () => {
    const historyAppend = vi.fn();
    const completed = job('delete-wins', JOB_STATUS.DONE);
    const { queue, state } = make({
      storedJobs: [job('delete-wins', JOB_STATUS.RUNNING)],
      terminalOutcomes: [completed],
      pendingDeletes: [{ id: 'delete-wins', assRef: null }],
      historyAppend,
    });

    queue.restoreJobs();

    expect(state.get('delete-wins')).toBeNull();
    expect(historyAppend).not.toHaveBeenCalled();
  });

  it('從 history 清除未收尾 outcome 時，會把 outcome 的 ASS 參照帶入 delete journal 供重啟重試', () => {
    const outcome = { ...job('locked-ass', JOB_STATUS.DONE), assRef: 'burn_locked.ass' };
    const historyEntry = { ...job('locked-ass', JOB_STATUS.DONE) };
    delete historyEntry.assRef;
    const { queue, state, pendingDeletes } = make({
      terminalOutcomes: [outcome],
      storedHistory: [historyEntry],
      removeAssFile: () => { throw new Error('access denied'); },
    });

    queue.restoreJobs();
    expect(state.get('locked-ass')).toMatchObject({ status: JOB_STATUS.DONE });
    expect(queue.clearCompleted()).toBe(1);
    expect(pendingDeletes()).toEqual([{ id: 'locked-ass', assRef: 'burn_locked.ass' }]);
  });

  it('使用者在 runner 結束前清除已完成工作，不會被 finally 補回完成紀錄', async () => {
    let queue;
    let markTerminal;
    let releaseRunner;
    const terminalReached = new Promise(resolve => { markTerminal = resolve; });
    const runnerReleased = new Promise(resolve => { releaseRunner = resolve; });
    const historyAppend = vi.fn();
    const runJob = vi.fn(async current => {
      queue.reportProgress(current.id, { done: true });
      markTerminal();
      await runnerReleased;
    });
    const setup = make({ runJob, historyAppend });
    ({ queue } = setup);
    setup.state.add(job('clear-race', JOB_STATUS.QUEUED));

    await queue.processQueue();
    await terminalReached;
    expect(setup.queue.clearCompleted()).toBe(1);
    releaseRunner();
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(historyAppend).not.toHaveBeenCalled();
    expect(setup.state.get('clear-race')).toBeNull();
  });
});
