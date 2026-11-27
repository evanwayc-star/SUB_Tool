import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Project } from '../src/project.js';
import { getScreenTextPlan, recognizeClipText } from '../src/screen-text-recognition.js';
import {
  cancelScreenTextSession, clearScreenTextSession, getScreenTextSession, onScreenTextSessionChange,
  resolveScreenTextPartial, setScreenTextDialogOpen, startScreenTextSession,
} from '../src/screen-text-session.js';

vi.mock('../src/project.js', () => ({ Project: { onWorkspaceInvalidated: vi.fn() } }));
vi.mock('../src/screen-text-recognition.js', () => ({ getScreenTextPlan: vi.fn(), recognizeClipText: vi.fn() }));

const options = { provider:'openai', model:'gpt-5.4-mini', sourceLang:'auto', sampleFps: 2 };
const clip = { name: '片段一' };
let invalidate, finish, fail, release, unsubscribe;
beforeEach(() => {
  vi.clearAllMocks();
  release = vi.fn();
  getScreenTextPlan.mockReturnValue({ range: { start: 0, end: 2 }, windows: [{}], fps: 25, dropFrame: false });
  Project.onWorkspaceInvalidated.mockImplementation(callback => { invalidate = callback; return release; });
  recognizeClipText.mockImplementation(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
});
afterEach(() => { unsubscribe?.(); unsubscribe = null; invalidate?.(); });

it.each([['openai','gpt-5.4'],['gemini','gemini-3.8-flash']])('缺省工作採 %s 的旗艦與最高品質，明確選項仍可覆寫', (provider, model) => {
  const job = startScreenTextSession(clip, { provider });
  expect(job).toMatchObject({ provider, model, sampleFps:10, frameWidth:1920, smartAccuracy:true });
  expect(recognizeClipText.mock.lastCall[1]).toMatchObject({ provider, model, sampleFps:10, frameWidth:1920, smartAccuracy:true });
});

it('輸出點只在開始時決定，背景工作與進度顯示共用當時的設定', async () => {
  const plan = { range: { start: 3, end: 8 }, windows: [{}, {}], fps: 29.97, dropFrame: true };
  getScreenTextPlan.mockReturnValueOnce(plan);
  const job = startScreenTextSession(clip, { ...options, scope: 'export' });
  expect(getScreenTextPlan).toHaveBeenCalledWith(clip, 'export');
  expect(recognizeClipText.mock.calls[0][1].plan).toBe(plan);
  expect(job).toMatchObject({ scope: 'export', clipName: '輸出 In／Out 範圍', range: { start: 3, end: 8 },
    windowCount: 2, fps: 29.97, dropFrame: true });
  setScreenTextDialogOpen(job.id, false);
  expect(startScreenTextSession(clip, { ...options, scope: 'all' }).id).toBe(job.id);
  expect(getScreenTextPlan).toHaveBeenCalledTimes(1);
  finish({ count: 1 });
  await Promise.resolve();
  expect(getScreenTextSession().range).toEqual({ start: 3, end: 8 });
});

it('工作只保存非機密辨識設定，API 金鑰不進入快照或辨識請求', () => {
  const job = startScreenTextSession(clip, { ...options, apiKey:'private-token', frameWidth:1024, smartAccuracy:false });
  expect(job).toMatchObject({ provider:'openai', sourceLang:'auto', frameWidth:1024, smartAccuracy:false });
  expect(job).not.toHaveProperty('apiKey');
  expect(recognizeClipText.mock.lastCall[1]).not.toHaveProperty('apiKey');
});

it('輸出區間沒有可辨識畫面時不啟動工作，也不蓋掉前次結果', async () => {
  startScreenTextSession(clip, options);
  finish({ count: 1 });
  await Promise.resolve();
  const previous = getScreenTextSession();
  getScreenTextPlan.mockImplementationOnce(() => { throw new Error('範圍內沒有影片'); });
  expect(() => startScreenTextSession(clip, { ...options, scope: 'export' })).toThrow('沒有影片');
  expect(recognizeClipText).toHaveBeenCalledTimes(1);
  expect(getScreenTextSession()).toBe(previous);
});

it('收起和還原同一個工作，保留進度並在完成時維持背景編輯的選取', async () => {
  const observed = vi.fn();
  unsubscribe = onScreenTextSessionChange(observed);
  const { id } = startScreenTextSession(clip, options);
  const request = recognizeClipText.mock.calls[0][1];
  expect(request.preserveSelection()).toBe(false);
  setScreenTextDialogOpen(id, false);
  request.onProgress({ progress: 0.4 });
  expect(getScreenTextSession()).toMatchObject({ id, clipName: clip.name, dialogOpen: false, progress: 0.4 });
  expect(startScreenTextSession({ name: '另一個片段' }, options).id).toBe(id);
  setScreenTextDialogOpen(id, true);
  expect(recognizeClipText).toHaveBeenCalledTimes(1);
  expect(request.signal.aborted).toBe(false);
  expect(request.preserveSelection()).toBe(true);
  finish({ count: 3 });
  await Promise.resolve();
  expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({ id, status: 'completed', count: 3 }));
  clearScreenTextSession(id);
  expect(observed).toHaveBeenLastCalledWith(null);
  expect(release).toHaveBeenCalledOnce();
});

