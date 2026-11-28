// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openModal, closeModal } from '../src/ui.js';
import { openScreenTextMonitorDialog, openScreenTextRecognitionDialog } from '../src/screen-text-recognition-dialog.js';
import { getScreenTextPlan, recognizeClipText } from '../src/screen-text-recognition.js';
import { getScreenTextSession } from '../src/screen-text-session.js';
import { Project } from '../src/project.js';
import { State } from '../src/state.js';

vi.mock('../src/media.js', () => ({ Media: { mpvMode:false } }));
vi.mock('../src/project.js', () => ({ Project:{ onWorkspaceInvalidated:vi.fn(() => () => {}) } }));
vi.mock('../src/screen-text-recognition.js', () => ({ getScreenTextPlan:vi.fn(), recognizeClipText:vi.fn() }));

const clip = { name:'<節目>.mov' };
const otherClip = { name:'另一段.mov' };
const element = id => document.getElementById(id);
const settings = { provider:'openai', model:'gpt-5.4', sourceLang:'auto', sampleFps:10,
  frameWidth:1920, smartAccuracy:true, hasApiKey:{openai:true,gemini:true} };
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
async function openDialog(...args) {
  openScreenTextRecognitionDialog(...args);
  await tick();
}
beforeEach(() => {
  document.body.innerHTML = '<div id="modalBg"><div class="modal"><div id="modalTitle"></div><div id="modalBody"></div><div id="modalFoot"></div></div></div><div id="toast"></div>';
  window.subtool = { getScreenTextSettings:vi.fn(async () => ({ ...settings })), saveScreenTextSettings:vi.fn(async value => ({ ...value, hasApiKey:{openai:true,gemini:true} })) };
  recognizeClipText.mockReset();
  getScreenTextPlan.mockReset().mockImplementation((target, scope) => ({
    range: scope === 'export' ? { start:2, end:8 } : { start:0, end:10 },
    windows: (scope === 'clip' ? [target] : [target, otherClip, target]).map(clip => ({clip})),
    fps:25, dropFrame:false,
  }));
});
afterEach(() => {
  closeModal();
  Project.onWorkspaceInvalidated.mock.lastCall?.[0]();
  Project.onWorkspaceInvalidated.mockClear();
});

it('重新開啟時保留已存的 mini、低取樣與較小畫面設定', async () => {
  window.subtool.getScreenTextSettings.mockResolvedValue({ ...settings, model:'gpt-5.4-mini', sampleFps:2, frameWidth:960, smartAccuracy:false });
  recognizeClipText.mockReturnValue(new Promise(() => {}));
  await openDialog(clip, () => true);
  expect(element('ocrModel').value).toBe('gpt-5.4-mini');
  expect(element('ocrSampleFps').value).toBe('2');
  expect(element('ocrFrameWidth').value).toBe('960');
  expect(element('ocrSmartAccuracy').checked).toBe(false);
  element('ocrStart').click(); await tick();
  expect(recognizeClipText.mock.lastCall[1]).toMatchObject({ model:'gpt-5.4-mini', sampleFps:2, frameWidth:960, smartAccuracy:false });
});

it('starts once with flagship cloud vision settings at ten samples per second and reports the generated cue count', async () => {
  let finish;
  recognizeClipText.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await openDialog(clip, () => true);
  expect(Array.from(element('ocrSourceLang').options, option => [option.value, option.label])).toEqual([
    ['auto', '自動判斷'], ['zh', '中文'], ['en', '英文'], ['ja', '日文'], ['ko', '韓文'],
  ]);
  expect(element('ocrScope').value).toBe('clip');
  expect(element('ocrScopeRange').textContent).toContain('00:00:10:00');
  expect(element('modalBody').querySelector('strong').textContent).toBe(clip.name);
  const start = element('ocrStart');
  start.click();
  start.click();
  await tick();
  expect(recognizeClipText).toHaveBeenCalledTimes(1);
  const [target, options] = recognizeClipText.mock.lastCall;
  expect(target).toBe(clip);
  expect(options).toMatchObject({ provider:'openai', model:'gpt-5.4', sourceLang:'auto', sampleFps:10, frameWidth:1920, smartAccuracy:true });
  const currentBar = element('ocrProgressBar');
  openScreenTextMonitorDialog();
  expect(element('ocrProgressBar')).toBe(currentBar);
  options.onProgress({ progress:0.5 });
  expect(element('ocrProgressBar').value).toBe(0.5);
  finish({ count:3 });
  await vi.waitFor(() => expect(element('ocrStatus').textContent).toContain('3 則字幕'));
  element('ocrClose').click();
  expect(getScreenTextSession()).toBeNull();
  expect(options.signal.aborted).toBe(false);
});

