// @subtool-ci windows
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { demuxIndex } from '../src/decode/demux.js';
import { createNativePreviewRuntime } from '../src/media-player-adapter.js';

const fixture=vi.hoisted(()=>{
  const context={fillRect:vi.fn(),drawImage:vi.fn(),save:vi.fn(),restore:vi.fn(),beginPath:vi.fn(),rect:vi.fn(),clip:vi.fn()};
  const publish={drawImage:vi.fn(),fillRect:vi.fn()};
  const canvas={style:{display:'none'},width:640,height:360,parentElement:{clientWidth:640,clientHeight:360},getContext:()=>publish};
  return {clips:[],context,publish,canvas,time:0,takeover:false,snapshot:null,clock:null,report:vi.fn()};
});
vi.mock('../src/dom.js',()=>({$:id=>id==='previewCanvas'?fixture.canvas:null,video:{src:'',currentSrc:''}}));
vi.mock('../src/state.js',()=>({State:{clips:fixture.clips,videoTracks:[{visible:true},{visible:true}],videoWidth:1920,videoHeight:1080,fps:25},ensureVideoTrackCount:vi.fn(),videoTrackVisible:()=>true}));
vi.mock('../src/media.js',()=>({Media:{mpvMode:false,seqOn:()=>true,tlTime:()=>fixture.time,inGap:()=>false,
  webCodecsTakeover:()=>fixture.takeover,setWebCodecsTakeover:value=>{fixture.takeover=value;},
  setWebCodecsComposited:(on,snapshot)=>{if(on&&snapshot)fixture.snapshot=snapshot;},reportWebCodecsPresentation:fixture.report,
}}));
vi.mock('../src/media-player-adapter.js',async importOriginal=>({...await importOriginal(),getPlayerAdapter:()=>({sourceClock:()=>fixture.clock})}));
vi.mock('../src/events.js',()=>({emit:vi.fn()}));
vi.mock('../src/ui.js',()=>({showToast:vi.fn()}));
import { WCPreview } from '../src/decode/player.js';

const ffmpeg=process.env.FFMPEG_PATH||path.resolve('electron/ffmpeg/ffmpeg.exe');
const nativeIt=fs.existsSync(ffmpeg)?it:it.skip;
const directories=[];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
afterEach(()=>{
  WCPreview.disposeAll();fixture.clock=null;vi.unstubAllGlobals();vi.restoreAllMocks();
  for(const directory of directories.splice(0))fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});
});

async function source(args){
  const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-wc-source-timing-'));
  directories.push(directory);
  const file=path.join(directory,'source.mp4');
  execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-y',...args,'-movflags','+faststart',file],{windowsHide:true,timeout:30000});
  const bytes=fs.readFileSync(file);
  // Keep the actual parser, reader, sequence mapping and SourceStream. Only
  // byte delivery and the codec are replaced; payload hashes identify which
  // physical source sample was painted even if its timestamp is changed.
  vi.stubGlobal('fetch',vi.fn(async(unused,{headers}={})=>{
    const range=/bytes=(\d+)-(\d+)/.exec(headers?.Range||'');
    const result=range?bytes.subarray(Number(range[1]),Number(range[2])+1):bytes;
    return new Response(result,{status:200});
  }));
  const parsed=await demuxIndex(file);
  const physical=new Map(parsed.index.map(sample=>[hash(bytes.subarray(sample.offset,sample.offset+sample.size)),sample.timestamp]));
  class Decoder {
    static async isConfigSupported(){return {supported:true};}
    constructor({output}){this.output=output;this.decodeQueueSize=0;this.pending=[];}
    configure(){}reset(){this.pending=[];}close(){}
    decode(chunk){this.pending.push({timestamp:chunk.timestamp,rawPts:physical.get(hash(chunk.data))});}
    async flush(){for(const frame of this.pending.splice(0).sort((a,b)=>a.timestamp-b.timestamp))this.output({...frame,displayWidth:64,displayHeight:36,close(){}});}
  }
  vi.stubGlobal('VideoDecoder',Decoder);
  vi.stubGlobal('EncodedVideoChunk',class {constructor(chunk){Object.assign(this,chunk);}});
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(fixture.context);
  fixture.clips.splice(0,fixture.clips.length,...[0,1].map(vtrack=>({id:'c'+vtrack,web:{url:file},in:0,out:1,offset:0,speed:.25,fps:25.5102,vtrack})));
  fixture.time=0;fixture.takeover=false;fixture.snapshot=null;vi.clearAllMocks();
  return parsed;
}

async function settle(){
  for(let index=0;index<40;index++){WCPreview.tick();await Promise.resolve();}
}

