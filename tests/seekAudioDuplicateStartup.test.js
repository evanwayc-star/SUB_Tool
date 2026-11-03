// @vitest-environment jsdom
import {readFileSync} from 'node:fs';
import {beforeAll,beforeEach,afterEach,it,expect,vi} from 'vitest';

vi.mock('../src/ui.js',()=>({renderCurrentTimecode:vi.fn(),setStatus:vi.fn(),showToast:vi.fn(),showOsd:vi.fn(),openModal:vi.fn(),closeModal:vi.fn()}));
vi.mock('../src/timeline-renderer.js',()=>({drawTimeline:vi.fn(),updatePlayhead:vi.fn()}));
const elements=[],buffers=[];
const node=()=>({connect:vi.fn(),disconnect:vi.fn()});
const context={state:'running',currentTime:0,destination:{},resume:vi.fn(),
  createGain:()=>({...node(),gain:{value:1,cancelScheduledValues:vi.fn(),setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn()}}),
  createAnalyser:()=>({...node(),fftSize:2048,getFloatTimeDomainData:buf=>buf.fill(0)}),
  createMediaElementSource:()=>node(),createChannelSplitter:()=>node(),createChannelMerger:()=>node(),
  createBufferSource:()=>{const source={...node(),playbackRate:{value:1},start:vi.fn(),stop:vi.fn()};buffers.push(source);return source;}};
class AudioElement extends EventTarget{
  constructor(){super();this.src='';this.currentTime=0;this.duration=10;this.readyState=4;this.paused=true;this.playbackRate=1;elements.push(this);}
  play=vi.fn(async()=>{this.paused=false;});pause=vi.fn(()=>{this.paused=true;});load=vi.fn();
}
let Media,State,resetAudioProject,ensureAudioSourceMap,Seq,AudioEngine,resetPlayerAdapter,video;
beforeAll(async()=>{
  document.body.innerHTML=readFileSync('index.html','utf8');video=document.getElementById('video');
  Object.defineProperty(video,'duration',{configurable:true,value:10});Object.defineProperty(video,'readyState',{configurable:true,value:1});
  video.pause=vi.fn();video.play=vi.fn(async()=>{});video.load=vi.fn();
  video.requestVideoFrameCallback=cb=>{queueMicrotask(()=>cb(0,{mediaTime:video.currentTime}));return 1;};video.cancelVideoFrameCallback=vi.fn();
  window.AudioContext=function(){return context;};globalThis.Audio=AudioElement;
  ({Media}=await import('../src/media.js'));({State,resetAudioProject,ensureAudioSourceMap}=await import('../src/state.js'));
  ({Seq}=await import('../src/sequence.js'));({AudioEngine}=await import('../src/audio-engine.js'));
  ({resetPlayerAdapter}=await import('../src/media-player-adapter.js'));
});
beforeEach(()=>{
  Media.reset();resetAudioProject();State.videoTracks=[{name:'V1',visible:true},{name:'V2',visible:true}];
  State.duration=10;State.fps=30;State.dropFrame=false;State.muted=false;
  video.src='file:///source.mov';video.currentTime=0;context.currentTime=0;elements.length=0;buffers.length=0;
  resetPlayerAdapter(null,video);Media.ensureCtx();
});
afterEach(()=>{Media.reset();vi.restoreAllMocks();});

it('播放中跳轉完成後第一個 tick 不應再重啟已起播的外部音軌',async()=>{
  const clip=Seq.add({id:'mother',name:'source.mov',path:'C:/source.mov',web:{url:'file:///source.mov'},primary:true,
    dur:10,in:0,out:10,offset:0,vtrack:0,audioSrc:'video',audioSourceId:'mother-source'});
  Media.activeClipId=clip.id;ensureAudioSourceMap(clip.audioSourceId,[{sourceStream:0,sourceChannel:0}]);
  const asset=Media.createExternalAudioSource({name:'external.wav',path:'C:/external.wav',duration:10,in:0,out:10,offset:0,
    descriptors:[{sourceStream:0,sourceChannel:0}]});
  const el=new AudioElement();el.src='file:///external.wav';
  Media.tracks.push({kind:'element',source:asset.audioSrc,audioSourceId:asset.audioSourceId,sourceStream:0,sourceChannel:0,
    el,gain:AudioEngine.createGain(),analyser:AudioEngine.createAnalyser(),muted:false,solo:false,volume:1});
  await Media.requestPresentation(1);Media.play();
  await vi.waitFor(()=>expect(el.paused).toBe(false));
  const seek=Media.seek(3);await seek;await vi.waitFor(()=>expect(el.paused).toBe(false));
  el.play.mockClear();el.pause.mockClear();
  // 兩個獨立時鐘容許 120 ms 以內的自然差異；重啟卻會把已播放的 40 ms 音訊倒退。
  video.currentTime=3.04;el.currentTime=3.08;
  Media.seqTick();await Promise.resolve();await Promise.resolve();
  expect(el.pause).not.toHaveBeenCalled();
  expect(el.currentTime).toBeCloseTo(3.08);
  expect(el.paused).toBe(false);
});

