import { describe, it, expect } from 'vitest';
import { State, applyFps, snapFps, FPS_SET } from '../src/state.js';

// A1 後 state.js 不再相依 dom.js/time.js，可在 node 環境直接測試 applyFps（純函式）。

describe('snapFps', () => {
  it('吸附到最接近的允許 fps', () => {
    expect(snapFps(23.9)).toBe(23.976);
    expect(snapFps(24.1)).toBe(24);
    expect(snapFps(60)).toBe(30);   // 超出範圍 → 取最近（30）
    expect(FPS_SET).toContain(29.97);
  });
});

describe('applyFps', () => {
  it('套用整數 fps、清除 dropFrame', () => {
    const r = applyFps(25);
    expect(r).toEqual({ fps: 25, dropFrame: false });
    expect(State.fps).toBe(25);
    expect(State.dropFrame).toBe(false);
  });

  it('"df" 後綴 → dropFrame=true 並解析數字', () => {
    const r = applyFps('29.97df');
    expect(State.fps).toBe(29.97);
    expect(State.dropFrame).toBe(true);
    expect(r).toEqual({ fps: 29.97, dropFrame: true });
  });

  it('非 df 字串會吸附並關閉 dropFrame', () => {
    applyFps('29.97df');           // 先設成 df
    const r = applyFps(24);        // 再切回非 df
    expect(r.dropFrame).toBe(false);
    expect(State.dropFrame).toBe(false);
    expect(State.fps).toBe(24);
  });
});