it.each([
  ['all','In 00:00:00:00　Out 00:00:10:00'],
  ['export','In 00:00:02:00　Out 00:00:08:00'],
])('shows the %s timeline range and restores the frozen range in the background monitor', async (mode, expectedRange) => {
  recognizeClipText.mockReturnValue(new Promise(() => {}));
  let sameClip = true;
  await openDialog(clip, () => sameClip, () => true);
  const scope = element('ocrScope');
  scope.value = mode;
  scope.dispatchEvent(new Event('change'));
  expect(element('ocrScopeSource').textContent).toBe('2 個影片片段');
  expect(element('ocrScopeRange').textContent).toBe(expectedRange);
  sameClip = false;
  element('ocrStart').click(); await tick();
  expect(getScreenTextSession().scope).toBe(mode);
  expect(element('ocrMonitorRange').textContent).toBe(expectedRange);
  expect(element('modalBody').querySelector('strong').textContent).not.toContain(clip.name);
  element('ocrMinimize').click();
  getScreenTextPlan.mockImplementation(() => { throw new Error('目前輸出範圍已變更'); });
  openScreenTextMonitorDialog();
  expect(element('ocrMonitorRange').textContent).toBe(expectedRange);
  expect(recognizeClipText).toHaveBeenCalledTimes(1);
});

it('shows the timecodes and blocks starting when the export interval has no video', async () => {
  const availablePlan = getScreenTextPlan.getMockImplementation();
  getScreenTextPlan.mockImplementation((clip, scope) => {
    if (scope === 'export') throw Object.assign(new Error('輸出範圍內沒有可辨識的影片。'), { range:{start:12,end:15} });
    return availablePlan(clip, scope);
  });
  await openDialog(clip, () => true);
  const scope = element('ocrScope');
  scope.value = 'export';
  scope.dispatchEvent(new Event('change'));
  expect(element('ocrScopeError').textContent).toContain('沒有可辨識的影片');
  expect(element('ocrScopeError').hidden).toBe(false);
  expect(element('ocrScopeRange').textContent).toBe('In 00:00:12:00　Out 00:00:15:00');
  expect(element('ocrStart').disabled).toBe(true);
  element('ocrStart').click(); await tick();
  expect(recognizeClipText).not.toHaveBeenCalled();
  scope.value = 'all';
  scope.dispatchEvent(new Event('change'));
  expect(element('ocrStart').disabled).toBe(false);
  expect(element('ocrScopeError').hidden).toBe(true);
});

it('identifies which end of the export interval uses the timeline default', async () => {
  const original = { exportIn:State.exportIn, exportOut:State.exportOut };
  try {
    Object.assign(State, { exportIn:2, exportOut:null });
    await openDialog(clip, () => true);
    element('ocrScope').value = 'export';
    element('ocrScope').dispatchEvent(new Event('change'));
    expect(element('ocrScopeDefault').hidden).toBe(false);
    expect(element('ocrScopeDefault').textContent).toBe('Out 採時間軸終點');
    State.exportOut = 8;
    element('ocrScope').dispatchEvent(new Event('change'));
    expect(element('ocrScopeDefault').hidden).toBe(true);
  } finally { Object.assign(State, original); }
});

