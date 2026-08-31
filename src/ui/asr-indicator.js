/* ==============================================================================
   SUB Tool — 語音辨識進度指示器渲染器 (ASR Monitor Indicator)
   ==============================================================================
   負責在頂部選單列（Menubar）與相關介面呈現語音辨識／文本匹配的即時背景進度。
   ============================================================================== */

export function renderAsrIndicator(button, session = null) {
  if (!button?.classList) return false;
  const status = session?.progress?.status;
  const running = !!(
    session &&
    status !== 'completed' &&
    status !== 'failed' &&
    status !== 'cancelled'
  );
  const reviewable = !!(session && (status === 'completed' || status === 'failed'));
  const visible = running || reviewable;

  button.classList.toggle('asr-running', running);
  button.style.display = visible ? '' : 'none';

  if (!visible) {
    button.removeAttribute('aria-label');
    button.removeAttribute('title');
    return false;
  }

  const rawPercent = session.progress?.percent;
  const isIndeterminate = session.progress?.indeterminate || !Number.isFinite(rawPercent);
  const percentText = isIndeterminate ? '推論中' : `${Math.max(0, Math.min(100, Math.round(rawPercent)))}%`;
  const taskLabel = session.taskMode === 'align' ? '文本匹配' : '語音辨識';

  const labelEl = button.querySelector('#asrMonitorLbl') || button.querySelector('.lbl');
  const stateText = status === 'completed' ? '完成' : (status === 'failed' ? '失敗' : percentText);
  if (labelEl) {
    labelEl.textContent = `🎙 ${taskLabel} ${stateText}`;
  }

  const detail = session.statusText || session.progress?.message || '';
  const tooltip = reviewable
    ? `${taskLabel}${stateText}${detail ? `（${detail}）` : ''}— 點擊查看結果`
    : `${taskLabel}進行中（${percentText}${detail ? ` · ${detail}` : ''}）— 點擊查看進度視窗`;
  button.title = tooltip;
  button.setAttribute('aria-label', tooltip);

  return true;
}
