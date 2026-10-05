import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createCompareWindow } = require('../electron/compare-window.js');

function fixture() {
  const windows = [];
  const protectWindow = vi.fn();
  const onClosed = vi.fn();
  const controller = createCompareWindow({
    document: '/app/compare.html', preload: '/app/compare-preload.js', protectWindow, onClosed,
    createWindow(options) {
      const window = new EventEmitter();
      window.options = options;
      window.destroyed = false;
      window.isDestroyed = () => window.destroyed;
      window.isMinimized = () => false;
      window.restore = vi.fn(); window.show = vi.fn(); window.focus = vi.fn();
      window.setMenu = vi.fn(); window.loadFile = vi.fn();
      window.webContents = new EventEmitter();
      window.webContents.send = vi.fn();
      windows.push(window);
      return window;
    },
  });
  return { controller, windows, protectWindow, onClosed };
}

describe('比對native window snapshot owner', () => {
  it.each(['sync', 'open'])('%s在load期間取代首次plan，renderer ready只收到最新revision', mode => {
    const { controller, windows, protectWindow } = fixture();
    controller.open({ revision: 1, plan: { rows: ['old'] } });
    const latest = { revision: 2, plan: { rows: ['new'] } };
    controller[mode](latest);
    expect(windows).toHaveLength(1);
    expect(protectWindow).toHaveBeenCalledWith(windows[0], { document: '/app/compare.html' });
    expect(windows[0].webContents.send).not.toHaveBeenCalled();
    windows[0].webContents.emit('did-finish-load');
    expect(windows[0].webContents.send).toHaveBeenCalledExactlyOnceWith('compare:update-data', latest);
    expect(controller.isSender(windows[0].webContents)).toBe(true);
    expect(controller.isSender({})).toBe(false);
  });

  it('已loaded的window sync立即更新，closed只通知一次且不能再接受舊sender', () => {
    const { controller, windows, onClosed } = fixture();
    controller.open({ revision: 1 });
    windows[0].webContents.emit('did-finish-load');
    controller.sync({ revision: 2 });
    expect(windows[0].webContents.send).toHaveBeenLastCalledWith('compare:update-data', { revision: 2 });
    windows[0].destroyed = true;
    windows[0].emit('closed');
    windows[0].emit('closed');
    expect(onClosed).toHaveBeenCalledOnce();
    expect(controller.sync({ revision: 3 })).toBe(false);
    expect(controller.isSender(windows[0].webContents)).toBe(false);
  });

  it('舊window延遲load/close不能寫到或關閉新window的snapshot', () => {
    const { controller, windows, onClosed } = fixture();
    controller.open({ revision: 1 });
    windows[0].destroyed = true;
    controller.open({ revision: 2 });
    windows[0].webContents.emit('did-finish-load');
    windows[0].emit('closed');
    expect(windows[0].webContents.send).not.toHaveBeenCalled();
    expect(windows[1].webContents.send).not.toHaveBeenCalled();
    expect(onClosed).not.toHaveBeenCalled();
    expect(controller.isSender(windows[1].webContents)).toBe(true);
    windows[1].webContents.emit('did-finish-load');
    expect(windows[1].webContents.send).toHaveBeenCalledExactlyOnceWith('compare:update-data', { revision: 2 });
  });
});
