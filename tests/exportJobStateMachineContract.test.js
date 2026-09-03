import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const QueueModule = require('../electron/export-queue');
const { JOB_STATUS } = QueueModule;

function job(id, status = JOB_STATUS.QUEUED) {
  return { id, status, pct: 0, elapsedMs: 0, etaS: null, errorMsg: null };
}

describe('匯出工作生命週期的單一 production interface', () => {
  it('queue module 暴露正式 ExportQueueState 與 JOB_STATUS', () => {
    expect(QueueModule.ExportQueueState).toBeTypeOf('function');
    expect(QueueModule.JOB_STATUS).toBeDefined();
  });

  it('透過 ExportQueueState 執行正式七狀態的合法轉移', () => {
    const state = new QueueModule.ExportQueueState([job('delivery')]);

    expect(state.setStatus('delivery', JOB_STATUS.RUNNING)?.status).toBe(JOB_STATUS.RUNNING);
    expect(state.setStatus('delivery', JOB_STATUS.DONE)?.status).toBe(JOB_STATUS.DONE);
    expect(state.setStatus('delivery', JOB_STATUS.RUNNING)).toBeNull();
    expect(state.get('delivery')?.status).toBe(JOB_STATUS.DONE);
  });

  it('拒絕影子狀態語彙，不讓 finished/error/cancelled 混入持久化 queue', () => {
    const state = new QueueModule.ExportQueueState([job('delivery')]);

    for (const legacyStatus of ['paused', 'finished', 'error', 'cancelled']) {
      expect(state.setStatus('delivery', legacyStatus), legacyStatus).toBeNull();
      expect(state.get('delivery')?.status).toBe(JOB_STATUS.QUEUED);
    }
  });
});
