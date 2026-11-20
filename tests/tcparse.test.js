// @vitest-environment jsdom
// tcparse -> state -> dom 連鎖相依，dom.js 在載入時即呼叫 document.getElementById，
// 故此檔需要 jsdom 環境（見稽核 T6：根因為 dom.js 的 import-time 副作用）。
// 另：tcparse 的 setupTimecodeInput 需要 menus.js 的 showCtx，而 menus→media→ui/timeline
// 整條 UI 鏈在載入時就對 DOM 元素掛監聽器（jsdom 空頁面為 null 會直接拋錯），
// 這裡只測純解析函式，故將 menus.js 以空實作隔離。
import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.mock('../src/menus.js', () => ({ showCtx: () => {} }));
import { State } from '../src/state.js';
import { parseTimecodeInput, setupTimecodeInput } from '../src/tcparse.js';
import { encoreToSec, getExactFps } from '../src/time.js';

// jsdom does not perform the browser's default text edit after beforeinput.
function typeText(input, text, inputType='insertText') {
  const event=new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType,data:text});
  if(input.dispatchEvent(event)){
    input.setRangeText(text,input.selectionStart,input.selectionEnd,'end');
    input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType,data:text}));
  }
  return event;
}
function pasteText(input,text){
  const event=new Event('paste',{bubbles:true,cancelable:true});
  Object.defineProperty(event,'clipboardData',{value:{getData:()=>text}});
  input.dispatchEvent(event);
  if(!event.defaultPrevented) typeText(input,text,'insertFromPaste');
}
function deleteText(input,backward=true){
  const inputType=backward?'deleteContentBackward':'deleteContentForward';
  const event=new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType});
  if(!input.dispatchEvent(event))return;
  let start=input.selectionStart,end=input.selectionEnd;
  if(start===end){if(backward)start=Math.max(0,start-1);else end=Math.min(input.value.length,end+1);}
  input.setRangeText('',start,end,'end');
  input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType}));
}
function editor(value='',options){
  const input=document.createElement('input');input.value=value;setupTimecodeInput(input,options);
  input.setSelectionRange(value.length,value.length);return input;
}

