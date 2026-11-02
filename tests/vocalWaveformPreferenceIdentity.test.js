import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const runtime = vi.hoisted(() => ({ state:{clips:[],audioProject:{sourceMaps:{}}}, media:{externalAudioSources:[],tracks:[]},desk:{} }));
vi.mock('../src/state.js',()=>({State:runtime.state,DESK:runtime.desk}));
vi.mock('../src/media.js',()=>({Media:runtime.media}));
vi.mock('../src/audio-engine.js',()=>({AudioEngine:{}}));
vi.mock('../src/vocal-waveform-worker-client.js',()=>({vocalWaveformClient:{},vocalAbortError:()=>new DOMException('cancelled','AbortError')}));

import { vocalWaveformCache, vocalCacheDescriptor, vocalPeakLength } from '../src/vocal-waveform-cache.js';
import { rememberSourceVocalSelection, restoreCachedSourceVocals } from '../src/vocal-waveform-source.js';

const { vocalSourceFingerprint }=createRequire(import.meta.url)('../electron/vocal-waveform-fingerprint.js');
const defaultStorage=vocalWaveformCache.localStorage;
afterEach(()=>{vi.restoreAllMocks();vocalWaveformCache.localStorage=defaultStorage;runtime.state.clips=[];delete runtime.desk.vocalWaveChunk;delete runtime.desk.vocalWaveFingerprint;});

function installCache(){
  const records=new Map(),preferences=new Map();
  vocalWaveformCache.localStorage={getItem:key=>preferences.get(key)||null,setItem:(key,value)=>preferences.set(key,value)};
  vi.spyOn(vocalWaveformCache,'transaction').mockImplementation(async (_mode,run)=>new Promise(resolve=>{
    let pending=0,result=null;
    const request=value=>{const operation={result:structuredClone(value)};pending++;queueMicrotask(()=>{
      operation.onsuccess?.();if(!--pending)resolve(result);
    });return operation;};
    run({get:key=>request(records.get(key)),getAll:()=>request([...records.values()]),
      put:record=>records.set(record.key,structuredClone(record)),delete:key=>records.delete(key)},value=>{result=value;});
    if(!pending)resolve(result);
  }));
}

it('不同母素材即使檔名、大小與修改時間相同，也不能共用人聲顯示偏好',async()=>{
  installCache();
  const file=byte=>new File([Uint8Array.of(byte,byte,byte,byte)],'voice.wav',{lastModified:123});
  const first=file(1),second=file(2),duration=1;
  const descriptor=async f=>vocalCacheDescriptor([...new Uint8Array(await crypto.subtle.digest('SHA-256',await f.arrayBuffer()))]
    .map(value=>value.toString(16).padStart(2,'0')).join(''),duration,[0]);
  const firstPeaks=new Float32Array(vocalPeakLength(duration)),secondPeaks=new Float32Array(vocalPeakLength(duration));
  secondPeaks[1]=.5;
  expect(await vocalWaveformCache.write(await descriptor(first),duration,firstPeaks)).toBe(true);
  expect(await vocalWaveformCache.write(await descriptor(second),duration,secondPeaks)).toBe(true);
  runtime.state.clips=[{id:'first',audioSourceId:'a',_file:first,dur:duration}];
  expect(await rememberSourceVocalSelection('a',true)).toBe(true);
  runtime.state.clips=[{id:'second',audioSourceId:'b',_file:second,dur:duration}];
  expect(await restoreCachedSourceVocals('b')).toBeNull();
});

it('新指紋已確認但資料庫更新尚未完成時重開，偏好按內容分開保存',async()=>{
  installCache();
  const first={name:'voice.wav',size:4,lastModified:123,arrayBuffer:async()=>Uint8Array.of(1,1,1,1).buffer};
  const second={name:'voice.wav',size:4,lastModified:123,arrayBuffer:async()=>Uint8Array.of(2,2,2,2).buffer};
  const descriptor=async f=>vocalCacheDescriptor([...new Uint8Array(await crypto.subtle.digest('SHA-256',await f.arrayBuffer()))]
    .map(value=>value.toString(16).padStart(2,'0')).join(''),1,[0]);
  const firstDescriptor=await descriptor(first),secondDescriptor=await descriptor(second);
  const firstPeaks=new Float32Array(vocalPeakLength(1)),secondPeaks=new Float32Array(vocalPeakLength(1));
  secondPeaks[1]=.5;
  await vocalWaveformCache.write(firstDescriptor,1,firstPeaks);await vocalWaveformCache.select(firstDescriptor,true);
  await vocalWaveformCache.write(secondDescriptor,1,secondPeaks);await vocalWaveformCache.select(secondDescriptor,true);
  runtime.state.clips=[{id:'first',audioSourceId:'a',_file:first,dur:1}];
  expect(await restoreCachedSourceVocals('a')).toEqual(firstPeaks);
  let finish,started;
  const gate=new Promise(resolve=>{finish=resolve;}),ready=new Promise(resolve=>{started=resolve;});
  const transaction=vocalWaveformCache.transaction.getMockImplementation();
  vocalWaveformCache.transaction.mockImplementationOnce(async(...args)=>{started();await gate;return transaction(...args);});
  const pending=rememberSourceVocalSelection('a',false);
  try{
    await ready;
    runtime.state.clips=[{id:'reopened',audioSourceId:'a',_file:first,dur:1}];
    expect(await restoreCachedSourceVocals('a')).toBeNull();
    runtime.state.clips=[{id:'second',audioSourceId:'b',_file:second,dur:1}];
    expect(await restoreCachedSourceVocals('b')).toEqual(secondPeaks);
    expect(await rememberSourceVocalSelection('b',true)).toBe(true);
    runtime.state.clips=[{id:'reopened',audioSourceId:'a',_file:first,dur:1}];
    expect(await restoreCachedSourceVocals('a')).toBeNull();
  }finally{finish();}
  expect(await pending).toBe(false);
});

