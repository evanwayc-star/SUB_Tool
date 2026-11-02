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
  window.subtool = { isDesktop: true, configLoad: async () => ({}), configSave: async () => true,
    fontsList: async () => ({ fonts: [] }), recentProjects: async () => [], status: async () => ({ ffmpeg: true }),
    getStartupFile: async () => null, onProgress() {}, onQueueStatus() {}, onOpenFile() {},
    onAppRequestClose() { initialized = true; } };
  const { State } = await import('../src/state.js');
  const { Media } = await import('../src/media.js');
  await import('../src/app.js');
  await vi.waitFor(() => expect(initialized).toBe(true));

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
  Media.playing = false;
});
