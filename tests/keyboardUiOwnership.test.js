// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let State, Media, UI, Menus, setSelection, commands;
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
  const { createCommands } = await import('../src/commands.js');
  const { on } = await import('../src/events.js');
  commands = createCommands();
  on('action', action => {
    if (action === 'safe-frame' || action === 'timecode-watermark') commands.run(action);
  });
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
  document.activeElement?.blur();
  key(document.body, 'Tab');
});
afterAll(() => { Menus.hideCtx(); UI.closeModal(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

function selectPlayerSpeed(rate) {
  document.getElementById('speedIndicator').dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true }));
  const entries = [...document.querySelectorAll('#ctxmenu [role="menuitem"]')];
  const item = entries.find(entry => entry.querySelector('.c-text').textContent === rate + '×');
  item.click();
}

it('選擇 0.5x 後，播放按鈕指令與空白鍵交替起播、暫停及續播都沿用該倍率', async () => {
  const indicator = document.getElementById('speedIndicator');
  const video = document.getElementById('video');
  const ratesAtStart = [];
  const play = () => { ratesAtStart.push(video.playbackRate); Media.playing = true; };
  Media.play.mockImplementationOnce(play).mockImplementationOnce(play);
  Media.pause.mockImplementationOnce(() => { Media.playing = false; });
  try {
    expect(video.playbackRate).toBe(1);
    selectPlayerSpeed(0.5);
    expect(indicator.textContent).toBe('0.5x');
    commands.run(document.getElementById('playBtn').dataset.act);
    await vi.advanceTimersByTimeAsync(0);
    expect(ratesAtStart).toEqual([0.5]);
    key(document.body, ' ');
    expect(Media.playing).toBe(false);
    expect(indicator.textContent).toBe('0.5x');
    key(document.body, ' ');
    await vi.advanceTimersByTimeAsync(0);
    expect(ratesAtStart).toEqual([0.5, 0.5]);
    expect(indicator.textContent).toBe('0.5x');
  } finally {
    Media.playing = false;
    selectPlayerSpeed(1);
  }
});

it('二倍速片段的手選倍率獨立顯示，JKL 穿梭停止後一般播放沿用手選倍率', async () => {
  const video = document.getElementById('video');
  const indicator = document.getElementById('speedIndicator');
  const clip = {id:'fast', in:0, out:10, offset:0, speed:2, primary:true};
  State.clips = [clip];
  Media.activeClipId = clip.id;
  Media.play.mockImplementationOnce(() => { Media.playing = true; });
  Media.pause.mockImplementationOnce(() => { Media.playing = false; });
  try {
    selectPlayerSpeed(0.5);
    expect(video.playbackRate).toBe(1);
    expect(indicator.textContent).toBe('0.5x');
    Menus.showPlayerMenu(0, 0);
    expect(document.querySelector('#ctxmenu .chk').parentElement.querySelector('.c-text').textContent).toBe('0.5×');
    const custom = [...document.querySelectorAll('#ctxmenu [role="menuitem"]')].find(item => item.textContent.includes('自訂速度'));
    custom.click();
    expect(document.getElementById('__promptInput').value).toBe('0.5');
    UI.closeModal();
    key(document.body, 'l');
    await vi.advanceTimersByTimeAsync(0);
    key(document.body, 'l');
    expect(indicator.textContent).toBe('1.5x');
    expect(video.playbackRate).toBe(3);
    key(document.body, 'k');
    expect(Media.playing).toBe(false);
    expect(indicator.textContent).toBe('0.5x');
    key(document.body, ' ');
    await vi.advanceTimersByTimeAsync(0);
    expect(Media.play).toHaveBeenCalledTimes(2);
    expect(video.playbackRate).toBe(1);
  } finally {
    State.clips = [];
    Media.activeClipId = null;
    Media.playing = false;
    selectPlayerSpeed(1);
  }
});

it('Tab 及 Shift+Tab 保持焦點，Enter 不會啟用工作區按鈕或舊播放綁定', async () => {
  const button = document.getElementById('playBtn');
  button.focus();
  State.keymap.toggle_play_pause = [{key:'enter'}];
  for (const shiftKey of [false, true]) {
    expect(key(button, 'Tab', {shiftKey}).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button);
  }
  expect(key(button, 'Enter').defaultPrevented).toBe(true);
  expect(key(document.body, 'Enter', {code:'NumpadEnter'}).defaultPrevented).toBe(true);
  await Promise.resolve();
  expect(Media.play).not.toHaveBeenCalled();
});

