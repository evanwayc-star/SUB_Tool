import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';

const require=createRequire(import.meta.url);
const {FileAuthority}=require('../electron/file-authority.js');
const {createMediaIntakeRuntime}=require('../electron/media-intake-runtime.js');
const roots=[];
afterEach(()=>{
  vi.restoreAllMocks();
  for(const root of roots.splice(0)){
    if(path.dirname(root)!==fs.realpathSync(os.tmpdir())||!path.basename(root).startsWith('subtool-cache-content-')) throw new Error('測試清理路徑不安全');
    fs.rmSync(root,{recursive:true,force:true});
  }
});

it('關閉仍在等待快取讀取時，resume 不能提早重新准入清理',async()=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-cache-content-'));roots.push(root);
  const cacheRoot=path.join(root,'cache'),tempRoot=path.join(root,'temp'),candidate=path.join(cacheRoot,'candidate');
  fs.mkdirSync(candidate,{recursive:true});fs.mkdirSync(tempRoot);fs.writeFileSync(path.join(candidate,'wave.bin'),'data');
  const runtime=createMediaIntakeRuntime({cacheRoot,tempRoot,allowSidecarCache:false,
    fileAuthority:new FileAuthority({internalDirectories:[cacheRoot,tempRoot]}),ffmpegExecution:{async execute(){}}});
  let release,started;const gate=new Promise(resolve=>{release=resolve;});const ready=new Promise(resolve=>{started=resolve;});
  const open=fs.promises.open;let blocked=false;
  const spy=vi.spyOn(fs.promises,'open').mockImplementation(async(file,...args)=>{
    const handle=await open(file,...args);
    if(!blocked&&path.basename(String(file))==='wave.bin'){
      blocked=true;const read=handle.read.bind(handle);
      handle.read=async(...params)=>{started();await gate;return read(...params);};
    }
    return handle;
  });
  let cleanup,closing,resuming;
  try{
    cleanup=runtime.cleanOrphans();await ready;
    closing=runtime.close();let resumed=false;
    resuming=runtime.resume().then(()=>{resumed=true;});
    await new Promise(resolve=>setTimeout(resolve,20));
    expect(resumed).toBe(false);
    expect(await runtime.clearAll()).toEqual({bytes:0,incomplete:true});
    release();await Promise.all([cleanup,closing,resuming]);
    expect(fs.readFileSync(path.join(candidate,'wave.bin'),'utf8')).toBe('data');
    expect(await runtime.clearAll()).toMatchObject({bytes:4,incomplete:false});
  }finally{release();await Promise.allSettled([cleanup,closing,resuming].filter(Boolean));spy.mockRestore();await runtime.close();}
});

it('清理 handle 關閉失敗時 resume 先重試收尾，失敗期間不得開放新清理',async()=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-cache-content-'));roots.push(root);
  const cacheRoot=path.join(root,'cache'),tempRoot=path.join(root,'temp'),candidate=path.join(cacheRoot,'candidate');
  fs.mkdirSync(candidate,{recursive:true});fs.mkdirSync(tempRoot);fs.writeFileSync(path.join(candidate,'wave.bin'),'data');
  const runtime=createMediaIntakeRuntime({cacheRoot,tempRoot,allowSidecarCache:false,
    fileAuthority:new FileAuthority({internalDirectories:[cacheRoot,tempRoot]}),ffmpegExecution:{async execute(){}}});
  const open=fs.promises.open;let selected=false,allow=false;
  const spy=vi.spyOn(fs.promises,'open').mockImplementation(async(file,...args)=>{
    const handle=await open(file,...args);
    if(!selected&&path.basename(String(file))==='wave.bin'){
      selected=true;const close=handle.close.bind(handle);
      handle.close=async()=>{if(!allow)throw new Error('handle remains open');return close();};
    }
    return handle;
  });
  try{
    expect(await runtime.cleanOrphans()).toMatchObject({incomplete:true});
    await expect(runtime.close()).rejects.toThrow('handle remains open');
    await expect(runtime.resume()).rejects.toThrow('handle remains open');
    expect(await runtime.clearAll()).toEqual({bytes:0,incomplete:true});
    allow=true;await runtime.resume();
    expect(await runtime.clearAll()).toMatchObject({bytes:4,incomplete:false});
  }finally{allow=true;spy.mockRestore();await runtime.close();}
});

