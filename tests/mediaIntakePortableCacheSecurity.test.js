import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';

const require=createRequire(import.meta.url);
const {createMediaIntakeRuntime,cacheKeyFor}=require('../electron/media-intake-runtime.js');
const {FileAuthority}=require('../electron/file-authority.js');
const roots=[],runtimes=[];
const outputs=args=>args.filter(arg=>/\.(?:mp4|wav|m4a)$/.test(arg));
function fixture(){
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-portable-security-'));roots.push(root);
  const source=path.join(root,'mother.bin');fs.writeFileSync(source,'mother source');
  const cacheRoot=path.join(root,'profile','cache');
  const authority=new FileAuthority({internalDirectories:[cacheRoot]});
  const create=(execute=async args=>{for(const output of outputs(args))fs.writeFileSync(output,'safe '+path.basename(output));}, overrides={})=>{
    const runtime=createMediaIntakeRuntime({cacheRoot,tempRoot:root,fileAuthority:authority,
      delay:async()=>{},ffmpegExecution:{execute},...overrides});runtimes.push(runtime);return runtime;
  };
  return {root,source,cacheRoot,authority,create};
}
function get(url,method='GET',range,headers=false){return new Promise((resolve,reject)=>{
  const request=http.request(url,{method,headers:range?{Range:range}:{}},response=>{
    const chunks=[];response.on('data',chunk=>chunks.push(chunk));
    response.on('end',()=>resolve({status:response.statusCode,bytes:Buffer.concat(chunks).toString(),...(headers?{headers:response.headers}:{})}));
    response.on('error',reject);
  });request.on('error',reject);request.end();
});}
afterEach(async()=>{
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map(runtime=>runtime.close()));
  for(const root of roots.splice(0)){
    const resolved=fs.realpathSync(root);
    if(path.dirname(resolved)!==fs.realpathSync(os.tmpdir())||!path.basename(resolved).startsWith('subtool-portable-security-'))throw new Error('cleanup boundary');
    fs.rmSync(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
});

it.each(['ingest','stream'])('%s 可寫性檢查不得截斷或刪除既有 hardlink 探針檔',async mode=>{
  const {root,source,create}=fixture();
  const directory=path.join(root,'.subtool_Cache',cacheKeyFor(source));
  fs.mkdirSync(directory,{recursive:true});
  const original=path.join(root,'keep-original.txt'),probe=path.join(directory,'.wtest_'+process.pid);
  fs.writeFileSync(original,'PRESERVE ORIGINAL BYTES');fs.linkSync(original,probe);
  const runtime=create(),work=await runtime[mode]({src:source,duration:1,needsProxy:true,audio:[]});
  await work.completion;
  expect(fs.readFileSync(original,'utf8')).toBe('PRESERVE ORIGINAL BYTES');
  expect(fs.readFileSync(probe,'utf8')).toBe('PRESERVE ORIGINAL BYTES');
  expect(fs.readFileSync((work.response||work).proxy,'utf8')).toBe('safe proxy.mp4');
});

it.each([undefined,'bytes=0-0'])('HEAD %s 的長度資訊也不能在 realpath 後改讀外部檔案',async range=>{
  const {root,source,create}=fixture(),runtime=create(),request={src:source,duration:1,audio:[]};
  await runtime.ingest({...request,needsProxy:true});const stream=await runtime.stream(request);
  const generation=path.dirname(stream.proxy),outside=path.join(root,'outside');fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside,'proxy.mp4'),'UNGRANTED_PRIVATE_BYTES');
  const original=fsp.stat;let replaced=false;
  vi.spyOn(fsp,'stat').mockImplementation(async(file,options)=>{
    if(file===stream.proxy&&!options&&!replaced){
      replaced=true;fs.renameSync(generation,generation+'-saved');fs.symlinkSync(outside,generation,'junction');
    }
    return original(file,options);
  });
  const result=await get(stream.streamUrl,'HEAD',range,true).catch(error=>({error:error.message}));
  if(!result.error&&[200,206].includes(result.status)){
    if(range)expect(result.headers['content-range']).toBe('bytes 0-0/14');
    else expect(result.headers['content-length']).toBe('14');
  }else expect(result.bytes||'').not.toContain('UNGRANTED_PRIVATE_BYTES');
});

