import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require=createRequire(import.meta.url);
const { accessVocalPeaks } = require('../electron/vocal-waveform-sidecar');
const { vocalSourceFingerprint } = require('../electron/vocal-waveform-fingerprint');
const { createMediaIntakeRuntime } = require('../electron/media-intake-runtime');
const { FileAuthority } = require('../electron/file-authority');
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root,{recursive:true,force:true}); });

it('兩台工作站使用同一 NAS 身分及配方可讀回峰值，換素材、串流、模型或資料損毀皆失配', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'subtool-vocal-share-')); roots.push(directory);
  let sharedSourceKey='a'.repeat(64);
  const withCache = async (_path, fn) => fn({ directory,sharedSourceKey,verify:()=>{} });
  const fingerprint = async source => (source.startsWith('Z:') ? '1' : '2').repeat(64);
  const sourceA='Z:/素材/節目.mxf', sourceB='Y:/素材/節目.mxf';
  const request = async (source,peaks,{model='d',streams=[0],local}={})=>({
    path:source, peaks, descriptor:JSON.stringify([2,model.repeat(64),'f'.repeat(64),44100,100,
      local || await fingerprint(source),0.5,streams]),
  });
  const invoke=async (...args)=>accessVocalPeaks(await request(...args),withCache,fingerprint);
  const expected=Float32Array.from({length:100},(_,i)=>(i%2?1:-1)*(i+1)/100);
  expect(await invoke(sourceA,expected)).toBe(true);
  expect(await invoke(sourceB)).toEqual(expected);
  expect(await invoke(sourceB,undefined,{streams:[1]})).toBeNull();
  expect(await invoke(sourceB,undefined,{model:'b'})).toBeNull();
  await expect(invoke(sourceB,undefined,{local:'0'.repeat(64)})).rejects.toThrow('變更');
  sharedSourceKey='e'.repeat(64);expect(await invoke(sourceB)).toBeNull();
  sharedSourceKey='a'.repeat(64);
  const file=fs.readdirSync(directory,{recursive:true}).find(name=>name.endsWith('content.peaks'));
  const bytes=fs.readFileSync(path.join(directory,file));bytes[bytes.length-1]^=1;
  fs.writeFileSync(path.join(directory,file),bytes);
  expect(await invoke(sourceB)).toBeNull();
});

it('拒絕不合理的配方及不符合時長的輸出，避免存取任何快取內容',async()=>{
  const withCache=vi.fn();
  const descriptor=JSON.stringify([2,'a'.repeat(64),'b'.repeat(64),44100,100,'c'.repeat(64),5,[0]]);
  await expect(accessVocalPeaks({descriptor,peaks:new Float32Array(10)},withCache)).rejects.toThrow('長度');
  await expect(accessVocalPeaks({descriptor:'[]'},withCache)).rejects.toThrow('配方');
  expect(withCache).not.toHaveBeenCalled();
});

it('真 sidecar 以另一個桌面設定檔及掛載路徑打開同一 NAS 母檔，能讀回相同峰值',async()=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-vocal-share-'));roots.push(root);
  const firstFolder=path.join(root,'mountA'),nextFolder=path.join(root,'mountB');
  const first=path.join(firstFolder,'m.mxf'),next=path.join(nextFolder,'m.mxf');
  fs.mkdirSync(firstFolder);fs.writeFileSync(first,Buffer.alloc(64000,13));
  const original=fs.realpathSync.native;
  const unc=vi.spyOn(fs.realpathSync,'native').mockImplementation((file,...args)=>
    file===first||file===next?'\\\\editing-nas\\shows\\m.mxf':original(file,...args));
  async function use(source,profile,peaks){
    const cacheRoot=path.join(root,profile,'mediacache'),tempRoot=path.join(root,profile,'temp');
    fs.mkdirSync(tempRoot,{recursive:true});
    const fileAuthority=new FileAuthority({internalDirectories:[cacheRoot,tempRoot]});fileAuthority.grantTrustedFile(source);
    const runtime=createMediaIntakeRuntime({cacheRoot,tempRoot,fileAuthority});
    try{
      const descriptor=JSON.stringify([2,'a'.repeat(64),'b'.repeat(64),44100,100,await vocalSourceFingerprint(source),1,[0]]);
      return await accessVocalPeaks({path:source,descriptor,peaks},runtime.withAudioEffectCache);
    }finally{await runtime.close();}
  }
  try{
    const peaks=Float32Array.from({length:200},(_,i)=>i%2?.2:-.8);
    expect(await use(first,'profileA',peaks)).toBe(true);
    fs.renameSync(firstFolder,nextFolder);
    expect(await use(next,'profileB')).toEqual(peaks);
    expect(fs.readdirSync(path.join(nextFolder,'.subtool_Cache')).filter(s=>/^[a-f0-9]{16}$/.test(s))).toHaveLength(1);
  }finally{unc.mockRestore();}
});