it('較新的 close 在先前 close 尚未完成時撤銷等待中的 resume',async()=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-cache-content-'));roots.push(root);
  const cacheRoot=path.join(root,'cache'),tempRoot=path.join(root,'temp'),candidate=path.join(cacheRoot,'candidate');
  fs.mkdirSync(candidate,{recursive:true});fs.mkdirSync(tempRoot);fs.writeFileSync(path.join(candidate,'wave.bin'),'data');
  const runtime=createMediaIntakeRuntime({cacheRoot,tempRoot,allowSidecarCache:false,
    fileAuthority:new FileAuthority({internalDirectories:[cacheRoot,tempRoot]}),ffmpegExecution:{async execute(){}}});
  let release,started;const gate=new Promise(resolve=>{release=resolve;});const ready=new Promise(resolve=>{started=resolve;});
  const open=fs.promises.open;let blocked=false;
  const spy=vi.spyOn(fs.promises,'open').mockImplementation(async(file,...args)=>{
    const handle=await open(file,...args);
    if(!blocked&&path.basename(String(file))==='wave.bin'){
      blocked=true;const read=handle.read.bind(handle);
      handle.read=async(...params)=>{started();await gate;return read(...params);};
    }
    return handle;
  });
  let cleanup,first,resuming,latest;
  try{
    cleanup=runtime.cleanOrphans();await ready;
    first=runtime.close();resuming=runtime.resume();latest=runtime.close();
    release();await Promise.all([cleanup,first,latest]);
    expect(await resuming).toBe(false);
    expect(await runtime.clearAll()).toEqual({bytes:0,incomplete:true});
    await runtime.resume();expect(await runtime.clearAll()).toMatchObject({bytes:4,incomplete:false});
  }finally{release();await Promise.allSettled([cleanup,first,resuming,latest].filter(Boolean));spy.mockRestore();await runtime.close();}
});

it('resume 重試未關閉 handle 期間出現較新的 close，不能再開放工作',async()=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-cache-content-'));roots.push(root);
  const cacheRoot=path.join(root,'cache'),tempRoot=path.join(root,'temp'),candidate=path.join(cacheRoot,'candidate');
  fs.mkdirSync(candidate,{recursive:true});fs.mkdirSync(tempRoot);fs.writeFileSync(path.join(candidate,'wave.bin'),'data');
  const runtime=createMediaIntakeRuntime({cacheRoot,tempRoot,allowSidecarCache:false,
    fileAuthority:new FileAuthority({internalDirectories:[cacheRoot,tempRoot]}),ffmpegExecution:{async execute(){}}});
  let release,started;const gate=new Promise(resolve=>{release=resolve;});const ready=new Promise(resolve=>{started=resolve;});
  const open=fs.promises.open;let selected=false,mode='fail';
  const spy=vi.spyOn(fs.promises,'open').mockImplementation(async(file,...args)=>{
    const handle=await open(file,...args);
    if(!selected&&path.basename(String(file))==='wave.bin'){
      selected=true;const close=handle.close.bind(handle);
      handle.close=async()=>{
        if(mode==='fail') throw new Error('handle remains open');
        if(mode==='wait'){started();await gate;}
        return close();
      };
    }
    return handle;
  });
  let resuming,latest;
  try{
    expect(await runtime.cleanOrphans()).toMatchObject({incomplete:true});
    await expect(runtime.close()).rejects.toThrow('handle remains open');
    mode='wait';resuming=runtime.resume();await ready;
    latest=runtime.close();release();await latest;
    expect(await resuming).toBe(false);
    expect(await runtime.clearAll()).toEqual({bytes:0,incomplete:true});
    mode='ok';await runtime.resume();expect(await runtime.clearAll()).toMatchObject({bytes:4,incomplete:false});
  }finally{mode='ok';release();await Promise.allSettled([resuming,latest].filter(Boolean));spy.mockRestore();await runtime.close();}
});

it.each(['clearAll','cleanOrphans'])('中央快取 %s 不得刪掉同時間戳的原位新內容',async operation=>{
  const original=Buffer.from('old cache bytes'),changed=Buffer.from('new cache bytes');
  {
    const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-cache-content-'));roots.push(root);
    const cacheRoot=path.join(root,'cache'),tempRoot=path.join(root,'temp'),candidate=path.join(cacheRoot,'candidate');
    fs.mkdirSync(candidate,{recursive:true});fs.mkdirSync(tempRoot);
    const file=path.join(candidate,'wave.bin');fs.writeFileSync(file,original);
    const runtime=createMediaIntakeRuntime({cacheRoot,tempRoot,allowSidecarCache:false,
      fileAuthority:new FileAuthority({internalDirectories:[cacheRoot,tempRoot]}),ffmpegExecution:{async execute(){}}});
    const realStat=fs.lstatSync,realOpen=fs.promises.open;let reads=0,before,after;
    const masked=stat=>new Proxy(stat,{get(target,property,receiver){
      if(before&&['mtimeNs','ctimeNs'].includes(property))return before[property];
      return Reflect.get(target,property,receiver);
    }});
    const spy=vi.spyOn(fs,'lstatSync').mockImplementation((target,...options)=>{
      let stat=realStat(target,...options);
      if(path.resolve(String(target))===file){
        if(++reads===1){before=stat;}
        else if(reads===2){fs.writeFileSync(file,changed);after=realStat(target,...options);}
      }
      return path.basename(String(target))===path.basename(file)&&options[0]?.bigint?masked(stat):stat;
    });
    const openSpy=vi.spyOn(fs.promises,'open').mockImplementation(async(target,...args)=>{
      const handle=await realOpen(target,...args);
      if(path.basename(String(target))===path.basename(file)){
        const stat=handle.stat.bind(handle);handle.stat=async(...options)=>masked(await stat(...options));
      }
      return handle;
    });
    let result;try{result=await runtime[operation]();}finally{spy.mockRestore();openSpy.mockRestore();await runtime.close();}
    expect(after).toBeTruthy();expect([after.dev,after.ino,after.size]).toEqual([before.dev,before.ino,before.size]);
    expect(result.incomplete).toBe(true);expect(fs.readFileSync(file)).toEqual(changed);
  }
});

