/* ==============================================================================
   SUB Tool — 匯出工作狀態機與分類定義 (Export Job Status Machine)
   ==============================================================================
   【架構與職責】
   匯出工作（Export Job）從建立、排隊、執行到結束的唯一狀態集合與狀態轉移矩陣。
   
   【安全與一致性鐵律】
   1. `terminal`（終態）與 `restorable`（可恢復狀態）是【互斥且窮盡】的：
      重開程式時，磁碟上的工作記錄若非被當作過期墓碑清除，即會被還原為可恢復狀態。
   2. 遺漏 TERMINAL 標記將導致已完成的工作在程式重啟後被當成 `queued` 重跑，
      進而覆寫已經交付給使用者的成品檔案（重要安全性質）。
   3. `stopping` 狀態下 FFmpeg 仍在執行中（屬於 liveWork），但若此時程式崩潰，
      重啟後不應恢復該工作（屬於 terminal）。
   ============================================================================== */
'use strict';

/**
 * 匯出工作狀態枚舉。
 * @readonly
 * @enum {string}
 */
const JOB_STATUS = Object.freeze({
  /** 等待排程執行 */
  QUEUED: 'queued',
  /** 正在進行 FFmpeg 轉檔/燒錄 */
  RUNNING: 'running',
  /** 正在發送終止訊號並等待程序關閉與半成品清理 */
  STOPPING: 'stopping',
  /** 匯出成功完成 */
  DONE: 'done',
  /** 匯出執行失敗 */
  FAILED: 'failed',
  /** 使用者手動停止 */
  STOPPED: 'stopped',
  /** 找不到來源素材檔案 */
  MISSING_SOURCE: 'missing-source',
});

/** 所有合法狀態清單 */
const ALL_STATUSES = Object.freeze(Object.values(JOB_STATUS));

/**
 * 終態集合（重啟後視為過期記錄並清理，不可恢復重跑）。
 * @type {Set<string>}
 */
const TERMINAL = new Set([
  JOB_STATUS.DONE,
  JOB_STATUS.FAILED,
  JOB_STATUS.STOPPED,
  JOB_STATUS.STOPPING,
]);

/**
 * 可恢復狀態集合（重啟程式後恢復為待處理工作）。
 * @type {Set<string>}
 */
const RESTORABLE = new Set([
  JOB_STATUS.QUEUED,
  JOB_STATUS.RUNNING,
  JOB_STATUS.MISSING_SOURCE,
]);

/**
 * 活躍中工作集合（尚有 FFmpeg 子行程在運行，關閉視窗前需確認）。
 * @type {Set<string>}
 */
const LIVE_WORK = new Set([
  JOB_STATUS.RUNNING,
  JOB_STATUS.STOPPING,
]);

/**
 * 可手動點擊「重試」之狀態集合。
 * @type {Set<string>}
 */
const RETRYABLE = new Set([
  JOB_STATUS.FAILED,
  JOB_STATUS.STOPPED,
  JOB_STATUS.MISSING_SOURCE,
]);

/**
 * 輸出路徑保留狀態集合（此狀態下其他工作禁止寫入相同輸出檔案）。
 * @type {Set<string>}
 */
const OUTPUT_RESERVED = new Set([
  JOB_STATUS.QUEUED,
  JOB_STATUS.RUNNING,
  JOB_STATUS.STOPPING,
  JOB_STATUS.MISSING_SOURCE,
]);

/**
 * 合法狀態轉移規則表。
 * @type {Record<string, string[]>}
 */
const TRANSITIONS = Object.freeze({
  [JOB_STATUS.QUEUED]: [
    JOB_STATUS.RUNNING,
    JOB_STATUS.STOPPED,
    JOB_STATUS.FAILED,
    JOB_STATUS.MISSING_SOURCE,
  ],
  [JOB_STATUS.RUNNING]: [
    JOB_STATUS.DONE,
    JOB_STATUS.FAILED,
    JOB_STATUS.STOPPING,
    JOB_STATUS.STOPPED,
    JOB_STATUS.QUEUED,
    JOB_STATUS.MISSING_SOURCE,
  ],
  [JOB_STATUS.STOPPING]: [
    JOB_STATUS.STOPPED,
    JOB_STATUS.FAILED,
    JOB_STATUS.DONE,
    JOB_STATUS.QUEUED,
  ],
  [JOB_STATUS.MISSING_SOURCE]: [
    JOB_STATUS.QUEUED,
    JOB_STATUS.STOPPED,
    JOB_STATUS.FAILED,
  ],
  [JOB_STATUS.FAILED]: [JOB_STATUS.QUEUED],
  [JOB_STATUS.STOPPED]: [JOB_STATUS.QUEUED],
  [JOB_STATUS.DONE]: [],
});

/** 檢查是否為已知合法狀態 */
const isKnownStatus = s => ALL_STATUSES.includes(s);

/** 檢查是否為終態 */
const isTerminal = s => TERMINAL.has(s);

/** 檢查是否為重開後可恢復狀態 */
const isRestorable = s => RESTORABLE.has(s);

/** 檢查是否為仍佔用子行程之活躍工作 */
const isLiveWork = s => LIVE_WORK.has(s);

/** 檢查是否允許重試 */
const isRetryable = s => RETRYABLE.has(s);

/** 檢查是否佔有輸出檔案鎖 */
const reservesOutput = s => OUTPUT_RESERVED.has(s);

/**
 * 驗證由 `from` 狀態轉移至 `to` 狀態是否合法。
 * 
 * @param {string} from 起始狀態
 * @param {string} to 目標狀態
 * @returns {boolean} 是否為合法轉移
 */
function canTransition(from, to) {
  if (!isKnownStatus(from) || !isKnownStatus(to)) return false;
  return (TRANSITIONS[from] || []).includes(to);
}

module.exports = {
  JOB_STATUS,
  ALL_STATUSES,
  TRANSITIONS,
  isKnownStatus,
  isTerminal,
  isRestorable,
  isLiveWork,
  isRetryable,
  reservesOutput,
  canTransition,
};
