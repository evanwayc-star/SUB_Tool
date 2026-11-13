// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  delete window.subtool; delete HTMLElement.prototype.scrollIntoView;
  delete window._ensurePlayheadVisible; delete window._markActiveRow;
});

it('播放頭追蹤只在實際視窗改變時重畫，保留邊界限制與過期 viewStart 的同步', async () => {
  vi.resetModules(); vi.useFakeTimers(); localStorage.clear();
  document.body.innerHTML = new DOMParser().parseFromString(fs.readFileSync(path.resolve('index.html'), 'utf8'), 'text/html').body.innerHTML;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  const rulerClear = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
    return new Proxy({
      ...(this.id === 'rulerCanvas' ? { clearRect: rulerClear } : {}),
      measureText: () => ({ width: 1 }), createLinearGradient: () => ({ addColorStop() {} }),
    }, { get: (target, key) => target[key] || (() => {}) });
  });
  let initialized = false;
  let storedKeys={toggle_mixer:[{key:'u'}],toggle_sub_mode:[{key:'y'}]};
  window.subtool = { isDesktop: true, configLoad: async () => ({}), configSave: async () => true,
    keysLoad:async()=>structuredClone(storedKeys),keysSave:async keys=>{storedKeys=structuredClone(keys);return true;},
    fontsList: async () => ({ fonts: [] }), recentProjects: async () => [], status: async () => ({ ffmpeg: true }),
    getStartupFile: async () => null, onProgress() {}, onQueueStatus() {}, onOpenFile() {},
    onAppRequestClose() { initialized = true; } };
  const { State,loadKeys,saveKeys } = await import('../src/state.js');
  const { Media } = await import('../src/media.js');
  await import('../src/app.js');
  await vi.waitFor(() => expect(initialized).toBe(true));
  expect(State.keymap.scroll_playhead).toEqual([{key:'u'}]);
  expect(State.keymap.toggle_mixer).toEqual([{key:'y'}]);
  expect(State.keymap.toggle_sub_mode).toEqual([{key:'y',shift:true}]);

  const scroll = document.getElementById('tlScroll');
  Object.defineProperty(scroll, 'clientWidth', { configurable: true, value: 1000 });
  let left = 0, maximum = 10000, time = 0;
  Object.defineProperty(scroll, 'scrollLeft', {
    configurable: true, get: () => left,
    set: value => { left = Math.max(0, Math.min(maximum, value)); },
  });
  Object.assign(State, { viewStart: 0, pxPerSec: 20 });
  vi.spyOn(Media, 'displayTime').mockImplementation(() => time);
  rulerClear.mockClear();

  // The same public hook is called by every playing animation frame. At the
  // beginning, the viewport cannot move farther left; only the playhead moves.
  for (let frame = 0; frame < 40; frame++) {
    time = frame / 25;
    window._ensurePlayheadVisible();
  }
  expect(left).toBe(0);
  expect(rulerClear).not.toHaveBeenCalled();

  time = 100;
  window._ensurePlayheadVisible();
  expect(left).toBe(1700);
  expect(State.viewStart).toBe(85);
  expect(rulerClear).toHaveBeenCalledOnce();
  expect(document.getElementById('tlPlayhead').style.left).toBe('300px');
  window._ensurePlayheadVisible();
  expect(rulerClear).toHaveBeenCalledOnce();

  // A requested move may also be clamped at the right end by the browser.
  maximum = 1000; left = 1000; State.viewStart = 50;
  rulerClear.mockClear();
  window._ensurePlayheadVisible();
  expect(left).toBe(1000);
  expect(State.viewStart).toBe(50);
  expect(rulerClear).not.toHaveBeenCalled();

  time = 0;
  window._ensurePlayheadVisible();
  expect(left).toBe(0);
  expect(State.viewStart).toBe(0);
  expect(rulerClear).toHaveBeenCalledOnce();
  window._ensurePlayheadVisible();
  expect(rulerClear).toHaveBeenCalledOnce();

  // If the scroll event has not synchronized State yet, keep that correction.
  State.viewStart = 1;
  window._ensurePlayheadVisible();
  expect(State.viewStart).toBe(0);
  expect(rulerClear).toHaveBeenCalledTimes(2);

  // Manual U always aligns the authoritative timeline playhead to 15% of the
  // content viewport. The 250px track header offset is outside that viewport.
  Object.defineProperty(scroll,'clientWidth',{configurable:true,value:1669});
  scroll.getBoundingClientRect=()=>({left:250,right:1919,width:1669,top:0,bottom:100,height:100});
  const seek=vi.spyOn(Media,'seek'),play=vi.spyOn(Media,'play'),pause=vi.spyOn(Media,'pause');
  const sourceTime=vi.spyOn(Media,'vTime').mockReturnValue(15);
  const press=(key,code)=>{window.dispatchEvent(new KeyboardEvent('keydown',{key,code,cancelable:true}));window.dispatchEvent(new KeyboardEvent('keyup',{key,code}));};
  maximum=10000;State.pxPerSec=20;
  for(const playing of [false,true]){
    Media.playing=playing;time=100;left=100;State.viewStart=5;
    press('u','KeyU');
    expect(left).toBeCloseTo(100*20-1669*.15,8);
    expect(State.viewStart).toBeCloseTo(left/20,8);
    expect(parseFloat(document.getElementById('tlPlayhead').style.left)+250).toBeCloseTo(250+1669*.15,8);
    expect(Media.playing).toBe(playing);expect(State.pxPerSec).toBe(20);expect(time).toBe(100);
  }
  time=2;press('u','KeyU');expect(left).toBe(0);expect(State.viewStart).toBe(0);
  maximum=1000;time=100;press('u','KeyU');expect(left).toBe(1000);expect(State.viewStart).toBe(50);
  const input=document.createElement('input');document.body.append(input);input.focus();
  time=0;input.dispatchEvent(new KeyboardEvent('keydown',{key:'u',code:'KeyU',bubbles:true}));expect(left).toBe(1000);
  input.remove();
  expect(seek).not.toHaveBeenCalled();expect(play).not.toHaveBeenCalled();expect(pause).not.toHaveBeenCalled();
  expect(sourceTime).not.toHaveBeenCalled();

  const mixer=document.getElementById('mixerPanel'),wasOpen=mixer.classList.contains('show'),subMode=State.subMode;
  press('y','KeyY');expect(mixer.classList.contains('show')).toBe(!wasOpen);
  press('y','KeyY');expect(mixer.classList.contains('show')).toBe(wasOpen);expect(State.subMode).toBe(subMode);
  expect(seek).not.toHaveBeenCalled();expect(play).not.toHaveBeenCalled();expect(pause).not.toHaveBeenCalled();

  const {showSettingsModal}=await import('../src/settings.js');showSettingsModal();
  expect(document.getElementById('settings-input-scroll_playhead-0')?.value).toBe('U');
  expect(document.getElementById('settings-row-scroll_playhead')?.textContent).toContain('將時間軸視野對齊目前播放點');
  expect(document.getElementById('settings-input-scroll_playhead-0')?.title).toContain('只捲動視野');
  expect(document.getElementById('settings-input-toggle_mixer-0')?.value).toBe('Y');
  expect(document.getElementById('settings-input-toggle_sub_mode-0')?.value).toBe('Shift + Y');
  document.getElementById('settingsCancelBtn').click();
  // Persisting the migrated map makes future loads idempotent. A deliberate
  // later reassignment back to U must remain the user's choice.
  await saveKeys();expect(storedKeys.scroll_playhead).toEqual([{key:'u'}]);
  const saved=structuredClone(State.keymap);State.keymap={};await loadKeys();expect(State.keymap).toEqual(saved);
  State.keymap.scroll_playhead=[];State.keymap.toggle_mixer=[{key:'u'}];await saveKeys();
  State.keymap=structuredClone(State.defaultKeymap);await loadKeys();
  expect(State.keymap.scroll_playhead).toEqual([]);expect(State.keymap.toggle_mixer).toEqual([{key:'u'}]);
  Media.playing = false;
});