describe('數字時碼編輯',()=>{
  beforeEach(()=>{State.fps=25;State.dropFrame=false;});
  it('逐鍵輸入八位數，自動加入分隔且不更動解析秒數',()=>{
    const input=editor();
    for(const digit of '01020304')typeText(input,digit);
    expect(input.value).toBe('01:02:03:04');expect(input.selectionStart).toBe(11);
    expect(parseTimecodeInput(input.value)).toBe(3723.16);expect(input.inputMode).toBe('numeric');
    const extra=typeText(input,'5');expect(extra.defaultPrevented).toBe(true);expect(input.value).toBe('01:02:03:04');
  });
  it.each(['a','測試','e','/',' ',':',';'])('一般輸入 %s 不可改變時碼／選取',text=>{
    const input=editor('01:02:03:04');input.setSelectionRange(3,5);
    expect(typeText(input,text).defaultPrevented).toBe(true);
    expect(input.value).toBe('01:02:03:04');expect([input.selectionStart,input.selectionEnd]).toEqual([3,5]);
  });
  it('選取分量替換及鍵盤導覽不跳到末尾',()=>{
    const input=editor('01:02:03:04');input.setSelectionRange(3,5);typeText(input,'12');
    expect(input.value).toBe('01:12:03:04');expect(input.selectionStart).toBe(5);
    for(const key of ['ArrowLeft','ArrowRight','Home','End','Tab']){
      const event=new KeyboardEvent('keydown',{key,cancelable:true});input.dispatchEvent(event);expect(event.defaultPrevented).toBe(false);
    }
    const selectAll=new KeyboardEvent('keydown',{key:'a',ctrlKey:true,cancelable:true});input.dispatchEvent(selectAll);expect(selectAll.defaultPrevented).toBe(false);
  });
  it.each([[3,true,'0:23:45:12',1],[2,false,'0:13:45:12',3]])('游標 %s 的刪除跨過系統分隔符，確實刪一位數', (cursor,backward,expected,position)=>{
    const input=editor('01:23:45:12');input.setSelectionRange(cursor,cursor);deleteText(input,backward);
    expect(input.value).toBe(expected);expect(input.selectionStart).toBe(position);
  });
  it('全選刪除保留空值；未定時提示不會被初始化成零',()=>{
    const input=editor('--:--:--:--');expect(input.value).toBe('--:--:--:--');input.select();deleteText(input);
    expect(input.value).toBe('');expect(parseTimecodeInput(input.value)).toBeNull();typeText(input,'4');expect(input.value).toBe('4');
  });
  it.each([['01:02:03:04','01:02:03:04'],['1:2:3:4','01:02:03:04'],['１２３４','12:34'],['０１：０２：０３；０４','01:02:03:04']])('正常時碼貼上 %s → %s', (text,expected)=>{
    const input=editor('00:00:00:00');input.select();pasteText(input,text);expect(input.value).toBe(expected);
  });
  it('貼上一般文字不得偷偷擷取其中數字變成時碼',()=>{
    const input=editor('00:00:02:00');input.select();pasteText(input,'第 12 段');expect(input.value).toBe('00:00:02:00');
    pasteText(input,'');expect(input.value).toBe('00:00:02:00');
  });
  it('DF 分號由專案產生；不變更有效 DF 標籤',()=>{
    State.fps=29.97;State.dropFrame=true;const input=editor();for(const digit of '00010002')typeText(input,digit);
    expect(input.value).toBe('00:01:00;02');expect(parseTimecodeInput(input.value)).toBeCloseTo(1800*1001/30000,8);
  });
  it('只在原本支援的欄位允許相對正負號',()=>{
    const signed=editor('',{allowSign:true});typeText(signed,'-');for(const digit of '00000100')typeText(signed,digit);
    expect(signed.value).toBe('-00:00:01:00');
    const absolute=editor();expect(typeText(absolute,'-').defaultPrevented).toBe(true);expect(absolute.value).toBe('');
  });
  it('原有小數秒數欄位保留 1.5，普通時碼欄不接受小數點',()=>{
    const duration=editor('',{allowSeconds:true});for(const digit of '1.5')typeText(duration,digit);expect(duration.value).toBe('1.5');
    expect(duration.inputMode).toBe('decimal');const input=editor('1');expect(typeText(input,'.').defaultPrevented).toBe(true);
  });
  it('小數秒只能輸入或貼純秒數，不把混用冒號的小數猜成別的時間',()=>{
    const input=editor('00:00:01:00',{allowSeconds:true});input.select();pasteText(input,'01:02:03.5');expect(input.value).toBe('00:00:01:00');
    input.setSelectionRange(6,8);pasteText(input,'1.5');expect(input.value).toBe('00:00:01:00');
    input.select();for(const digit of '123.5')typeText(input,digit);expect(input.value).toBe('123.5');
  });
  it('組字中不碰草稿；完成後全形數字轉 ASCII，自動分隔',()=>{
    const input=editor();input.dispatchEvent(new CompositionEvent('compositionstart'));
    input.value='１２３４';input.setSelectionRange(4,4);input.dispatchEvent(new InputEvent('input',{isComposing:true,inputType:'insertCompositionText'}));
    expect(input.value).toBe('１２３４');input.dispatchEvent(new CompositionEvent('compositionend',{data:'１２３４'}));
    expect(input.value).toBe('12:34');expect(input.selectionStart).toBe(5);
  });
  it('組字產生非數字時還原原草稿與選取，不提交零',()=>{
    const input=editor('00:00:12:00');input.select();input.dispatchEvent(new CompositionEvent('compositionstart'));
    input.value='測試';input.dispatchEvent(new InputEvent('input',{isComposing:true}));input.dispatchEvent(new CompositionEvent('compositionend',{data:'測試'}));
    expect(input.value).toBe('00:00:12:00');expect([input.selectionStart,input.selectionEnd]).toEqual([0,11]);
  });
  it('組字期間直接失焦，caller 只能提交正常化數字或原草稿',()=>{
    const input=editor('00:00:01:00');input.select();input.dispatchEvent(new CompositionEvent('compositionstart'));
    input.value='１２３４';input.setSelectionRange(4,4);let committed;
    input.addEventListener('blur',()=>{committed=input.value;});input.dispatchEvent(new FocusEvent('blur'));
    expect(committed).toBe('12:34');
  });
  it('長小時時碼貼上不截掉高位；全形小數秒不變成格數',()=>{
    const input=editor();pasteText(input,'100:02:03:04');expect(input.value).toBe('100:02:03:04');expect(parseTimecodeInput(input.value)).toBe(360123.16);
    const seconds=editor('',{allowSeconds:true});pasteText(seconds,'１２３．５');expect(seconds.value).toBe('123.5');
  });
  it('重複 setup 不重複上下鍵步進，未綁定文字框保持文字',()=>{
    const input=editor('00:00:01:00');setupTimecodeInput(input);input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',cancelable:true}));
    expect(input.value).toBe('00:00:01:01');const text=document.createElement('input');typeText(text,'字幕 ABC 123');expect(text.value).toBe('字幕 ABC 123');
  });
});

