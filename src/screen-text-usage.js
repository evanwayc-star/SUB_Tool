const counts = ['windows','cachedWindows','pendingWindows','uniqueFrames','imageAppearances',
  'pendingImageAppearances','reviewMaxWindows','reviewWindows','pendingReviewWindows',
  'newRequests','inputTokens','outputTokens','cachedInputTokens'];

// A progress event is a snapshot of one source, not a request delta.
export function combineScreenTextMetrics(completed, current) {
  const result = {...completed, ...current};
  for (const key of counts) result[key] = (completed[key] || 0) + (current?.[key] || 0);
  if (completed.estimatedCostUsd === null || current?.estimatedCostUsd === null) result.estimatedCostUsd = null;
  else if (Number.isFinite(current?.estimatedCostUsd)) result.estimatedCostUsd = (completed.estimatedCostUsd ?? 0) + current.estimatedCostUsd;
  return result;
}

export function screenTextPlanLabel(m={}) {
  return `${m.windows||0} 個視窗 · 快取 ${m.cachedWindows||0} · 待處理 ${m.pendingWindows||0} · ${m.uniqueFrames||0} 個不同畫格／含重複 ${m.imageAppearances||0} 張次（待送 ${m.pendingImageAppearances||0}）· 最多追加 ${m.reviewMaxWindows||0} 窗複檢 · 本次新增 ${m.newRequests||0} 請求`;
}

export function screenTextUsageLabel(m) {
  if (!m) return '費用未知';
  const cost=m.estimatedCostUsd;
  const estimate=Number.isFinite(cost)?'本次估計 US$'+(cost===0?'0':Number(cost.toPrecision(5)).toString()):'費用未知';
  return `${m.stage||''} ${m.model||''} · ${screenTextPlanLabel(m)} · 複檢 ${m.reviewWindows||0} 窗（待送 ${m.pendingReviewWindows||0}）· 輸入／輸出 ${m.inputTokens||0}／${m.outputTokens||0} tokens（快取輸入 ${m.cachedInputTokens||0}）· ${estimate}，實際費用依供應商計費。`;
}
