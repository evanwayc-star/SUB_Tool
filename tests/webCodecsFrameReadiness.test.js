// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture=vi.hoisted(()=>{
  const clips=[
    {id:'a',web:{url:'a.mp4'},in:10,out:20,offset:100,vtrack:0},
    {id:'b',web:{url:'b.mp4'},in:0,out:10,offset:102,vtrack:1},
  ];
  const ctx={fillRect:vi.fn(),drawImage:vi.fn(),save:vi.fn(),restore:vi.fn(),beginPath:vi.fn(),rect:vi.fn(),clip:vi.fn()};
  const publish={drawImage:vi.fn(),fillRect:vi.fn()};
  const canvas={style:{display:'none'},width:640,height:360,parentElement:{clientWidth:640,clientHeight:360},getContext:()=>publish};
  return {clips,defaults:clips.map(clip=>({...clip})),ctx,publish,canvas,time:103,takeover:false,availableB:25,longHold:false,sourceFps:25,sourceOffsetUs:0,indexFailure:false,keyFrames:[0],realReader:false,decode:vi.fn(),session:null,snapshot:null,composition:vi.fn(),report:vi.fn()};
});
vi.mock('../src/dom.js',()=>({$:id=>id==='previewCanvas'?fixture.canvas:null,video:{src:'',currentSrc:''}}));
vi.mock('../src/state.js',()=>({State:{clips:fixture.clips,videoTracks:[{visible:true},{visible:true}],videoWidth:1920,videoHeight:1080,fps:25},ensureVideoTrackCount:vi.fn(),videoTrackVisible:()=>true}));
vi.mock('../src/media.js',()=>({Media:{
  mpvMode:false,seqOn:()=>true,tlTime:()=>fixture.time,inGap:()=>false,
  webCodecsTakeover:()=>fixture.takeover,setWebCodecsTakeover:value=>{fixture.takeover=value;fixture.session?.setWebCodecsTakeover(value);},
  setWebCodecsComposited:fixture.composition,reportWebCodecsPresentation:fixture.report,
}}));
vi.mock('../src/media-player-adapter.js',()=>({getPlayerAdapter:()=>({})}));
vi.mock('../src/events.js',()=>({emit:vi.fn()}));
vi.mock('../src/ui.js',()=>({showToast:vi.fn()}));
vi.mock('../src/decode/demux.js',async importOriginal=>{
  const actual=await importOriginal();
  const samples=url=>Array.from({length:url==='a.mp4'?500:250},(_,i)=>({
    type:fixture.keyFrames.includes(i)?'key':'delta',
    timestamp:Math.round(i*1e6/fixture.sourceFps)+(fixture.sourceOffsetUs||0)+(url==='b.mp4'&&fixture.longHold&&i>25?460000:0),
    duration:url==='b.mp4'&&fixture.longHold&&i===25?500000:Math.round((i+1)*1e6/fixture.sourceFps)-Math.round(i*1e6/fixture.sourceFps),
    offset:i,size:1,
  }));
  const info=()=>({presentationOffsetUs:fixture.sourceOffsetUs==null?null:-fixture.sourceOffsetUs});
  return {...actual,
  demuxIndex:vi.fn(async url=>{
    if(fixture.indexFailure) throw new Error('moov is not in the header');
    return {config:{codec:'test'},index:samples(url),keyIdx:fixture.keyFrames,maxEnd:500,info:info()};
  }),
  demuxFile:vi.fn(async()=>({config:{codec:'test'},chunks:samples('a.mp4').map((sample,i)=>({...sample,data:new Uint8Array([i])})),info:info()})),
  SampleReader:class {constructor(url,index,maxEnd){if(fixture.realReader)return new actual.SampleReader(url,index,maxEnd);this.url=url;}data(i){return this.url==='b.mp4'&&i>fixture.availableB?null:new Uint8Array([i]);}ensure(){}dispose(){}},
  MemReader:class {constructor(chunks){this.chunks=chunks;}data(i){return this.chunks[i]?.data;}ensure(){}dispose(){}},
};});
import {WCPreview} from '../src/decode/player.js';
import {createMediaPresentationSession} from '../src/media-presentation-core.js';
import {Seq} from '../src/sequence.js';
import {State} from '../src/state.js';
import {demuxIndex} from '../src/decode/demux.js';