it('共享 sidecar 清理期間原位改寫即使時間相同也不能刪除新內容',async()=>{
  const original=Buffer.from('old cache bytes'), changed=Buffer.from('new cache bytes');
  {
    const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-cache-content-'));roots.push(root);
    const media=path.join(root,'media'),cacheRoot=path.join(root,'cache'),tempRoot=path.join(root,'temp');
    for(const directory of [media,cacheRoot,tempRoot])fs.mkdirSync(directory);
    const src=path.join(media,'source.mov');fs.writeFileSync(src,'mother');
    const authority=new FileAuthority({internalDirectories:[cacheRoot,tempRoot]});authority.grantTrustedFile(src);
    const runtime=createMediaIntakeRuntime({cacheRoot,tempRoot,fileAuthority:authority,delay:async()=>{},
      ffmpegExecution:{async execute(args){for(const file of args.filter(value=>/\.(m4a|wav|mp4)$/.test(value)))fs.writeFileSync(file,original);}}});
    try{
      const result=await runtime.ingest({src,duration:1,needsProxy:false,audio:[{channels:1}]});
      const wave=result.wave, realStat=fs.lstatSync, realOpen=fs.promises.open;
      let reads=0,before,after;
      const masked=stat=>new Proxy(stat,{get(target,property,receiver){
        if(before&&['mtimeNs','ctimeNs'].includes(property))return before[property];
        return Reflect.get(target,property,receiver);
      }});
      const spy=vi.spyOn(fs,'lstatSync').mockImplementation((file,...options)=>{
        let stat=realStat(file,...options);
        if(path.resolve(String(file))===wave){
          if(++reads===1){before=stat;}
          else if(reads===2){fs.writeFileSync(wave,changed);after=realStat(file,...options);}
        }
        return path.basename(String(file))===path.basename(wave)&&options[0]?.bigint?masked(stat):stat;
      });
      const openSpy=vi.spyOn(fs.promises,'open').mockImplementation(async(file,...args)=>{
        const handle=await realOpen(file,...args);
        if(path.basename(String(file))===path.basename(wave)){
          const stat=handle.stat.bind(handle);handle.stat=async(...options)=>masked(await stat(...options));
        }
        return handle;
      });
      let cleanup;try{cleanup=await runtime.clearAll(src);}finally{spy.mockRestore();openSpy.mockRestore();}
      expect(after).toBeTruthy();
      expect([after.dev,after.ino,after.size]).toEqual([before.dev,before.ino,before.size]);
      expect(cleanup.incomplete).toBe(true);
      expect(fs.readFileSync(wave)).toEqual(changed);
    }finally{await runtime.close();}
  }
});

