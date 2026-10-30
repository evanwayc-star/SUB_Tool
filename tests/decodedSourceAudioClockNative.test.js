// @subtool-ci windows
import {afterEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createAudioEngineForTest} from '../src/audio-engine.js';
import {sourcePresentationMetadata,clearSourceFrameIndexes} from '../src/decode/source-frame-index.js';
import {nativeTestTools} from './fixtures/native-tools.cjs';

const {ffmpeg,ffprobe}=nativeTestTools(),directories=[];
const pcm=(samples,rate=48000)=>({sampleRate:rate,numberOfChannels:1,length:samples.length,duration:samples.length/rate,getChannelData:()=>samples});
function amplitude(buffer,start,frequency){
  const first=Math.round(start*buffer.sampleRate),count=Math.round(.1*buffer.sampleRate),samples=buffer.getChannelData(0);
  let sine=0,cosine=0;
  for(let index=0;index<count;index++){
    const phase=2*Math.PI*frequency*index/buffer.sampleRate;
    sine+=samples[first+index]*Math.sin(phase);cosine+=samples[first+index]*Math.cos(phase);
  }
  return 2*Math.hypot(sine,cosine)/count;
}
afterEach(()=>{
  clearSourceFrameIndexes();vi.unstubAllGlobals();
  for(const directory of directories.splice(0)){
    const resolved=fs.realpathSync(directory);
    if(path.dirname(resolved)!==fs.realpathSync(os.tmpdir())||!path.basename(resolved).startsWith('subtool-decoded-audio-native-'))throw new Error('decoded audio cleanup boundary');
    fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
});

describe.skipIf(!fs.existsSync(ffmpeg))('original AAC/PCM decoded buffer source clock',()=>{
  it.each([0,5].flatMap(origin=>['aac','pcm_s16le'].map(codec=>({origin,codec}))).concat([{origin:5,codec:'libopus'}]))
  ('true $codec container $origin: original decoder/WASM WAV PCM starts at the proved active audio epoch',async({origin,codec})=>{
    const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-decoded-audio-native-'));directories.push(directory);
    const opus=codec==='libopus',file=path.join(directory,opus?'mother.webm':'mother.mov');
    const run=args=>{
      const result=spawnSync(ffmpeg,['-hide_banner','-nostdin','-loglevel','error',...args],{windowsHide:true,timeout:20000,maxBuffer:4<<20});
      expect(result.error||result.status,result.stderr?.toString()).toBe(0);return result.stdout;
    };
    run(['-y','-itsoffset',String(origin+.5),'-f','lavfi','-i','color=red:s=64x48:r=30:d=3',
      '-itsoffset',String(origin),'-f','lavfi','-i','aevalsrc=if(lt(t\\,0.5)\\,0.12*sin(2*PI*440*t)\\,0.12*sin(2*PI*880*t)):s=48000:d=3.5',
      '-map','0:v','-map','1:a','-c:v',opus?'libvpx-vp9':'libx264','-bf','3','-fps_mode','passthrough','-c:a',codec,file]);
    const bytes=fs.readFileSync(file);
    vi.stubGlobal('fetch',vi.fn(async(_url,{headers}={})=>{
      const range=/bytes=(\d+)-(\d+)/.exec(headers.Range),part=bytes.subarray(Number(range[1]),Number(range[2])+1);
      return new Response(part,{status:206});
    }));
    const metadata=await sourcePresentationMetadata(file);
    expect(metadata.presentationTimestampOffset).toBe(-(origin+.5));
    if(!opus) expect(metadata.audioPresentationTimestampOffset).toBe(codec==='aac'&&origin===5?-4.978:-origin||0);
    const decodedProbe=spawnSync(ffprobe,['-v','error','-select_streams','a:0','-show_entries','frame=pts_time',
      '-read_intervals','%+#2','-of','json',file],{windowsHide:true,timeout:10000});
    expect(decodedProbe.status,decodedProbe.stderr?.toString()).toBe(0);
    const firstDecoded=Number(JSON.parse(decodedProbe.stdout).frames[0].pts_time);
    expect(metadata.decoderAudioPresentationTimestampOffsets[0]).toBeCloseTo(-firstDecoded,10);
    const raw=run(['-i',file,'-map','0:a:0','-ar','48000','-ac','1','-f','f32le','pipe:1']);
    const samples=new Float32Array(raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.length)),original=pcm(samples);
    expect(amplitude(original,.1,440)).toBeGreaterThan(.075);
    const context={state:'running',destination:{},createGain:()=>({connect(){}}),createAnalyser:()=>({fftSize:8}),
      decodeAudioData:async()=>original,createBuffer:(_channels,length,rate)=>pcm(new Float32Array(length),rate)};
    const engine=createAudioEngineForTest({createContext:()=>context});
    const normalized=await engine.decodeSourceAudioData(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length),{url:file});
    expect(normalized.length).toBe(Math.round(metadata.duration*48000));
    const referenceStart=Math.round((origin+.5-firstDecoded)*original.sampleRate);
    expect([...normalized.getChannelData(0).subarray(0,48000)]).toEqual([...original.getChannelData(0).subarray(referenceStart,referenceStart+48000)]);
    for(const time of [.05,.25,.6,2.8]){
      expect(amplitude(normalized,time,880)).toBeGreaterThan(.075);
      expect(amplitude(normalized,time,440)).toBeLessThan(.004);
    }
    expect(await engine.normalizeSourceAudioBuffer(normalized,{url:file})).toBe(normalized);
  },30000);
});
