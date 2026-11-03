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

function setupOverlap(){
  const top=Seq.add({id:'top',name:'source.mov',path:'C:/source.mov',web:{url:'file:///source.mov'},primary:true,
    dur:10,in:0,out:10,offset:0,vtrack:1,audioSrc:'video',audioSourceId:'mother-source'});
  const bottom=Seq.add({id:'bottom',name:'bottom.mov',path:'C:/bottom.mov',web:{url:'file:///bottom.mov'},
    dur:10,in:0,out:6,offset:3,vtrack:0,speed:2,audioSrc:'clip:bottom',audioSourceId:'bottom-source'});
  Media.activeClipId=top.id;ensureAudioSourceMap(top.audioSourceId,[{sourceStream:0,sourceChannel:0}]);
  ensureAudioSourceMap(bottom.audioSourceId,[{sourceStream:0,sourceChannel:0}]);
  Media.tracks.push({kind:'buffer',source:'video',audioSourceId:top.audioSourceId,sourceStream:0,sourceChannel:0,
    buffer:{duration:10},gain:AudioEngine.createGain(),analyser:AudioEngine.createAnalyser(),muted:false,solo:false,volume:1});
  const lower=new AudioElement();lower.src='file:///bottom.wav';
  Media.tracks.push({kind:'element',source:'clip:bottom',audioSourceId:bottom.audioSourceId,sourceStream:0,sourceChannel:0,
    el:lower,gain:AudioEngine.createGain(),analyser:AudioEngine.createAnalyser(),muted:false,solo:false,volume:1});
  return {top,bottom,lower};
}

it.each([{start:1,target:4,active:true},{start:4,target:7,active:false}])
('播放中跳至同一最上層影片的 $target 秒後，第一個 tick 不重播且保留底層音軌',async({start,target,active})=>{
  const {lower}=setupOverlap();
  await Media.requestPresentation(start);Media.play();
  await vi.waitFor(()=>expect(buffers.some(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length)).toBe(true));
  video.currentTime=start+.04;Media.seqTick();
  await Media.seek(target);
  await vi.waitFor(()=>expect(buffers.some(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length)).toBe(true));
  await vi.waitFor(()=>expect(lower.paused).toBe(!active));
  if(active){expect(lower.currentTime).toBeCloseTo(2);expect(lower.playbackRate).toBe(2);}
  const resumed=buffers.findLast(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length);
  video.currentTime=target+.04;context.currentTime=.04;Media.seqTick();
  expect(resumed.stop).not.toHaveBeenCalled();
  expect(buffers.filter(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length)).toEqual([resumed]);
  expect(lower.paused).toBe(!active);
});

it.each([false,true])('連續跳轉後 $pause 暫停時仍只由最後位置控制音軌',async pause=>{
  const {lower}=setupOverlap();
  await Media.requestPresentation(1);Media.play();
  await vi.waitFor(()=>expect(buffers.some(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length)).toBe(true));
  video.currentTime=1.04;Media.seqTick();
  const frames=[],callback=video.requestVideoFrameCallback;
  video.requestVideoFrameCallback=cb=>{frames.push(cb);return frames.length;};
  try{
    const first=Media.seek(4);
    await vi.waitFor(()=>expect(frames.length).toBeGreaterThan(0));
    const latest=Media.seek(7);
    if(pause)Media.pause({seekOnPause:false});
    frames.shift()(0,{mediaTime:4});await first;
    await vi.waitFor(()=>expect(frames.length).toBeGreaterThan(0));
    frames.shift()(0,{mediaTime:7});await latest;
    await vi.waitFor(()=>expect(Media.playbackTransitionPending()).toBe(false));
    const playing=buffers.filter(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length);
    if(pause)expect(playing).toHaveLength(0);
    else{
      await vi.waitFor(()=>expect(buffers.filter(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length)).toHaveLength(1));
      const resumed=buffers.findLast(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length);
      video.currentTime=7.04;Media.seqTick();expect(resumed.stop).not.toHaveBeenCalled();
    }
    expect(lower.paused).toBe(true);
  }finally{video.requestVideoFrameCallback=callback;}
});

