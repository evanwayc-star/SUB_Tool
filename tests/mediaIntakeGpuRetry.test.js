import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require=createRequire(import.meta.url);
const {createMediaIntakeRuntime}=require('../electron/media-intake-runtime.js');
const {FileAuthority}=require('../electron/file-authority.js');
const {createFFmpegExecution}=require('../electron/ffmpeg-execution-engine.js');
const roots=[];
const gpuError=()=>Object.assign(new Error('CUDA_ERROR_NO_DEVICE'),{code:'FFMPEG_EXIT'});
function fixture(execute,extra={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'subtool-intake-gpu-'));roots.push(root);
  const src=path.join(root,'source.bin'),cacheRoot=path.join(root,'cache');fs.writeFileSync(src,'mother');
  const calls=[];
  const runtime=createMediaIntakeRuntime({tempRoot:root,cacheRoot,allowSidecarCache:false,
    fileAuthority:new FileAuthority({internalDirectories:[cacheRoot]}),delay:async()=>{},
    getEncoder:()=> 'h264_nvenc',describeVideo:async()=>({codec:'h264',pixelFormat:'yuv420p',width:1920,height:1080}),
    ffmpegExecution:{execute:(args,options)=>{calls.push(args);return execute(args,calls.length,options);}},...extra});
  return {runtime,src,calls};
}
function output(args) { return args.find(value=>value.endsWith('proxy.mp4')); }
function writeOutputs(args,fill=1) {
  for(const name of args.filter(value=>/\.(?:mp4|m4a|wav)$/.test(value))) fs.writeFileSync(name,Buffer.alloc(131072,fill));
}
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});

it('CUDA 解碼、上傳及相容 NVENC 失敗後以 CPU 成功，只提交最後實際內容',async()=>{
  const progress=[];
  const f=fixture(async(args,n)=>{writeOutputs(args,n);if(n<4)throw gpuError();},{sendProgress:(_target,payload)=>progress.push(payload)});
  try {
    const result=await f.runtime.ingest({src:f.src,duration:1,needsProxy:true,audio:[{channels:1}]});
    expect(f.calls).toHaveLength(4);
    expect(new Set(f.calls.map(output)).size).toBe(4);
    expect(fs.existsSync(path.dirname(output(f.calls[0])))).toBe(false);
    expect(fs.existsSync(path.dirname(output(f.calls[1])))).toBe(false);
    expect(fs.existsSync(path.dirname(output(f.calls[2])))).toBe(false);
    expect(f.calls[0]).toContain('cuda');
    expect(f.calls[1][f.calls[1].indexOf('-vf')+1]).toContain('hwupload_cuda');
    expect(f.calls[2][f.calls[2].indexOf('-vf')+1]).not.toContain('scale_cuda');
    expect(f.calls[2]).toContain('h264_nvenc');expect(f.calls[3]).toContain('libx264');
    expect(fs.readFileSync(result.proxy)[0]).toBe(4);
    expect(fs.readFileSync(result.channels[0].file)[0]).toBe(4);
    expect(progress.filter(event=>event.done)).toHaveLength(1);
    expect(progress.find(event=>event.done).outcome).toBe('success');
  } finally {await f.runtime.close();}
});

it.each(['cancel','close','io'])('%s 後不重試或提交',async action=>{
  let cancelled=false,release,started;const gate=new Promise(r=>{release=r;}),entered=new Promise(r=>{started=r;});
  const f=fixture(async args=>{writeOutputs(args);started();await gate;throw action==='io'?Object.assign(new Error('disk error'),{code:'EIO'}):gpuError();});
  const pending=f.runtime.ingest({src:f.src,duration:1,needsProxy:true,audio:[]},{isCancelled:()=>cancelled});
  try {await entered;if(action==='cancel')cancelled=true;if(action==='close')await f.runtime.close();release();
    await expect(pending).rejects.toThrow();expect(f.calls).toHaveLength(1);
  } finally {release();await pending.catch(()=>{});await f.runtime.close();}
});

it('失敗的 generation 被同名替換時保留外物，且不再啟動 writer',async()=>{
  let foreign;
  const f=fixture(async args=>{
    writeOutputs(args);
    const dir=path.dirname(output(args));fs.renameSync(dir,dir+'-original');fs.mkdirSync(dir);
    foreign=path.join(dir,'foreign.txt');fs.writeFileSync(foreign,'外來資料');throw gpuError();
  });
  try {
    await expect(f.runtime.ingest({src:f.src,duration:1,needsProxy:true,audio:[]})).rejects.toThrow();
    expect(f.calls).toHaveLength(1);expect(fs.readFileSync(foreign,'utf8')).toBe('外來資料');
  } finally {await f.runtime.close();}
});

