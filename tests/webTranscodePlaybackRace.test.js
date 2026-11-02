// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';

const dom=vi.hoisted(()=>{
  const video={style:{},src:'',readyState:1,duration:10,videoWidth:1920,videoHeight:1080,
    playbackRate:1,currentTime:0,muted:false,hasAttribute:()=>false,pause:vi.fn()};
  const elements=new Map();
  return {video,sublist:null,tlScroll:null,tlLayer:null,tlTracks:null,rulerCv:null,imageLayer:null,
    $(id){if(!elements.has(id))elements.set(id,{style:{},textContent:'',innerHTML:'',value:'',
      classList:{add:vi.fn(),remove:vi.fn()},addEventListener:vi.fn(),removeEventListener:vi.fn(),
      querySelectorAll:()=>[],getBoundingClientRect:()=>({left:0,top:0,width:640,height:360})});return elements.get(id);}};
});
vi.mock('../src/dom.js',()=>dom);
vi.mock('../src/ui.js',()=>new Proxy({renderCurrentTimecode:vi.fn(),setStatus:vi.fn(),showToast:vi.fn(),openModal:vi.fn(),closeModal:vi.fn()},
  {get:(target,key)=>key==='then'?undefined:(target[key]||vi.fn())}));
vi.mock('../src/timeline-renderer.js',()=>new Proxy({drawTimeline:vi.fn(),updatePlayhead:vi.fn()},
  {get:(target,key)=>key==='then'?undefined:(target[key]||vi.fn())}));
vi.mock('../src/mixer.js',()=>({renderAudioTracks:vi.fn(),clearMeterStrips:vi.fn()}));
vi.mock('../src/decode/source-frame-index.js',async importOriginal=>({
  ...await importOriginal(),sourcePresentationMetadata:vi.fn(async()=>null),
}));