it('明確取消會等待工作結束，過期操作不影響下個工作', async () => {
  const { id } = startScreenTextSession(clip, options);
  const request = recognizeClipText.mock.calls[0][1];
  cancelScreenTextSession(id);
  clearScreenTextSession(id);
  request.onProgress({ progress: 0.5 });
  expect(request.signal.aborted).toBe(true);
  expect(getScreenTextSession()).toMatchObject({ status: 'cancelling', progress: null });
  expect(startScreenTextSession(clip, options).id).toBe(id);
  fail(new DOMException('已取消', 'AbortError'));
  await Promise.resolve();
  expect(getScreenTextSession().status).toBe('cancelled');
  const next = startScreenTextSession(clip, options);
  clearScreenTextSession(id);
  setScreenTextDialogOpen(id, false);
  cancelScreenTextSession(id);
  expect(getScreenTextSession()).toBe(next);
  finish({ count: 0 });
  await Promise.resolve();
  expect(getScreenTextSession().count).toBe(0);
});

it('切換專案後清空狀態並忽略舊通知；背景錯誤保留供還原查看', async () => {
  startScreenTextSession(clip, options);
  const oldRequest = recognizeClipText.mock.calls[0][1];
  const oldFail = fail;
  invalidate();
  expect(oldRequest.signal.aborted).toBe(true);
  expect(getScreenTextSession()).toBeNull();
  const { id } = startScreenTextSession(clip, options);
  setScreenTextDialogOpen(id, false);
  oldRequest.onProgress({ progress: 0.9 });
  oldFail(new Error('舊錯誤'));
  await Promise.resolve();
  expect(getScreenTextSession()).toMatchObject({ id, progress: null, status: 'running' });
  fail(new Error('模型讀取失敗'));
  await Promise.resolve();
  expect(getScreenTextSession()).toMatchObject({ status: 'failed', message: '模型讀取失敗', dialogOpen: false });
  invalidate();
  expect(getScreenTextSession()).toBeNull();
});

it('尚未決定的部分字幕由本工作持有，換專案或舊按鈕都不能再加入', async () => {
  const job = startScreenTextSession(clip, options);
  cancelScreenTextSession(job.id);
  const commitPartial = vi.fn(() => 2);
  finish({ count:2, commitPartial });
  await Promise.resolve();
  clearScreenTextSession(job.id);
  expect(startScreenTextSession(clip, options)).toMatchObject({ id:job.id, status:'partial' });
  invalidate();
  const next = startScreenTextSession(clip, options);
  resolveScreenTextPartial(job.id, true);
  expect(getScreenTextSession().id).toBe(next.id);
  expect(commitPartial).not.toHaveBeenCalled();
});
