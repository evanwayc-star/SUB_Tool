// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bindPreviewStatusView } from '../src/preview-status-view.js';

let state,view,root,setMode;
const flush=async()=>{for(let n=0;n<8;n++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const modeButton=mode=>root.querySelector(`[data-preview-mode="${mode}"]`);
beforeEach(()=>{
  vi.useFakeTimers();
  document.head.innerHTML=`<style>${readFileSync('src/styles.css','utf8')}</style>`;
  document.body.innerHTML=readFileSync('index.html','utf8');
  root=document.getElementById('previewStatus');
  state={mode:'smooth',sourceKind:'original',network:true,available:true,proxyAvailable:false,
    phase:'paused',localPreparation:'idle',localProgress:null,position:4,sourceTime:4};
  setMode=vi.fn(async mode=>{state={...state,mode,phase:'paused'};return true;});
  view=bindPreviewStatusView({root,readState:()=>state,setMode});
});
afterEach(()=>{view?.dispose();vi.useRealTimers();});

it('播放器顯示實際來源與暫用原片原因，來源切換後更新而不把選項當成已就緒',()=>{
  expect(root.querySelector('[data-preview-source]').textContent).toBe('NAS 原片');
  expect(root.querySelector('[data-preview-preparation]').textContent).toContain('預覽準備中，暫用原片');
  state={...state,sourceKind:'proxy',network:false,proxyAvailable:true};view.update();
  expect(root.querySelector('[data-preview-source]').textContent).toBe('同資料夾預覽');
  expect(root.querySelector('[data-preview-preparation]').textContent).not.toContain('暫用原片');
  state={...state,sourceKind:'proxy',network:true};view.update();
  expect(root.querySelector('[data-preview-source]').textContent).toBe('NAS 預覽');
  state={...state,mode:'original',sourceKind:'original',compositePreview:true};view.update();
  expect(modeButton('original').getAttribute('aria-pressed')).toBe('true');
  expect(root.querySelector('[data-preview-source]').textContent).toBe('合成預覽');
  expect(root.querySelector('[data-preview-preparation]').textContent).toContain('檢查原始畫質請回到單一滿版、無合成效果的片段');
  state={...state,compositePreview:false};view.update();
  expect(root.querySelector('[data-preview-source]').textContent).toBe('NAS 原片');
  expect(root.querySelector('[data-preview-preparation]').textContent).not.toContain('合成');
});

it('等待未滿250ms不閃提示，跨定位/影片/聲道階段沿用連續等待時間',()=>{
  const status=root.querySelector('[data-preview-wait]');
  state={...state,phase:'seeking'};view.update();vi.advanceTimersByTime(200);
  expect(getComputedStyle(status).display).toBe('none');
  state={...state,phase:'audio'};view.update();vi.advanceTimersByTime(49);
  expect(getComputedStyle(status).display).toBe('none');
  vi.advanceTimersByTime(1);expect(getComputedStyle(status).display).not.toBe('none');
  expect(status.textContent).toBe('等待聲道…');
  state={...state,phase:'video'};view.update();expect(status.textContent).toBe('等待影片…');
  state={...state,phase:'playing'};view.update();expect(getComputedStyle(status).display).toBe('none');
});

it('短等待結束與dispose都撤銷延後提示，晚到timer不改新畫面',()=>{
  const status=root.querySelector('[data-preview-wait]');
  state={...state,phase:'seeking'};view.update();vi.advanceTimersByTime(100);
  state={...state,phase:'paused'};view.update();vi.advanceTimersByTime(1000);
  expect(getComputedStyle(status).display).toBe('none');
  state={...state,phase:'video'};view.update();view.dispose();vi.advanceTimersByTime(1000);
  expect(getComputedStyle(status).display).toBe('none');
});

it('原片模式保留來源資訊，舊本機複製狀態不再顯示',()=>{
  state={...state,mode:'original',localPreparation:'copying',localProgress:42.8};view.update();
  expect(modeButton('original').getAttribute('aria-pressed')).toBe('true');
  expect(root.querySelector('[data-preview-source]').textContent).toBe('NAS 原片');
  expect(root.querySelector('[data-preview-preparation]').textContent).not.toContain('本機預覽');
  state={...state,localPreparation:'failed'};view.update();
  expect(root.querySelector('[data-preview-preparation]').textContent).not.toContain('本機預覽');
  expect(modeButton('smooth').title).toContain('480p／1000 kb/s');
});

it('兩顆按鈕切換公開setMode，等待期間不重入；按下狀態以最新snapshot為準',async()=>{
  const done=deferred();setMode.mockReturnValueOnce(done.promise);
  const original=modeButton('original'),proxy=modeButton('smooth'),group=root.querySelector('[data-preview-modes]');
  expect([proxy.textContent,original.textContent]).toEqual(['Proxy 預覽','原始畫質']);
  original.click();
  expect(setMode).toHaveBeenCalledWith('original');
  expect(original.disabled&&proxy.disabled).toBe(true);
  expect(group.getAttribute('aria-busy')).toBe('true');
  expect(root.querySelector('[data-preview-wait]').textContent).toBe('切換影像中…');
  proxy.click();original.click();expect(setMode).toHaveBeenCalledOnce();
  state={...state,mode:'original'};done.resolve(true);await flush();
  expect(original.getAttribute('aria-pressed')).toBe('true');
  expect(proxy.getAttribute('aria-pressed')).toBe('false');
  expect(original.disabled||proxy.disabled).toBe(false);
  expect(group.getAttribute('aria-busy')).toBe('false');
  proxy.click();await flush();
  expect(setMode).toHaveBeenLastCalledWith('smooth');
  expect(proxy.getAttribute('aria-pressed')).toBe('true');
  expect(original.getAttribute('aria-pressed')).toBe('false');
});

it.each(['false','reject'])('切換%s時還原權威選項並顯示可重試提示，沒有unhandled rejection',async outcome=>{
  if(outcome==='reject')setMode.mockRejectedValueOnce(new Error('C:/secret/movie.mov'));
  else setMode.mockImplementationOnce(async()=>{state={...state,phase:'error'};return false;});
  modeButton('original').click();await flush();
  expect(modeButton('smooth').getAttribute('aria-pressed')).toBe('true');
  expect(modeButton('original').disabled).toBe(false);
  expect(root.querySelector('[data-preview-wait]').textContent).toBe(outcome==='reject'?'未能切換預覽模式，請重試':'預覽暫時無法使用');
  expect(root.textContent).not.toContain('secret');
  // Media can retain the chosen preference after a failed presentation. The
  // selected button must still let the user retry that same source.
  state={...state,mode:'original'};view.update();modeButton('original').click();await flush();
  expect(setMode).toHaveBeenCalledTimes(2);
  expect(root.querySelector('[data-preview-wait]').hidden).toBe(true);
});

it('較新定位完成後舊切換才回傳false，不把取消操作顯示成失敗',async()=>{
  const done=deferred();setMode.mockReturnValueOnce(done.promise);
  modeButton('original').click();
  state={...state,mode:'original',sourceKind:'original',phase:'paused',position:8};view.update();
  done.resolve(false);await flush();
  expect(modeButton('original').getAttribute('aria-pressed')).toBe('true');
  expect(root.querySelector('[data-preview-wait]').hidden).toBe(true);
  state={...state,phase:'playing'};view.update();
  expect(root.querySelector('[data-preview-wait]').hidden).toBe(true);
});

it('未提供預覽能力時停用模式，不能送出切換且保留明確原因',()=>{
  state={...state,available:false,message:'\\\\Storage\\private.mov'};view.update();
  for(const button of root.querySelectorAll('[data-preview-mode]')){
    expect(button.disabled).toBe(true);expect(button.title).toContain('目前無法切換預覽模式');
    button.click();
  }
  expect(setMode).not.toHaveBeenCalled();
  expect(root.querySelector('[data-preview-preparation]').textContent).toContain('目前無法切換預覽模式');
  expect(root.textContent).not.toContain('Storage');
});

it('切換等待期間卸除view，晚到失敗不改已離開的UI',async()=>{
  const done=deferred();setMode.mockReturnValueOnce(done.promise);
  modeButton('original').click();
  view.dispose();const before=root.innerHTML;
  done.reject(new Error('late'));await flush();
  expect(root.innerHTML).toBe(before);
});
