// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

const ui=vi.hoisted(()=>({setStatus:vi.fn(),showToast:vi.fn(),openModal:vi.fn(),closeModal:vi.fn()}));
const dom=vi.hoisted(()=>{
  const video={style:{},src:'',currentTime:0,duration:10,playbackRate:1,muted:false,
    hasAttribute:()=>false,pause:vi.fn(),dispatchEvent:vi.fn()};
  const elements=new Map();
  return {video,sublist:null,tlScroll:null,tlLayer:null,tlTracks:null,rulerCv:null,imageLayer:null,
    $(id){if(!elements.has(id))elements.set(id,{style:{},textContent:'',value:'',innerHTML:'',
      classList:{add:vi.fn(),remove:vi.fn()},addEventListener:vi.fn(),removeEventListener:vi.fn(),
      querySelectorAll:()=>[],getBoundingClientRect:()=>({left:0,top:0,width:640,height:360})});return elements.get(id);}};
});
vi.mock('../src/dom.js',()=>dom);
vi.mock('../src/ui.js',()=>new Proxy(ui,{get:(target,key)=>key==='then'?undefined:(target[key]||vi.fn())}));
vi.mock('../src/timeline-renderer.js',()=>new Proxy({drawTimeline:vi.fn(),updatePlayhead:vi.fn()},
  {get:(target,key)=>key==='then'?undefined:(target[key]||vi.fn())}));
vi.mock('../src/mixer.js',()=>({renderAudioTracks:vi.fn(),clearMeterStrips:vi.fn()}));

afterEach(()=>{vi.restoreAllMocks();delete window.subtool;});

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
  let entryId = 0;
  socket.write = vi.fn(raw => {
    const message = JSON.parse(raw);
    if (message.command?.[0] === 'loadfile') {
      loadedPath = message.command[1];
      entryId++;
      // Native loading can complete before the loadfile command reply arrives.
      if (loadEvents) queueMicrotask(() => socket.emit('data', Buffer.from(
        JSON.stringify({event:'start-file',playlist_entry_id:entryId})+'\n'+
        '{"event":"file-loaded"}\n{"event":"playback-restart"}\n',
      )));
    }
    if (typeof message.request_id !== 'number') return;
    const data = message.command?.[0] === 'loadfile' ? {playlist_entry_id:entryId}
      : message.command?.[1] === 'path' ? loadedPath
      : message.command?.[1] === 'time-pos' ? 0
      : message.command?.[1] === 'pause' ? true : duration;
    queueMicrotask(() => socket.emit('data', Buffer.from(JSON.stringify({ request_id: message.request_id, data, error: 'success' }) + '\n')));
  });
  return socket;
}

function make({ duration = 123.5, guideLoad, setTimer = () => 0, createLog, spawnFailure, describeSource, socketFactory, onEvent } = {}) {
  FakeWindow.instances = [];
  const parent = { isDestroyed: () => false, getContentBounds: () => ({ x: 100, y: 200 }) };
  const children = [];
  const sockets = [];
  const events = [];
  const delays = [];
  let tempId = 0;
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
    temporaryFiles: {
      create: extension => ({ file: `C:/tmp/subtool-${++tempId}.${extension}` }),
      write: vi.fn(), stream: createLog || (() => null), remove: vi.fn(),
    },
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
    onEvent: event => { events.push(event); onEvent?.(event); },
    log: vi.fn(),
    now: vi.fn(() => 9001),
    delay: async ms => { delays.push(ms); },
    setTimer,
    clearTimer: vi.fn(),
  });
  return { host, parent, children, sockets, events, delays };
}


function observerId(socket, name) {
  const registrations=socket.write.mock.calls.map(([raw])=>JSON.parse(raw))
    .filter(message=>message.command?.[0]==='observe_property'&&message.command[2]===name);
  return registrations.at(-1)?.command[1];
}
function notify(socket,name,data,id) {
  socket.emit('data',Buffer.from(JSON.stringify({event:'property-change',name,data,id})+'\n'));
}

