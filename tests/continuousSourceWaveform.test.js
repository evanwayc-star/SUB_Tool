import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {afterEach,expect,it,vi} from 'vitest';
const require=createRequire(import.meta.url);
const {createMediaIntakeRuntime,cacheKeyFor,buildAudioIngestPlan}=require('../electron/media-intake-runtime');
const {sharedSourceFingerprintSync}=require('../electron/mother-source-evidence');
const {FileAuthority}=require('../electron/file-authority');
const {runContinuousSourceWaveform,CHECKPOINT_SAMPLES}=require('../electron/continuous-source-waveform');
const {openContinuousWaveformCache}=require('../electron/continuous-waveform-cache');
const roots=[],runtimes=[];
function fixture(duration=13.12725,{allowSidecarCache=false}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'subtool-continuous-runtime-'));roots.push(root);
  const src=path.join(root,'source.mov'),cacheRoot=path.join(root,'cache'),tempRoot=path.join(root,'temp');
  fs.mkdirSync(cacheRoot);fs.mkdirSync(tempRoot);fs.writeFileSync(src,Buffer.alloc(2*1024*1024,71));
  const samples=Math.round(duration*4000),pcm=Buffer.alloc(samples*2),audio=[{channels:1,timestampOffset:0}];
  for(let n=0;n<samples;n++)pcm.writeInt16LE((n*29)%20000-10000,n*2);
  const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(pcm.length+36,4);header.write('WAVEfmt ',8);
  header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(4000,24);
  header.writeUInt32LE(8000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);
  const execute=vi.fn(async(args,options)=>{
    if(options.streamPcm){
      const start=Math.round(Number(args[args.indexOf('-ss')+1])*4000)*2;
      for(let offset=start;offset<pcm.length;offset+=8001)options.onPcm(pcm.subarray(offset,offset+8001));
      return;
    }
    for(const output of args.filter(value=>/\.(?:m4a|wav|mp4)$/.test(value)&&value!==src))
      fs.writeFileSync(output,output.endsWith('wave.wav')?Buffer.concat([header,pcm]):Buffer.alloc(100,4));
  });
  const create=(sendProgress=()=>{})=>{
    const authority=new FileAuthority({internalDirectories:[cacheRoot,tempRoot]});authority.grantTrustedFile(src);
    const runtime=createMediaIntakeRuntime({cacheRoot,tempRoot,allowSidecarCache,fileAuthority:authority,
      ffmpegExecution:{execute},describeAudio:async()=>audio,sendProgress});runtimes.push(runtime);return runtime;
  };
  return {root,src,cacheRoot,pcm,audio,duration,samples,execute,create,request:{src,duration,audio,continuous:true}};
}
afterEach(async()=>{
  vi.restoreAllMocks();await Promise.all(runtimes.splice(0).map(runtime=>runtime.close()));
  for(const root of roots.splice(0)){
    if(path.dirname(root)!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('subtool-continuous-runtime-'))throw new Error('unsafe cleanup');
    fs.rmSync(root,{recursive:true,force:true});
  }
});

it('單次解碼在整片完成前發布已保存的5秒peak，正式wave逐sample正確且warm不重算',async()=>{
  const f=fixture(),events=[];const runtime=f.create((_target,event)=>events.push(event));
  const result=await runtime.waveform(f.request);
  expect(f.execute).toHaveBeenCalledOnce();
  expect(result).toMatchObject({continuous:true,complete:true,temporary:false,cached:false});
  expect(fs.readFileSync(result.wave).subarray(44)).toEqual(f.pcm);
  const batches=events.filter(event=>event.waveform).map(event=>event.waveform);
  expect(batches.map(batch=>batch.completedSamples)).toEqual([20000,40000,f.samples]);
  expect(batches[0]).toMatchObject({startSample:0,sampleRate:4000,resolution:100,totalSamples:f.samples});
  expect(batches[0].peaks).toHaveLength(1000);expect(batches[0].peaks.some(value=>value>0)).toBe(true);
  expect(batches[0].peaks.some(value=>value<0)).toBe(true);
  await runtime.close();const reopened=f.create();
  expect(await reopened.cleanOrphans()).toMatchObject({removed:0,incomplete:false});
  expect(await reopened.waveform(f.request)).toMatchObject({wave:result.wave,cached:true});
  expect(f.execute).toHaveBeenCalledOnce();expect(reopened.cleanupGeneratedFile(result.wave)).toBe(false);
});