it.each([
  ['h', 'safeFrame', 'safeFrameBtn'],
  ['g', 'timecodeWatermark', 'timecodeWatermarkBtn'],
])('Ctrl+%s 與工具列顯示同一個預覽疊層，按住不會閃爍', (letter, overlay, button) => {
  State[overlay] = false;
  const input = document.getElementById('searchInput');
  expect(key(input, letter, {ctrlKey:true}).defaultPrevented).toBe(false);
  expect(State[overlay]).toBe(false);
  expect(key(document.body, letter, {ctrlKey:true}).defaultPrevented).toBe(true);
  expect(State[overlay]).toBe(true);
  expect(document.getElementById(overlay).classList.contains('on')).toBe(true);
  expect(document.getElementById(button).classList.contains('active')).toBe(true);
  key(document.body, letter, {ctrlKey:true, repeat:true});
  expect(State[overlay]).toBe(true);
  key(document.body, letter, {metaKey:true});
  expect(document.getElementById(overlay).classList.contains('on')).toBe(false);
  expect(document.getElementById(button).classList.contains('active')).toBe(false);
});

it.each(['#playBtn', '[data-act="mixer-zero-faders"]'])('聚焦工作區按鈕 %s 時，Space 播放而不啟用該按鈕', async selector => {
  const button = document.querySelector(selector);
  expect(button).toBeTruthy();
  const click = vi.fn(); button.addEventListener('click', click, {once:true});
  button.focus();
  const event = key(button, ' ');
  await Promise.resolve();
  expect(event.defaultPrevented).toBe(true);
  expect(Media.play).toHaveBeenCalledOnce();
  expect(click).not.toHaveBeenCalled();
  button.removeEventListener('click', click);
});

it('滑鼠點擊浮動面板按鈕先釋放焦點，按鈕重建後 Space 不會重做按鈕動作', async () => {
  const wrap = document.getElementById('mixerStrips');
  wrap.innerHTML = '<button class="mx-mute">M</button>';
  const original = wrap.firstElementChild;
  let focusedDuringClick;
  original.addEventListener('click', () => {
    focusedDuringClick = document.activeElement;
    wrap.innerHTML = '<button class="mx-mute">M</button>';
  });
  original.focus();
  original.dispatchEvent(new MouseEvent('click', {bubbles:true,detail:1}));
  expect(focusedDuringClick).toBe(document.body);
  expect(document.activeElement).toBe(document.body);
  key(document.activeElement, ' '); await vi.runOnlyPendingTimersAsync();
  expect(Media.play).toHaveBeenCalledOnce();
  // 重繪接回的新按鈕也不能讓 Space 變成靜音。
  Media.play.mockClear(); Media.playing = false;
  wrap.firstElementChild.focus();
  expect(key(document.activeElement, ' ').defaultPrevented).toBe(true);
  await Promise.resolve(); expect(Media.play).toHaveBeenCalledOnce();
  wrap.replaceChildren();
});

it('按鈕上的播放仍遵守自訂綁定，不硬寫死 Space', async () => {
  const button = document.getElementById('playBtn'); button.focus();
  State.keymap.toggle_play_pause = [{key:'f8'}];
  expect(key(button, ' ').defaultPrevented).toBe(true);
  await Promise.resolve(); expect(Media.play).not.toHaveBeenCalled();
  expect(key(button, 'F8').defaultPrevented).toBe(true);
  await Promise.resolve(); expect(Media.play).toHaveBeenCalledOnce();
});

it('滑鼠操作對話框按鈕後回到視窗，Space 不穿透播放', async () => {
  UI.openModal('確認', '<button id="dialogAction">確認</button>');
  const button = document.getElementById('dialogAction'); button.focus();
  button.dispatchEvent(new MouseEvent('click', {bubbles:true,detail:1}));
  expect(document.activeElement).toBe(button.closest('[role="dialog"]'));
  expect(key(button, ' ').defaultPrevented).toBe(true);
  await Promise.resolve(); expect(Media.play).not.toHaveBeenCalled();
});

