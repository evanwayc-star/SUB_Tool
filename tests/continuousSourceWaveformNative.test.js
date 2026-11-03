// @subtool-ci windows
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterEach, expect, it } from 'vitest';
import { nativeTestTools } from './fixtures/native-tools.cjs';

const require=createRequire(import.meta.url);
const {createMediaProbe}=require('../electron/media-probe.js');
const {createMediaIntakeRuntime}=require('../electron/media-intake-runtime.js');
const {createFFmpegExecution}=require('../electron/ffmpeg-execution-engine.js');
const {FileAuthority}=require('../electron/file-authority.js');
const {ffmpeg,ffprobe}=nativeTestTools(),roots=[];

function run(args){
  const result=spawnSync(ffmpeg,['-hide_banner','-nostdin','-loglevel','error','-threads','1',...args],
    {windowsHide:true,timeout:30000,maxBuffer:16*1024*1024});
  expect(result.error||result.status,result.stderr?.toString()).toBe(0);
  return result.stdout;
}

function writeSignal(file,rate,channels,duration,seed){
  const count=Math.round(rate*duration),data=Buffer.alloc(count*channels*2);
  let state=seed>>>0;
  for(let i=0;i<count;i++) for(let channel=0;channel<channels;channel++){
    state^=state<<13;state^=state>>>17;state^=state<<5;
    let value=Math.round(((state>>>0)/0xffffffff-.5)*18000);
    if([5,10].some(time=>Math.abs(i-Math.round(time*rate))<=1)) value=channel%2?-24000:24000;
    data.writeInt16LE(value,(i*channels+channel)*2);
  }
  const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(36+data.length,4);header.write('WAVEfmt ',8);
  header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(channels,22);
  header.writeUInt32LE(rate,24);header.writeUInt32LE(rate*channels*2,28);header.writeUInt16LE(channels*2,32);
  header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(data.length,40);
  fs.writeFileSync(file,Buffer.concat([header,data]));
}

function readPcm(file){
  const bytes=fs.readFileSync(file);
  expect(bytes.toString('ascii',0,4)).toBe('RIFF');expect(bytes.toString('ascii',8,12)).toBe('WAVE');
  expect(bytes.readUInt32LE(4)+8).toBe(bytes.length);
  for(let at=12;at+8<=bytes.length;){
    const size=bytes.readUInt32LE(at+4),tag=bytes.toString('ascii',at,at+4);
    if(tag==='fmt '){
      expect(bytes.readUInt16LE(at+10)).toBe(1);expect(bytes.readUInt32LE(at+12)).toBe(4000);
      expect(bytes.readUInt16LE(at+22)).toBe(16);
    }
    if(tag==='data'){expect(at+8+size).toBeLessThanOrEqual(bytes.length);return bytes.subarray(at+8,at+8+size);}
    at+=8+size+(size%2);
  }
  throw new Error('缺少 PCM data');
}