it('中斷保留已保存prefix，重新建立runtime可seek續算並重播既有進度',async()=>{
  const f=fixture();let cancelled=false;
  const runtime=f.create((_target,event)=>{if(event.waveform?.completedSamples===40000)cancelled=true;});
  await expect(runtime.waveform(f.request,{isCancelled:()=>cancelled})).rejects.toMatchObject({code:'INGEST_SUPERSEDED'});
  await runtime.close();const events=[];const reopened=f.create((_target,event)=>events.push(event));
  const result=await reopened.waveform(f.request);
  expect(result.resumedSamples).toBe(40000);expect(f.execute).toHaveBeenCalledTimes(2);
  const args=f.execute.mock.calls[1][0];expect(args[args.indexOf('-ss')+1]).toBe('7');
  expect(events.filter(event=>event.waveform).map(event=>event.waveform.startSample)).toEqual([0,20000,40000]);
  expect(fs.readFileSync(result.wave).subarray(44)).toEqual(f.pcm);
});

it('完成wave直接加入Proxy/audio publication，新runtime可從relative metadata讀取同一wave',async()=>{
  const f=fixture(),runtime=f.create();const wave=await runtime.waveform(f.request);
  const prepared=await runtime.ingest({src:f.src,duration:f.duration,audio:f.audio,needsProxy:true});
  const args=f.execute.mock.calls[1][0];
  expect(args).not.toContain('-f');
  expect(args.filter(value=>value.endsWith('wave.wav'))).toEqual([]);
  expect(prepared.wave).toBe(wave.wave);expect(fs.readFileSync(prepared.wave).subarray(44)).toEqual(f.pcm);
  await runtime.close();const reopened=f.create();
  const warm=await reopened.ingest({src:f.src,duration:f.duration,audio:f.audio,needsProxy:true});
  expect(warm).toMatchObject({cached:true,wave:wave.wave});expect(f.execute).toHaveBeenCalledTimes(2);
});

it('完成wave直接供串流Proxy使用，公開stream不重算wave且新runtime保留相同PCM',async()=>{
  const f=fixture(),runtime=f.create(),wave=await runtime.waveform(f.request);
  const streamed=await runtime.stream({src:f.src,duration:f.duration,audio:f.audio});
  await streamed.completion;
  expect(streamed.response?.wave).toBe(wave.wave);
  expect(f.execute.mock.calls[1][0].filter(value=>value.endsWith('wave.wav'))).toEqual([]);
  expect(fs.readFileSync(streamed.response.wave).subarray(44)).toEqual(f.pcm);
  await runtime.close();const reopened=f.create();
  const warm=await reopened.stream({src:f.src,duration:f.duration,audio:f.audio});
  expect(warm).toMatchObject({cached:true,wave:wave.wave});expect(f.execute).toHaveBeenCalledTimes(2);
});

it.each([13,65])('%i秒多checkpoint的來源bytes驗證有界，不隨stdout chunks重讀NAS抽樣',async duration=>{
  const f=fixture(duration),runtime=f.create(),open=fs.openSync,read=fs.readSync;const sourceDescriptors=new Set();let sourceReads=0,sourceBytes=0;
  vi.spyOn(fs,'openSync').mockImplementation((file,...args)=>{const fd=open(file,...args);sourceDescriptors.delete(fd);if(file===f.src)sourceDescriptors.add(fd);return fd;});
  vi.spyOn(fs,'readSync').mockImplementation((fd,buffer,offset,length,position)=>{const count=read(fd,buffer,offset,length,position);if(sourceDescriptors.has(fd)){sourceReads++;sourceBytes+=count;}return count;});
  await runtime.waveform(f.request);
  // Includes fixed admission / legacy-receipt lookup, final publication and
  // the one source-witness recheck at handover;
  // thirteen checkpoints must not add another source-content read per chunk.
  expect(sourceReads).toBeLessThanOrEqual(45);expect(sourceBytes).toBeLessThanOrEqual(15*1179648);
  expect(f.execute).toHaveBeenCalledOnce();
});