it.each(['proxy','wave','channel'])('複製來的共用 %s 不能經 generation junction 取得 cache 外檔案能力',async component=>{
  const {root,source,authority,create}=fixture();
  const runtime=create(),request={src:source,duration:1,needsProxy:true,audio:[{channels:1}]};
  const original=await runtime.ingest(request);
  const cache=path.join(root,'.subtool_Cache',cacheKeyFor(source));
  const other=path.join(root,'second-computer');fs.mkdirSync(other);
  const moved=path.join(other,'mother.bin');fs.copyFileSync(source,moved);
  const copied=path.join(other,'.subtool_Cache',path.basename(cache));fs.cpSync(cache,copied,{recursive:true});
  const outside=path.join(root,'private');fs.mkdirSync(outside);
  const filename=component==='proxy'?'proxy.mp4':component==='wave'?'wave.wav':'ch_01.m4a';
  const privateFile=path.join(outside,filename);fs.writeFileSync(privateFile,'UNGRANTED_PRIVATE_BYTES');
  fs.symlinkSync(outside,path.join(copied,'external-generation'),'junction');
  const metaPath=path.join(copied,'meta.json'),meta=JSON.parse(fs.readFileSync(metaPath,'utf8'));
  if(component==='channel')meta.channels[0].file='external-generation/'+filename;
  else meta[component]='external-generation/'+filename;
  fs.writeFileSync(metaPath,JSON.stringify(meta));
  const reader=create(async()=>{throw new Error('unsafe cache rejected before rebuild');});
  await expect(reader.ingest({...request,src:moved})).rejects.toThrow('unsafe cache rejected before rebuild');
  expect(authority.canRead(privateFile)).toBe(false);
  expect(fs.readFileSync(component==='proxy'?original.proxy:component==='wave'?original.wave:original.channels[0].file,'utf8')).toContain('safe');
});

it.each(['generation','source-key'].flatMap(level=>[['GET',undefined],['GET','bytes=0-21'],['HEAD',undefined],['HEAD','bytes=0-21']]
  .map(([method,range])=>({level,method,range}))))
('lease 發出後換 $level junction，$method $range 仍不能讀 cache 外的 bytes',async({level,method,range})=>{
  const {root,source,create}=fixture(),runtime=create();
  const request={src:source,duration:1,audio:[]};
  await runtime.ingest({...request,needsProxy:true});
  const stream=await runtime.stream(request);
  expect((await get(stream.streamUrl)).bytes).toBe('safe proxy.mp4');
  const directory=level==='generation'?path.dirname(stream.proxy):path.dirname(path.dirname(stream.proxy));
  const outside=path.join(root,'outside'),file=path.join(outside,path.relative(directory,stream.proxy));
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'UNGRANTED_PRIVATE_BYTES');
  fs.renameSync(directory,directory+'-saved');fs.symlinkSync(outside,directory,'junction');
  const result=await get(stream.streamUrl,method,range).catch(error=>({error:error.message}));
  expect(result.bytes||'').not.toContain('UNGRANTED_PRIVATE_BYTES');
  expect(result.status===200||result.status===206).toBe(false);
});

it('來源 key junction 不得准入或作為補建位置，原快取 bytes 保留',async()=>{
  const {root,source,create}=fixture(),runtime=create();
  const request={src:source,duration:1,needsProxy:true,audio:[]};
  const original=await runtime.ingest(request),old=path.dirname(path.dirname(original.proxy));
  const target=path.join(root,'second-computer');fs.mkdirSync(target);
  const moved=path.join(target,'mother.bin');fs.copyFileSync(source,moved);
  const sidecar=path.join(target,'.subtool_Cache');fs.mkdirSync(sidecar);
  fs.symlinkSync(old,path.join(sidecar,cacheKeyFor(moved)),'junction');
  const before=fs.readFileSync(path.join(old,'meta.json'));
  const reader=create(async()=>{throw new Error('unsafe key directory rejected');});
  await expect(reader.ingest({...request,src:moved})).rejects.toThrow('unsafe key directory rejected');
  expect(fs.readFileSync(path.join(old,'meta.json'))).toEqual(before);
  expect(fs.readFileSync(original.proxy,'utf8')).toBe('safe proxy.mp4');
});

it('配置的 cache root 掛載仍允許正常 key/generation 播放，不把掛載等同 key 逃逸',async()=>{
  const {root,source,cacheRoot,create}=fixture();
  const mount=path.join(root,'mounted-cache');fs.mkdirSync(mount);fs.mkdirSync(path.dirname(cacheRoot),{recursive:true});
  fs.symlinkSync(mount,cacheRoot,'junction');
  const runtime=create(undefined,{allowSidecarCache:false}),request={src:source,duration:1,audio:[]};
  await runtime.ingest({...request,needsProxy:true});
  const stream=await runtime.stream(request);
  expect(stream.cached).toBe(true);expect((await get(stream.streamUrl)).bytes).toBe('safe proxy.mp4');
});

