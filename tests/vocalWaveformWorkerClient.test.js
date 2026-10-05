import { expect, it, vi } from 'vitest';
vi.mock('../src/vocal-waveform-worker.js?worker&inline',()=>({default:class{}}));
import { VocalWaveformClient } from '../src/vocal-waveform-worker-client.js';

class FakeWorker{
  listeners=new Map();terminated=0;requests=[];
  addEventListener(type,listener){this.listeners.set(type,listener);}
  terminate(){this.terminated++;}
  postMessage(message){this.requests.push(message);}
  respond(data){this.listeners.get('message')?.({data});}
}
const audio=duration=>[new Float32Array(Math.round(duration*44100)),new Float32Array(Math.round(duration*44100))];
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

it('61秒母素材分段只讀取34秒內PCM，丟棄context並保持完整來源桶位置',async()=>{
  const worker=new FakeWorker(),client=new VocalWaveformClient({createWorker:()=>worker});
  const reads=[];
  const promise=client.analyze({duration:61,readChunk:async request=>{reads.push(request);return audio(request.duration);}});
  for(let i=0;i<3;i++){
    await tick();
    const request=worker.requests[i];
    expect(request.offsetSamples).toBe(i===0?0:88200);
    const result=new Float32Array(Math.ceil(request.lengthSamples/441)*2).fill(i+1);
    worker.respond({type:'result',jobId:request.jobId,peaks:result});
  }
  const peaks=await promise;
  expect(reads.map(({start,duration})=>[start,duration])).toEqual([[0,32],[28,33],[58,3]]);
  expect(peaks).toHaveLength(12200);
  expect([peaks[0],peaks[5999],peaks[6000],peaks[11999],peaks[12000],peaks.at(-1)]).toEqual([1,1,2,2,3,3]);
  expect(worker.terminated).toBe(0);
});

it('取消會終止真正推論；舊worker晚到結果不會完成新工作',async()=>{
  const workers=[],client=new VocalWaveformClient({createWorker:()=>{const worker=new FakeWorker();workers.push(worker);return worker;}});
  const controller=new AbortController();
  const old=client.analyze({duration:1,readChunk:async()=>audio(1),signal:controller.signal});
  const rejected=expect(old).rejects.toMatchObject({name:'AbortError'});
  await tick();controller.abort();await rejected;
  expect(workers[0].terminated).toBe(1);
  const next=client.analyze({duration:1,readChunk:async()=>audio(1)});await tick();
  workers[0].respond({type:'result',jobId:1,peaks:new Float32Array(200).fill(9)});
  expect(client.pending).not.toBeNull();
  workers[1].respond({type:'result',jobId:2,peaks:new Float32Array(200).fill(2)});
  expect((await next)[0]).toBe(2);
});

it('取消讀取中的工作後不建立worker，讀取失敗仍可重新分析',async()=>{
  let release;const createWorker=vi.fn(),controller=new AbortController();
  const client=new VocalWaveformClient({createWorker});
  const first=client.analyze({duration:1,signal:controller.signal,readChunk:()=>new Promise(resolve=>{release=resolve;})});
  const rejected=expect(first).rejects.toMatchObject({name:'AbortError'});
  controller.abort();release(audio(1));await rejected;
  expect(createWorker).not.toHaveBeenCalled();
  await expect(client.analyze({duration:1,readChunk:async()=>{throw new Error('extract failed');}})).rejects.toThrow('extract failed');
  expect(client.active).toBe(false);
});

it('拒絕重疊工作、不完整PCM與錯誤波形長度，避免污染來源快取',async()=>{
  const worker=new FakeWorker(),client=new VocalWaveformClient({createWorker:()=>worker});
  await expect(client.analyze({duration:10,readChunk:async()=>audio(1)})).rejects.toThrow('長度不足');
  const promise=client.analyze({duration:1,readChunk:async()=>audio(1)});
  const rejected=expect(promise).rejects.toThrow('波形長度');await tick();
  await expect(client.analyze({duration:1,readChunk:async()=>audio(1)})).rejects.toThrow('已有');
  worker.respond({type:'result',jobId:worker.requests[0].jobId,peaks:new Float32Array(2)});await rejected;
});

it('worker 載入失敗或逾時會釋放工作與GPU/WASM，可再次重試',async()=>{
  const worker=new FakeWorker(),client=new VocalWaveformClient({createWorker:()=>worker,timeoutMs:10});
  await expect(client.analyze({duration:1,readChunk:async()=>audio(1)})).rejects.toThrow('逾時');
  expect(worker.terminated).toBe(1);expect(client.active).toBe(false);
});

it('30.07 秒尾段使用整數 sample 桶計算，不因浮點誤差超出完整來源陣列',async()=>{
  const worker=new FakeWorker(),client=new VocalWaveformClient({createWorker:()=>worker});
  const promise=client.analyze({duration:30.07,readChunk:async ({duration})=>audio(duration)});
  for(let i=0;i<2;i++){
    await tick();const request=worker.requests[i];
    worker.respond({type:'result',jobId:request.jobId,peaks:new Float32Array(Math.ceil(request.lengthSamples/441)*2).fill(1)});
  }
  expect(await promise).toHaveLength(6014);
});
