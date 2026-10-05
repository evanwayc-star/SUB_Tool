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
  let loadedPath = null;
  socket.write = vi.fn(raw => {
    const message = JSON.parse(raw);
    if (message.command?.[0] === 'loadfile') {
      loadedPath = message.command[1];
      queueMicrotask(() => socket.emit('data', Buffer.from('{"event":"file-loaded"}\n')));
    }
    if (typeof message.request_id !== 'number') return;
    const data = message.command?.[1] === 'path' ? loadedPath : duration;
    queueMicrotask(() => socket.emit('data', Buffer.from(JSON.stringify({ request_id: message.request_id, data }) + '\n')));
  });
  return socket;
}

function make({ duration = 123.5, guideLoad, setTimer = () => 0 } = {}) {
  FakeWindow.instances = [];
  const parent = { isDestroyed: () => false, getContentBounds: () => ({ x: 100, y: 200 }) };
  const children = [];
  const sockets = [];
  const events = [];
  const delays = [];
  const host = createMpvHost({
    BrowserWindow: guideLoad ? class extends FakeWindow {
      constructor(options) {
        super(options);
        this.loadURL = vi.fn(url => url.startsWith('file:') ? guideLoad() : Promise.resolve());
      }
    } : FakeWindow,
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
    delay: async ms => { delays.push(ms); },
    setTimer,
    clearTimer: vi.fn(),
  });
  return { host, parent, children, sockets, events, delays };
}

