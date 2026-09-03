// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { setTimelineToolbarCollapsed, toggleTimelineToolbar } from '../src/timeline-interaction-engine.js';

describe('時間軸工具列收合按鈕', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button id="toggle" aria-expanded="true">
        <span data-role="timeline-toolbar-icon">◀</span>
      </button>
      <div id="options"></div>`;
  });

  function controls() {
    return {
      button: document.getElementById('toggle'),
      options: document.getElementById('options'),
    };
  }

  it('收合時隱藏整組選項並保留可展開的無障礙狀態', () => {
    const control = controls();

    expect(setTimelineToolbarCollapsed(control, true)).toBe(true);
    expect(control.options.hidden).toBe(true);
    expect(control.button.getAttribute('aria-expanded')).toBe('false');
    expect(control.button.getAttribute('aria-label')).toBe('展開時間軸工具');
    expect(control.button.textContent.trim()).toBe('»');
  });

  it('同一顆按鈕可重新展開所有選項', () => {
    const control = controls();
    setTimelineToolbarCollapsed(control, true);

    expect(toggleTimelineToolbar(control)).toBe(false);
    expect(control.options.hidden).toBe(false);
    expect(control.button.getAttribute('aria-expanded')).toBe('true');
    expect(control.button.getAttribute('aria-label')).toBe('收合時間軸工具');
    expect(control.button.textContent.trim()).toBe('«');
  });

});
