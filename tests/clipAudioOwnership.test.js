import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require=createRequire(import.meta.url);
const {createClipAudioCache}=require('../electron/clip-audio-cache.js');
const {FileAuthority}=require('../electron/file-authority.js');
const roots=[];
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
function wave() {
  const bytes=Buffer.alloc(44+48000*2);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);
  bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);
  bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(96000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);
  bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40);return bytes;
}
const stagingIn=cache=>{
  const bucket=path.join(cache,fs.readdirSync(cache).find(name=>/^[a-f0-9]{64}$/.test(name)));
  return path.join(bucket,fs.readdirSync(bucket).find(name=>name.startsWith('entry-')),'content.wav');
};
const write=(options,bytes)=>fs.writeFileSync(options.outputDescriptor,bytes);

it('反向音訊 writer 結束後快取根被同名替換，不能刪除替代目錄中的檔案',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'subtool-reverse-owner-'));roots.push(root);
  const source=path.join(root,'source.bin'),cache=path.join(root,'cache');fs.writeFileSync(source,'mother');
  const authority=new FileAuthority();authority.grantTrustedFile(source,{read:true,write:false});
  let foreign,original;
  const runtime=createClipAudioCache({cacheRoot:cache,fileAuthority:authority,execute:async (_args,options)=>{
    const staging=stagingIn(cache);write(options,'original unfinished');
    try {fs.renameSync(cache,cache+'-original');} catch(error) {
      expect(['EPERM','EACCES','EBUSY']).toContain(error.code);original=staging;throw new Error('writer failed');
    }
    fs.mkdirSync(cache);foreign=staging;original=path.join(cache+'-original',path.relative(cache,staging));
    fs.mkdirSync(path.dirname(foreign),{recursive:true});fs.writeFileSync(foreign,'foreign');throw new Error('writer failed');
  }});
  await expect(runtime.reverse({path:source,in:0,out:1,sourceStream:0})).rejects.toThrow('writer failed');
  if(foreign){expect(fs.readFileSync(foreign,'utf8')).toBe('foreign');expect(fs.readFileSync(original,'utf8')).toBe('original unfinished');}
});

it('writer 失敗後 staging 本身被同名替換，不刪除替代檔',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'subtool-reverse-owner-'));roots.push(root);
  const source=path.join(root,'source.bin'),cache=path.join(root,'cache');fs.writeFileSync(source,'mother');
  const authority=new FileAuthority();authority.grantTrustedFile(source,{read:true});let foreign,original;
  const runtime=createClipAudioCache({cacheRoot:cache,fileAuthority:authority,execute:async (_args,options)=>{
    const staging=stagingIn(cache);write(options,'original');original=staging+'.original';
    try{fs.renameSync(staging,original);}catch(error){expect(['EPERM','EACCES','EBUSY']).toContain(error.code);throw new Error('writer failed');}
    foreign=staging;fs.writeFileSync(foreign,'foreign');throw new Error('writer failed');
  }});
  await expect(runtime.reverse({path:source,in:0,out:1,sourceStream:0})).rejects.toThrow('writer failed');
  if(foreign){expect(fs.readFileSync(foreign,'utf8')).toBe('foreign');expect(fs.readFileSync(original,'utf8')).toBe('original');}
});

it('發布時同名成品已被外物占用，不得覆寫',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'subtool-reverse-owner-'));roots.push(root);
  const source=path.join(root,'source.bin'),cache=path.join(root,'cache');fs.writeFileSync(source,'mother');
  const authority=new FileAuthority();authority.grantTrustedFile(source,{read:true});let foreign;
  const runtime=createClipAudioCache({cacheRoot:cache,fileAuthority:authority,execute:async (_args,options)=>{
    const staging=stagingIn(cache);write(options,wave());
    const key=path.basename(path.dirname(path.dirname(staging)));
    foreign=path.join(cache,`${key}.wav`);fs.writeFileSync(foreign,'foreign');
  }});
  const result=await runtime.reverse({path:source,in:0,out:1,sourceStream:0});
  expect(fs.readFileSync(result.path)).toEqual(wave());
  expect(fs.readFileSync(foreign,'utf8')).toBe('foreign');
});

it('清理等待期間 staging 被同名替換，仍須保留替代物',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'subtool-reverse-owner-'));roots.push(root);
  const source=path.join(root,'source.bin'),cache=path.join(root,'cache');fs.writeFileSync(source,'mother');
  const authority=new FileAuthority();authority.grantTrustedFile(source,{read:true});
  let staging,release,entered;const gate=new Promise(resolve=>{release=resolve;}),waiting=new Promise(resolve=>{entered=resolve;});
  const lstat=fsp.lstat.bind(fsp);
  vi.spyOn(fsp,'lstat').mockImplementation(async(file,...args)=>{
    if(file===staging){entered();await gate;}return lstat(file,...args);
  });
  const runtime=createClipAudioCache({cacheRoot:cache,fileAuthority:authority,execute:async (_args,options)=>{
    staging=stagingIn(cache);write(options,'original');throw new Error('writer failed');
  }});
  const pending=runtime.reverse({path:source,in:0,out:1,sourceStream:0});
  const rejected=expect(pending).rejects.toThrow('writer failed');
  try {
    await waiting;
    let idle=false;const waitingForIdle=runtime.waitForIdle().then(()=>{idle=true;});
    await new Promise(resolve=>setImmediate(resolve));expect(idle).toBe(false);
    fs.renameSync(staging,staging+'.original');fs.writeFileSync(staging,'foreign');release();
    await rejected;await waitingForIdle;expect(fs.readFileSync(staging,'utf8')).toBe('foreign');
    expect(fs.readFileSync(staging+'.original','utf8')).toBe('original');
  } finally {release();await pending.catch(()=>{});}
});