it('套用疊合音軌的同步通知觸發較新跳轉時，舊起播不得搶回聲音',async()=>{
  const {lower}=setupOverlap();
  await Media.requestPresentation(1);Media.play();
  await vi.waitFor(()=>expect(buffers.some(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length)).toBe(true));
  video.currentTime=1.04;Media.seqTick();
  const {on}=await import('../src/events.js');
  let listening=true,newer=null;
  on('media:audioTracks',()=>{
    if(listening&&!newer&&Math.abs(Media.displayTime()-4)<.001){
      // 先撤銷監聽，以免同步巢狀事件再次啟動新工作。
      listening=false;newer=Media.seek(7);
    }
  });
  try{
    await Media.seek(4);
    await vi.waitFor(()=>expect(newer).not.toBeNull());
    await newer;
    await vi.waitFor(()=>expect(buffers.filter(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length)).toHaveLength(1));
    expect(Media.displayTime()).toBeCloseTo(7);
    expect(lower.paused).toBe(true);
    const resumed=buffers.findLast(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length);
    expect(resumed.start.mock.calls[0][1]).toBeCloseTo(7);
  }finally{listening=false;}
});

it('播放器起播回覆等待期間跨過疊合邊界，聲音先對齊實際位置且首 tick 不重播',async()=>{
  const {lower}=setupOverlap();
  await Media.requestPresentation(1);Media.play();
  await vi.waitFor(()=>expect(buffers.some(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length)).toBe(true));
  video.currentTime=1.04;Media.seqTick();
  let acceptPlay;
  const pendingPlay=new Promise(resolve=>{acceptPlay=resolve;});
  video.play.mockClear();
  video.play.mockReturnValueOnce(pendingPlay);
  try{
    const seeking=Media.seek(179/30);
    await seeking;
    await vi.waitFor(()=>expect(video.play).toHaveBeenCalledTimes(1));
    // 起播回覆回來前越過底層片段的 6 秒終點；不能先依舊區間播放再重啟。
    video.currentTime=6.04;acceptPlay();
    await vi.waitFor(()=>expect(buffers.filter(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length)).toHaveLength(1));
    const resumed=buffers.findLast(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length);
    expect(lower.paused).toBe(true);
    expect(resumed.start.mock.calls[0][1]).toBeCloseTo(6.04);
    video.currentTime=6.08;Media.seqTick();
    expect(resumed.stop).not.toHaveBeenCalled();
  }finally{acceptPlay();}
});

it.each([{start:2,actual:3.1,active:true},{start:5.9,actual:6.1,active:false}])
('mpv 靜音回覆延到 $actual 秒時，先更新疊合配線且下一 tick 不重啟',async({start,actual,active})=>{
  const {lower}=setupOverlap();
  const {activateMpvTransport}=await import('../src/media-player-adapter.js');
  let acceptMute,controlMute=false;
  const muted=new Promise(resolve=>{acceptMute=resolve;});
  const bridge={launch:vi.fn(async()=>({ok:true,sourceSessionId:'late-mute',duration:10})),
    play:vi.fn(async()=>{}),pause:vi.fn(async()=>{}),rate:vi.fn(async()=>{}),direction:vi.fn(async()=>true),
    present:vi.fn(async time=>({backend:'mpv',presentedSourceTime:time})),
    mute:vi.fn(value=>value&&controlMute?muted:Promise.resolve())};
  const runtime=activateMpvTransport({mpv:bridge});
  await runtime.enterMpv({src:'C:/source.mov'});Media._mpvPath='C:/source.mov';Media._mpvTime=start;
  try{
    await Media.requestPresentation(start);Media.play();
    await vi.waitFor(()=>expect(bridge.play).toHaveBeenCalledOnce());
    await vi.waitFor(()=>expect(Media.playbackTransitionPending()).toBe(false));
    // 初始起播現在先等共同準備；此處獨立測已播放後的背景接管 ACK。
    Media.stopElementSources();Media.stopBufferSources();lower.play.mockClear();
    controlMute=true;Media.startBufferSources(start);Media.startElementSources(start);
    expect(lower.play).not.toHaveBeenCalled();
    Media._mpvTime=actual;acceptMute();
    await vi.waitFor(()=>expect(buffers.some(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length)).toBe(true));
    await vi.waitFor(()=>expect(lower.paused).toBe(!active));
    if(active){expect(lower.currentTime).toBeCloseTo(.2);expect(lower.playbackRate).toBe(2);}
    const voice=buffers.findLast(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length);
    expect(voice.start.mock.calls[0][1]).toBeCloseTo(actual);
    Media._mpvTime=actual+.04;Media.seqTick();
    expect(voice.stop).not.toHaveBeenCalled();
    expect(lower.paused).toBe(!active);
  }finally{acceptMute();Media.pause({seekOnPause:false});runtime.stopBoundsFeeder();resetPlayerAdapter(null,video);}
});

