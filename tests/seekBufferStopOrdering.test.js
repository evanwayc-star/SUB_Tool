// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../src/ui.js',()=>({setStatus:vi.fn(),showToast:vi.fn(),showOsd:vi.fn(),openModal:vi.fn(),closeModal:vi.fn()}));
vi.mock('../src/timeline-renderer.js',()=>({drawTimeline:vi.fn(),updatePlayhead:vi.fn()}));
const node=()=>({connect:vi.fn(),disconnect:vi.fn()});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

it('播放中跳轉的同步通知期間，先前 buffer 聲音已停止',async()=>{
  vi.resetModules();document.body.innerHTML=readFileSync('index.html','utf8');
  const video=document.getElementById('video');video.pause=vi.fn();video.play=vi.fn(async()=>{});video.load=vi.fn();
  const active=new Set(),sourceSamples=new Float32Array(120).fill(.5);
  const buffer={duration:12,length:120,sampleRate:10,numberOfChannels:1,getChannelData:()=>sourceSamples};
  const context={state:'running',currentTime:0,destination:{},resume:vi.fn(),
    createGain:()=>({...node(),gain:{value:1,cancelScheduledValues:vi.fn(),setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn()}}),
    createAnalyser:()=>({...node(),fftSize:2048,getFloatTimeDomainData:buf=>buf.fill(0)}),
    createMediaElementSource:()=>node(),createChannelSplitter:()=>node(),createChannelMerger:()=>node(),
    createBufferSource:()=>{
      const voice={...node(),playbackRate:{value:1},buffer:null,offset:0,
        start(unused,offset){this.offset=offset;active.add(this);},stop(){active.delete(this);}};
      return voice;
    }};
  const sample=()=>[...active].reduce((sum,voice)=>sum+(voice.buffer?.getChannelData(0)[Math.floor(voice.offset*10)]||0),0);
  window.AudioContext=function(){return context;};
  const mpv={launch:vi.fn(async()=>({ok:true,duration:12,sourceSessionId:'source-session'})),play:vi.fn(async()=>{}),pause:vi.fn(async()=>{}),
    present:vi.fn(time=>Promise.resolve({backend:'mpv',presentedSourceTime:time})),mute:vi.fn(async()=>{}),quit:vi.fn(async()=>{})};
  const desktop={isDesktop:true,mpv};Object.defineProperty(window,'subtool',{configurable:true,value:desktop});
  const {Media}=await import('../src/media.js');const {State,resetAudioProject,ensureAudioSourceMap}=await import('../src/state.js');
  const {Seq}=await import('../src/sequence.js');const {activateMpvTransport}=await import('../src/media-player-adapter.js');
  let during;
  const observed=()=>{const start=performance.now();do{during=sample();}while(performance.now()-start<10);};
  try{
    Media.reset();resetAudioProject();State.duration=12;State.fps=25;State.dropFrame=false;
    const runtime=activateMpvTransport(desktop,video);await runtime.enterMpv({src:'C:/source.mov'});
    const clip=Seq.add({id:'main',name:'source.mov',path:'C:/source.mov',primary:true,
      dur:12,in:0,out:12,offset:0,vtrack:0,audioSrc:'video',audioSourceId:'main'});
    Media.activeClipId=clip.id;Media._mpvPath=clip.path;
    expect(runtime.ownsNativeSourcePath(clip.path)).toBe(true);
    ensureAudioSourceMap(clip.audioSourceId,[{sourceStream:0,sourceChannel:0}]);
    Media.ensureCtx();Media.tracks.push({kind:'buffer',source:'video',audioSourceId:clip.audioSourceId,
      sourceStream:0,sourceChannel:0,gain:context.createGain(),muted:false,solo:false,volume:1,buffer});
    Media.play();await vi.waitFor(()=>expect(sample()).toBeGreaterThan(0));
    window.addEventListener('mpv:seeked',observed,{once:true});
    const pending=Media.seek(4);
    expect(during).toBe(0);
    await expect(pending).resolves.toMatchObject({status:'presented',presentedTime:4,source:'mpv'});
    expect(mpv.present).toHaveBeenCalledWith(4,expect.any(Object));
    await vi.waitFor(()=>expect(sample()).toBe(.5));
  }finally{window.removeEventListener('mpv:seeked',observed);Media.reset();delete window.subtool;}
});