async function loadFirstFrame(){
  WCPreview.tick();
  for(let n=0;n<8;n++) await Promise.resolve();
  WCPreview.tick();
}

beforeEach(()=>{
  fixture.time=103;fixture.takeover=false;fixture.availableB=25;fixture.longHold=false;fixture.sourceFps=25;fixture.sourceOffsetUs=0;fixture.indexFailure=false;fixture.keyFrames=[0];fixture.realReader=false;fixture.session=null;fixture.snapshot=null;
  fixture.clips.splice(0,fixture.clips.length,...fixture.defaults.map(clip=>({...clip})));
  State.videoTracks=[{visible:true},{visible:true}];
  vi.clearAllMocks();
  fixture.composition.mockImplementation((on,snapshot)=>{if(on&&snapshot)fixture.snapshot=snapshot;});
  class Decoder {
    static async isConfigSupported(){return {supported:true};}
    constructor({output}){this.output=output;this.decodeQueueSize=0;}
    configure(){}reset(){}close(){}async flush(){}
    decode(chunk){fixture.decode(chunk);this.output({timestamp:chunk.timestamp,sampleIndex:chunk.data[0],displayWidth:1920,displayHeight:1080,closed:false,close(){this.closed=true;}});}
  }
  vi.stubGlobal('VideoDecoder',Decoder);
  vi.stubGlobal('EncodedVideoChunk',class {constructor(data){Object.assign(this,data);}});
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(fixture.ctx);
});
afterEach(()=>{WCPreview.disposeAll();vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('WebCodecs public preview frame admission',()=>{
  it('同母素材五層的慢速 Range 各自前進，共用索引且卸載取消所有讀取',async()=>{
    vi.useFakeTimers();
    try{
      fixture.realReader=true;fixture.time=.2;
      fixture.keyFrames=Array.from({length:500},(_,index)=>index);
      fixture.clips.splice(0,fixture.clips.length,...[0,96,192,288,384].map((start,vtrack)=>({
        id:'layer-'+vtrack,web:{url:'a.mp4'},in:start/25,out:start/25+1,offset:0,vtrack,
      })));
      State.videoTracks=fixture.clips.map(()=>({visible:true}));
      const requests=[];
      vi.stubGlobal('fetch',vi.fn((url,{headers,signal})=>new Promise((resolve,reject)=>{
        const [,start,end]=/bytes=(\d+)-(\d+)/.exec(headers.Range).map(Number);
        const request={signal,completed:false};requests.push(request);
        const timer=setTimeout(()=>{
          request.completed=true;
          resolve({ok:true,headers:{get:()=>String(end-start+1)},arrayBuffer:async()=>Uint8Array.from({length:end-start+1},(_,index)=>(start+index)%256).buffer});
        },50);
        signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('cancelled','AbortError'));},{once:true});
      })));
      for(let tick=0;tick<20;tick++){WCPreview.tick();await vi.advanceTimersByTimeAsync(10);}
      expect(fixture.publish.drawImage).toHaveBeenCalled();
      expect(fixture.report.mock.lastCall[0]).toHaveLength(5);
      expect(fixture.report.mock.lastCall[0].every(window=>window.start<=fixture.time+1e-9&&window.end>fixture.time-1e-9)).toBe(true);
      expect(demuxIndex).toHaveBeenCalledOnce();
      expect(WCPreview.stats().sources.every(source=>source.frames<=75)).toBe(true);
      // A cold new target leaves reads pending; releasing the preview owns
      // those reads even though the immutable source index remains reusable.
      for(const clip of fixture.clips){clip.in+=48/25;clip.out+=48/25;}
      WCPreview.tick();
      const pending=requests.filter(request=>!request.completed);
      expect(pending).toHaveLength(5);
      WCPreview.disposeAll();
      expect(pending.every(request=>request.signal.aborted)).toBe(true);
      expect(WCPreview.stats().sources).toEqual([]);
    }finally{vi.useRealTimers();}
  });

  it.each(['immediate','queued'])('240FPS %s decode keeps drawn frames alive and feeds later targets without holes',async delivery=>{
    const pending=[],allocated=[];
    class Decoder{
      static async isConfigSupported(){return {supported:true};}
      constructor({output}){this.output=output;this.decodeQueueSize=0;}
      configure(){}reset(){}close(){}async flush(){}
      decode(chunk){
        fixture.decode(chunk);
        const frame={timestamp:chunk.timestamp,displayWidth:1920,displayHeight:1080,closed:false,close(){this.closed=true;}};
        allocated.push(frame);
        if(delivery==='queued')pending.push(()=>this.output(frame));else this.output(frame);
      }
    }
    vi.stubGlobal('VideoDecoder',Decoder);
    for(const clip of fixture.clips)Object.assign(clip,{in:0,out:1,offset:0,fps:240});
    fixture.sourceFps=240;fixture.availableB=500;fixture.time=0;
    fixture.ctx.drawImage.mockImplementation(frame=>{expect(frame.closed).toBe(false);});
    await loadFirstFrame();
    // Even when decodeQueueSize is zero before output callbacks are delivered,
    // the owner accounts for encoded in-flight frames in its admission budget.
    expect(fixture.decode.mock.calls.length).toBeLessThanOrEqual(150);
    for(const time of [0,.05,.2,.4,.7,.2]){
      fixture.time=time;fixture.publish.drawImage.mockClear();fixture.ctx.drawImage.mockClear();
      for(let attempts=0;attempts<30&&!fixture.publish.drawImage.mock.calls.length;attempts++){
        for(const deliver of pending.splice(0))deliver();
        WCPreview.tick();
      }
      expect(fixture.publish.drawImage).toHaveBeenCalled();
      expect(fixture.ctx.drawImage.mock.calls.slice(-2).map(([frame])=>frame.timestamp))
        .toEqual([Math.round(time*1e6),Math.round(time*1e6)]);
      expect(WCPreview.stats().sources.every(source=>source.frames<=75)).toBe(true);
    }
    WCPreview.disposeAll();for(const deliver of pending.splice(0))deliver();
    expect(allocated.every(frame=>frame.closed)).toBe(true);
  });
  it('NTSC reverse trim-out remains half-open despite a floating point ULP',async()=>{
    const fps=30000/1001,out=30/fps;
    for(const clip of fixture.clips)Object.assign(clip,{in:0,out,offset:0,fps,speed:.25,reverse:true});
    fixture.sourceFps=fps;fixture.availableB=250;fixture.time=0;
    await loadFirstFrame();
    expect(fixture.ctx.drawImage.mock.calls.map(([frame])=>frame.timestamp)).toEqual([967633,967633]);
    expect(fixture.snapshot.time).toBe(0);
  });
  it.each([
    {reverse:false,time:.16,source:.04,sampleIndex:1},
    {reverse:true,time:.16,source:.96,sampleIndex:24},
    {reverse:true,time:0,source:.96,sampleIndex:24},
  ])('edit-list預滾不改變慢速來源選格 reverse=$reverse TL=$time',async({reverse,time,source,sampleIndex})=>{
    for(const clip of fixture.clips) Object.assign(clip,{in:0,out:1,offset:0,fps:25,speed:.25,reverse});
    fixture.sourceOffsetUs=80000;fixture.availableB=250;fixture.time=time;
    await loadFirstFrame();
    expect(fixture.ctx.drawImage.mock.calls.map(([frame])=>frame.timestamp)).toEqual([source*1e6,source*1e6]);
    expect(fixture.ctx.drawImage.mock.calls.map(([frame])=>frame.sampleIndex)).toEqual([sampleIndex,sampleIndex]);
    const windows=fixture.report.mock.lastCall[0];
    expect(windows).toHaveLength(2);
    expect(windows.every(window=>window.start<=time+1e-9&&window.end>=time-1e-9)).toBe(true);
    expect(fixture.snapshot.time).toBe(time);
  });

  it('整檔demux退路也以edit-list呈現時間解碼與回報',async()=>{
    for(const clip of fixture.clips) Object.assign(clip,{in:0,out:1,offset:0,fps:25,speed:.25});
    fixture.sourceOffsetUs=80000;fixture.indexFailure=true;fixture.availableB=250;fixture.time=.16;
    vi.spyOn(console,'warn').mockImplementation(()=>{});
    vi.stubGlobal('fetch',vi.fn(async()=>({headers:{get:()=>null},arrayBuffer:async()=>new ArrayBuffer(1024)})));
    await loadFirstFrame();
    expect(fixture.ctx.drawImage.mock.calls.map(([frame])=>frame.timestamp)).toEqual([40000,40000]);
    expect(fixture.report.mock.lastCall[0].every(window=>Math.abs(window.time-.16)<1e-9)).toBe(true);
  });

  it('不支援的多段edit不猜來源時間，讓回原presenter',async()=>{
    fixture.sourceOffsetUs=null;fixture.availableB=250;
    vi.spyOn(console,'warn').mockImplementation(()=>{});
    await loadFirstFrame();
    expect(fixture.ctx.drawImage).not.toHaveBeenCalled();
    expect(fixture.publish.drawImage).not.toHaveBeenCalled();
    expect(fixture.report).not.toHaveBeenCalled();
    expect(fixture.takeover).toBe(false);
  });

  it.each([1.04,1])('30fps來源 out=%s 的慢速反轉首格完成多層呈現，微秒量化不跨過trim-out',async out=>{
    for(const clip of fixture.clips) Object.assign(clip,{in:0,out,offset:0,fps:30,speed:.25,reverse:true});
    fixture.sourceFps=30;fixture.availableB=250;fixture.time=0;fixture.takeover=true;
    const clip=fixture.clips.at(-1),frameIndex=Math.ceil(out*30)-1;
    const sourcePts=Math.round(frameIndex*1e6/30)/1e6;
    const sourceDuration=(Math.round((frameIndex+1)*1e6/30)-Math.round(frameIndex*1e6/30))/1e6;
    const adapter={type:'mpv',present:vi.fn(async()=>({backend:'mpv',presentedSourceTime:sourcePts,presentedSourceDuration:sourceDuration}))};
    const commit=vi.fn(t=>t);
    const session=createMediaPresentationSession({getTolerance:()=>1.5/25,timeoutMs:1000,
      timeline:{normalizeTarget:t=>t,hasSequence:()=>true,clipAt:()=>clip,sourceTime:Seq.toSource,timelineTime:s=>Seq.toTimeline(s,clip)},
      player:{adapter:()=>adapter,isNative:()=>true,frameWindow:async()=>({start:sourcePts,end:sourcePts+sourceDuration})},commitPresented:commit});
    fixture.session=session;session.setWebCodecsTakeover(true);
    fixture.report.mockImplementation(windows=>session.reportWebCodecsPresentation(windows));
    try{
      const pending=session.request(0,{tolerance:.018});
      await Promise.resolve();await Promise.resolve();
      expect(commit).not.toHaveBeenCalled();
      await loadFirstFrame();
      expect(fixture.ctx.drawImage.mock.calls.map(([frame])=>frame.timestamp)).toEqual([sourcePts*1e6,sourcePts*1e6]);
      expect(fixture.report.mock.lastCall[0]).toHaveLength(2);
      expect(fixture.report.mock.lastCall[0].every(window=>window.reverse&&window.startInclusive)).toBe(true);
      await expect(pending).resolves.toMatchObject({status:'presented',presentedTime:0,source:'webcodecs'});
      expect(commit).toHaveBeenCalledExactlyOnceWith(0);
      expect(fixture.snapshot.time).toBe(0);
    }finally{session.reset('test-finished');}
  });

  it('尚未開始的30fps反轉疊層預取正確末格GOP，不因固定尾端補償回到前一GOP',async()=>{
    for(const clip of fixture.clips) Object.assign(clip,{in:0,out:1.04,offset:1,fps:30,speed:.25,reverse:true});
    fixture.sourceFps=30;fixture.availableB=250;fixture.keyFrames=[0,31];fixture.time=0;
    await loadFirstFrame();
    expect(fixture.ctx.drawImage).not.toHaveBeenCalled();
    expect(fixture.decode.mock.calls.filter(([chunk])=>chunk.type==='key').map(([chunk])=>chunk.timestamp)).toEqual([1033333,1033333]);
    fixture.time=1;
    WCPreview.tick();
    expect(fixture.ctx.drawImage.mock.calls.map(([frame])=>frame.timestamp)).toEqual([1033333,1033333]);
    expect(fixture.snapshot.time).toBe(1);
  });

  it.each([false,true])('25%% 慢速 reverse=%s 的完整畫格提交播放目標，保留來源區間證據',async reverse=>{
    for(const clip of fixture.clips){clip.speed=.25;clip.reverse=reverse;}
    fixture.availableB=250;fixture.time=103.02;
    await loadFirstFrame();
    expect(fixture.publish.drawImage).toHaveBeenCalled();
    expect(fixture.snapshot.time).toBe(103.02);
    const windows=fixture.report.mock.lastCall[0];
    expect(windows).toHaveLength(2);
    for(const window of windows){
      expect(window.reverse).toBe(reverse);
      expect(window.end-window.start).toBeCloseTo(.16,8);
      expect(window.start).toBeLessThan(fixture.time);
      expect(window.end).toBeGreaterThan(fixture.time);
    }
    expect(windows[0].time).toBeCloseTo(reverse?103.04:102.88,8);
    expect(windows[1].time).toBeCloseTo(reverse?103.12:102.96,8);
  });
  it('bytes暫時斷供時保留上一完整canvas與時間，恢復後提交新完整畫格',async()=>{
    await loadFirstFrame();
    expect(fixture.report).toHaveBeenLastCalledWith([
      expect.objectContaining({time:103,start:103,end:expect.closeTo(103.04,8)}),expect.objectContaining({time:103,start:103,end:expect.closeTo(103.04,8)})
    ]);
    const held=fixture.snapshot;
    fixture.publish.drawImage.mockClear();fixture.report.mockClear();
    fixture.time=104;
    WCPreview.tick();
    expect(fixture.publish.drawImage).not.toHaveBeenCalled();
    expect(fixture.snapshot).toBe(held);
    expect(fixture.report).not.toHaveBeenCalled();
    fixture.availableB=250;
    WCPreview.tick();
    expect(fixture.publish.drawImage).toHaveBeenCalledOnce();
    expect(fixture.report).toHaveBeenLastCalledWith([
      expect.objectContaining({time:104,start:104,end:expect.closeTo(104.04,8)}),expect.objectContaining({time:104,start:104,end:expect.closeTo(104.04,8)})
    ]);
    expect(fixture.snapshot.time).toBe(104);
  });
  it('冷seek遇到舊來源畫格時不以不完整時刻的canvas接管',async()=>{
    fixture.time=104;
    await loadFirstFrame();
    expect(fixture.publish.drawImage).not.toHaveBeenCalled();
    expect(fixture.takeover).toBe(false);
    expect(fixture.report).not.toHaveBeenCalled();
  });
  it('低FPS或VFR的長畫格涵蓋目標即可提交，snapshot仍使用實際PTS',async()=>{
    fixture.longHold=true;
    await loadFirstFrame();
    fixture.publish.drawImage.mockClear();
    fixture.time=103.3;
    WCPreview.tick();
    expect(fixture.publish.drawImage).toHaveBeenCalledOnce();
    expect(fixture.report).toHaveBeenLastCalledWith([
      expect.objectContaining({time:103.28,start:103.28,end:expect.closeTo(103.32,8)}),expect.objectContaining({time:103,start:103,end:103.5})
    ]);
    expect(fixture.snapshot.time).toBe(103);
  });
});