it('正常發布後快取保有完整 WAV bytes，重新建立 runtime 能重用',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'subtool-reverse-owner-'));roots.push(root);
  const source=path.join(root,'source.bin'),cache=path.join(root,'cache');fs.writeFileSync(source,'mother');
  const authority=new FileAuthority();authority.grantTrustedFile(source,{read:true});
  const execute=vi.fn(async (_args,options)=>write(options,wave()));
  const options={cacheRoot:cache,fileAuthority:authority,execute},request={path:source,in:0,out:1,sourceStream:0};
  const first=await createClipAudioCache(options).reverse(request);
  const again=await createClipAudioCache(options).reverse(request);
  expect(again).toEqual(first);expect(execute).toHaveBeenCalledOnce();
  expect(fs.readFileSync(first.path)).toEqual(wave());
});

it('既有快取損毀時保留損毀內容並重建可用 WAV',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'subtool-reverse-owner-'));roots.push(root);
  const source=path.join(root,'source.bin'),cache=path.join(root,'cache');fs.writeFileSync(source,'mother');
  const authority=new FileAuthority();authority.grantTrustedFile(source,{read:true});
  const execute=vi.fn(async (_args,options)=>write(options,wave()));
  const options={cacheRoot:cache,fileAuthority:authority,execute},request={path:source,in:0,out:1,sourceStream:0};
  const old=await createClipAudioCache(options).reverse(request);fs.writeFileSync(old.path,'corrupt');
  const rebuilt=await createClipAudioCache(options).reverse(request);
  expect(fs.readFileSync(rebuilt.path)).toEqual(wave());expect(execute).toHaveBeenCalledTimes(2);
  expect(fs.readFileSync(old.path,'utf8')).toBe('corrupt');
});

it('不支援 hard link 的本機快取仍能安全發布並重用完整 WAV',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'subtool-reverse-owner-'));roots.push(root);
  const source=path.join(root,'source.bin'),cache=path.join(root,'cache');fs.writeFileSync(source,'mother');
  const authority=new FileAuthority();authority.grantTrustedFile(source,{read:true});
  const execute=vi.fn(async (_args,options)=>write(options,wave()));
  const options={cacheRoot:cache,fileAuthority:authority,execute},request={path:source,in:0,out:1,sourceStream:0};
  vi.spyOn(fs,'linkSync').mockImplementation(()=>{throw Object.assign(new Error('hard links unsupported'),{code:'ENOTSUP'});});
  const first=await createClipAudioCache(options).reverse(request);
  expect(fs.readFileSync(first.path)).toEqual(wave());
  expect(await createClipAudioCache(options).reverse(request)).toEqual(first);
  expect(execute).toHaveBeenCalledOnce();
});

it('writer 使用已持有 fd，不會因 staging 換檔改寫替代物',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'subtool-reverse-owner-'));roots.push(root);
  const source=path.join(root,'source.bin'),cache=path.join(root,'cache');fs.writeFileSync(source,'mother');
  const authority=new FileAuthority();authority.grantTrustedFile(source,{read:true});let foreign=null;
  const runtime=createClipAudioCache({cacheRoot:cache,fileAuthority:authority,execute:async (args,options)=>{
    expect(args.at(-1)).toBe('fd:');const staging=stagingIn(cache);
    try{fs.renameSync(staging,staging+'.original');}catch(error){expect(['EPERM','EACCES','EBUSY']).toContain(error.code);write(options,wave());return;}
    foreign=staging;fs.writeFileSync(foreign,'foreign');write(options,wave());
  }});
  const result=runtime.reverse({path:source,in:0,out:1,sourceStream:0});
  if(process.platform==='win32'){
    const outcome=await result.catch(error=>error);
    if(foreign){expect(outcome).toBeInstanceOf(Error);expect(fs.readFileSync(foreign,'utf8')).toBe('foreign');}
    else expect(fs.readFileSync(outcome.path)).toEqual(wave());
  }else{
    await expect(result).rejects.toThrow();expect(fs.readFileSync(foreign,'utf8')).toBe('foreign');
  }
});