it('桌面同路徑換成不同母素材時，已驗證的舊偏好不能影響新素材',async()=>{
  installCache();
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-vocal-pref-'));
  const file=path.join(root,'mother.wav'),duration=1;
  runtime.desk.vocalWaveChunk=vi.fn();runtime.desk.vocalWaveFingerprint=vocalSourceFingerprint;
  try{
    fs.writeFileSync(file,'first content');
    const first=await vocalSourceFingerprint(file),oldDescriptor=vocalCacheDescriptor(first,duration,[0]);
    const peaks=new Float32Array(vocalPeakLength(duration));peaks[1]=.5;
    await vocalWaveformCache.write(oldDescriptor,duration,peaks);
    runtime.state.clips=[{id:'first',audioSourceId:'a',path:file,dur:duration}];
    expect(await rememberSourceVocalSelection('a',true)).toBe(true);
    fs.writeFileSync(file,'other content');
    const next=await vocalSourceFingerprint(file);expect(next).not.toBe(first);
    await vocalWaveformCache.write(vocalCacheDescriptor(next,duration,[0]),duration,peaks);
    runtime.state.clips=[{id:'second',audioSourceId:'b',path:file,dur:duration}];
    expect(await restoreCachedSourceVocals('b')).toBeNull();
  }finally{
    const actual=fs.realpathSync(root);
    if(path.dirname(actual)!==fs.realpathSync(os.tmpdir())||!path.basename(actual).startsWith('subtool-vocal-pref-'))throw new Error('拒絕刪除測試目錄以外資料');
    fs.rmSync(actual,{recursive:true,force:true});
  }
});

it('桌面同一來源物件的檔案被原位取代後，不能用舊指紋同步改寫舊素材偏好',async()=>{
  installCache();
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-vocal-pref-'));
  const file=path.join(root,'mother.wav'),duration=1;
  let hold=false,finish;
  const fingerprint=async source=>{
    const bytes=await fs.promises.readFile(source);
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
    if(hold){hold=false;return new Promise(resolve=>{finish=()=>resolve(hash);});}
    return hash;
  };
  runtime.desk.vocalWaveChunk=vi.fn();runtime.desk.vocalWaveFingerprint=fingerprint;
  try{
    fs.writeFileSync(file,'aaaa');
    const descriptor=vocalCacheDescriptor(await fingerprint(file),duration,[0]);
    const peaks=new Float32Array(vocalPeakLength(duration));peaks[1]=.5;
    await vocalWaveformCache.write(descriptor,duration,peaks);await vocalWaveformCache.select(descriptor,true);
    const source={id:'clip',audioSourceId:'audio',path:file,dur:duration};runtime.state.clips=[source];
    expect(await restoreCachedSourceVocals('audio')).toEqual(peaks);
    fs.writeFileSync(file,'bbbb');hold=true;
    const pending=rememberSourceVocalSelection('audio',false);
    try{
      await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
      fs.writeFileSync(file,'aaaa');runtime.state.clips=[{...source}];
      expect(await restoreCachedSourceVocals('audio')).toEqual(peaks);
    }finally{finish();}
    expect(await pending).toBe(false);
  }finally{
    const actual=fs.realpathSync(root);
    if(path.dirname(actual)!==fs.realpathSync(os.tmpdir())||!path.basename(actual).startsWith('subtool-vocal-pref-'))throw new Error('拒絕刪除測試目錄以外資料');
    fs.rmSync(actual,{recursive:true,force:true});
  }
});

it('同一來源在指紋等待期間切回原音，恢復快取立即遵循暫存選擇',async()=>{
  installCache();
  const fingerprint='a'.repeat(64),duration=1;
  const descriptor=vocalCacheDescriptor(fingerprint,duration,[0]);
  const peaks=new Float32Array(vocalPeakLength(duration));peaks[1]=.5;
  await vocalWaveformCache.write(descriptor,duration,peaks);
  await vocalWaveformCache.select(descriptor,true);
  let finish;
  runtime.desk.vocalWaveChunk=vi.fn();
  runtime.desk.vocalWaveFingerprint=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValue(fingerprint);
  runtime.state.clips=[{id:'clip',audioSourceId:'audio',path:'C:/mother.wav',dur:duration}];
  const pending=rememberSourceVocalSelection('audio',false);
  expect(await restoreCachedSourceVocals('audio')).toBeNull();
  finish(fingerprint);expect(await pending).toBe(true);
  expect(await restoreCachedSourceVocals('audio')).toBeNull();
});