// Independent, uninterrupted native reference: source-clock alignment, equal
// weight per original channel, fixed denominator after a shorter stream ends.
// Do not insert volume=1 for a sole mono stream: it changes FFmpeg negotiation
// to float and can create one-LSB differences unrelated to the resume seam.
function fullReference(source,duration,audio){
  const count=Math.round(duration*4000),seek=Number(Math.max(0,-(audio[0].timestampOffset||0)).toFixed(6));
  const total=audio.reduce((sum,stream)=>sum+stream.channels,0),weight=(1/total).toFixed(12),filters=[],labels=[];
  audio.forEach((stream,index)=>{
    const offset=(stream.timestampOffset||0)+seek;
    const clock=offset?`asetpts=PTS${offset<0?'-':'+'}${Math.abs(offset).toFixed(6)}/TB,`:'';
    filters.push(`[0:a:${index}]${clock}aresample=48000:async=1:first_pts=0[clock${index}]`);
    if(stream.channels===1&&total===1){labels.push(`[clock${index}]`);return;}
    if(stream.channels===1) filters.push(`[clock${index}]volume=${weight}[mix${index}]`);
    else filters.push(`[clock${index}]pan=mono|c0=${Array.from({length:stream.channels},(_,channel)=>`${weight}*c${channel}`).join('+')}[mix${index}]`);
    labels.push(`[mix${index}]`);
  });
  if(labels.length>1) filters.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0[all]`);
  filters.push(`${labels.length>1?'[all]':labels[0]}aresample=4000,apad=whole_len=${count},atrim=end_sample=${count},asetpts=N/SR/TB[out]`);
  return run(['-filter_complex_threads','1','-ss',String(seek),'-i',source,'-filter_complex',filters.join(';'),
    '-map','[out]','-c:a','pcm_s16le','-f','s16le','pipe:1']);
}

afterEach(()=>{
  for(const root of roots.splice(0)){
    const resolved=fs.realpathSync(root);
    if(path.dirname(resolved)!==fs.realpathSync(os.tmpdir())||!path.basename(resolved).startsWith('subtool-continuous-native-'))
      throw new Error('拒絕清除本次原生測試目錄以外的資料');
    fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
});

it.skipIf(!fs.existsSync(ffmpeg)||!fs.existsSync(ffprobe)).each([
  {name:'48 kHz PCM MOV',rate:48000,extension:'mov',codec:'pcm_s16le',fast:true},
  {name:'44.1 kHz AAC MOV',rate:44100,extension:'mov',codec:'aac',fast:true},
  {name:'44.1 kHz PCM MKV 與不同電腦 strict 目錄',rate:44100,extension:'mkv',codec:'pcm_s16le',foreign:true},
  {name:'多 stream 非零來源原點與短音軌',rate:44100,extension:'mkv',codec:'pcm_s16le',mixed:true,fast:true},
])('$name 中斷續算後每個 PCM 樣本與不中斷解碼完全相同',async spec=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-continuous-native-'));roots.push(root);
  const input=path.join(root,'input.wav'),source=path.join(root,'source.'+spec.extension);
  writeSignal(input,spec.rate,spec.mixed?2:1,14,0x19384756);
  if(spec.mixed){
    const short=path.join(root,'short.wav');writeSignal(short,48000,1,7.25,0x71483210);
    run(['-y','-itsoffset','5.5','-f','lavfi','-i','color=black:s=32x32:r=24:d=13.12725',
      '-itsoffset','5','-i',input,'-itsoffset','6.125','-i',short,
      '-map','0:v:0','-map','1:a:0','-map','2:a:0','-c:v','ffv1','-c:a',spec.codec,'-fps_mode','passthrough',source]);
  }else run(['-y','-f','lavfi','-i','color=black:s=32x32:r=24:d=13.12725','-i',input,
    '-map','0:v:0','-map','1:a:0','-c:v',spec.extension==='mov'?'libx264':'ffv1','-c:a',spec.codec,source]);
  const probe=createMediaProbe({executable:ffprobe});
  const execution=createFFmpegExecution({getFFmpegPath:()=>ffmpeg,getUserDataDir:()=>root});
  const calls=[],progress=[];let runtime,cancelled=false,owned,cancelAt;
  try{
    const info=await probe.describe(source),duration=13.12725,totalSamples=Math.round(duration*4000);
    expect(info.duration).toBeGreaterThanOrEqual(duration);
    if(spec.mixed){expect(info.audio.map(stream=>stream.channels)).toEqual([2,1]);expect(info.video.presentationTimestampOffset).toBe(-5.5);}
    const expected=fullReference(source,duration,info.audio);
    expect(expected.length).toBe(totalSamples*2);expect(expected.some(value=>value!==0)).toBe(true);
    const request={src:source,duration,audio:info.audio,continuous:true};
    const create=(phase,onProgress=()=>{})=>createMediaIntakeRuntime({
      fileAuthority:new FileAuthority({internalDirectories:[root]}),backgroundWaveforms:true,
      ffmpegExecution:{execute:(args,options)=>{calls.push({phase,args});return execution.execute(args,options);}},
      tempRoot:root,cacheRoot:path.join(root,'local-cache-'+phase),allowSidecarCache:true,
      describeAudio:async file=>(await probe.describe(file)).audio,
      sendProgress:(_target,payload)=>{progress.push({phase,...payload});onProgress(payload);},
    });
    runtime=create('cancel',payload=>{
      const samples=payload.waveform?.completedSamples;
      if(samples===40000&&!cancelled){cancelAt=samples;cancelled=true;owned?.kill();}
    });
    await expect(runtime.waveform(request,{isCancelled:()=>cancelled,ownProcess:child=>{owned=child;}}))
      .rejects.toMatchObject({code:'INGEST_SUPERSEDED'});
    await runtime.close();runtime=null;
    expect(cancelAt).toBe(40000);
    if(spec.foreign){
      const sidecar=path.join(root,'.subtool_Cache');
      const entries=fs.readdirSync(sidecar,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&/^[a-f0-9]{16}$/.test(entry.name));
      expect(entries).toHaveLength(1);
      // Only this fixture's cache is moved. The shared source witness stays
      // identical while the per-computer strict directory no longer matches.
      fs.renameSync(path.join(sidecar,entries[0].name),path.join(sidecar,'b'.repeat(16)));
    }
    runtime=create('resume');
    const result=await runtime.waveform(request),actual=readPcm(result.wave);
    expect(result).toMatchObject({complete:true,temporary:false,resumedSamples:40000});
    expect(actual.length).toBe(totalSamples*2);
    expect(actual.subarray((cancelAt-4000)*2,(cancelAt+4000)*2)).toEqual(expected.subarray((cancelAt-4000)*2,(cancelAt+4000)*2));
    expect(actual).toEqual(expected);
    const resumed=calls.filter(call=>call.phase==='resume'),seekOf=call=>Number(call.args[call.args.indexOf('-ss')+1]);
    expect(seekOf(resumed[0])).toBe(spec.mixed?7.5:7);
    if(spec.fast) expect(resumed).toHaveLength(1);
    else{
      // A coarse MKV timebase may change resampler phase on seek. A single
      // verified-origin fallback is allowed; silently joining mismatched PCM is not.
      expect(resumed.length).toBeLessThanOrEqual(2);
      if(resumed.length===2) expect(seekOf(resumed[1])).toBe(0);
    }
    await runtime.close();runtime=null;
    runtime=create('warm');
    const warm=await runtime.waveform(request);
    expect(warm).toMatchObject({cached:true,complete:true,temporary:false});
    expect(calls.filter(call=>call.phase==='warm')).toHaveLength(0);
    expect(readPcm(warm.wave)).toEqual(expected);
    expect(progress.some(event=>event.phase==='resume'&&event.waveform?.startSample===0)).toBe(true);
  }finally{await runtime?.close();await execution.cancelAllAndWait();await probe.cancelAllAndWait();}
},30000);

it.skipIf(!fs.existsSync(ffmpeg)||!fs.existsSync(ffprobe))('連續波形完成後真FFmpeg串流Proxy沿用相同PCM而不輸出第二份wave',async()=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-continuous-native-'));roots.push(root);
  const input=path.join(root,'input.wav'),source=path.join(root,'source.mkv'),duration=3;
  writeSignal(input,48000,1,duration,0x24971386);
  run(['-y','-f','lavfi','-i','color=black:s=32x32:r=24:d=3','-i',input,
    '-map','0:v:0','-map','1:a:0','-c:v','ffv1','-c:a','pcm_s16le',source]);
  const probe=createMediaProbe({executable:ffprobe});
  const execution=createFFmpegExecution({getFFmpegPath:()=>ffmpeg,getUserDataDir:()=>root});
  const calls=[];let runtime;
  try{
    const info=await probe.describe(source),expected=fullReference(source,duration,info.audio);
    runtime=createMediaIntakeRuntime({
      fileAuthority:new FileAuthority({internalDirectories:[root]}),backgroundWaveforms:true,
      ffmpegExecution:{execute:(args,options)=>{calls.push(args);return execution.execute(args,options);}},
      tempRoot:root,cacheRoot:path.join(root,'local-cache'),allowSidecarCache:false,
      describeAudio:async file=>(await probe.describe(file)).audio,
      describeVideo:async file=>(await probe.describe(file)).video,
    });
    const wave=await runtime.waveform({src:source,duration,audio:info.audio,continuous:true});
    expect(expected.length).toBe(duration*4000*2);expect(expected.some(value=>value!==0)).toBe(true);
    expect(readPcm(wave.wave)).toEqual(expected);
    const streamed=await runtime.stream({src:source,duration,audio:info.audio});await streamed.completion;
    expect(streamed.response?.wave).toBe(wave.wave);
    expect(calls).toHaveLength(2);
    expect(calls[1].filter(value=>value.endsWith('wave.wav')||value==='pipe:1')).toEqual([]);
    expect(readPcm(streamed.response.wave)).toEqual(expected);
    const proxy=await probe.describe(streamed.response.proxy),channel=await probe.describe(streamed.response.channels[0].file);
    expect(proxy.video.codec).toBe('h264');expect(proxy.duration).toBeGreaterThanOrEqual(duration);
    expect(channel.audio[0].channels).toBe(1);expect(channel.duration).toBeGreaterThanOrEqual(duration);
  }finally{await runtime?.close();await execution.cancelAllAndWait();await probe.cancelAllAndWait();}
},30000);
