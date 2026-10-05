import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parse } from 'acorn';
import { describe, expect, it, vi } from 'vitest';
import { DELIVERY_FRAME_RATES, exactDeliveryFrameRate } from '../shared/delivery-frame-rate.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function channelsIn(source, expression) {
  return [...source.matchAll(expression)].map(match => match[1]);
}

function queueBridge(sendSync = vi.fn((channel, value) => exactDeliveryFrameRate(value))) {
  let api;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'electron/queue-preload.js'), 'utf8'), {
    require: name => {
      if (name !== 'electron') throw new Error(`sandbox preload cannot require ${name}`);
      return {
        contextBridge: { exposeInMainWorld: (name, exposed) => { if (name === 'queueAPI') api = exposed; } },
        ipcRenderer: { sendSync, invoke: vi.fn(), on() {}, removeAllListeners() {} },
      };
    },
  });
  return { api, sendSync };
}

function queueFrameRateHandler() {
  const source = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const registration = ast.body.find(node => node.type === 'ExpressionStatement'
    && node.expression.type === 'CallExpression'
    && node.expression.callee.object?.name === 'ipcMain'
    && node.expression.callee.property?.name === 'on'
    && node.expression.arguments[0]?.value === 'queue:exactFrameRate');
  expect(registration).toBeDefined();
  const webContents = {};
  let handler;
  const context = {
    ipcMain: { on: (channel, listener) => { handler = listener; } },
    queueWin: { isDestroyed: () => false, webContents },
    exactDeliveryFrameRate,
  };
  vm.runInNewContext(source.slice(registration.start, registration.end), context);
  return { handler, context, webContents };
}

describe('sandbox 佇列精確 FPS bridge', () => {
  it('只需 electron require 即可暴露 bridge，九種標準 FPS 重複查詢只各 IPC 一次', () => {
    const { api, sendSync } = queueBridge();
    expect(api).toBeDefined();
    expect(sendSync).not.toHaveBeenCalled();
    for (const { value } of DELIVERY_FRAME_RATES) {
      expect(api.exactFrameRate(value)).toBe(exactDeliveryFrameRate(value));
      expect(api.exactFrameRate(value)).toBe(exactDeliveryFrameRate(value));
    }
    expect(sendSync).toHaveBeenCalledTimes(9);
    expect(sendSync.mock.calls.every(([channel]) => channel === 'queue:exactFrameRate')).toBe(true);
  });

  it('數值與字串原樣交由共享 parser，包含有理數、自訂 FPS 與無效值', () => {
    const { api, sendSync } = queueBridge();
    for (const value of ['30000/1001', '59.94', 'bad', 0.5, 480, 0, NaN, Infinity]) {
      expect(api.exactFrameRate(value)).toBe(exactDeliveryFrameRate(value));
      expect(sendSync).toHaveBeenLastCalledWith('queue:exactFrameRate', value);
    }
  });

  it('非數值或字串類型使用 30 FPS fallback，不傳送物件或函式', () => {
    const { api, sendSync } = queueBridge();
    for (const value of [undefined, null, true, {}, [], () => {}, Symbol('invalid')]) {
      expect(api.exactFrameRate(value)).toBe(30);
    }
    expect(sendSync).toHaveBeenCalledExactlyOnceWith('queue:exactFrameRate', 30);
  });

  it('快取最多保留 64 種查詢，超出後移除最早項目並保留近期值', () => {
    const { api, sendSync } = queueBridge();
    for (let rate = 100; rate < 164; rate++) expect(api.exactFrameRate(rate)).toBe(rate);
    expect(api.exactFrameRate(163)).toBe(163);
    expect(sendSync).toHaveBeenCalledTimes(64);
    expect(api.exactFrameRate(164)).toBe(164);
    expect(api.exactFrameRate(163)).toBe(163);
    expect(sendSync).toHaveBeenCalledTimes(65);
    expect(api.exactFrameRate(100)).toBe(100);
    expect(sendSync).toHaveBeenCalledTimes(66);
  });

  it.each([null, undefined, '30', NaN, -1])('拒絕無效的同步回應 %s，失敗不能寫入快取', response => {
    const sendSync = vi.fn().mockReturnValueOnce(response).mockReturnValueOnce(25);
    const { api } = queueBridge(sendSync);
    expect(() => api.exactFrameRate(25)).toThrow(/影格率/);
    expect(api.exactFrameRate(25)).toBe(25);
    expect(sendSync).toHaveBeenCalledTimes(2);
  });

  it('main 同步 handler 只對存活佇列 sender 回傳共享精確 FPS', () => {
    const { handler, webContents } = queueFrameRateHandler();
    expect(handler.constructor.name).not.toBe('AsyncFunction');
    for (const value of [29.97, '30000/1001', 'bad', 480, NaN]) {
      const event = { sender: webContents };
      handler(event, value);
      expect(event.returnValue).toBe(exactDeliveryFrameRate(value));
    }
  });

  it('同步事件成功路徑只寫一次回覆，不能先送 null 再覆寫精確 FPS', () => {
    const { handler, webContents } = queueFrameRateHandler();
    const replies = [];
    const event = { sender: webContents };
    Object.defineProperty(event, 'returnValue', { set: value => replies.push(value) });
    handler(event, 29.97);
    expect(replies).toEqual([exactDeliveryFrameRate(29.97)]);
  });

  it.each(['foreign', 'destroyed', 'missing', 'invalid-type'])('main 拒絕 %s，仍立即回應 null', mode => {
    const { handler, context, webContents } = queueFrameRateHandler();
    if (mode === 'destroyed') context.queueWin.isDestroyed = () => true;
    if (mode === 'missing') context.queueWin = null;
    const event = { sender: mode === 'foreign' ? {} : webContents };
    const replies = [];
    Object.defineProperty(event, 'returnValue', {
      get: () => replies[0],
      set: value => replies.push(value),
    });
    handler(event, mode === 'invalid-type' ? {} : 29.97);
    expect(event.returnValue).toBeNull();
    expect(replies).toEqual([null]);
  });
});