it('通過圍堵與開啟後再換 junction，Range 只讀原 handle 或在 OS 拒絕變更時中止',async()=>{
  const {root,source,create}=fixture(),runtime=create(),request={src:source,duration:1,audio:[]};
  await runtime.ingest({...request,needsProxy:true});const stream=await runtime.stream(request);
  const generation=path.dirname(stream.proxy),outside=path.join(root,'outside');fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside,'proxy.mp4'),'UNGRANTED_PRIVATE_BYTES');
  const original=fs.createReadStream;
  let attackError;
  vi.spyOn(fs,'createReadStream').mockImplementation((file,options)=>{
    if(file===stream.proxy){
      try {fs.renameSync(generation,generation+'-saved');fs.symlinkSync(outside,generation,'junction');}
      catch(error){attackError=error;throw error;}
    }
    return original(file,options);
  });
  const result=await get(stream.streamUrl,'GET','bytes=0-13').catch(error=>({error:error.message}));
  if(attackError){
    // Windows 禁止更名含有此已開啟檔案的目錄；這條安全拒絕不能被誤報為原 bytes 成功。
    expect(process.platform).toBe('win32');expect(attackError.code).toBe('EPERM');
    expect(result).toHaveProperty('error');
    expect(fs.readFileSync(stream.proxy,'utf8')).toBe('safe proxy.mp4');
  }else expect(result).toEqual({status:206,bytes:'safe proxy.mp4'});
});

it.each(['ingest','stream'])('%s 唯讀快取補建在准入後換 junction，不可複製外檔或提前發布串流',async mode=>{
  const {root,source,create}=fixture(),producer=create();
  const original=await producer.ingest({src:source,duration:1,needsProxy:true,audio:[]});
  const old=path.dirname(path.dirname(original.proxy)),target=path.join(root,'second-computer');fs.mkdirSync(target);
  const moved=path.join(target,'mother.bin');fs.copyFileSync(source,moved);
  const sharedRoot=path.join(target,'.subtool_Cache'),copied=path.join(sharedRoot,path.basename(old));fs.cpSync(old,copied,{recursive:true});
  const metaPath=path.join(copied,'meta.json'),before=fs.readFileSync(metaPath);
  const generation=path.join(copied,path.relative(old,path.dirname(original.proxy))),outside=path.join(root,'private');fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside,'proxy.mp4'),'UNGRANTED_PRIVATE_BYTES');
  const write=fs.writeFileSync,open=fs.openSync;let replaced=false;
  vi.spyOn(fs,'openSync').mockImplementation((file,flags,...args)=>{
    if(typeof file==='string'&&path.resolve(file).startsWith(sharedRoot+path.sep)&&flags==='wx'){
      if(path.basename(file).startsWith('.wtest_')&&!replaced){
        replaced=true;fs.renameSync(generation,generation+'-saved');fs.symlinkSync(outside,generation,'junction');
      }
      throw Object.assign(new Error('shared cache read-only'),{code:'EACCES'});
    }
    return open(file,flags,...args);
  });
  vi.spyOn(fs,'writeFileSync').mockImplementation((file,...args)=>{
    if(typeof file==='string'&&path.resolve(file).startsWith(sharedRoot+path.sep)){
      if(path.basename(file).startsWith('.wtest_')&&!replaced){
        replaced=true;fs.renameSync(generation,generation+'-saved');fs.symlinkSync(outside,generation,'junction');
      }
      throw Object.assign(new Error('shared cache read-only'),{code:'EACCES'});
    }
    return write(file,...args);
  });
  const encode=vi.fn(async args=>{for(const file of outputs(args))write(file,'new audio');});
  const consumer=create(encode);
  await expect(consumer[mode]({src:moved,duration:1,needsProxy:true,audio:[{channels:1}]}))
    .rejects.toThrow(/快取元件超出實際目錄/);
  expect(replaced).toBe(true);expect(encode).not.toHaveBeenCalled();
  expect(fs.readFileSync(metaPath)).toEqual(before);
  expect(fs.readFileSync(original.proxy,'utf8')).toBe('safe proxy.mp4');
});
