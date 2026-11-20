// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let State, Media, History, emit, time = 1, nextFrame = 0;
const frames = new Map();
const tc = () => document.getElementById('tcCur');
const video = () => document.getElementById('video');
const press = (input, key) => input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
function openEditor(value = '00:00:10:00') {
  tc().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  const input = tc().querySelector('input');
  expect(input).toBeTruthy();
  input.value = value; input.setSelectionRange(3, 8);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input;
}
function renderFrame() {
  for (const [id, callback] of [...frames]) { frames.delete(id); callback(performance.now()); }
}
function typeDigits(input,text){
  for(const digit of text){
    const key=new KeyboardEvent('keydown',{key:digit,bubbles:true,cancelable:true});
    if(!input.dispatchEvent(key))continue;
    const before=new InputEvent('beforeinput',{inputType:'insertText',data:digit,bubbles:true,cancelable:true});
    if(!input.dispatchEvent(before))continue;
    input.setRangeText(digit,input.selectionStart,input.selectionEnd,'end');
    input.dispatchEvent(new InputEvent('input',{inputType:'insertText',data:digit,bubbles:true}));
  }
}

beforeAll(async () => {
  vi.useFakeTimers(); localStorage.clear();
  document.body.innerHTML = new DOMParser().parseFromString(fs.readFileSync(path.resolve('index.html'), 'utf8'), 'text/html').body.innerHTML;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', callback => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', id => frames.delete(id));
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new Proxy({
    measureText: () => ({ width: 1 }), createLinearGradient: () => ({ addColorStop() {} }),
  }, { get: (target, key) => target[key] || (() => {}) }));
  let initialized = false;
  window.subtool = { isDesktop: true, configLoad: async () => ({}), configSave: async () => true,
    fontsList: async () => ({ fonts: [] }), recentProjects: async () => [], status: async () => ({ ffmpeg: true }),
    getStartupFile: async () => null, onProgress() {}, onQueueStatus() {}, onOpenFile() {},
    onAppRequestClose() { initialized = true; } };
  ({ State } = await import('../src/state.js')); ({ Media } = await import('../src/media.js'));
  ({ History } = await import('../src/history.js')); ({ emit } = await import('../src/events.js'));
  await import('../src/app.js');
  await vi.waitFor(() => expect(initialized).toBe(true));
  vi.spyOn(Media, 'displayTime').mockImplementation(() => time);
  vi.spyOn(Media, 'seek');
});

beforeEach(() => {
  const input = tc().querySelector('input'); if (input) press(input, 'Escape');
  Media.resetPresentationSession('timecode-test'); Media.playing = false;
  Object.assign(State, { fps: 25, dropFrame: false, duration: 60, cues: [], notes: [], clips: [],
    externalAudioState: [], externalAudioEnd: 0, tracks: [], autoSelect: false });
  document.getElementById('seekBar').max = '60000';
  time = 1; video().dispatchEvent(new Event('timeupdate'));
  History.reset(); Media.seek.mockClear();
});

afterAll(() => {
  Media.playing = false; Media.resetPresentationSession('timecode-test-finished');
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  delete window.subtool; delete HTMLElement.prototype.scrollIntoView;
  delete window._ensurePlayheadVisible; delete window._markActiveRow;
});

it.each(['mpv', 'frame', 'timeupdate', 'pause', 'fps', 'seek'])('%s 讀數保留同一主時碼輸入框、焦點、草稿及選取範圍', async source => {
  const input = openEditor(); time = 2.04; Media.playing = true;
  if (source === 'mpv') Media.observeMpvEvent({ event: 'property-change', name: 'time-pos', data: time });
  else if (source === 'frame') renderFrame();
  else if (source === 'fps') emit('fps:changed');
  else if (source === 'seek') await Media.seek(time);
  else video().dispatchEvent(new Event(source));
  expect(input.isConnected).toBe(true); expect(tc().querySelector('input')).toBe(input);
  expect(document.activeElement).toBe(input); expect(input.value).toBe('00:00:10:00');
  expect(input.selectionStart).toBe(3); expect(input.selectionEnd).toBe(8);
  press(input, 'Escape');
  expect(tc().textContent).toBe('00:00:02:01');
  expect(History.stack).toHaveLength(1);
});

it.each(['Enter', 'blur'])('%s 提交播放中的時碼草稿一次，後續舊 blur 不重複定位', async submit => {
  const input = openEditor(); time = 3; Media.playing = true;
  video().dispatchEvent(new Event('timeupdate'));
  if (submit === 'Enter') press(input, 'Enter'); else input.blur();
  input.dispatchEvent(new Event('blur'));
  await Promise.resolve();
  expect(Media.seek).toHaveBeenCalledExactlyOnceWith(10);
  expect(input.isConnected).toBe(false); expect(tc().textContent).toBe('00:00:10:00');
  expect(History.stack).toHaveLength(1);
});

it('Escape 取消後顯示最新位置，後續正常播放仍更新時碼及 seek bar', () => {
  const input = openEditor(); time = 4; Media.playing = true; renderFrame();
  press(input, 'Escape'); input.dispatchEvent(new Event('blur'));
  expect(Media.seek).not.toHaveBeenCalled(); expect(tc().textContent).toBe('00:00:04:00');
  time = 4.04; renderFrame();
  expect(tc().textContent).toBe('00:00:04:01');
  expect(document.getElementById('seekBar').value).toBe('4040');
  expect(History.stack).toHaveLength(1);
});

it.each([['tcShiftInput','shift-fwd',1.48,2.48],['durAdjTcInput','dur-adj-add',1,2.48]])('調整欄 %s 只收數字、顯示時碼並以真命令修改字幕', (id,action,start,end)=>{
  State.tracks=[{visible:true,locked:false}];State.cues=[{id:'numeric-cue',start:1,end:2,text:'保留字幕文字',track:0}];History.reset();
  const input=document.getElementById(id);input.focus();input.select();typeDigits(input,'００００００１２abc');
  expect(input.value).toBe('00:00:00:12');expect(input.inputMode).toBe('numeric');press(input,'Enter');
  document.querySelector(`[data-act="${action}"]`).click();
  expect(State.cues[0]).toMatchObject({start,end,text:'保留字幕文字'});expect(History.stack).toHaveLength(2);
  History.undo();expect(State.cues[0]).toMatchObject({start:1,end:2});
});

it('播放點的數字輸入仍支援相對負號，Enter 只提交一次',async()=>{
  time=10;const input=openEditor('');typeDigits(input,'-０００００１１２');
  expect(input.value).toBe('-00:00:01:12');press(input,'Enter');await Promise.resolve();
  expect(Media.seek).toHaveBeenCalledExactlyOnceWith(8.52);
});