describe('actual MP4 WebCodecs source timing',()=>{
  nativeIt.each([0,5])('container origin %s: video zero shifts decoder sample selection and all layer evidence without changing payload',async origin=>{
    await source(['-f','lavfi','-i','testsrc2=size=64x36:rate=25:duration=3','-f','lavfi','-i','anullsrc=r=48000:cl=mono',
      '-filter_complex',`[0:v]setpts=PTS+${origin+.52}/TB[v];[1:a]asetpts=PTS+${origin}/TB[a]`,'-map','[v]','-map','[a]','-t',String(origin+3.52),'-fps_mode','passthrough','-c:v','libx264','-bf','0','-c:a','aac']);
    fixture.time=origin+3.32;fixture.clips.forEach(clip=>{clip.out=origin+3.52;clip.speed=1;});
    await settle();expect(fixture.context.drawImage.mock.calls.at(-1)[0].timestamp).toBe(Math.round((origin+3.32)*1e6));
    fixture.context.drawImage.mockClear();fixture.report.mockClear();
    const runtime=createNativePreviewRuntime();
    runtime.registerSourceClock('mother',{timestampOffset:-.52,presentationTimestampOffset:-(origin+.52)});
    fixture.clock=runtime.sourceClock('mother');fixture.time=2.8;
    fixture.clips.forEach(clip=>{clip.out=3;clip.speed=1;});
    await settle();
    const frames=fixture.context.drawImage.mock.calls.slice(-2).map(([frame])=>frame);
    expect(frames.map(frame=>frame.timestamp)).toEqual([2800000,2800000]);
    const windows=fixture.report.mock.lastCall[0];
    expect(windows.every(window=>Math.abs(window.time-2.8)<1e-9)).toBe(true);
    expect(fixture.snapshot.time).toBe(2.8);
  });

  nativeIt.each([false,true])('VFR+Bframes 慢速 reverse=%s 的短格與hold使用實際呈現時窗',async reverse=>{
    const parsed=await source(['-f','lavfi','-i','testsrc2=size=64x36:rate=50:duration=2','-vf',"select='not(mod(n,4))+eq(mod(n,4),1)'",'-fps_mode','vfr','-c:v','libx264','-bf','3']);
    expect(parsed.info.presentationOffsetUs).toBe(-80000);
    fixture.clips.forEach(clip=>{clip.reverse=reverse;});
    for(const [sourceTarget,sourcePts,sourceEnd] of [[.17,.16,.18],[.23,.18,.24]]){
      fixture.time=reverse?(1-sourceTarget)/.25:sourceTarget/.25;
      fixture.context.drawImage.mockClear();fixture.report.mockClear();
      await settle();
      const drawn=fixture.context.drawImage.mock.calls.slice(-2).map(([frame])=>frame);
      expect(drawn.map(frame=>frame.rawPts)).toEqual([(sourcePts+.08)*1e6,(sourcePts+.08)*1e6]);
      const windows=fixture.report.mock.lastCall[0];
      expect(windows).toHaveLength(2);
      expect(windows.every(window=>Math.abs(window.end-window.start-(sourceEnd-sourcePts)/.25)<1e-9)).toBe(true);
      expect(fixture.snapshot.time).toBe(fixture.time);
    }
  });

  nativeIt('leading empty edit 前不以future首格冒充來源0秒',async()=>{
    const parsed=await source(['-f','lavfi','-i','testsrc2=size=64x36:rate=25:duration=1','-vf','setpts=PTS+1/TB','-fps_mode','passthrough','-c:v','libx264','-bf','0']);
    expect(parsed.info.presentationOffsetUs).toBe(1000000);
    fixture.clips.forEach(clip=>{clip.out=2;});
    await settle();
    expect(fixture.context.drawImage).not.toHaveBeenCalled();
    expect(fixture.report).not.toHaveBeenCalled();
    expect(fixture.takeover).toBe(false);

    fixture.time=1.02/.25;
    await settle();
    expect(fixture.context.drawImage.mock.calls.slice(-2).map(([frame])=>({pts:frame.timestamp,rawPts:frame.rawPts})))
      .toEqual([{pts:1000000,rawPts:0},{pts:1000000,rawPts:0}]);
    expect(fixture.takeover).toBe(true);
    const held=fixture.snapshot;
    fixture.context.drawImage.mockClear();fixture.publish.drawImage.mockClear();fixture.report.mockClear();
    fixture.time=0;
    await settle();
    expect(fixture.context.drawImage).not.toHaveBeenCalled();
    expect(fixture.publish.drawImage).not.toHaveBeenCalled();
    expect(fixture.report).not.toHaveBeenCalled();
    expect(fixture.snapshot).toBe(held);
  });
});