it.each(['probe','load-command'])('切換 B 的 %s 失敗後重新返回 A 必須重新證明 native 來源',async failure=>{
  vi.resetModules();vi.clearAllMocks();let deliver;
  const {host,sockets}=make({describeSource:async path=>{
    if(failure==='probe'&&path==='C:/B.mov')throw new Error('probe failed');return {};
  },onEvent:event=>deliver?.(event)});
  const bridge={launch:options=>host.launch(options),loadfile:vi.fn(path=>host.loadFile(path)),
    onEvent:callback=>{deliver=callback;},pause:options=>host.pause(options),play:options=>host.play(options),
    seek:(time,options)=>host.seek(time,options),direction:async()=>true,rate:async()=>true,mute:async()=>true,
    quit:()=>host.quit(),cancelPresent:()=>host.cancelPresent(),setGuide:async()=>true,setImageGuide:async()=>true};
  window.subtool={isDesktop:true,mpv:bridge,configSave:vi.fn()};
  const {State}=await import('../src/state.js');const {Media}=await import('../src/media.js');
  const {resetPlayerAdapter}=await import('../src/media-player-adapter.js');
  const runtime=resetPlayerAdapter(window.subtool,dom.video);
  const a={id:'A',name:'A.mov',path:'C:/A.mov',dur:10,in:0,out:10,offset:0,vtrack:0};
  const b={id:'B',name:'B.mov',path:'C:/B.mov',dur:10,in:0,out:10,offset:10,vtrack:0};
  Object.assign(State,{clips:[a,b],duration:20,videoTracks:[{visible:true}],fps:25});
  try{
    const original=await runtime.enterMpv({src:a.path});runtime.onEvent(event=>Media.observeMpvEvent(event));
    Media.activeClipId=a.id;Media._gap=false;Media._mpvPath=a.path;Media._mpvTime=2;
    const socket=sockets[0],write=socket.write.getMockImplementation();
    if(failure==='load-command')socket.write.mockImplementation(raw=>{
      const message=JSON.parse(raw);
      if(message.command?.[0]==='loadfile'&&message.command[1]===b.path){
        queueMicrotask(()=>socket.emit('data',Buffer.from(JSON.stringify({request_id:message.request_id,error:'load failed'})+'\n')));return;
      }
      write(raw);
    });
    await Media._ensureClip(b,2,false);
    expect(Media._gap).toBe(true);
    expect(runtime.ownsNativeSourceSession(original.sourceSessionId)).toBe(false);
    await Media._ensureClip(a,2,false);
    expect(bridge.loadfile).toHaveBeenCalledWith(a.path);
    expect(Media.activeClipId).toBe(a.id);expect(Media._gap).toBe(false);
    await vi.waitFor(()=>expect(socket.write.mock.calls.map(([raw])=>JSON.parse(raw).command)
      .some(command=>command?.[0]==='set_property'&&command[1]==='time-pos')).toBe(true));
    await Promise.resolve();await Promise.resolve();
    Media.playing=true;notify(socket,'time-pos',3,observerId(socket,'time-pos'));
    expect(Media._mpvTime).toBe(3);
  }finally{Media.reset();runtime.stopBoundsFeeder();host.quit();}
});