describe('Windows mpv host lifecycle', () => {
  it('截圖等待 matching acknowledgement，錯誤回覆不冒充成功', async () => {
    const { host, sockets } = make();
    await host.launch({ src: 'D:/media/a.mxf' });
    const socket = sockets[0];
    socket.write.mockClear();
    socket.write.mockImplementation(() => {});
    let settled = false;
    const screenshot = host.screenshot('D:/out/Shot-001.jpg');
    screenshot.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    const message = JSON.parse(socket.write.mock.calls[0][0]);
    expect(message.request_id).toEqual(expect.any(Number));
    socket.emit('data', Buffer.from(JSON.stringify({ request_id: message.request_id + 1, error: 'success' }) + '\n'));
    await Promise.resolve();
    expect(settled).toBe(false);
    socket.emit('data', Buffer.from(JSON.stringify({ request_id: message.request_id, error: 'success' }) + '\n'));
    await expect(screenshot).resolves.toEqual({ ok: true });
    const failed = host.screenshot('D:/out/Shot-002.jpg');
    const rejection = expect(failed).rejects.toThrow('writing-error');
    const second = JSON.parse(socket.write.mock.calls[1][0]);
    socket.emit('data', Buffer.from(JSON.stringify({ request_id: second.request_id, error: 'writing-error' }) + '\n'));
    await rejection;
    host.quit();
  });

  it('pipe 失敗、斷線、逾時均讓截圖失敗，不能 fulfilled(null)', async () => {
    const timers = [];
    const { host, sockets } = make({ setTimer: fn => { timers.push(fn); return timers.length; } });
    await host.launch({ src: 'D:/media/a.mxf' });
    const socket = sockets[0];
    socket.write.mockImplementation(() => { throw new Error('pipe write failed'); });
    await expect(host.screenshot('D:/out/a.jpg')).rejects.toThrow('pipe write failed');
    socket.write.mockImplementation(() => {});
    const timed = host.screenshot('D:/out/b.jpg');
    const timeout = expect(timed).rejects.toThrow('逾時');
    timers.at(-1)();
    await timeout;
    const pending = host.screenshot('D:/out/c.jpg');
    const disconnected = expect(pending).rejects.toThrow('中斷');
    socket.emit('close');
    await disconnected;
    await expect(host.screenshot('D:/out/d.jpg')).rejects.toThrow('尚未連線');
    host.quit();
  });

  it('舊來源的 file-loaded 不能完成新換檔，只有 path 確認後才回報 duration', async () => {
    const { host, sockets } = make();
    await host.launch({ src: 'D:/media/initial.mxf' });
    const socket = sockets[0];
    let loadedPath = 'D:/media/a.mxf';
    socket.write.mockImplementation(raw => {
      const message = JSON.parse(raw);
      if (typeof message.request_id !== 'number') return;
      const data = message.command[1] === 'path' ? loadedPath : 200;
      queueMicrotask(() => socket.emit('data', Buffer.from(JSON.stringify({ request_id: message.request_id, data }) + '\n')));
    });
    const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
    const old = host.loadFile('D:/media/a.mxf');
    await flush();
    const latest = host.loadFile('D:/media/b.mxf');
    let latestSettled = false;
    latest.then(() => { latestSettled = true; });
    await flush();
    await expect(old).resolves.toEqual({ ok: false, duration: 0 });
    socket.emit('data', Buffer.from('{"event":"file-loaded"}\n'));
    await flush();
    expect(latestSettled).toBe(false);
    loadedPath = 'D:\\media\\b.mxf';
    socket.emit('data', Buffer.from('{"event":"file-loaded"}\n'));
    await expect(latest).resolves.toEqual({ ok: true, duration: 200 });
    host.quit();
  });

  it('換檔 pause await 期間 quit/relaunch，舊 request 不會寫入新 pipe', async () => {
    const { host, sockets } = make();
    await host.launch({ src: 'D:/media/initial.mxf' });
    const old = host.loadFile('D:/media/obsolete.mxf');
    host.quit();
    await host.launch({ src: 'D:/media/latest.mxf' });
    await expect(old).resolves.toEqual({ ok: false, duration: 0 });
    const commands = sockets[1].write.mock.calls.map(([raw]) => JSON.parse(raw).command);
    expect(commands.some(command => command[0] === 'loadfile')).toBe(false);
    host.quit();
  });

  it('被新來源取代的 guide 載入完成後不可再啟動舊 mpv 或覆寫新宿主', async () => {
    let finishOldGuide;
    const oldGuide = new Promise(resolve => { finishOldGuide = resolve; });
    const guideLoad = vi.fn().mockReturnValueOnce(oldGuide).mockResolvedValue(undefined);
    const { host, children } = make({ guideLoad });
    const oldLaunch = host.launch({ src: 'D:/media/old.mxf' });
    const oldResult = expect(oldLaunch).rejects.toThrow('mpv 啟動已被新的媒體取代');
    await host.launch({ src: 'D:/media/new.mxf' });
    finishOldGuide();
    await oldResult;

    expect(children).toHaveLength(1);
    expect(children[0].args.at(-1)).toBe('D:/media/new.mxf');
    expect(children[0].child.kill).not.toHaveBeenCalled();
  });

  it('啟動與換檔在來源就緒時立即回傳，不固定等待 400ms 或反覆查 duration', async () => {
    const { host, sockets, delays } = make();
    await expect(host.launch({ src: 'D:/media/a.mxf', bounds: { x: 0, y: 0, w: 100, h: 50 } }))
      .resolves.toEqual({ ok: true, duration: 123.5 });
    expect(delays).toEqual([]);

    sockets[0].write.mockClear();
    await expect(host.loadFile('D:/media/b.mxf')).resolves.toEqual({ ok: true, duration: 123.5 });
    const commands = sockets[0].write.mock.calls.map(([raw]) => JSON.parse(raw).command);
    expect(commands.filter(command => command[0] === 'get_property')).toEqual([
      ['get_property', 'path'],
      ['get_property', 'duration'],
    ]);
    expect(delays).toEqual([]);
  });

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

  it('同一毫秒快速換片仍使用不同的 pipe 與字幕檔，避免連到尚未退出的舊 mpv', async () => {
    const { host, children, sockets } = make();
    await host.launch({ src: 'D:/media/a.mxf' });
    host.setSubtitles('[Script Info]\nTitle: A');

    await host.launch({ src: 'D:/media/b.mxf' });
    host.setSubtitles('[Script Info]\nTitle: B');

    const pipeOf = launch => launch.args.find(arg => arg.startsWith('--input-ipc-server='));
    const subtitleOf = socket => socket.write.mock.calls
      .map(([raw]) => JSON.parse(raw).command)
      .find(command => command?.[0] === 'sub-add')?.[1];
    expect(pipeOf(children[0])).toBeTruthy();
    expect(pipeOf(children[1])).not.toBe(pipeOf(children[0]));
    expect(subtitleOf(sockets[0])).toBeTruthy();
    expect(subtitleOf(sockets[1])).not.toBe(subtitleOf(sockets[0]));
  });

  it('同一 mpv 程序換來源時取消舊畫格請求，不讓新檔 time-pos 完成舊請求', async () => {
    const { host, sockets } = make();
    await host.launch({ src: 'D:/media/a.mxf' });
    const oldPresentation = host.present(10, { exact: true, tolerance: 0.01 });

    await expect(host.loadFile('D:/media/b.mxf')).resolves.toMatchObject({ ok: true });
    sockets[0].emit('data', Buffer.from(JSON.stringify({
      event: 'property-change', name: 'time-pos', data: 10,
    }) + '\n'));
    await expect(oldPresentation).resolves.toBeNull();
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