it('舊完整generation wave位於另一strict key時，以已有同源receipt重用且不開始連續解碼',async()=>{
  const f=fixture(13.12725,{allowSidecarCache:true}),runtime=f.create();
  const legacy=await runtime.ingest({src:f.src,duration:f.duration,audio:f.audio,needsProxy:true});
  const originalDir=path.dirname(path.dirname(legacy.wave)),foreign=path.join(path.dirname(originalDir),'0123456789abcdef');
  await runtime.close();fs.renameSync(originalDir,foreign);
  f.execute.mockImplementationOnce(()=>{throw new Error('完整 wave 不該重新解碼');});
  const reopened=f.create();const warm=await reopened.waveform(f.request);
  expect(warm).toMatchObject({cached:true,complete:true,temporary:false});
  expect(fs.readFileSync(warm.wave).subarray(44)).toEqual(f.pcm);expect(f.execute).toHaveBeenCalledOnce();
});

it('ignoreCached 強制重新解碼成新的完整 wave，保留原本已完成檔案',async()=>{
  const f=fixture(),runtime=f.create(),first=await runtime.waveform(f.request);
  const rebuilt=await runtime.waveform({...f.request,ignoreCached:true});
  expect(rebuilt.cached).toBe(false);expect(rebuilt.wave).not.toBe(first.wave);expect(f.execute).toHaveBeenCalledTimes(2);
  expect(fs.readFileSync(first.wave).subarray(44)).toEqual(f.pcm);expect(fs.readFileSync(rebuilt.wave).subarray(44)).toEqual(f.pcm);
});

it('sidecar key 可寫但波形子目錄拒絕建立時明確失敗，不轉中央或發布未保存進度',async()=>{
  const f=fixture(13.12725,{allowSidecarCache:true}),events=[],mkdir=fs.mkdirSync;
  vi.spyOn(fs,'mkdirSync').mockImplementation((dir,...args)=>{
    if(String(dir).includes('.subtool_Cache')&&path.basename(dir)==='continuous-waveforms')throw Object.assign(new Error('namespace readonly'),{code:'EACCES'});
    return mkdir(dir,...args);
  });
  await expect(f.create((_target,event)=>events.push(event)).waveform(f.request)).rejects.toMatchObject({code:'EACCES'});
  expect(fs.readdirSync(f.cacheRoot)).toEqual([]);
  expect(events.filter(event=>event.waveform)).toEqual([]);
  expect(f.execute).not.toHaveBeenCalled();
});

it('完成 wave 原始 shared witness 改變時，同 strict key 的下一個 ingest 不得重用舊 wave',async()=>{
  const f=fixture(13.12725,{allowSidecarCache:true}),runtime=f.create();
  const first=await runtime.waveform(f.request),strict=cacheKeyFor(f.src),shared=sharedSourceFingerprintSync(f.src);
  const open=fs.openSync,close=fs.closeSync,stat=fs.statSync,fstat=fs.fstatSync,fds=new Set();
  const alter=value=>Object.assign(Object.create(Object.getPrototypeOf(value)),value,{birthtimeNs:value.birthtimeNs+1n});
  vi.spyOn(fs,'openSync').mockImplementation((file,...args)=>{const fd=open(file,...args);if(file===f.src)fds.add(fd);return fd;});
  vi.spyOn(fs,'closeSync').mockImplementation(fd=>{fds.delete(fd);return close(fd);});
  vi.spyOn(fs,'statSync').mockImplementation((file,options)=>{const value=stat(file,options);return file===f.src&&options?.bigint?alter(value):value;});
  vi.spyOn(fs,'fstatSync').mockImplementation((fd,options)=>{const value=fstat(fd,options);return fds.has(fd)&&options?.bigint?alter(value):value;});
  expect(cacheKeyFor(f.src)).toBe(strict);expect(sharedSourceFingerprintSync(f.src)).not.toBe(shared);
  const result=await runtime.ingest({src:f.src,duration:f.duration,audio:f.audio,needsProxy:true});
  expect(result.wave).not.toBe(first.wave);expect(f.execute.mock.calls[1][0].some(value=>value.endsWith('wave.wav'))).toBe(true);
});

