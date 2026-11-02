import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const require=createRequire(import.meta.url);
const {createClipFrameCache}=require('../electron/clip-frame-cache.js');
const {FileAuthority}=require('../electron/file-authority.js');
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64');
const roots=[];
const stagingIn=cache=>{
  const bucket=path.join(cache,fs.readdirSync(cache).find(name=>/^[a-f0-9]{64}$/.test(name)));
  return path.join(bucket,fs.readdirSync(bucket).find(name=>name.startsWith('entry-')),'content.png');
};
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
function fixture(execute){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'subtool-frame-owner-'));roots.push(root);
  const source=path.join(root,'source.bin'),cache=path.join(root,'cache');fs.writeFileSync(source,'mother');
  const authority=new FileAuthority();authority.grantTrustedFile(source,{read:true});
  const options={cacheRoot:cache,fileAuthority:authority,execute,probe:async()=>({duration:2,video:{fps:25}})};
  return {root,source,cache,options,request:{path:source,time:1,fps:25},runtime:createClipFrameCache(options)};
}
function corruptedIDAT() {
  const bytes=Buffer.from(PNG),at=bytes.indexOf('IDAT'),length=bytes.readUInt32BE(at-4);
  bytes[at+4]=0;bytes[at+5]=0;
  bytes.writeUInt32BE(crc32(bytes.subarray(at,at+4+length)),at+4+length);
  expect(()=>inflateSync(bytes.subarray(at+4,at+4+length))).toThrow();
  return bytes;
}
function chunk(type,data) {
  const bytes=Buffer.alloc(data.length+12);bytes.writeUInt32BE(data.length);bytes.write(type,4);data.copy(bytes,8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4,8+data.length)),8+data.length);return bytes;
}
function syntheticPng({color,depth,interlace}) {
  const width=9,height=7,channels={3:1,6:4}[color],header=Buffer.alloc(13);
  header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=depth;header[9]=color;header[12]=interlace;
  const passes=interlace?[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]]:[[0,0,1,1]],rows=[];
  for(const [x,y,dx,dy] of passes){
    const w=width>x?Math.ceil((width-x)/dx):0,h=height>y?Math.ceil((height-y)/dy):0;
    for(let row=0;w&&row<h;row++)rows.push(Buffer.alloc(1+Math.ceil(w*channels*depth/8)));
  }
  const compressed=deflateSync(Buffer.concat(rows)),middle=Math.ceil(compressed.length/2);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),
    ...(color===3?[chunk('PLTE',Buffer.from([0,0,0,255,255,255]))]:[]),
    chunk('IDAT',compressed.subarray(0,middle)),chunk('IDAT',compressed.subarray(middle)),chunk('IEND',Buffer.alloc(0))]);
}
function rawPng({width=1,height=1,raw=Buffer.from([0,255,0,0,255]),extra=Buffer.alloc(0)}={}) {
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),
    chunk('IDAT',Buffer.concat([deflateSync(raw),extra])),chunk('IEND',Buffer.alloc(0))]);
}

it('IDAT 解壓毀損但首尾與 CRC 正確時不可重用，保留舊檔並重建',async()=>{
  const execute=vi.fn(async (_args,options)=>fs.writeFileSync(options.outputDescriptor,PNG)),f=fixture(execute);
  const first=await f.runtime.frame(f.request),bad=corruptedIDAT();fs.writeFileSync(first.path,bad);
  const second=await createClipFrameCache(f.options).frame(f.request);
  expect(second.path).not.toBe(first.path);expect(execute).toHaveBeenCalledTimes(2);
  expect(fs.readFileSync(first.path)).toEqual(bad);expect(fs.readFileSync(second.path)).toEqual(PNG);
});