it('Enter 只確認最上層目前可用的動作，長按不會穿透至下一次確認', () => {
  const apply = vi.fn(), cancel = vi.fn();
  UI.openModal('第一步', '', [
    {label:'取消',act:cancel},
    {label:'繼續',enterDefault:true,act:()=>UI.openModal('第二步','',[
      {label:'先前的動作',hidden:true,enterDefault:true,act:cancel},
      {label:'確認',enterDefault:true,act:apply},
    ])},
  ]);
  const firstCancel = document.querySelector('#modalFoot button');
  firstCancel.focus();
  key(firstCancel, 'Enter');
  expect(document.getElementById('modalTitle').textContent).toBe('第二步');
  key(document.activeElement, 'Enter', {repeat:true});
  key(document.activeElement, ' ');
  expect(apply).not.toHaveBeenCalled();
  key(document.activeElement, 'Enter', {code:'NumpadEnter'});
  expect(apply).toHaveBeenCalledOnce();
  expect(cancel).not.toHaveBeenCalled();
});

it.each([['exp-dialog',false],['exp-dialog',true],['exp-video',false],['exp-video',true]])('滑鼠開啟 %s 並結束對話框（committed=%s）後，Space 播放而不再次啟用按鈕', async (action,committed) => {
  const button = document.querySelector(`[data-act="${action}"]`);
  button.addEventListener('click', () => {
    button.blur();
    UI.openModal('匯出', '<button>設定</button>');
  }, {once:true});
  button.focus();
  button.dispatchEvent(new MouseEvent('click', {bubbles:true,detail:1}));
  key(document.getElementById('modalBody').querySelector('button'), 'Tab');
  UI.closeModal({committed}); await vi.runOnlyPendingTimersAsync();
  expect(document.activeElement).toBe(document.body);
  const event = key(document.activeElement, ' '); await Promise.resolve();
  expect(event.defaultPrevented).toBe(true);
  expect(Media.play).toHaveBeenCalledOnce();
});

it.each([' ', 'Enter'])('上方操作按鈕不留焦點，僅 Space 可播放（%s）', async value => {
  const buttons = [...document.querySelectorAll('.menubar button')];
  expect(buttons.length).toBeGreaterThan(0);
  for (const button of buttons) {
    expect(button.tabIndex).toBe(-1);
    button.focus();
    expect(document.activeElement).not.toBe(button);
  }
  const fps = document.getElementById('fpsSel');
  fps.focus(); expect(document.activeElement).toBe(fps);
  const button = document.querySelector('[data-act="exp-dialog"]');
  button.focus(); expect(document.activeElement).toBe(document.body);
  const event = key(document.activeElement, value); await Promise.resolve();
  expect(event.defaultPrevented).toBe(true);
  expect(Media.play).toHaveBeenCalledTimes(value === ' ' ? 1 : 0);
});

it('其他區域的滑鼠按鈕不繞過對話框、IME 或文字編輯的快捷鍵圍籬', async () => {
  const button = document.getElementById('playBtn');
  button.focus(); button.dispatchEvent(new MouseEvent('click', {bubbles:true,detail:1}));
  key(button, ' ', {isComposing:true}); key(button, ' ', {keyCode:229});
  UI.openModal('輸入', '<input id="keyboardOwnerInput">');
  key(button, ' '); key(document.getElementById('keyboardOwnerInput'), ' ');
  UI.closeModal(); await vi.runOnlyPendingTimersAsync();
  const input = document.getElementById('searchInput'); input.focus(); key(input, ' ');
  await Promise.resolve(); expect(Media.play).not.toHaveBeenCalled();
});

