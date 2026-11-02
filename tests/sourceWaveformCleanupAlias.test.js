import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';

const require=createRequire(import.meta.url);
const {FileAuthority}=require('../electron/file-authority.js');
const {createMediaIntakeRuntime,cacheKeyFor}=require('../electron/media-intake-runtime.js');
const {parse}=require('acorn');
let root;
afterEach(()=>{
  vi.restoreAllMocks();
  if(root && path.dirname(root)===fs.realpathSync(os.tmpdir()) && path.basename(root).startsWith('subtool-wave-alias-')) fs.rmSync(root,{recursive:true,force:true});
  root=null;
});

it('模擬同一來源波形的 8.3 最末檔名，寫入期間不得繞過 owner',async()=>{
  root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-wave-alias-'));
  const tempRoot=path.join(root,'temp'),cacheRoot=path.join(root,'cache');fs.mkdirSync(tempRoot);
  const source=path.join(root,'mother.mov'),output=path.join(tempRoot,'source-wave-long.wav');
  const short=path.join(tempRoot,'SOURCE~1.WAV');fs.writeFileSync(source,'mother bytes');
  let release,started;
  const pending=new Promise(resolve=>{release=resolve;}),began=new Promise(resolve=>{started=resolve;});
  const runtime=createMediaIntakeRuntime({tempRoot,cacheRoot,allowSidecarCache:false,
    fileAuthority:new FileAuthority({internalDirectories:[tempRoot,cacheRoot]}),createTempPath:()=>output,
    ffmpegExecution:{async execute(_args,options){fs.writeSync(options.outputDescriptor,Buffer.from('wave bytes'));started();await pending;}}});
  const work=runtime.waveform({src:source,duration:1,audio:[{channels:1}]});await began;
  const lstat=fs.lstatSync,real=fs.realpathSync.native,unlink=fs.unlinkSync;
  const lstatSpy=vi.spyOn(fs,'lstatSync').mockImplementation((file,...args)=>lstat(file===short?output:file,...args));
  const realSpy=vi.spyOn(fs.realpathSync,'native').mockImplementation((file,...args)=>real(file===short?output:file,...args));
  const unlinkSpy=vi.spyOn(fs,'unlinkSync').mockImplementation((file,...args)=>unlink(file===short?output:file,...args));
  let cleaned,stillExists;
  try{cleaned=runtime.cleanupGeneratedFile(short);stillExists=fs.existsSync(output);}
  finally{lstatSpy.mockRestore();realSpy.mockRestore();unlinkSpy.mockRestore();release();await work.catch(()=>{});}
  expect(cleaned).toBe(false);expect(stillExists).toBe(true);
});

it('來源波形寫入時，TMP 內指回自身的 junction 別名不能繞過 owner 清理',async()=>{
  root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-wave-alias-'));
  const tempRoot=path.join(root,'temp'),cacheRoot=path.join(root,'cache');fs.mkdirSync(tempRoot);
  const source=path.join(root,'mother.mov'),output=path.join(tempRoot,'source-wave.wav');
  fs.writeFileSync(source,'mother bytes');fs.symlinkSync(tempRoot,path.join(tempRoot,'alias'),'junction');
  let release,started;
  const pending=new Promise(resolve=>{release=resolve;}),began=new Promise(resolve=>{started=resolve;});
  const runtime=createMediaIntakeRuntime({tempRoot,cacheRoot,allowSidecarCache:false,
    fileAuthority:new FileAuthority({internalDirectories:[tempRoot,cacheRoot]}),createTempPath:()=>output,
    ffmpegExecution:{async execute(_args,options){fs.writeSync(options.outputDescriptor,Buffer.from('wave bytes'));started();await pending;}}});
  const work=runtime.waveform({src:source,duration:1,audio:[{channels:1}]});
  await began;
  let cleaned,stillExists;
  try{
    cleaned=runtime.cleanupGeneratedFile(path.join(tempRoot,'alias','source-wave.wav'));
    stillExists=fs.existsSync(output);
  }finally{release();await work.catch(()=>{});}
  expect(cleaned).toBe(false);
  expect(stillExists).toBe(true);
});

