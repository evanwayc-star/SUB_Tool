// @vitest-environment jsdom
import {readFileSync} from 'node:fs';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';

const node=()=>({connect:vi.fn(),disconnect:vi.fn()});
const context={state:'running',currentTime:0,destination:{},resume:vi.fn(),
  createGain:()=>({...node(),gain:{value:1,cancelScheduledValues:vi.fn(),setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn()}}),
  createAnalyser:()=>({...node(),fftSize:2048,getFloatTimeDomainData:buf=>buf.fill(0)}),
  createMediaElementSource:()=>node(),createChannelSplitter:()=>node(),createChannelMerger:()=>node()};
class AudioElement extends EventTarget{
  // 已可播的外音，測試只延遲舊 ended 事件，不延遲解碼資料。
  constructor(){super();this.src='file:///external.wav';this.currentTime=0;this.duration=10;this.readyState=4;this.paused=true;this.playbackRate=1;}
  play=vi.fn(async()=>{this.paused=false;});pause=vi.fn(()=>{this.paused=true;});load=vi.fn();
}
let Media,State,resetAudioProject,ensureAudioSourceMap,Seq,AudioEngine,resetPlayerAdapter,video;
beforeAll(async()=>{
  const parsed=new DOMParser().parseFromString(readFileSync('index.html','utf8'),'text/html');
  document.body.innerHTML=parsed.body.innerHTML;video=document.getElementById('video');
  vi.stubGlobal('ResizeObserver',class{observe(){} unobserve(){} disconnect(){}});
  vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});
  vi.stubGlobal('Audio',AudioElement);window.AudioContext=function(){return context;};
  HTMLElement.prototype.scrollIntoView=vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockImplementation(()=>new Proxy({
    measureText:()=>({width:1}),createLinearGradient:()=>({addColorStop(){}}),
  },{get:(target,key)=>target[key]||(()=>{}),set:(target,key,value)=>(target[key]=value,true)}));
  Object.defineProperty(video,'duration',{configurable:true,value:10});
  Object.defineProperty(video,'readyState',{configurable:true,value:1});
  video.pause=vi.fn();video.play=vi.fn(async()=>{});video.load=vi.fn();
  video.requestVideoFrameCallback=cb=>{queueMicrotask(()=>cb(0,{mediaTime:video.currentTime}));return 1;};
  video.cancelVideoFrameCallback=vi.fn();
  ({Media}=await import('../src/media.js'));
  ({State,resetAudioProject,ensureAudioSourceMap}=await import('../src/state.js'));
  ({Seq}=await import('../src/sequence.js'));({AudioEngine}=await import('../src/audio-engine.js'));
  ({resetPlayerAdapter}=await import('../src/media-player-adapter.js'));
  await import('../src/app.js');
});
beforeEach(()=>{
  Media.reset();resetAudioProject();State.clips=[];State.videoTracks=[{name:'V1',visible:true}];
  State.duration=10;State.fps=25;State.dropFrame=false;State.muted=false;
  video.src='file:///source.mov';video.currentTime=0;context.currentTime=0;
  resetPlayerAdapter(null,video);Media.ensureCtx();
});
afterEach(()=>{Media.reset();});
afterAll(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();delete window.AudioContext;});

function addVideo(out=5){
  const clip=Seq.add({id:'video-ended',name:'source.mov',path:'C:/source.mov',web:{url:'file:///source.mov'},primary:true,
    dur:10,in:0,out,offset:0,vtrack:0,audioSrc:'video',audioSourceId:'video-ended'});
  Media.activeClipId=clip.id;ensureAudioSourceMap(clip.audioSourceId,[{sourceStream:0,sourceChannel:0}]);return clip;
}
function addExternal(offset=0){
  const asset=Media.createExternalAudioSource({name:'external.wav',path:'C:/external.wav',duration:10,in:0,out:5,offset,
    descriptors:[{sourceStream:0,sourceChannel:0}]});
  const el=new AudioElement();
  Media.tracks.push({kind:'element',source:asset.audioSrc,audioSourceId:asset.audioSourceId,sourceStream:0,sourceChannel:0,
    el,gain:AudioEngine.createGain(),analyser:AudioEngine.createAnalyser(),muted:false,solo:false,volume:1});
  Media.recomputeTimelineDuration();return el;
}

