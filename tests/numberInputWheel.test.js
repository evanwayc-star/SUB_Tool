// @vitest-environment jsdom
import { describe,expect,it,vi } from 'vitest';
import { bindNumberInputWheel } from '../src/keybinding-engine.js';

describe('數值輸入框滑鼠滾輪',()=>{
  it.each([
    '<input type="number" disabled value="40">',
    '<input type="number" readonly value="40">',
    '<fieldset disabled><input type="number" value="40"></fieldset>',
    '<input class="num-scrubber" readonly value="40">',
  ])('保留不可編輯欄位的值並讓滾輪繼續捲動：%s',html=>{
    document.body.innerHTML=html;
    const input=document.querySelector('input');
    const onInput=vi.fn(),onChange=vi.fn();
    input.addEventListener('input',onInput);
    input.addEventListener('change',onChange);
    const unbind=bindNumberInputWheel(document);
    try{
      const event=new WheelEvent('wheel',{deltaY:-1,bubbles:true,cancelable:true});
      expect(input.dispatchEvent(event)).toBe(true);
      expect(event.defaultPrevented).toBe(false);
      expect(input.value).toBe('40');
      expect(onInput).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
    }finally{unbind();}
  });

  it('解除 disabled 後可以正常調整數值',()=>{
    document.body.innerHTML='<input type="number" disabled value="40">';
    const input=document.querySelector('input');
    const unbind=bindNumberInputWheel(document);
    try{
      input.disabled=false;
      input.dispatchEvent(new WheelEvent('wheel',{deltaY:-1,bubbles:true,cancelable:true}));
      expect(input.value).toBe('41');
    }finally{unbind();}
  });

  it('行距依 step 每格調整 0.1，並維持乾淨的小數值',()=>{
    document.body.innerHTML='<input type="number" id="tsLineSp" min="1" max="100" step="0.1" value="1">';
    const input=document.getElementById('tsLineSp');
    const onInput=vi.fn();
    input.addEventListener('input',onInput);
    const unbind=bindNumberInputWheel(document);

    const up=()=>input.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true,cancelable:true}));
    const down=()=>input.dispatchEvent(new WheelEvent('wheel',{deltaY:100,bubbles:true,cancelable:true}));
    expect(up()).toBe(false);
    expect(input.value).toBe('1.1');
    up();
    expect(input.value).toBe('1.2');
    down();
    expect(input.value).toBe('1.1');
    expect(onInput).toHaveBeenCalledTimes(3);

    unbind();
  });

  it('維持上下限，Shift 仍提供十倍步進',()=>{
    document.body.innerHTML='<input type="number" min="1" max="2" step="0.1" value="1.5">';
    const input=document.querySelector('input');
    const unbind=bindNumberInputWheel(document);

    input.dispatchEvent(new WheelEvent('wheel',{deltaY:-1,shiftKey:true,bubbles:true,cancelable:true}));
    expect(input.value).toBe('2');
    input.dispatchEvent(new WheelEvent('wheel',{deltaY:1,shiftKey:true,bubbles:true,cancelable:true}));
    expect(input.value).toBe('1');

    unbind();
  });
});
