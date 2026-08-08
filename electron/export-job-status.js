/* ==============================================================================
   SUB Tool — 匯出工作的狀態機（唯一定義）
   ==============================================================================

   **匯出工作**（見 CONTEXT.md）從送出到結束會經過七種狀態。這一支是它們的唯一來源：
   狀態集合本身，以及四個「這個狀態算什麼」的分類。

   【為什麼要收成一份】
   v5.11.0 之前，狀態是散在 electron/ 各處的 46 處字面字串，而分類有四份、
   分別住在三支檔案裡：

     queue-store.js      RESTORABLE_STATUSES / TERMINAL_STATUSES
     main.js             OUTPUT_RESERVED_STATUSES
     export-queue-state  liveWorkCount() 與 retry() 各自內聯的清單

   新增一種狀態時，沒有任何機制告訴你「還有三個地方要表態」。而漏掉其中一個
   **不會報錯**——尤其漏掉 TERMINAL 的後果，是已完成的工作在重啟後被當成
   `queued` 重跑，ffmpeg 以 `-y` 覆寫掉**已經交付出去的成品**
   （這條安全性質見 docs/版本變更紀錄.md 的 v5.7.0）。

   【分類彼此的關係】
   - `terminal` 與 `restorable` 是**互斥且窮盡**的：磁碟上的每一筆記錄，
     重開程式時不是被恢復、就是被當墓碑刪掉，沒有第三種。
   - `liveWork` 與 `terminal` **刻意重疊**於 `stopping`：ffmpeg 還活著
     （所以算 live work，關閉程式要先問），但萬一程式在這個狀態下死掉，
     那筆工作不該被恢復（所以磁碟上算 terminal）。這不是筆誤。
============================================================================== */

const JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  STOPPING: 'stopping',
  DONE: 'done',
  FAILED: 'failed',
  STOPPED: 'stopped',
  MISSING_SOURCE: 'missing-source',
});

const ALL_STATUSES = Object.freeze(Object.values(JOB_STATUS));

/* 磁碟上讀到這些狀態時要當墓碑刪掉、不可恢復（見檔頭：漏掉的後果是覆寫已交付成品）。 */
const TERMINAL = new Set([JOB_STATUS.DONE, JOB_STATUS.FAILED, JOB_STATUS.STOPPED, JOB_STATUS.STOPPING]);

/* 重開程式後要恢復成待處理的狀態。與 TERMINAL 互斥且窮盡。 */
const RESTORABLE = new Set([JOB_STATUS.QUEUED, JOB_STATUS.RUNNING, JOB_STATUS.MISSING_SOURCE]);

/* 還有 ffmpeg 程序活著——關閉視窗前要先問、並行度計算也看這個。
   stopping 也算：送出停止訊號到程序真的結束之間仍在跑。 */
const LIVE_WORK = new Set([JOB_STATUS.RUNNING, JOB_STATUS.STOPPING]);

/* 使用者可以按「重試」把它推回佇列的狀態。 */
const RETRYABLE = new Set([JOB_STATUS.FAILED, JOB_STATUS.STOPPED, JOB_STATUS.MISSING_SOURCE]);

/* 這筆工作仍然「佔著」它的輸出路徑——另一筆工作不可以寫到同一個檔案。
   done 不在內：已經寫完了，要覆寫是使用者的選擇。 */
const OUTPUT_RESERVED = new Set([JOB_STATUS.QUEUED, JOB_STATUS.RUNNING, JOB_STATUS.STOPPING, JOB_STATUS.MISSING_SOURCE]);

/* 合法轉移。列舉而非「只要不是 X 都可以」——後者在新增狀態時不會提醒你補規則。 */
const TRANSITIONS = Object.freeze({
  [JOB_STATUS.QUEUED]: [JOB_STATUS.RUNNING, JOB_STATUS.STOPPED, JOB_STATUS.FAILED, JOB_STATUS.MISSING_SOURCE],
  [JOB_STATUS.RUNNING]: [JOB_STATUS.DONE, JOB_STATUS.FAILED, JOB_STATUS.STOPPING, JOB_STATUS.STOPPED, JOB_STATUS.QUEUED, JOB_STATUS.MISSING_SOURCE],
  [JOB_STATUS.STOPPING]: [JOB_STATUS.STOPPED, JOB_STATUS.FAILED, JOB_STATUS.DONE, JOB_STATUS.QUEUED],
  /* 恢復時可先發現來源遺失、後發現輸出規格也非法；後者是可修正的交付錯誤，
     仍需能明確標成 failed，不能由 queue 直接繞過狀態機寫欄位。 */
  [JOB_STATUS.MISSING_SOURCE]: [JOB_STATUS.QUEUED, JOB_STATUS.STOPPED, JOB_STATUS.FAILED],
  [JOB_STATUS.FAILED]: [JOB_STATUS.QUEUED],
  [JOB_STATUS.STOPPED]: [JOB_STATUS.QUEUED],
  [JOB_STATUS.DONE]: [],
});

const isKnownStatus = s => ALL_STATUSES.includes(s);
const isTerminal = s => TERMINAL.has(s);
const isRestorable = s => RESTORABLE.has(s);
const isLiveWork = s => LIVE_WORK.has(s);
const isRetryable = s => RETRYABLE.has(s);
const reservesOutput = s => OUTPUT_RESERVED.has(s);

/** 這個轉移合法嗎？未知狀態一律不合法（不要靜默放行打錯字的狀態）。 */
function canTransition(from, to) {
  if (!isKnownStatus(from) || !isKnownStatus(to)) return false;
  return (TRANSITIONS[from] || []).includes(to);
}

module.exports = {
  JOB_STATUS, ALL_STATUSES, TRANSITIONS,
  isKnownStatus, isTerminal, isRestorable, isLiveWork, isRetryable, reservesOutput,
  canTransition,
};
