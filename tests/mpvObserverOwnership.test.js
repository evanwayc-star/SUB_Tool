// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

const ui=vi.hoisted(()=>({renderCurrentTimecode:vi.fn(),setStatus:vi.fn(),showToast:vi.fn(),openModal:vi.fn(),closeModal:vi.fn()}));
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

it.each(['time-pos','pause'])('舊來源 %s 已排進 renderer 通道後不得影響新來源，當前值仍有效',async name=>{
  vi.resetModules();vi.clearAllMocks();
  let deliver,hold=true;const queued=[];
  const {host,sockets}=make({onEvent:event=>{
    if(hold&&event.event==='property-change'&&event.name===name) queued.push(event);
    else deliver?.(event);
  }});
  const bridge={launch:options=>host.launch(options),loadfile:path=>host.loadFile(path),
    onEvent:callback=>{deliver=callback;},pause:options=>host.pause(options),play:options=>host.play(options),
    quit:()=>host.quit(),cancelPresent:()=>host.cancelPresent(),
    setGuide:async()=>true,setImageGuide:async()=>true};
  window.subtool={isDesktop:true,mpv:bridge,configSave:vi.fn()};
  const {State}=await import('../src/state.js');
  const {Media}=await import('../src/media.js');
  const {resetPlayerAdapter}=await import('../src/media-player-adapter.js');
  const runtime=resetPlayerAdapter(window.subtool,dom.video);
  const clip={id:'B',name:'B.mov',path:'C:/B.mov',dur:10,in:0,out:10,offset:0,vtrack:0};
  Object.assign(State,{clips:[clip],duration:10,videoTracks:[{visible:true}],fps:25});
  const stop=vi.spyOn(Media,'stopBufferSources').mockImplementation(()=>{});
  vi.spyOn(Media,'stopElementSources').mockImplementation(()=>{});
  try{
    await runtime.enterMpv({src:'C:/A.mov'});runtime.onEvent(event=>Media.observeMpvEvent(event));
    const socket=sockets[0],oldObserver=observerId(socket,name);
    expect(oldObserver).toEqual(expect.any(Number));
    notify(socket,name,name==='pause'?true:7,oldObserver);
    await vi.waitFor(()=>expect(queued).toHaveLength(1));
    const loaded=await runtime.loadfile('C:/B.mov');expect(loaded.ok).toBe(true);
    Media.activeClipId='B';Media._gap=false;Media._mpvPath=clip.path;Media._mpvTime=2;Media.playing=true;
    hold=false;deliver(queued[0]);
    expect(Media._mpvTime).toBe(2);expect(Media.playing).toBe(true);expect(stop).not.toHaveBeenCalled();
    const currentObserver=observerId(socket,name);
    expect(currentObserver).toEqual(expect.any(Number));
    if(name==='time-pos')await host.seek(2);
    notify(socket,name,name==='pause'?true:3,currentObserver);
    if(name==='pause')await vi.waitFor(()=>expect(Media.playing).toBe(false));
    else expect(Media._mpvTime).toBe(3);
  }finally{Media.reset();runtime.stopBoundsFeeder();host.quit();}
});

it('舊 observer 的 pause 與 time-pos 不得讓新來源的 present 誤完成',async()=>{
  const {host,sockets}=make();
  try{
    await host.launch({src:'C:/A.mov'});
    const socket=sockets[0],oldPause=observerId(socket,'pause'),oldTime=observerId(socket,'time-pos');
    await host.loadFile('C:/B.mov');await host.play();
    const priorWrite=socket.write.getMockImplementation();let seekMessage;
    socket.write.mockImplementation(raw=>{
      const message=JSON.parse(raw);
      if(message.command?.[0]==='seek'||(message.command?.[0]==='set_property'&&message.command[1]==='time-pos')){
        seekMessage=message;return;
      }
      priorWrite(raw);
    });
    let settled=false;const pending=host.present(4,{tolerance:0.01}).then(value=>{settled=true;return value;});
    expect(seekMessage).toBeTruthy();
    notify(socket,'pause',true,oldPause);notify(socket,'time-pos',4,oldTime);
    socket.emit('data',Buffer.from(JSON.stringify({request_id:seekMessage.request_id,error:'success'})+'\n'));
    for(let i=0;i<12;i++)await Promise.resolve();
    expect(settled).toBe(false);
    notify(socket,'pause',false,observerId(socket,'pause'));
    notify(socket,'time-pos',4,observerId(socket,'time-pos'));
    socket.emit('data',Buffer.from(JSON.stringify({event:'playback-restart'})+'\n'));
    await expect(pending).resolves.toMatchObject({backend:'mpv',presentedSourceTime:4});
  }finally{host.quit();}
});

