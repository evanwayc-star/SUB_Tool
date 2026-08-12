// @vitest-environment jsdom
import { describe,expect,it,vi } from 'vitest';
import { bindNumberInputWheel } from '../src/number-input-wheel.js';

describe('數值輸入框滑鼠滾輪',()=>{
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
