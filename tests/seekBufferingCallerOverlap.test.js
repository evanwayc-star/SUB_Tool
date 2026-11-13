// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../src/ui.js',()=>({renderCurrentTimecode:vi.fn(),setStatus:vi.fn(),showToast:vi.fn(),showOsd:vi.fn(),openModal:vi.fn(),closeModal:vi.fn()}));
vi.mock('../src/timeline-renderer.js',()=>({drawTimeline:vi.fn(),updatePlayhead:vi.fn()}));

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const node=()=>({connect:vi.fn(),disconnect:vi.fn()});
const flush=async()=>{for(let n=0;n<12;n++)await Promise.resolve();};
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

async function fixture(){
  vi.resetModules();
  document.body.innerHTML=readFileSync('index.html','utf8');
  const video=document.getElementById('video');
  video.pause=vi.fn();video.play=vi.fn(async()=>{});video.load=vi.fn();
  const elements=[],presentations=[],trace=[];
  let nativeEvent;
  class AudioElement extends EventTarget{
    constructor(){super();this.src=`file:///cache-${elements.length}.m4a`;this._time=0;this.duration=12;
      this.readyState=4;this.seeking=false;this.paused=true;this.holdSeek=false;elements.push(this);}
    get currentTime(){return this._time;}
    set currentTime(value){this._time=value;trace.push({type:'seek',channel:elements.indexOf(this),time:value});
      if(this.holdSeek){this.seeking=true;this.readyState=1;}}
    play=vi.fn(async()=>{this.paused=false;trace.push({type:'play',channel:elements.indexOf(this),time:this._time});});
    pause=vi.fn(()=>{this.paused=true;});
    load=vi.fn();
    ready(){this.holdSeek=false;this.seeking=false;this.readyState=4;
      this.dispatchEvent(new Event('seeked'));this.dispatchEvent(new Event('canplay'));}
    advance(seconds){if(!this.paused&&!this.seeking&&this.readyState>=3)this._time+=seconds;}
  }
  const context={state:'running',currentTime:0,destination:{},resume:vi.fn(),
    createGain:()=>({...node(),gain:{value:1,cancelScheduledValues:vi.fn(),setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn()}}),
    createAnalyser:()=>({...node(),fftSize:2048,getFloatTimeDomainData:buf=>buf.fill(0)}),
    createMediaElementSource:()=>node(),createChannelSplitter:()=>node(),createChannelMerger:()=>node()};
  window.AudioContext=function(){return context;};vi.stubGlobal('Audio',AudioElement);
  const mpv={launch:vi.fn(async()=>({ok:true,duration:12,sourceSessionId:'mother'})),
    play:vi.fn(async()=>({ready:true,sourceTime:Media.vTime()})),pause:vi.fn(async()=>{}),
    seek:vi.fn(async()=>true),direction:vi.fn(async()=>true),
    present:vi.fn(time=>{const work={...deferred(),time};presentations.push(work);return work.promise;}),
    mute:vi.fn(async()=>{}),quit:vi.fn(async()=>{}),onEvent:vi.fn(callback=>{nativeEvent=callback;})};
  const desktop={isDesktop:true,mpv};
  Object.defineProperty(window,'subtool',{configurable:true,value:desktop});
  const {Media}=await import('../src/media.js');
  const {State,resetAudioProject,ensureAudioSourceMap}=await import('../src/state.js');
  const {activateMpvTransport}=await import('../src/media-player-adapter.js');
  const {Seq}=await import('../src/sequence.js');
  Media.reset();resetAudioProject();State.duration=12;State.fps=25;State.dropFrame=false;State.muted=false;
  const adapter=activateMpvTransport(desktop,video);
  adapter.onEvent(event=>Media.observeMpvEvent(event));
  await adapter.enterMpv({src:'C:/mother.mov'});
  const clip=Seq.add({id:'mother',name:'mother.mov',path:'C:/mother.mov',primary:true,
    dur:12,in:0,out:12,offset:0,vtrack:0,audioSrc:'video',audioSourceId:'mother-audio'});
  Media.activeClipId=clip.id;Media._mpvPath=clip.path;Media.ensureCtx();
  ensureAudioSourceMap(clip.audioSourceId,[{sourceStream:0,sourceChannel:0},{sourceStream:0,sourceChannel:1}]);
  for(let sourceChannel=0;sourceChannel<2;sourceChannel++)Media.tracks.push({kind:'element',source:'video',audioSourceId:clip.audioSourceId,
    sourceStream:0,sourceChannel,el:new AudioElement(),gain:context.createGain(),muted:false,solo:false,volume:1});
  const emit=(name,data,sourceSessionId='mother',detail={})=>nativeEvent({event:'property-change',name,data,sourceSessionId,...detail});
  const tick=async(seconds=.04)=>{
    for(const element of elements)element.advance(seconds);
    context.currentTime+=seconds;
    Media.seqTick();Media.syncAudioDrift();Media.seqTick();await flush();
  };
  const finishPresentation=async index=>{
    await vi.waitFor(()=>expect(presentations[index]).toBeDefined());
    const work=presentations[index];work.resolve({backend:'mpv',presentedSourceTime:work.time});await flush();
  };
  const startAt=async time=>{
    const index=presentations.length,pending=Media.seek(time);Media.play();
    await finishPresentation(index);await pending;
    await vi.waitFor(()=>expect(elements.every(element=>!element.paused)).toBe(true));
  };
  const dispose=()=>{for(const work of presentations)work.resolve({backend:'mpv',presentedSourceTime:work.time});Media.reset();delete window.subtool;};
  return {Media,Seq,clip,adapter,mpv,elements,trace,emit,tick,finishPresentation,startAt,dispose};
}

