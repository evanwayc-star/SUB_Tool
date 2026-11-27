// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mountPlayheadOcrRegion } from '../src/playhead-ocr-region.js';

let container, canvas, surface, overlay, change, submit, dispose, captured;
const image = {left:100, top:20, width:400, height:225};
beforeEach(() => {
  document.body.innerHTML = '<div id="playheadOcrRegion"></div>';
  container = document.getElementById('playheadOcrRegion');
  canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080;
  canvas.getBoundingClientRect = () => image;
  change = vi.fn(); submit = vi.fn();
  dispose = mountPlayheadOcrRegion(container, canvas, change, submit);
  surface = canvas.closest('button'); overlay = container.querySelector('.playhead-ocr-selection');
  captured = null;
  surface.setPointerCapture = id => { captured = id; };
  surface.hasPointerCapture = id => captured === id;
  surface.releasePointerCapture = () => { captured = null; };
});
afterEach(() => dispose());

function pointer(type, x, y, {id = 1, target = canvas, primary = true, button = 0, ...mods} = {}) {
  const e = new MouseEvent(type, {clientX:x, clientY:y, button, bubbles:true, cancelable:true, ...mods});
  Object.defineProperties(e, {pointerId:{value:id}, isPrimary:{value:primary}});
  target.dispatchEvent(e);
  return e;
}
function drag(x, y, endX, endY, mods = {}) {
  pointer('pointerdown', x, y, mods);
  pointer('pointermove', endX, endY, mods);
  pointer('pointerup', endX, endY, mods);
}
function key(key, modifiers = {}) {
  surface.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...modifiers}));
}
const selection = () => change.mock.lastCall[0];

it.each([[140,45,260,95],[260,95,140,45],[260,45,140,95],[140,95,260,45]])(
  '四個方向拖曳只更新選取，來源畫格不受預覽尺寸影響', (x, y, endX, endY) => {
    expect(pointer('pointerdown',x,y).defaultPrevented).toBe(true);
    expect(captured).toBe(1);
    pointer('pointermove',endX,endY);
    expect(overlay.hasAttribute('hidden')).toBe(false); expect(change).not.toHaveBeenCalled();
    pointer('pointerup',endX,endY);
    expect(captured).toBeNull();
    expect(change).toHaveBeenCalledExactlyOnceWith([{x:192,y:120,width:576,height:240}]);
    expect(document.activeElement).toBe(surface);
    surface.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));
    expect(submit).not.toHaveBeenCalled();
    surface.click(); expect(submit).toHaveBeenCalledExactlyOnceWith();
  });

it('留白不能啟動框選，從圖內拖到外面只取畫格內完整像素', () => {
  pointer('pointerdown',90,20,{target:container}); pointer('pointerup',260,90,{target:window});
  pointer('pointerdown',80,15); pointer('pointerup',200,50);
  expect(change).not.toHaveBeenCalled();
  pointer('pointerdown',145,67); pointer('pointerup',800,600,{target:window});
  expect(change).toHaveBeenCalledExactlyOnceWith([{x:216,y:225,width:1704,height:855}]);
});

it('次要按鍵或第二支指標不劫持已開始的框，過小操作可重試', () => {
  pointer('pointerdown',140,45,{button:2}); pointer('pointerup',260,95);
  pointer('pointerdown',140,45); pointer('pointerdown',280,120,{id:2,primary:false});
  pointer('pointerup',310,135,{id:2,primary:false}); expect(captured).toBe(1);
  pointer('pointerup',141,46); expect(change).not.toHaveBeenCalled(); expect(overlay.hasAttribute('hidden')).toBe(true);
  drag(140,45,260,95); expect(change).toHaveBeenCalledOnce();
});

it.each(['pointercancel','lostpointercapture','blur'])('遇到 %s 時還原先前的複合選區', type => {
  drag(140,45,260,95); drag(300,90,380,160,{shiftKey:true});
  const first = overlay.innerHTML;
  pointer('pointerdown',200,65,{altKey:true}); pointer('pointermove',310,120);
  if (type === 'blur') window.dispatchEvent(new Event('blur'));
  else pointer(type,310,120,{target:surface});
  pointer('pointerup',310,120);
  expect(captured).toBeNull(); expect(overlay.innerHTML).toBe(first); expect(change).toHaveBeenCalledTimes(2);
  expect(submit).not.toHaveBeenCalled();
});

it('相交與相連的同列矩形會合併，重複加選與扣除再填回不累積碎片', () => {
  drag(100,20,200,120);
  drag(150,20,250,120,{shiftKey:true});
  drag(250,20,300,120,{shiftKey:true});
  const whole = [{x:0,y:0,width:960,height:480}];
  expect(selection()).toEqual(whole);
  for (let i = 0; i < 12; i++) {
    drag(140,45,180,95,{altKey:true});
    expect(selection()).toHaveLength(4);
    drag(140,45,180,95,{shiftKey:true});
    expect(selection()).toEqual(whole);
    drag(150,48,170,78,{shiftKey:true});
    expect(selection()).toEqual(whole);
  }
  expect(submit).not.toHaveBeenCalled();
});

