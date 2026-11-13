import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { parse } from 'acorn';
import { describe, expect, it, vi } from 'vitest';

// Exercise the real preload and main handler together. A mock renderer-only
// bridge would miss a field dropped between the viewport caller and the host.
function bridge({ sender = 'main', destroyed = false, absent = false, result = true } = {}) {
  const source = fs.readFileSync(path.resolve('electron/main.js'), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const statement = ast.body.find(node => node.type === 'ExpressionStatement'
    && node.expression?.callee?.object?.name === 'ipcMain'
    && node.expression.callee.property?.name === 'handle'
    && node.expression.arguments[0]?.value === 'mpv:setViewport');
  expect(statement, 'main must register the native viewport endpoint').toBeDefined();
  const webContents = { id: 17 };
  const mainWin = absent ? null : { webContents, isDestroyed: () => destroyed };
  const event = { sender: sender === 'main' ? webContents : { id: 17 } };
  const host = { setViewport: vi.fn(async () => result) };
  const handlers = new Map();
  const context = vm.createContext({ mainWin, mpvHost: host,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } });
  vm.runInContext(source.slice(statement.start, statement.end), context);
  const invoke = vi.fn(async (channel, ...args) => {
    expect(channel).toBe('mpv:setViewport');
    return handlers.get(channel)(event, ...structuredClone(args));
  });
  let api;
  vm.runInNewContext(fs.readFileSync(path.resolve('electron/preload.js'), 'utf8'), {
    require: name => {
      if (name !== 'electron') throw new Error(`unexpected require: ${name}`);
      return { contextBridge: { exposeInMainWorld: (key, exposed) => { if (key === 'subtool') api = exposed; } },
        ipcRenderer: { invoke, on() {}, send() {} }, webUtils: {} };
    },
    ArrayBuffer, Uint8Array, Promise, TypeError, RangeError,
  });
  expect(api?.mpv?.setViewport, 'preload must expose the native viewport endpoint').toBeTypeOf('function');
  return { api, host, invoke, context };
}

function viewport() {
  return {
    bounds: { x: 103.25, y: 74.5, w: 960.5, h: 540.25 },
    visible: true,
    occluders: [
      { x: 850.75, y: 65.25, w: 260.5, h: 330.75 },
      { x: 120.5, y: 100.25, w: 170.75, h: 90.5 },
    ],
  };
}

describe('原生 viewport preload 與 main IPC', () => {
  it('主 renderer 的 bounds、visible 與全部遮擋矩形完整送至 host 並回傳結果', async () => {
    const { api, host, invoke } = bridge();
    const request = viewport();
    await expect(api.mpv.setViewport(request)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('mpv:setViewport', request);
    expect(host.setViewport).toHaveBeenCalledExactlyOnceWith(request);
  });

  it('保留 visible false 與空遮擋清單，也保留 host 拒絕的結果', async () => {
    const { api, host } = bridge({ result: false });
    const request = { bounds: viewport().bounds, visible: false, occluders: [] };
    await expect(api.mpv.setViewport(request)).resolves.toBe(false);
    expect(host.setViewport).toHaveBeenCalledExactlyOnceWith(request);
  });

  it.each([
    ['非主 renderer，即使偽造相同 webContents id', { sender: 'other' }],
    ['主視窗已銷毀', { destroyed: true }],
    ['主視窗不存在', { absent: true }],
  ])('%s 時拒絕且不觸發 host', async (_label, options) => {
    const { api, host, invoke } = bridge(options);
    await expect(api.mpv.setViewport(viewport())).rejects.toThrow('原生畫面範圍請求來源無效');
    expect(invoke).toHaveBeenCalledOnce();
    expect(host.setViewport).not.toHaveBeenCalled();
  });

  it('主視窗替換後，舊 renderer 不能沿用先前資格改變 viewport', async () => {
    const { api, host, context } = bridge();
    await expect(api.mpv.setViewport(viewport())).resolves.toBe(true);
    host.setViewport.mockClear();
    context.mainWin = { webContents: { id: 18 }, isDestroyed: () => false };
    await expect(api.mpv.setViewport(viewport())).rejects.toThrow('原生畫面範圍請求來源無效');
    expect(host.setViewport).not.toHaveBeenCalled();
  });
});
