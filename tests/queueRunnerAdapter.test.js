import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { relayQueueRunnerEvent, runnerFailureProgress } = require('../electron/queue-runner-adapter.js');

describe('queue runner IPC adapter', () => {
  it('queue 接受 terminal transition 後才把 task-progress 轉送 renderer', () => {
    const reportProgress = vi.fn(() => true);
    const send = vi.fn();

    expect(relayQueueRunnerEvent({ reportProgress, send }, 'job-1', 'task-progress', { done: true })).toBe(true);
    expect(send).toHaveBeenCalledWith('task-progress', { done: true });
  });

  it('journal 無法落盤時不把假的 terminal task-progress 送給 renderer', () => {
    const reportProgress = vi.fn(() => false);
    const send = vi.fn();

    expect(relayQueueRunnerEvent({ reportProgress, send }, 'job-1', 'task-progress', { error: true })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('使用者停止優先於其後的關機，runner error 仍要回報 stopped 終態', () => {
    expect(runnerFailureProgress({
      stopped: true,
      shutdown: true,
      error: new Error('watchdog stopped'),
    })).toEqual({ stopped: true });
  });

  it('只有關機中斷且未手動停止時，才不回報 failed 終態', () => {
    expect(runnerFailureProgress({
      stopped: false,
      shutdown: true,
      error: new Error('shutdown'),
    })).toBeNull();
  });
});