it('反轉疊合準備完成時已跨出片段，採完成位置配線且首 tick 不重播',async()=>{
  const {bottom,lower}=setupOverlap();bottom.reverse=true;
  let finish;
  const ready=new Promise(resolve=>{finish=resolve;});
  const prepare=vi.spyOn(Media,'prepareClipReverseAudio').mockReturnValue(ready);
  await Media.requestPresentation(4);Media.play();
  await vi.waitFor(()=>expect(prepare).toHaveBeenCalledOnce());
  video.currentTime=7;finish(true);await ready;
  await vi.waitFor(()=>expect(buffers.findLast(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length)?.start.mock.calls[0][1]).toBeCloseTo(7));
  expect(lower.paused).toBe(true);expect(lower.play).not.toHaveBeenCalled();
  const voice=buffers.findLast(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length);
  video.currentTime=7.04;Media.seqTick();
  expect(voice.stop).not.toHaveBeenCalled();expect(lower.paused).toBe(true);
});

it.each([
  {swap:true,start:2,actual:3.1,first:'element'},
  {swap:true,start:2,actual:3.1,first:'buffer',background:true},
  {swap:true,start:5.9,actual:6.1,first:'element'},
  {swap:true,start:5.9,actual:6.1,first:'buffer'},
  {swap:false,start:2,actual:3.1,first:'element'},
  {swap:false,start:2,actual:3.1,first:'buffer'},
])('延遲 mute 的 $first 先回覆，buffer 位於短片段=$swap，$start→$actual 兩種 follower 一起更新',async({swap,start,actual,first,background})=>{
  const {top,bottom,lower}=setupOverlap();
  if(swap){
    top.primary=false;top.audioSrc='clip:top';bottom.primary=true;bottom.audioSrc='video';
    const buffer=Media.tracks.find(track=>track.kind==='buffer');buffer.audioSourceId=bottom.audioSourceId;
    const element=Media.tracks.find(track=>track.kind==='element');element.source=top.audioSrc;element.audioSourceId=top.audioSourceId;
  }
  const {activateMpvTransport}=await import('../src/media-player-adapter.js');
  let controlMute=false;
  const muteReplies=[];
  const bridge={launch:vi.fn(async()=>({ok:true,sourceSessionId:'split-mute-replies',duration:10})),
    play:vi.fn(async()=>{}),pause:vi.fn(async()=>{}),rate:vi.fn(async()=>{}),direction:vi.fn(async()=>true),
    present:vi.fn(async time=>({backend:'mpv',presentedSourceTime:time})),mute:vi.fn(value=>{
      if(!value||!controlMute)return Promise.resolve();
      return new Promise(resolve=>{muteReplies.push(resolve);});
    })};
  const runtime=activateMpvTransport({mpv:bridge});
  await runtime.enterMpv({src:'C:/source.mov'});Media._mpvPath='C:/source.mov';Media._mpvTime=start;
  try{
    await Media.requestPresentation(start);Media.play();
    await vi.waitFor(()=>expect(bridge.play).toHaveBeenCalledOnce());
    await vi.waitFor(()=>expect(Media.playbackTransitionPending()).toBe(false));
    // 已接受的起播完成後，重新排入兩種背景 follower，才有各自的 mute ACK。
    Media.stopElementSources();Media.stopBufferSources();
    controlMute=true;
    if(Media.tracks.some(track=>track.kind==='buffer'&&!track._srcHidden))Media.startBufferSources(start);
    Media.startElementSources(start);
    const initialCount=swap&&start===2?1:2;
    await vi.waitFor(()=>expect(muteReplies).toHaveLength(initialCount));
    // 背景聲道剛完成時，也可能單獨要求目前仍隱藏的 buffer 接管。
    if(background){Media.startBufferSources(start);expect(muteReplies).toHaveLength(2);}
    const initial=muteReplies.splice(0);
    Media._mpvTime=actual;
    if(initial.length===1)initial[0]();
    else{
      const bufferIndex=background?1:0,firstIndex=first==='buffer'?bufferIndex:1-bufferIndex;
      initial[firstIndex]();
      // 先完成其中一條真實 adapter 回覆，再交另一條；其間可建立新 follower。
      for(let i=0;i<8;i++)await Promise.resolve();
      if(background){
        const voices=buffers.filter(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length);
        expect(voices).toHaveLength(1);expect(voices[0].start.mock.calls[0][1]).toBeCloseTo(.2);
      }
      initial[1-firstIndex]();
    }
    const bufferActive=!swap||actual<6,elementActive=swap||actual<6;
    await vi.waitFor(()=>{
      for(const resolve of muteReplies.splice(0))resolve();
      const voices=buffers.filter(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length);
      expect(voices).toHaveLength(bufferActive?1:0);
      expect(lower.paused).toBe(!elementActive);
    });
    const voices=buffers.filter(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length);
    if(bufferActive)expect(voices[0].start.mock.calls[0][1]).toBeCloseTo(swap ? .2 : actual);
    if(elementActive)expect(lower.currentTime).toBeCloseTo(swap?actual:.2);
    const bufferCount=buffers.length,plays=lower.play.mock.calls.length;
    Media._mpvTime=actual+.04;Media.seqTick();
    for(let i=0;i<8;i++)await Promise.resolve();
    expect(buffers).toHaveLength(bufferCount);expect(lower.play).toHaveBeenCalledTimes(plays);
    for(const voice of voices)expect(voice.stop).not.toHaveBeenCalled();
  }finally{
    controlMute=false;for(const resolve of muteReplies)resolve();
    Media.pause({seekOnPause:false});runtime.stopBoundsFeeder();resetPlayerAdapter(null,video);
  }
});