it.each(['original','quarantine'])('關閉會等待並取消 %s 的非同步 sidecar 驗證，保留快取',async stage=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-cache-content-'));roots.push(root);
  const media=path.join(root,'media'),cacheRoot=path.join(root,'cache'),tempRoot=path.join(root,'temp');
  for(const directory of [media,cacheRoot,tempRoot])fs.mkdirSync(directory);
  const src=path.join(media,'source.mov');fs.writeFileSync(src,'mother');
  const authority=new FileAuthority({internalDirectories:[cacheRoot,tempRoot]});authority.grantTrustedFile(src);
  const runtime=createMediaIntakeRuntime({cacheRoot,tempRoot,fileAuthority:authority,delay:async()=>{},
    ffmpegExecution:{async execute(args){for(const file of args.filter(value=>/\.(m4a|wav|mp4)$/.test(value)))fs.writeFileSync(file,'cache content');}}});
  let release,started;
  const gate=new Promise(resolve=>{release=resolve;});
  const ready=new Promise(resolve=>{started=resolve;});
  try{
    const {wave}=await runtime.ingest({src,duration:1,needsProxy:false,audio:[{channels:1}]});
    const realOpen=fs.promises.open;let blocked=false;
    const spy=vi.spyOn(fs.promises,'open').mockImplementation(async(file,...args)=>{
      const handle=await realOpen(file,...args);
      const selected=path.basename(String(file))===path.basename(wave)
        && (String(file).includes('.subtool-clear-')===(stage==='quarantine'));
      if(selected&&!blocked){
        blocked=true;const read=handle.read.bind(handle);
        handle.read=async(...args)=>{started();await gate;return read(...args);};
      }
      return handle;
    });
    let closing,cleanup;
    try{
      cleanup=runtime.clearAll(src);
      await Promise.race([ready,cleanup.then(()=>{throw new Error('未進入預期的內容讀取');})]);
      let finished=false;closing=runtime.close().then(()=>{finished=true;});
      await new Promise(resolve=>setTimeout(resolve,20));expect(finished).toBe(false);
      expect(await runtime.clearAll(src)).toEqual({bytes:0,incomplete:true});
      expect(await runtime.cleanOrphans()).toEqual({removed:0,bytes:0,incomplete:true});
      release();
      expect(await cleanup).toMatchObject({incomplete:true});await closing;
      expect(fs.readFileSync(wave,'utf8')).toBe('cache content');
      expect(await runtime.clearAll(src)).toEqual({bytes:0,incomplete:true});
      expect(await runtime.cleanOrphans()).toEqual({removed:0,bytes:0,incomplete:true});
    }finally{release();await Promise.allSettled([cleanup,closing].filter(Boolean));spy.mockRestore();}
  }finally{await runtime.close();}
});

it.each(['original','quarantine','final'])('啟動孤兒清理在 %s 讀取時關閉，會等待並保留快取',async stage=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-cache-content-'));roots.push(root);
  const cacheRoot=path.join(root,'cache'),tempRoot=path.join(root,'temp'),candidate=path.join(cacheRoot,'candidate');
  fs.mkdirSync(candidate,{recursive:true});fs.mkdirSync(tempRoot);
  const file=path.join(candidate,'wave.bin');fs.writeFileSync(file,'cache content');
  const runtime=createMediaIntakeRuntime({cacheRoot,tempRoot,allowSidecarCache:false,
    fileAuthority:new FileAuthority({internalDirectories:[cacheRoot,tempRoot]}),ffmpegExecution:{async execute(){}}});
  let release,started;const gate=new Promise(resolve=>{release=resolve;});const ready=new Promise(resolve=>{started=resolve;});
  const realOpen=fs.promises.open;let blocked=false,quarantineOpens=0;
  const spy=vi.spyOn(fs.promises,'open').mockImplementation(async(target,...args)=>{
    const handle=await realOpen(target,...args),text=String(target),isolated=text.includes('.subtool-cleanup-retained-');
    if(path.basename(text)==='wave.bin'&&isolated)quarantineOpens++;
    const selected=path.basename(text)==='wave.bin'
      && (stage==='original'?!isolated:isolated&&quarantineOpens===(stage==='quarantine'?1:2));
    if(selected&&!blocked){blocked=true;const read=handle.read.bind(handle);handle.read=async(...args)=>{started();await gate;return read(...args);};}
    return handle;
  });
  let cleanup,closing;
  try{
    cleanup=runtime.cleanOrphans();
    await Promise.race([ready,cleanup.then(()=>{throw new Error('未進入預期的內容讀取');})]);
    let finished=false;closing=runtime.close().then(()=>{finished=true;});
    await new Promise(resolve=>setTimeout(resolve,20));expect(finished).toBe(false);
    release();expect(await cleanup).toMatchObject({incomplete:true});await closing;
    expect(fs.readFileSync(file,'utf8')).toBe('cache content');
  }finally{release();await Promise.allSettled([cleanup,closing].filter(Boolean));spy.mockRestore();await runtime.close();}
});