it('TMP 內 junction 指向外部目錄時，舊式 cleanup 不可刪除外部檔案',async () =>{
  root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-wave-alias-'));
  const tempRoot=path.join(root,'temp'),outside=path.join(root,'outside');fs.mkdirSync(tempRoot);fs.mkdirSync(outside);
  const file=path.join(outside,'foreign.wav');fs.writeFileSync(file,'foreign bytes');
  fs.symlinkSync(outside,path.join(tempRoot,'alias'),'junction');
  const runtime=createMediaIntakeRuntime({tempRoot,cacheRoot:path.join(root,'cache'),
    fileAuthority:new FileAuthority({internalDirectories:[tempRoot]}),ffmpegExecution:{execute:vi.fn()}});
  expect(runtime.cleanupGeneratedFile(path.join(tempRoot,'alias','foreign.wav'))).toBe(false);
  expect(fs.readFileSync(file,'utf8')).toBe('foreign bytes');
});

it('已授權的快取根被同名目錄替換後，不可把新目錄採信為原根',async () =>{
  root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-wave-alias-'));
  const tempRoot=path.join(root,'temp'),cacheRoot=path.join(root,'cache'),oldCache=path.join(root,'old-cache');
  fs.mkdirSync(tempRoot);fs.mkdirSync(cacheRoot);
  const file=path.join(cacheRoot,'legacy.wav');fs.writeFileSync(file,'original cache bytes');
  const runtime=createMediaIntakeRuntime({tempRoot,cacheRoot,
    fileAuthority:new FileAuthority({internalDirectories:[tempRoot,cacheRoot]}),ffmpegExecution:{execute:vi.fn()}});
  fs.renameSync(cacheRoot,oldCache);fs.mkdirSync(cacheRoot);fs.writeFileSync(file,'foreign replacement bytes');
  expect(runtime.cleanupGeneratedFile(file)).toBe(false);
  expect(fs.readFileSync(file,'utf8')).toBe('foreign replacement bytes');
  expect(fs.readFileSync(path.join(oldCache,'legacy.wav'),'utf8')).toBe('original cache bytes');
});

it('中央快取根被替換後，新的 ingest 不得授權新子目錄並刪除外來檔',async()=>{
  root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-wave-alias-'));
  const tempRoot=path.join(root,'temp'),cacheRoot=path.join(root,'cache'),oldCache=path.join(root,'old-cache');
  const source=path.join(root,'mother.mov');fs.mkdirSync(tempRoot);fs.mkdirSync(cacheRoot);fs.writeFileSync(source,'source');
  const authority=new FileAuthority({internalDirectories:[tempRoot,cacheRoot]});authority.grantTrustedFile(source);
  const execute=vi.fn(async args=>{for(const file of args.filter(value=>typeof value==='string'&&/\.(mp4|wav|m4a)$/.test(value))) fs.writeFileSync(file,Buffer.alloc(131072));});
  const runtime=createMediaIntakeRuntime({tempRoot,cacheRoot,allowSidecarCache:false,fileAuthority:authority,ffmpegExecution:{execute}});
  fs.renameSync(cacheRoot,oldCache);fs.mkdirSync(cacheRoot);fs.writeFileSync(path.join(cacheRoot,'foreign'),'foreign bytes');
  await expect(runtime.ingest({src:source,duration:1,needsProxy:true,audio:[]})).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();expect(fs.readdirSync(cacheRoot)).toEqual(['foreign']);
  expect(fs.readFileSync(path.join(cacheRoot,'foreign'),'utf8')).toBe('foreign bytes');
});

it.each(['clearAll','cleanOrphans'])('%s 不可刪除同名替換後的快取根及其內容',async method =>{
  root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-wave-alias-'));
  const tempRoot=path.join(root,'temp'),cacheRoot=path.join(root,'cache'),oldCache=path.join(root,'old-cache');
  fs.mkdirSync(tempRoot);fs.mkdirSync(cacheRoot);
  fs.mkdirSync(path.join(cacheRoot,'old'));fs.writeFileSync(path.join(cacheRoot,'old','keep'),'old bytes');
  const runtime=createMediaIntakeRuntime({tempRoot,cacheRoot,
    fileAuthority:new FileAuthority({internalDirectories:[tempRoot,cacheRoot]}),ffmpegExecution:{execute:vi.fn()}});
  fs.renameSync(cacheRoot,oldCache);fs.mkdirSync(cacheRoot);fs.mkdirSync(path.join(cacheRoot,'foreign'));
  const foreign=path.join(cacheRoot,'foreign','file');fs.writeFileSync(foreign,'foreign bytes');
  runtime[method]();
  expect(fs.readFileSync(foreign,'utf8')).toBe('foreign bytes');
  expect(fs.readFileSync(path.join(oldCache,'old','keep'),'utf8')).toBe('old bytes');
});

