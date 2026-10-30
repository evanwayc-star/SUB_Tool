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
          resolve(new Response(Uint8Array.from({length:end-start+1},(_,index)=>(start+index)%256)));
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
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(new Uint8Array(1024))));
    await loadFirstFrame();
    expect(fixture.ctx.drawImage.mock.calls.map(([frame])=>frame.timestamp)).toEqual([40000,40000]);
    expect(fixture.report.mock.lastCall[0].every(window=>Math.abs(window.time-.16)<1e-9)).toBe(true);
  });

  it('整檔退路逐段讀取合法內容，不再呼叫無界 arrayBuffer 聚合',async()=>{
    fixture.indexFailure=true;fixture.availableB=250;
    vi.spyOn(console,'warn').mockImplementation(()=>{});
    const aggregate=[];
    vi.stubGlobal('fetch',vi.fn(async()=>{
      const response=new Response(new Uint8Array(1024));
      aggregate.push(vi.spyOn(response,'arrayBuffer'));
      return response;
    }));
    await loadFirstFrame();
    expect(fixture.publish.drawImage).toHaveBeenCalled();
    expect(aggregate).toHaveLength(2);
    expect(aggregate.every(read=>read.mock.calls.length===0)).toBe(true);
  });

  it('整檔退路在未知長度串流越過上限時立即取消，不聚合也不解碼',async()=>{
    fixture.indexFailure=true;
    vi.spyOn(console,'warn').mockImplementation(()=>{});
    const reads=[];
    vi.stubGlobal('fetch',vi.fn(async()=>{
      // 僅用 size-only adapter 表示超過 1.5 GiB 的首個 chunk；反例不配置巨量記憶體。
      const reader={read:vi.fn(async()=>({done:false,value:{byteLength:1500*1024*1024+1}})),
        cancel:vi.fn(async()=>{}),releaseLock:vi.fn()};
      const aggregate=vi.fn(async()=>({byteLength:1500*1024*1024+1}));
      reads.push({reader,aggregate});
      return {ok:true,headers:new Headers(),body:{getReader:()=>reader},arrayBuffer:aggregate};
    }));
    WCPreview.tick();
    await vi.waitFor(()=>expect(reads).toHaveLength(2));
    await vi.waitFor(()=>expect(reads.every(({reader})=>reader.cancel.mock.calls.length===1)).toBe(true));
    expect(reads.every(({reader,aggregate})=>reader.read.mock.calls.length===1&&aggregate.mock.calls.length===0)).toBe(true);
    expect(fixture.decode).not.toHaveBeenCalled();
    expect(fixture.takeover).toBe(false);
  });

  it('卸載預覽工作集會中止尚未完成的整檔退路，共用來源仍只讀一次',async()=>{
    fixture.indexFailure=true;
    fixture.clips[1].web={url:'a.mp4'};
    vi.spyOn(console,'warn').mockImplementation(()=>{});
    const cancelled=vi.fn(),controllers=[];
    vi.stubGlobal('fetch',vi.fn(async(unused,{signal}={})=>{
      const body=new ReadableStream({start(controller){controllers.push(controller);},cancel:cancelled});
      signal?.addEventListener('abort',()=>controllers.at(-1).error(new DOMException('cancelled','AbortError')),{once:true});
      return new Response(body);
    }));
    WCPreview.tick();
    await vi.waitFor(()=>expect(fetch).toHaveBeenCalledOnce());
    const signal=fetch.mock.calls[0][1]?.signal;
    try{
      WCPreview.disposeAll();
      expect(signal?.aborted).toBe(true);
      expect(fixture.decode).not.toHaveBeenCalled();
    }finally{for(const controller of controllers)try{controller.close();}catch(_){} }
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
  it.each(['decode','callback'])('已接管後的永久 %s 錯誤讓回原 presenter，不永久顯示故障前畫格',async failure=>{
    let reportError;
    if(failure==='callback'){
      const Decoder=globalThis.VideoDecoder;
      vi.stubGlobal('VideoDecoder',class extends Decoder{
        constructor(options){super(options);reportError=options.error;}
      });
    }
    vi.spyOn(console,'error').mockImplementation(()=>{});
    await loadFirstFrame();
    expect(fixture.takeover).toBe(true);
    expect(fixture.snapshot.time).toBe(103);
    fixture.publish.drawImage.mockClear();fixture.report.mockClear();
    if(failure==='decode')fixture.decode.mockImplementationOnce(()=>{throw new Error('decoder closed');});
    else reportError(new Error('corrupt sample'));
    fixture.time=104;fixture.availableB=250;
    WCPreview.tick();
    WCPreview.tick();
    expect(fixture.takeover).toBe(false);
    expect(fixture.canvas.style.display).toBe('none');
    expect(fixture.composition).toHaveBeenLastCalledWith(false);
    expect(fixture.publish.drawImage).not.toHaveBeenCalled();
    expect(fixture.report).not.toHaveBeenCalled();
    // 故障層完全透明後不再是必要畫面；仍可由其餘有效層重新接管。
    State.videoTracks[failure==='decode'?0:1].opacity=0;
    WCPreview.tick();
    expect(fixture.takeover).toBe(true);
    expect(fixture.publish.drawImage).toHaveBeenCalledOnce();
    expect(fixture.report.mock.lastCall[0]).toHaveLength(1);
    expect(fixture.snapshot.time).toBe(104);
  });
  it.each(['http','network','short'])('目標 Range %s 失敗讓回已呈現的原生畫格，重新讀取成功後才接管新畫面',async failure=>{
    fixture.realReader=true;fixture.time=.2;fixture.keyFrames=[0,48,96,144,192];
    for(const clip of fixture.clips) Object.assign(clip,{in:0,out:10,offset:0});
    let unavailable=false;
    vi.stubGlobal('fetch',vi.fn(async(url,{headers})=>{
      if(unavailable&&failure==='http') return {ok:false,status:404};
      if(unavailable&&failure==='network') throw new Error('connection lost');
      const [,start,end]=/bytes=(\d+)-(\d+)/.exec(headers.Range).map(Number);
      return new Response(Uint8Array.from({length:unavailable?0:end-start+1},(_,index)=>(start+index)%256));
    }));
    const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});
    await loadFirstFrame();
    await vi.waitFor(()=>{WCPreview.tick();expect(fixture.takeover).toBe(true);});
    expect(fixture.snapshot.time).toBe(.2);
    const adapter={type:'mpv',present:vi.fn(async()=>({backend:'mpv',presentedSourceTime:4}))};
    const commit=vi.fn(t=>t),clip=fixture.clips.at(-1);
    const session=createMediaPresentationSession({getTolerance:()=>.018,timeoutMs:1000,
      timeline:{normalizeTarget:t=>t,hasSequence:()=>true,clipAt:()=>clip,sourceTime:Seq.toSource,timelineTime:s=>Seq.toTimeline(s,clip)},
      player:{adapter:()=>adapter,isNative:()=>true},commitPresented:commit});
    fixture.session=session;session.setWebCodecsTakeover(true);
    fixture.report.mockImplementation(windows=>session.reportWebCodecsPresentation(windows));
    try{
      unavailable=true;fixture.time=4;
      fixture.publish.drawImage.mockClear();fixture.report.mockClear();
      const pending=session.request(4,{tolerance:.018});
      WCPreview.tick();
      expect(fixture.takeover).toBe(true); // 尚未知道 IO 結果時保留完整舊畫格。
      await vi.waitFor(()=>expect(warning).toHaveBeenCalledWith('[WC] 取位元組失敗:',expect.any(String)));
      WCPreview.tick();
      expect(fixture.takeover).toBe(false);
      expect(fixture.canvas.style.display).toBe('none');
      expect(fixture.composition).toHaveBeenLastCalledWith(false);
      expect(fixture.publish.drawImage).not.toHaveBeenCalled();
      expect(fixture.report).not.toHaveBeenCalled();
      await expect(pending).resolves.toMatchObject({status:'presented',presentedTime:4,source:'mpv'});
      expect(commit).toHaveBeenLastCalledWith(4);
      unavailable=false;
      await vi.waitFor(()=>{WCPreview.tick();expect(fixture.takeover).toBe(true);});
      expect(fixture.snapshot.time).toBe(4);
      expect(fixture.report.mock.lastCall[0].every(window=>window.start<=4&&window.end>4)).toBe(true);
    }finally{session.reset();}
  });
  it('已接管後新疊層圖片載入失敗會讓回原 presenter',async()=>{
    await loadFirstFrame();
    expect(fixture.takeover).toBe(true);
    vi.stubGlobal('Image',class{
      set src(url){if(url)queueMicrotask(()=>this.onerror?.());}
    });
    fixture.clips[0]={id:'image',type:'image',web:{url:'broken.png'},in:0,out:20,offset:100,vtrack:0};
    fixture.publish.drawImage.mockClear();fixture.report.mockClear();
    WCPreview.tick();
    expect(fixture.takeover).toBe(true); // 尚在載入時仍保留完整畫格。
    await Promise.resolve();
    WCPreview.tick();
    expect(fixture.takeover).toBe(false);
    expect(fixture.canvas.style.display).toBe('none');
    expect(fixture.composition).toHaveBeenLastCalledWith(false);
    expect(fixture.publish.drawImage).not.toHaveBeenCalled();
    expect(fixture.report).not.toHaveBeenCalled();
  });
  it('未來預取失敗不撤下仍有效的來源格，也不發布另一層尚未就緒的畫面',async()=>{
    fixture.realReader=true;fixture.time=.2;fixture.keyFrames=[0,48,96,144,192];
    for(const clip of fixture.clips) Object.assign(clip,{in:0,out:10,offset:0});
    let blockFuture=false,releaseLayer;
    vi.stubGlobal('fetch',vi.fn((url,{headers,signal})=>{
      const [,start,end]=/bytes=(\d+)-(\d+)/.exec(headers.Range).map(Number);
      const response=()=>new Response(Uint8Array.from({length:end-start+1},(_,index)=>(start+index)%256));
      if(!blockFuture||start<48) return Promise.resolve(response());
      if(url==='a.mp4') return Promise.resolve({ok:false,status:404});
      return new Promise((resolve,reject)=>{
        releaseLayer=()=>resolve(response());
        signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true});
      });
    }));
    const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});
    await loadFirstFrame();
    await vi.waitFor(()=>{WCPreview.tick();expect(fixture.takeover).toBe(true);});
    blockFuture=true;fixture.time=1.8;fixture.clips[1].in=2;
    fixture.publish.drawImage.mockClear();fixture.report.mockClear();
    WCPreview.tick();
    await vi.waitFor(()=>expect(warning).toHaveBeenCalled());
    WCPreview.tick();
    expect(fixture.takeover).toBe(true);
    expect(fixture.snapshot.time).toBe(.2);
    expect(fixture.publish.drawImage).not.toHaveBeenCalled();
    expect(fixture.report).not.toHaveBeenCalled();
    releaseLayer();
    await vi.waitFor(()=>{WCPreview.tick();expect(fixture.publish.drawImage).toHaveBeenCalled();});
    expect(fixture.snapshot.time).toBeCloseTo(1.8,8);
    expect(fixture.report.mock.lastCall[0]).toHaveLength(2);
    expect(fixture.ctx.drawImage.mock.calls.slice(-2).map(([frame])=>frame.timestamp)).toEqual([1800000,3800000]);
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
