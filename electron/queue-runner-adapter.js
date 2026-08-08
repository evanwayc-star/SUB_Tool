'use strict';

/* runner 產生的 task-progress 是 Electron adapter 的輸出，不是 queue 狀態本身。
   QueueManager 拒絕 terminal transition（例如 journal 無法落盤）時，renderer 絕不能
   先看到「完成／失敗」；否則 UI 與可恢復磁碟狀態又會分岔。 */
function relayQueueRunnerEvent({ reportProgress, send }, jobId, event, data) {
  if (event === 'task-progress' && reportProgress(jobId, data) === false) return false;
  send(event, data);
  return true;
}

/* 使用者已按停止時，該意圖不能被隨後的 app shutdown 吃掉：queue 已經把工作轉成
   stopping，runner 結束必須回報 stopped outcome。只有純 shutdown 的中斷才不產生終態。 */
function runnerFailureProgress({ stopped = false, shutdown = false, error = null } = {}) {
  const partialCleanup = error?.code === 'PARTIAL_CLEANUP_FAILED' || error?.watchdogResult?.cleanup?.retainedLease;
  if (stopped) {
    if (partialCleanup) return { error: true, errorMsg: error?.message || String(error) };
    return { stopped: true };
  }
  if (shutdown) return null;
  return { error: true, errorMsg: error?.message || String(error) };
}

module.exports = { relayQueueRunnerEvent, runnerFailureProgress };