it('孤兒掃描期間同一目錄的母素材 metadata 改寫時保留新的來源證據',async () =>{
  root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-wave-alias-'));
  const tempRoot=path.join(root,'temp'),cacheRoot=path.join(root,'cache'),candidate=path.join(cacheRoot,'candidate');
  fs.mkdirSync(tempRoot);fs.mkdirSync(candidate,{recursive:true});
  const metadata=path.join(candidate,'meta.json');
  const record=char=>JSON.stringify({proxy:'missing.mp4',wave:null,channels:[],sourceContent:{format:'source-v3-sha256',size:1,sha256:char.repeat(64)},sourceKeys:[char.repeat(16)]});
  fs.writeFileSync(metadata,record('a'));
  const runtime=createMediaIntakeRuntime({tempRoot,cacheRoot,
    fileAuthority:new FileAuthority({internalDirectories:[tempRoot,cacheRoot]}),ffmpegExecution:{execute:vi.fn()}});
  const read=fs.readFileSync;let swapped=false;
  const spy=vi.spyOn(fs,'readFileSync').mockImplementation((file,...args)=>{
    const result=read(file,...args);
    if(path.resolve(String(file))===metadata&&!swapped){fs.writeFileSync(metadata,record('b'));swapped=true;}
    return result;
  });
  try{await runtime.cleanOrphans();}finally{spy.mockRestore();}
  expect(swapped).toBe(true);expect(JSON.parse(fs.readFileSync(metadata,'utf8')).sourceContent.sha256).toBe('b'.repeat(64));
});

it('母素材旁的 sidecar 是 junction 時，clearAll 不可刪除指向外部的資料',async () =>{
  root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-wave-alias-'));
  const tempRoot=path.join(root,'temp'),cacheRoot=path.join(root,'cache'),media=path.join(root,'media'),outside=path.join(root,'outside');
  for(const dir of [tempRoot,cacheRoot,media,outside])fs.mkdirSync(dir);
  const source=path.join(media,'mother.mov');fs.writeFileSync(source,'source');
  const foreignDir=path.join(outside,cacheKeyFor(source));fs.mkdirSync(foreignDir);const foreign=path.join(foreignDir,'foreign.wav');fs.writeFileSync(foreign,'foreign');
  fs.symlinkSync(outside,path.join(media,'.subtool_Cache'),'junction');
  const authority=new FileAuthority({internalDirectories:[tempRoot,cacheRoot]});authority.grantTrustedFile(source);
  const runtime=createMediaIntakeRuntime({tempRoot,cacheRoot,fileAuthority:authority,ffmpegExecution:{execute:vi.fn()}});
  await runtime.clearAll(source);
  expect(fs.readFileSync(foreign,'utf8')).toBe('foreign');
});

it('母素材旁的 sidecar 是 junction 時，ingest 使用授權中央 cache，不寫入外部目錄',async()=>{
  root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-wave-alias-'));
  const tempRoot=path.join(root,'temp'),cacheRoot=path.join(root,'cache'),media=path.join(root,'media'),outside=path.join(root,'outside');
  for(const dir of [tempRoot,cacheRoot,media,outside])fs.mkdirSync(dir);
  const source=path.join(media,'mother.mov');fs.writeFileSync(source,'source');
  fs.symlinkSync(outside,path.join(media,'.subtool_Cache'),'junction');
  const authority=new FileAuthority({internalDirectories:[tempRoot,cacheRoot]});authority.grantTrustedFile(source);
  const execute=vi.fn(async args=>{for(const file of args.filter(value=>typeof value==='string'&&/\.(mp4|wav|m4a)$/.test(value))) fs.writeFileSync(file,Buffer.alloc(131072));});
  const runtime=createMediaIntakeRuntime({tempRoot,cacheRoot,fileAuthority:authority,ffmpegExecution:{execute}});
  const result=await runtime.ingest({src:source,duration:1,needsProxy:true,audio:[]});
  expect(result.proxy.startsWith(cacheRoot+path.sep)).toBe(true);expect(fs.readdirSync(outside)).toEqual([]);
});