it('調時面板的百分比套用可從模式選單與標題按 Enter，切換模式後立即失效',()=>{
  const panel=document.getElementById('shiftPanel');
  const page=document.getElementById('shiftPageDur'), row=document.getElementById('durAdjPctRow');
  const mode=document.getElementById('durAdjMode'), apply=row.querySelector('button');
  UI.togglePanel(panel.id);
  const handler=vi.fn(event=>event.stopPropagation());
  apply.addEventListener('click',handler);
  try{
    page.style.display='';row.style.display='';
    key(mode,'Enter');key(panel,'Enter');key(panel,'Enter',{repeat:true});
    row.style.display='none';key(mode,'Enter');
    expect(handler).toHaveBeenCalledTimes(2);
  }finally{
    page.style.display='none';row.style.display='none';
    apply.removeEventListener('click',handler);UI.closePanel(panel.id);
  }
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

it('右鍵選單沒有預選項目；方向鍵可瀏覽，Enter 與空白都不會執行', () => {
  const origin = document.getElementById('playBtn'); origin.focus();
  const first = vi.fn(), last = vi.fn();
  Menus.showCtx(20, 20, [{label:'一',act:first},{label:'不可用'},{sep:true},{label:'二',act:last}]);
  const items = [...document.querySelectorAll('#ctxmenu [role="menuitem"]')];
  const menu = document.getElementById('ctxmenu');
  expect(document.activeElement).toBe(menu);
  expect(key(menu, 'Enter').defaultPrevented).toBe(true);
  key(menu, 'ArrowDown'); expect(document.activeElement).toBe(items[0]);
  key(items[0], 'ArrowDown'); expect(document.activeElement).toBe(items[2]);
  key(items[2], 'Home'); expect(document.activeElement).toBe(items[0]);
  key(items[0], 'End'); expect(document.activeElement).toBe(items[2]);
  for (const value of ['Enter',' ']) expect(key(items[2], value).defaultPrevented).toBe(true);
  expect(last).not.toHaveBeenCalled(); expect(first).not.toHaveBeenCalled();
  items[2].click();
  expect(last).toHaveBeenCalledOnce(); expect(first).not.toHaveBeenCalled();
  expect(document.getElementById('ctxmenu').classList.contains('show')).toBe(false);
  expect(document.activeElement).toBe(origin); expect(Media.play).not.toHaveBeenCalled();
});

it('Escape 只關閉選單；Tab 及 Shift+Tab 保持原位', () => {
  State.cues = [{id:'cue',start:0,end:1,text:'保留',track:0}];
  setSelection({kind:'sub',ids:['cue'],primary:'cue'});
  const origin = document.getElementById('playBtn'); origin.focus();
  Menus.showCtx(20, 20, [{label:'編輯',act:vi.fn()}]);
  const escape = key(document.activeElement, 'Escape');
  expect(escape.defaultPrevented).toBe(true);
  expect(document.getElementById('ctxmenu').classList.contains('show')).toBe(false);
  expect(State.selectedId).toBe('cue'); expect(document.activeElement).toBe(origin);
  Menus.showCtx(20, 20, [{label:'編輯',act:vi.fn()}]);
  const menu = document.getElementById('ctxmenu');
  for (const shiftKey of [false,true]) {
    expect(key(menu, 'Tab', {shiftKey}).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(menu);
    expect(menu.classList.contains('show')).toBe(true);
  }
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

it('對話框內的時碼右鍵選單接住 Enter 與 Escape，換窗同步移除舊選單', async () => {
  const { setupTimecodeInput } = await import('../src/tcparse.js');
  const menu = document.getElementById('ctxmenu'), home = menu.parentElement, apply = vi.fn();
  const bg = document.getElementById('modalBg');
  UI.openModal('修改持續時間', '<input id="testDuration" value="00:00:01:00">', [
    { label:'套用', enterDefault:true, act:apply }
  ]);
  const input = document.getElementById('testDuration');
  setupTimecodeInput(input); input.focus(); input.setSelectionRange(3,5);
  const open = () => input.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,cancelable:true}));
  open();
  expect(menu.dataset.ownerId).toBe('modalBg');
  expect(menu.parentElement).toBe(bg);
  for (const value of ['Tab','Enter',' ']) expect(key(input,value).defaultPrevented).toBe(true);
  expect(apply).not.toHaveBeenCalled();
  key(input,'Escape');
  expect(bg.classList.contains('show')).toBe(true);
  expect(menu.parentElement).toBe(home);
  expect(input.selectionStart).toBe(3); expect(input.selectionEnd).toBe(5);
  open(); UI.openModal('下一步', '<p>校對結果</p>');
  expect(menu.classList.contains('show')).toBe(false);
  expect(menu.parentElement).toBe(home);
  expect(menu.hasAttribute('data-owner-id')).toBe(false);
  expect(apply).not.toHaveBeenCalled();
});