it('同路徑重載的 observer 世代不同；正常每格通知不增加 IPC 查詢',async()=>{
  const {host,sockets,events}=make();
  try{
    const initial=await host.launch({src:'C:/same.mov'}),socket=sockets[0];
    const oldId=observerId(socket,'time-pos');
    const next=await host.loadFile('C:/same.mov'),newId=observerId(socket,'time-pos');
    expect(next.sourceSessionId).not.toBe(initial.sourceSessionId);expect(newId).not.toBe(oldId);
    events.length=0;const commands=socket.write.mock.calls.length;
    notify(socket,'time-pos',100,oldId);
    for(let frame=0;frame<2000;frame++)notify(socket,'time-pos',frame/25,newId);
    expect(socket.write.mock.calls.length).toBe(commands);
    const positions=events.filter(event=>event.name==='time-pos');
    expect(positions).toHaveLength(2000);
    expect(positions.at(-1)).toMatchObject({data:1999/25,sourceSessionId:next.sourceSessionId});
  }finally{host.quit();}
});

it('新 observer 註冊 ACK 失敗會清理部分訂閱，稍後載入仍可建立新來源',async()=>{
  const {host,sockets,events}=make();
  try{
    await host.launch({src:'C:/A.mov'});const socket=sockets[0],write=socket.write.getMockImplementation();let reject=true;
    socket.write.mockImplementation(raw=>{
      const message=JSON.parse(raw);
      if(reject&&message.command?.[0]==='observe_property'&&message.command[2]==='pause'){
        reject=false;queueMicrotask(()=>socket.emit('data',Buffer.from(JSON.stringify({request_id:message.request_id,error:'property unavailable'})+'\n')));return;
      }
      write(raw);
    });
    await expect(host.loadFile('C:/B.mov')).rejects.toThrow('property unavailable');
    const failedId=observerId(socket,'time-pos');
    expect(socket.write.mock.calls.map(([raw])=>JSON.parse(raw).command)).toContainEqual(['unobserve_property',failedId]);
    const loaded=await host.loadFile('C:/C.mov');const currentId=observerId(socket,'time-pos');
    expect(currentId).not.toBe(failedId);events.length=0;
    notify(socket,'time-pos',4,failedId);notify(socket,'time-pos',5,currentId);
    expect(events.filter(event=>event.name==='time-pos')).toEqual([expect.objectContaining({data:5,sourceSessionId:loaded.sourceSessionId})]);
  }finally{host.quit();}
});

it('被新來源取代的 observer 註冊晚回覆，只清除自己的 ID',async()=>{
  const {host,sockets,events}=make();
  try{
    await host.launch({src:'C:/A.mov'});const socket=sockets[0],write=socket.write.getMockImplementation();let held;
    socket.write.mockImplementation(raw=>{
      const message=JSON.parse(raw);
      if(!held&&message.command?.[0]==='observe_property'&&message.command[2]==='time-pos'){held=message;return;}
      write(raw);
    });
    const old=host.loadFile('C:/B.mov');await vi.waitFor(()=>expect(held).toBeTruthy());
    const current=await host.loadFile('C:/C.mov'),currentId=observerId(socket,'time-pos');
    socket.emit('data',Buffer.from(JSON.stringify({request_id:held.request_id,error:'success'})+'\n'));
    expect((await old).ok).toBe(false);
    const commands=socket.write.mock.calls.map(([raw])=>JSON.parse(raw).command);
    expect(commands).toContainEqual(['unobserve_property',held.command[1]]);
    expect(commands).not.toContainEqual(['unobserve_property',currentId]);
    events.length=0;notify(socket,'time-pos',5,currentId);
    expect(events).toContainEqual(expect.objectContaining({name:'time-pos',data:5,sourceSessionId:current.sourceSessionId}));
  }finally{host.quit();}
});

