// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';

const dom = vi.hoisted(() => {
  const video = { style: {}, src: '', readyState: 1, duration: 10, videoWidth: 1920, videoHeight: 1080,
    playbackRate: 1, currentTime: 0, muted: false, hasAttribute: () => false, pause: vi.fn() };
  const elements = new Map();
  return { video, sublist: null, tlScroll: null, tlLayer: null, tlTracks: null, rulerCv: null, imageLayer: null,
    $(id) {
      if (!elements.has(id)) elements.set(id, { style: {}, textContent: '', innerHTML: '', value: '',
        classList: { add: vi.fn(), remove: vi.fn() }, addEventListener: vi.fn(), removeEventListener: vi.fn(),
        querySelectorAll: () => [], getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }) });
      return elements.get(id);
    } };
});
vi.mock('../src/dom.js', () => dom);
vi.mock('../src/ui.js', () => new Proxy({ renderCurrentTimecode: vi.fn(), setStatus: vi.fn(), showToast: vi.fn(), openModal: vi.fn(), closeModal: vi.fn() }, {
  get: (target, key) => key === 'then' ? undefined : (target[key] || vi.fn()),
}));
vi.mock('../src/timeline-renderer.js', () => new Proxy({ drawTimeline: vi.fn(), updatePlayhead: vi.fn() }, {
  get: (target, key) => key === 'then' ? undefined : (target[key] || vi.fn()),
}));
vi.mock('../src/mixer.js', () => ({ renderAudioTracks: vi.fn(), clearMeterStrips: vi.fn() }));