it.each([{start:2,target:3.1,active:true},{start:5.9,target:6.1,active:false}])
('外音與疊合片段同時跨界至 $target 秒時，只依更新後的配線定位一次',async({start,target,active})=>{
  const {lower}=setupOverlap();
  const asset=Media.createExternalAudioSource({name:'external.wav',path:'C:/external.wav',duration:10,in:0,out:3,offset:3,
    descriptors:[{sourceStream:0,sourceChannel:0}]});
  const external=new AudioElement();external.src='file:///external.wav';
  Media.tracks.push({kind:'element',source:asset.audioSrc,audioSourceId:asset.audioSourceId,sourceStream:0,sourceChannel:0,
    el:external,gain:AudioEngine.createGain(),analyser:AudioEngine.createAnalyser(),muted:false,solo:false,volume:1});
  await Media.requestPresentation(start);Media.play();
  await vi.waitFor(()=>expect(buffers.some(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length)).toBe(true));
  await vi.waitFor(()=>expect(external.paused).toBe(active));
  const starts=vi.spyOn(Media._audioRouter,'startElementSources');
  video.currentTime=target;context.currentTime=.1;Media.seqTick();
  expect(starts).toHaveBeenCalledTimes(1);
  await vi.waitFor(()=>expect(external.paused).toBe(!active));
  expect(lower.paused).toBe(!active);
  if(active)expect(external.currentTime).toBeCloseTo(.1);
});

it('跨越音訊邊界通知中同步跳轉時，舊 tick 不得重啟音訊',async()=>{
  setupOverlap();
  const asset=Media.createExternalAudioSource({name:'external.wav',path:'C:/external.wav',duration:10,in:0,out:3,offset:3,
    descriptors:[{sourceStream:0,sourceChannel:0}]});
  const external=new AudioElement();external.src='file:///external.wav';
  Media.tracks.push({kind:'element',source:asset.audioSrc,audioSourceId:asset.audioSourceId,sourceStream:0,sourceChannel:0,
    el:external,gain:AudioEngine.createGain(),analyser:AudioEngine.createAnalyser(),muted:false,solo:false,volume:1});
  await Media.requestPresentation(2);Media.play();
  await vi.waitFor(()=>expect(buffers.some(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length)).toBe(true));
  const starts=vi.spyOn(Media._audioRouter,'startElementSources');
  const {on}=await import('../src/events.js');let listening=true,newer=null;
  on('media:audioTracks',()=>{if(listening&&!newer){listening=false;newer=Media.seek(7);}});
  try{
    video.currentTime=3.1;Media.seqTick();
    expect(newer).not.toBeNull();
    expect(starts).not.toHaveBeenCalled();
    await newer;await vi.waitFor(()=>expect(buffers.some(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length)).toBe(true));
    expect(Media.displayTime()).toBeCloseTo(7);
    expect(external.paused).toBe(true);
  }finally{listening=false;}
});