it('B 的 probe 尚未完成就切換 C，仍撤銷 A 的兩個舊訂閱',async()=>{
  let releaseProbe;const probeGate=new Promise(resolve=>{releaseProbe=resolve;});
  const {host,sockets}=make({describeSource:async path=>{if(path==='C:/B.mov')await probeGate;return {};}});
  try{
    await host.launch({src:'C:/A.mov'});const socket=sockets[0];
    const oldTime=observerId(socket,'time-pos'),oldPause=observerId(socket,'pause');
    const old=host.loadFile('C:/B.mov');const current=await host.loadFile('C:/C.mov');
    expect(current.ok).toBe(true);releaseProbe();expect((await old).ok).toBe(false);
    const commands=socket.write.mock.calls.map(([raw])=>JSON.parse(raw).command);
    expect(commands).toContainEqual(['unobserve_property',oldTime]);
    expect(commands).toContainEqual(['unobserve_property',oldPause]);
  }finally{releaseProbe();host.quit();}
});

it('舊 restart 先於 seek ACK 不可證明等待真畫格的 capture 完成',async()=>{
  const {host,sockets}=make();
  try{
    await host.launch({src:'C:/A.mov'});await host.loadFile('C:/B.mov');
    const socket=sockets[0],write=socket.write.getMockImplementation();let seekMessage;
    socket.write.mockImplementation(raw=>{
      const message=JSON.parse(raw);
      if(message.command?.[0]==='seek'||(message.command?.[0]==='set_property'&&message.command[1]==='time-pos')){seekMessage=message;return;}
      if(message.command?.[0]==='get_property'&&message.command[1]==='time-pos'){
        queueMicrotask(()=>socket.emit('data',Buffer.from(JSON.stringify({request_id:message.request_id,data:4,error:'success'})+'\n')));return;
      }
      write(raw);
    });
    let settled=false;const pending=host.present(4,{tolerance:.01,waitForFrame:true}).then(value=>{settled=true;return value;});
    socket.emit('data',Buffer.from(JSON.stringify({event:'playback-restart'})+'\n'));
    socket.emit('data',Buffer.from(JSON.stringify({request_id:seekMessage.request_id,error:'success'})+'\n'));
    for(let i=0;i<12;i++)await Promise.resolve();expect(settled).toBe(false);
    socket.emit('data',Buffer.from(JSON.stringify({event:'playback-restart'})+'\n'));
    await expect(pending).resolves.toMatchObject({backend:'mpv',presentedSourceTime:4});
  }finally{host.quit();}
});

it('seek ACK 與新 restart 在同一 pipe chunk 時，仍可完成真畫格呈現',async()=>{
  const {host,sockets}=make();
  try{
    await host.launch({src:'C:/A.mov'});await host.loadFile('C:/B.mov');
    const socket=sockets[0],write=socket.write.getMockImplementation();
    socket.write.mockImplementation(raw=>{
      const message=JSON.parse(raw);
      if(message.command?.[0]==='set_property'&&message.command[1]==='time-pos'){
        queueMicrotask(()=>socket.emit('data',Buffer.from(JSON.stringify({request_id:message.request_id,error:'success'})+'\n'+JSON.stringify({event:'playback-restart'})+'\n')));return;
      }
      if(message.command?.[0]==='get_property'&&message.command[1]==='time-pos'){
        queueMicrotask(()=>socket.emit('data',Buffer.from(JSON.stringify({request_id:message.request_id,data:4,error:'success'})+'\n')));return;
      }
      write(raw);
    });
    await expect(host.present(4,{tolerance:.01,waitForFrame:true})).resolves.toMatchObject({backend:'mpv',presentedSourceTime:4});
  }finally{host.quit();}
});

