// @subtool-ci windows
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import { nativeTestTools } from './fixtures/native-tools.cjs';

vi.mock('../src/state.js',()=>({State:{audioProject:{sourceMaps:{}}},DESK:{}}));
vi.mock('../src/events.js',()=>({emit:vi.fn()}));
vi.mock('../src/util.js',()=>({readFile:vi.fn()}));
vi.mock('../src/audio-engine.js',()=>({AudioEngine:{isReady:true}}));
vi.mock('../src/audio-routing-engine.js',()=>({AudioPipeline:{}}));
vi.mock('../src/media.js',()=>({Media:{tracks:[],activeSource:null}}));
vi.mock('../src/dom.js',()=>({$:vi.fn(),video:{}}));
vi.mock('../src/ui.js',()=>({renderCurrentTimecode:vi.fn(),setStatus:vi.fn()}));
import { Wave } from '../src/waveform-decoder.js';

const require=createRequire(import.meta.url);
const {createMediaProbe}=require('../electron/media-probe.js');
const {createMediaIntakeRuntime}=require('../electron/media-intake-runtime.js');
const {createFFmpegExecution}=require('../electron/ffmpeg-execution-engine.js');
const {FileAuthority}=require('../electron/file-authority.js');
const {ffmpeg,ffprobe}=nativeTestTools();
const roots=[];
function run(args){
  const result=spawnSync(ffmpeg,['-hide_banner','-nostdin','-loglevel','error',...args],{
    windowsHide:true,timeout:30000,maxBuffer:8*1024*1024,
  });
  expect(result.error||result.status,result.stderr?.toString()).toBe(0);
  return result.stdout;
}
afterEach(()=>{
  for(const root of roots.splice(0)){
    const real=fs.realpathSync(root);
    if(path.dirname(real)!==fs.realpathSync(tmpdir())||!path.basename(real).startsWith('subtool-source-wave-native-'))
      throw new Error('拒絕清除測試目錄以外資料');
    fs.rmSync(real,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
});

it.skipIf(!fs.existsSync(ffmpeg)||!fs.existsSync(ffprobe)).each([
  {name:'浮點尾段有聲音',duration:60.333333333333,audio:'sine=frequency=440:sample_rate=48000:duration=61',audible:true},
  {name:'音訊比影片短',duration:60.123456789,audio:'sine=frequency=440:sample_rate=48000:duration=1',audible:false},
  {name:'全靜音尾段',duration:60.001125,audio:'anullsrc=r=48000:cl=mono:d=61',audible:false},
])('$name 在 60 秒後的 PCM 長度及 renderer 波形均有效',async({name,duration,audio,audible})=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'subtool-source-wave-native-'));roots.push(root);
  const source=path.join(root,'source.mkv'),cache=path.join(root,'cache');
  run(['-y','-f','lavfi','-i','color=black:s=32x32:r=1:d=62',
    '-f','lavfi','-i',audio,'-map','0:v:0','-map','1:a:0','-c:v','ffv1','-c:a','pcm_s16le',source]);
  const probe=createMediaProbe({executable:ffprobe});
  const execution=createFFmpegExecution({getFFmpegPath:()=>ffmpeg,getUserDataDir:()=>root});
  const runtime=createMediaIntakeRuntime({fileAuthority:new FileAuthority({internalDirectories:[root]}),
    ffmpegExecution:execution,tempRoot:root,cacheRoot:cache,allowSidecarCache:false,
    describeAudio:async file=>(await probe.describe(file)).audio});
  try{
    const info=await probe.describe(source),start=60,length=duration-start;
    expect(info.duration).toBeGreaterThanOrEqual(duration);
    expect(info.audio).toHaveLength(1);
    if(name==='全靜音尾段'){
      // Confirm 60 秒仍有真實 PCM，避免把 EOF 或容器片長誤認為短尾段問題。
      const sourcePcm=run(['-ss','60','-i',source,'-map','0:a:0','-t','0.1','-ar','4000','-ac','1','-f','s16le','pipe:1']);
      expect(sourcePcm.length/2).toBeGreaterThanOrEqual(399);
      expect(sourcePcm.every(value=>value===0)).toBe(true);
    }
    const segment=await runtime.waveform({src:source,duration,audio:info.audio,start,length});
    expect(segment).toMatchObject({cached:false,temporary:true,start,duration:length});
    const decoded=run(['-i',segment.wave,'-map','0:a:0','-ar','4000','-ac','1','-f','s16le','pipe:1']);
    const frames=decoded.length/2,expected=Math.round(length*4000);
    expect(frames).toBe(expected);
    let peak=0;
    for(let i=0;i<decoded.length;i+=2)peak=Math.max(peak,Math.abs(decoded.readInt16LE(i)));
    if(audible) expect(peak).toBeGreaterThan(1000);else expect(peak).toBe(0);
    const bytes=fs.readFileSync(segment.wave);
    const array=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
    const peaks=Wave.calcSourceWaveform(array,segment.duration);
    expect(peaks).not.toBeNull();
    expect(peaks.length).toBe(Math.ceil(segment.duration*Wave.resolution)*2);
    if(audible) expect(peaks.some(value=>Math.abs(value)>.02)).toBe(true);
    else expect(peaks.every(value=>value===0)).toBe(true);
    expect(runtime.cleanupGeneratedFile(segment.wave)).toBe(true);
    await runtime.close();
    const encode=vi.fn((...args)=>execution.execute(...args));
    const reopened=createMediaIntakeRuntime({fileAuthority:new FileAuthority({internalDirectories:[root]}),
      ffmpegExecution:{execute:encode},tempRoot:root,cacheRoot:cache,allowSidecarCache:false,
      describeAudio:async file=>(await probe.describe(file)).audio});
    try{
      expect(await reopened.cleanOrphans()).toMatchObject({removed:0,incomplete:false});
      const warm=await reopened.waveform({src:source,duration,audio:info.audio,start,length});
      expect(warm).toMatchObject({cached:true,temporary:true,start,duration:length});
      expect(encode).not.toHaveBeenCalled();
      expect(fs.readFileSync(warm.wave)).toEqual(bytes);
      expect(run(['-i',warm.wave,'-map','0:a:0','-ar','4000','-ac','1','-f','s16le','pipe:1'])).toEqual(decoded);
      expect(reopened.cleanupGeneratedFile(warm.wave)).toBe(true);
    }finally{await reopened.close();}
  }finally{
    await runtime.close();await execution.cancelAllAndWait();await probe.cancelAllAndWait();
  }
},30000);