function setupVideoGap(hasNext){
  const clip=Seq.add({id:'gap-first',name:'source.mov',path:'C:/source.mov',web:{url:'file:///source.mov'},primary:true,
    dur:10,in:0,out:5,offset:0,vtrack:0,audioSrc:'video',audioSourceId:'gap-source'});
  if(hasNext)Seq.add({id:'gap-next',name:'next.mov',path:'C:/next.mov',web:{url:'file:///next.mov'},
    dur:10,in:0,out:2,offset:8,vtrack:0,audioSrc:'clip:gap-next',audioSourceId:'gap-next'});
  Media.activeClipId=clip.id;ensureAudioSourceMap(clip.audioSourceId,[{sourceStream:0,sourceChannel:0}]);
  const asset=Media.createExternalAudioSource({name:'external.wav',path:'C:/external.wav',duration:10,in:0,out:3,offset:5,
    descriptors:[{sourceStream:0,sourceChannel:0}]});
  const external=new AudioElement();external.src='file:///external.wav';
  Media.tracks.push({kind:'element',source:asset.audioSrc,audioSourceId:asset.audioSourceId,sourceStream:0,sourceChannel:0,
    el:external,gain:AudioEngine.createGain(),analyser:AudioEngine.createAnalyser(),muted:false,solo:false,volume:1});
  Media.tracks.push({kind:'buffer',source:'video',audioSourceId:clip.audioSourceId,sourceStream:0,sourceChannel:0,
    buffer:{duration:10},gain:AudioEngine.createGain(),analyser:AudioEngine.createAnalyser(),muted:false,solo:false,volume:1});
  Media.recomputeTimelineDuration();
  return external;
}

it.each([{hasNext:false,method:'tick'},{hasNext:true,method:'tick'},
  {hasNext:false,method:'ended'},{hasNext:true,method:'ended'}])
('影片結束同時外音開始，$method 有後續影片=$hasNext 只起播一次',async({hasNext,method})=>{
  const external=setupVideoGap(hasNext);
  await Media.requestPresentation(4);Media.play();
  await vi.waitFor(()=>expect(buffers.some(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length)).toBe(true));
  expect(external.paused).toBe(true);
  const starts=vi.spyOn(Media._audioRouter,'startElementSources');
  video.currentTime=5;
  if(method==='tick') Media.seqTick();else expect(Media.seqContinueAtEnd()).toBe(true);
  expect(starts).toHaveBeenCalledTimes(1);
  await vi.waitFor(()=>expect(external.paused).toBe(false));
  expect(external.currentTime).toBeCloseTo(0);
  expect(Media.inGap()).toBe(true);
  // ended 與 tick 的提交都必須留下同一份活動證據；下一 tick 不得再定位。
  external.currentTime=.08;
  Media.seqTick();
  expect(starts).toHaveBeenCalledTimes(1);
  expect(external.currentTime).toBeCloseTo(.08);
});

it('進入 gap 停止外音時同步觸發較新 seek，舊轉場不可再起播外音',async()=>{
  const external=setupVideoGap(true);
  await Media.requestPresentation(4);Media.play();
  await vi.waitFor(()=>expect(buffers.some(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length)).toBe(true));
  const starts=vi.spyOn(Media._audioRouter,'startElementSources');
  const pause=external.pause;let newer=null,armed=true;
  external.pause=vi.fn(()=>{pause();if(armed){armed=false;newer=Media.seek(2);}});
  video.currentTime=5;Media.seqTick();
  expect(newer).not.toBeNull();expect(starts).not.toHaveBeenCalled();
  await newer;await vi.waitFor(()=>expect(Media.displayTime()).toBeCloseTo(2));
  expect(Media.inGap()).toBe(false);expect(external.paused).toBe(true);
});

