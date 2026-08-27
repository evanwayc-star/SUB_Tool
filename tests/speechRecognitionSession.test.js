import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  getAsrSession,
  startAsrSession,
  updateAsrSessionProgress,
  updateAsrSessionStatus,
  setAsrSessionDialogOpen,
  cancelActiveAsrSession,
  completeAsrSession,
  failAsrSession,
  onAsrSessionChange,
  clearAsrSession
} from '../src/speech-recognition-session.js';

describe('語音辨識背景工作階段管理器 (speech-recognition-session)', () => {
  beforeEach(() => {
    clearAsrSession();
  });

  it('啟動新工作階段時建立初始資料結構並通知訂閱者', () => {
    const events = [];
    const unsub = onAsrSessionChange(s => events.push(s ? { ...s } : null));

    const controller = new AbortController();
    const session = startAsrSession({
      controller,
      taskMode: 'transcribe',
      provider: 'builtin',
      builtinModel: 'onnx-community/whisper-tiny',
      language: 'zh',
      clips: [{ id: 'clip-1', in: 0, out: 10, dur: 10 }],
      conf: { provider: 'builtin' },
      dialogOpen: true
    });

    expect(session).toBeTruthy();
    expect(session.id).toMatch(/^asr-\d+/);
    expect(session.progress.status).toBe('preparing');
    expect(session.progress.indeterminate).toBe(true);
    expect(session.dialogOpen).toBe(true);
    expect(getAsrSession()).toBe(session);
    expect(events.length).toBeGreaterThan(0);

    unsub();
  });

  it('若已存在未結束的工作階段，啟動新階段時會中止前一個工作階段', () => {
    const controller1 = new AbortController();
    const session1 = startAsrSession({ controller: controller1, taskMode: 'transcribe' });

    expect(controller1.signal.aborted).toBe(false);

    const controller2 = new AbortController();
    const session2 = startAsrSession({ controller: controller2, taskMode: 'align' });

    expect(controller1.signal.aborted).toBe(true);
    expect(controller2.signal.aborted).toBe(false);
    expect(getAsrSession()).toBe(session2);
  });

  it('即時更新進度與狀態文字並通知訂閱者', () => {
    const controller = new AbortController();
    startAsrSession({ controller, taskMode: 'transcribe' });

    const snapshots = [];
    onAsrSessionChange(s => {
      if (s) snapshots.push({ percent: s.progress?.percent, message: s.progress?.message, statusText: s.statusText });
    });

    updateAsrSessionProgress({
      status: 'loading',
      percent: 45,
      indeterminate: false,
      message: '正在下載 AI 模型檔案 (model.onnx)…'
    });

    expect(snapshots.at(-1)).toEqual({
      percent: 45,
      message: '正在下載 AI 模型檔案 (model.onnx)…',
      statusText: '正在準備音訊並進行分析…'
    });

    updateAsrSessionStatus('[1/2] 本機推論中…');
    expect(snapshots.at(-1).statusText).toBe('[1/2] 本機推論中…');
  });

  it('支援切換對話框開啟／背景執行狀態', () => {
    startAsrSession({ controller: new AbortController(), dialogOpen: true });
    expect(getAsrSession().dialogOpen).toBe(true);

    setAsrSessionDialogOpen(false);
    expect(getAsrSession().dialogOpen).toBe(false);

    setAsrSessionDialogOpen(true);
    expect(getAsrSession().dialogOpen).toBe(true);
  });

  it('取消工作階段時會發出 signal 中止、更新狀態為 cancelled 並清除活動階段', () => {
    const controller = new AbortController();
    const session = startAsrSession({ controller });

    expect(controller.signal.aborted).toBe(false);

    const cancelled = cancelActiveAsrSession();
    expect(cancelled.id).toBe(session.id);
    expect(controller.signal.aborted).toBe(true);
    expect(cancelled.progress.status).toBe('cancelled');
    expect(getAsrSession()).toBeNull();
  });

  it('完成工作階段時標記 completed 狀態與 100% 進度', () => {
    startAsrSession({ controller: new AbortController() });
    const results = [{ clip: { id: 'c1' }, segments: [{ start: 0, end: 1, text: '你好' }] }];

    completeAsrSession(results);
    const session = getAsrSession();
    expect(session.progress.status).toBe('completed');
    expect(session.progress.percent).toBe(100);
    expect(session.results).toEqual(results);
  });

  it('工作階段失敗時記錄錯誤與 failed 狀態', () => {
    startAsrSession({ controller: new AbortController() });
    const err = new Error('網路超時');

    failAsrSession(err);
    const session = getAsrSession();
    expect(session.progress.status).toBe('failed');
    expect(session.error).toBe(err);
    expect(session.statusText).toContain('網路超時');
  });
});
