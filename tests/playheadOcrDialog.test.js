// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openPlayheadOcr } from '../src/playhead-ocr-dialog.js';
import { closeModal, openModal } from '../src/ui.js';
import { DESK } from '../src/state.js';
import { Media } from '../src/media.js';
import { Project } from '../src/project.js';
import { capturePlayheadOcrCanvas, encodePlayheadOcrRegion } from '../src/playhead-ocr-frame.js';
import { mountPlayheadOcrRegion } from '../src/playhead-ocr-region.js';
import { commitPlayheadOcrCue } from '../src/playhead-ocr-cue.js';

vi.mock('../src/state.js', async importOriginal=>({...await importOriginal(), DESK:{
  recognizeFrameText:vi.fn(), cancelFrameText:vi.fn(async()=>{}),
}}));
vi.mock('../src/media.js',()=>({Media:{displayTime:vi.fn(),mpvMode:false}}));
vi.mock('../src/project.js',()=>({Project:{captureWorkspaceOwnership:()=>()=>true,onWorkspaceInvalidated:vi.fn(()=>()=>{})}}));
vi.mock('../src/playhead-ocr-frame.js',()=>({capturePlayheadOcrCanvas:vi.fn(),encodePlayheadOcrRegion:vi.fn()}));
vi.mock('../src/playhead-ocr-region.js',()=>({mountPlayheadOcrRegion:vi.fn(()=>()=>{})}));
vi.mock('../src/playhead-ocr-cue.js',async original=>({...await original(),commitPlayheadOcrCue:vi.fn()}));

const el=id=>document.getElementById(id);
beforeEach(()=>{
  vi.clearAllMocks();
  document.body.innerHTML='<div id="modalBg"><div class="modal"><div id="modalTitle"></div><div id="modalBody"></div><div id="modalFoot"></div></div></div>';
  Media.displayTime.mockReturnValue(2.4);
  capturePlayheadOcrCanvas.mockResolvedValue({time:2.4,canvas:document.createElement('canvas')});
  encodePlayheadOcrRegion.mockResolvedValue('png');
  DESK.recognizeFrameText.mockResolvedValue({text:'你好\n<字幕> العربية'});
});
afterEach(()=>closeModal());

async function select(rect = null) {
  mountPlayheadOcrRegion.mock.lastCall[2](rect ? [rect] : null);
  await el('playheadOcrStart').onclick();
}

it('凍結畫格後先顯示框選工具，使用者選取前不啟動 OCR',async()=>{
  await openPlayheadOcr();
  expect(el('playheadOcrRegion').hidden).toBe(false);
  el('modalFoot').querySelector('button').click();
  expect(encodePlayheadOcrRegion).not.toHaveBeenCalled();
  expect(DESK.recognizeFrameText).not.toHaveBeenCalled();
  expect(commitPlayheadOcrCue).not.toHaveBeenCalled();
});

it('校對內容作為純文字保留換行，只在確認後提交到原始播放點',async()=>{
  const run=openPlayheadOcr();
  Media.displayTime.mockReturnValue(9);
  await run;
  expect(capturePlayheadOcrCanvas.mock.calls[0][0]).toBe(2.4);
  const rect = {x:20,y:40,width:100,height:20};
  await select(rect);
  expect(encodePlayheadOcrRegion.mock.lastCall[1]).toEqual([rect]);
  const input=el('playheadOcrText');
  expect(input.value).toBe('你好\n<字幕> العربية');
  expect(el('playheadOcrStatus').textContent).toMatch(/ · 2 秒$/);
  expect(commitPlayheadOcrCue).not.toHaveBeenCalled();
  input.value='修改後\nالعربية';
  input.dispatchEvent(new Event('input'));
  el('playheadOcrConfirm').click();
  expect(commitPlayheadOcrCue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    time:2.4,originalText:'你好\n<字幕> العربية',text:'修改後\nالعربية',
  }));
  expect(el('modalBg').classList.contains('show')).toBe(false);
});

it.each(['取消','換專案','取代視窗'])('%s 後丟棄遲到的 OCR 結果，也撤銷原生工作',async reason=>{
  let finish;
  DESK.recognizeFrameText.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  await openPlayheadOcr();
  const run=select();
  await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
  if(reason==='取消') el('modalFoot').querySelector('button').click();
  if(reason==='換專案') Project.onWorkspaceInvalidated.mock.lastCall[0]();
  if(reason==='取代視窗') openModal('其他操作','',[]);
  expect(DESK.cancelFrameText).toHaveBeenCalledWith(DESK.recognizeFrameText.mock.lastCall[0].requestId);
  finish({text:'過期結果'});
  await run;
  expect(commitPlayheadOcrCue).not.toHaveBeenCalled();
  expect(el('playheadOcrText')?.value||'').toBe('');
});

it('沒讀到文字時容許手動校正，空白不能提交',async()=>{
  DESK.recognizeFrameText.mockResolvedValueOnce({text:''});
  await openPlayheadOcr();
  await select();
  expect(el('playheadOcrStatus').textContent).toContain('沒有辨識到文字');
  expect(el('playheadOcrConfirm').disabled).toBe(true);
  el('playheadOcrText').value='補字';
  el('playheadOcrText').dispatchEvent(new Event('input'));
  expect(el('playheadOcrConfirm').disabled).toBe(false);
  closeModal();
  expect(commitPlayheadOcrCue).not.toHaveBeenCalled();
});

