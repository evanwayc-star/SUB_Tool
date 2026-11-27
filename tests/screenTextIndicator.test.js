// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { bindScreenTextIndicator } from '../src/ui.js';

const source = readFileSync('index.html', 'utf8');
const running = {
  id:'ocr-job', clipName:'第二段', status:'running', progress:null, message:'正在載入模型', dialogOpen:false,
};
let button, toast, publish;

beforeEach(() => {
  const page = new DOMParser().parseFromString(source, 'text/html');
  button = page.getElementById('screenTextMonitorBtn');
  toast = page.getElementById('toast');
  document.body.replaceChildren(button, toast);
  bindScreenTextIndicator(button, null, listener => { publish = listener; });
});

describe('工具列畫面文字辨識進度', () => {
  it('只在有可查看的工作時顯示，能分別辨認載入、進度與取消中', () => {
    expect(getComputedStyle(button).display).toBe('none');
    publish(running);
    expect(getComputedStyle(button).display).not.toBe('none');
    expect(button.classList.contains('ocr-running')).toBe(true);
    expect(button.textContent).toContain('畫面文字 辨識中');
    expect(button.title).toContain('第二段');
    publish({ ...running, progress:0.327 });
    expect(button.textContent).toContain('33%');
    expect(button.getAttribute('aria-label')).toContain('查看辨識進度');
    publish({ ...running, status:'cancelling' });
    expect(button.textContent).toContain('取消中');
    publish({ ...running, status:'cancelled' });
    expect(getComputedStyle(button).display).toBe('none');
  });

  it.each([
    ['completed', '完成', '已新增 3 則字幕'],
    ['completed', '完成', '這個片段沒有辨識到文字。'],
    ['partial', '待加入', '已停止辨識，已辨識到 3 則字幕。要將這些字幕加入新軌嗎？'],
    ['failed', '失敗', '無法載入模型'],
  ])('背景工作 %s 保留結果入口並只提醒一次（%s，%s）', (status, state, message) => {
    publish(running);
    const terminal = { ...running, status, message };
    publish(terminal);
    expect(button.classList.contains('ocr-running')).toBe(false);
    expect(button.textContent).toContain(state);
    expect(button.title).toContain('查看辨識結果');
    expect(toast.textContent).toContain(message);
    toast.textContent = '';
    publish({ ...terminal, dialogOpen:true });
    publish({ ...terminal, dialogOpen:false });
    expect(toast.textContent).toBe('');
    publish(null);
    expect(getComputedStyle(button).display).toBe('none');
  });

  it('前景已看到結果時，收起視窗不再提醒', () => {
    publish({ ...running, dialogOpen:true });
    const completed = { ...running, status:'completed', message:'已新增 1 則字幕' };
    publish({ ...completed, dialogOpen:true });
    publish(completed);
    expect(toast.textContent).toBe('');
    expect(button.textContent).toContain('完成');
  });
});
