// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let State, Media, UI, Menus, setSelection;
const key = (target, value, options = {}) => {
  const event = new KeyboardEvent('keydown', { key:value, bubbles:true, cancelable:true, ...options });
  target.dispatchEvent(event);
  return event;
};

beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = new DOMParser().parseFromString(fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8'), 'text/html').body.innerHTML;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
  HTMLCanvasElement.prototype.getContext = () => new Proxy({measureText:()=>({width:1}),createLinearGradient:()=>({addColorStop(){}})},
    {get:(target,name)=>target[name]||(()=>{}),set:(target,name,value)=>(target[name]=value,true)});
  ({State,setSelection} = await import('../src/state.js'));
  ({Media} = await import('../src/media.js'));
  UI = await import('../src/ui.js');
  Menus = await import('../src/menus.js');
  await import('../src/keyboard.js');
  vi.spyOn(Media, 'play').mockResolvedValue(true);
  vi.spyOn(Media, 'pause').mockImplementation(() => {});
});
beforeEach(() => {
  UI.closeModal(); Menus.hideCtx(); vi.clearAllTimers(); vi.clearAllMocks();
  document.getElementById('settingsModal')?.remove();
  State.keymap = structuredClone(State.defaultKeymap);
  State.subMode = false; State.cues = []; State.tracks = [{name:'字幕',locked:false}];
  State.clips = []; State.duration = 10;
  setSelection({kind:'sub',ids:[]});
  Media.playing = false;
});
afterAll(() => { Menus.hideCtx(); UI.closeModal(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

it.each([' ', 'Enter'])('聚焦工具列按鈕時 %s 保留原生啟用，不開始播放', async value => {
  const button = document.querySelector('[data-act="save-project"]');
  const click = vi.fn(); button.addEventListener('click', click, {once:true}); button.focus();
  const event = key(button, value);
  await Promise.resolve();
  expect(event.defaultPrevented).toBe(false);
  expect(Media.play).not.toHaveBeenCalled();
  // jsdom 不執行瀏覽器的原生鍵盤 click；確認它沒有被 keydown 取消後再模擬。
  button.click(); expect(click).toHaveBeenCalledOnce();
});

it('工作區仍可用 Space 播放，已被局部控制處理的事件不再播放', async () => {
  document.activeElement?.blur();
  key(document.body, ' '); await Promise.resolve();
  expect(Media.play).toHaveBeenCalledOnce(); Media.play.mockClear();
  Media.playing=false;
  const handled = new KeyboardEvent('keydown', {key:' ',bubbles:true,cancelable:true});
  handled.preventDefault(); document.body.dispatchEvent(handled); await Promise.resolve();
  expect(Media.play).not.toHaveBeenCalled();
});

it('選單方向鍵略過停用項目，Enter 執行目前項目並還原焦點', () => {
  const origin = document.querySelector('[data-act="save-project"]'); origin.focus();
  const first = vi.fn(), last = vi.fn();
  Menus.showCtx(20, 20, [{label:'一',act:first},{label:'不可用'},{sep:true},{label:'二',act:last}]);
  const items = [...document.querySelectorAll('#ctxmenu [role="menuitem"]')];
  expect(document.activeElement).toBe(items[0]);
  key(items[0], 'ArrowDown'); expect(document.activeElement).toBe(items[2]);
  key(items[2], 'Home'); expect(document.activeElement).toBe(items[0]);
  key(items[0], 'End'); expect(document.activeElement).toBe(items[2]);
  key(items[2], 'Enter');
  expect(last).toHaveBeenCalledOnce(); expect(first).not.toHaveBeenCalled();
  expect(document.getElementById('ctxmenu').classList.contains('show')).toBe(false);
  expect(document.activeElement).toBe(origin); expect(Media.play).not.toHaveBeenCalled();
});

it('Escape 只關閉選單，不清除字幕選取；Tab 關閉選單後可繼續導航', () => {
  State.cues = [{id:'cue',start:0,end:1,text:'保留',track:0}];
  setSelection({kind:'sub',ids:['cue'],primary:'cue'});
  const origin = document.querySelector('[data-act="save-project"]'); origin.focus();
  Menus.showCtx(20, 20, [{label:'編輯',act:vi.fn()}]);
  const escape = key(document.activeElement, 'Escape');
  expect(escape.defaultPrevented).toBe(true);
  expect(document.getElementById('ctxmenu').classList.contains('show')).toBe(false);
  expect(State.selectedId).toBe('cue'); expect(document.activeElement).toBe(origin);
  Menus.showCtx(20, 20, [{label:'編輯',act:vi.fn()}]);
  const tab = key(document.activeElement, 'Tab');
  expect(tab.defaultPrevented).toBe(false);
  expect(document.getElementById('ctxmenu').classList.contains('show')).toBe(false);
});

it('輸入框右鍵保持游標；鍵盤進入選單後 Escape 還原原選取', () => {
  const input = document.getElementById('searchInput'); input.value = 'abcdef'; input.focus(); input.setSelectionRange(1,4);
  Menus.showCtx(20, 20, [{label:'複製',act:vi.fn()}], {preserveFocus:true});
  expect(document.activeElement).toBe(input); expect(input.selectionStart).toBe(1); expect(input.selectionEnd).toBe(4);
  key(input, 'ArrowDown'); expect(document.activeElement).toBe(input);
  expect(document.getElementById(input.getAttribute('aria-activedescendant')).getAttribute('role')).toBe('menuitem');
  key(document.activeElement, 'Escape');
  expect(document.activeElement).toBe(input); expect(input.selectionStart).toBe(1); expect(input.selectionEnd).toBe(4);
  expect(input.hasAttribute('aria-activedescendant')).toBe(false);expect(input.hasAttribute('aria-controls')).toBe(false);
});
