import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const queueHtml = readFileSync(new URL('../electron/queue.html', import.meta.url), 'utf8');
const openWindows = [];

async function openQueueWindow(jobs) {
  const queueAPI = {
    getAll: vi.fn().mockResolvedValue({ jobs, isPaused: false, concurrency: 1 }),
    setPause: vi.fn().mockResolvedValue(),
    setConcurrency: vi.fn().mockResolvedValue(),
    stopJob: vi.fn().mockResolvedValue(),
    retryJob: vi.fn().mockResolvedValue(),
    clearJob: vi.fn().mockResolvedValue(),
    clearCompleted: vi.fn().mockResolvedValue(),
    reorderJob: vi.fn().mockResolvedValue(),
    showMainWindow: vi.fn().mockResolvedValue(),
    openPath: vi.fn().mockResolvedValue(),
    showItemInFolder: vi.fn().mockResolvedValue(),
    onUpdate: vi.fn()
  };
  const dom = new JSDOM(queueHtml, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, 'queueAPI', { configurable: true, value: queueAPI });
      Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText: vi.fn().mockResolvedValue() }
      });
    }
  });
  openWindows.push(dom.window);
  await new Promise(resolve => dom.window.setTimeout(resolve, 0));
  await Promise.resolve();
  return { document: dom.window.document, queueAPI };
}

afterEach(() => {
  while (openWindows.length) openWindows.pop().close();
});