it.each(['playing','existing','switch-other','paused','seek-pending','replaced','event-replace','timeline-replace','notify-pause'])(
  '非原生影片背景抽音完成時，%s 的播放資格決定是否從目前位置啟動',async scenario=>{
  vi.resetModules();delete window.subtool;
  const starts=[],nodes=[],gain=()=>({connect:vi.fn(),disconnect:vi.fn(),gain:{value:1}});
  window.AudioContext=class {
    constructor(){this.state='running';this.destination={};this.currentTime=0;}
    createGain(){return gain();}
    createAnalyser(){return {connect:vi.fn(),disconnect:vi.fn(),fftSize:0};}
    createBuffer(_channels,length,sampleRate){const data=new Float32Array(length);return {numberOfChannels:1,length,sampleRate,duration:length/sampleRate,getChannelData:()=>data};}
    createBufferSource(){const node={buffer:null,playbackRate:{value:1},connect:vi.fn(),disconnect:vi.fn(),stop:vi.fn(),
      start:vi.fn((...args)=>starts.push({args,buffer:node.buffer}))};nodes.push(node);return node;}
    resume(){}
  };
  const {Media}=await import('../src/media.js');
  const {State,resetAudioProject}=await import('../src/state.js');
  const {Seq}=await import('../src/sequence.js');
  const {AudioEngine}=await import('../src/audio-engine.js');
  const {on}=await import('../src/events.js');
  Media.reset();Media.ctx=null;Media.master=null;Media.tracks=[];
  State.cues=[];State.clips=[];State.mediaPath=null;resetAudioProject();
  dom.video.currentTime=0;
  const createDescriptor=Object.getOwnPropertyDescriptor(URL,'createObjectURL');
  const revokeDescriptor=Object.getOwnPropertyDescriptor(URL,'revokeObjectURL');
  Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(()=> 'blob:transcoded')});
  Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()});
  let logger=()=>{},releaseExtraction,signalExtraction,owned=true;
  const gate=new Promise(resolve=>{releaseExtraction=resolve;});
  const started=new Promise(resolve=>{signalExtraction=resolve;});
  const ff={setLogger:vi.fn(value=>{logger=value;}),FS:vi.fn(action=>action==='readFile'?new Uint8Array([0,1,2,3]):undefined),
    run:vi.fn(async(...args)=>{
      if(args.length===2)logger({message:'Stream #0:1: Audio: aac'});
      if(args.at(-1)==='a0.wav'){signalExtraction();await gate;}
    })};
  vi.spyOn(Media,'_loadFFmpegForIntake').mockResolvedValue(ff);
  vi.spyOn(AudioEngine,'readSourceAudioClock').mockResolvedValue({duration:10});
  const buffer={numberOfChannels:2,length:480000,sampleRate:48000,duration:10,getChannelData:()=>new Float32Array(480000)};
  vi.spyOn(AudioEngine,'decodeSourceAudioData').mockResolvedValue(buffer);
  vi.spyOn(Media,'attachMeter').mockImplementation(()=>{});
  vi.spyOn(Media,'_commitOriginalWave').mockImplementation(()=>{});
  vi.spyOn(Media,'tlTime').mockImplementation(()=>scenario==='switch-other'?dom.video.currentTime+5:dom.video.currentTime);
  vi.spyOn(Media,'vTime').mockImplementation(()=>dom.video.currentTime);
  vi.spyOn(Media,'playbackTransitionPending').mockImplementation(()=>scenario==='seek-pending');
  const start=vi.spyOn(Media,'startBufferSources');
  if(scenario==='event-replace') on('audio:sourceRegistered',()=>{owned=false;Media.reset();Media.playing=true;});
  try{
    const file=new File([new Uint8Array([1,2,3,4])],'source.mxf',{type:'video/x-mxf'});
    const pending=Media._transcodeAndExtract(file,null,{owns:()=>owned});
    await started;
    if(scenario==='timeline-replace') on('media:timeline',()=>{if(owned){owned=false;Media.reset();Media.playing=true;}});
    if(scenario==='notify-pause') on('media:audioTracks',()=>{Media.playing=false;});
    // The video-only Proxy is already present; move while extraction waits.
    dom.video.currentTime=4.25;
    Media.playing=scenario!=='paused';
    if(scenario==='existing'){
      const clip=State.clips[0];
      Media.tracks.push({kind:'buffer',source:'video',audioSourceId:clip.audioSourceId,
        sourceStream:0,sourceChannel:0,buffer,gain:gain(),volume:1});
      Media.startBufferSources(4.25);
      expect(starts).toHaveLength(1);
      starts.length=0;start.mockClear();
    }
    let otherBuffer;
    if(scenario==='switch-other'){
      State.clips[0].out=5;
      const other=Seq.add({name:'另一來源',path:'C:/other.mov',dur:10,in:0,out:10,offset:5,
        audioSourceId:'other-source',audioSrc:'clip:other'});
      Media.activeClipId=other.id;dom.video.currentTime=1.25;
      otherBuffer={...buffer};
      Media.tracks.push({kind:'buffer',source:'clip:other',audioSourceId:'other-source',
        sourceStream:0,sourceChannel:0,buffer:otherBuffer,gain:gain(),volume:1});
    }
    if(scenario==='replaced'){owned=false;Media.reset();Media.playing=true;}
    releaseExtraction();
    const result=await pending;
    if(scenario==='replaced'||scenario==='event-replace'||scenario==='timeline-replace'){
      expect(result).toBe(false);expect(start).not.toHaveBeenCalled();expect(starts).toEqual([]);return;
    }
    expect(result).toBe(true);
    expect(Media.tracks.filter(track=>track.kind==='buffer')).toHaveLength(scenario==='switch-other'?3:2);
    if(scenario==='playing'||scenario==='existing'){
      expect(start).toHaveBeenCalledOnce();expect(start).toHaveBeenCalledWith(4.25);
      expect(starts).toHaveLength(2);
      for(const started of starts)expect(started.args[1]).toBeCloseTo(4.25);
      if(scenario==='existing')expect(nodes[0].stop).toHaveBeenCalledOnce();
    }else if(scenario==='switch-other'){
      expect(start).toHaveBeenCalledOnce();expect(start).toHaveBeenCalledWith(1.25);
      expect(starts).toHaveLength(1);expect(starts[0].buffer).toBe(otherBuffer);
      expect(starts[0].args[1]).toBeCloseTo(1.25);
    }else{
      expect(starts).toEqual([]);
      if(scenario==='paused'||scenario==='notify-pause')expect(start).not.toHaveBeenCalled();
    }
  }finally{
    releaseExtraction();Media.reset();vi.restoreAllMocks();
    if(createDescriptor)Object.defineProperty(URL,'createObjectURL',createDescriptor);else delete URL.createObjectURL;
    if(revokeDescriptor)Object.defineProperty(URL,'revokeObjectURL',revokeDescriptor);else delete URL.revokeObjectURL;
  }
});