it('組字確認與 Shift+Enter 換行仍由輸入欄處理，單按 Enter 建立一筆',async()=>{
  await openPlayheadOcr();
  await select();
  const input=el('playheadOcrText');
  const enter=opts=>input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...opts}));
  expect(enter({isComposing:true})).toBe(true);
  expect(enter({shiftKey:true})).toBe(true);
  expect(commitPlayheadOcrCue).not.toHaveBeenCalled();
  expect(enter({})).toBe(false);
  expect(commitPlayheadOcrCue).toHaveBeenCalledTimes(1);
});

it('同一個凍結畫格可重新框選，複選語言與白字選項傳給對應工作',async()=>{
  await openPlayheadOcr();
  const choices = el('playheadOcrOptions').querySelectorAll('fieldset input');
  expect(Array.from(choices, field => [field.value, field.labels[0].textContent])).toEqual([
    ['chi_tra','繁中'], ['chi_sim','簡中'], ['eng','英文'], ['jpn','日文'], ['kor','韓文'],
  ]);
  const chosen = el('playheadOcrOptions').querySelectorAll('input[value=chi_tra],input[value=eng]');
  chosen.forEach(input=>input.click());
  el('playheadOcrWhite').click();
  const rect={x:12,y:10,width:110,height:20};
  await select(rect);
  expect(encodePlayheadOcrRegion.mock.lastCall).toEqual([expect.anything(),[rect],expect.objectContaining({whiteSubtitles:true})]);
  expect(DESK.recognizeFrameText.mock.lastCall[0].languages).toEqual(['chi_tra','eng']);
  expect(el('playheadOcrLanguageSummary').textContent).toContain('繁中、英文');
  el('playheadOcrReselect').click();
  expect(el('playheadOcrRegion').hidden).toBe(false);
  expect(encodePlayheadOcrRegion).toHaveBeenCalledTimes(1);
  chosen.forEach(input=>input.click());
  el('playheadOcrWhite').click();
  await select();
  expect(encodePlayheadOcrRegion.mock.lastCall[1]).toBeNull();
  expect(DESK.recognizeFrameText.mock.lastCall[0].languages).toEqual([]);
  expect(capturePlayheadOcrCanvas).toHaveBeenCalledTimes(1);
});

it('編碼期間換專案不會送出畫格',async()=>{
  let finish;
  encodePlayheadOcrRegion.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  await openPlayheadOcr();
  const run=select();
  Project.onWorkspaceInvalidated.mock.lastCall[0]();
  finish('late');
  await run;
  expect(DESK.recognizeFrameText).not.toHaveBeenCalled();
  expect(commitPlayheadOcrCue).not.toHaveBeenCalled();
});

it('辨識中返回可立刻重選，舊請求結束或取消都不能覆蓋新校對框',async()=>{
  let oldResult, stopped;
  DESK.recognizeFrameText.mockImplementationOnce(()=>new Promise(resolve=>{oldResult=resolve;}));
  DESK.cancelFrameText.mockImplementationOnce(()=>new Promise(resolve=>{stopped=resolve;}));
  await openPlayheadOcr();
  const [,,change,drag]=mountPlayheadOcrRegion.mock.lastCall;
  const submit=el('playheadOcrStart').onclick;
  const first=[{x:0,y:0,width:30,height:20}];
  drag(true);
  await submit();
  expect(encodePlayheadOcrRegion).not.toHaveBeenCalled();
  drag(false);
  change(first);
  expect(el('playheadOcrStart').hasAttribute('data-enter-default')).toBe(true);
  const pending=submit();
  expect(document.querySelector('[data-enter-default]')).toBeNull();
  await vi.waitFor(()=>expect(oldResult).toBeTypeOf('function'));
  el('playheadOcrBack').click();
  expect(el('playheadOcrRegion').hidden).toBe(false);
  expect(mountPlayheadOcrRegion).toHaveBeenCalledTimes(1);
  const next=[...first,{x:50,y:80,width:40,height:30}];
  change(next);
  DESK.recognizeFrameText.mockResolvedValueOnce({text:'第二次的結果'});
  const resumed=submit();
  await Promise.resolve();
  expect(DESK.recognizeFrameText).toHaveBeenCalledTimes(1);
  stopped(true);
  await resumed;
  oldResult({text:'過期結果'});
  await pending;
  expect(el('playheadOcrText').value).toBe('第二次的結果');
  expect([...document.querySelectorAll('[data-enter-default]')]).toEqual([el('playheadOcrConfirm')]);
  expect(encodePlayheadOcrRegion.mock.lastCall[1]).toEqual(next);
  expect(capturePlayheadOcrCanvas).toHaveBeenCalledTimes(1);
});

it('空選區不送件，編碼中返回會丟棄舊資料並保留框選',async()=>{
  let finish;
  encodePlayheadOcrRegion.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  await openPlayheadOcr();
  const [,,change]=mountPlayheadOcrRegion.mock.lastCall;
  const submit=el('playheadOcrStart').onclick;
  change([]);
  expect(el('playheadOcrStart').disabled).toBe(true);
  await submit();
  expect(encodePlayheadOcrRegion).not.toHaveBeenCalled();
  change(null);
  const pending=submit();
  el('playheadOcrBack').click();
  expect(encodePlayheadOcrRegion.mock.lastCall[2].signal.aborted).toBe(true);
  finish('stale'); await pending;
  expect(DESK.recognizeFrameText).not.toHaveBeenCalled();
  expect(el('playheadOcrRegion').hidden).toBe(false);
  expect(commitPlayheadOcrCue).not.toHaveBeenCalled();
});