it('跳轉至外部片段之前，跨入其起點仍會起播且不會重啟影片 buffer',async()=>{
  const clip=Seq.add({id:'mother',name:'source.mov',path:'C:/source.mov',web:{url:'file:///source.mov'},primary:true,
    dur:10,in:0,out:10,offset:0,vtrack:0,audioSrc:'video',audioSourceId:'mother-source'});
  Media.activeClipId=clip.id;ensureAudioSourceMap(clip.audioSourceId,[{sourceStream:0,sourceChannel:0}]);
  const asset=Media.createExternalAudioSource({name:'external.wav',path:'C:/external.wav',duration:10,in:0,out:4,offset:4,
    descriptors:[{sourceStream:0,sourceChannel:0}]});
  const el=new AudioElement();el.src='file:///external.wav';
  Media.tracks.push({kind:'element',source:asset.audioSrc,audioSourceId:asset.audioSourceId,sourceStream:0,sourceChannel:0,
    el,gain:AudioEngine.createGain(),analyser:AudioEngine.createAnalyser(),muted:false,solo:false,volume:1});
  Media.tracks.push({kind:'buffer',source:'video',audioSourceId:'mother-source',sourceStream:0,sourceChannel:0,
    buffer:{duration:10},gain:AudioEngine.createGain(),analyser:AudioEngine.createAnalyser(),muted:false,solo:false,volume:1});
  await Media.requestPresentation(1);Media.play();
  await vi.waitFor(()=>expect(buffers.some(source=>source.start.mock.calls.length)).toBe(true));
  await Media.seek(3);await vi.waitFor(()=>expect(buffers.some(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length)).toBe(true));
  expect(el.paused).toBe(true);
  const activeBuffer=buffers.find(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length);
  el.play.mockClear();video.currentTime=4.2;Media.seqTick();
  await vi.waitFor(()=>expect(el.paused).toBe(false));
  expect(el.play).toHaveBeenCalledOnce();expect(el.currentTime).toBeCloseTo(.2);
  expect(activeBuffer.stop).not.toHaveBeenCalled();
  video.currentTime=4.24;el.currentTime=.28;Media.seqTick();
  await Promise.resolve();
  expect(el.currentTime).toBeCloseTo(.28);expect(el.play).toHaveBeenCalledOnce();
  expect(activeBuffer.stop).not.toHaveBeenCalled();
});

it('停止舊外音同步觸發較新的定位時，舊定位不應搶回目標',async()=>{
  const clip=Seq.add({id:'mother',name:'source.mov',path:'C:/source.mov',web:{url:'file:///source.mov'},primary:true,
    dur:10,in:0,out:10,offset:0,vtrack:0,audioSrc:'video',audioSourceId:'mother-source'});
  Media.activeClipId=clip.id;ensureAudioSourceMap(clip.audioSourceId,[{sourceStream:0,sourceChannel:0}]);
  const asset=Media.createExternalAudioSource({name:'external.wav',path:'C:/external.wav',duration:10,in:0,out:10,offset:0,
    descriptors:[{sourceStream:0,sourceChannel:0}]});
  const el=new AudioElement();el.src='file:///external.wav';
  Media.tracks.push({kind:'element',source:asset.audioSrc,audioSourceId:asset.audioSourceId,sourceStream:0,sourceChannel:0,
    el,gain:AudioEngine.createGain(),analyser:AudioEngine.createAnalyser(),muted:false,solo:false,volume:1});
  await Media.requestPresentation(1);Media.play();await vi.waitFor(()=>expect(el.paused).toBe(false));
  let reentered=false,newer;
  const pause=el.pause;
  el.pause=vi.fn(()=>{pause();if(!reentered){reentered=true;newer=Media.seek(6);}});
  const older=Media.seek(3);await Promise.all([older,newer]);
  await vi.waitFor(()=>expect(el.paused).toBe(false));
  expect(Media.displayTime()).toBeCloseTo(6);expect(el.currentTime).toBeCloseTo(6);
});

