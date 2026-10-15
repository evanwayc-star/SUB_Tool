// @subtool-ci windows
// @vitest-environment jsdom
import {readFileSync,existsSync,mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {beforeAll,beforeEach,afterEach,it,expect,vi} from 'vitest';
import { nativeTestTools } from './fixtures/native-tools.cjs';

vi.mock('../src/ui.js',()=>({setStatus:vi.fn(),showToast:vi.fn(),showOsd:vi.fn(),openModal:vi.fn(),closeModal:vi.fn()}));
vi.mock('../src/timeline-renderer.js',()=>({drawTimeline:vi.fn(),updatePlayhead:vi.fn()}));
vi.mock('../src/mixer.js',()=>({renderAudioTracks:vi.fn(),clearMeterStrips:vi.fn()}));

const require=createRequire(import.meta.url);
const {createMediaProbe}=require('../electron/media-probe.js');
const { ffmpeg, ffprobe } = nativeTestTools();
const node=()=>({connect:vi.fn(),disconnect:vi.fn()});
const context={state:'running',currentTime:0,destination:{},resume:vi.fn(),
  createGain:()=>({...node(),gain:{value:1}}),
  createAnalyser:()=>({...node(),fftSize:2048,getFloatTimeDomainData:buffer=>buffer.fill(0)}),
  createMediaElementSource:()=>({...node(),channelCount:1}),createChannelSplitter:node,createChannelMerger:node,
};
let Media,State,resetAudioProject,getPlayerAdapter,resetPlayerAdapter,video,probe;
beforeAll(async()=>{
  document.body.innerHTML=readFileSync('index.html','utf8');video=document.getElementById('video');
  for(const [key,value] of Object.entries({duration:0,readyState:1}))Object.defineProperty(video,key,{configurable:true,value});
  video.pause=vi.fn();video.play=vi.fn(async()=>{});video.load=vi.fn();
  window.AudioContext=function(){return context;};
  probe=createMediaProbe({executable:ffprobe});
  Object.defineProperty(window,'subtool',{configurable:true,value:{isDesktop:true,
    probe:file=>probe.describe(file),fileURL:async file=>'file:///'+file}});
  ({Media}=await import('../src/media.js'));({State,resetAudioProject}=await import('../src/state.js'));
  ({getPlayerAdapter,resetPlayerAdapter}=await import('../src/media-player-adapter.js'));
});
beforeEach(()=>{
  Media.reset();resetAudioProject();State.clips=[];State.duration=0;State.fps=30;State.dropFrame=false;
  video.src='';video.currentTime=0;resetPlayerAdapter(null,video);Media.ensureCtx();
});
afterEach(async()=>{Media.reset();vi.restoreAllMocks();vi.unstubAllGlobals();await probe.cancelAllAndWait();probe.resume();});

it.skipIf(!existsSync(ffmpeg)||!existsSync(ffprobe)).each([0,5])
('audio-only 原點%s：真AAC probe經公開桌面匯入回來源0秒，暫時metadata不縮短母素材',async origin=>{
  const directory=mkdtempSync(path.join(realpathSync(tmpdir()),'subtool-placement-audio-origin-'));
  try{
    const file=path.join(directory,'mother.m4a');
    const result=spawnSync(ffmpeg,['-hide_banner','-nostdin','-loglevel','error','-y','-itsoffset',String(origin),
      '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=3','-c:a','aac',file],{windowsHide:true,timeout:20000});
    expect(result.error||result.status,result.stderr?.toString()).toBe(0);
    const info=await probe.describe(file),rawOrigin=-info.audio[0].presentationTimestampOffset;
    expect(info.video).toBeNull();expect(info.audio[0].timestampOffset).toBe(0);
    expect(rawOrigin).toBeCloseTo(origin===0?0:4.978,5);
    class OriginAudio extends EventTarget{
      constructor(){
        super();this.src='';this.duration=info.duration;this.readyState=1;this.paused=true;this.seeks=[];
        let time=0,expanded=false;
        Object.defineProperty(this,'currentTime',{get:()=>time,set:value=>{
          time=Math.min(value,this.duration);this.seeks.push(value);
          if(value>this.duration&&!expanded){
            expanded=true;
            queueMicrotask(()=>{this.duration=rawOrigin+info.duration-.8;this.dispatchEvent(new Event('durationchange'));});
          }
        }});
      }
      play=vi.fn(async()=>{this.paused=false;});pause=vi.fn(()=>{this.paused=true;});load=vi.fn();
    }
    vi.stubGlobal('Audio',OriginAudio);
    const cache=vi.spyOn(Media,'cacheExternalRoutingAudio').mockResolvedValue();
    const asset=await Media.addAudioFileDesktop(file);
    const {showToast}=await import('../src/ui.js');
    expect(asset,JSON.stringify(showToast.mock.calls)).not.toBeNull();
    const element=Media.sourceChannels(asset.audioSrc)[0].el,adapter=getPlayerAdapter();
    expect(element.currentTime).toBeCloseTo(rawOrigin,6);
    expect(adapter.sourceTime(element.currentTime,element.src)).toBeCloseTo(0,6);
    expect(asset.duration).toBeCloseTo(info.duration,6);expect(asset.out).toBeCloseTo(info.duration,6);
    expect(asset.offset).toBe(0);
    expect(cache).toHaveBeenCalledWith(asset,file,info.duration,info.audio);
    vi.spyOn(Media,'displayTime').mockReturnValue(1.2);
    const second=await Media.addAudioFileDesktop(file);
    expect(second.offset).toBe(1.2);expect(second.audioSourceId).not.toBe(asset.audioSourceId);
    Media.startElementSources(1,1);
    await vi.waitFor(()=>expect(element.currentTime).toBeCloseTo(rawOrigin+1,6));
    Media.stopElementSources();element.src='file:///normalized-channel.wav';
    Media.startElementSources(1,1);
    await vi.waitFor(()=>expect(element.currentTime).toBe(1));
  }finally{
    await probe.cancelAllAndWait();
    const resolved=realpathSync(directory);
    if(path.dirname(resolved)!==realpathSync(tmpdir())||!path.basename(resolved).startsWith('subtool-placement-audio-origin-'))throw new Error('audio origin cleanup boundary');
    rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
},30000);

it('快取音訊在空專案首段從0開始，第二段依播放點放置且保持獨立來源',async()=>{
  class CachedAudio extends EventTarget{
    constructor(){super();this.src='';this.duration=4;this.readyState=1;this.currentTime=0;this.paused=true;}
    play=vi.fn(async()=>{this.paused=false;});pause=vi.fn(()=>{this.paused=true;});load=vi.fn();
  }
  vi.stubGlobal('Audio',CachedAudio);
  const prepared={duration:4,channels:[{file:'C:/cache/channel.wav',sourceStream:0,sourceChannel:0}]};
  const first=await Media._addDesktopCachedAudio('C:/source.mxf',null,prepared);
  expect(first.offset).toBe(0);expect(first.preferCache).toBe(true);
  vi.spyOn(Media,'displayTime').mockReturnValue(2.5);
  const second=await Media._addDesktopCachedAudio('C:/source.mxf',null,prepared);
  expect(second.offset).toBe(2.5);expect(second.audioSourceId).not.toBe(first.audioSourceId);
  expect(State.externalAudioState.map(source=>source.offset)).toEqual([0,2.5]);
});

it('reset撤銷尚在等durationchange的原檔initial seek，拒絕晚到metadata並釋放element',async()=>{
  const elements=[];
  class PendingAudio extends EventTarget{
    constructor(){
      super();this.src='';this.duration=3;this.readyState=1;elements.push(this);
      let time=0;Object.defineProperty(this,'currentTime',{get:()=>time,set:value=>{time=Math.min(value,this.duration);}});
    }
    pause=vi.fn();load=vi.fn();
  }
  vi.stubGlobal('Audio',PendingAudio);
  vi.spyOn(window.subtool,'probe').mockResolvedValue({duration:3,video:null,audio:[{channels:1,timestampOffset:0,presentationTimestampOffset:-5}]});
  const pending=Media.addAudioFileDesktop('C:/pending.m4a');
  await vi.waitFor(()=>expect(elements[0]?.currentTime).toBe(3));
  Media.reset();
  const outcome=await Promise.race([pending,new Promise(resolve=>setTimeout(()=>resolve('still pending'),150))]);
  getPlayerAdapter().cancelElementSeek(elements[0]);await pending;
  expect(outcome).toBeNull();expect(elements[0].src).toBe('');
  elements[0].duration=8;elements[0].dispatchEvent(new Event('durationchange'));
  expect(elements[0].currentTime).toBe(3);
  expect(Media.tracks).toEqual([]);expect(Media.externalAudioSources).toEqual([]);expect(State.externalAudioState).toEqual([]);
});
