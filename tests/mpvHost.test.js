import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
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

function socketThatReportsDuration(duration = 123.5, { loadEvents = true } = {}) {
  const socket = new EventEmitter();
  socket.destroy = vi.fn(() => socket.emit('close'));
  let loadedPath = null;
  socket.write = vi.fn(raw => {
    const message = JSON.parse(raw);
    if (message.command?.[0] === 'loadfile') {
      loadedPath = message.command[1];
      // Native loading can complete before the loadfile command reply arrives.
      if (loadEvents) queueMicrotask(() => socket.emit('data', Buffer.from(
        '{"event":"file-loaded"}\n{"event":"playback-restart"}\n',
      )));
    }
    if (typeof message.request_id !== 'number') return;
    const data = message.command?.[1] === 'path' ? loadedPath
      : message.command?.[1] === 'time-pos' ? 0 : duration;
    queueMicrotask(() => socket.emit('data', Buffer.from(JSON.stringify({ request_id: message.request_id, data, error: 'success' }) + '\n')));
  });
  return socket;
}

function make({ duration = 123.5, guideLoad, setTimer = () => 0, createLog, spawnFailure, describeSource, socketFactory } = {}) {
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
      if (spawnFailure) throw spawnFailure;
      const child = new EventEmitter();
      child.kill = vi.fn();
      child.stderr = createLog ? new PassThrough() : null;
      children.push({ child, exe, args });
      return child;
    }),
    createConnection: vi.fn(() => {
      const socket = socketFactory ? socketFactory() : socketThatReportsDuration(duration);
      sockets.push(socket);
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    }),
    fs: { writeFileSync: vi.fn(), createWriteStream: createLog || vi.fn(() => null) },
    path: { join: (...parts) => parts.join('/') },
    url: { pathToFileURL: filePath => ({ href: 'file:///' + filePath }) },
    getMainWindow: () => parent,
    supported: () => true,
    findExecutable: vi.fn(() => 'C:/bundle/mpv.exe'),
    ensureTmp: vi.fn(),
    tmpDir: 'C:/tmp',
    tempFiles: new Set(),
    guideHtml: '<!doctype html>',
    describeSource,
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
  it('mute 等到原生 mpv 的成功回覆才完成，失敗回覆會拒絕', async () => {
    const { host, sockets } = make();
    await host.launch({ src: 'D:/media/initial.mxf' });
    try {
      const socket = sockets[0];
      const originalWrite = socket.write;
      const pending = [];
      socket.write = vi.fn(raw => {
        const message = JSON.parse(raw);
        if (message.command?.[0] === 'set_property' && message.command?.[1] === 'mute') pending.push(message);
        else originalWrite(raw);
      });
      let completed = false;
      const muted = host.mute(true).then(() => { completed = true; });
      await Promise.resolve();
      expect(completed).toBe(false);
      expect(pending[0]).toMatchObject({ command: ['set_property', 'mute', true], request_id: expect.any(Number) });
      socket.emit('data', Buffer.from(JSON.stringify({ request_id: pending[0].request_id, error: 'success' }) + '\n'));
      await muted;
      expect(completed).toBe(true);
      const rejected = host.mute(true);
      socket.emit('data', Buffer.from(JSON.stringify({ request_id: pending[1].request_id, error: 'property unavailable' }) + '\n'));
      await expect(rejected).rejects.toThrow('property unavailable');
    } finally { host.quit(); }
  });
  it('pipe 的 UTF-8 字元跨 byte 分塊時，事件內容仍保持完整', async () => {
    const { host, sockets, events } = make();
    await host.launch({ src: 'D:/media/initial.mxf' });
    try {
      const message = { event: 'property-change', name: 'media-title', data: '中文素材 🎬' };
      const bytes = Buffer.from(JSON.stringify(message) + '\n');
      for (const byte of bytes) sockets[0].emit('data', Buffer.from([byte]));
      expect(events.at(-1)).toEqual(message);
    } finally { host.quit(); }
  });

  it('中文來源的 path 回覆跨 UTF-8 分塊，仍能確認初始畫格已載入', async () => {
    const { host } = make({ socketFactory: () => {
      const socket = socketThatReportsDuration();
      const emit = socket.emit.bind(socket);
      socket.emit = (event, ...values) => {
        if (event !== 'data') return emit(event, ...values);
        for (const byte of values[0]) emit('data', Buffer.from([byte]));
        return true;
      };
      return socket;
    } });
    let loaded = false;
    const launch = host.launch({ src: 'D:/媒體/中文素材.mxf' }).then(result => {
      loaded = true;
      return result;
    });
    try {
      for (let index = 0; index < 50; index++) await Promise.resolve();
      expect(loaded).toBe(true);
      await expect(launch).resolves.toEqual({ ok: true, duration: 123.5 });
    } finally { host.quit(); await launch.catch(() => {}); }
  });

  it('換連線丟棄舊 JSON 與半個 UTF-8 字元，舊 pipe 尾段不能污染新來源', async () => {
    const { host, sockets, events } = make();
    await host.launch({ src: 'D:/media/initial.mxf' });
    const oldMessage = Buffer.from(JSON.stringify({ event: 'property-change', name: 'media-title', data: '舊來源' }) + '\n');
    const split = oldMessage.indexOf(Buffer.from('舊')) + 1;
    sockets[0].emit('data', oldMessage.subarray(0, split));
    await host.launch({ src: 'D:/media/latest.mxf' });
    try {
      sockets[0].emit('data', oldMessage.subarray(split));
      const message = { event: 'property-change', name: 'media-title', data: '新來源' };
      sockets[1].emit('data', Buffer.from(JSON.stringify(message) + '\n'));
      expect(events.at(-1)).toEqual(message);
      expect(events).not.toContainEqual({ event: 'property-change', name: 'media-title', data: '舊來源' });
    } finally { host.quit(); }
  });

  it.each([2, 8])('倒播暫停 %i 路 native 混音，正播精確恢復原圖並可再次倒播', async count => {
    const {host,sockets,children}=make();
    await host.launch({src:'D:/media/multi.mxf',audio:Array.from({length:count},()=>({}))});
    const graph=children[0].args.find(arg=>arg.startsWith('--lavfi-complex=')).slice('--lavfi-complex='.length);
    const initialCommands = sockets[0].write.mock.calls.map(([raw]) => JSON.parse(raw).command);
    expect(initialCommands).toContainEqual(['loadfile', 'D:/media/multi.mxf', 'replace']);
    expect(initialCommands).not.toContainEqual(['set_property', 'lavfi-complex', '']);
    let liveGraph=graph;
    const socket=sockets[0],write=socket.write.getMockImplementation();
    socket.write.mockImplementation(raw=>{
      const command=JSON.parse(raw).command;
      if(command[0]==='set_property'&&command[1]==='lavfi-complex')liveGraph=command[2];
      write(raw);
    });
    try{
      for(let round=0;round<3;round++){
        await expect(host.direction('backward')).resolves.toBe(true);
        expect(liveGraph).toBe('');
        await expect(host.direction('forward')).resolves.toBe(true);
        expect(liveGraph).toBe(graph);
      }
    }finally{host.quit();}
  });

  it('倒播期間換來源後，forward 不得恢復舊來源的 native 混音圖',async()=>{
    const {host,sockets}=make();
    await host.launch({src:'D:/media/multi.mxf',audio:[{},{},{}]});
    await host.direction('backward');
    await host.loadFile('D:/media/new-single.mov');
    sockets[0].write.mockClear();
    await host.direction('forward');
    expect(sockets[0].write.mock.calls.map(([raw])=>JSON.parse(raw).command)
      .filter(command=>command[1]==='lavfi-complex').every(command=>command[2]==='')).toBe(true);
    host.quit();
  });

  it('loadFile probe 開始即撤銷舊方向；失敗後仍可還原尚未換掉的來源混音',async()=>{
    let rejectProbe;
    const probe=new Promise((resolve,reject)=>{rejectProbe=reject;});
    const {host,sockets}=make({describeSource:file=>file.includes('bad')?probe:Promise.resolve(null)});
    await host.launch({src:'D:/media/multi.mxf',audio:[{},{}]});
    await host.direction('backward');
    const changing=host.loadFile('D:/media/bad.mov');
    const failed=expect(changing).rejects.toThrow('probe unavailable');
    await expect(host.direction('forward')).resolves.toBe(false);
    rejectProbe(new Error('probe unavailable'));await failed;
    await expect(host.direction('forward')).resolves.toBe(true);
    expect(sockets[0].write.mock.calls.map(([raw])=>JSON.parse(raw).command)).toContainEqual([
      'set_property','lavfi-complex','[aid1][aid2]amix=inputs=2:normalize=0[ao]',
    ]);
    host.quit();
  });

  it('換來源撤銷尚未完成的 backward，不讓舊方向落到新素材',async()=>{
    const {host,sockets}=make();await host.launch({src:'D:/media/multi.mxf',audio:[{},{}]});
    const socket=sockets[0],write=socket.write.getMockImplementation();let held;
    socket.write.mockImplementation(raw=>{
      const message=JSON.parse(raw);
      if(message.command[1]==='hwdec'&&message.command[2]==='no'){held=message;return;}
      write(raw);
    });
    const backward=host.direction('backward');
    for(let index=0;index<10&&!held;index++)await Promise.resolve();
    expect(held).toBeTruthy();
    await host.loadFile('D:/media/new.mov');
    socket.emit('data',Buffer.from(JSON.stringify({request_id:held.request_id,error:'success'})+'\n'));
    await expect(backward).resolves.toBe(false);
    expect(socket.write.mock.calls.map(([raw])=>JSON.parse(raw).command)).not.toContainEqual([
      'set_property','play-direction','backward',
    ]);
    host.quit();
  });

  it('clear graph 晚到回覆不得覆寫更新的 forward；quit/relaunch 不可復活舊圖',async()=>{
    const {host,sockets}=make();await host.launch({src:'D:/media/multi.mxf',audio:[{},{}]});
    const socket=sockets[0],write=socket.write.getMockImplementation();let held;
    socket.write.mockImplementation(raw=>{
      const message=JSON.parse(raw);
      if(message.command[1]==='lavfi-complex'&&message.command[2]===''&&!held){held=message;return;}
      write(raw);
    });
    const backward=host.direction('backward');
    await Promise.resolve();
    const forward=host.direction('forward');await forward;
    expect(held).toBeTruthy();
    socket.emit('data',Buffer.from(JSON.stringify({request_id:held.request_id,error:'success'})+'\n'));
    await expect(backward).resolves.toBe(false);
    host.quit();await host.launch({src:'D:/media/single.mov'});
    sockets[1].write.mockClear();await host.direction('forward');
    expect(sockets[1].write.mock.calls.map(([raw])=>JSON.parse(raw).command)
      .filter(command=>command[1]==='lavfi-complex')).toEqual([]);
    host.quit();
  });

  it.each(['clear','restore'])('native 混音 %s 命令失敗不可宣稱方向已安全就緒',async phase=>{
    const {host,sockets}=make();await host.launch({src:'D:/media/multi.mxf',audio:[{},{}]});
    if(phase==='restore')await host.direction('backward');
    const socket=sockets[0],write=socket.write.getMockImplementation();
    socket.write.mockImplementation(raw=>{
      const message=JSON.parse(raw);
      if(message.command[1]==='lavfi-complex'&&(phase==='clear'?message.command[2]==='':message.command[2]!=='')){
        queueMicrotask(()=>socket.emit('data',Buffer.from(JSON.stringify({request_id:message.request_id,error:'property-unavailable'})+'\n')));return;
      }
      write(raw);
    });
    await expect(host.direction(phase==='clear'?'backward':'forward')).rejects.toThrow('property-unavailable');
    if(phase==='clear')expect(socket.write.mock.calls.map(([raw])=>JSON.parse(raw).command)).not.toContainEqual(['set_property','play-direction','backward']);
    host.quit();
  });

  it('forward 的混音還原回覆晚到時，新 backward 仍會清除已送出的圖',async()=>{
    const {host,sockets}=make();await host.launch({src:'D:/media/multi.mxf',audio:[{},{}]});
    await host.direction('backward');
    const socket=sockets[0],write=socket.write.getMockImplementation();let held,liveGraph='';
    socket.write.mockImplementation(raw=>{
      const message=JSON.parse(raw);
      if(message.command[1]==='lavfi-complex'){
        liveGraph=message.command[2];
        if(liveGraph&&!held){held=message;return;}
      }
      write(raw);
    });
    const forward=host.direction('forward');
    for(let index=0;index<10&&!held;index++)await Promise.resolve();
    expect(held).toBeTruthy();
    await expect(host.direction('backward')).resolves.toBe(true);
    expect(liveGraph).toBe('');
    socket.emit('data',Buffer.from(JSON.stringify({request_id:held.request_id,error:'success'})+'\n'));
    await expect(forward).resolves.toBe(false);
    expect(liveGraph).toBe('');host.quit();
  });

  it('倒播設定中途失敗會還原正向與原圖，不能只留下被清空的混音',async()=>{
    const {host,sockets,children}=make();await host.launch({src:'D:/media/multi.mxf',audio:[{},{}]});
    const graph=children[0].args.find(arg=>arg.startsWith('--lavfi-complex=')).slice('--lavfi-complex='.length);
    const socket=sockets[0],write=socket.write.getMockImplementation();let liveGraph=graph;
    socket.write.mockImplementation(raw=>{
      const message=JSON.parse(raw);
      if(message.command[1]==='lavfi-complex')liveGraph=message.command[2];
      if(message.command[1]==='hwdec'&&message.command[2]==='no'){
        queueMicrotask(()=>socket.emit('data',Buffer.from(JSON.stringify({request_id:message.request_id,error:'setting-failed'})+'\n')));return;
      }
      write(raw);
    });
    await expect(host.direction('backward')).rejects.toThrow('setting-failed');
    expect(liveGraph).toBe(graph);
    expect(socket.write.mock.calls.map(([raw])=>JSON.parse(raw).command)).toContainEqual(['set_property','play-direction','forward']);
    host.quit();
  });

  it('quit 取消 graph 清除等待，晚到回覆不能在新播放器恢復舊圖',async()=>{
    const {host,sockets}=make();await host.launch({src:'D:/media/multi.mxf',audio:[{},{}]});
    const socket=sockets[0],write=socket.write.getMockImplementation();let held;
    socket.write.mockImplementation(raw=>{
      const message=JSON.parse(raw);
      if(message.command[1]==='lavfi-complex'&&message.command[2]===''){held=message;return;}
      write(raw);
    });
    const backward=host.direction('backward');
    const cancelled=backward.then(value=>({value}),error=>({error}));
    await Promise.resolve();expect(held).toBeTruthy();
    host.quit();expect((await cancelled).error).toBeInstanceOf(Error);
    await host.launch({src:'D:/media/new-single.mov'});
    const before=sockets[1].write.mock.calls.length;
    socket.emit('data',Buffer.from(JSON.stringify({request_id:held.request_id,error:'success'})+'\n'));
    await Promise.resolve();expect(sockets[1].write.mock.calls.length).toBe(before);
    await host.direction('forward');
    expect(sockets[1].write.mock.calls.map(([raw])=>JSON.parse(raw).command)
      .filter(command=>command[1]==='lavfi-complex')).toEqual([]);host.quit();
  });


  it('mother clock owns duration, time-pos, seek acknowledgement and subtitle placement', async () => {
    const describeSource=vi.fn(async()=>({video:{timestampOffset:-.5}}));
    const {host,sockets,children,events}=make({duration:3.5,describeSource});
    await expect(host.launch({src:'D:/mother.mkv'})).resolves.toEqual({ok:true,duration:3});
    expect(describeSource).toHaveBeenCalledWith('D:/mother.mkv');
    expect(children[0].args).toContain('--sub-delay=0.5');
    const pending=host.present(2.8,{exact:true,tolerance:.000001});
    await Promise.resolve();
    const socket=sockets[0];
    socket.emit('data',Buffer.from(JSON.stringify({event:'property-change',name:'time-pos',data:3.3})+'\n'));
    await expect(pending).resolves.toEqual({backend:'mpv',presentedSourceTime:2.8});
    socket.emit('data',Buffer.from(JSON.stringify({event:'property-change',name:'duration',data:3.5})+'\n'));
    expect(events).toContainEqual({event:'property-change',name:'time-pos',data:2.8});
    expect(events).toContainEqual({event:'property-change',name:'duration',data:3});
    expect(socket.write.mock.calls.map(([raw])=>JSON.parse(raw).command)).toContainEqual(['seek',3.3,'absolute+exact']);
    host.quit();
  });
  it('loading a normalized Proxy and returning to the mother re-probes their actual clocks',async()=>{
    const describeSource=vi.fn(async file=>({video:{timestampOffset:file.includes('proxy')?0:-.5}}));
    const {host,sockets}=make({duration:3.5,describeSource});
    await host.launch({src:'D:/mother.mkv'});
    await host.loadFile('D:/proxy.mp4');await host.seek(2.8);
    const commands=()=>sockets[0].write.mock.calls.map(([raw])=>JSON.parse(raw).command);
    expect(commands()).toContainEqual(['set_property','sub-delay',0]);
    expect(commands()).toContainEqual(['set_property','time-pos',2.8]);
    await host.loadFile('D:/mother.mkv');await host.seek(2.8);
    expect(commands()).toContainEqual(['set_property','sub-delay',.5]);
    expect(commands()).toContainEqual(['set_property','time-pos',3.3]);
    expect(describeSource.mock.calls.map(([file])=>file)).toEqual(['D:/mother.mkv','D:/proxy.mp4','D:/mother.mkv']);
    host.quit();
  });

  it('非同步記錄失敗不能中斷播放器，且 stderr 繼續排空', async () => {
    const output = new PassThrough();
    const { host, children } = make({ createLog: () => output });
    await host.launch({ src: 'D:/media/a.mxf' });
    output.destroy(Object.assign(new Error('diagnostic disk full'), { code: 'ENOSPC' }));
    await new Promise(resolve => setImmediate(resolve));
    expect(host.snapshot()).toMatchObject({ hasClient: true, hasProcess: true });
    expect(children[0].child.kill).not.toHaveBeenCalled();
    children[0].child.stderr.write(Buffer.alloc(65536));
    await new Promise(resolve => setImmediate(resolve));
    expect(children[0].child.stderr.readableLength).toBe(0);
    host.quit();
  });

  it('換片和退出關閉各自記錄，舊 child 晚到的 close 不能關閉新記錄', async () => {
    const outputs = [new PassThrough(), new PassThrough()];
    let next = 0;
    const { host, children } = make({ createLog: () => outputs[next++] });
    await host.launch({ src: 'D:/media/a.mxf' });
    await host.launch({ src: 'D:/media/b.mxf' });
    expect(outputs[0].destroyed).toBe(true);
    children[0].child.emit('close', 0);
    expect(outputs[1].destroyed).toBe(false);
    host.quit();
    expect(outputs[1].destroyed).toBe(true);
  });

  it('spawn 同步失敗也關閉已開啟的記錄', async () => {
    const output = new PassThrough();
    const { host } = make({ createLog: () => output, spawnFailure: new Error('spawn failed') });
    await expect(host.launch({ src: 'D:/media/a.mxf' })).rejects.toThrow('spawn failed');
    expect(output.destroyed).toBe(true);
    expect(host.snapshot()).toMatchObject({ hasProcess: false, hasClient: false });
  });

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
    expect(commands.filter(command => command[0] === 'loadfile'))
      .toEqual([['loadfile', 'D:/media/latest.mxf', 'replace']]);
    host.quit();
  });

  it('被新來源取代的 guide 載入完成後不可再啟動舊 mpv 或覆寫新宿主', async () => {
    let finishOldGuide;
    const oldGuide = new Promise(resolve => { finishOldGuide = resolve; });
    const guideLoad = vi.fn().mockReturnValueOnce(oldGuide).mockResolvedValue(undefined);
    const { host, children, sockets } = make({ guideLoad });
    const oldLaunch = host.launch({ src: 'D:/media/old.mxf' });
    const oldResult = expect(oldLaunch).rejects.toThrow('mpv 啟動已被新的媒體取代');
    await host.launch({ src: 'D:/media/new.mxf' });
    finishOldGuide();
    await oldResult;

    expect(children).toHaveLength(1);
    expect(sockets[0].write.mock.calls.map(([raw]) => JSON.parse(raw).command))
      .toContainEqual(['loadfile', 'D:/media/new.mxf', 'replace']);
    expect(children[0].args).not.toContain('D:/media/old.mxf');
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

  it.each([
    ['file-loaded 尚未到達', false],
    ['file-loaded 已到達但首個 VO 畫格尚未就緒', true],
  ])('launch 不可在 %s、native 仍拒絕 seek 時宣告成功', async (_stage, announceFileLoaded) => {
    const socket = new EventEmitter();
    const source = 'D:/media/startup.mxf';
    const rejectedSeeks = [];
    let frameReady = false;
    let nativePosition = null;
    const emit = message => socket.emit('data', Buffer.from(JSON.stringify(message) + '\n'));
    socket.destroy = vi.fn(() => socket.emit('close'));
    socket.write = vi.fn(raw => {
      const { command, request_id } = JSON.parse(raw);
      let data = null;
      let error = 'success';
      if (command[0] === 'seek' || (command[0] === 'set_property' && command[1] === 'time-pos')) {
        if (!frameReady) {
          rejectedSeeks.push(command);
          error = 'property unavailable';
        } else nativePosition = command[0] === 'seek' ? command[1] : command[2];
      } else if (command[0] === 'get_property') {
        if (command[1] === 'duration') data = 123.5;
        if (command[1] === 'path') data = source;
        if (command[1] === 'time-pos') data = nativePosition;
      }
      if (typeof request_id === 'number') queueMicrotask(() => emit({ request_id, data, error }));
    });
    const { host } = make({ socketFactory: () => socket });
    let launchState = 'pending';
    const launching = host.launch({ src: source }).then(
      value => { launchState = 'ready'; return value; },
      error => { launchState = 'failed'; throw error; },
    );
    // Observe failure immediately as well, so cleanup cannot leave an unhandled rejection.
    void launching.catch(() => {});
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      if (announceFileLoaded) emit({ event: 'file-loaded' });
      await new Promise(resolve => setTimeout(resolve, 0));
      const prematurePresent = host.present(3, { exact: true, tolerance: 0.01 });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(rejectedSeeks).toContainEqual(['seek', 3, 'absolute+exact']);
      expect(nativePosition).toBeNull();
      expect(launchState).toBe('pending');

      frameReady = true;
      nativePosition = 0;
      if (!announceFileLoaded) emit({ event: 'file-loaded' });
      emit({ event: 'property-change', name: 'time-pos', data: 0 });
      emit({ event: 'playback-restart' });
      await expect(launching).resolves.toMatchObject({ ok: true });
      host.cancelPresent();
      await prematurePresent;
    } finally {
      host.quit();
      await launching.catch(() => {});
    }
  });

  it('初始首格期限到仍未就緒會失敗並清掉 child、pipe 與宿主', async () => {
    const timers = [];
    const { host, children, sockets } = make({
      socketFactory: () => socketThatReportsDuration(123.5, { loadEvents: false }),
      setTimer: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; },
    });
    const launching = host.launch({ src: 'D:/media/never-ready.mxf' });
    const failure = expect(launching).rejects.toThrow(/初始畫格.*就緒/);
    await new Promise(resolve => setTimeout(resolve, 0));
    const readinessTimeout = timers.find(timer => timer.ms === 15000);
    expect(readinessTimeout).toBeDefined();
    readinessTimeout.callback();
    await failure;
    expect(children[0].child.kill).toHaveBeenCalledOnce();
    expect(sockets[0].destroy).toHaveBeenCalledOnce();
    expect(FakeWindow.instances.every(window => window.destroyed)).toBe(true);
    expect(host.snapshot()).toMatchObject({ hasClient: false, hasProcess: false, hasHostWindow: false });
  });

  it.each([
    ['null clock', null, 'success'],
    ['failed clock read', 7, 'property unavailable'],
  ])('初始 restart 後仍須有效來源時鐘，%s 不可冒充首格', async (_name, data, error) => {
    const socket = socketThatReportsDuration();
    const write = socket.write.getMockImplementation();
    socket.write.mockImplementation(raw => {
      const message = JSON.parse(raw);
      if (message.command[0] !== 'get_property' || message.command[1] !== 'time-pos') return write(raw);
      queueMicrotask(() => socket.emit('data', Buffer.from(JSON.stringify({
        request_id: message.request_id, data, error,
      }) + '\n')));
    });
    const { host, children } = make({ socketFactory: () => socket });
    await expect(host.launch({ src: 'D:/media/bad-clock.mxf' })).rejects.toThrow(/初始畫格.*就緒/);
    expect(children[0].child.kill).toHaveBeenCalledOnce();
    expect(host.snapshot()).toMatchObject({ hasClient: false, hasProcess: false });
  });

  it.each(['quit', 'relaunch'])('初始首格等待可被 %s 撤銷，舊事件不能完成或破壞新宿主', async action => {
    let connections = 0;
    const { host, sockets, children } = make({ socketFactory: () =>
      socketThatReportsDuration(123.5, { loadEvents: connections++ > 0 }),
    });
    const old = host.launch({ src: 'D:/media/old.mxf' });
    const cancelled = expect(old).rejects.toThrow(/取代|中斷/);
    await new Promise(resolve => setTimeout(resolve, 0));
    if (action === 'quit') host.quit();
    else await expect(host.launch({ src: 'D:/media/new.mxf' })).resolves.toMatchObject({ ok: true });
    await cancelled;
    sockets[0].emit('data', Buffer.from('{"event":"file-loaded"}\n{"event":"playback-restart"}\n'));
    if (action === 'relaunch') {
      expect(children[1].child.kill).not.toHaveBeenCalled();
      expect(host.snapshot()).toMatchObject({ hasClient: true, hasProcess: true, hasHostWindow: true });
    }
    host.quit();
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

  it.each([
    ['native error', false],
    ['command timeout', false],
    ['success with null data', true],
  ])('present 的 %s 回覆須正確判定 ACK，即使舊 time-pos 已等於目標', async (reply, accepted) => {
    const timers = [];
    const { host, sockets } = make({ setTimer: (callback, ms) => {
      const timer = { callback, ms };
      timers.push(timer);
      return timer;
    } });
    await host.launch({ src: 'D:/media/a.mxf' });
    const socket = sockets[0];
    socket.write.mockImplementation(raw => {
      const message = JSON.parse(raw);
      if (typeof message.request_id !== 'number') return;
      const isSeek = message.command[0] === 'seek';
      if (isSeek && reply === 'command timeout') return;
      // This is the unchanged native position, not a value copied from the rejected seek.
      const data = message.command[0] === 'get_property' && message.command[1] === 'time-pos' ? 7 : null;
      const error = isSeek && reply === 'native error' ? 'property unavailable' : 'success';
      queueMicrotask(() => socket.emit('data', Buffer.from(JSON.stringify({
        request_id: message.request_id, data, error,
      }) + '\n')));
    });
    const timerStart = timers.length;
    let result;
    const pending = host.present(7, { exact: true, tolerance: 0.01 });
    void pending.then(value => { result = value; }, () => {});
    try {
      if (reply === 'command timeout') {
        const seekTimeout = timers.slice(timerStart).find(timer => timer.ms === 5000);
        expect(seekTimeout).toBeDefined();
        seekTimeout.callback();
      }
      await new Promise(resolve => setTimeout(resolve, 0));
      if (accepted) expect(result).toEqual({ backend: 'mpv', presentedSourceTime: 7 });
      else expect(result?.backend).not.toBe('mpv');
    } finally {
      host.cancelPresent();
      host.quit();
      await pending.catch(() => {});
    }
  });

  it('null time-pos 事件與讀回都不代表第零格，直到 native 回報有效零秒才完成', async () => {
    const { host, sockets } = make();
    await host.launch({ src: 'D:/media/a.mxf' });
    const socket = sockets[0];
    socket.write.mockImplementation(raw => {
      const { request_id } = JSON.parse(raw);
      if (typeof request_id !== 'number') return;
      queueMicrotask(() => socket.emit('data', Buffer.from(JSON.stringify({
        request_id, data: null, error: 'success',
      }) + '\n')));
    });
    let result;
    const pending = host.present(0, { exact: true, tolerance: 0.01 });
    void pending.then(value => { result = value; });
    try {
      socket.emit('data', Buffer.from('{"event":"property-change","name":"time-pos","data":null}\n'));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(result).toBeUndefined();
      socket.emit('data', Buffer.from('{"event":"property-change","name":"time-pos","data":0}\n'));
      await expect(pending).resolves.toEqual({ backend: 'mpv', presentedSourceTime: 0 });
    } finally { host.quit(); }
  });

  it('capture waits for native restart and reads actual time after the seek, even while paused', async () => {
    const { host, sockets } = make();
    await host.launch({ src: 'D:/media/a.mxf', bounds: { x: 0, y: 0, w: 100, h: 50 } });
    const socket=sockets[0];let restarted=false;
    socket.write.mockImplementation(raw=>{
      const message=JSON.parse(raw);
      if(typeof message.request_id!=='number')return;
      queueMicrotask(()=>socket.emit('data',Buffer.from(JSON.stringify({
        request_id:message.request_id,
        data:message.command?.[0]==='get_property'?(restarted?10.001:10):null,
        error:'success',
      })+'\n')));
    });
    const pending=host.present(10,{tolerance:.015,waitForFrame:true});
    let settled=false;pending.then(()=>{settled=true;});
    socket.emit('data',Buffer.from(JSON.stringify({event:'property-change',name:'time-pos',data:10})+'\n'));
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(settled).toBe(false);
    restarted=true;
    socket.emit('data',Buffer.from(JSON.stringify({event:'playback-restart'})+'\n'));
    await expect(pending).resolves.toEqual({backend:'mpv',presentedSourceTime:10.001});
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
        error: 'success',
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
      '--wid=4660', '--sub-fonts-dir=C:/fonts', '--idle=yes', '--pause',
      '--lavfi-complex=[aid1][aid2]amix=inputs=2:normalize=0[ao]',
      '--cache=yes', '--vd-queue-enable=yes',
      '--demuxer-max-bytes=256MiB', '--demuxer-max-back-bytes=192MiB',
      '--demuxer-backward-playback-step=10',
    ]));
    expect(children[0].args).not.toContain('D:/media/source.mxf');
    expect(sockets[0].write.mock.calls.map(([raw]) => JSON.parse(raw).command))
      .toContainEqual(['loadfile', 'D:/media/source.mxf', 'replace']);
    expect(sockets[0].write.mock.calls.map(([raw]) => JSON.parse(raw).command))
      .not.toContainEqual(['set_property', 'pause', false]);
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
