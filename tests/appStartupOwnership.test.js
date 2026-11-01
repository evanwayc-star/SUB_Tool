// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let State, Project, Media, addCue, isProjectDirty, status, startup, api;
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function project(text) {
  const data = { app: 'SUB Tool', version: 3, fps: 25, tracks: [{ name: '對白', visible: true }],
    cues: [{ start: 1, end: 2, text, track: 1 }], notes: [], clips: [], videoTracks: [], media: {} };
  return { path: `C:/${text}.subtool`, b64: Buffer.concat([
    Buffer.from([255, 254]), Buffer.from(JSON.stringify(data), 'utf16le'),
  ]).toString('base64') };
}
async function finishStatus() {
  status.resolve({ ffmpeg: true, venc: 'libx264' });
  await vi.waitFor(() => expect(api.getStartupFile).toHaveBeenCalledOnce());
}

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); localStorage.clear();
  document.body.innerHTML = new DOMParser().parseFromString(fs.readFileSync(path.resolve('index.html'), 'utf8'), 'text/html').body.innerHTML;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new Proxy({
    measureText: () => ({ width: 1 }), createLinearGradient: () => ({ addColorStop() {} }),
  }, { get: (target, key) => target[key] || (() => {}), set: (target, key, value) => (target[key] = value, true) }));
  status = deferred(); startup = deferred();
  api = { isDesktop: true, configLoad: async () => ({}), configSave: async () => true,
    fontsList: async () => ({ fonts: [] }), recentProjects: async () => [],
    status: vi.fn(() => status.promise), getStartupFile: vi.fn(() => startup.promise),
    onProgress: vi.fn(), onQueueStatus: vi.fn(), onOpenFile: vi.fn(), onAppRequestClose: vi.fn(),
    stat: async () => ({ exists: false }) };
  window.subtool = api;
  ({ State } = await import('../src/state.js'));
  ({ Project, isProjectDirty } = await import('../src/project.js'));
  ({ Media } = await import('../src/media.js'));
  ({ addCue } = await import('../src/subtitle-model.js'));
  vi.spyOn(Project, '_isFontAvailable').mockReturnValue(true);
  await import('../src/app.js');
  await vi.waitFor(() => expect(api.status).toHaveBeenCalledOnce());
});

afterEach(() => {
  if (Media) { Media.playing = false; Media.resetPresentationSession('test-finished'); }
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  delete window.subtool;
  delete HTMLElement.prototype.scrollIntoView;
});

it.each(['engine-status', 'startup-read'])('啟動等待 %s 期間提交的字幕必須先確認才能捨棄', async phase => {
  if (phase === 'startup-read') await finishStatus();
  addCue(0, 2, 'USER_EDIT', 0);
  expect(isProjectDirty()).toBe(true);
  if (phase === 'engine-status') await finishStatus();
  startup.resolve(project('FROM_STARTUP'));
  await vi.waitFor(() => expect(document.getElementById('modalBody').textContent).toContain('未儲存'));
  const cancel = [...document.querySelectorAll('#modalFoot button')].find(button => button.textContent === '取消');
  cancel.click();
  expect(State.cues.map(cue => cue.text)).toEqual(['USER_EDIT']);
  expect(isProjectDirty()).toBe(true);
});

it('沒有較新操作的冷啟動仍直接載入並建立乾淨基線', async () => {
  await finishStatus(); startup.resolve(project('FROM_STARTUP'));
  await vi.waitFor(() => expect(State.cues.map(cue => cue.text)).toEqual(['FROM_STARTUP']));
  expect(isProjectDirty()).toBe(false);
  expect(document.getElementById('modalBody').textContent).not.toContain('未儲存');
});

it('等待引擎狀態期間較新的開檔意圖保有權威', async () => {
  await Project.open(async () => project('NEWER_PROJECT'));
  await finishStatus(); startup.resolve(project('STALE_STARTUP'));
  await vi.advanceTimersByTimeAsync(100);
  expect(State.cues.map(cue => cue.text)).toEqual(['NEWER_PROJECT']);
  expect(isProjectDirty()).toBe(false);
});

it('沒有啟動檔時不對等待期間新增的字幕顯示無效捨棄確認', async () => {
  addCue(0, 2, 'USER_EDIT', 0);
  await finishStatus(); startup.resolve(null);
  await vi.advanceTimersByTimeAsync(100);
  expect(State.cues.map(cue => cue.text)).toEqual(['USER_EDIT']);
  expect(document.getElementById('modalBody').textContent).not.toContain('未儲存');
});

it.each([false,true])('拖曳字幕期間選擇 FPS（同值=%s），保留正確時間與 Undo／Redo',async same=>{
  const {History}=await import('../src/history.js');
  const {setSelection}=await import('../src/state.js');
  const {ensureProjectSaved}=await import('../src/project.js');
  const Timeline=await import('../src/timeline-renderer.js');
  State.fps=25;State.dropFrame=false;State.clips=[];State.notes=[];State.duration=10;
  State.tracks=[{name:'字幕',visible:true,locked:false}];State.trackCount=1;State.vtracksCollapsed=false;
  State.cues=[{id:'fps-drag',start:3,end:4,text:'原稿',track:0}];
  History.reset();
  const guard=ensureProjectSaved();
  [...document.querySelectorAll('#modalFoot button')].find(button=>button.textContent==='稍後再說').click();
  await guard;
  for(const element of [document.getElementById('tlLayer'),document.getElementById('tlScroll')]){
    element.getBoundingClientRect=()=>({left:0,top:0,right:640,bottom:500,width:640,height:500});
    Object.defineProperty(element,'clientWidth',{configurable:true,value:640});
    Object.defineProperty(element,'clientHeight',{configurable:true,value:500});
  }
  State.pxPerSec=80;State.viewStart=0;Timeline.drawTimeline();
  setSelection({kind:'sub',ids:['fps-drag'],primary:'fps-drag'});
  const block=document.querySelector('.cue-block[data-id="fps-drag"]');expect(block).toBeTruthy();
  block.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:240,clientY:100}));
  window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:280,clientY:100}));
  expect(State.cues[0].start).toBeGreaterThan(3);
  const preview={start:State.cues[0].start,end:State.cues[0].end};
  const selector=document.getElementById('fpsSel');selector.value=same?'25':'24';selector.dispatchEvent(new Event('change',{bubbles:true}));
  window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:280,clientY:100}));
  expect(State.fps).toBe(same?25:24);expect(State.cues[0]).toMatchObject(same?preview:{start:3,end:4});
  History.undo();expect(State.fps).toBe(25);expect(State.cues[0]).toMatchObject({start:3,end:4});
  History.redo();expect(State.fps).toBe(same?25:24);expect(State.cues[0]).toMatchObject(same?preview:{start:3,end:4});
});