it('慢畫格與第二聲道等待期間，多個 Play/tick caller 只提交一次相同起播',async()=>{
  const f=await fixture();
  try{
    const {Media,elements,mpv}=f;
    elements[1].holdSeek=true;
    const seek=Media.seek(4);Media.play();
    for(let n=0;n<5;n++){Media.play();await f.tick(.2);}
    expect(elements.map(element=>element.play.mock.calls.length)).toEqual([0,0]);
    await f.finishPresentation(0);await seek;await flush();
    for(let n=0;n<5;n++){Media.play();await f.tick(.2);}
    expect(mpv.play).not.toHaveBeenCalled();
    expect(elements.map(element=>element.play.mock.calls.length)).toEqual([0,0]);
    elements[1].ready();
    await vi.waitFor(()=>expect(elements.every(element=>!element.paused)).toBe(true));
    for(let n=1;n<=5;n++){f.emit('time-pos',4+n*.04);Media.play();await f.tick();}
    expect(mpv.play).toHaveBeenCalledOnce();
    expect(elements.map(element=>element.play.mock.calls.length),JSON.stringify(f.trace)).toEqual([1,1]);
    for(const element of elements)expect(element.currentTime).toBeCloseTo(4.2);
  }finally{f.dispose();}
});

it('緩衝結束時第二聲道仍未就緒，所有聲道等齊後只恢復一次',async()=>{
  const f=await fixture();
  try{
    await f.startAt(4);
    const nativePauses=f.mpv.pause.mock.calls.length;
    f.emit('paused-for-cache',true);
    for(let n=0;n<5;n++)await f.tick(.2);
    expect(f.elements.map(element=>element.play.mock.calls.length),JSON.stringify(f.trace)).toEqual([1,1]);
    expect(f.elements.every(element=>element.paused)).toBe(true);
    expect(f.Media.playing).toBe(true);
    expect(f.mpv.pause).toHaveBeenCalledTimes(nativePauses);
    f.elements[1].holdSeek=true;f.elements[1].readyState=1;
    f.emit('paused-for-cache',false);f.emit('time-pos',4.04);await flush();
    for(let n=0;n<4;n++)await f.tick(.04);
    expect(f.elements.every(element=>element.paused)).toBe(true);
    f.elements[1].ready();await vi.waitFor(()=>expect(f.elements.every(element=>!element.paused)).toBe(true));
    const resumed=f.elements.map(element=>element.currentTime);
    expect(resumed[0]).toBeCloseTo(resumed[1]);
    for(let n=1;n<=5;n++){f.emit('time-pos',resumed[0]+n*.04);await f.tick();}
    expect(f.elements.map(element=>element.play.mock.calls.length)).toEqual([2,2]);
  }finally{f.dispose();}
});