it.each(['pause','reset'])('純外音反轉準備期間 tick 不重排工作，%s 後晚到結果不會起播',async action=>{
  const asset=Media.createExternalAudioSource({name:'reverse.wav',path:'C:/reverse.wav',duration:10,
    in:0,out:10,offset:0,reverse:true,descriptors:[{sourceStream:0,sourceChannel:0}]});
  const el=new AudioElement();el.src='file:///reverse.wav';
  Media.tracks.push({kind:'element',source:asset.audioSrc,audioSourceId:asset.audioSourceId,sourceStream:0,sourceChannel:0,
    el,gain:AudioEngine.createGain(),analyser:AudioEngine.createAnalyser(),muted:false,solo:false,volume:1});
  let finish;
  const ready=new Promise(resolve=>{finish=resolve;});
  const prepare=vi.spyOn(Media,'prepareClipReverseAudio').mockReturnValue(ready);
  const starts=vi.spyOn(Media._audioRouter,'startElementSources');
  await Media.seek(1);Media.play();
  Media.seqTick();Media.seqTick();
  expect(prepare).toHaveBeenCalledOnce();
  expect(el.play).not.toHaveBeenCalled();
  if(action==='reset')Media.reset();else Media.pause({seekOnPause:false});
  finish(true);await ready;await Promise.resolve();await Promise.resolve();
  expect(starts).not.toHaveBeenCalled();
  expect(el.paused).toBe(true);
});

it('短反轉外音準備中跨出範圍，即使回到原已提交活動也須撤銷晚到起播',async()=>{
  const clip=Seq.add({id:'mother',name:'source.mov',path:'C:/source.mov',web:{url:'file:///source.mov'},primary:true,
    dur:10,in:0,out:10,offset:0,vtrack:0,audioSrc:'video',audioSourceId:'mother-source'});
  Media.activeClipId=clip.id;ensureAudioSourceMap(clip.audioSourceId,[{sourceStream:0,sourceChannel:0}]);
  const asset=Media.createExternalAudioSource({name:'reverse.wav',path:'C:/reverse.wav',duration:10,
    in:0,out:1,offset:3,reverse:true,descriptors:[{sourceStream:0,sourceChannel:0}]});
  const el=new AudioElement();el.src='file:///reverse.wav';
  Media.tracks.push({kind:'element',source:asset.audioSrc,audioSourceId:asset.audioSourceId,sourceStream:0,sourceChannel:0,
    el,gain:AudioEngine.createGain(),analyser:AudioEngine.createAnalyser(),muted:false,solo:false,volume:1},
    {kind:'buffer',source:'video',audioSourceId:clip.audioSourceId,sourceStream:0,sourceChannel:0,
    buffer:{duration:10},gain:AudioEngine.createGain(),analyser:AudioEngine.createAnalyser(),muted:false,solo:false,volume:1});
  await Media.requestPresentation(1);Media.play();
  await vi.waitFor(()=>expect(buffers.some(source=>source.start.mock.calls.length)).toBe(true));
  let finish;
  const ready=new Promise(resolve=>{finish=resolve;});
  const prepare=vi.spyOn(Media,'prepareClipReverseAudio').mockReturnValue(ready);
  const starts=vi.spyOn(Media._audioRouter,'startElementSources');
  const voice=buffers.findLast(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length);
  video.currentTime=3.2;Media.seqTick();expect(prepare).toHaveBeenCalledOnce();
  video.currentTime=4.2;Media.seqTick();
  const startsBeforeReady=starts.mock.calls.length,bufferCount=buffers.length;
  finish(true);await ready;await Promise.resolve();await Promise.resolve();
  expect(starts).toHaveBeenCalledTimes(startsBeforeReady);
  expect(voice.stop).not.toHaveBeenCalled();expect(buffers).toHaveLength(bufferCount);
  expect(el.play).not.toHaveBeenCalled();expect(el.paused).toBe(true);
});
