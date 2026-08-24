/* ==============================================================================
   SUB Tool — 跨行程匯出工作確定性狀態機契約 ("shared/export-job-state-machine.cjs")
   ==============================================================================
   【架構與職責】
   純領域 CommonJS 零相依深層契約：定義匯出佇列工作生命週期的合法狀態、
   狀態轉換圖 (State Transition Graph) 與終態判定，供 Renderer (ESM)
   與 Electron 主行程 (CJS) 共用，恪守 ADR-0001 原則。
   ============================================================================== */
'use strict';

const EXPORT_JOB_STATES = {
  QUEUED: 'queued',
  RUNNING: 'running',
  PAUSED: 'paused',
  FINISHED: 'finished',
  ERROR: 'error',
  CANCELLED: 'cancelled',
};

const VALID_TRANSITIONS = {
  [EXPORT_JOB_STATES.QUEUED]: [
    EXPORT_JOB_STATES.RUNNING,
    EXPORT_JOB_STATES.PAUSED,
    EXPORT_JOB_STATES.CANCELLED,
  ],
  [EXPORT_JOB_STATES.RUNNING]: [
    EXPORT_JOB_STATES.FINISHED,
    EXPORT_JOB_STATES.ERROR,
    EXPORT_JOB_STATES.PAUSED,
    EXPORT_JOB_STATES.CANCELLED,
  ],
  [EXPORT_JOB_STATES.PAUSED]: [
    EXPORT_JOB_STATES.QUEUED,
    EXPORT_JOB_STATES.CANCELLED,
  ],
  [EXPORT_JOB_STATES.FINISHED]: [], // 終態
  [EXPORT_JOB_STATES.ERROR]: [
    EXPORT_JOB_STATES.QUEUED, // 允許重試 (Retry)
  ],
  [EXPORT_JOB_STATES.CANCELLED]: [
    EXPORT_JOB_STATES.QUEUED, // 允許重新排程
  ],
};

/**
 * 判定狀態轉換是否符合契約規定。
 * 
 * @param {string} fromState 當前狀態
 * @param {string} toState 目標狀態
 * @returns {boolean} 是否合法
 */
function canTransition(fromState, toState) {
  if (fromState === toState) return true;
  const allowed = VALID_TRANSITIONS[fromState];
  return Array.isArray(allowed) && allowed.includes(toState);
}

/**
 * 判定指定狀態是否為終態 (Terminal State)。
 * 
 * @param {string} state 狀態字串
 * @returns {boolean}
 */
function isTerminalState(state) {
  return state === EXPORT_JOB_STATES.FINISHED ||
         state === EXPORT_JOB_STATES.ERROR ||
         state === EXPORT_JOB_STATES.CANCELLED;
}

/**
 * 執行純函式狀態轉換。
 * 
 * @param {object} job 當前工作資料
 * @param {string} nextState 下一個狀態
 * @param {object} [metadata={}] 附加屬性 (如 progress, error, finishedAt)
 * @returns {object} 更新後之工作資料
 */
function transitionJob(job, nextState, metadata = {}) {
  const current = job?.status || EXPORT_JOB_STATES.QUEUED;
  if (!canTransition(current, nextState)) {
    throw new Error(`非法匯出狀態轉換：無法從 '${current}' 轉換至 '${nextState}'`);
  }

  return {
    ...job,
    status: nextState,
    ...metadata,
    updatedAt: Date.now(),
  };
}

module.exports = {
  EXPORT_JOB_STATES,
  canTransition,
  isTerminalState,
  transitionJob,
};