it.each(['gap','audioOnly'])('真 app ended 監聽器收到舊事件，%s 播放時保留外音及虛擬時鐘',async mode=>{
  if(mode==='gap')addVideo();
  const external=addExternal(mode==='gap'?5:0);
  await Media.requestPresentation(mode==='gap'?6:1);Media.play();
  await vi.waitFor(()=>expect(external.paused).toBe(false));
  expect(Media.playing).toBe(true);
  expect(mode==='gap'?Media.inGap():Media.audioOnlyTimeline()).toBe(true);
  const before=Media.tlTime();video.dispatchEvent(new Event('ended'));
  expect(Media.playing).toBe(true);expect(external.paused).toBe(false);
  expect(Media.tlTime()).toBeGreaterThanOrEqual(before);
});

it('真 app ended 監聽器仍會在真正最後影片結束時停止',async()=>{
  addVideo(10);Media.recomputeTimelineDuration();
  await Media.requestPresentation(1);Media.play();
  await vi.waitFor(()=>expect(Media.presenterClockMoving()).toBe(true));
  video.currentTime=10;video.dispatchEvent(new Event('ended'));
  expect(Media.playing).toBe(false);expect(Media.displayTime()).toBe(10);
});

it('真 app ended 監聽器在定位等待中仍會讓真正播畢取消該 presentation',async()=>{
  addVideo(10);Media.recomputeTimelineDuration();
  await Media.requestPresentation(1);Media.play();
  await vi.waitFor(()=>expect(Media.presenterClockMoving()).toBe(true));
  const callbacks=[],original=video.requestVideoFrameCallback;
  video.requestVideoFrameCallback=callback=>{callbacks.push(callback);return callbacks.length;};
  try{
    const pending=Media.seek(4);
    await vi.waitFor(()=>expect(callbacks.length).toBeGreaterThan(0));
    expect(Media.playbackTransitionPending()).toBe(true);
    video.dispatchEvent(new Event('ended'));
    expect(await pending).toMatchObject({status:'cancelled',reason:'player-ended'});
    expect(Media.playing).toBe(false);
  }finally{video.requestVideoFrameCallback=original;}
});

it('presentation 正在交接 gap 時的 ended 仍交給 session 裁定',async()=>{
  addVideo(5);addExternal(5);
  await Media.requestPresentation(1);Media.play();
  await vi.waitFor(()=>expect(Media.presenterClockMoving()).toBe(true));
  const pending=Media.seek(6);
  expect(Media.inGap()).toBe(true);expect(Media.playbackTransitionPending()).toBe(true);
  video.dispatchEvent(new Event('ended'));
  expect(await pending).toMatchObject({status:'cancelled',reason:'player-ended'});
  expect(Media.playing).toBe(false);
});

it('真 app ended 監聽器仍能接續緊鄰的下一影片',async()=>{
  addVideo(5);
  Seq.add({id:'next-ended',name:'source.mov',path:'C:/source.mov',web:{url:'file:///source.mov'},
    dur:10,in:5,out:10,offset:5,vtrack:0,audioSrc:'video',audioSourceId:'video-ended'});
  Media.recomputeTimelineDuration();await Media.requestPresentation(4);Media.play();
  await vi.waitFor(()=>expect(Media.presenterClockMoving()).toBe(true));
  video.currentTime=5;video.dispatchEvent(new Event('ended'));
  await vi.waitFor(()=>expect(Media.activeClip()?.id).toBe('next-ended'));
  expect(Media.playing).toBe(true);
});