it('rejects a stale project even for whole-timeline OCR', async () => {
  let current = true;
  await openDialog(clip, () => true, () => current);
  element('ocrScope').value = 'all';
  element('ocrScope').dispatchEvent(new Event('change'));
  current = false;
  element('ocrStart').click(); await tick();
  expect(recognizeClipText).not.toHaveBeenCalled();
  expect(element('toast').textContent).toContain('專案已變更');
});

it.each(['minimize','dismiss','replace'])('keeps the job running on %s and restores the same progress', async reason => {
  let finish;
  recognizeClipText.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await openDialog(clip, () => true);
  element('ocrStart').click(); await tick();
  const options = recognizeClipText.mock.lastCall[1];
  const oldCancel = element('ocrCancel');
  if (reason === 'minimize') element('ocrMinimize').click();
  else if (reason === 'dismiss') closeModal();
  else openModal('下一個視窗', '<p>新工作</p>');
  expect(getScreenTextSession().dialogOpen).toBe(false);
  oldCancel.click();
  expect(options.signal.aborted).toBe(false);
  options.onProgress({progress:0.65});
  if (reason === 'replace') {
    expect(element('modalTitle').textContent).toBe('下一個視窗');
    await openDialog({name:'另一個片段'}, () => true);
  } else openScreenTextMonitorDialog();
  expect(getScreenTextSession().dialogOpen).toBe(true);
  expect(element('modalBody').querySelector('strong').textContent).toBe(clip.name);
  expect(element('ocrProgressBar').value).toBe(0.65);
  expect(recognizeClipText).toHaveBeenCalledTimes(1);
  finish({ count:3 });
  await vi.waitFor(() => expect(element('ocrStatus').textContent).toContain('3 則字幕'));
});

it('leaves another dialog undisturbed on background completion, then opens the result or a fresh clip setup', async () => {
  let finish;
  recognizeClipText.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await openDialog(clip, () => true);
  element('ocrStart').click(); await tick();
  openModal('編輯字幕', '<input id="draft" value="我的修改">');
  finish({ count:1 });
  await vi.waitFor(() => expect(getScreenTextSession().status).toBe('completed'));
  expect(element('draft').value).toBe('我的修改');
  openScreenTextMonitorDialog();
  expect(element('ocrStatus').textContent).toContain('1 則字幕');
  expect(element('ocrClose').hidden).toBe(false);
  expect(element('ocrCancel').hidden).toBe(true);
  await openDialog({name:'另一個片段'}, () => true);
  expect(element('modalBody').querySelector('strong').textContent).toBe('另一個片段');
  expect(element('ocrStart')).not.toBeNull();
  expect(recognizeClipText).toHaveBeenCalledTimes(1);
});

it('only aborts on explicit cancellation and displays cancellation until the worker settles', async () => {
  let fail;
  recognizeClipText.mockReturnValue(new Promise((_, reject) => { fail = reject; }));
  await openDialog(clip, () => true);
  element('ocrStart').click(); await tick();
  element('ocrMinimize').click();
  openScreenTextMonitorDialog();
  element('ocrCancel').click();
  expect(recognizeClipText.mock.lastCall[1].signal.aborted).toBe(true);
  expect(element('ocrCancel').disabled).toBe(true);
  expect(getScreenTextSession().status).toBe('cancelling');
  element('ocrMinimize').click();
  await openDialog(clip, () => true);
  expect(element('ocrCancel').disabled).toBe(true);
  fail(new DOMException('已取消', 'AbortError'));
  await vi.waitFor(() => expect(element('ocrStatus').textContent).toContain('已取消'));
  element('ocrClose').click();
  expect(getScreenTextSession()).toBeNull();
  expect(recognizeClipText).toHaveBeenCalledTimes(1);
});

it('closes the progress view when its project is replaced', async () => {
  recognizeClipText.mockReturnValue(new Promise(() => {}));
  await openDialog(clip, () => true);
  element('ocrStart').click(); await tick();
  Project.onWorkspaceInvalidated.mock.lastCall[0]();
  expect(element('modalBg').classList.contains('show')).toBe(false);
  expect(getScreenTextSession()).toBeNull();
});

