import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ExportQueueState } = require('../electron/export-queue-state');

function job(id, status = 'queued', extra = {}) {
  return {
    id,
    status,
    pct: 0,
    elapsedMs: 0,
    etaS: null,
    errorMsg: null,
    ...extra,
  };
}

describe('匯出佇列的唯一順序狀態', () => {
  it('恢復後用同一個有序 collection 同時提供監控順序、下一份工作與狀態摘要', () => {
    const state = new ExportQueueState();
    state.load([
      job('restored-running', 'running'),
      job('restored-first'),
      job('restored-missing', 'missing-source'),
      job('restored-second'),
    ]);

    expect(state.jobs().map(item => item.id)).toEqual([
      'restored-running', 'restored-first', 'restored-missing', 'restored-second',
    ]);
    expect(state.nextQueued()?.id).toBe('restored-first');
    expect(state.statusSnapshot(true)).toEqual({
      waitingCount: 2,
      missingCount: 1,
      liveCount: 1, // restored-running
      isPaused: true,
    });
  });

  it('重試只改工作狀態，保留監控與持久化順序並使同一位置成為下一份工作', () => {
    const state = new ExportQueueState([
      job('running-first', 'running'),
      job('retry-here', 'failed', { pct: 81, elapsedMs: 9000, etaS: 2, errorMsg: 'ffmpeg failed', completedAt: 123 }),
      job('queued-later'),
    ]);

    expect(state.retry('retry-here')).toMatchObject({ id: 'retry-here', status: 'queued' });
    state.add(job('queued-last'));

    expect(state.jobs().map(item => item.id)).toEqual([
      'running-first', 'retry-here', 'queued-later', 'queued-last',
    ]);
    expect(state.get('retry-here')).toMatchObject({ pct: 0, elapsedMs: 0, etaS: null, errorMsg: null });
    expect(state.get('retry-here')).not.toHaveProperty('completedAt');
    expect(state.nextQueued()?.id).toBe('retry-here');
  });

  it('重新排序、停止與移除都在同一份有序 collection 上更新下一份工作', () => {
    const state = new ExportQueueState([
      job('queued-a'),
      job('running-now', 'running'),
      job('queued-b'),
      job('queued-c'),
    ]);

    expect(state.reorder('queued-c', 0)?.id).toBe('queued-c');
    expect(state.jobs().map(item => item.id)).toEqual(['queued-c', 'queued-a', 'running-now', 'queued-b']);
    expect(state.nextQueued()?.id).toBe('queued-c');

    expect(state.stop('queued-c')).toMatchObject({ id: 'queued-c', status: 'stopped' });
    expect(state.stop('running-now')).toMatchObject({ id: 'running-now', status: 'stopping' });
    expect(state.nextQueued()?.id).toBe('queued-a');

    expect(state.remove('queued-a')?.id).toBe('queued-a');
    expect(state.jobs().map(item => item.id)).toEqual(['queued-c', 'running-now', 'queued-b']);
    expect(state.nextQueued()?.id).toBe('queued-b');
  });
});

/* 「還在轉檔嗎」只有這一份定義。關閉主視窗要不要改開監控視窗（不要砍掉轉檔）、
   關閉監控視窗要不要先確認（會中斷轉檔），兩個決定都讀 liveWorkCount()。
   任何一處自己重寫 status 比對，就會在改狀態名稱時漏掉一處——而漏掉的後果是
   安靜地把使用者跑到一半的轉檔砍掉。 */
describe('liveWorkCount：正在轉檔的工作數', () => {
  it('running 與 stopping 都算——stopping 的 ffmpeg 還沒真的結束', () => {
    const state = new ExportQueueState([
      job('a', 'running'),
      job('b', 'stopping'),
    ]);
    expect(state.liveWorkCount()).toBe(2);
  });

  it('等待中與各種終端狀態都不算', () => {
    const state = new ExportQueueState([
      job('waiting', 'queued'),
      job('finished', 'done'),
      job('broken', 'failed'),
      job('halted', 'stopped'),
      job('lost', 'missing-source'),
    ]);
    expect(state.liveWorkCount()).toBe(0);
  });

  it('空佇列是 0', () => {
    expect(new ExportQueueState().liveWorkCount()).toBe(0);
  });

  it('狀態摘要一併帶出 liveCount，監控畫面與關閉決策讀同一個數字', () => {
    const state = new ExportQueueState([
      job('a', 'running'),
      job('b', 'queued'),
      job('c', 'missing-source'),
    ]);
    expect(state.statusSnapshot(true)).toEqual({
      waitingCount: 1,
      missingCount: 1,
      liveCount: 1,
      isPaused: true,
    });
  });
});
