// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../src/ui.js',()=>({renderCurrentTimecode:vi.fn(),setStatus:vi.fn(),showToast:vi.fn(),showOsd:vi.fn(),openModal:vi.fn(),closeModal:vi.fn()}));
vi.mock('../src/timeline-renderer.js',()=>({drawTimeline:vi.fn(),updatePlayhead:vi.fn()}));
vi.mock('../src/decode/source-frame-index.js',()=>({sourceFrameWindow:vi.fn(async()=>null),
  sourcePresentationMetadata:vi.fn(async()=>null),clearSourceFrameIndexes:vi.fn()}));

const node=()=>({connect:vi.fn(),disconnect:vi.fn()});
const flush=async()=>{for(let n=0;n<16;n++)await Promise.resolve();};
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();delete window.AudioContext;});

async function fixture(){
  vi.resetModules();document.body.innerHTML=readFileSync('index.html','utf8');
  const video=document.getElementById('video');
  video.pause=vi.fn();video.play=vi.fn(async()=>{});video.load=vi.fn();
  const elements=[],seeks=[];let nativeEvent,session=0;
  class AudioElement extends EventTarget{
    constructor(){super();this.src=`file:///channel-${elements.length}.m4a`;this._time=0;this.duration=2000;
      this.readyState=4;this.seeking=false;this.paused=true;elements.push(this);}
    get currentTime(){return this._time;}
    set currentTime(value){this._time=value;seeks.push({channel:elements.indexOf(this),time:value});}
    play=vi.fn(async()=>{this.paused=false;});
    pause=vi.fn(()=>{this.paused=true;});
    load=vi.fn();
    advance(seconds){if(!this.paused)this._time+=seconds;}
  }
  const context={state:'running',currentTime:0,destination:{},resume:vi.fn(),
    createGain:()=>({...node(),gain:{value:1,cancelScheduledValues:vi.fn(),setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn()}}),
    createAnalyser:()=>({...node(),fftSize:2048,getFloatTimeDomainData:buf=>buf.fill(0)}),
    createMediaElementSource:()=>node(),createChannelSplitter:()=>node(),createChannelMerger:()=>node()};
  window.AudioContext=function(){return context;};vi.stubGlobal('Audio',AudioElement);
  const accepted=()=>({ok:true,duration:2000,sourceSessionId:`source-${++session}`});
  const mpv={launch:vi.fn(async()=>accepted()),loadfile:vi.fn(async()=>accepted()),
    play:vi.fn(async()=>({ready:true,sourceTime:Media.vTime()})),pause:vi.fn(async()=>{}),
    seek:vi.fn(async()=>true),direction:vi.fn(async()=>true),cancelPresent:vi.fn(async()=>true),
    present:vi.fn(async time=>({backend:'mpv',presentedSourceTime:time})),
    mute:vi.fn(async()=>{}),quit:vi.fn(async()=>{}),onEvent:vi.fn(callback=>{nativeEvent=callback;})};
  const desktop={isDesktop:true,mpv};Object.defineProperty(window,'subtool',{configurable:true,value:desktop});
  const {Media}=await import('../src/media.js');
  const {State,resetAudioProject,ensureAudioSourceMap}=await import('../src/state.js');
  const {activateMpvTransport,activateHtml5Transport}=await import('../src/media-player-adapter.js');
  const {Seq}=await import('../src/sequence.js');
  Media.reset();resetAudioProject();State.duration=2000;State.fps=24;State.dropFrame=false;State.muted=false;State.previewMode='original';
  const adapter=activateMpvTransport(desktop,video);adapter.onEvent(event=>Media.observeMpvEvent(event));
  await adapter.enterMpv({src:'C:/mother.mov'});
  const clip=Seq.add({id:'mother',path:'C:/mother.mov',primary:true,dur:2000,in:0,out:2000,offset:0,
    vtrack:0,audioSrc:'video',audioSourceId:'mother-audio'});
  Media.activeClipId=clip.id;Media._mpvPath=clip.path;Media.ensureCtx();
  ensureAudioSourceMap(clip.audioSourceId,[{sourceStream:0,sourceChannel:0},{sourceStream:0,sourceChannel:1}]);
  for(let sourceChannel=0;sourceChannel<2;sourceChannel++)Media.tracks.push({kind:'element',source:'video',audioSourceId:clip.audioSourceId,
    sourceStream:0,sourceChannel,el:new AudioElement(),gain:context.createGain(),muted:false,solo:false,volume:1});
  const emit=(time,id=`source-${session}`)=>nativeEvent({event:'property-change',name:'time-pos',data:time,sourceSessionId:id});
  const advance=seconds=>{for(const element of elements)element.advance(seconds);context.currentTime+=seconds;};
  const sync=async()=>{Media.syncAudioDrift();await flush();};
  const startAt=async time=>{await Media.seek(time);Media.play();await vi.waitFor(()=>expect(elements.every(el=>!el.paused)).toBe(true));};
  return {Media,State,Seq,clip,adapter,mpv,video,elements,seeks,emit,advance,sync,startAt,activateHtml5Transport,
    dispose:()=>{Media.reset();delete window.subtool;}};
}