it.each(['加入','捨棄'])('前段結果可稍後決定，從其他片段再開仍須明確選擇%s', async choice => {
  let finish;
  recognizeClipText.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const commitPartial = vi.fn(() => 3);
  await openDialog(clip, () => true);
  element('ocrStart').click(); await tick();
  element('ocrCancel').click();
  expect(recognizeClipText.mock.lastCall[1].signal.reason.keepScreenTextResults).toBe(true);
  finish({ count:3, commitPartial });
  await vi.waitFor(() => expect(element('ocrKeepPartial').hidden).toBe(false));
  expect(element('ocrStatus').textContent).toContain('3 則');
  expect(element('ocrCancel').hidden).toBe(true);
  const staleKeep = element('ocrKeepPartial');
  element('ocrLater').click();
  staleKeep.click();
  expect(commitPartial).not.toHaveBeenCalled();
  expect(getScreenTextSession()).toMatchObject({ status:'partial', dialogOpen:false });
  await openDialog(otherClip, () => true);
  expect(element('modalBody').querySelector('strong').textContent).toBe(clip.name);
  expect(recognizeClipText).toHaveBeenCalledOnce();
  const button = element(choice === '加入' ? 'ocrKeepPartial' : 'ocrDiscardPartial');
  button.click();
  button.click();
  if (choice === '加入') {
    expect(commitPartial).toHaveBeenCalledOnce();
    expect(getScreenTextSession()).toMatchObject({ status:'completed', count:3 });
    expect(element('ocrStatus').textContent).toContain('已將 3 則字幕加入');
  } else {
    expect(commitPartial).not.toHaveBeenCalled();
    expect(getScreenTextSession()).toBeNull();
    expect(element('modalBg').classList.contains('show')).toBe(false);
  }
});

it('restores the original clip settings on a foreground failure after reopening progress from a different clip', async () => {
  let fail;
  recognizeClipText.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
  await openDialog(clip, () => true);
  element('ocrSampleFps').value = '3';
  element('ocrStart').click(); await tick();
  element('ocrMinimize').click();
  await openDialog({name:'不同來源'}, () => true);
  fail(new Error('模型載入失敗'));
  await vi.waitFor(() => expect(element('ocrError')?.textContent).toBe('模型載入失敗'));
  expect(element('modalBody').querySelector('strong').textContent).toBe(clip.name);
  expect(element('ocrSampleFps').valueAsNumber).toBe(3);
});

it('validates sampling and API readiness and retains settings for retry', async () => {
  recognizeClipText.mockRejectedValueOnce(new Error('模型無法辨識')).mockResolvedValueOnce({ count:0 });
  window.subtool.getScreenTextSettings.mockResolvedValue({ ...settings, hasApiKey:{} });
  await openDialog(clip, () => true);
  element('ocrSampleFps').value = '0';
  element('ocrStart').click(); await tick();
  expect(recognizeClipText).not.toHaveBeenCalled();
  element('ocrSampleFps').value = '4';
  element('ocrStart').click(); await tick();
  expect(element('ocrError').textContent).toContain('API 金鑰');
  element('ocrSourceLang').value = 'ja';
  element('ocrApiKey').value = 'private-key';
  element('ocrStart').click(); await tick();
  expect(window.subtool.saveScreenTextSettings).toHaveBeenCalledWith(expect.objectContaining({ apiKey:'private-key' }));
  expect(recognizeClipText.mock.lastCall[1]).toMatchObject({ sourceLang:'ja', sampleFps:4 });
  expect(recognizeClipText.mock.lastCall[1]).not.toHaveProperty('apiKey');
  await vi.waitFor(() => expect(element('ocrError')?.textContent).toBe('模型無法辨識'));
  await tick();
  expect(element('ocrApiKey').value).toBe('');
  expect(element('ocrSourceLang').value).toBe('ja');
});

