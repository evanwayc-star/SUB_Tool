import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {afterEach,expect,it,vi} from 'vitest';
const require=createRequire(import.meta.url);
const {createMediaIntakeRuntime,cacheKeyFor}=require('../electron/media-intake-runtime');
const {sharedSourceFingerprintSync}=require('../electron/mother-source-evidence');
const {FileAuthority}=require('../electron/file-authority');
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
