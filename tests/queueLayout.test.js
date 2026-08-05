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
    updateDelivery: vi.fn().mockResolvedValue({ format: 'h264', outPath: 'C:\\out\\a.mp4', width: 1920, height: 1080 }),
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
    /* 沒有 fps 就退回 HH:MM:SS.mmm——不要假裝有影格精度。
       精確秒數保留在 title 裡，換成影格顯示之後資訊也不會消失。 */
    expect(document.querySelector('[data-job-id="done-1"] .job-duration')?.title)
      .toBe('輸出時長 00:00:20.02 · 精確 20.020 秒');
  });

  /* 時長改用剪輯慣用的 HH:MM:SS:FF（v6.1.4）。
     這是【時長】不是時間碼位置，所以不做 drop-frame 補償——DF 是為了讓 29.97 的
     時間碼位置貼回牆上時鐘，對長度沒有意義。29.97 以 30 為進位基數。 */
  it('有 fps 時，時長以 HH:MM:SS:FF 顯示', async () => {
    const jobs = [
      { id: 'j25', status: 'queued', payload: { outPath: 'C:\\out\\a.mp4', duration: 20.04, fps: 25 } },
      { id: 'j2997', status: 'queued', payload: { outPath: 'C:\\out\\b.mp4', duration: 3600, fps: 29.97 } },
      { id: 'jexact', status: 'queued', payload: { outPath: 'C:\\out\\c.mp4', duration: 2, fps: 24 } }
    ];
    const { document } = await openQueueWindow(jobs);
    const durationText = id => document.querySelector(`[data-job-id="${id}"] .job-duration`)?.textContent;

    expect(durationText('j25')).toBe('時長 00:00:20:01');   // 20.04s × 25 = 501 影格 → 20 秒又 1 格
    expect(durationText('jexact')).toBe('時長 00:00:02:00'); // 整秒不可以跑出 FF=24
    // 29.97：3600 秒 × 29.97 = 107892 影格；以 30 為基數 → 3596 秒又 12 格
    expect(durationText('j2997')).toBe('時長 00:59:56:12');
    expect(document.querySelector('[data-job-id="j25"] .job-duration')?.title)
      .toContain('（25 fps）');
  });

  it('顯示交付規格與加入佇列的時間', async () => {
    const jobs = [
      { id: 'mp4', status: 'queued', createdAt: new Date(2026, 7, 5, 23, 52, 23).getTime(),
        payload: { outPath: 'C:\\out\\a.mp4', format: 'h264', width: 1920, height: 1080, videoKbps: 8000 } },
      // ProRes 固定 profile、WAV 沒有視訊：不可以顯示會誤導的 kbps
      { id: 'pro', status: 'queued', payload: { outPath: 'C:\\out\\b.mov', format: 'prores', width: 1920, height: 1080, videoKbps: 8000 } },
      { id: 'wav', status: 'queued', payload: { outPath: 'C:\\out\\c.wav', format: 'wav', width: 1920, height: 1080, videoKbps: 8000 } }
    ];
    const { document } = await openQueueWindow(jobs);
    const spec = id => document.querySelector(`[data-job-id="${id}"] .job-chip--spec`)?.textContent;

    expect(spec('mp4')).toBe('MP4 / 1920 x 1080 px / 8000 kbps');
    expect(spec('pro')).toBe('ProRes / 1920 x 1080 px');
    expect(spec('wav')).toBe('WAV');

    // 「加入」二字拿掉了：它靠位置（推到最右）與 title 表達，不再佔用寬度
    expect(document.querySelector('[data-job-id="mp4"] .job-enqueued')?.textContent)
      .toBe('2026/08/05-11:52:23pm');
    // 舊工作沒有 createdAt 時不可以印出 Invalid Date
    expect(document.querySelector('[data-job-id="pro"] .job-enqueued')).toBe(null);
  });

  it('等待中的列才有拖曳握把與格式下拉；執行中沒有', async () => {
    const jobs = [
      { id: 'q1', status: 'queued', payload: { outPath: 'C:\\out\\a.mp4', format: 'h264' } },
      { id: 'r1', status: 'running', payload: { outPath: 'C:\\out\\b.mp4', format: 'h264' } }
    ];
    const { document } = await openQueueWindow(jobs);
    const row = id => document.querySelector(`[data-job-id="${id}"]`);

    // 握把每一列都在（不能拖的用透明佔位，各列文字才對齊）
    expect(row('q1').querySelector('.job-grip')).not.toBe(null);
    expect(row('r1').querySelector('.job-grip')).not.toBe(null);
    expect(row('q1').draggable).toBe(true);
    expect(row('r1').draggable).toBe(false);

    // 交付設定只有等待中能改：執行中的 ffmpeg argv 已經定案
    expect(row('q1').querySelector('[data-action="edit"]')).not.toBe(null);
    expect(row('r1').querySelector('[data-action="edit"]')).toBe(null);

    // 還沒轉檔的用「刪除」，轉檔中的才用「停止」
    expect(row('q1').querySelector('[data-action="delete"]')).not.toBe(null);
    expect(row('q1').querySelector('[data-action="stop"]')).toBe(null);
    expect(row('r1').querySelector('[data-action="stop"]')).not.toBe(null);
    expect(row('r1').querySelector('[data-action="delete"]')).toBe(null);
  });

  it('顯示會被燒進交付的字幕軌', async () => {
    const jobs = [
      { id: 'subs', status: 'queued', payload: { outPath: 'C:\\out\\a.mp4', format: 'h264', subtitleTracks: ['取詞', '對白'] } },
      { id: 'none', status: 'queued', payload: { outPath: 'C:\\out\\b.mp4', format: 'h264', subtitleTracks: [] } },
      // WAV 沒有畫面，不談字幕
      { id: 'wav', status: 'queued', payload: { outPath: 'C:\\out\\c.wav', format: 'wav', subtitleTracks: ['取詞'] } },
      // 舊工作沒有這個欄位 → 整段不顯示，不可以謊報「無字幕」
      { id: 'legacy', status: 'queued', payload: { outPath: 'C:\\out\\d.mp4', format: 'h264' } }
    ];
    const { document } = await openQueueWindow(jobs);
    const subs = id => document.querySelector(`[data-job-id="${id}"] .job-subs`)?.textContent ?? null;

    expect(subs('subs')).toBe('字幕 取詞、對白');
    expect(subs('none')).toBe('無字幕');
    expect(subs('wav')).toBe(null);
    expect(subs('legacy')).toBe(null);
  });

  it('顯示是否燒入 TC', async () => {
    const jobs = [
      { id: 'tc', status: 'queued', payload: { outPath: 'C:\\out\\a_TC.mp4', format: 'h264', timecodeWatermark: { start: '01:00:00:00' } } },
      { id: 'notc', status: 'queued', payload: { outPath: 'C:\\out\\b.mp4', format: 'h264', timecodeWatermark: null } }
    ];
    const { document } = await openQueueWindow(jobs);
    const tc = id => document.querySelector(`[data-job-id="${id}"] .job-chip--tc`);
    expect(tc('tc')?.textContent).toBe('燒入 TC');
    expect(tc('notc')).toBe(null);
  });

  it('交付編輯器：TC 開關會送出，WAV 不送', async () => {
    const jobs = [{
      id: 'q1', status: 'queued',
      payload: { outPath: 'C:\\out\\a.mp4', format: 'h264', targetH: 0, videoKbps: 8000,
                 timecodeWatermark: null, timelineStartTimecode: '01:00:00:00' }
    }];
    const { document, queueAPI } = await openQueueWindow(jobs);
    const row = document.querySelector('[data-job-id="q1"]');
    row.querySelector('[data-action="edit"]').click();
    const box = row.querySelector('.job-editor');

    expect(box.querySelector('[data-f="tc"]').checked).toBe(false);
    box.querySelector('[data-f="tc"]').checked = true;
    box.querySelector('[data-f="save"]').click();
    await new Promise(r => setTimeout(r, 0));

    expect(queueAPI.updateDelivery).toHaveBeenCalledWith('q1',
      expect.objectContaining({ format: 'h264', burnTimecode: true }));
  });

  it('交付編輯器：只送 format/targetH/kbps，尺寸與路徑由主程序推導', async () => {
    const jobs = [{
      id: 'q1', status: 'queued',
      payload: { outPath: 'C:\\out\\a.mp4', format: 'h264', width: 1920, height: 1080,
                 canvasW: 1920, canvasH: 1080, targetH: 0, videoKbps: 8000 }
    }];
    const { document, queueAPI } = await openQueueWindow(jobs);
    const row = document.querySelector('[data-job-id="q1"]');

    row.querySelector('[data-action="edit"]').click();
    const box = row.querySelector('.job-editor');
    expect(box, '按下更改格式應該開出編輯面板').not.toBe(null);
    // 編輯期間必須關掉拖曳，否則在輸入框上按住會被當成拖曳整張卡片
    expect(row.draggable).toBe(false);

    box.querySelector('[data-f="res"]').value = '720';
    box.querySelector('[data-f="kbps"]').value = '3000';
    box.querySelector('[data-f="save"]').click();
    await new Promise(r => setTimeout(r, 0));

    expect(queueAPI.updateDelivery).toHaveBeenCalledWith('q1',
      { format: 'h264', targetH: 720, kbps: 3000, burnTimecode: false });
  });

  it('交付編輯器：WAV 隱藏解析度與碼率，且不送 kbps', async () => {
    const jobs = [{
      id: 'q1', status: 'queued',
      payload: { outPath: 'C:\\out\\a.mp4', format: 'h264', width: 1920, height: 1080, targetH: 0, videoKbps: 8000 }
    }];
    const { document, queueAPI } = await openQueueWindow(jobs);
    const row = document.querySelector('[data-job-id="q1"]');
    row.querySelector('[data-action="edit"]').click();
    const box = row.querySelector('.job-editor');

    const fmt = box.querySelector('[data-f="format"]');
    fmt.value = 'wav';
    fmt.dispatchEvent(new document.defaultView.Event('change'));

    expect(box.querySelector('[data-only="video"]').hidden).toBe(true);
    expect(box.querySelector('[data-only="h264"]').hidden).toBe(true);

    box.querySelector('[data-f="save"]').click();
    await new Promise(r => setTimeout(r, 0));
    // WAV 沒有視訊碼率，不可以送 kbps
    expect(queueAPI.updateDelivery).toHaveBeenCalledWith('q1', { format: 'wav', targetH: 0 });
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
    /* 等待中的工作用【刪除】而不是【停止】——它根本還沒跑過，
       標成「已停止」沒有意義。刪除會問一次，因為那會連交付設定一起丟掉。 */
    document.defaultView.confirm = () => true;
    document.querySelector('[data-job-id="queued-1"] [data-action="delete"]').click();
    document.querySelector('[data-job-id="failed-1"] [data-action="retry"]').click();

    expect(queueAPI.showItemInFolder).toHaveBeenCalledWith(outPath);
    expect(queueAPI.clearJob).toHaveBeenCalledWith('queued-1');
    expect(queueAPI.stopJob).not.toHaveBeenCalled();
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