it.each([false,true])('原生位置每 250ms 批次更新時，連續音訊不重播（WebCodecs 接管=%s）',async webCodecs=>{
  const f=await fixture();
  try{
    await f.startAt(1200);f.Media.setWebCodecsTakeover(webCodecs);const initialSeeks=f.seeks.length;
    f.advance(.19);f.emit(1200.25);await f.sync();
    for(let observation=1;observation<=3;observation++){
      for(let frame=0;frame<10;frame++){
        f.advance(.025);await f.sync();
        expect(f.Media.vTime()).toBeCloseTo(1200+observation*.25);
      }
      f.emit(1200+(observation+1)*.25);await f.sync();
    }
    expect(f.elements.map(el=>el.play.mock.calls.length)).toEqual([1,1]);
    expect(f.seeks).toHaveLength(initialSeeks);
    for(const element of f.elements)expect(element.currentTime).toBeCloseTo(1200.94);
    expect(f.Media.displayTime()).toBeCloseTo(1201);
  }finally{f.dispose();}
});

it('舊來源回報不能重新校音，新來源位置仍會修正真正的漂移',async()=>{
  const f=await fixture();
  try{
    await f.startAt(1200);f.emit(1200);await f.sync();
    f.advance(.5);f.emit(1200.25,'stale-source');await f.sync();
    expect(f.elements.map(el=>el.play.mock.calls.length)).toEqual([1,1]);
    f.emit(1200.25);await f.sync();
    expect(f.elements.map(el=>el.play.mock.calls.length)).toEqual([2,2]);
    for(const element of f.elements)expect(element.currentTime).toBeCloseTo(1200.25);
  }finally{f.dispose();}
});

it('切換來源 session 後，即使秒數相同也重新取得校音資格',async()=>{
  const f=await fixture();
  try{
    await f.startAt(1200);f.emit(1200);await f.sync();
    await f.adapter.loadfile('C:/next.mov');
    f.advance(.5);f.emit(1200);await f.sync();
    expect(f.elements.map(el=>el.play.mock.calls.length)).toEqual([2,2]);
    for(const element of f.elements)expect(element.currentTime).toBeCloseTo(1200);
  }finally{f.dispose();}
});

it('HTML 播放保留既有逐次漂移修正，不沿用 native observation 限制',async()=>{
  const f=await fixture();
  try{
    await f.startAt(1200);await f.sync();
    f.video.src='file:///mother.mov';f.video.currentTime=1200;
    await f.activateHtml5Transport(f.video);
    for(let attempt=0;attempt<2;attempt++){f.advance(.5);await f.sync();}
    expect(f.elements.map(el=>el.play.mock.calls.length)).toEqual([3,3]);
    for(const element of f.elements)expect(element.currentTime).toBeCloseTo(1200);
  }finally{f.dispose();}
});

it.each(['gap','audio-only'])('%s 虛擬時間前進時不受停止的 native observation 限制',async kind=>{
  const f=await fixture();
  try{
    let now=0;vi.spyOn(performance,'now').mockImplementation(()=>now);
    const external=f.Media.createExternalAudioSource({name:'voice.wav',duration:2000,in:0,out:2000,offset:0,fallbackCount:2});
    for(const track of f.Media.tracks){track.source=external.audioSrc;track.audioSourceId=external.audioSourceId;}
    if(kind==='gap')f.clip.out=1201;
    else {f.State.clips=[];f.Media.activeClipId=null;}
    await f.startAt(1202);await f.sync();
    expect(kind==='gap'?f.Media.inGap():f.Media.audioOnlyTimeline()).toBe(true);
    for(let attempt=0;attempt<2;attempt++){
      now+=250;f.advance(.5);await f.sync();
    }
    expect(f.elements.map(el=>el.play.mock.calls.length)).toEqual([3,3]);
    for(const element of f.elements)expect(element.currentTime).toBeCloseTo(1202.5);
  }finally{f.dispose();}
});
