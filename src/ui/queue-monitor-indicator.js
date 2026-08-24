/* 主工具列只消費主行程提供的 liveCount，不在 renderer 重新判斷工作狀態。
   running / stopping 是否仍算轉檔中，由 ExportQueueState 統一決定。 */
export function renderQueueMonitorIndicator(button, snapshot = {}) {
  if (!button?.classList) return false;
  const rawCount = Number(snapshot?.liveCount);
  const liveCount = Number.isFinite(rawCount) && rawCount > 0 ? Math.floor(rawCount) : 0;
  const running = liveCount > 0;
  const status = running ? `${liveCount} 份正在轉檔` : '目前沒有正在轉檔';

  button.classList.toggle('queue-running', running);
  button.setAttribute('aria-label', `監控匯出佇列，${status}；快捷鍵 .`);
  button.title = `監控匯出佇列（${status}，快捷鍵 .）`;
  return running;
}