it('整張可直接辨識或扣除，中空處保留，空選區禁送；雙擊回到整張', () => {
  expect(overlay.hasAttribute('hidden')).toBe(true);
  surface.click(); expect(submit).toHaveBeenCalledTimes(1);
  drag(140,45,260,95,{shiftKey:true}); expect(selection()).toBeNull();
  drag(140,45,260,95,{altKey:true});
  const pieces = selection();
  expect(pieces.reduce((area,r) => area + r.width * r.height,0)).toBe(1920*1080 - 576*240);
  expect(pieces.some(r => r.x <= 450 && 450 < r.x+r.width && r.y <= 200 && 200 < r.y+r.height)).toBe(false);
  drag(100,20,500,245,{altKey:true}); expect(selection()).toEqual([]);
  surface.click(); expect(submit).toHaveBeenCalledTimes(1);
  surface.dispatchEvent(new MouseEvent('dblclick',{button:0,detail:2,bubbles:true}));
  expect(selection()).toBeNull(); expect(overlay.hasAttribute('hidden')).toBe(true);
  expect(submit).toHaveBeenCalledTimes(1);
  surface.click(); expect(submit).toHaveBeenCalledTimes(2);
});

it('交錯操作逐格符合布林選取、整數界線及不重疊輸出', () => {
  // Each 25×25 CSS cell represents exactly 120×120 source pixels.
  const rows = 9, columns = 16;
  let expected = Array.from({length:rows}, () => Array(columns).fill(true));
  let seed = 849;
  const random = max => { seed = (1664525 * seed + 1013904223) >>> 0; return seed % max; };
  for (let step = 0; step < 75; step++) {
    const x = random(columns), y = random(rows), w = 1 + random(columns-x), h = 1 + random(rows-y);
    const mode = step % 11 === 0 ? 'replace' : step % 2 === 0 ? 'subtract' : 'add';
    drag(100+x*25,20+y*25,100+(x+w)*25,20+(y+h)*25,{shiftKey:mode==='add',altKey:mode==='subtract'});
    expected = expected.map((row, ry) => row.map((prev, rx) => {
      const inside = rx >= x && rx < x+w && ry >= y && ry < y+h;
      if (mode === 'replace') return inside;
      return mode === 'add' ? prev || inside : prev && !inside;
    }));
    const result = selection() ?? [{x:0,y:0,width:1920,height:1080}];
    const pixels = Array.from({length:rows}, () => Array(columns).fill(0));
    for (const rect of result) {
      expect(Object.values(rect).every(n => n % 120 === 0)).toBe(true);
      for (let ry=rect.y/120; ry<(rect.y+rect.height)/120; ry++) {
        for (let rx=rect.x/120; rx<(rect.x+rect.width)/120; rx++) pixels[ry][rx]++;
      }
    }
    expect(pixels).toEqual(expected.map(row => row.map(Number)));
  }
});

it('鍵盤調整最近的框、保留其他選區，移動及重設都不啟動辨識', () => {
  key('ArrowRight'); key('ArrowUp',{altKey:true}); key('ArrowDown',{altKey:true,shiftKey:true});
  expect(selection()).toEqual([{x:499,y:359,width:960,height:361}]);
  drag(100,20,125,45,{shiftKey:true});
  key('ArrowRight',{altKey:true});
  expect(selection()).toEqual(expect.arrayContaining([{x:1,y:0,width:120,height:120},{x:499,y:359,width:960,height:361}]));
  expect(submit).not.toHaveBeenCalled();
  key('Home'); expect(selection()).toBeNull(); expect(submit).not.toHaveBeenCalled();
});

it('解除時釋放 capture、全域監聽和本次 DOM，其他 UI 保留', () => {
  const extra = document.createElement('p'); container.append(extra);
  pointer('pointerdown',140,45); dispose(); pointer('pointerup',260,95,{target:window}); surface.click();
  expect(captured).toBeNull(); expect(change).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
  expect([...container.children]).toEqual([extra]);
});

it('辨識階段切換時，選框、選項、文字欄會跟隨 hidden 隱藏', () => {
  const style = document.createElement('style');
  style.textContent = readFileSync('src/styles.css', 'utf8');
  document.head.append(style);
  const options = document.createElement('div'), label = document.createElement('label');
  options.id = 'playheadOcrOptions';
  label.id = 'playheadOcrLabel';
  document.body.append(options, label);
  try {
    expect(getComputedStyle(options).display).toBe('flex');
    for (const element of [container, options, label]) {
      element.hidden = true;
      expect(getComputedStyle(element).display).toBe('none');
      element.hidden = false;
      expect(getComputedStyle(element).display).not.toBe('none');
    }
  } finally { style.remove(); }
});