it('零預算可免金鑰啟動，實際估價 0.00001 與零請求均顯示',async()=>{
  window.subtool.getScreenTextSettings.mockResolvedValue({...settings,hasApiKey:{}});
  recognizeClipText.mockResolvedValue({count:0,metrics:{newRequests:0,estimatedCostUsd:.00001}});
  await openDialog(clip,()=>true);
  element('ocrBudget').value='0';element('ocrStart').click();
  await vi.waitFor(()=>expect(element('ocrUsage')?.textContent).toContain('本次估計 US$0.00001'));
  expect(element('ocrUsage').textContent).toContain('本次新增 0 請求');
  expect(recognizeClipText.mock.lastCall[1]).toMatchObject({maxNewRequests:0});
});

it('重試扣除前次已經送出的請求並保留內容模式與區域',async()=>{
  recognizeClipText.mockRejectedValue(Object.assign(new Error('連線中斷'),{metrics:{newRequests:2}}));
  await openDialog(clip,()=>true);
  element('ocrUseRegion').click();element('ocrRegion3').value='30';
  element('ocrBudget').value='5';element('ocrContentMode').value='variety';element('ocrStart').click();
  await vi.waitFor(()=>expect(element('ocrError')?.textContent).toBe('連線中斷'));
  expect(element('ocrBudget').valueAsNumber).toBe(3);
  expect(element('ocrUseRegion').checked).toBe(true);expect(element('ocrRegion3').valueAsNumber).toBe(30);
  expect(element('ocrContentMode').value).toBe('variety');
});

it('a relink or removed clip invalidates an open setup dialog', async () => {
  let current = true;
  await openDialog(clip, () => current);
  current = false;
  element('ocrStart').click(); await tick();
  expect(recognizeClipText).not.toHaveBeenCalled();
  expect(element('toast').textContent).toContain('片段已變更');
});

it('switches providers without carrying a typed key and stores only nonsecret job options', async () => {
  recognizeClipText.mockReturnValue(new Promise(() => {}));
  await openDialog(clip, () => true);
  element('ocrApiKey').value = 'openai-private';
  element('ocrProvider').value = 'gemini';
  element('ocrProvider').dispatchEvent(new Event('change'));
  expect(element('ocrApiKey').value).toBe('');
  const defaultModel=element('ocrModel').selectedOptions[0];
  expect(defaultModel.textContent).toContain('預設');
  element('ocrApiKey').value = 'gemini-private';
  element('ocrFrameWidth').value = '960';
  element('ocrSmartAccuracy').checked = false;
  element('ocrStart').click(); await tick();
  expect(window.subtool.saveScreenTextSettings).toHaveBeenCalledWith({
    provider:'gemini', model:defaultModel.value, sourceLang:'auto', sampleFps:10,contentMode:'faithful',region:null,
    frameWidth:960, smartAccuracy:false, apiKey:'gemini-private',
  });
  expect(getScreenTextSession()).toMatchObject({provider:'gemini', frameWidth:960, smartAccuracy:false});
  expect(JSON.stringify(getScreenTextSession())).not.toContain('private');
});

it('does not start a stale project or replace another modal after saving credentials', async () => {
  let save, owns = true;
  window.subtool.saveScreenTextSettings.mockImplementation(() => new Promise(resolve => { save = resolve; }));
  await openDialog(clip, () => owns);
  const key = element('ocrApiKey');
  key.value = 'secret';
  element('ocrStart').click();
  owns = false;
  openModal('其他工作', '<p>繼續編輯</p>');
  expect(key.value).toBe('');
  save(settings); await tick();
  expect(recognizeClipText).not.toHaveBeenCalled();
  expect(element('modalTitle').textContent).toBe('其他工作');
});

it('ignores late settings when the setup dialog has closed', async () => {
  let loaded;
  window.subtool.getScreenTextSettings.mockImplementation(() => new Promise(resolve => { loaded = resolve; }));
  openScreenTextRecognitionDialog(clip, () => true);
  expect(element('ocrStart').disabled).toBe(true);
  openModal('其他工作', '<p>繼續編輯</p>');
  loaded(settings); await tick();
  expect(element('modalTitle').textContent).toBe('其他工作');
  expect(recognizeClipText).not.toHaveBeenCalled();
});
