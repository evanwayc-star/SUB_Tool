// @vitest-environment jsdom
// tcparse -> state -> dom 連鎖相依，dom.js 在載入時即呼叫 document.getElementById，
// 故此檔需要 jsdom 環境（見稽核 T6：根因為 dom.js 的 import-time 副作用）。
// 另：tcparse 的 setupTimecodeInput 需要 menus.js 的 showCtx，而 menus→media→ui/timeline
// 整條 UI 鏈在載入時就對 DOM 元素掛監聽器（jsdom 空頁面為 null 會直接拋錯），
// 這裡只測純解析函式，故將 menus.js 以空實作隔離。
import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.mock('../src/menus.js', () => ({ showCtx: () => {} }));
import { State } from '../src/state.js';
import { parseTimecodeInput } from '../src/tcparse.js';

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