it('seek ACK 與新 time-pos 在同一 pipe chunk 時，位置可交給目前來源',async()=>{
  const {host,sockets,events}=make();
  try{
    await host.launch({src:'C:/A.mov'});const loaded=await host.loadFile('C:/B.mov');
    const socket=sockets[0],write=socket.write.getMockImplementation();
    socket.write.mockImplementation(raw=>{
      const message=JSON.parse(raw);
      if(message.command?.[0]==='set_property'&&message.command[1]==='time-pos'){
        const event={event:'property-change',name:'time-pos',id:observerId(socket,'time-pos'),data:4};
        queueMicrotask(()=>socket.emit('data',Buffer.from(JSON.stringify({request_id:message.request_id,error:'success'})+'\n'+JSON.stringify(event)+'\n')));return;
      }
      write(raw);
    });
    events.length=0;await host.seek(4);
    expect(events).toContainEqual(expect.objectContaining({name:'time-pos',data:4,sourceSessionId:loaded.sourceSessionId}));
    expect(events.find(event=>event.name==='time-pos')).not.toHaveProperty('beforeSourcePositioning');
  }finally{host.quit();}
});

it('同一來源舊 time-pos 早於 seek ACK，不能代替 ACK 後的新查詢',async()=>{
  const {host,sockets}=make();
  try{
    await host.launch({src:'C:/A.mov'});const socket=sockets[0],write=socket.write.getMockImplementation();let seekMessage,query;
    socket.write.mockImplementation(raw=>{
      const message=JSON.parse(raw);
      if(message.command?.[0]==='seek'||(message.command?.[0]==='set_property'&&message.command[1]==='time-pos')){seekMessage=message;return;}
      if(message.command?.[0]==='get_property'&&message.command[1]==='time-pos'){query=message;return;}
      write(raw);
    });
    let settled=false;const pending=host.present(4,{tolerance:.01}).then(value=>{settled=true;return value;});
    notify(socket,'time-pos',4,observerId(socket,'time-pos'));
    socket.emit('data',Buffer.from(JSON.stringify({request_id:seekMessage.request_id,error:'success'})+'\n'));
    await vi.waitFor(()=>expect(query).toBeTruthy());expect(settled).toBe(false);
    socket.emit('data',Buffer.from(JSON.stringify({request_id:query.request_id,data:4,error:'success'})+'\n'));
    await expect(pending).resolves.toMatchObject({backend:'mpv',presentedSourceTime:4});
  }finally{host.quit();}
});

it.each(['play','pause'])('%s 命令失敗後，以原本暫停狀態繼續判斷呈現',async failed=>{
  const {host,sockets}=make();
  try{
    await host.launch({src:'C:/A.mov'});const socket=sockets[0],write=socket.write.getMockImplementation();
    if(failed==='pause')await host.play();
    socket.write.mockImplementation(raw=>{
      const message=JSON.parse(raw);
      if(message.command?.[0]==='set_property'&&message.command[1]==='pause'&&message.command[2]===(failed==='pause')){
        queueMicrotask(()=>socket.emit('data',Buffer.from(JSON.stringify({request_id:message.request_id,error:'property unavailable'})+'\n')));return;
      }
      if(message.command?.[0]==='get_property'&&message.command[1]==='time-pos'){
        queueMicrotask(()=>socket.emit('data',Buffer.from(JSON.stringify({request_id:message.request_id,data:4,error:'success'})+'\n')));return;
      }
      write(raw);
    });
    await expect(host[failed]()).rejects.toThrow('property unavailable');
    let settled=false;const pending=host.present(4,{tolerance:.01}).then(value=>{settled=true;return value;});
    for(let i=0;i<16;i++)await Promise.resolve();
    expect(settled).toBe(failed==='play');
    if(failed==='pause')socket.emit('data',Buffer.from(JSON.stringify({event:'playback-restart'})+'\n'));
    await expect(pending).resolves.toMatchObject({backend:'mpv',presentedSourceTime:4});
  }finally{host.quit();}
});