it('gap 暫停影片同步觸發較新 seek 時，舊轉場不可隱藏新畫面',async()=>{
  setupVideoGap(true);
  await Media.requestPresentation(4);Media.play();
  await vi.waitFor(()=>expect(buffers.some(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length)).toBe(true));
  let newer=null,armed=true;
  video.style.visibility='visible';
  video.pause=vi.fn(()=>{if(armed){armed=false;newer=Media.seek(2);}});
  try{
    video.currentTime=5;Media.seqTick();
    expect(newer).not.toBeNull();expect(video.style.visibility).not.toBe('hidden');
    await newer;await vi.waitFor(()=>expect(Media.displayTime()).toBeCloseTo(2));
    expect(Media.inGap()).toBe(false);
  }finally{video.pause=vi.fn();}
});

it.each([25,30])('%s FPS 尾端裁掉一格時，out 到達後必須停止影片聲音並進入外音間隙',async fps=>{
  const out=10-1/fps;
  const clip=Seq.add({id:'short-tail',name:'source.mov',path:'C:/source.mov',web:{url:'file:///source.mov'},primary:true,
    dur:10,in:0,out,offset:0,vtrack:0,audioSrc:'video',audioSourceId:'short-tail'});
  Media.activeClipId=clip.id;State.fps=fps;ensureAudioSourceMap(clip.audioSourceId,[{sourceStream:0,sourceChannel:0}]);
  const asset=Media.createExternalAudioSource({name:'external.wav',path:'C:/external.wav',duration:10,in:0,out:2,offset:out,
    descriptors:[{sourceStream:0,sourceChannel:0}]});
  const external=new AudioElement();external.src='file:///external.wav';
  Media.tracks.push({kind:'element',source:asset.audioSrc,audioSourceId:asset.audioSourceId,sourceStream:0,sourceChannel:0,
    el:external,gain:AudioEngine.createGain(),analyser:AudioEngine.createAnalyser(),muted:false,solo:false,volume:1});
  Media.tracks.push({kind:'buffer',source:'video',audioSourceId:clip.audioSourceId,sourceStream:0,sourceChannel:0,
    buffer:{duration:10},gain:AudioEngine.createGain(),analyser:AudioEngine.createAnalyser(),muted:false,solo:false,volume:1});
  Media.recomputeTimelineDuration();await Media.requestPresentation(9.8);Media.play();
  await vi.waitFor(()=>expect(buffers.some(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length)).toBe(true));
  const voice=buffers.findLast(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length);
  video.currentTime=out;Media.seqTick();
  expect(Media.inGap()).toBe(true);expect(voice.stop).toHaveBeenCalledOnce();
  await vi.waitFor(()=>expect(external.paused).toBe(false));expect(external.currentTime).toBeCloseTo(0);
});

it('直接播放 gap 時，停止外音觸發新 seek 不得隱藏新畫面或起播舊時間',async()=>{
  const external=setupVideoGap(true);
  await Media.requestPresentation(4);Media.play();
  await vi.waitFor(()=>expect(buffers.some(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length)).toBe(true));
  const starts=vi.spyOn(Media._audioRouter,'startElementSources');
  const pause=external.pause;let newer=null,armed=true;
  external.pause=vi.fn(()=>{pause();if(armed){armed=false;newer=Media.seek(2);}});
  video.style.visibility='visible';
  Media._startPresentedPlayback(6);
  expect(newer).not.toBeNull();expect(starts).not.toHaveBeenCalled();expect(video.style.visibility).not.toBe('hidden');
  await newer;await vi.waitFor(()=>expect(Media.displayTime()).toBeCloseTo(2));
  expect(Media.inGap()).toBe(false);expect(external.paused).toBe(true);
});

it('presentation 進入 gap 時同步觸發較新 seek，舊 presentation 不得隱藏新畫面',async()=>{
  const external=setupVideoGap(true);
  await Media.requestPresentation(4);Media.play();
  await vi.waitFor(()=>expect(buffers.some(source=>source.start.mock.calls.length&&!source.stop.mock.calls.length)).toBe(true));
  const pause=external.pause;let newer=null,armed=true;
  external.pause=vi.fn(()=>{pause();if(armed&&Media.inGap()){armed=false;newer=Media.seek(2);}});
  video.style.visibility='visible';
  const older=Media.seek(6);
  expect(newer).not.toBeNull();
  expect(video.style.visibility).not.toBe('hidden');
  await Promise.all([older,newer]);
  await vi.waitFor(()=>expect(Media.displayTime()).toBeCloseTo(2));
  expect(Media.inGap()).toBe(false);expect(external.paused).toBe(true);
});
