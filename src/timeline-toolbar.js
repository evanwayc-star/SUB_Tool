export function setTimelineToolbarCollapsed({ button, options } = {}, collapsed = false) {
  if (!button || !options) return false;
  const next = !!collapsed;
  options.hidden = next;
  button.setAttribute('aria-expanded', String(!next));
  button.setAttribute('aria-label', next ? '展開時間軸工具' : '收合時間軸工具');
  button.title = next ? '展開音軌數與時間軸工具' : '收合音軌數與時間軸工具';
  const icon = button.querySelector('[data-role="timeline-toolbar-icon"]');
  if (icon) icon.textContent = next ? '»' : '«';
  return next;

}

export function toggleTimelineToolbar({ button, options } = {}) {
  return setTimelineToolbarCollapsed({ button, options }, !options?.hidden);
}