it('舊工作等待指紋時同 ID 來源被替換，不將選擇寫入新來源',async()=>{
  installCache();
  const fingerprint='a'.repeat(64),duration=1;
  const descriptor=vocalCacheDescriptor(fingerprint,duration,[0]);
  await vocalWaveformCache.write(descriptor,duration,new Float32Array(vocalPeakLength(duration)));
  let finish;
  runtime.desk.vocalWaveChunk=vi.fn();
  runtime.desk.vocalWaveFingerprint=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValue(fingerprint);
  runtime.state.clips=[{id:'clip',audioSourceId:'audio',path:'C:/mother.wav',dur:duration}];
  const pending=rememberSourceVocalSelection('audio',true);
  runtime.state.clips=[{id:'clip',audioSourceId:'audio',path:'C:/mother.wav',dur:duration}];
  finish(fingerprint);expect(await pending).toBe(false);
  expect(await restoreCachedSourceVocals('audio')).toBeNull();
});

it('快取恢復等待指紋時同 ID 同路徑來源被新物件取代，舊結果不可交付',async()=>{
  installCache();
  const fingerprint='b'.repeat(64),duration=1;
  const descriptor=vocalCacheDescriptor(fingerprint,duration,[0]);
  const peaks=new Float32Array(vocalPeakLength(duration));peaks[1]=.5;
  await vocalWaveformCache.write(descriptor,duration,peaks);await vocalWaveformCache.select(descriptor,true);
  let finish;
  runtime.desk.vocalWaveChunk=vi.fn();
  runtime.desk.vocalWaveFingerprint=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValue(fingerprint);
  const source={id:'clip',audioSourceId:'audio',path:'C:/mother.wav',dur:duration};runtime.state.clips=[source];
  const pending=restoreCachedSourceVocals('audio');
  runtime.state.clips=[{...source}];
  finish(fingerprint);
  expect(await pending).toBeNull();
  expect(await restoreCachedSourceVocals('audio')).toEqual(peaks);
});

it('同檔案資訊但不同內容的來源同時選擇人聲時，各自的選擇均可保存',async()=>{
  installCache();
  let delay=false,finish;
  const first={name:'voice.wav',size:4,lastModified:123,arrayBuffer:()=>{
    if(delay){delay=false;return new Promise(resolve=>{finish=()=>resolve(Uint8Array.of(1,1,1,1).buffer);});}
    return Promise.resolve(Uint8Array.of(1,1,1,1).buffer);
  }};
  const second={name:'voice.wav',size:4,lastModified:123,arrayBuffer:async()=>Uint8Array.of(2,2,2,2).buffer};
  const descriptor=async f=>vocalCacheDescriptor([...new Uint8Array(await crypto.subtle.digest('SHA-256',await f.arrayBuffer()))]
    .map(value=>value.toString(16).padStart(2,'0')).join(''),1,[0]);
  await vocalWaveformCache.write(await descriptor(first),1,new Float32Array(vocalPeakLength(1)));
  await vocalWaveformCache.write(await descriptor(second),1,new Float32Array(vocalPeakLength(1)));
  runtime.state.clips=[{id:'one',audioSourceId:'a',_file:first,dur:1},{id:'two',audioSourceId:'b',_file:second,dur:1}];
  delay=true;const slow=rememberSourceVocalSelection('a',true);
  try{
    expect(await rememberSourceVocalSelection('b',true)).toBe(true);
  }finally{finish();}
  expect(await slow).toBe(true);
  expect(await restoreCachedSourceVocals('a')).toBeInstanceOf(Float32Array);
  expect(await restoreCachedSourceVocals('b')).toBeInstanceOf(Float32Array);
});

it('相同來源以不同物件同時切換時，晚到舊選擇不可覆蓋較新選擇',async()=>{
  installCache();
  let delay=false,finish;
  const file={name:'voice.wav',size:4,lastModified:123,arrayBuffer:()=>{
    if(delay){delay=false;return new Promise(resolve=>{finish=()=>resolve(Uint8Array.of(1,1,1,1).buffer);});}
    return Promise.resolve(Uint8Array.of(1,1,1,1).buffer);
  }};
  const descriptor=vocalCacheDescriptor([...new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))]
    .map(value=>value.toString(16).padStart(2,'0')).join(''),1,[0]);
  await vocalWaveformCache.write(descriptor,1,new Float32Array(vocalPeakLength(1)));
  runtime.state.clips=[{id:'one',audioSourceId:'a',_file:file,dur:1},{id:'two',audioSourceId:'b',_file:file,dur:1}];
  delay=true;const slow=rememberSourceVocalSelection('a',true);
  try{expect(await rememberSourceVocalSelection('b',false)).toBe(true);}finally{finish();}
  expect(await slow).toBe(false);
  expect(await restoreCachedSourceVocals('a')).toBeNull();
  expect(await restoreCachedSourceVocals('b')).toBeNull();
});