it('sidecar 寫入准入期間根被同名替換，不採用新根作快取並保留不確定探針',async()=>{
  root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-wave-alias-'));
  const tempRoot=path.join(root,'temp'),cacheRoot=path.join(root,'cache'),media=path.join(root,'media');
  for(const dir of [tempRoot,cacheRoot,media])fs.mkdirSync(dir);
  const source=path.join(media,'mother.mov'),sidecar=path.join(media,'.subtool_Cache'),oldSidecar=path.join(media,'old-sidecar');
  fs.writeFileSync(source,'source');fs.mkdirSync(sidecar);
  const authority=new FileAuthority({internalDirectories:[tempRoot,cacheRoot]});authority.grantTrustedFile(source);
  const execute=vi.fn(async args=>{for(const file of args.filter(value=>typeof value==='string'&&/\.(mp4|wav|m4a)$/.test(value))) fs.writeFileSync(file,Buffer.alloc(131072));});
  const runtime=createMediaIntakeRuntime({tempRoot,cacheRoot,fileAuthority:authority,ffmpegExecution:{execute}});
  const open=fs.openSync;let swapped=false;
  const spy=vi.spyOn(fs,'openSync').mockImplementation((file,...args)=>{
    if(!swapped&&String(file).includes('.wtest_')&&String(file).startsWith(sidecar+path.sep)){
      swapped=true;fs.renameSync(sidecar,oldSidecar);fs.mkdirSync(sidecar);
      const foreignDir=path.join(sidecar,cacheKeyFor(source));fs.mkdirSync(foreignDir);fs.writeFileSync(path.join(foreignDir,'foreign'),'foreign');
    }
    return open(file,...args);
  });
  let result;try{result=await runtime.ingest({src:source,duration:1,needsProxy:true,audio:[]});}finally{spy.mockRestore();}
  expect(swapped).toBe(true);expect(result.proxy.startsWith(cacheRoot+path.sep)).toBe(true);
  const foreignDir=path.join(sidecar,cacheKeyFor(source)),entries=fs.readdirSync(foreignDir);
  expect(entries).toContain('foreign');expect(entries.filter(name=>name!=='foreign')).toEqual([expect.stringMatching(/^\.wtest_/)]);
  expect(fs.readFileSync(path.join(foreignDir,'foreign'),'utf8')).toBe('foreign');
});

it('合法清除快取保留已授權根身分，後續舊式 cleanup 仍可正常使用',async () =>{
  root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-wave-alias-'));
  const tempRoot=path.join(root,'temp'),cacheRoot=path.join(root,'cache');fs.mkdirSync(tempRoot);fs.mkdirSync(cacheRoot);
  fs.mkdirSync(path.join(cacheRoot,'old'));fs.writeFileSync(path.join(cacheRoot,'old','file'),'old bytes');
  const authority=new FileAuthority({internalDirectories:[tempRoot,cacheRoot]});
  const runtime=createMediaIntakeRuntime({tempRoot,cacheRoot,fileAuthority:authority,ffmpegExecution:{execute:vi.fn()}});
  const before=fs.statSync(cacheRoot,{bigint:true});
  expect((await runtime.clearAll()).bytes).toBe(9);
  const after=fs.statSync(cacheRoot,{bigint:true});expect([after.dev,after.ino]).toEqual([before.dev,before.ino]);
  expect(fs.readdirSync(cacheRoot)).toEqual([]);
  const fresh=path.join(cacheRoot,'legacy.wav');fs.writeFileSync(fresh,'new owned output');
  expect(runtime.cleanupGeneratedFile(fresh)).toBe(true);expect(fs.existsSync(fresh)).toBe(false);
});

it.each([false,true])('真 main 啟動對動態 CACHE 根在既有=%s 時即捕獲權威',async alreadyExists =>{
  root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-wave-alias-'));
  const tempRoot=path.join(root,'temp'),cacheRoot=path.join(root,'cache'),oldCache=path.join(root,'old-cache');fs.mkdirSync(tempRoot);
  if(alreadyExists)fs.mkdirSync(cacheRoot);
  let currentCache=null;
  const authority=new FileAuthority({internalDirectories:[tempRoot]});
  const runtime=createMediaIntakeRuntime({tempRoot,cacheRoot:()=>currentCache,fileAuthority:authority,ffmpegExecution:{execute:vi.fn()}});
  const main=fs.readFileSync(path.join(process.cwd(),'electron/main.js'),'utf8'),tree=parse(main,{ecmaVersion:'latest',sourceType:'script'});
  let registration;
  const visit=node=>{
    if(!node||typeof node!=='object')return;
    if(node.type==='TryStatement'&&main.slice(node.start,node.end).includes('mediaIntakeRuntime.registerCleanupRoot(CACHE)'))registration=node;
    for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);}
  };visit(tree);expect(registration).toBeTruthy();
  currentCache=cacheRoot;authority.grantInternalDirectory(cacheRoot);
  vm.runInNewContext(main.slice(registration.start,registration.end),{fs,CACHE:cacheRoot,mediaIntakeRuntime:runtime,console});
  const original=path.join(cacheRoot,'wave.wav');fs.writeFileSync(original,'owned');expect(runtime.cleanupGeneratedFile(original)).toBe(true);
  fs.renameSync(cacheRoot,oldCache);fs.mkdirSync(cacheRoot);fs.writeFileSync(original,'foreign');
  expect(runtime.registerCleanupRoot(cacheRoot)).toBe(false);expect(runtime.cleanupGeneratedFile(original)).toBe(false);
  expect(fs.readFileSync(original,'utf8')).toBe('foreign');
});

