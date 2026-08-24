import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  sanitizeWindowBounds,
  decideWindowCloseAction,
} = require('../electron/window-lifecycle-authority.js');

describe('window-lifecycle-authority', () => {
  it('限制視窗幾何邊界，防止視窗在螢幕外無法操作', () => {
    const displays = [
      { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    ];

    // 在螢幕範圍內
    const normal = sanitizeWindowBounds({ x: 100, y: 100, width: 1200, height: 800 }, displays);
    expect(normal).toEqual({ x: 100, y: 100, width: 1200, height: 800 });

    // 儲存的座標在已被拔除的副螢幕（例如 x=3000）
    const offscreen = sanitizeWindowBounds({ x: 3000, y: 100, width: 1200, height: 800 }, displays);
    expect(offscreen.x).toBeUndefined(); // 回退置中
    expect(offscreen.width).toBe(1200);
    expect(offscreen.height).toBe(800);
  });

  it('轉檔進行中時，關閉主視窗需提出警告', () => {
    expect(decideWindowCloseAction(0, false)).toBe('quit');
    expect(decideWindowCloseAction(2, false)).toBe('prompt_running_jobs');
    expect(decideWindowCloseAction(2, true)).toBe('quit'); // 全域退出
  });
});