describe('匯出佇列監控緊湊工作區', () => {
  it('把未完成工作集中至主要工作區，完成紀錄採收合區塊', async () => {
    const jobs = [
      {
        id: 'done-1',
        status: 'done',
        pct: 100,
        elapsedMs: 12000,
        completedAt: new Date(2026, 6, 28, 15, 53).getTime(),
        payload: { outPath: 'C:\\out\\完成.mp4' }
      },
      { id: 'running-1', status: 'running', pct: 36, elapsedMs: 7000, etaS: 13, payload: { outPath: 'C:\\out\\執行中.mp4' } },
      { id: 'stopping-1', status: 'stopping', pct: 36, payload: { outPath: 'C:\\out\\停止中.mp4' } },
      { id: 'queued-1', status: 'queued', pct: 0, payload: { outPath: 'C:\\out\\等待中.mp4' } },
      { id: 'failed-1', status: 'failed', errorMsg: '測試失敗', payload: { outPath: 'C:\\out\\失敗.mp4' } },
      { id: 'stopped-1', status: 'stopped', payload: { outPath: 'C:\\out\\已停止.mp4' } }
    ];

    const { document } = await openQueueWindow(jobs);
    const completed = [...document.querySelectorAll('#completedJobList .job')];
    const unfinished = [...document.querySelectorAll('#unfinishedJobList .job')];

    expect(completed.map(el => el.dataset.jobId)).toEqual(['done-1']);
    expect(unfinished.map(el => el.dataset.jobId)).toEqual([
      'running-1', 'stopping-1', 'queued-1', 'failed-1', 'stopped-1'
    ]);
    expect(document.getElementById('completedCount').textContent).toBe('1');
    expect(document.getElementById('unfinishedCount').textContent).toBe('5');
    expect(document.getElementById('activeCount').textContent).toBe('2');
    expect(document.getElementById('waitingCount').textContent).toBe('1');
    expect(document.getElementById('attentionCount').textContent).toBe('2');
    expect(document.getElementById('queueBoard').classList.contains('queue-workspace')).toBe(true);
    expect(document.getElementById('unfinishedJobList').classList.contains('job-list--active')).toBe(true);
    expect(document.getElementById('completedHistory').hidden).toBe(false);
    expect(document.getElementById('completedHistory').open).toBe(false);
    expect(document.querySelector('[data-job-id="done-1"] .job-meta')?.textContent || '')
      .toContain('完成於 7月28日 · 03:53 PM');
    expect(document.querySelector('[data-job-id="queued-1"]').classList.contains('job--compact')).toBe(true);
    expect(Boolean(document.querySelector('[data-job-id="queued-1"] .job-meta'))).toBe(false);
    expect(document.getElementById('queueWarning').hidden).toBe(false);
    expect(document.defaultView.getComputedStyle(document.getElementById('queueWarning')).display).not.toBe('none');
    expect(document.querySelector('[data-job-id="queued-1"]').getAttribute('draggable')).toBe('true');
    expect(document.querySelector('[data-job-id="stopping-1"] .job-status').textContent).toContain('停止中');
    expect(document.querySelector('[data-job-id="stopping-1"] [data-action="retry"]')).toBeNull();
  });

  it('沒有工作時只保留主要空狀態，不浪費一整塊已完成區', async () => {
    const { document } = await openQueueWindow([]);

    expect(document.querySelector('#unfinishedJobList .queue-empty')?.textContent).toContain('沒有匯出工作');
    expect(document.getElementById('completedHistory').hidden).toBe(true);
    expect(document.getElementById('activeCount').textContent).toBe('0');
    expect(document.getElementById('waitingCount').textContent).toBe('0');
    expect(document.getElementById('attentionCount').textContent).toBe('0');
    expect(document.getElementById('clearCompletedBtn').disabled).toBe(true);
    expect(document.getElementById('queueWarning').hidden).toBe(true);
    expect(document.defaultView.getComputedStyle(document.getElementById('queueWarning')).display).toBe('none');
  });

  it('每份工作都顯示送出交付時凍結的輸出時長', async () => {
    const jobs = [
      { id: 'done-1', status: 'done', payload: { outPath: 'C:\\out\\完成.mp4', duration: 20.02 } },
      { id: 'running-1', status: 'running', payload: { outPath: 'C:\\out\\執行中.mp4', duration: 3672.5 } },
      { id: 'queued-1', status: 'queued', payload: { outPath: 'C:\\out\\等待中.mp4', duration: 0.033 } },
      { id: 'legacy-1', status: 'stopped', payload: { outPath: 'C:\\out\\舊工作.mp4' } }
    ];

    const { document } = await openQueueWindow(jobs);
    const durationText = id => document.querySelector(`[data-job-id="${id}"] .job-duration`)?.textContent;

    expect(durationText('done-1')).toBe('時長 00:00:20.02');
    expect(durationText('running-1')).toBe('時長 01:01:12.5');
    expect(durationText('queued-1')).toBe('時長 00:00:00.033');
    expect(durationText('legacy-1')).toBe('時長 —');
    expect(document.querySelector('[data-job-id="done-1"] .job-duration')?.title)
      .toBe('輸出時長：00:00:20.02');
  });

  it('緊湊列仍保留操作按鈕，工作文字不會被當成 HTML', async () => {
    const outPath = 'C:\\out\\"><img id="injected-output" src=x>.mp4';
    const jobs = [
      { id: 'done-1', status: 'done', payload: { outPath } },
      { id: 'queued-1', status: 'queued', payload: { outPath: 'C:\\out\\等待.mp4' } },
      {
        id: 'failed-1',
        status: 'failed',
        errorMsg: '<img id="injected-error" src=x>',
        payload: { outPath: 'C:\\out\\失敗.mp4' }
      }
    ];

    const { document, queueAPI } = await openQueueWindow(jobs);
    document.querySelector('[data-job-id="done-1"] [data-action="show-output"]').click();
    document.querySelector('[data-job-id="queued-1"] [data-action="stop"]').click();
    document.querySelector('[data-job-id="failed-1"] [data-action="retry"]').click();

    expect(queueAPI.showItemInFolder).toHaveBeenCalledWith(outPath);
    expect(queueAPI.stopJob).toHaveBeenCalledWith('queued-1');
    expect(queueAPI.retryJob).toHaveBeenCalledWith('failed-1');
    expect(document.getElementById('injected-output')).toBeNull();
    expect(document.getElementById('injected-error')).toBeNull();
  });

  it('可從監控視窗重新開啟主視窗', async () => {
    const { document, queueAPI } = await openQueueWindow([]);
    document.getElementById('showMainWindowBtn').click();
    expect(queueAPI.showMainWindow).toHaveBeenCalledTimes(1);
  });
});