describe('Electron invoke interface', () => {
  it('截圖reservation釋放只接受path字串並使用獨立main channel', async () => {
    const invoke = vi.fn().mockResolvedValue(true);
    let api;
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'electron/preload.js'), 'utf8'), {
      require: () => ({
        contextBridge: { exposeInMainWorld: (name, exposed) => { if (name === 'subtool') api = exposed; } },
        ipcRenderer: { invoke, on() {}, send() {} }, webUtils: {},
      }),
      ArrayBuffer, Uint8Array, Promise, TypeError, RangeError,
    });
    expect(() => api.releaseScreenshotPath(null)).toThrow(TypeError);
    expect(invoke).not.toHaveBeenCalled();
    await api.releaseScreenshotPath('C:/Project/Shot-001.jpg');
    expect(invoke).toHaveBeenCalledWith('fs:releaseScreenshotPath', 'C:/Project/Shot-001.jpg');
  });
  it('preload 暴露的每一條 invoke channel 都有主程序 handler', () => {
    const preloadSources = ['preload.js', 'queue-preload.js', 'compare-preload.js']
      .map(file => fs.readFileSync(path.join(ROOT, 'electron', file), 'utf8'));
    const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
    const invoked = new Set(preloadSources.flatMap(source =>
      channelsIn(source, /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g)));
    const handled = new Set(channelsIn(main, /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g));

    expect([...invoked].filter(channel => !handled.has(channel)).sort()).toEqual([]);
  });

  it('preload 的同步查詢都有主程序 on handler', () => {
    const preloadSources = ['preload.js', 'queue-preload.js', 'compare-preload.js']
      .map(file => fs.readFileSync(path.join(ROOT, 'electron', file), 'utf8'));
    const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    const sent = new Set(preloadSources.flatMap(source =>
      channelsIn(source, /ipcRenderer\.sendSync\(\s*['"]([^'"]+)['"]/g)));
    const handled = new Set(channelsIn(main, /ipcMain\.on\(\s*['"]([^'"]+)['"]/g));
    expect([...sent].filter(channel => !handled.has(channel))).toEqual([]);
  });
});
