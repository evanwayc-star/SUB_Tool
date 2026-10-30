// @subtool-ci windows
// @vitest-environment jsdom
import {readFileSync,existsSync,mkdtempSync,rmSync,realpathSync,openSync,readSync,writeSync,closeSync,statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {beforeAll,beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {nativeTestTools} from './fixtures/native-tools.cjs';

vi.mock('../src/ui.js',()=>({setStatus:vi.fn(),showToast:vi.fn(),showOsd:vi.fn(),openModal:vi.fn(),closeModal:vi.fn()}));
vi.mock('../src/timeline-renderer.js',()=>({drawTimeline:vi.fn(),updatePlayhead:vi.fn()}));
vi.mock('../src/mixer.js',()=>({renderAudioTracks:vi.fn(),clearMeterStrips:vi.fn()}));

const {ffmpeg}=nativeTestTools();
const node=()=>({connect:vi.fn(),disconnect:vi.fn()});
const context={state:'running',currentTime:0,destination:{},resume:vi.fn(),
  createGain:()=>({...node(),gain:{value:1}}),
  createAnalyser:()=>({...node(),fftSize:2048,getFloatTimeDomainData:buffer=>buffer.fill(0)}),
  createMediaElementSource:()=>({...node(),channelCount:1}),createChannelSplitter:node,createChannelMerger:node,
};
const files=new Map(),directories=[],audios=[];
let Media,State,resetAudioProject,getPlayerAdapter,resetPlayerAdapter,video,rawTime,rawDuration,videoUrl,urlCount;

class OriginalMedia extends EventTarget{
  constructor(){super();this.url='';this.readyState=1;this.paused=true;this.playbackRate=1;this.current=0;this.end=0;audios.push(this);}
  get src(){return this.url;}
  set src(url){this.url=url;this.info=files.get(url);this.end=this.info?.initialDuration||0;this.current=0;
    queueMicrotask(()=>{this.onloadedmetadata?.();this.dispatchEvent(new Event('loadedmetadata'));});}
  get duration(){return this.end;}
  get currentTime(){return this.current;}
  set currentTime(target){this.current=Math.min(target,this.end||target);
    if(target>this.end&&this.info&&!this.info.holdDuration)queueMicrotask(()=>{
      this.end=this.info.rawEnd;this.dispatchEvent(new Event('durationchange'));
    });}
  play=vi.fn(async()=>{this.paused=false;});pause=vi.fn(()=>{this.paused=true;});load=vi.fn();
  removeAttribute(name){if(name==='src')this.src='';}
}

function fixture({audioOnly=false,extension='mov',origin=5,audioLength=3.5,tailMoov=false,sourceFps=30,vfr=false}={}){
  const directory=mkdtempSync(path.join(realpathSync(tmpdir()),'subtool-web-clock-'));directories.push(directory);
  const file=path.join(directory,'mother.'+extension);
  const args=audioOnly
    ?['-itsoffset',String(origin),'-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=3','-c:a',extension==='mov'?'pcm_s16le':extension==='webm'?'libopus':'aac']
    :['-itsoffset',String(origin+.5),'-f','lavfi','-i',`testsrc2=size=64x48:rate=${sourceFps}:duration=3`,
      '-itsoffset',String(origin),'-f','lavfi','-i',`sine=frequency=440:sample_rate=48000:duration=${audioLength}`,
      '-map','0:v','-map','1:a',...(vfr?['-vf',"select='not(mod(n,4))+eq(mod(n,4),1)'"]:[]),'-fps_mode',vfr?'vfr':'passthrough','-c:v',extension==='webm'?'libvpx-vp9':'libx264','-bf','3','-c:a',extension==='webm'?'libopus':'pcm_s16le'];
  const result=spawnSync(ffmpeg,['-hide_banner','-nostdin','-loglevel','error','-y',...args,...(tailMoov?[]:['-movflags','+faststart']),file],{windowsHide:true,timeout:20000});
  expect(result.error||result.status,result.stderr?.toString()).toBe(0);
  if(tailMoov){
    const original=readFileSync(file);let offset=0;
    while(offset<original.length&&original.toString('ascii',offset+4,offset+8)!=='moov')offset+=original.readUInt32BE(offset);
    expect(offset).toBeLessThan(original.length);
    const padding=500*1024*1024+1024-original.length,header=Buffer.alloc(8),handle=openSync(file,'r+');
    header.writeUInt32BE(padding);header.write('free',4);
    try{writeSync(handle,header,0,8,offset);writeSync(handle,original.subarray(offset),0,original.length-offset,offset+padding);}
    finally{closeSync(handle);}
  }
  // Byte transport and DOM are the adapters. Intake, mp4box, source index,
  // clock registration, deferred seek and all project placements stay real.
  const first=audioOnly?(extension==='m4a'?4.978:extension==='webm'?4.9945:origin):origin+.5;
  const rawEnd=(audioOnly?origin+3:Math.max(origin+3.5,origin+audioLength))+(extension==='webm'?.008:0);
  return {name:path.basename(file),size:tailMoov?statSync(file).size:600_000_000,
    ...(tailMoov?{path:file}:{bytes:readFileSync(file)}),initialDuration:audioOnly?3:3.5,
    rawEnd,first,sourceDuration:rawEnd-first};
}

beforeAll(async()=>{
  delete window.subtool;document.body.innerHTML=readFileSync('index.html','utf8');video=document.getElementById('video');
  Object.defineProperties(video,{
    src:{configurable:true,get:()=>videoUrl,set:url=>{videoUrl=url;video.setAttribute('src',url);rawTime=0;rawDuration=files.get(url)?.initialDuration||0;}},
    currentTime:{configurable:true,get:()=>rawTime,set:target=>{rawTime=Math.min(target,rawDuration||target);
      const info=files.get(videoUrl);if(info&&target>rawDuration)queueMicrotask(()=>{rawDuration=info.rawEnd;video.dispatchEvent(new Event('durationchange'));});}},
    duration:{configurable:true,get:()=>rawDuration},readyState:{configurable:true,value:1},
    videoWidth:{configurable:true,value:64},videoHeight:{configurable:true,value:48},
  });
  video.pause=vi.fn();video.play=vi.fn(async()=>{});video.load=vi.fn();
  video.requestVideoFrameCallback=callback=>{queueMicrotask(()=>callback(0,{mediaTime:video.currentTime}));return 1;};
  video.cancelVideoFrameCallback=vi.fn();
  window.AudioContext=function(){return context;};
  ({Media}=await import('../src/media.js'));({State,resetAudioProject}=await import('../src/state.js'));
  ({getPlayerAdapter,resetPlayerAdapter}=await import('../src/media-player-adapter.js'));
});
beforeEach(()=>{
  files.clear();audios.length=0;urlCount=0;Media.reset();resetAudioProject();State.clips=[];State.duration=0;State.fps=30;State.dropFrame=false;
  videoUrl='';rawTime=0;rawDuration=0;resetPlayerAdapter(null,video);Media.ensureCtx();
  vi.stubGlobal('Audio',OriginalMedia);
  vi.spyOn(URL,'createObjectURL').mockImplementation(file=>{const url=`blob:web-clock-${++urlCount}`;files.set(url,file);return url;});
  vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
  const create=document.createElement.bind(document);
  vi.spyOn(document,'createElement').mockImplementation((tag,options)=>tag==='video'?new OriginalMedia():create(tag,options));
  vi.stubGlobal('fetch',vi.fn(async(url,{headers}={})=>{
    const range=/bytes=(\d+)-(\d+)/.exec(headers?.Range||'');
    if(!range)throw new Error('metadata must use bounded Range');
    const source=files.get(url);if(!source)throw new Error('unsupported source');
    let part;
    if(source.path){
      const start=Number(range[1]),end=Math.min(source.size,Number(range[2])+1),handle=openSync(source.path,'r');
      part=Buffer.alloc(Math.max(0,end-start));
      try{readSync(handle,part,0,part.length,start);}finally{closeSync(handle);}
    }else part=source.bytes.subarray(Number(range[1]),Number(range[2])+1);
    return new Response(part,{status:206});
  }));
  vi.spyOn(Media,'probeAndMaybeExtract').mockResolvedValue(true);
});
afterEach(()=>{
  Media.reset();vi.restoreAllMocks();vi.unstubAllGlobals();
  for(const directory of directories.splice(0)){
    const resolved=realpathSync(directory);
    if(path.dirname(resolved)!==realpathSync(tmpdir())||!path.basename(resolved).startsWith('subtool-web-clock-'))throw new Error('web clock cleanup boundary');
    rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
});

describe.skipIf(!existsSync(ffmpeg))('web原始File public intake使用真header/sample來源時鐘',()=>{
  it('ordinary-speed VFR File uses its long covering frame without widening strict project tolerance',async()=>{
    const file=fixture({sourceFps:50,vfr:true});await Media.loadVideoFile(file);
    State.fps=25;Object.assign(State.clips[0],{speed:1,reverse:false});
    const result=await Media.seek(.04,{presentationTolerance:.45/25});
    expect(result).toMatchObject({status:'presented',presentedTime:.04});
    expect(video.currentTime).toBeCloseTo(getPlayerAdapter().playerTime(.02),10);
    expect(Media.displayTime()).toBe(.04);
  });
  it('ordinary 25FPS File on a 30FPS project presents the actual covering source frame under strict stepping',async()=>{
    const file=fixture({sourceFps:25});await Media.loadVideoFile(file);
    State.fps=30;State.clips[0].fps=25;
    const target=1/30;
    const result=await Media.seek(target,{presentationTolerance:.45/30});
    expect(result).toMatchObject({status:'presented',presentedTime:target});
    const first=getPlayerAdapter().playerTime(0);
    expect(video.currentTime).toBe(first);expect(Media.displayTime()).toBe(target);
    const callbacks=[];const original=video.requestVideoFrameCallback;
    video.requestVideoFrameCallback=callback=>{callbacks.push(callback);return 1;};
    try{
      const next=Media.seek(2/30,{presentationTolerance:.45/30});
      await vi.waitFor(()=>expect(callbacks).toHaveLength(1));
      callbacks.shift()(0,{mediaTime:first});await Promise.resolve();
      expect(Media.presentationPending()).toBe(true);
      callbacks.shift()(0,{mediaTime:first+.04});
      await expect(next).resolves.toMatchObject({status:'presented',presentedTime:2/30});
    }finally{video.requestVideoFrameCallback=original;}
  });
  it('真500MiB tail-moov File primary/additional/audio入口使用相同clock，只讀小範圍索引',async()=>{
    const file=fixture({tailMoov:true});expect(file.size).toBeGreaterThan(500*1024*1024);
    await Media.loadVideoFile(file);
    expect(State.duration).toBe(3);expect(State.clips[0].out).toBe(3);expect(Media.vTime()).toBe(0);expect(video.currentTime).toBe(5.5);
    const presentation=await Media.seek(2.8);expect(presentation.status).toBe('presented');expect(video.currentTime).toBe(8.3);
    const additional=await Media.addClipWeb(file);expect(additional.in).toBe(0);expect(additional.out).toBe(3);expect(additional.offset).toBeCloseTo(2.8,10);
    const asset=await Media.addAudioFile(file),element=Media.sourceChannels(asset.audioSrc)[0].el;
    expect(asset.duration).toBe(3);expect(element.currentTime).toBe(5.5);
    const reads=fetch.mock.calls.map(([,options])=>/bytes=(\d+)-(\d+)/.exec(options.headers.Range));
    expect(reads.some(match=>Number(match[1])>500*1024*1024-64*1024)).toBe(true);
    expect(reads.reduce((sum,match)=>sum+Number(match[2])-Number(match[1])+1,0)).toBeLessThan(1024*1024);
  });

  it.each(['mov','webm'].flatMap(extension=>[3.5,5].map(audioLength=>({extension,audioLength}))))('primary與additional原始$extension保留audio長度$audioLength，來源零點與seek一致',async({extension,audioLength})=>{
    const file=fixture({extension,audioLength});
    await Media.loadVideoFile(file);
    const adapter=getPlayerAdapter(),primary=State.clips[0];
    expect(adapter.sourceClock(video.src).timestampOffset).toBe(-5.5);
    expect(video.currentTime).toBe(5.5);expect(Media.vTime()).toBe(0);
    expect(primary.in).toBe(0);expect(primary.out).toBe(file.sourceDuration);expect(State.duration).toBe(file.sourceDuration);
    const presentation=await Media.seek(2.8);expect(presentation.status).toBe('presented');
    expect(video.currentTime).toBe(8.3);expect(Media.vTime()).toBeCloseTo(2.8,10);
    const additional=await Media.addClipWeb(file);
    expect(additional.dur).toBe(file.sourceDuration);expect(additional.in).toBe(0);expect(additional.out).toBe(file.sourceDuration);
    expect(additional.offset).toBeCloseTo(2.8,10);
    const audio=Media.sourceChannels(additional.audioSrc)[0].el;
    await adapter.seekElement(audio,1);expect(audio.currentTime).toBe(6.5);expect(adapter.sourceTime(audio.currentTime,audio.src)).toBe(1);
    adapter.registerSourceClock('blob:processed-proxy',null);expect(adapter.playerTime(1,'blob:processed-proxy')).toBe(1);
  });

  it.each(['mov','m4a','webm'])('audio-only %s從空專案匯入，原點歸零且後續asset offset依真external library',async extension=>{
    const file=fixture({audioOnly:true,extension}),adapter=getPlayerAdapter();
    expect(State).not.toHaveProperty('audioSources');
    const asset=await Media.addAudioFile(file),element=Media.sourceChannels(asset.audioSrc)[0].el;
    expect(asset.offset).toBe(0);expect(asset.duration).toBe(file.sourceDuration);expect(asset.out).toBe(file.sourceDuration);
    expect(element.currentTime).toBe(file.first);expect(adapter.sourceTime(element.currentTime,element.src)).toBe(0);
    await adapter.seekElement(element,1);expect(element.currentTime).toBe(file.first+1);
    await Media.seek(1.2);
    const second=await Media.addAudioFile(file);expect(second.offset).toBe(1.2);
  });

  it('影片容器直接作外部音訊仍使用共同video零點，保留video前半秒音訊的相位',async()=>{
    const file=fixture(),asset=await Media.addAudioFile(file),adapter=getPlayerAdapter();
    const element=Media.sourceChannels(asset.audioSrc)[0].el;
    expect(asset.duration).toBe(3);expect(element.currentTime).toBe(5.5);
    await adapter.seekElement(element,2.8);expect(element.currentTime).toBe(8.3);
  });

  it('reset取消尚未commit的initial audio epoch seek，晚到duration不能重新seek或建立asset',async()=>{
    const file=fixture({audioOnly:true});file.holdDuration=true;
    const pending=Media.addAudioFile(file);
    await vi.waitFor(()=>expect(audios.some(element=>element.currentTime===3)).toBe(true));
    const element=audios.find(item=>item.currentTime===3);
    Media.reset();await expect(pending).resolves.toBeNull();
    expect(element.src).toBe('');expect(Media.externalAudioSources).toEqual([]);expect(Media.tracks).toEqual([]);
    element.end=8;element.dispatchEvent(new Event('durationchange'));
    expect(element.currentTime).toBe(0);
  });
});