it('啟動清理無關的中央快取時，另一素材波形不需等待',async()=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-cache-content-'));roots.push(root);
  const cacheRoot=path.join(root,'cache'),tempRoot=path.join(root,'temp'),media=path.join(root,'media');
  const candidate=path.join(cacheRoot,'unrelated');fs.mkdirSync(candidate,{recursive:true});fs.mkdirSync(tempRoot);fs.mkdirSync(media);
  const file=path.join(candidate,'wave.bin'),src=path.join(media,'source.mov');fs.writeFileSync(file,'old cache');fs.writeFileSync(src,'mother');
  const authority=new FileAuthority({internalDirectories:[cacheRoot,tempRoot]});authority.grantTrustedFile(src);
  const runtime=createMediaIntakeRuntime({cacheRoot,tempRoot,allowSidecarCache:false,fileAuthority:authority,delay:async()=>{},
    ffmpegExecution:{async execute(args,options={}){if(Number.isInteger(options.outputDescriptor))fs.writeSync(options.outputDescriptor,Buffer.from('new waveform'));}}});
  let release,started;const gate=new Promise(resolve=>{release=resolve;});const ready=new Promise(resolve=>{started=resolve;});
  const realOpen=fs.promises.open;let blocked=false;
  const spy=vi.spyOn(fs.promises,'open').mockImplementation(async(target,...args)=>{
    const handle=await realOpen(target,...args);
    if(target===file&&!blocked){blocked=true;const read=handle.read.bind(handle);handle.read=async(...args)=>{started();await gate;return read(...args);};}
    return handle;
  });
  let cleanup,wave;
  try{
    cleanup=runtime.cleanOrphans();await ready;
    wave=runtime.waveform({src,duration:1,audio:[{channels:1}]});
    const early=await Promise.race([wave,new Promise(resolve=>setTimeout(()=>resolve(null),100))]);
    expect(early).toMatchObject({cached:false,temporary:true});
    release();await cleanup;
  }finally{release();await Promise.allSettled([cleanup,wave].filter(Boolean));spy.mockRestore();await runtime.close();}
});

it('清理先於首次建立 sidecar，較新的同素材轉檔完成後波形不被刪除',async()=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-cache-content-'));roots.push(root);
  const cacheRoot=path.join(root,'cache'),tempRoot=path.join(root,'temp'),media=path.join(root,'media'),candidate=path.join(cacheRoot,'unrelated');
  fs.mkdirSync(candidate,{recursive:true});fs.mkdirSync(tempRoot);fs.mkdirSync(media);
  const file=path.join(candidate,'old.bin'),src=path.join(media,'source.mov');fs.writeFileSync(file,'old cache');fs.writeFileSync(src,'mother');
  const authority=new FileAuthority({internalDirectories:[cacheRoot,tempRoot]});authority.grantTrustedFile(src);
  const runtime=createMediaIntakeRuntime({cacheRoot,tempRoot,fileAuthority:authority,delay:async()=>{},
    ffmpegExecution:{async execute(args){for(const output of args.filter(value=>/\.(m4a|wav|mp4)$/.test(value)))fs.writeFileSync(output,'new waveform');}}});
  let release,started;const gate=new Promise(resolve=>{release=resolve;});const ready=new Promise(resolve=>{started=resolve;});
  const realOpen=fs.promises.open;let blocked=false;
  const spy=vi.spyOn(fs.promises,'open').mockImplementation(async(target,...args)=>{
    const handle=await realOpen(target,...args);
    if(target===file&&!blocked){blocked=true;const read=handle.read.bind(handle);handle.read=async(...args)=>{started();await gate;return read(...args);};}
    return handle;
  });
  let cleanup,ingest;
  try{
    cleanup=runtime.clearAll(src);await ready;
    ingest=runtime.ingest({src,duration:1,needsProxy:false,audio:[{channels:1}]});
    expect(await Promise.race([ingest,new Promise(resolve=>setTimeout(()=>resolve(null),80))])).toBeNull();
    release();await cleanup;
    const result=await ingest;
    expect(fs.readFileSync(result.wave,'utf8')).toBe('new waveform');
    expect(path.basename(path.dirname(path.dirname(path.dirname(result.wave)))).toLowerCase()).toBe('.subtool_cache');
  }finally{release();await Promise.allSettled([cleanup,ingest].filter(Boolean));spy.mockRestore();await runtime.close();}
});

