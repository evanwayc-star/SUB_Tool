import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require=createRequire(import.meta.url);
const {createMediaIntakeRuntime,cacheKeyFor}=require('../electron/media-intake-runtime');
const {FileAuthority}=require('../electron/file-authority');
const {sharedSourceFingerprintSync}=require('../electron/mother-source-evidence');
const {openContinuousWaveformCache}=require('../electron/continuous-waveform-cache');
const roots=[],runtimes=[];
function fixture(backgroundWaveforms=false){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'subtool-cache-info-'));roots.push(root);
  const src=path.join(root,'movie.mov'),cacheRoot=path.join(root,'central'),tempRoot=path.join(root,'temp');
  fs.writeFileSync(src,Buffer.alloc(4096,7));fs.mkdirSync(cacheRoot);fs.mkdirSync(tempRoot);
  const dir=path.join(root,'.subtool_Cache',cacheKeyFor(src));fs.mkdirSync(dir,{recursive:true});
  const spec={version:1,sharedSourceKey:sharedSourceFingerprintSync(src),audio:[{channels:1}],totalSamples:40000};
  const writer=openContinuousWaveformCache(dir,spec);writer.appendPCM(Buffer.alloc(20000*2,1));writer.checkpoint();writer.close();
  const fileAuthority=new FileAuthority({internalDirectories:[cacheRoot,tempRoot]});fileAuthority.grantTrustedFile(src);
  const execute=vi.fn();
  const runtime=createMediaIntakeRuntime({cacheRoot,tempRoot,fileAuthority,backgroundWaveforms,ffmpegExecution:{execute}});runtimes.push(runtime);
  return {root,src,dir,runtime,execute};
}
afterEach(async()=>{vi.restoreAllMocks();for(const runtime of runtimes.splice(0))await runtime.close();for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});

it.each([false,true])('目前素材快取顯示 sidecar 的部分保存紀錄，不掃 PCM、不啟轉檔：worker=%s',async background=>{
  const f=fixture(background),pcmFds=new Set(),open=fs.openSync;
  vi.spyOn(fs,'openSync').mockImplementation((file,...args)=>{const fd=open(file,...args);if(/(?:partial|wave)\.wav$/.test(String(file)))pcmFds.add(fd);else pcmFds.delete(fd);return fd;});
  const nativeRead=fs.readSync,pcmReads=[];
  vi.spyOn(fs,'readSync').mockImplementation((fd,buffer,offset,length,position)=>{
    if(pcmFds.has(fd)&&position>=44)pcmReads.push({length,position});
    return nativeRead(fd,buffer,offset,length,position);
  });
  const info=await f.runtime.cacheInfo(f.src);
  expect(info.folders).toBe(0);
  expect(info.source).toMatchObject({path:f.src,locations:[{directory:f.dir,kind:'sidecar',waveform:{state:'partial',completedSamples:20000,totalSamples:40000,verified:false}}]});
  expect(f.execute).not.toHaveBeenCalled();
  // Source samples / JSON records are bounded. Wave PCM is not rehashed merely to open a dialog.
  expect(pcmReads).toHaveLength(0);
});

it('共享素材的其他 client key 仍顯示同一來源紀錄，Proxy 與波形狀態分開',async()=>{
  const f=fixture(),other=path.join(path.dirname(f.dir),'b'.repeat(16));fs.renameSync(f.dir,other);
  fs.writeFileSync(path.join(other,'proxy.mp4'),'proxy');
  const sourceKey=cacheKeyFor(f.src),sharedKey=sharedSourceFingerprintSync(f.src);
  fs.writeFileSync(path.join(other,'meta.json'),JSON.stringify({proxy:'proxy.mp4',channels:[],sourceKeys:[sourceKey],
    sourceContent:{format:'source-v4-shared-file',size:4096,sharedSourceKey:sharedKey}}));
  const info=await f.runtime.cacheInfo(f.src);
  expect(info.source.locations).toHaveLength(1);
  expect(info.source.locations[0]).toMatchObject({directory:other,proxy:true,waveform:{state:'partial',verified:false}});
});

it('檢查點檔案被符號連結取代時不讀外部內容，也不宣稱有可續算紀錄',async()=>{
  const f=fixture(),folder=path.join(f.dir,'continuous-waveforms'),generation=path.join(folder,fs.readdirSync(folder)[0]);
  const external=path.join(f.root,'outside.json');fs.writeFileSync(external,'private');
  const checkpoint=path.join(generation,'checkpoint.json');fs.unlinkSync(checkpoint);fs.symlinkSync(external,checkpoint,'file');
  const read=vi.spyOn(fs,'readFileSync');
  const info=await f.runtime.cacheInfo(f.src);
  expect(info.source.locations).toEqual([]);expect(read.mock.calls.some(([file])=>file===external)).toBe(false);
  expect(fs.readFileSync(external,'utf8')).toBe('private');
});

it('母素材改變後，資訊面板不把舊檢查點標成目前來源的保存紀錄',async()=>{
  const f=fixture();fs.writeFileSync(f.src,Buffer.alloc(4096,9));
  const info=await f.runtime.cacheInfo(f.src);
  expect(info.source.locations).toEqual([]);
});

it('未載入素材時中央統計也由 worker 執行，關閉 runtime 撤銷待回覆查詢',async()=>{
  const f=fixture(true),reads=[];const readdir=fs.readdirSync;
  vi.spyOn(fs,'readdirSync').mockImplementation((dir,...args)=>{reads.push(dir);return readdir(dir,...args);});
  const info=await f.runtime.cacheInfo(null);
  expect(info).toMatchObject({folders:0,bytes:0});expect(reads).not.toContain(path.join(f.root,'central'));
  const pending=f.runtime.cacheInfo(f.src),rejected=expect(pending).rejects.toMatchObject({code:'INGEST_SUPERSEDED'});
  await f.runtime.close();await rejected;expect(f.execute).not.toHaveBeenCalled();
});
