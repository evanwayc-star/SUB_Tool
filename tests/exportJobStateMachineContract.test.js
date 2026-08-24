import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  EXPORT_JOB_STATES,
  canTransition,
  isTerminalState,
  transitionJob,
} = require('../shared/export-job-state-machine.cjs');

describe('export-job-state-machine contract', () => {
  it('嚴格約束合法的狀態轉換路徑', () => {
    // queued -> running (合法)
    expect(canTransition(EXPORT_JOB_STATES.QUEUED, EXPORT_JOB_STATES.RUNNING)).toBe(true);

    // running -> finished (合法)
    expect(canTransition(EXPORT_JOB_STATES.RUNNING, EXPORT_JOB_STATES.FINISHED)).toBe(true);

    // running -> error (合法)
    expect(canTransition(EXPORT_JOB_STATES.RUNNING, EXPORT_JOB_STATES.ERROR)).toBe(true);

    // finished -> running (非法：已完成不可重跑)
    expect(canTransition(EXPORT_JOB_STATES.FINISHED, EXPORT_JOB_STATES.RUNNING)).toBe(false);

    // error -> queued (合法：重試)
    expect(canTransition(EXPORT_JOB_STATES.ERROR, EXPORT_JOB_STATES.QUEUED)).toBe(true);
  });

  it('正確判定終態 (Terminal States)', () => {
    expect(isTerminalState(EXPORT_JOB_STATES.FINISHED)).toBe(true);
    expect(isTerminalState(EXPORT_JOB_STATES.ERROR)).toBe(true);
    expect(isTerminalState(EXPORT_JOB_STATES.CANCELLED)).toBe(true);
    expect(isTerminalState(EXPORT_JOB_STATES.RUNNING)).toBe(false);
    expect(isTerminalState(EXPORT_JOB_STATES.QUEUED)).toBe(false);
  });

  it('執行純函式狀態轉換與例外防護', () => {
    const job = { id: 'job_1', status: EXPORT_JOB_STATES.QUEUED };

    const runningJob = transitionJob(job, EXPORT_JOB_STATES.RUNNING, { progress: 0 });
    expect(runningJob.status).toBe(EXPORT_JOB_STATES.RUNNING);
    expect(runningJob.progress).toBe(0);
    expect(runningJob.updatedAt).toBeDefined();

    // 嘗試從 finished 跳回 running 應拋出例外
    const finishedJob = { id: 'job_1', status: EXPORT_JOB_STATES.FINISHED };
    expect(() => transitionJob(finishedJob, EXPORT_JOB_STATES.RUNNING)).toThrow(/非法匯出狀態轉換/);
  });
});
