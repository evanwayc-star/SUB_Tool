/* 匯出工作狀態機的唯一定義。

   v5.11.0 之前，狀態是散在 electron/ 的 46 處字面字串，分類有四份、住在三支檔案裡：
     queue-store.js      RESTORABLE_STATUSES / TERMINAL_STATUSES
     main.js             OUTPUT_RESERVED_STATUSES
     export-queue-state  liveWorkCount() 與 retry() 各自內聯的清單

   新增一種狀態時，沒有任何機制告訴你「還有三個地方要表態」。漏掉不會報錯——
   而漏掉 TERMINAL 的後果，是已完成的工作在重啟後被當成 queued 重跑、
   ffmpeg 以 -y 覆寫掉**已經交付出去的成品**（見變更紀錄 v5.7.0）。

   這支測試的重點不是「函式會不會回傳正確的布林」，而是**分類之間的不變量**：
   新增一個狀態卻沒有替它分類，這裡就會紅。 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../electron/export-job-status.js');

describe('狀態集合', () => {
  it('七種狀態，值與磁碟上既有記錄相容', () => {
    expect([...S.ALL_STATUSES].sort()).toEqual(
      ['done', 'failed', 'missing-source', 'queued', 'running', 'stopped', 'stopping']);
  });

  it('JOB_STATUS 是凍結的（避免有人在執行期塞新狀態進來）', () => {
    expect(Object.isFrozen(S.JOB_STATUS)).toBe(true);
  });

  it('未知狀態一律不算已知', () => {
    for (const bad of ['', null, undefined, 'runnning', 'Done', 'complete']) {
      expect(S.isKnownStatus(bad), String(bad)).toBe(false);
    }
  });
});

/* 這一組才是重點：分類之間的關係。 */
describe('分類的不變量', () => {
  const terminal = S.ALL_STATUSES.filter(S.isTerminal);
  const restorable = S.ALL_STATUSES.filter(S.isRestorable);

  /* 磁碟上的每一筆記錄，重開程式時不是被恢復、就是被當墓碑刪掉，沒有第三種。
     少了這條，新增的狀態會兩邊都不屬於 → queue-store 讀到就丟例外。 */
  it('terminal 與 restorable 互斥且窮盡', () => {
    expect(terminal.filter(s => restorable.includes(s))).toEqual([]);
    expect(terminal.length + restorable.length).toBe(S.ALL_STATUSES.length);
  });

  it('每個狀態都被 terminal／restorable 其中之一涵蓋', () => {
    const unclassified = S.ALL_STATUSES.filter(s => !S.isTerminal(s) && !S.isRestorable(s));
    expect(unclassified).toEqual([]);
  });

  /* stopping 同時是 live work 與 terminal——這是刻意的，不是筆誤：
     ffmpeg 還活著（關閉視窗要先問），但程式若在此時死掉，那筆工作不該被恢復。 */
  it('liveWork 與 terminal 只在 stopping 重疊', () => {
    const both = S.ALL_STATUSES.filter(s => S.isLiveWork(s) && S.isTerminal(s));
    expect(both).toEqual(['stopping']);
  });

  it('done 永遠不是 live work、不可重試、不佔用輸出路徑', () => {
    expect(S.isLiveWork('done')).toBe(false);
    expect(S.isRetryable('done')).toBe(false);
    expect(S.reservesOutput('done')).toBe(false);
  });

  it('可重試的狀態都不是 live work（還在跑的東西不該被推回佇列）', () => {
    for (const s of S.ALL_STATUSES.filter(S.isRetryable)) {
      expect(S.isLiveWork(s), s).toBe(false);
    }
  });

  it('live work 一定佔用輸出路徑（正在寫的檔案不可被另一筆工作覆寫）', () => {
    for (const s of S.ALL_STATUSES.filter(S.isLiveWork)) {
      expect(S.reservesOutput(s), s).toBe(true);
    }
  });

  it('未知狀態不屬於任何分類（打錯字不會靜默通過）', () => {
    for (const f of ['isTerminal', 'isRestorable', 'isLiveWork', 'isRetryable', 'reservesOutput']) {
      expect(S[f]('runnning'), f).toBe(false);
    }
  });
});

/* 與改動前四份清單的逐項對照——這次收斂不可以改變任何既有行為。 */
describe('與 v5.10.0 的四份清單完全相同', () => {
  const same = (got, want) => expect([...got].sort()).toEqual([...want].sort());

  it('queue-store TERMINAL_STATUSES', () => {
    same(S.ALL_STATUSES.filter(S.isTerminal), ['done', 'failed', 'stopped', 'stopping']);
  });
  it('queue-store RESTORABLE_STATUSES', () => {
    same(S.ALL_STATUSES.filter(S.isRestorable), ['queued', 'running', 'missing-source']);
  });
  it('main OUTPUT_RESERVED_STATUSES', () => {
    same(S.ALL_STATUSES.filter(S.reservesOutput), ['queued', 'running', 'stopping', 'missing-source']);
  });
  it('export-queue-state liveWorkCount', () => {
    same(S.ALL_STATUSES.filter(S.isLiveWork), ['running', 'stopping']);
  });
  it('export-queue-state retry', () => {
    same(S.ALL_STATUSES.filter(S.isRetryable), ['failed', 'stopped', 'missing-source']);
  });
});

describe('轉移', () => {
  it('每個狀態都有轉移表條目（新增狀態時會被迫定義）', () => {
    for (const s of S.ALL_STATUSES) {
      expect(Array.isArray(S.TRANSITIONS[s]), s).toBe(true);
    }
  });

  it('done 是死路——不可能回到 running（那正是覆寫已交付成品的情境）', () => {
    expect(S.TRANSITIONS.done).toEqual([]);
    expect(S.canTransition('done', 'running')).toBe(false);
    expect(S.canTransition('done', 'queued')).toBe(false);
  });

  it('正常流程可走', () => {
    expect(S.canTransition('queued', 'running')).toBe(true);
    expect(S.canTransition('running', 'done')).toBe(true);
    expect(S.canTransition('running', 'stopping')).toBe(true);
    expect(S.canTransition('stopping', 'stopped')).toBe(true);
  });

  it('可重試的狀態都能回到 queued', () => {
    for (const s of S.ALL_STATUSES.filter(S.isRetryable)) {
      expect(S.canTransition(s, 'queued'), s).toBe(true);
    }
  });

  it('關閉程式時 running 退回 queued 是合法的（v5.7.0 的復原流程）', () => {
    expect(S.canTransition('running', 'queued')).toBe(true);
  });

  it('轉移表只會指向已知狀態', () => {
    for (const [from, tos] of Object.entries(S.TRANSITIONS)) {
      for (const to of tos) expect(S.isKnownStatus(to), `${from} → ${to}`).toBe(true);
    }
  });

  it('未知狀態的轉移一律拒絕', () => {
    expect(S.canTransition('runnning', 'done')).toBe(false);
    expect(S.canTransition('queued', 'finished')).toBe(false);
    expect(S.canTransition(null, undefined)).toBe(false);
  });
});
