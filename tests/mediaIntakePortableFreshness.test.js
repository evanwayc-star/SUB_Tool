import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';

const require=createRequire(import.meta.url);
const {createMediaIntakeRuntime,cacheKeyFor}=require('../electron/media-intake-runtime.js');
const {sharedSourceFingerprintSync}=require('../electron/mother-source-evidence.js');
const {FileAuthority}=require('../electron/file-authority.js');
const roots=[],runtimes=[];
const outputs=args=>args.filter(value=>/\.(mp4|m4a|wav)$/.test(value));

function setup(){
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-portable-freshness-'));roots.push(root);
  const src=path.join(root,'mother.mxf'),cacheRoot=path.join(root,'cache'),tempRoot=path.join(root,'temp');
  fs.mkdirSync(cacheRoot);fs.mkdirSync(tempRoot);fs.writeFileSync(src,Buffer.alloc(4*1024*1024,27));
  const request={src,duration:1,needsProxy:true,audio:[{channels:1}]};
  const open=(options={})=>{
    const execute=vi.fn(async(args,nativeOptions)=>{
      for(const output of outputs(args))fs.writeFileSync(output,Buffer.alloc(1024,path.basename(output).length));
      await options.afterWrite?.(args,nativeOptions);
    });
    const runtime=createMediaIntakeRuntime({cacheRoot,tempRoot,allowSidecarCache:true,
      fileAuthority:new FileAuthority({internalDirectories:[cacheRoot,tempRoot]}),delay:async()=>{},
      ffmpegExecution:{execute},sendProgress:options.sendProgress});
    runtimes.push(runtime);return {runtime,execute};
  };
  return {root,src,request,open};
}

// A prior full-content receipt is valid input; manufacture it from the exact
// fixture bytes, preserving the independently recorded shared-file witness.
function seedPriorSha(directory,src){
  const sourceContent={format:'source-v3-sha256',size:fs.statSync(src).size,
    sha256:crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex')};
  const visit=dir=>{
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const file=path.join(dir,entry.name);
      if(entry.isDirectory())visit(file);
      else if(entry.isFile()&&entry.name.endsWith('.json')){
        const raw=JSON.parse(fs.readFileSync(file,'utf8'));
        if(raw.sourceContent)fs.writeFileSync(file,JSON.stringify({...raw,sourceContent}));
      }
    }
  };
  visit(directory);
}

function sourceBirthtimeChange(src){
  const descriptors=new Set(),open=fs.openSync,close=fs.closeSync,stat=fs.statSync,fstat=fs.fstatSync;
  let changed=false;
  const alter=value=>changed?Object.assign(Object.create(Object.getPrototypeOf(value)),value,{birthtimeNs:value.birthtimeNs+1n}):value;
  vi.spyOn(fs,'openSync').mockImplementation((file,...args)=>{
    const fd=open(file,...args);if(file===src)descriptors.add(fd);return fd;
  });
  vi.spyOn(fs,'closeSync').mockImplementation(fd=>{descriptors.delete(fd);return close(fd);});
  vi.spyOn(fs,'statSync').mockImplementation((file,options)=>{
    const value=stat(file,options);return file===src&&options?.bigint?alter(value):value;
  });
  vi.spyOn(fs,'fstatSync').mockImplementation((fd,options)=>{
    const value=fstat(fd,options);return descriptors.has(fd)&&options?.bigint?alter(value):value;
  });
  return ()=>{changed=true;};
}

afterEach(async()=>{
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map(runtime=>runtime.close()));
  for(const root of roots.splice(0)){
    const resolved=fs.realpathSync(root);
    if(path.dirname(resolved)!==fs.realpathSync(os.tmpdir())||!path.basename(resolved).startsWith('subtool-portable-freshness-'))
      throw new Error('拒絕清除未核對的來源 freshness 測試目錄');
    fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
});

it.each(['cache-ready','writer','publication'])('舊 SHA 收據在 %s 期間共享身分改變，strict 相同仍拒絕交付或補件 publication',async phase=>{
  const f=setup(),producer=f.open(),saved=await producer.runtime.ingest(f.request);
  await producer.runtime.close();
  const directory=path.dirname(path.dirname(saved.proxy));
  seedPriorSha(directory,f.src);
  const metaPath=path.join(directory,'meta.json'),priorMeta=fs.readFileSync(metaPath),priorProxy=fs.readFileSync(saved.proxy);
  const receipt=path.join(directory,'source-'+cacheKeyFor(f.src)+'.json'),priorReceipt=fs.readFileSync(receipt);
  const key=cacheKeyFor(f.src),shared=sharedSourceFingerprintSync(f.src),change=sourceBirthtimeChange(f.src);
  if(phase!=='cache-ready')fs.truncateSync(saved.wave,2);
  if(phase==='publication'){
    const rename=fs.renameSync;
    vi.spyOn(fs,'renameSync').mockImplementation((from,to)=>{
      if(path.basename(to)==='cache-meta.json')change();
      return rename(from,to);
    });
  }
  const reader=f.open({
    afterWrite:()=>{if(phase==='writer')change();},
    sendProgress:(_target,payload)=>{if(phase==='cache-ready'&&payload.stage==='cache-ready')change();},
  });
  await expect(reader.runtime.ingest(f.request)).rejects.toThrow('母素材');
  expect(cacheKeyFor(f.src)).toBe(key);
  expect(sharedSourceFingerprintSync(f.src)).not.toBe(shared);
  expect(fs.readFileSync(saved.proxy)).toEqual(priorProxy);
  expect(fs.readFileSync(metaPath)).toEqual(priorMeta);
  expect(fs.readFileSync(receipt)).toEqual(priorReceipt);
  expect(fs.readdirSync(directory).filter(name=>name.startsWith('generation-')))
    .toEqual([path.basename(path.dirname(saved.proxy))]);
  expect(reader.execute).toHaveBeenCalledTimes(phase==='cache-ready'?0:1);
  if(phase!=='cache-ready')expect(outputs(reader.execute.mock.calls[0][0]).map(file=>path.basename(file))).toEqual(['wave.wav']);
});