it('重試前母素材變更不得以舊來源證據再啟動 writer',async()=>{
  let source;
  const f=fixture(async args=>{writeOutputs(args);fs.writeFileSync(source,'different mother');throw gpuError();});
  source=f.src;
  try {
    await expect(f.runtime.ingest({src:f.src,duration:1,needsProxy:true,audio:[]})).rejects.toThrow('母素材在轉檔期間變更');
    expect(f.calls).toHaveLength(1);
  } finally {await f.runtime.close();}
});

it('已完成音訊在重試時保留原 bytes 與路徑',async()=>{
  const f=fixture(async(args,n)=>{writeOutputs(args,n);if(n===2)throw gpuError();});
  try {
    const request={src:f.src,duration:1,audio:[{channels:1}]};
    const audio=await f.runtime.ingest({...request,needsProxy:false});
    expect(f.calls[0]).not.toContain('-hwaccel');
    const bytes=fs.readFileSync(audio.channels[0].file);
    const result=await f.runtime.ingest({...request,needsProxy:true});
    expect(f.calls).toHaveLength(3);
    expect(result.channels[0].file).toBe(audio.channels[0].file);
    expect(fs.readFileSync(result.channels[0].file)).toEqual(bytes);
    expect(fs.readFileSync(result.proxy)[0]).toBe(3);
  } finally {await f.runtime.close();}
});

it('真正的 execution 在舊 child close 前不啟動下一個 writer',async()=>{
  const logs=fs.mkdtempSync(path.join(os.tmpdir(),'subtool-intake-gpu-'));roots.push(logs);
  const children=[];
  const execution=createFFmpegExecution({getFFmpegPath:()=> 'fake-ffmpeg',getUserDataDir:()=>logs,
    spawnDirect:(_binary,args)=>{
      const child=new EventEmitter();child.stderr=new EventEmitter();children.push(child);
      writeOutputs(args,children.length);
      if(children.length===1)queueMicrotask(()=>{child.stderr.emit('data',Buffer.from('CUDA_ERROR_NO_DEVICE'));child.emit('exit',1);});
      else queueMicrotask(()=>child.emit('close',0));
      return child;
    }});
  const f=fixture(()=>{}, {ffmpegExecution:execution});
  const pending=f.runtime.ingest({src:f.src,duration:1,needsProxy:true,audio:[]});
  try {
    await vi.waitFor(()=>expect(children).toHaveLength(1));
    await new Promise(resolve=>setImmediate(resolve));expect(children).toHaveLength(1);
    children[0].emit('close',1);
    const result=await pending;expect(children).toHaveLength(2);expect(fs.readFileSync(result.proxy)[0]).toBe(2);
  } finally {children[0]?.emit('close',1);await pending.catch(()=>{});await f.runtime.close();await execution.cancelAllAndWait();}
});

it('串流舊 attempt 的 stat 晚回來不能發布失敗檔',async()=>{
  let statEntered,releaseStat,secondStarted,finishSecond;
  const entered=new Promise(r=>{statEntered=r;}), gate=new Promise(r=>{releaseStat=r;});
  const second=new Promise(r=>{secondStarted=r;}), finish=new Promise(r=>{finishSecond=r;});
  let firstPath;
  const f=fixture(async(args,n)=>{
    writeOutputs(args,n);
    if(n===1){firstPath=output(args);await entered;throw gpuError();}
    secondStarted();await finish;
  });
  const original=fs.promises.stat.bind(fs.promises);
  vi.spyOn(fs.promises,'stat').mockImplementation(async(file,...args)=>{
    const result=await original(file,...args);
    if(file===firstPath){statEntered();await gate;}
    return result;
  });
  const pending=f.runtime.stream({src:f.src,duration:1,audio:[]});
  try {
    await second;releaseStat();const work=await pending;
    expect(f.calls).toHaveLength(2);expect(work.response.proxy).toBe(output(f.calls[1]));
    expect(fs.readFileSync(work.response.proxy)[0]).toBe(2);
    finishSecond();await work.completion;
  } finally {releaseStat();finishSecond();await pending.catch(()=>{});await f.runtime.close();}
});

it('串流 URL 已發布時 writer 失敗不可切換或重試',async()=>{
  let fail;const gate=new Promise(r=>{fail=r;});
  const f=fixture(async args=>{writeOutputs(args);await gate;throw gpuError();});
  try {
    const work=await f.runtime.stream({src:f.src,duration:1,audio:[]});
    const original=work.response.proxy;fail();await work.completion;
    expect(f.calls).toHaveLength(1);expect(work.response.proxy).toBe(original);
  } finally {fail();await f.runtime.close();}
});