it.each([{key:'Enter',isComposing:true},{key:'Escape',isComposing:true},{key:'ArrowUp',isComposing:true},
  {key:'ArrowDown',isComposing:true},{key:'Enter',keyCode:229}])('組字 %j 保留原生行為且不進入時碼提交或步進',options=>{
  const input=document.createElement('input');input.value='00:00:01:00';input.setSelectionRange(10,10);
  setupTimecodeInput(input);const submit=vi.fn();input.addEventListener('keydown',submit);
  const event=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,...options});input.dispatchEvent(event);
  expect(submit).not.toHaveBeenCalled();expect(input.value).toBe('00:00:01:00');expect(event.defaultPrevented).toBe(false);
});

describe('parseTimecodeInput 絕對時碼（非 DF）', () => {
  beforeEach(() => { State.fps = 24; State.dropFrame = false; });

  it('HH:MM:SS:FF', () => {
    expect(parseTimecodeInput('00:00:01:00')).toBeCloseTo(1, 6);
    expect(parseTimecodeInput('00:00:00:12')).toBeCloseTo(12 / 24, 6);
    expect(parseTimecodeInput('01:02:03:00')).toBeCloseTo(3723, 6);
  });

  it('格數夾在 fps-1 以內', () => {
    // f=30 在 24fps 下夾為 23
    expect(parseTimecodeInput('00:00:00:30')).toBeCloseTo(23 / 24, 6);
  });

  it('空字串回 null', () => {
    expect(parseTimecodeInput('')).toBeNull();
    expect(parseTimecodeInput('   ')).toBeNull();
  });
});

describe('parseTimecodeInput 緊湊輸入', () => {
  beforeEach(() => { State.fps = 24; State.dropFrame = false; });

  it('由右至左對應 格/秒/分/時', () => {
    expect(parseTimecodeInput('0102')).toBeCloseTo(1 + 2 / 24, 6); // 1 秒 02 格
    expect(parseTimecodeInput('1000')).toBeCloseTo(10, 6);          // 10 秒 00 格
  });

  it('非數字緊湊輸入回 null', () => {
    expect(parseTimecodeInput('ab')).toBeNull();
  });
});

describe('parseTimecodeInput Drop-frame', () => {
  beforeEach(() => { State.fps = 29.97; State.dropFrame = true; });

  it('DF 時碼經 encoreToSec 反推', () => {
    // frame 1800 -> 00:01:00;02 -> 1800*1001/30000
    expect(parseTimecodeInput('00:01:00;02')).toBeCloseTo((1800 * 1001) / 30000, 4);
  });
});

describe('時間碼輸入真實按鍵與影格格網', () => {
  it.each([
    [29.97, true, '00:00:59;29', 'ArrowUp', '00:01:00;02'],
    [29.97, true, '00:01:00;02', 'ArrowDown', '00:00:59;29'],
    [59.94, true, '00:00:59;59', 'ArrowUp', '00:01:00;04'],
    [59.94, true, '00:01:00;04', 'ArrowDown', '00:00:59;59'],
    [29.97, true, '00:09:59;29', 'ArrowUp', '00:10:00;00'],
    [59.94, true, '00:09:59;59', 'ArrowUp', '00:10:00;00'],
    [29.97, false, '00:00:59:29', 'ArrowUp', '00:01:00:00'],
    [24, false, '00:00:00:00', 'ArrowDown', '00:00:00:00'],
  ])('%s DF=%s %s %s → %s', (fps, df, before, key, after) => {
    State.fps = fps; State.dropFrame = df;
    const input = document.createElement('input');
    input.value = before; input.setSelectionRange(10, 10);
    setupTimecodeInput(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true }));
    expect(input.value).toBe(after);
    expect(input.selectionStart).toBe(10);
    const actualStep = Math.round((encoreToSec(input.value, fps, df) - encoreToSec(before, fps, df)) * getExactFps(fps));
    expect(actualStep).toBe(before === after ? 0 : key === 'ArrowUp' ? 1 : -1);
  });

  it.each(['oops:00:00:00','00:00:01:00garbage','00:00:1.5:00','00::01:00','1:2:3:4:5',
    '00:00:-1:00','00:00:1e2:00','123456789','999999999999999999:00:00:00'])('非法時碼 %s 不可猜成可提交的時間', input => {
    expect(parseTimecodeInput(input)).toBeNull();
  });
  it('合法短分段仍由右至左解讀',()=>{
    expect(parseTimecodeInput('01:02')).toBeCloseTo(1+2/24,8);
    expect(parseTimecodeInput('02:01:02')).toBeCloseTo(121+2/24,8);
  });

  it.each([[29.97, '00:00:00;00', 4, '00:01:00;02'], [59.94, '+00:00:59;00', 8, '+00:01:00;04']])('秒或分微調也只產生有效 DF 標籤', (fps, before, cursor, expected) => {
    State.fps = fps; State.dropFrame = true;
    const input = document.createElement('input');
    input.value = before; input.setSelectionRange(cursor, cursor);
    setupTimecodeInput(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true }));
    expect(input.value).toBe(expected);
    expect(input.selectionStart).toBe(cursor);
  });
});