it('格式驗證期間母素材變更時不得發布反向音訊',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'subtool-reverse-owner-'));roots.push(root);
  const source=path.join(root,'source.bin'),cache=path.join(root,'cache');fs.writeFileSync(source,'mother');
  const authority=new FileAuthority();authority.grantTrustedFile(source,{read:true});
  const open=fsp.open.bind(fsp);let changed=false;
  vi.spyOn(fsp,'open').mockImplementation(async(file,...args)=>{
    const handle=await open(file,...args);
    if(String(file).endsWith('content.wav')){
      const read=handle.read.bind(handle);handle.read=async(...readArgs)=>{
        const result=await read(...readArgs);if(!changed){changed=true;fs.writeFileSync(source,'different mother');}return result;
      };
    }
    return handle;
  });
  const runtime=createClipAudioCache({cacheRoot:cache,fileAuthority:authority,execute:async (_args,options)=>write(options,wave())});
  await expect(runtime.reverse({path:source,in:0,out:1,sourceStream:0})).rejects.toThrow('來源在建立快取期間已變更');
  expect(changed).toBe(true);expect(fs.readdirSync(cache)).toEqual([]);
});

it('舊版完整平面快取仍可被新 runtime 重用',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'subtool-reverse-owner-'));roots.push(root);
  const source=path.join(root,'source.bin'),cache=path.join(root,'cache');fs.writeFileSync(source,'mother');
  const authority=new FileAuthority();authority.grantTrustedFile(source,{read:true});
  const execute=vi.fn(async (_args,options)=>write(options,wave()));
  const options={cacheRoot:cache,fileAuthority:authority,execute},request={path:source,in:0,out:1,sourceStream:0};
  const first=await createClipAudioCache(options).reverse(request);
  const key=path.basename(path.dirname(path.dirname(first.path))),legacy=path.join(cache,`${key}.wav`);
  fs.copyFileSync(first.path,legacy);fs.rmSync(path.dirname(first.path),{recursive:true});
  const reused=await createClipAudioCache(options).reverse(request);
  expect(reused.path).toBe(legacy);expect(fs.readFileSync(legacy)).toEqual(wave());expect(execute).toHaveBeenCalledOnce();
});

it('legacy WAV 可讀但不能建立 key 子目錄時仍直接重用',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'subtool-reverse-owner-'));roots.push(root);
  const source=path.join(root,'source.bin'),cache=path.join(root,'cache');fs.writeFileSync(source,'mother');
  const authority=new FileAuthority();authority.grantTrustedFile(source,{read:true});
  const execute=vi.fn(async (_args,options)=>write(options,wave()));
  const options={cacheRoot:cache,fileAuthority:authority,execute},request={path:source,in:0,out:1,sourceStream:0};
  const first=await createClipAudioCache(options).reverse(request),bucket=path.dirname(path.dirname(first.path));
  const legacy=path.join(cache,`${path.basename(bucket)}.wav`);fs.copyFileSync(first.path,legacy);fs.rmSync(bucket,{recursive:true});
  const mkdir=fs.mkdirSync.bind(fs);
  vi.spyOn(fs,'mkdirSync').mockImplementation((dir,...args)=>{
    if(dir===bucket)throw Object.assign(new Error('read-only cache'),{code:'EACCES'});
    return mkdir(dir,...args);
  });
  const reused=await createClipAudioCache(options).reverse(request);
  expect(reused.path).toBe(legacy);expect(fs.readFileSync(legacy)).toEqual(wave());expect(execute).toHaveBeenCalledOnce();
});

it('其他 runtime 不得把尚未完成的 generation 當成快取',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'subtool-reverse-owner-'));roots.push(root);
  const source=path.join(root,'source.bin'),cache=path.join(root,'cache');fs.writeFileSync(source,'mother');
  const authority=new FileAuthority();authority.grantTrustedFile(source,{read:true});
  let entered,release;const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const firstExecute=vi.fn(async (_args,options)=>{write(options,wave());entered();await gate;});
  const secondExecute=vi.fn(async (_args,options)=>write(options,wave()));
  const options={cacheRoot:cache,fileAuthority:authority},request={path:source,in:0,out:1,sourceStream:0};
  const pending=createClipAudioCache({...options,execute:firstExecute}).reverse(request);
  try {
    await started;
    const second=await createClipAudioCache({...options,execute:secondExecute}).reverse(request);
    expect(secondExecute).toHaveBeenCalledOnce();expect(fs.readFileSync(second.path)).toEqual(wave());
    release();const first=await pending;expect(first.path).not.toBe(second.path);
  } finally {release();await pending.catch(()=>{});}
});

it('查找時只掃目前素材 key 的 bucket，不掃全部快取',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'subtool-reverse-owner-'));roots.push(root);
  const source=path.join(root,'source.bin'),cache=path.join(root,'cache');fs.writeFileSync(source,'mother');
  const authority=new FileAuthority();authority.grantTrustedFile(source,{read:true});
  const execute=vi.fn(async (_args,options)=>write(options,wave()));
  const options={cacheRoot:cache,fileAuthority:authority,execute},request={path:source,in:0,out:1,sourceStream:0};
  await createClipAudioCache(options).reverse(request);
  const readdir=vi.spyOn(fs,'readdirSync');
  await createClipAudioCache(options).reverse(request);
  expect(readdir.mock.calls.some(([dir])=>dir===cache)).toBe(false);expect(execute).toHaveBeenCalledOnce();
});