it('CRC 損毀的 PNG 不可當成完整快取',async()=>{
  const execute=vi.fn(async (_args,options)=>fs.writeFileSync(options.outputDescriptor,PNG)),f=fixture(execute);
  const first=await f.runtime.frame(f.request),bad=Buffer.from(PNG),at=bad.indexOf('IDAT'),length=bad.readUInt32BE(at-4);
  bad[at+4+length]^=1;fs.writeFileSync(first.path,bad);
  const second=await createClipFrameCache(f.options).frame(f.request);
  expect(second.path).not.toBe(first.path);expect(execute).toHaveBeenCalledTimes(2);expect(fs.readFileSync(first.path)).toEqual(bad);
});

it.each([{color:3,depth:1,interlace:0},{color:6,depth:16,interlace:0},{color:6,depth:8,interlace:1}])
('合法多 IDAT 的 PNG 色彩格式 $color/$depth/interlace=$interlace 仍可重用',async format=>{
  const bytes=syntheticPng(format),execute=vi.fn(async (_args,options)=>fs.writeFileSync(options.outputDescriptor,bytes)),f=fixture(execute);
  const first=await f.runtime.frame(f.request),second=await createClipFrameCache(f.options).frame(f.request);
  expect(first).toMatchObject({width:9,height:7});expect(second).toEqual(first);expect(execute).toHaveBeenCalledOnce();
});

it.each([
  ['非法列濾鏡',()=>rawPng({raw:Buffer.from([5,255,0,0,255])})],
  ['多餘解壓資料',()=>rawPng({raw:Buffer.alloc(1024*1024)})],
  ['壓縮串流後多餘資料',()=>rawPng({extra:Buffer.from([42])})],
  ['超過解壓預算',()=>rawPng({width:20000,height:20000})],
])('writer 產生%s時不能發布 PNG，仍可重試',async (_kind,makeBad)=>{
  const execute=vi.fn().mockImplementationOnce(async (_args,options)=>fs.writeFileSync(options.outputDescriptor,makeBad()))
    .mockImplementation(async (_args,options)=>fs.writeFileSync(options.outputDescriptor,PNG));
  const f=fixture(execute);
  await expect(f.runtime.frame(f.request)).rejects.toThrow('完整 PNG');
  expect(fs.readdirSync(f.cache)).toEqual([]);
  const recovered=await f.runtime.frame(f.request);
  expect(fs.readFileSync(recovered.path)).toEqual(PNG);expect(execute).toHaveBeenCalledTimes(2);
});
it('固定畫面 writer 結束後快取根被同名替換，不能刪除外物',async()=>{
  let f,foreign,original;
  f=fixture(async (_args,options)=>{
    const staging=stagingIn(f.cache);
    fs.writeFileSync(options.outputDescriptor,'original');
    try {fs.renameSync(f.cache,f.cache+'-original');} catch(error) {
      expect(['EPERM','EACCES','EBUSY']).toContain(error.code);throw new Error('writer failed');
    }
    fs.mkdirSync(f.cache);foreign=staging;original=path.join(f.cache+'-original',path.relative(f.cache,staging));
    fs.mkdirSync(path.dirname(foreign),{recursive:true});fs.writeFileSync(foreign,'foreign');throw new Error('writer failed');
  });
  await expect(f.runtime.frame(f.request)).rejects.toThrow('writer failed');
  if(foreign){expect(fs.readFileSync(foreign,'utf8')).toBe('foreign');expect(fs.readFileSync(original,'utf8')).toBe('original');}
});

it('損毀的固定畫面應保留原檔並可重建有效 PNG',async()=>{
  const execute=vi.fn(async (_args,options)=>fs.writeFileSync(options.outputDescriptor,PNG)),f=fixture(execute);
  const old=await f.runtime.frame(f.request);fs.writeFileSync(old.path,'corrupt');
  const rebuilt=await createClipFrameCache(f.options).frame(f.request);
  expect(fs.readFileSync(rebuilt.path)).toEqual(PNG);expect(execute).toHaveBeenCalledTimes(2);
  expect(fs.readFileSync(old.path,'utf8')).toBe('corrupt');
});