it.each([
  {legacy:false, edit:null},
  {legacy:true, edit:null},
  {legacy:true, edit:'subtitle'},
  {legacy:true, edit:'routing'},
  {legacy:true, edit:'routing-before'},
  {legacy:true, edit:'save'},
  {legacy:true, edit:'different-name'},
  {legacy:true, edit:'unknown-size'},
  {legacy:true, edit:null, actualDuration:12},
])('網頁重連來源 FPS 與舊式配線：$legacy，等待期間 $edit，來源長度 $actualDuration', async ({legacy,edit,actualDuration=10}) => {
  delete window.subtool;
  window.AudioContext = class {
    constructor(){ this.state = 'running'; this.destination = {}; this.currentTime = 0; }
    createGain(){ return { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } }; }
    createAnalyser(){ return { connect: vi.fn(), fftSize: 0 }; }
    resume(){}
  };
  const { Media }=await import('../src/media.js');
  const { State, resetAudioProject, setFps }=await import('../src/state.js');
  const util=await import('../src/util.js');
  const download=vi.spyOn(util,'downloadBytes').mockImplementation(()=>{});
  const { Project, isProjectDirty }=await import('../src/project.js');
  const { History }=await import('../src/history.js');
  Media.reset(); Media.ctx=null; Media.master=null; Media.tracks=[];
  dom.video.duration=actualDuration;
  State.cues=[];State.clips=[];State.mediaPath=null;resetAudioProject();
  let releaseProbe,signalProbe;
  const waiting=new Promise(resolve=>{releaseProbe=resolve;}),started=new Promise(resolve=>{signalProbe=resolve;});
  vi.spyOn(Media,'probeAndMaybeExtract').mockImplementation(async()=>{signalProbe();await waiting;});
  vi.spyOn(Media,'_connectStereo').mockReturnValue([]);
  const originalCreate=document.createElement.bind(document),probes=[],callbacks=[];
  const createDescriptor=Object.getOwnPropertyDescriptor(URL,'createObjectURL');
  const revokeDescriptor=Object.getOwnPropertyDescriptor(URL,'revokeObjectURL');
  const frameDescriptor=Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype,'requestVideoFrameCallback');
  let nextUrl=0;
  Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(()=>`blob:fps-${++nextUrl}`)});
  Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()});
  Object.defineProperty(HTMLVideoElement.prototype,'requestVideoFrameCallback',{configurable:true,value:()=>1});
  dom.video.requestVideoFrameCallback=callback=>{callbacks.push(callback);return callbacks.length;};
  vi.spyOn(document,'createElement').mockImplementation(tag=>{
    if(tag!=='video')return originalCreate(tag);
    const probe={readyState:0,onloadedmetadata:null,onerror:null};probes.push(probe);return probe;
  });
  try{
    vi.spyOn(Project,'_checkMissingFonts').mockResolvedValue([]);
    const data={version:3,fps:25,duration:10,media:{name:'A.mp4',size:2_000_000_000},
      tracks:[{name:'字幕',visible:true}],cues:[{start:1,end:2,text:'原字幕',track:1}],notes:[],
      clips:[{name:'A.mp4',primary:true,audioSourceId:'asset-original',in:0,out:10,dur:10,offset:0}],
      audioProject:{mode:'auto',buses:[{id:'ab1',name:'音訊軌 1'},{id:'ab2',name:'音訊軌 2'}],
        sourceMaps:{'asset-original':{channels:[{sourceStream:0,sourceChannel:0,busIds:['ab1']},{sourceStream:0,sourceChannel:1,busIds:['ab2']}]}},
        exportLayout:{streams:[{id:'out1',layout:'mono',busIds:['ab1']},{id:'out2',layout:'mono',busIds:['ab2']}]}}};
    if(legacy){ delete data.clips[0].audioSourceId;delete data.audioProject; }
    if(edit==='different-name')data.media.name='OTHER.mp4';
    if(edit==='unknown-size')data.media.size=0;
    await Project.load(new File([JSON.stringify(data)],'project.subtool'));
    const {generation,plan}=Project.pendingMediaRelink();
    if(edit==='routing-before'){State.audioProject.mode='manual';History.record('重連前編輯配線');}
    const loading=Media.loadVideoFile({name:'A.mp4',size:2_000_000_000},plan);
    await vi.waitFor(()=>expect(probes).toHaveLength(1));probes[0].onloadedmetadata();
    await started;
    if(edit==='subtitle'){State.cues[0].text='等待期間編輯';History.record('等待期間編輯');}
    if(edit==='routing'){State.audioProject.buses[0].volume=.5;History.record('等待期間音量編輯');}
    if(edit==='save') await Project.saveAs();
    releaseProbe();
    await loading;await Media.waitForPendingProjectRestore();
    await Project.finishBrowserMediaRelink(generation,plan);
    expect(State.clips[0]).toMatchObject({dur:10,out:10});
    const actualEdit=edit==='subtitle'||edit==='routing'||edit==='routing-before';
    const hasEdit=actualEdit||edit==='different-name'||edit==='unknown-size';
    expect(isProjectDirty()).toBe(hasEdit);
    expect(callbacks).toHaveLength(1);
    for(let frame=0;frame<13;frame++) callbacks[frame](0,{mediaTime:frame/30});
    expect(State.clips[0].fps).toBe(30);
    expect(isProjectDirty()).toBe(hasEdit);
    if(actualEdit){
      History.undo();
      expect(isProjectDirty()).toBe(false);
      History.redo();expect(isProjectDirty()).toBe(true);
      History.undo();
    }
    State.cues[0].text='真實編輯';
    expect(isProjectDirty()).toBe(true);
    State.cues[0].text='原字幕';
    expect(isProjectDirty()).toBe(hasEdit&&!actualEdit);
    await Project.saveAs();
    const bytes=download.mock.calls.at(-1)[0];
    const saved=JSON.parse(Buffer.from(bytes).subarray(2).toString('utf16le'));
    expect(saved.clips[0].fps).toBe(30);
    expect(isProjectDirty()).toBe(false);
    setFps(State.fps===25?'24':'25');
    expect(isProjectDirty()).toBe(true);
  }finally{
    releaseProbe();
    Media.reset();vi.restoreAllMocks();
    if(createDescriptor)Object.defineProperty(URL,'createObjectURL',createDescriptor);else delete URL.createObjectURL;
    if(revokeDescriptor)Object.defineProperty(URL,'revokeObjectURL',revokeDescriptor);else delete URL.revokeObjectURL;
    if(frameDescriptor)Object.defineProperty(HTMLVideoElement.prototype,'requestVideoFrameCallback',frameDescriptor);else delete HTMLVideoElement.prototype.requestVideoFrameCallback;
    delete dom.video.requestVideoFrameCallback;
  }
});
