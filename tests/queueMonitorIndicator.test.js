/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import { renderQueueMonitorIndicator } from '../src/ui/queue-monitor-indicator.js';

describe('監控序列圓形進度環', () => {
  let button;

  beforeEach(() => {
    document.body.innerHTML = `
      <button id="stMonitorBtn" title="監控匯出佇列（.）">
        <span class="queue-monitor-ring" aria-hidden="true"></span>
        <span class="lbl">監控序列</span>
      </button>
    `;
    button = document.getElementById('stMonitorBtn');
  });

  it('依主行程 liveCount 在旋轉中與完整靜止環之間切換', () => {
    expect(renderQueueMonitorIndicator(button, { liveCount: 2 })).toBe(true);
    expect(button.classList.contains('queue-running')).toBe(true);
    expect(button.getAttribute('aria-label')).toContain('2 份正在轉檔');
    expect(button.title).toContain('2 份正在轉檔');

    expect(renderQueueMonitorIndicator(button, { liveCount: 0 })).toBe(false);
    expect(button.classList.contains('queue-running')).toBe(false);
    expect(button.getAttribute('aria-label')).toContain('目前沒有正在轉檔');
    expect(button.title).toContain('目前沒有正在轉檔');
  });
});
