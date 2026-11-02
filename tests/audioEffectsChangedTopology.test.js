// @vitest-environment jsdom
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';

const { vocalSourceFingerprint }=createRequire(import.meta.url)('../electron/vocal-waveform-fingerprint.js');
let Media,State,desk,root;
beforeAll(async()=>{
  document.body.innerHTML=fs.readFileSync('index.html','utf8');
  desk={isDesktop:true};window.subtool=desk;
  ({Media}=await import('../src/media.js'));
  ({State}=await import('../src/state.js'));
});

it.each(['取消','來源佈局失權'])('probe 等待期間%s不得啟動音訊處理',async ending=>{
  root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-topology-test-'));
  const file=path.join(root,'mother.mov');fs.writeFileSync(file,'stable mother');
  desk.audioSourceFingerprint=vocalSourceFingerprint;
  let release,entered=false;
  const gate=new Promise(resolve=>{release=resolve;});
  desk.probe=vi.fn(async()=>{entered=true;await gate;return {audio:[{channels:1}]};});
  desk.normalizeAudio=vi.fn();desk.cleanupAudio=vi.fn();
  const source={id:'clip',type:'video',audioSourceId:'source',path:file,descriptors:[{sourceStream:0,sourceChannel:0}]};
  State.clips=[source];
  const install=vi.spyOn(Media,'_installAudioEffect').mockImplementation(()=>{});
  const effects=Media.audioEffects;
  const pending=effects.apply(source,{max:-6,min:-12});
  try{
    await vi.waitFor(()=>expect(entered).toBe(true));
    if(ending==='取消') effects.invalidate({clear:true});
    else source.descriptors=[{sourceStream:0,sourceChannel:0},{sourceStream:0,sourceChannel:1}];
    release();expect(await pending).toEqual({status:'replaced'});
    expect(desk.normalizeAudio).not.toHaveBeenCalled();expect(install).not.toHaveBeenCalled();
  }finally{release();effects.invalidate({clear:true});}
});
afterEach(()=>{
  Media._audioEffects?.invalidate({clear:true});State.clips=[];vi.restoreAllMocks();
  if(root){
    const real=fs.realpathSync(root);
    if(path.dirname(real)!==fs.realpathSync(os.tmpdir())||!path.basename(real).startsWith('subtool-topology-test-')) throw new Error('拒絕刪除測試目錄以外資料');
    fs.rmSync(real,{recursive:true,force:true});root=null;
  }
});

it.each([
  ['單聲道變雙聲道',[{channels:2}],[[0,0],[0,1]]],
  ['一條串流變兩條串流',[{channels:1},{channels:1}],[[0,0],[1,0]]],
])('同路徑換檔 %s 時處理實際聲道並保留原配線',async(_description,audio,expected)=>{
  root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-topology-test-'));
  const file=path.join(root,'mother.mov');
  // 真檔案與正式有界 fingerprint；probe／normalize 使用可控 adapter 模擬所見拓撲。
  const write=streams=>fs.writeFileSync(file,JSON.stringify({audio:streams}));
  write([{channels:1}]);
  desk.audioSourceFingerprint=vocalSourceFingerprint;
  desk.probe=vi.fn(async file=>JSON.parse(fs.readFileSync(file,'utf8')));
  desk.normalizeAudio=vi.fn(async(_file,options)=>({outputPath:`stream-${options.sourceStream}.wav`}));
  desk.cleanupAudio=vi.fn();
  const source={id:'clip',type:'video',audioSourceId:'source',path:file,descriptors:[{sourceStream:0,sourceChannel:0}]};
  State.clips=[source];
  vi.spyOn(Media,'_prepareAudioEffect').mockImplementation(async(_source,result)=>result);
  const install=vi.spyOn(Media,'_installAudioEffect').mockImplementation(()=>{});
  const effects=Media.audioEffects;
  const options={max:-6,min:-12,inputBoost:0,isTruePeak:true};
  const routing=JSON.stringify(State.audioProject);
  try{
    expect(await effects.apply(source,options)).toEqual({status:'completed'});
    expect(await effects.apply(source,null)).toEqual({status:'completed'});
    write(audio);install.mockClear();desk.normalizeAudio.mockClear();
    expect(await effects.apply(source,options)).toEqual({status:'completed'});
    expect(install.mock.lastCall[1].streams.flatMap(stream=>stream.descriptors.map(d=>[d.sourceStream,d.sourceChannel]))).toEqual(expected);
    expect(JSON.stringify(State.audioProject)).toBe(routing);
    write([{channels:1}]);
    expect(await effects.apply(source,options)).toEqual({status:'completed'});
    expect(install.mock.lastCall[1].streams.flatMap(stream=>stream.descriptors.map(d=>[d.sourceStream,d.sourceChannel]))).toEqual([[0,0]]);
  }finally{effects.invalidate({clear:true});}
});