it.each(['valid-placement','lost-placement','lost-active','lost-present'])('同來源資格 %s 控制三處快徑',async scenario=>{
  vi.resetModules();vi.clearAllMocks();let deliver;
  const {host,sockets}=make({describeSource:async path=>{if(path==='C:/B.mov')throw new Error('probe failed');return {};},
    onEvent:event=>deliver?.(event)});
  const bridge={launch:options=>host.launch(options),loadfile:vi.fn(path=>host.loadFile(path)),
    onEvent:callback=>{deliver=callback;},pause:options=>host.pause(options),play:options=>host.play(options),
    present:(time,options)=>host.present(time,options),seek:(time,options)=>host.seek(time,options),
    direction:async()=>true,rate:async()=>true,mute:async()=>true,cancelPresent:()=>host.cancelPresent(),
    quit:()=>host.quit(),setGuide:async()=>true,setImageGuide:async()=>true};
  window.subtool={isDesktop:true,mpv:bridge,configSave:vi.fn()};
  const {State}=await import('../src/state.js');const {Media}=await import('../src/media.js');
  const {resetPlayerAdapter}=await import('../src/media-player-adapter.js');
  const runtime=resetPlayerAdapter(window.subtool,dom.video);
  const first={id:'A1',name:'A.mov',path:'C:/A.mov',dur:10,in:0,out:5,offset:0,vtrack:0};
  const second={id:'A2',name:'A.mov',path:'C:/A.mov',dur:10,in:5,out:10,offset:5,vtrack:0};
  Object.assign(State,{clips:[first,second],duration:10,videoTracks:[{visible:true}],fps:25});
  try{
    const initial=await runtime.enterMpv({src:first.path});runtime.onEvent(event=>Media.observeMpvEvent(event));
    Media.activeClipId=first.id;Media._gap=false;Media._mpvPath=first.path;Media._mpvTime=2;
    if(scenario!=='valid-placement'){
      await expect(runtime.loadfile('C:/B.mov')).rejects.toThrow();
      expect(runtime.ownsNativeSourceSession(initial.sourceSessionId)).toBe(false);
      bridge.loadfile.mockClear();
    }
    if(scenario==='lost-active'||scenario==='lost-present') Media.activeClipId=second.id;
    if(scenario==='lost-present'){
      const pending=Media.requestPresentation(6);
      await vi.waitFor(()=>expect(bridge.loadfile).toHaveBeenCalledWith(first.path));
      Media.resetPresentationSession('test cleanup');await pending;
    }else{
      await Media._ensureClip(second,6,false);
      if(scenario==='valid-placement')expect(bridge.loadfile).not.toHaveBeenCalled();
      else expect(bridge.loadfile).toHaveBeenCalledWith(first.path);
      expect(Media.activeClipId).toBe(second.id);
      await Promise.resolve();await Promise.resolve();
      Media.playing=true;notify(sockets[0],'time-pos',7,observerId(sockets[0],'time-pos'));
      expect(Media._mpvTime).toBe(7);
    }
  }finally{Media.reset();runtime.stopBoundsFeeder();host.quit();}
});
it('B 成功但舊 _ensureClip 在 IPC 回覆前被新 request 取消，回到 A 必須核對已接受來源實際路徑',async()=>{
  vi.resetModules();vi.clearAllMocks();let deliver,release,loadedB,owns=true;
  const gate=new Promise(resolve=>{release=resolve;});
  const {host}=make({onEvent:event=>deliver?.(event)});
  const bridge={launch:options=>host.launch(options),loadfile:vi.fn(async path=>{
    const result=await host.loadFile(path);
    if(path==='C:/B.mov'){loadedB=result;await gate;}
    return result;
  }),onEvent:callback=>{deliver=callback;},pause:options=>host.pause(options),play:options=>host.play(options),
    seek:(time,options)=>host.seek(time,options),direction:async()=>true,rate:async()=>true,mute:async()=>true,
    quit:()=>host.quit(),cancelPresent:()=>host.cancelPresent(),setGuide:async()=>true,setImageGuide:async()=>true};
  window.subtool={isDesktop:true,mpv:bridge,configSave:vi.fn()};
  const {State}=await import('../src/state.js');const {Media}=await import('../src/media.js');
  const {resetPlayerAdapter}=await import('../src/media-player-adapter.js');
  const runtime=resetPlayerAdapter(window.subtool,dom.video);
  const a={id:'A',name:'A.mov',path:'C:/A.mov',dur:10,in:0,out:10,offset:0,vtrack:0};
  const b={id:'B',name:'B.mov',path:'C:/B.mov',dur:10,in:0,out:10,offset:10,vtrack:0};
  Object.assign(State,{clips:[a,b],duration:20,videoTracks:[{visible:true}],fps:25});
  try{
    await runtime.enterMpv({src:a.path});runtime.onEvent(event=>Media.observeMpvEvent(event));
    Media.activeClipId=a.id;Media._gap=false;Media._mpvPath=a.path;Media._mpvTime=2;
    const stale=Media._ensureClip(b,2,false,{owns:()=>owns});
    await vi.waitFor(()=>expect(loadedB?.ok).toBe(true));
    owns=false;release();await stale;
    expect(runtime.ownsNativeSourceSession(loadedB.sourceSessionId)).toBe(true);
    expect(Media._mpvPath).toBe(a.path);
    await Media._ensureClip(a,2,false);
    expect(bridge.loadfile).toHaveBeenCalledWith(a.path);
    expect(runtime.ownsNativeSourceSession(loadedB.sourceSessionId)).toBe(false);
    expect(Media.activeClipId).toBe(a.id);
  }finally{release();Media.reset();runtime.stopBoundsFeeder();host.quit();}
});