it.each(['live','cached'])('%s stream lease 不得讀取同名替換的 generation',async mode=>{
  const f=fixture(async args=>writeOutputs(args));
  try {
    const request={src:f.src,duration:1,audio:[]};
    const first=await f.runtime.stream(request);await first.completion;
    const work=mode==='cached'?await f.runtime.stream(request):first;
    const response=work.response||work;
    const dir=path.dirname(response.proxy),moved=dir+'-original';
    fs.renameSync(dir,moved);fs.mkdirSync(dir);fs.writeFileSync(response.proxy,Buffer.alloc(131072,77));
    const result=await fetch(response.streamUrl,{headers:{Range:'bytes=0-15'}});
    expect(result.status).not.toBe(206);
    expect(fs.readFileSync(response.proxy)[0]).toBe(77);
    expect(fs.readFileSync(path.join(moved,'proxy.mp4'))[0]).toBe(1);
  } finally {await f.runtime.close();}
});

it('串流可播前 generation 已被替換時，不發布 URL 並保留兩份資料',async()=>{
  let moved,foreign;
  const f=fixture(async(args,_n,options)=>{
    writeOutputs(args);const dir=path.dirname(output(args));moved=dir+'-original';
    fs.renameSync(dir,moved);fs.mkdirSync(dir);foreign=output(args);fs.writeFileSync(foreign,Buffer.alloc(131072,77));
    await new Promise(resolve=>options.onProcess({kill:resolve}));
  });
  try {
    await expect(f.runtime.stream({src:f.src,duration:1,audio:[]})).rejects.toThrow();
    expect(fs.readFileSync(foreign)[0]).toBe(77);
    expect(fs.readFileSync(path.join(moved,'proxy.mp4'))[0]).toBe(1);
  } finally {await f.runtime.close();}
});

it('generation 未變但 Proxy 本身被同名替換時不能供應新檔',async()=>{
  const f=fixture(async args=>writeOutputs(args));
  try {
    const work=await f.runtime.stream({src:f.src,duration:1,audio:[]});await work.completion;
    const file=work.response.proxy,moved=file+'.original';
    fs.renameSync(file,moved);fs.writeFileSync(file,Buffer.alloc(131072,77));
    const response=await fetch(work.response.streamUrl,{headers:{Range:'bytes=0-15'}});
    expect(response.status).not.toBe(206);
    expect(fs.readFileSync(file)[0]).toBe(77);expect(fs.readFileSync(moved)[0]).toBe(1);
  } finally {await f.runtime.close();}
});

it('母素材消失或索引更新不撤銷已授權的串流檔案',async()=>{
  const f=fixture(async args=>writeOutputs(args));
  try {
    const request={src:f.src,duration:1,audio:[]};
    const live=await f.runtime.stream(request);await live.completion;
    const cached=await f.runtime.stream(request);
    fs.unlinkSync(f.src);
    fs.writeFileSync(path.join(path.dirname(path.dirname(live.response.proxy)),'meta.json'),'更新的索引');
    for(const url of [live.response.streamUrl,cached.streamUrl]) {
      const response=await fetch(url,{headers:{Range:'bytes=0-15'}});
      expect(response.status).toBe(206);expect(new Uint8Array(await response.arrayBuffer())[0]).toBe(1);
    }
  } finally {await f.runtime.close();}
});

it('進度回報各次實際 GPU 策略與最後 CPU 退路，純音訊不帶策略',async()=>{
  const events=[];
  const f=fixture(async(args,n,options)=>{
    options.onProgress({label:options.label,pct:20});writeOutputs(args,n);
    if(n<4)throw gpuError();
  },{sendProgress:(_target,payload)=>events.push(payload)});
  try {
    await f.runtime.ingest({src:f.src,duration:1,needsProxy:true,audio:[]});
    const labels=events.filter(event=>event.stage==='transcoding'&&!event.done).map(event=>event.label);
    expect(labels).toEqual(expect.arrayContaining([expect.stringContaining('GPU 解碼／縮放／編碼'),
      expect.stringContaining('GPU 縮放／編碼'),expect.stringContaining('GPU 編碼'),expect.stringContaining('CPU 轉檔')]));
    expect(events.filter(event=>event.done)).toHaveLength(1);
    events.length=0;
    await f.runtime.ingest({src:f.src,duration:1,needsProxy:false,audio:[{channels:1}]});
    expect(events.filter(event=>event.stage==='transcoding'&&!event.done)).toEqual([
      expect.objectContaining({label:'正在分析音訊',pct:20}),
    ]);
  } finally {await f.runtime.close();}
});