it('恢復群組第一聲道 play 交界再緩衝，撤銷其餘聲道並保留新的等待 owner',async()=>{
  const f=await fixture();
  try{
    await f.startAt(4);f.emit('paused-for-cache',true);await flush();
    expect(f.elements.every(element=>element.paused)).toBe(true);
    const first=f.elements[0],play=first.play;
    let rebuffered=false;
    first.play=vi.fn(()=>{
      const pending=play();
      if(!rebuffered){rebuffered=true;f.emit('paused-for-cache',true);}
      return pending;
    });
    f.emit('paused-for-cache',false);f.emit('time-pos',4.04);
    await vi.waitFor(()=>expect(rebuffered).toBe(true));await flush();
    expect(f.elements.every(element=>element.paused)).toBe(true);
    expect(f.Media.playing).toBe(true);
    expect(f.elements[1].play).toHaveBeenCalledOnce();
    for(let n=0;n<5;n++)await f.tick(.2);
    expect(first.play).toHaveBeenCalledOnce();
    f.emit('paused-for-cache',false);f.emit('time-pos',4.08);
    await vi.waitFor(()=>expect(f.elements.every(element=>!element.paused)).toBe(true));
    expect(first.play).toHaveBeenCalledTimes(2);
    expect(f.elements[1].play).toHaveBeenCalledTimes(2);
  }finally{f.dispose();}
});

it('自動切換下一片段的聲道 play 尚未完成時再次緩衝，仍須立即停止聲音',async()=>{
  const f=await fixture(),accepted=deferred();
  try{
    f.clip.out=4;
    const next=f.Seq.add({id:'next',name:'mother.mov',path:'C:/mother.mov',dur:12,in:4,out:8,offset:4,vtrack:0,
      audioSrc:'video',audioSourceId:f.clip.audioSourceId});
    await f.startAt(3.96);
    const first=f.elements[0];
    first.play.mockImplementationOnce(()=>{first.paused=false;return accepted.promise;});
    f.emit('time-pos',4);f.Media.seqTick();
    await vi.waitFor(()=>expect(f.Media.activeClip()).toBe(next));
    await vi.waitFor(()=>expect(first.play).toHaveBeenCalledTimes(2));
    f.emit('paused-for-cache',true);await flush();
    expect(f.elements.every(element=>element.paused)).toBe(true);
    expect(f.Media.playing).toBe(true);
    accepted.resolve();await flush();
    for(let n=0;n<5;n++)await f.tick(.2);
    expect(f.elements.every(element=>element.paused)).toBe(true);
    expect(first.play).toHaveBeenCalledTimes(2);
  }finally{accepted.resolve();f.dispose();}
});

