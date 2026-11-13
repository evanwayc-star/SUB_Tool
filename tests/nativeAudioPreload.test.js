import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

function bridge(result){
  const invoke=vi.fn(async()=>result);
  let api;
  vm.runInNewContext(readFileSync('electron/preload.js','utf8'),{require:name=>{
    if(name!=='electron') throw new Error(`unexpected require: ${name}`);
    return {contextBridge:{exposeInMainWorld:(_name,value)=>{api=value;}},
      ipcRenderer:{invoke,on:vi.fn(),send:vi.fn()},webUtils:{}};
  }});
  return {api,invoke};
}

it('真 preload 保留母素材時間與完整 bus mixes，回傳對應混音峰值',async()=>{
  const result={time:1.025,levels:[{sourceStream:0,sourceChannel:0,level:.6}],busLevels:[{busId:'a1',level:1.2}]};
  const {api,invoke}=bridge(result);
  const request={path:'C:/two-tones.mov',time:1,rate:1,mixes:[{busId:'a1',inputs:[
    {sourceStream:0,sourceChannel:0,gain:1},{sourceStream:1,sourceChannel:0,gain:1}]}]};
  expect(await api.readAudioMeter(request)).toEqual(result);
  expect(invoke).toHaveBeenCalledWith('audio:meterRead',request);
  await api.stopAudioMeter();
  expect(invoke).toHaveBeenLastCalledWith('audio:meterStop');
});

it('真 preload 保留原生控制的來源 session 與逐聲道增益',async()=>{
  const {api,invoke}=bridge(true);
  const request={sourceSessionId:'current',channels:[{sourceStream:0,sourceChannel:0,gain:0}]};
  await expect(api.mpv.audioMix(request)).resolves.toBe(true);
  expect(invoke).toHaveBeenCalledWith('mpv:audioMix',request);
});