it('新來源事件先於 IPC 載入回覆仍由確認過的 adapter session 接手',async()=>{
  let deliver,release,loaded;const gate=new Promise(resolve=>{release=resolve;});
  const {host,sockets}=make({onEvent:event=>deliver?.(event)});
  const bridge={launch:options=>host.launch(options),loadfile:async path=>{loaded=await host.loadFile(path);await gate;return loaded;},
    onEvent:callback=>{deliver=callback;}};
  const {createNativePreviewRuntime}=await import('../src/media-player-adapter.js');
  const runtime=createNativePreviewRuntime({mpv:bridge,video:dom.video,windowTarget:null}),received=vi.fn();
  try{
    await runtime.enterMpv({src:'C:/A.mov'});runtime.onEvent(received);
    const switching=runtime.loadfile('C:/B.mov');await vi.waitFor(()=>expect(loaded).toBeTruthy());
    const socket=sockets[0];notify(socket,'time-pos',3,observerId(socket,'time-pos'));
    expect(received.mock.calls.some(([event])=>event.name==='time-pos')).toBe(false);
    release();await switching;
    await vi.waitFor(()=>expect(received).toHaveBeenCalledWith(expect.objectContaining({name:'time-pos',data:3,sourceSessionId:loaded.sourceSessionId})));
  }finally{release();runtime.stopBoundsFeeder();host.quit();}
});

it('真實 _ensureClip 等待新來源定位時，載入初始零秒不能覆寫目標播放點',async()=>{
  vi.resetModules();vi.clearAllMocks();let deliver;
  const {host,sockets}=make({onEvent:event=>deliver?.(event)});
  const bridge={launch:options=>host.launch(options),loadfile:path=>host.loadFile(path),onEvent:callback=>{deliver=callback;},
    seek:()=>new Promise(()=>{}),direction:async()=>true,rate:async()=>true,mute:async()=>true,pause:async()=>true};
  window.subtool={isDesktop:true,mpv:bridge,configSave:vi.fn()};
  const {State}=await import('../src/state.js');const {Media}=await import('../src/media.js');
  const {resetPlayerAdapter}=await import('../src/media-player-adapter.js');
  const runtime=resetPlayerAdapter(window.subtool,dom.video);
  const old={id:'old',name:'A.mov',path:'C:/A.mov',dur:10,in:0,out:10,offset:0,vtrack:0};
  const clip={id:'new',name:'B.mov',path:'C:/B.mov',dur:10,in:0,out:10,offset:10,vtrack:0};
  Object.assign(State,{clips:[old,clip],duration:20,videoTracks:[{visible:true}],fps:25});
  try{
    await runtime.enterMpv({src:old.path});runtime.onEvent(event=>Media.observeMpvEvent(event));
    Media.activeClipId=old.id;Media._gap=false;Media._mpvPath=old.path;
    const socket=sockets[0],write=socket.write.getMockImplementation();let injected=false;
    socket.write.mockImplementation(raw=>{
      const message=JSON.parse(raw);
      if(!injected&&message.command?.[0]==='observe_property'&&message.command[2]==='time-pos'){
        injected=true;notify(socket,'time-pos',0,message.command[1]);
      }
      write(raw);
    });
    await Media._ensureClip(clip,4,false);
    expect(injected).toBe(true);expect(Media._mpvTime).toBe(4);
    await new Promise(resolve=>setTimeout(resolve,20));
    expect(Media._mpvTime).toBe(4);
  }finally{Media.reset();runtime.stopBoundsFeeder();host.quit();}
});
async function pauseIntentFixture() {
  vi.resetModules();vi.clearAllMocks();
  let deliver,hold=false;const queued=[];
  const {host,sockets}=make({onEvent:event=>{
    if(hold&&event.event==='property-change'&&event.name==='pause') queued.push(event);
    else deliver?.(event);
  }});
  const bridge={launch:options=>host.launch(options),loadfile:path=>host.loadFile(path),
    onEvent:callback=>{deliver=callback;},pause:(...args)=>host.pause(...args),play:(...args)=>host.play(...args),
    quit:()=>host.quit(),cancelPresent:()=>host.cancelPresent(),
    setGuide:async()=>true,setImageGuide:async()=>true};
  window.subtool={isDesktop:true,mpv:bridge,configSave:vi.fn()};
  const {State}=await import('../src/state.js');const {Media}=await import('../src/media.js');
  const {resetPlayerAdapter}=await import('../src/media-player-adapter.js');
  const runtime=resetPlayerAdapter(window.subtool,dom.video);
  const clip={id:'A',name:'A.mov',path:'C:/A.mov',dur:10,in:0,out:10,offset:0,vtrack:0};
  Object.assign(State,{clips:[clip],duration:10,videoTracks:[{visible:true}],fps:25});
  const stop=vi.spyOn(Media,'stopBufferSources').mockImplementation(()=>{});
  vi.spyOn(Media,'stopElementSources').mockImplementation(()=>{});
  await runtime.enterMpv({src:clip.path});runtime.onEvent(event=>Media.observeMpvEvent(event));
  Media.activeClipId=clip.id;Media._gap=false;Media._mpvPath=clip.path;Media._mpvTime=2;Media.playing=true;
  return {host,socket:sockets[0],runtime,Media,stop,queued,
    hold(value){hold=value;},deliver(event){deliver(event);},
    cleanup(){Media.reset();runtime.stopBoundsFeeder();host.quit();}};
}