it.each(['pause','seek'])('緩衝中的 %s 撤銷舊恢復工作，晚到可播事件不重播舊目標',async action=>{
  const f=await fixture();
  try{
    await f.startAt(4);f.emit('paused-for-cache',true);await flush();
    if(action==='pause')f.Media.pause({seekOnPause:false});
    else{
      const pending=f.Media.seek(8);
      // A new seek cannot become playable while the accepted native source
      // still reports paused-for-cache. Supply its actual recovery evidence
      // before the presentation/readiness result, then test a duplicate below.
      f.emit('paused-for-cache',false);f.emit('time-pos',8);
      await f.finishPresentation(1);await pending;
      await vi.waitFor(()=>expect(f.elements.every(element=>!element.paused)).toBe(true));
    }
    const starts=f.elements.map(element=>element.play.mock.calls.length);
    f.emit('paused-for-cache',false);await flush();
    for(let n=1;n<=5;n++){
      if(action==='seek')f.emit('time-pos',8+n*.04);
      await f.tick();
    }
    expect(f.elements.map(element=>element.play.mock.calls.length)).toEqual(starts);
    expect(f.elements.every(element=>element.paused)).toBe(action==='pause');
    if(action==='seek')for(const element of f.elements)expect(element.currentTime).toBeCloseTo(8.2);
  }finally{f.dispose();}
});

it('舊來源的 cache 狀態不能停住目前來源，也不能解除目前來源的緩衝',async()=>{
  const f=await fixture();
  try{
    await f.startAt(4);f.emit('paused-for-cache',true,'previous-source');await flush();
    expect(f.elements.every(element=>!element.paused)).toBe(true);
    f.emit('paused-for-cache',true);await flush();
    expect(f.elements.every(element=>element.paused)).toBe(true);
    f.emit('paused-for-cache',false,'previous-source');
    for(let n=1;n<=4;n++){f.emit('time-pos',4+n*.04);await f.tick();}
    expect(f.elements.every(element=>element.paused)).toBe(true);
    expect(f.elements.map(element=>element.play.mock.calls.length)).toEqual([1,1]);
    f.emit('paused-for-cache',false);f.emit('time-pos',4.2);
    await vi.waitFor(()=>expect(f.elements.every(element=>!element.paused)).toBe(true));
    expect(f.elements.map(element=>element.play.mock.calls.length)).toEqual([2,2]);
  }finally{f.dispose();}
});

it('同來源緩衝先於新起播的 pause=false 回報，晚到解除暫停仍須停止 followers',async()=>{
  const f=await fixture();
  try{
    await f.startAt(1);f.Media.pause({seekOnPause:false});await flush();
    const pauseIntent=f.mpv.pause.mock.calls.at(-1)?.[0]?.intentId;
    expect(pauseIntent).toBeTypeOf('string');
    f.emit('pause',true,'mother',{playbackIntentId:pauseIntent});
    expect(f.adapter.nativePlaybackState()).toMatchObject({pause:true});
    for(const element of f.elements)element.play.mockClear();
    const pending=f.Media.seek(4);
    f.Media.play();await f.finishPresentation(1);await pending;
    await vi.waitFor(()=>expect(f.elements.every(element=>!element.paused)).toBe(true));
    const playIntent=f.mpv.play.mock.calls.at(-1)[0].intentId;
    const nativePauses=f.mpv.pause.mock.calls.length;
    // Property-change delivery may lag the successful readiness IPC. The old
    // pause observation must not hide new cache/core state once unpause arrives.
    f.emit('paused-for-cache',true);f.emit('core-idle',true);
    f.emit('pause',false,'mother',{playbackIntentId:playIntent});await flush();
    expect(f.adapter.nativePlaybackState()).toMatchObject({pause:false,pausedForCache:true,coreIdle:true});
    expect(f.elements.every(element=>element.paused)).toBe(true);
    expect(f.Media.playing).toBe(true);
    expect(f.mpv.pause).toHaveBeenCalledTimes(nativePauses);
    for(let n=0;n<5;n++)await f.tick(.2);
    expect(f.elements.map(element=>element.play.mock.calls.length)).toEqual([1,1]);
    f.emit('paused-for-cache',false);f.emit('core-idle',false);f.emit('time-pos',4.04);
    await vi.waitFor(()=>expect(f.elements.every(element=>!element.paused)).toBe(true));
    expect(f.elements.map(element=>element.play.mock.calls.length)).toEqual([2,2]);
  }finally{f.dispose();}
});
