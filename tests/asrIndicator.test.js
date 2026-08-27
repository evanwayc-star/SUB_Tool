// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { renderAsrIndicator } from '../src/ui/asr-indicator.js';

describe('頂部工具列語音辨識指示器 (asr-indicator)', () => {
  let button;

  beforeEach(() => {
    document.body.innerHTML = `
      <button id="asrMonitorBtn" data-act="asr-monitor" style="display:none;" title="語音辨識進度">
        <span class="asr-monitor-ring"></span>
        <span id="asrMonitorLbl" class="lbl">🎙 辨識中</span>
      </button>
    `;
    button = document.getElementById('asrMonitorBtn');
  });

  it('無活動 session 或已取消時隱藏指示器按鈕', () => {
    renderAsrIndicator(button, null);
    expect(button.style.display).toBe('none');
    expect(button.classList.contains('asr-running')).toBe(false);

    renderAsrIndicator(button, { progress: { status: 'cancelled' } });
    expect(button.style.display).toBe('none');
    expect(button.classList.contains('asr-running')).toBe(false);
  });

  it('進行中且有具體百分比時，顯示按鈕、包含百分比文字與 running 動畫 class', () => {
    const session = {
      taskMode: 'transcribe',
      progress: {
        status: 'transcribing',
        percent: 68,
        indeterminate: false,
        message: '本機 AI 正在推論…'
      },
      statusText: '[1/2] 本機 AI 正在推論…'
    };

    renderAsrIndicator(button, session);
    expect(button.style.display).toBe('');
    expect(button.classList.contains('asr-running')).toBe(true);
    expect(button.textContent).toContain('68%');
    expect(button.title).toContain('語音辨識進行中');
    expect(button.title).toContain('68%');
  });

  it('進行中但無具體百分比 (indeterminate) 時，顯示推論中與 running class', () => {
    const session = {
      taskMode: 'align',
      progress: {
        status: 'transcribing',
        percent: null,
        indeterminate: true,
        message: '分析聲音中…'
      }
    };

    renderAsrIndicator(button, session);
    expect(button.style.display).toBe('');
    expect(button.classList.contains('asr-running')).toBe(true);
    expect(button.textContent).toContain('文本匹配');
    expect(button.title).toContain('文本匹配進行中');
  });

  it('結束狀態時隱藏指示器', () => {
    const session = {
      taskMode: 'transcribe',
      progress: {
        status: 'completed',
        percent: 100,
        indeterminate: false,
        message: '辨識完成'
      }
    };

    renderAsrIndicator(button, session);
    expect(button.style.display).toBe('none');
    expect(button.classList.contains('asr-running')).toBe(false);
  });

  it('失敗時隱藏指示器', () => {
    const session = {
      taskMode: 'transcribe',
      progress: {
        status: 'failed',
        message: '連線中斷'
      },
      error: new Error('連線中斷')
    };

    renderAsrIndicator(button, session);
    expect(button.style.display).toBe('none');
    expect(button.classList.contains('asr-running')).toBe(false);
  });
});