it.each(['original','quarantine','final'])('中央快取 %s 的 handle 無法關閉時保留檔案並在關機重試',async stage=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-cache-content-'));roots.push(root);
  const cacheRoot=path.join(root,'cache'),tempRoot=path.join(root,'temp'),candidate=path.join(cacheRoot,'candidate');
  fs.mkdirSync(candidate,{recursive:true});fs.mkdirSync(tempRoot);
  const file=path.join(candidate,'wave.bin');fs.writeFileSync(file,'cache content');
  const identity=fs.lstatSync(file,{bigint:true});
  const runtime=createMediaIntakeRuntime({cacheRoot,tempRoot,allowSidecarCache:false,
    fileAuthority:new FileAuthority({internalDirectories:[cacheRoot,tempRoot]}),ffmpegExecution:{async execute(){}}});
  const realOpen=fs.promises.open;let blocked=false,attempts=0,allow=false,observed,quarantineOpens=0;
  const spy=vi.spyOn(fs.promises,'open').mockImplementation(async(target,...args)=>{
    const handle=await realOpen(target,...args),text=String(target);
    const isolated=text.includes('.subtool-cleanup-retained-');
    if(path.basename(text)==='wave.bin'&&isolated)quarantineOpens++;
    if(path.basename(text)==='wave.bin'&&!blocked&&
      (stage==='original'?!isolated:isolated&&quarantineOpens===(stage==='quarantine'?1:2))){
      blocked=true;observed=text;const close=handle.close.bind(handle);
      handle.close=async()=>{attempts++;if(!allow)throw new Error('temporary close failure');return close();};
    }
    return handle;
  });
  const expectRetained=()=>{
    // POSIX can restore the original path with an open handle; Windows may retain quarantine.
    const retained=[...new Set([file,observed])].filter(target=>fs.existsSync(target));
    expect(retained).toHaveLength(1);
    const stat=fs.lstatSync(retained[0],{bigint:true});
    expect(stat.isFile()&&!stat.isSymbolicLink()).toBe(true);
    expect(stat).toMatchObject({dev:identity.dev,ino:identity.ino});
    expect(fs.readFileSync(retained[0],'utf8')).toBe('cache content');
  };
  try{
    expect(await runtime.cleanOrphans()).toMatchObject({incomplete:true});
    expect(blocked).toBe(true);expectRetained();
    await expect(runtime.close()).rejects.toThrow('temporary close failure');
    expect(attempts).toBe(2);expectRetained();
    allow=true;await runtime.close();expect(attempts).toBe(3);
    expectRetained();
  }finally{allow=true;await runtime.close();spy.mockRestore();}
});

it.each(['central','sidecar'])('%s 隔離讀取期間目錄被替換，不得把外物還原到原路徑',async kind=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-cache-content-'));roots.push(root);
  const cacheRoot=path.join(root,'cache'),tempRoot=path.join(root,'temp'),media=path.join(root,'media');
  for(const dir of [cacheRoot,tempRoot,media])fs.mkdirSync(dir);
  const src=path.join(media,'source.mov');fs.writeFileSync(src,'mother');
  const authority=new FileAuthority({internalDirectories:[cacheRoot,tempRoot]});authority.grantTrustedFile(src);
  const runtime=createMediaIntakeRuntime({cacheRoot,tempRoot,fileAuthority:authority,delay:async()=>{},
    ffmpegExecution:{async execute(args){for(const file of args.filter(value=>/\.(m4a|wav|mp4)$/.test(value)))fs.writeFileSync(file,'cache content');}}});
  let original,wave;
  if(kind==='sidecar'){
    ({wave}=await runtime.ingest({src,duration:1,needsProxy:false,audio:[{channels:1}]}));
    original=path.dirname(path.dirname(wave));
  }else{
    original=path.join(cacheRoot,'candidate');fs.mkdirSync(original);wave=path.join(original,'wave.bin');fs.writeFileSync(wave,'cache content');
  }
  let release,started,quarantine;const gate=new Promise(resolve=>{release=resolve;});const ready=new Promise(resolve=>{started=resolve;});
  const realOpen=fs.promises.open;let blocked=false;
  const spy=vi.spyOn(fs.promises,'open').mockImplementation(async(target,...args)=>{
    const handle=await realOpen(target,...args),text=String(target);
    const marker=kind==='sidecar'?'.subtool-clear-':'.subtool-cleanup-retained-';
    if(text.includes(marker)&&path.basename(text)===path.basename(wave)&&!blocked){
      blocked=true;
      const relative=path.relative(original,wave).split(path.sep);quarantine=text;
      for(let i=0;i<relative.length;i++)quarantine=path.dirname(quarantine);
      const close=handle.close.bind(handle);handle.close=async()=>{await close();started();await gate;};
    }
    return handle;
  });
  let cleanup;
  try{
    cleanup=kind==='sidecar'?runtime.clearAll(src):runtime.cleanOrphans();
    await Promise.race([ready,cleanup.then(()=>{throw new Error('未進入隔離讀取');})]);
    const saved=path.join(root,'saved-original');fs.renameSync(quarantine,saved);
    fs.mkdirSync(quarantine);fs.writeFileSync(path.join(quarantine,'foreign.txt'),'foreign');
    release();expect(await cleanup).toMatchObject({incomplete:true});
    expect(fs.existsSync(original)).toBe(false);
    expect(fs.readFileSync(path.join(quarantine,'foreign.txt'),'utf8')).toBe('foreign');
    expect(fs.readFileSync(path.join(saved,path.relative(original,wave)),'utf8')).toBe('cache content');
  }finally{release();await Promise.allSettled([cleanup].filter(Boolean));spy.mockRestore();await runtime.close();}
});