it('不同 hard link 目錄項目不視為來源波形別名，未知 TMP 檔也不自動取得清理權',async()=>{
  root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-wave-alias-'));
  const tempRoot=path.join(root,'temp'),cacheRoot=path.join(root,'cache');fs.mkdirSync(tempRoot);
  const source=path.join(root,'mother.mov'),output=path.join(tempRoot,'source-wave.wav'),alias=path.join(tempRoot,'another.wav');
  fs.writeFileSync(source,'mother bytes');
  const runtime=createMediaIntakeRuntime({tempRoot,cacheRoot,allowSidecarCache:false,
    fileAuthority:new FileAuthority({internalDirectories:[tempRoot,cacheRoot]}),createTempPath:()=>output,
    ffmpegExecution:{async execute(_args,options){fs.writeSync(options.outputDescriptor,Buffer.from('wave bytes'));}}});
  await runtime.waveform({src:source,duration:1,audio:[{channels:1}]});fs.linkSync(output,alias);
  expect(runtime.isSourceWaveTemporary(alias)).toBe(false);
  expect(runtime.cleanupGeneratedFile(alias)).toBe(false);
  expect(fs.readFileSync(output,'utf8')).toBe('wave bytes');expect(fs.readFileSync(alias,'utf8')).toBe('wave bytes');
  expect(runtime.cleanupGeneratedFile(output)).toBe(true);
  expect(fs.readFileSync(alias,'utf8')).toBe('wave bytes');
});

it('快取根遭替換或無法讀取時不回報虛假的零容量',async () =>{
  root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-wave-alias-'));
  const tempRoot=path.join(root,'temp'),cacheRoot=path.join(root,'cache'),old=path.join(root,'old');
  fs.mkdirSync(tempRoot);fs.mkdirSync(cacheRoot);
  const runtime=createMediaIntakeRuntime({tempRoot,cacheRoot,
    fileAuthority:new FileAuthority({internalDirectories:[tempRoot,cacheRoot]}),ffmpegExecution:{execute:vi.fn()}});
  const read=fs.readdirSync;
  const spy=vi.spyOn(fs,'readdirSync').mockImplementation((dir,...args)=>{
    if(dir===cacheRoot)throw Object.assign(new Error('denied'),{code:'EACCES'});
    return read(dir,...args);
  });
  try{expect(runtime.cacheInfo()).toEqual({root:cacheRoot,unavailable:true});}finally{spy.mockRestore();}
  fs.renameSync(cacheRoot,old);fs.mkdirSync(cacheRoot);
  expect(runtime.cacheInfo()).toEqual({root:cacheRoot,unavailable:true});
});

it('cacheInfo 遇到導向外部檔案的符號連結時不讀取或計入外部資料',async () =>{
  root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-wave-alias-'));
  const tempRoot=path.join(root,'temp'),cacheRoot=path.join(root,'cache'),candidate=path.join(cacheRoot,'candidate');
  const external=path.join(root,'outside.txt'),link=path.join(candidate,'external-link');
  fs.mkdirSync(tempRoot);fs.mkdirSync(candidate,{recursive:true});fs.writeFileSync(external,'outside bytes');
  fs.symlinkSync(external,link,'file');
  const runtime=createMediaIntakeRuntime({tempRoot,cacheRoot,
    fileAuthority:new FileAuthority({internalDirectories:[tempRoot,cacheRoot]}),ffmpegExecution:{execute:vi.fn()}});
  expect(runtime.cacheInfo()).toEqual({root:cacheRoot,unavailable:true});
  expect(fs.readFileSync(external,'utf8')).toBe('outside bytes');
});
