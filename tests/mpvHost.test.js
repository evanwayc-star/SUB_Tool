import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createMpvHost } = require('../electron/mpv-host.js');

class FakeWindow {
  static instances = [];

  constructor(options) {
    this.options = options;
    this.destroyed = false;
    this.webContents = { executeJavaScript: vi.fn(() => Promise.resolve()) };
    this.setIgnoreMouseEvents = vi.fn();
    this.setMenu = vi.fn();
    this.loadURL = vi.fn(() => Promise.resolve());
    this.setBounds = vi.fn();
    this.show = vi.fn();
    this.showInactive = vi.fn();
    this.hide = vi.fn();
    this.moveTop = vi.fn();
    this.destroy = vi.fn(() => { this.destroyed = true; });
    FakeWindow.instances.push(this);
  }

  isDestroyed() { return this.destroyed; }
  getNativeWindowHandle() { return Buffer.from([0x34, 0x12, 0, 0, 0, 0, 0, 0]); }
}

function socketThatReportsDuration(duration = 123.5) {
  const socket = new EventEmitter();
  socket.destroy = vi.fn(() => socket.emit('close'));
  socket.write = vi.fn(raw => {
    const message = JSON.parse(raw);
    if (typeof message.request_id !== 'number') return;
    queueMicrotask(() => socket.emit('data', Buffer.from(JSON.stringify({ request_id: message.request_id, data: duration }) + '\n')));
  });
  return socket;
}

function make({ duration = 123.5 } = {}) {
  FakeWindow.instances = [];
  const parent = { isDestroyed: () => false, getContentBounds: () => ({ x: 100, y: 200 }) };
  const children = [];
  const sockets = [];
  const events = [];
  const host = createMpvHost({
    BrowserWindow: FakeWindow,
    spawn: vi.fn((exe, args) => {
      const child = new EventEmitter();
      child.kill = vi.fn();
      child.stderr = null;
      children.push({ child, exe, args });
      return child;
    }),
    createConnection: vi.fn(() => {
      const socket = socketThatReportsDuration(duration);
      sockets.push(socket);
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    }),
    fs: { writeFileSync: vi.fn(), createWriteStream: vi.fn(() => null) },
    path: { join: (...parts) => parts.join('/') },
    url: { pathToFileURL: filePath => ({ href: 'file:///' + filePath }) },
    getMainWindow: () => parent,
    supported: () => true,
    findExecutable: vi.fn(() => 'C:/bundle/mpv.exe'),
    ensureTmp: vi.fn(),
    tmpDir: 'C:/tmp',
    tempFiles: new Set(),
    guideHtml: '<!doctype html>',
    fontsDir: () => 'C:/fonts',
    onEvent: event => events.push(event),
    log: vi.fn(),
    now: vi.fn(() => 9001),
    delay: async () => {},
    setTimer: fn => { fn(); return 0; },
    clearTimer: vi.fn(),
  });
  return { host, parent, children, sockets, events };
}