it('隔離批次 A 已讀取、B 等待期間 A 被原位改寫，逐檔發布前保留新內容',async()=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-cache-content-'));roots.push(root);
  const cacheRoot=path.join(root,'cache'),tempRoot=path.join(root,'temp'),candidate=path.join(cacheRoot,'candidate');
  fs.mkdirSync(candidate,{recursive:true});fs.mkdirSync(tempRoot);
  const a=path.join(candidate,'a.bin'),b=path.join(candidate,'b.bin');
  fs.writeFileSync(a,'old bytes');fs.writeFileSync(b,Buffer.alloc(2*1024*1024,7));
  const expected=fs.lstatSync(a,{bigint:true}),changed=Buffer.from('new bytes');
  const runtime=createMediaIntakeRuntime({cacheRoot,tempRoot,allowSidecarCache:false,
    fileAuthority:new FileAuthority({internalDirectories:[cacheRoot,tempRoot]}),ffmpegExecution:{async execute(){}}});
  let release,started,aFinished,quarantineA;
  const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{started=resolve;}),aRead=new Promise(resolve=>{aFinished=resolve;});
  const masked=stat=>new Proxy(stat,{get(target,property,receiver){
    if(['mtimeNs','ctimeNs'].includes(property))return expected[property];return Reflect.get(target,property,receiver);
  }});
  const realStat=fs.lstatSync,realOpen=fs.promises.open;
  const statSpy=vi.spyOn(fs,'lstatSync').mockImplementation((file,...args)=>{
    const stat=realStat(file,...args);return path.basename(String(file))==='a.bin'&&args[0]?.bigint?masked(stat):stat;
  });
  let gated=false;
  const openSpy=vi.spyOn(fs.promises,'open').mockImplementation(async(file,...args)=>{
    const handle=await realOpen(file,...args),text=String(file);
    if(path.basename(text)==='a.bin'){
      const stat=handle.stat.bind(handle);handle.stat=async(...options)=>masked(await stat(...options));
      if(text.includes('.subtool-cleanup-retained-')){
        quarantineA=text;const read=handle.read.bind(handle);
        handle.read=async(...options)=>{const result=await read(...options);aFinished();return result;};
      }
    }
    if(text.includes('.subtool-cleanup-retained-')&&path.basename(text)==='b.bin'&&!gated){
      gated=true;const read=handle.read.bind(handle);handle.read=async(...options)=>{started();await gate;return read(...options);};
    }
    return handle;
  });
  let cleanup;
  try{
    cleanup=runtime.clearAll();await Promise.race([Promise.all([ready,aRead]),cleanup.then(()=>{throw new Error('未進入批次驗證');})]);
    fs.writeFileSync(quarantineA,changed);release();
    expect(await cleanup).toMatchObject({incomplete:true});
    expect(fs.readFileSync(a)).toEqual(changed);expect(fs.statSync(b).size).toBe(2*1024*1024);
  }finally{release();await Promise.allSettled([cleanup].filter(Boolean));statSpy.mockRestore();openSpy.mockRestore();await runtime.close();}
});

it('最後核對 A 已完成時立即刪除，不等待仍在讀取的 B',async()=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-cache-content-'));roots.push(root);
  const cacheRoot=path.join(root,'cache'),tempRoot=path.join(root,'temp'),candidate=path.join(cacheRoot,'candidate');
  fs.mkdirSync(candidate,{recursive:true});fs.mkdirSync(tempRoot);
  fs.writeFileSync(path.join(candidate,'a.bin'),'a');fs.writeFileSync(path.join(candidate,'b.bin'),'b');
  const runtime=createMediaIntakeRuntime({cacheRoot,tempRoot,allowSidecarCache:false,
    fileAuthority:new FileAuthority({internalDirectories:[cacheRoot,tempRoot]}),ffmpegExecution:{async execute(){}}});
  let release,started,deleted;const gate=new Promise(resolve=>{release=resolve;});
  const ready=new Promise(resolve=>{started=resolve;}),aDeleted=new Promise(resolve=>{deleted=resolve;});
  const realOpen=fs.promises.open,realUnlink=fs.unlinkSync;let bOpens=0;
  const openSpy=vi.spyOn(fs.promises,'open').mockImplementation(async(file,...args)=>{
    const handle=await realOpen(file,...args),text=String(file);
    if(text.includes('.subtool-cleanup-retained-')&&path.basename(text)==='b.bin'&&++bOpens===2){
      const read=handle.read.bind(handle);handle.read=async(...options)=>{started();await gate;return read(...options);};
    }
    return handle;
  });
  const unlinkSpy=vi.spyOn(fs,'unlinkSync').mockImplementation((file,...args)=>{
    const value=realUnlink(file,...args);
    if(String(file).includes('.subtool-cleanup-retained-')&&path.basename(String(file))==='a.bin')deleted();
    return value;
  });
  let cleanup;
  try{
    cleanup=runtime.clearAll();await Promise.race([ready,cleanup.then(()=>{throw new Error('未進入 B 最後核對');})]);
    const first=await Promise.race([aDeleted.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),1000))]);
    expect(first).toBe(true);release();expect(await cleanup).toEqual({bytes:2,incomplete:false});
  }finally{release();await Promise.allSettled([cleanup].filter(Boolean));openSpy.mockRestore();unlinkSpy.mockRestore();await runtime.close();}
});