function continuousCaller(f,{savedSamples=0,verify=vi.fn()}={}){
  const spec={version:1,sharedSourceKey:'a'.repeat(64),audio:f.audio,totalSamples:f.samples};
  if(savedSamples){
    const prefix=openContinuousWaveformCache(f.cacheRoot,spec);
    prefix.appendPCM(f.pcm.subarray(0,savedSamples*2));prefix.checkpoint();prefix.close();
  }
  const writer=openContinuousWaveformCache(f.cacheRoot,spec,{verify});
  const store={
    get isComplete(){return writer.isComplete;},get wavePath(){return writer.wavePath;},
    get completedSamples(){return writer.completedSamples;},get writtenSamples(){return writer.writtenSamples;},
    appendPCM:vi.fn(bytes=>writer.appendPCM(bytes)),checkpoint:vi.fn(()=>writer.checkpoint()),
    readPCM:vi.fn((start,count)=>writer.readPCM(start,count)),complete:vi.fn(()=>writer.complete()),
    close:vi.fn(()=>writer.close()),
  };
  const events=[],progress=vi.fn(event=>events.push(event));
  verify.mockClear?.();
  const run=execute=>runContinuousSourceWaveform({src:f.src,duration:f.duration,audio:f.audio,sourceKey:'fixture',
    store,verify,execute,buildPlan:buildAudioIngestPlan,progress});
  return {store,verify,events,progress,run};
}

function sendPcm(options,pcm,chunkBytes){
  for(let offset=0;offset<pcm.length;offset+=chunkBytes)options.onPcm(pcm.subarray(offset,offset+chunkBytes));
}

function expectedPeaks(pcm){
  const result=[];
  for(let offset=0;offset<pcm.length;offset+=80){
    let minimum=0,maximum=0;
    for(let sample=offset;sample<Math.min(offset+80,pcm.length);sample+=2){
      const value=pcm.readInt16LE(sample)/32768;minimum=Math.min(minimum,value);maximum=Math.max(maximum,value);
    }
    result.push(minimum,maximum);
  }
  return Array.from(Float32Array.from(result));
}

it.each([16384,257,200000])('stdout 每 %i bytes 到達時，以最多5秒一塊保存，PCM 與所有 peaks 不受 chunk 邊界影響',async chunkBytes=>{
  const f=fixture(),c=continuousCaller(f);
  const result=await c.run(async(_args,options)=>sendPcm(options,f.pcm,chunkBytes));
  expect(fs.readFileSync(result.wave).subarray(44)).toEqual(f.pcm);
  expect(c.events.flatMap(event=>Array.from(event.waveform.peaks))).toEqual(expectedPeaks(f.pcm));
  expect(c.events.map(event=>event.waveform.completedSamples)).toEqual([20000,40000,f.samples]);
  expect(c.store.appendPCM.mock.calls.map(([bytes])=>bytes.length),`verify calls: ${c.verify.mock.calls.length}`)
    .toEqual([40000,40000,f.pcm.length-80000]);
  expect(c.store.close).toHaveBeenCalledOnce();
});

it('小 stdout chunks 不增加來源與檔案權威驗證的往返次數',async()=>{
  const counts=[];
  for(const chunkBytes of [40000,257]){
    const f=fixture(),c=continuousCaller(f);
    const result=await c.run(async(_args,options)=>sendPcm(options,f.pcm,chunkBytes));
    expect(fs.readFileSync(result.wave).subarray(44)).toEqual(f.pcm);
    counts.push(c.verify.mock.calls.length);
  }
  expect(counts[1]).toBe(counts[0]);
});

it.each([1,2])('EOF 少 %i byte 不提交未完整的尾段，只保留已完成5秒 checkpoint',async missingBytes=>{
  const f=fixture(5.5),c=continuousCaller(f);
  await expect(c.run(async(_args,options)=>sendPcm(options,f.pcm.subarray(0,-missingBytes),257))).rejects.toThrow('PCM 未完整到達');
  expect(c.store.writtenSamples).toBe(CHECKPOINT_SAMPLES);expect(c.store.completedSamples).toBe(CHECKPOINT_SAMPLES);
  expect(c.events.map(event=>event.waveform.completedSamples)).toEqual([CHECKPOINT_SAMPLES]);
  expect(c.store.complete).not.toHaveBeenCalled();expect(c.store.close).toHaveBeenCalledOnce();
});