describe('Windows mpv host lifecycle', () => {
  it('原生倒播用 play-direction 切換方向，恢復正播時也明確寫回 forward', async () => {
    const { host, sockets } = make();
    await host.launch({ src: 'D:/media/a.mxf', bounds: { x: 0, y: 0, w: 100, h: 50 } });
    sockets[0].write.mockClear();

    host.direction('backward');
    host.direction('forward');

    const commands = sockets[0].write.mock.calls.map(([raw]) => JSON.parse(raw).command);
    expect(commands).toEqual([
      ['set_property', 'play-direction', 'backward'],
      ['set_property', 'play-direction', 'forward'],
    ]);
  });

  it('連續精準定位直接改 time-pos，避免 seek 指令延後最新逐格目標', async () => {
    const { host, sockets } = make();
    await host.launch({ src: 'D:/media/a.mxf', bounds: { x: 0, y: 0, w: 100, h: 50 } });
    sockets[0].write.mockClear();

    host.seek(10);
    host.seek(10 + 1 / 25);
    host.seek(10 + 2 / 25);

    const commands = sockets[0].write.mock.calls.map(([raw]) => JSON.parse(raw).command);
    expect(commands).toEqual([
      ['set_property', 'time-pos', 10],
      ['set_property', 'time-pos', 10.04],
      ['set_property', 'time-pos', 10.08],
    ]);
  });

  it('launch owns both native windows, embeds mpv, connects the pipe, and cleans all resources on quit', async () => {
    const { host, children, sockets } = make();

    await expect(host.launch({ src: 'D:/media/source.mxf', bounds: { x: 10, y: 20, w: 320, h: 180 }, audio: [{}, {}] }))
      .resolves.toEqual({ ok: true, duration: 123.5 });

    const [hostWindow, guideWindow] = FakeWindow.instances;
    expect(hostWindow.setBounds).toHaveBeenCalledWith({ x: 110, y: 220, width: 320, height: 180 });
    expect(guideWindow.setBounds).toHaveBeenCalledWith({ x: 110, y: 220, width: 320, height: 180 });
    expect(hostWindow.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });
    expect(guideWindow.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });
    expect(children[0].exe).toBe('C:/bundle/mpv.exe');
    expect(children[0].args).toEqual(expect.arrayContaining([
      '--wid=4660', '--sub-fonts-dir=C:/fonts', '--', 'D:/media/source.mxf',
      '--lavfi-complex=[aid1][aid2]amix=inputs=2:normalize=0[ao]',
    ]));
    expect(sockets[0].write).toHaveBeenCalledWith(expect.stringContaining('observe_property'));
    expect(host.snapshot()).toMatchObject({ hasHostWindow: true, hasGuideWindow: true, hasClient: true, hasProcess: true });

    host.quit();

    expect(children[0].child.kill).toHaveBeenCalledTimes(1);
    expect(sockets[0].destroy).toHaveBeenCalledTimes(1);
    expect(hostWindow.destroy).toHaveBeenCalledTimes(1);
    expect(guideWindow.destroy).toHaveBeenCalledTimes(1);
    expect(host.snapshot()).toMatchObject({ hasHostWindow: false, hasGuideWindow: false, hasClient: false, hasProcess: false });
  });

  it('replacing media tears down the old process and pipe before creating the next host', async () => {
    const { host, children, sockets } = make();

    await host.launch({ src: 'D:/media/a.mxf', bounds: { x: 0, y: 0, w: 100, h: 50 } });
    const oldWindows = [...FakeWindow.instances];
    await host.launch({ src: 'D:/media/b.mxf', bounds: { x: 2, y: 3, w: 100, h: 50 } });

    expect(children).toHaveLength(2);
    expect(children[0].child.kill).toHaveBeenCalledTimes(1);
    expect(sockets[0].destroy).toHaveBeenCalledTimes(1);
    expect(oldWindows.every(window => window.destroyed)).toBe(true);
    expect(host.snapshot()).toMatchObject({ hasHostWindow: true, hasClient: true, hasProcess: true });
  });

  it('mpv 異常結束時也收掉 pipe 與兩個透明視窗，不能留下空白 native overlay', async () => {
    const { host, children, sockets, events } = make();

    await host.launch({ src: 'D:/media/a.mxf', bounds: { x: 0, y: 0, w: 100, h: 50 } });
    const [hostWindow, guideWindow] = FakeWindow.instances;
    children[0].child.emit('close', 1);

    expect(sockets[0].destroy).toHaveBeenCalledTimes(1);
    expect(hostWindow.destroy).toHaveBeenCalledTimes(1);
    expect(guideWindow.destroy).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ event: 'disconnected' });
    expect(host.snapshot()).toMatchObject({ hasHostWindow: false, hasGuideWindow: false, hasClient: false, hasProcess: false });
  });

  it('guide 永久穿透；它只顯示 overlay，圖片指標保留給主 renderer', async () => {
    const { host } = make();
    await host.launch({ src: 'D:/media/a.mxf', bounds: { x: 0, y: 0, w: 100, h: 50 } });
    const guideWindow = FakeWindow.instances[1];

    host.setImageGuide({ html: '<div class="img-wrap selected"></div>', rect: { x: 0, y: 0, w: 100, h: 50 } });

    expect(guideWindow.setIgnoreMouseEvents).toHaveBeenCalledTimes(1);
    expect(guideWindow.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });
    expect(guideWindow.webContents.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('window.setImages'), true);
  });
});
