// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../src/ui.js',()=>({renderCurrentTimecode:vi.fn(),setStatus:vi.fn(),showToast:vi.fn(),showOsd:vi.fn(),openModal:vi.fn(),closeModal:vi.fn()}));
vi.mock('../src/timeline-renderer.js',()=>({drawTimeline:vi.fn(),updatePlayhead:vi.fn()}));

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const node=()=>({connect:vi.fn(),disconnect:vi.fn()});

afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

it.each(['single','rapid'])('mpv 播放中 %s 跳轉前先停止外部音訊，畫格就緒後才從目標起播',async action=>{
  vi.resetModules();
  document.body.innerHTML=readFileSync('index.html','utf8');
  const video=document.getElementById('video');
  video.pause=vi.fn();video.play=vi.fn(async()=>{});video.load=vi.fn();
  const trace=[],presented=deferred(),latest=deferred();
  class AudioElement extends EventTarget{
    constructor(){super();this.src='file:///voice.wav';this._time=0;this.duration=12;this.readyState=1;this.paused=true;this.playbackRate=1;}
    get currentTime(){return this._time;}
    set currentTime(value){trace.push({type:'seek',value,paused:this.paused});this._time=value;}
    play=vi.fn(async()=>{this.paused=false;trace.push({type:'play',value:this._time});});
    pause=vi.fn(()=>{this.paused=true;trace.push({type:'pause'});});
    load=vi.fn();
  }
  const context={state:'running',currentTime:0,destination:{},resume:vi.fn(),
    createGain:()=>({...node(),gain:{value:1,cancelScheduledValues:vi.fn(),setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn()}}),
    createAnalyser:()=>({...node(),fftSize:2048,getFloatTimeDomainData:buf=>buf.fill(0)}),
    createMediaElementSource:()=>node(),createChannelSplitter:()=>node(),createChannelMerger:()=>node()};
  window.AudioContext=function(){return context;};vi.stubGlobal('Audio',AudioElement);
  const mpv={launch:vi.fn(async()=>({ok:true,duration:12,sourceSessionId:'mpv-test-source'})),play:vi.fn(async()=>{}),
    pause:vi.fn(async()=>trace.push({type:'mpv-pause'})),present:vi.fn(time=>time===6?latest.promise:presented.promise),
    mute:vi.fn(async()=>{}),quit:vi.fn(async()=>{})};
  const desktop={isDesktop:true,mpv};
  Object.defineProperty(window,'subtool',{configurable:true,value:desktop});
  const {Media}=await import('../src/media.js');
  const {State,resetAudioProject}=await import('../src/state.js');
  const {activateMpvTransport}=await import('../src/media-player-adapter.js');
  const {Seq}=await import('../src/sequence.js');
  try{
    Media.reset();resetAudioProject();State.duration=12;State.fps=25;State.dropFrame=false;
    const runtime=activateMpvTransport(desktop,video);await runtime.enterMpv({src:'C:/source.mov'});
    expect(runtime.ownsNativeSourceSession('mpv-test-source')).toBe(true);
    expect(runtime.ownsNativeSourcePath('C:/source.mov')).toBe(true);
    const clip=Seq.add({id:'video-primary',name:'source.mov',path:'C:/source.mov',primary:true,
      dur:12,in:0,out:12,offset:0,vtrack:0,audioSrc:'video',audioSourceId:'video-primary'});
    Media.activeClipId=clip.id;Media._mpvPath=clip.path;
    const asset=Media.createExternalAudioSource({name:'voice.wav',path:'C:/voice.wav',duration:12});
    const el=new AudioElement();
    Media.ensureCtx();Media.tracks.push({kind:'element',source:asset.audioSrc,audioSourceId:asset.audioSourceId,
      sourceStream:0,sourceChannel:0,gain:context.createGain(),muted:false,solo:false,volume:1,el});
    Media.play();
    await vi.waitFor(()=>expect(el.paused).toBe(false));
    expect(mpv.play).toHaveBeenCalledOnce();
    trace.length=0;
    const pending=Media.seek(4);
    expect(trace.find(item=>item.type==='seek')).toMatchObject({value:4,paused:true});
    expect(el.paused).toBe(true);
    expect(trace.filter(item=>item.type==='play')).toEqual([]);
    // 與真 mpv launch 契約相同：來源 session 已接管後才送出定位。
    await vi.waitFor(()=>expect(mpv.present).toHaveBeenCalledTimes(1));
    let pendingLatest;
    if(action==='rapid'){
      pendingLatest=Media.seek(6);
      expect(trace.filter(item=>item.type==='seek').at(-1)).toMatchObject({value:6,paused:true});
      expect(el.paused).toBe(true);
    }
    presented.resolve({backend:'mpv',presentedSourceTime:4});
    expect(await pending).toMatchObject({status:'presented',requestedTime:4,presentedTime:4});
    if(pendingLatest){
      expect(trace.filter(item=>item.type==='play')).toEqual([]);
      await vi.waitFor(()=>expect(mpv.present).toHaveBeenCalledTimes(2));
      latest.resolve({backend:'mpv',presentedSourceTime:6});
      expect(await pendingLatest).toMatchObject({status:'presented',requestedTime:6,presentedTime:6});
    }
    await vi.waitFor(()=>expect(el.paused).toBe(false));
    expect(trace.filter(item=>item.type==='play')).toEqual([{type:'play',value:action==='rapid'?6:4}]);
  }finally{presented.resolve({backend:'mpv',presentedSourceTime:4});latest.resolve({backend:'mpv',presentedSourceTime:6});Media.reset();delete window.subtool;}
});