it('不支援 hard link 時固定畫面仍可發布及跨 runtime 重用',async()=>{
  const execute=vi.fn(async (_args,options)=>fs.writeFileSync(options.outputDescriptor,PNG)),f=fixture(execute);
  vi.spyOn(fs,'linkSync').mockImplementation(()=>{throw Object.assign(new Error('unsupported'),{code:'ENOTSUP'});});
  const first=await f.runtime.frame(f.request);
  const second=await createClipFrameCache(f.options).frame(f.request);
  expect(fs.readFileSync(first.path)).toEqual(PNG);expect(second).toEqual(first);expect(execute).toHaveBeenCalledOnce();
});

it('固定畫面 writer 寫已持有 fd，staging 換檔也不改寫替代物',async()=>{
  let f,foreign=null;
  f=fixture(async (args,options)=>{
    expect(args.at(-1)).toBe('fd:');const staging=stagingIn(f.cache);
    try{fs.renameSync(staging,staging+'.original');}catch(error){
      expect(['EPERM','EACCES','EBUSY']).toContain(error.code);fs.writeFileSync(options.outputDescriptor,PNG);return;
    }
    foreign=staging;fs.writeFileSync(foreign,'foreign');fs.writeFileSync(options.outputDescriptor,PNG);
  });
  const outcome=await f.runtime.frame(f.request).catch(error=>error);
  if(foreign){expect(outcome).toBeInstanceOf(Error);expect(fs.readFileSync(foreign,'utf8')).toBe('foreign');}
  else expect(fs.readFileSync(outcome.path)).toEqual(PNG);
});

it('PNG 驗證期間母素材變更不能發布固定畫面',async()=>{
  const open=fsp.open.bind(fsp);let changed=false,f;
  vi.spyOn(fsp,'open').mockImplementation(async(file,...args)=>{
    const handle=await open(file,...args);
    if(String(file).endsWith('content.png')){
      const read=handle.read.bind(handle);handle.read=async(...readArgs)=>{
        const result=await read(...readArgs);if(!changed){changed=true;fs.writeFileSync(f.source,'different mother');}return result;
      };
    }
    return handle;
  });
  f=fixture(async (_args,options)=>fs.writeFileSync(options.outputDescriptor,PNG));
  await expect(f.runtime.frame(f.request)).rejects.toThrow('母素材在擷取期間已變更');
  expect(changed).toBe(true);expect(fs.readdirSync(f.cache)).toEqual([]);
});

it('舊版完整平面固定畫面快取仍可重用',async()=>{
  const execute=vi.fn(async (_args,options)=>fs.writeFileSync(options.outputDescriptor,PNG)),f=fixture(execute);
  const first=await f.runtime.frame(f.request);
  const key=path.basename(path.dirname(path.dirname(first.path))),legacy=path.join(f.cache,`${key}.png`);
  fs.copyFileSync(first.path,legacy);fs.rmSync(path.dirname(first.path),{recursive:true});
  const reused=await createClipFrameCache(f.options).frame(f.request);
  expect(reused.path).toBe(legacy);expect(fs.readFileSync(legacy)).toEqual(PNG);expect(execute).toHaveBeenCalledOnce();
});

it('legacy PNG 可讀但不能建立 key 子目錄時仍直接重用',async()=>{
  const execute=vi.fn(async (_args,options)=>fs.writeFileSync(options.outputDescriptor,PNG)),f=fixture(execute);
  const first=await f.runtime.frame(f.request),bucket=path.dirname(path.dirname(first.path));
  const legacy=path.join(f.cache,`${path.basename(bucket)}.png`);fs.copyFileSync(first.path,legacy);fs.rmSync(bucket,{recursive:true});
  const mkdir=fs.mkdirSync.bind(fs);
  vi.spyOn(fs,'mkdirSync').mockImplementation((dir,...args)=>{
    if(dir===bucket)throw Object.assign(new Error('read-only cache'),{code:'EACCES'});
    return mkdir(dir,...args);
  });
  const reused=await createClipFrameCache(f.options).frame(f.request);
  expect(reused.path).toBe(legacy);expect(fs.readFileSync(legacy)).toEqual(PNG);expect(execute).toHaveBeenCalledOnce();
});
