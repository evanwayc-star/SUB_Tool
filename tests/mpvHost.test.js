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
  it('原生倒播先切軟解與反向佇列，恢復正播時明確寫回 forward 與 auto hwdec', async () => {
    const { host, sockets } = make();
    await host.launch({ src: 'D:/media/a.mxf', bounds: { x: 0, y: 0, w: 100, h: 50 } });
    sockets[0].write.mockClear();

    await host.direction('backward');
    await host.direction('forward');

    const commands = sockets[0].write.mock.calls.map(([raw]) => JSON.parse(raw).command);
    expect(commands).toEqual([
      ['set_property', 'hwdec', 'no'],
      ['set_property', 'play-direction', 'backward'],
      ['set_property', 'play-direction', 'forward'],
      ['set_property', 'hwdec', 'auto'],
    ]);
  });

  it('尚未完成的倒播切換被 forward 取代後，不會晚到再寫回 backward', async () => {
    const { host, sockets } = make();
    await host.launch({ src: 'D:/media/a.mxf', bounds: { x: 0, y: 0, w: 100, h: 50 } });
    sockets[0].write.mockClear();

    const backward = host.direction('backward');
    const forward = host.direction('forward');
    await expect(backward).resolves.toBe(false);
    await expect(forward).resolves.toBe(true);

    const commands = sockets[0].write.mock.calls.map(([raw]) => JSON.parse(raw).command);
    expect(commands).toEqual([
      ['set_property', 'hwdec', 'no'],
      ['set_property', 'play-direction', 'forward'],
      ['set_property', 'hwdec', 'auto'],
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

  it('暫停中的 present 在指令確認且 time-pos 到達後回報實際畫格，不等待播放重啟', async () => {
    const { host, sockets } = make();
    await host.launch({ src: 'D:/media/a.mxf', bounds: { x: 0, y: 0, w: 100, h: 50 } });
    const socket = sockets[0];
    socket.write.mockClear();
    socket.emit('data', Buffer.from(JSON.stringify({
      event: 'property-change', name: 'pause', data: true,
    }) + '\n'));

    const pending = host.present(10, { exact: true, tolerance: 0.05 });
    await Promise.resolve();
    socket.emit('data', Buffer.from(JSON.stringify({
      event: 'property-change', name: 'time-pos', data: 9.98,
    }) + '\n'));

    await expect(pending).resolves.toEqual({ backend: 'mpv', presentedSourceTime: 9.98 });
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('absolute+exact'));
  });

  it('暫停中定位到已在顯示的同一格時，主動查詢 time-pos，避免沒有 property-change 而卡住後續請求', async () => {
    const { host, sockets } = make();
    await host.launch({ src: 'D:/media/a.mxf', bounds: { x: 0, y: 0, w: 100, h: 50 } });
    const socket = sockets[0];
    socket.write.mockClear();
    socket.write.mockImplementation(raw => {
      const message = JSON.parse(raw);
      if (typeof message.request_id !== 'number') return;
      const isTimePositionQuery = message.command?.[0] === 'get_property' && message.command?.[1] === 'time-pos';
      queueMicrotask(() => socket.emit('data', Buffer.from(JSON.stringify({
        request_id: message.request_id,
        data: isTimePositionQuery ? 10 : null,
      }) + '\n')));
    });

    const pending = host.present(10, { exact: true, tolerance: 0.05 });
    const result = await Promise.race([
      pending,
      new Promise(resolve => setTimeout(() => resolve('still-pending'), 20)),
    ]);

    expect(result).toEqual({ backend: 'mpv', presentedSourceTime: 10 });
    const commands = socket.write.mock.calls.map(([raw]) => JSON.parse(raw).command);
    expect(commands).toContainEqual(['get_property', 'time-pos']);
  });

  it('播放中的 present 仍等到 seek 後的 time-pos 與 playback-restart 才回報實際畫格', async () => {
    const { host, sockets, events } = make();
    await host.launch({ src: 'D:/media/a.mxf', bounds: { x: 0, y: 0, w: 100, h: 50 } });
    const socket = sockets[0];
    socket.write.mockClear();
    socket.emit('data', Buffer.from(JSON.stringify({
      event: 'property-change', name: 'pause', data: false,
    }) + '\n'));

    const pending = host.present(10, { exact: true, tolerance: 0.05 });
    await Promise.resolve();
    socket.emit('data', Buffer.from(JSON.stringify({
      event: 'property-change', name: 'time-pos', data: 9.98,
    }) + '\n'));

    let settled = false;
    pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    socket.emit('data', Buffer.from(JSON.stringify({ event: 'playback-restart' }) + '\n'));
    await expect(pending).resolves.toEqual({ backend: 'mpv', presentedSourceTime: 9.98 });
    expect(events).toContainEqual({ event: 'playback-restart' });
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('absolute+exact'));
  });

  it('只觀測內附 mpv 實際提供的 time-pos，不註冊不存在的 video-pts', async () => {
    const { host, sockets } = make();
    await host.launch({ src: 'D:/media/a.mxf', bounds: { x: 0, y: 0, w: 100, h: 50 } });

    const observed = sockets[0].write.mock.calls
      .map(([raw]) => JSON.parse(raw).command)
      .filter(command => command?.[0] === 'observe_property');
    expect(observed).toContainEqual(['observe_property', 1, 'time-pos']);
    expect(observed.some(command => command[2] === 'video-pts')).toBe(false);
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
      '--cache=yes', '--vd-queue-enable=yes',
      '--demuxer-max-bytes=256MiB', '--demuxer-max-back-bytes=192MiB',
      '--demuxer-backward-playback-step=10',
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

  it('播放中呼叫 pause 後立即 present，能以暫停呈現完成，不等待永遠不會發生的 playback-restart', async () => {
    const { host, sockets } = make();
    await host.launch({ src: 'D:/media/a.mxf', bounds: { x: 0, y: 0, w: 100, h: 50 } });
    const socket = sockets[0];
    socket.write.mockClear();

    // 模擬播放狀態中
    socket.emit('data', Buffer.from(JSON.stringify({
      event: 'property-change', name: 'pause', data: false,
    }) + '\n'));

    // 播放中按往後一格：先 pause()，緊接著 present()
    host.pause();
    const pending = host.present(9.96, { exact: true, tolerance: 0.05 });

    // socket 收到 seek 指令並確認，且回報 time-pos
    await Promise.resolve();
    socket.emit('data', Buffer.from(JSON.stringify({
      event: 'property-change', name: 'time-pos', data: 9.96,
    }) + '\n'));

    // 應順利完成，不被播放狀態的 restarted 阻擋
    await expect(pending).resolves.toEqual({ backend: 'mpv', presentedSourceTime: 9.96 });
  });
});