it.skipIf(!fs.existsSync(ffmpeg)||!fs.existsSync(ffprobe))('不同聲道數的多 stream 波形依全部原始聲道平均，且較短 stream 尾端補零',async()=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'subtool-source-wave-native-'));roots.push(root);
  const source=path.join(root,'mixed.mkv'),cache=path.join(root,'cache');
  run(['-y','-f','lavfi','-i','aevalsrc=0.3|0.3:s=48000:d=1:c=stereo',
    '-f','lavfi','-i','aevalsrc=-0.3:s=48000:d=0.5:c=mono',
    '-map','0:a:0','-map','1:a:0','-c:a','pcm_s16le',source]);
  const probe=createMediaProbe({executable:ffprobe});
  const execution=createFFmpegExecution({getFFmpegPath:()=>ffmpeg,getUserDataDir:()=>root});
  const runtime=createMediaIntakeRuntime({fileAuthority:new FileAuthority({internalDirectories:[root]}),
    ffmpegExecution:execution,tempRoot:root,cacheRoot:cache,allowSidecarCache:false,
    describeAudio:async file=>(await probe.describe(file)).audio});
  try{
    const audio=(await probe.describe(source)).audio;
    expect(audio.map(stream=>stream.channels)).toEqual([2,1]);
    const temporary=await runtime.waveform({src:source,duration:1,audio});
    const prepared=await runtime.ingest({src:source,duration:1,needsProxy:false,audio});
    for(const wave of [temporary.wave,prepared.wave]){
      const bytes=fs.readFileSync(wave);
      const buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
      const peaks=Wave.calcSourceWaveform(buffer,1);
      expect(peaks).not.toBeNull();
      // 早段平均 (0.3 + 0.3 - 0.3) / 3 = 0.1；短音軌結束後
      // 平均 (0.3 + 0.3 + 0) / 3 = 0.2，不得因 stream 數量重正規化。
      expect(peaks[20*2+1]).toBeCloseTo(0.1,2);
      expect(peaks[80*2+1]).toBeCloseTo(0.2,2);
    }
  }finally{
    await runtime.close();await execution.cancelAllAndWait();await probe.cancelAllAndWait();
  }
},30000);