it('PCM 全數到達但解碼程序失敗，不提交不足5秒的尾段或宣告完成',async()=>{
  const f=fixture(5.5),c=continuousCaller(f),error=Object.assign(new Error('decoder failed'),{code:'FFMPEG_EXIT'});
  await expect(c.run(async(_args,options)=>{sendPcm(options,f.pcm,257);throw error;})).rejects.toBe(error);
  expect(c.store.writtenSamples).toBe(CHECKPOINT_SAMPLES);expect(c.store.completedSamples).toBe(CHECKPOINT_SAMPLES);
  expect(c.events).toHaveLength(1);expect(c.store.complete).not.toHaveBeenCalled();expect(c.store.close).toHaveBeenCalledOnce();
});

it('取消未滿一塊的 PCM 不寫入或發布，已保存 prefix 可重新逐 sample 續算',async()=>{
  const f=fixture();let cancelled=false;
  const verify=vi.fn(()=>{if(cancelled)throw Object.assign(new Error('cancelled'),{code:'INGEST_SUPERSEDED'});});
  const c=continuousCaller(f,{verify});
  await expect(c.run(async(_args,options)=>{
    options.onPcm(f.pcm.subarray(0,40000));options.onPcm(f.pcm.subarray(40000,40127));cancelled=true;
  })).rejects.toMatchObject({code:'INGEST_SUPERSEDED'});
  expect(c.store.writtenSamples).toBe(CHECKPOINT_SAMPLES);expect(c.store.completedSamples).toBe(CHECKPOINT_SAMPLES);
  expect(c.events).toHaveLength(1);expect(c.store.close).toHaveBeenCalledOnce();
  const resumed=continuousCaller(f),execute=vi.fn(async(args,options)=>{
    const start=Number(args[args.indexOf('-ss')+1])*8000;sendPcm(options,f.pcm.subarray(start),257);
  });
  const result=await resumed.run(execute);
  expect(result.resumedSamples).toBe(CHECKPOINT_SAMPLES);expect(execute).toHaveBeenCalledOnce();
  expect(fs.readFileSync(result.wave).subarray(44)).toEqual(f.pcm);
  expect(resumed.events.flatMap(event=>Array.from(event.waveform.peaks))).toEqual(expectedPeaks(f.pcm));
});

it('超出來源長度的 PCM chunk 不寫入或完成，保留先前已保存的 prefix',async()=>{
  const f=fixture(5.5),c=continuousCaller(f),child={kill:vi.fn()};
  await expect(c.run(async(_args,options)=>{
    options.onProcess(child);options.onPcm(f.pcm.subarray(0,40000));
    options.onPcm(Buffer.concat([f.pcm.subarray(40000),Buffer.alloc(2)]));
  })).rejects.toThrow('超出來源 sample 範圍');
  expect(child.kill).toHaveBeenCalledOnce();expect(c.store.writtenSamples).toBe(CHECKPOINT_SAMPLES);
  expect(c.store.complete).not.toHaveBeenCalled();expect(c.events).toHaveLength(1);expect(c.store.close).toHaveBeenCalledOnce();
});

it.each([false,true])('續算重疊 sample 不同會從原點再核對完整 prefix，永久不一致=%s',async permanentMismatch=>{
  const f=fixture(),c=continuousCaller(f,{savedSamples:40000});
  const execute=vi.fn(async(args,options)=>{
    const start=Number(args[args.indexOf('-ss')+1])*4000,bytes=Buffer.from(f.pcm.subarray(start*2));
    if(start)bytes[(39000-start)*2]^=127;
    else if(permanentMismatch)bytes[123*2]^=127;
    sendPcm(options,bytes,257);
  });
  const result=c.run(execute);
  if(permanentMismatch){
    await expect(result).rejects.toMatchObject({code:'SOURCE_WAVE_RESUME_MISMATCH'});
    expect(c.store.writtenSamples).toBe(40000);expect(c.store.complete).not.toHaveBeenCalled();
  }else{
    expect(fs.readFileSync((await result).wave).subarray(44)).toEqual(f.pcm);
    expect(c.events.flatMap(event=>Array.from(event.waveform.peaks))).toEqual(expectedPeaks(f.pcm));
  }
  expect(execute.mock.calls.map(([args])=>args[args.indexOf('-ss')+1])).toEqual(['7','0']);
  expect(c.store.close).toHaveBeenCalledOnce();
});
