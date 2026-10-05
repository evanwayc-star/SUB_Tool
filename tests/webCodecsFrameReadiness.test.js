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
  return {clips,ctx,publish,canvas,time:103,takeover:false,availableB:25,longHold:false,snapshot:null,composition:vi.fn(),report:vi.fn()};
});
vi.mock('../src/dom.js',()=>({$:id=>id==='previewCanvas'?fixture.canvas:null,video:{src:'',currentSrc:''}}));
vi.mock('../src/state.js',()=>({State:{clips:fixture.clips,videoTracks:[{visible:true},{visible:true}],videoWidth:1920,videoHeight:1080}}));
vi.mock('../src/media.js',()=>({Media:{
  mpvMode:false,seqOn:()=>true,tlTime:()=>fixture.time,inGap:()=>false,
  webCodecsTakeover:()=>fixture.takeover,setWebCodecsTakeover:value=>{fixture.takeover=value;},
  setWebCodecsComposited:fixture.composition,reportWebCodecsPresentation:fixture.report,
}}));
vi.mock('../src/sequence.js',()=>({Seq:{
  clipsAt:()=>fixture.clips,toSource:(t,c)=>t-c.offset+c.in,
  toTimeline:(t,c)=>t-c.in+c.offset,clipEnd:c=>c.offset+c.out-c.in,
}}));
vi.mock('../src/media-player-adapter.js',()=>({getPlayerAdapter:()=>({})}));
vi.mock('../src/events.js',()=>({emit:vi.fn()}));
vi.mock('../src/ui.js',()=>({showToast:vi.fn()}));
vi.mock('../src/decode/demux.js',()=>({
  demuxIndex:async url=>({config:{codec:'test'},index:Array.from({length:url==='a.mp4'?500:250},(_,i)=>({
    type:i===0?'key':'delta',
    timestamp:i*40000+(url==='b.mp4'&&fixture.longHold&&i>25?460000:0),
    duration:url==='b.mp4'&&fixture.longHold&&i===25?500000:40000,
  })),keyIdx:[0],maxEnd:500}),
  demuxFile:vi.fn(),
  SampleReader:class {constructor(url){this.url=url;}data(i){return this.url==='b.mp4'&&i>fixture.availableB?null:new Uint8Array([1]);}ensure(){}dispose(){}},
  MemReader:class {},
}));
import {WCPreview} from '../src/decode/player.js';

async function loadFirstFrame(){
  WCPreview.tick();
  for(let n=0;n<8;n++) await Promise.resolve();
  WCPreview.tick();
}

beforeEach(()=>{
  fixture.time=103;fixture.takeover=false;fixture.availableB=25;fixture.longHold=false;fixture.snapshot=null;
  vi.clearAllMocks();
  fixture.composition.mockImplementation((on,snapshot)=>{if(on&&snapshot)fixture.snapshot=snapshot;});
  class Decoder {
    static async isConfigSupported(){return {supported:true};}
    constructor({output}){this.output=output;this.decodeQueueSize=0;}
    configure(){}reset(){}close(){}async flush(){}
    decode(chunk){this.output({timestamp:chunk.timestamp,displayWidth:1920,displayHeight:1080,close(){}});}
  }
  vi.stubGlobal('VideoDecoder',Decoder);
  vi.stubGlobal('EncodedVideoChunk',class {constructor(data){Object.assign(this,data);}});
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(fixture.ctx);
});
afterEach(()=>{WCPreview.disposeAll();vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('WebCodecs public preview frame admission',()=>{
  it('bytes暫時斷供時保留上一完整canvas與時間，恢復後提交新完整畫格',async()=>{
    await loadFirstFrame();
    expect(fixture.report).toHaveBeenLastCalledWith([103,103]);
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
    expect(fixture.report).toHaveBeenLastCalledWith([104,104]);
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
    expect(fixture.report).toHaveBeenLastCalledWith([103.32,103]);
    expect(fixture.snapshot.time).toBe(103);
  });
});