it('同一 session 的舊 pause 已到 renderer 佇列，新 play 之後不得終止目前播放',async()=>{
  const f=await pauseIntentFixture();
  try{
    const priorWrite=f.socket.write.getMockImplementation();
    f.socket.write.mockImplementation(raw=>{
      const message=JSON.parse(raw);
      if(message.command?.[0]==='get_property'&&message.command[1]==='pause'){
        queueMicrotask(()=>f.socket.emit('data',Buffer.from(JSON.stringify({request_id:message.request_id,data:true,error:'success'})+'\n')));return;
      }
      priorWrite(raw);
    });
    f.hold(true);notify(f.socket,'pause',true,observerId(f.socket,'pause'));
    await vi.waitFor(()=>expect(f.queued).toHaveLength(1));
    await f.runtime.play();f.Media.playing=true;f.stop.mockClear();
    f.hold(false);f.deliver(f.queued[0]);
    expect(f.Media.playing).toBe(true);expect(f.stop).not.toHaveBeenCalled();
  }finally{f.cleanup();}
});

it.each(['play','pause-then-play'])('pause 查詢在 %s 意圖前已送出，遲到回覆不得終止新播放；目前 pause 仍可生效',async change=>{
  const f=await pauseIntentFixture();
  try{
    const priorWrite=f.socket.write.getMockImplementation(),queries=[];
    f.socket.write.mockImplementation(raw=>{
      const message=JSON.parse(raw);
      if(message.command?.[0]==='get_property'&&message.command[1]==='pause'){queries.push(message);return;}
      priorWrite(raw);
    });
    notify(f.socket,'pause',true,observerId(f.socket,'pause'));
    await vi.waitFor(()=>expect(queries).toHaveLength(1));
    if(change==='pause-then-play')await f.runtime.pause();
    await f.runtime.play();f.Media.playing=true;f.stop.mockClear();
    f.socket.emit('data',Buffer.from(JSON.stringify({request_id:queries[0].request_id,data:true,error:'success'})+'\n'));
    for(let i=0;i<16;i++)await Promise.resolve();
    expect(f.Media.playing).toBe(true);expect(f.stop).not.toHaveBeenCalled();
    // A fresh notification and a fresh query for the accepted current state
    // must still reach Media; a blanket pause-event suppression is incorrect.
    notify(f.socket,'pause',true,observerId(f.socket,'pause'));
    await vi.waitFor(()=>expect(queries.length).toBeGreaterThanOrEqual(2));
    const fresh=queries.at(-1);
    f.socket.emit('data',Buffer.from(JSON.stringify({request_id:fresh.request_id,data:true,error:'success'})+'\n'));
    await vi.waitFor(()=>expect(f.Media.playing).toBe(false));
  }finally{f.cleanup();}
});
