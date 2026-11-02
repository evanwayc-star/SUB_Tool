// @vitest-environment jsdom
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
import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { createNativePreviewRuntime } from '../src/media-player-adapter.js';

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
      : message.command?.[1] === 'time-pos' ? 0 : duration;
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


it.each([
  ['late-eof','eof',false],['late-error','error',false],['same-path','eof',true],
  ['current-eof','eof',false],['current-error','error',false],['during-switch','eof',false],
  ['late-to-host','eof',false],['gap','eof',false],['audio-only','eof',false],
  ['current-switch','eof',false],['pending-current','eof',false],
  ['pending-cancel','eof',false],
])('真 host 至 Media 的 %s 依來源 entry 判斷',async(scenario,reason,samePath)=>{
  vi.resetModules();vi.clearAllMocks();
  let receive;const queued=[];
  const {host,sockets}=make({onEvent:event=>{
    if(event.event==='end-file'&&event.playlist_entry_id===1)queued.push(event);
    else receive?.(event);
  }});
  let releaseReply,hostResult;
  const replyGate=new Promise(resolve=>{releaseReply=resolve;});
  const bridge={launch:options=>host.launch(options),loadfile:async path=>{
    const result=await host.loadFile(path);
    if(scenario.startsWith('pending-')){hostResult=result;await replyGate;}
    return result;
  },
    onEvent:callback=>{receive=callback;},quit:()=>host.quit(),pause:async()=>true};
  window.subtool={isDesktop:true,mpv:bridge,configSave:vi.fn()};
  const {State}=await import('../src/state.js');
  const {Media}=await import('../src/media.js');
  const {resetPlayerAdapter}=await import('../src/media-player-adapter.js');
  const runtime=resetPlayerAdapter(window.subtool,dom.video);
  const oldPath='D:/same.mkv',newPath=samePath?oldPath:'D:/new.mkv';
  const clip={id:'B',name:'B',path:newPath,dur:10,in:0,out:10,offset:0,vtrack:0};
  Object.assign(State,{clips:[clip],cues:[],notes:[],duration:10,tracks:[],videoTracks:[{name:'V1',visible:true}],fps:25});
  try{
    const a=await runtime.enterMpv({src:oldPath});
    runtime.onEvent(event=>Media.observeMpvEvent(event));
    const socket=sockets[0];
    const emit=event=>socket.emit('data',Buffer.from(JSON.stringify(event)+'\n'));
    if(scenario==='late-eof'||scenario==='late-error'||samePath) emit({event:'end-file',playlist_entry_id:1,reason});
    const loading=runtime.loadfile(newPath);
    if(scenario.startsWith('pending-')){
      await vi.waitFor(()=>expect(hostResult).toBeTruthy());
      emit({event:'end-file',playlist_entry_id:2,reason});
      if(scenario==='pending-cancel') runtime.selectHtml5(dom.video);
      releaseReply();
    }
    const b=await loading;
    expect(b.sourceSessionId).not.toBe(a.sourceSessionId);
    Media.activeClipId='B';Media._mpvPath=newPath;Media._mpvTime=2;Media.playing=true;
    const stop=vi.spyOn(Media,'stopBufferSources').mockImplementation(()=>{});
    vi.spyOn(Media,'stopElementSources').mockImplementation(()=>{});
    const continuation=vi.spyOn(Media,'seqContinueAtEnd').mockReturnValue(false);
    if(scenario==='pending-current'){
      await vi.waitFor(()=>expect(Media.playing).toBe(false));
      expect(continuation).toHaveBeenCalledOnce();
    }else if(scenario==='pending-cancel'){
      await new Promise(resolve=>setTimeout(resolve,10));
      expect(Media.playing).toBe(true);expect(stop).not.toHaveBeenCalled();
    }else if(scenario==='late-to-host'){
      emit({event:'end-file',playlist_entry_id:1,reason});
      expect(queued).toHaveLength(0);expect(Media.playing).toBe(true);
    }else if(scenario==='gap'){
      Media._gap=true;emit({event:'end-file',playlist_entry_id:2,reason});
      expect(Media.playing).toBe(true);expect(continuation).not.toHaveBeenCalled();
    }else if(scenario==='audio-only'){
      State.clips=[];Media.activeClipId=null;
      Media.createExternalAudioSource({name:'voice.wav',duration:10,in:0,out:10,offset:0,fallbackCount:1});
      expect(Media.audioOnlyTimeline()).toBe(true);
      emit({event:'end-file',playlist_entry_id:2,reason});
      expect(Media.playing).toBe(true);expect(continuation).not.toHaveBeenCalled();
    }else if(scenario==='current-switch'){
      Media._seqSwitching=true;emit({event:'end-file',playlist_entry_id:2,reason});
      expect(Media.playing).toBe(true);expect(continuation).not.toHaveBeenCalled();
    }else if(scenario.startsWith('late')||samePath){
      expect(queued).toHaveLength(1);
      receive(queued[0]);
      expect(Media.playing).toBe(true);expect(stop).not.toHaveBeenCalled();expect(continuation).not.toHaveBeenCalled();
    }else if(scenario==='during-switch'){
      Media._seqSwitching=true;
      emit({event:'end-file',playlist_entry_id:1,reason});
      expect(Media.playing).toBe(true);expect(continuation).not.toHaveBeenCalled();
    }else{
      emit({event:'end-file',playlist_entry_id:2,reason});
      expect(Media.playing).toBe(false);
      expect(continuation).toHaveBeenCalledTimes(reason==='error'?0:1);
    }
  }finally{releaseReply();Media.reset();runtime.stopBoundsFeeder();host.quit();}
});
