import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parse } from 'acorn';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { FileAuthority } = require('../electron/file-authority.js');
const { createScreenshotOutput } = require('../electron/screenshot-output.js');
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function bridge(fileAuthority, screenshotOutput, mpvHost, channel = 'mpv:screenshot', mainFrame = true) {
  const source = fs.readFileSync(path.resolve('electron/main.js'), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const statement = ast.body.find(node => node.type === 'ExpressionStatement'
    && node.expression?.callee?.object?.name === 'ipcMain'
    && node.expression.callee.property?.name === 'handle'
    && node.expression.arguments[0]?.value === channel);
  expect(statement).toBeDefined();
  let handler, api;
  const sender = { mainFrame: {} };
  const event = { sender, senderFrame: mainFrame ? sender.mainFrame : {} };
  vm.runInNewContext(source.slice(statement.start, statement.end), {
    ipcMain: { handle: (channel, fn) => { handler = fn; } }, fileAuthority, screenshotOutput, mpvHost, Error,
    isMainWindowSender: e => e.sender === sender, _isAppQuitting: false,
  });
  vm.runInNewContext(fs.readFileSync(path.resolve('electron/preload.js'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (name, exposed) => { if (name === 'subtool') api = exposed; } },
      ipcRenderer: { invoke: (invoked, ...args) => {
        expect(invoked).toBe(channel);
        return Promise.resolve().then(() => handler(event, ...args));
      }, on() {}, send() {} }, webUtils: {} }),
    ArrayBuffer, Uint8Array, Promise, TypeError, RangeError,
  });
  return api;
}

describe('原生截圖 preload 與 main IPC', () => {
  it('OCR reads a clean PNG through the main frame and releases the temporary file before returning', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-native-ocr-')); roots.push(temp);
    const authority = new FileAuthority(), output = createScreenshotOutput({ fileAuthority: authority, tempDir: temp });
    const png = Buffer.from('iVBORw0KGgo=', 'base64');
    const host = { screenshot: vi.fn(async (file, settings) => {
      expect(path.extname(file)).toBe('.png');
      expect(settings.videoOnly).toBe(true);
      fs.writeFileSync(file, png);
      return { ok: true };
    }) };
    await expect(bridge(authority, output, host, 'mpv:captureOcrFrame', false).mpv.captureOcrFrame()).rejects.toThrow('此視窗');
    expect(host.screenshot).not.toHaveBeenCalled();
    await expect(bridge(authority, output, host, 'mpv:captureOcrFrame').mpv.captureOcrFrame()).resolves.toEqual({
      ok: true, b64: png.toString('base64'),
    });
    expect(fs.readdirSync(temp)).toEqual([]);
    await output.close();
  });
  it('不覆蓋專案資料夾同名檔，從私有 temp 回傳影像並清理', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-native-shot-ipc-')); roots.push(root);
    const selected = path.join(root, 'selected'), temp = path.join(root, 'private');
    fs.mkdirSync(selected); fs.mkdirSync(temp);
    const requested = path.join(selected, '.subtool_temp_shot.jpg'); fs.writeFileSync(requested, 'user content');
    const authority = new FileAuthority(); authority.grantScreenshotDirectory(selected);
    const output = createScreenshotOutput({ fileAuthority: authority, tempDir: temp });
    let actual;
    const host = { screenshot: vi.fn(async file => { actual = file; fs.writeFileSync(file, 'captured'); return { ok: true }; }) };
    const result = await bridge(authority, output, host).mpv.screenshot(requested);
    expect(result).toEqual({ ok: true, b64: Buffer.from('captured').toString('base64') });
    expect(actual.startsWith(temp + path.sep)).toBe(true);
    expect(fs.readFileSync(requested, 'utf8')).toBe('user content');
    expect(fs.readdirSync(temp)).toEqual([]);
    await output.close();
  });

  it('未授權路徑不啟動 mpv 或建立暫存', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-native-shot-ipc-')); roots.push(root);
    const temp = path.join(root, 'private'); fs.mkdirSync(temp);
    const authority = new FileAuthority(), output = createScreenshotOutput({ fileAuthority: authority, tempDir: temp });
    const host = { screenshot: vi.fn() };
    await expect(bridge(authority, output, host).mpv.screenshot(path.join(root, 'untrusted.jpg'))).rejects.toThrow(/未授權/);
    expect(host.screenshot).not.toHaveBeenCalled();
    expect(fs.readdirSync(temp)).toEqual([]);
  });
});