it('完整候選准入後第二次 unlink 失敗，回報已刪 bytes 並還原其餘檔案',async()=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-cache-content-'));roots.push(root);
  const cacheRoot=path.join(root,'cache'),tempRoot=path.join(root,'temp'),candidate=path.join(cacheRoot,'candidate');
  fs.mkdirSync(candidate,{recursive:true});fs.mkdirSync(tempRoot);
  for(const name of ['a.bin','b.bin'])fs.writeFileSync(path.join(candidate,name),'12345678');
  const runtime=createMediaIntakeRuntime({cacheRoot,tempRoot,allowSidecarCache:false,
    fileAuthority:new FileAuthority({internalDirectories:[cacheRoot,tempRoot]}),ffmpegExecution:{async execute(){}}});
  const realUnlink=fs.unlinkSync;let count=0;
  const spy=vi.spyOn(fs,'unlinkSync').mockImplementation((file,...args)=>{
    if(String(file).includes('.subtool-cleanup-retained-')&&++count===2)throw Object.assign(new Error('blocked'),{code:'EACCES'});
    return realUnlink(file,...args);
  });
  try{
    expect(await runtime.clearAll()).toEqual({bytes:8,incomplete:true});
    expect(fs.readdirSync(candidate)).toHaveLength(1);
    expect(fs.readFileSync(path.join(candidate,fs.readdirSync(candidate)[0]),'utf8')).toBe('12345678');
  }finally{spy.mockRestore();await runtime.close();}
});

it.each(['same','different','same-folder'])('清理期間 %s 來源波形只等待有交集的 sidecar',async relation=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-cache-content-'));roots.push(root);
  const mediaA=path.join(root,'a'),mediaB=path.join(root,'b'),cacheRoot=path.join(root,'cache'),tempRoot=path.join(root,'temp');
  for(const directory of [mediaA,mediaB,cacheRoot,tempRoot])fs.mkdirSync(directory);
  const sourceA=path.join(mediaA,'source.mov'),sourceB=path.join(relation==='same-folder'?mediaA:mediaB,'other.mov');
  fs.writeFileSync(sourceA,'mother A');fs.writeFileSync(sourceB,'mother B');
  const authority=new FileAuthority({internalDirectories:[cacheRoot,tempRoot]});
  authority.grantTrustedFile(sourceA);authority.grantTrustedFile(sourceB);
  const runtime=createMediaIntakeRuntime({cacheRoot,tempRoot,fileAuthority:authority,delay:async()=>{},
    ffmpegExecution:{async execute(args,options={}){
      if(Number.isInteger(options.outputDescriptor))fs.writeSync(options.outputDescriptor,Buffer.from('new waveform'));
      for(const file of args.filter(value=>/\.(m4a|wav|mp4)$/.test(value)))fs.writeFileSync(file,'cache content');
    }}});
  let release,started;const gate=new Promise(resolve=>{release=resolve;});const ready=new Promise(resolve=>{started=resolve;});
  try{
    const request=src=>({src,duration:1,needsProxy:false,audio:[{channels:1}]});
    const a=await runtime.ingest(request(sourceA));const b=await runtime.ingest(request(sourceB));
    const realOpen=fs.promises.open;let blocked=false;
    const spy=vi.spyOn(fs.promises,'open').mockImplementation(async(file,...args)=>{
      const handle=await realOpen(file,...args);
      if(file===a.wave&&!blocked){blocked=true;const read=handle.read.bind(handle);handle.read=async(...args)=>{started();await gate;return read(...args);};}
      return handle;
    });
    let cleanup,wave;
    try{
      cleanup=runtime.clearAll(sourceA);await ready;
      wave=runtime.waveform(request(relation==='same'?sourceA:sourceB));
      const early=await Promise.race([wave.then(value=>({value})),new Promise(resolve=>setTimeout(()=>resolve(null),80))]);
      if(relation!=='same'){
        expect(early?.value).toMatchObject({cached:true,wave:b.wave});
        expect(fs.readFileSync(b.wave,'utf8')).toBe('cache content');
      }else expect(early).toBeNull();
      release();await cleanup;
      if(relation==='same')expect((await wave).cached).toBe(false);
    }finally{release();await Promise.allSettled([cleanup,wave].filter(Boolean));spy.mockRestore();}
  }finally{await runtime.close();}
});