it('同路徑失去 bridge 時提示並進入間隙，不能假裝來源仍可使用',async()=>{
  vi.resetModules();vi.clearAllMocks();let deliver;
  const {host}=make({onEvent:event=>deliver?.(event)});
  const bridge={launch:options=>host.launch(options),loadfile:vi.fn(path=>host.loadFile(path)),
    onEvent:callback=>{deliver=callback;},pause:options=>host.pause(options),quit:()=>host.quit()};
  window.subtool={isDesktop:true,mpv:bridge,configSave:vi.fn()};
  const {State}=await import('../src/state.js');const {Media}=await import('../src/media.js');
  const {resetPlayerAdapter}=await import('../src/media-player-adapter.js');
  const runtime=resetPlayerAdapter(window.subtool,dom.video);
  const clip={id:'A',name:'A.mov',path:'C:/A.mov',dur:10,in:0,out:10,offset:0,vtrack:0};
  Object.assign(State,{clips:[clip],duration:10,videoTracks:[{visible:true}],fps:25});
  try{
    await runtime.enterMpv({src:clip.path});runtime.onEvent(event=>Media.observeMpvEvent(event));
    Media.activeClipId=clip.id;Media._gap=false;Media._mpvPath=clip.path;Media._mpvTime=2;
    runtime.setMpvBridge(null);
    await Media._ensureClip(clip,2,false);
    expect(Media._gap).toBe(true);expect(bridge.loadfile).not.toHaveBeenCalled();
    expect(ui.showToast.mock.calls.flat().join(' ')).toMatch(/播放器未連線/);
  }finally{Media.reset();runtime.stopBoundsFeeder();host.quit();}
});

it.each(['html','new-source'])('恢復 A 時若被 %s 取代，遲到結果不得定位舊來源',async replacement=>{
  vi.resetModules();vi.clearAllMocks();let deliver,release,loadedA;
  const gate=new Promise(resolve=>{release=resolve;});
  const {host}=make({describeSource:async path=>{if(path==='C:/B.mov')throw new Error('probe failed');return {};},
    onEvent:event=>deliver?.(event)});
  const bridge={launch:options=>host.launch(options),loadfile:vi.fn(async path=>{
    const result=await host.loadFile(path);
    if(path==='C:/A.mov'){loadedA=result;await gate;}
    return result;
  }),onEvent:callback=>{deliver=callback;},pause:options=>host.pause(options),play:options=>host.play(options),
    seek:vi.fn((time,options)=>host.seek(time,options)),direction:async()=>true,rate:async()=>true,mute:async()=>true,
    quit:()=>host.quit(),cancelPresent:()=>host.cancelPresent(),setGuide:async()=>true,setImageGuide:async()=>true};
  window.subtool={isDesktop:true,mpv:bridge,configSave:vi.fn()};
  const {State}=await import('../src/state.js');const {Media}=await import('../src/media.js');
  const {resetPlayerAdapter}=await import('../src/media-player-adapter.js');
  const runtime=resetPlayerAdapter(window.subtool,dom.video);
  const clip={id:'A',name:'A.mov',path:'C:/A.mov',dur:10,in:0,out:10,offset:0,vtrack:0};
  Object.assign(State,{clips:[clip],duration:10,videoTracks:[{visible:true}],fps:25});
  try{
    await runtime.enterMpv({src:clip.path});runtime.onEvent(event=>Media.observeMpvEvent(event));
    Media.activeClipId=clip.id;Media._gap=false;Media._mpvPath=clip.path;Media._mpvTime=2;
    await expect(runtime.loadfile('C:/B.mov')).rejects.toThrow();
    const restoring=Media._ensureClip(clip,4,false);
    await vi.waitFor(()=>expect(loadedA?.ok).toBe(true));
    if(replacement==='html') runtime.selectHtml5(dom.video);
    else expect((await runtime.loadfile('C:/C.mov')).ok).toBe(true);
    release();await restoring;
    expect(bridge.seek).not.toHaveBeenCalled();expect(Media._mpvTime).toBe(2);
    expect(runtime.ownsNativeSourceSession(loadedA.sourceSessionId)).toBe(false);
  }finally{release();Media.reset();runtime.stopBoundsFeeder();host.quit();}
});
