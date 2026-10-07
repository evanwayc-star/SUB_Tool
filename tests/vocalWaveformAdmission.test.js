import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks=vi.hoisted(()=>({
  native:vi.fn(),cancel:vi.fn(),workers:[],
  state:{clips:[],audioProject:{sourceMaps:{}},duration:1},
  media:{tracks:[],externalAudioSources:[],activeSource:'video'},
}));
vi.mock('../src/state.js',()=>({State:mocks.state,DESK:{vocalWaveChunk:mocks.native,cancelVocalWaveChunk:mocks.cancel}}));
vi.mock('../src/events.js',()=>({emit:vi.fn()}));
vi.mock('../src/util.js',()=>({readFile:vi.fn()}));
vi.mock('../src/audio-engine.js',()=>({AudioEngine:{isReady:true}}));
vi.mock('../src/audio-routing-engine.js',()=>({AudioPipeline:{}}));
vi.mock('../src/media.js',()=>({Media:mocks.media}));
vi.mock('../src/dom.js',()=>({$:vi.fn(),video:{}}));
vi.mock('../src/ui.js',()=>({setStatus:vi.fn()}));
// Keep Wave, the source owner and client admission real; replace only the Worker port.
vi.mock('../src/vocal-waveform-worker.js?worker&inline',()=>({default:class{
  listeners=new Map();requests=[];terminated=0;
  constructor(){mocks.workers.push(this);}
  addEventListener(type,listener){this.listeners.set(type,listener);}
  postMessage(message){this.requests.push(message);}
  terminate(){this.terminated++;}
  respond(data){this.listeners.get('message')?.({data});}
}}));

import { Wave } from '../src/waveform-decoder.js';
import { analyzeSourceVocals } from '../src/vocal-waveform-source.js';
import { vocalWaveformClient } from '../src/vocal-waveform-worker-client.js';

const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const original=new Float32Array([-0.8,0.8]);
const controllers=[];
const outcome=promise=>promise.then(value=>({value}),error=>({error}));
function analyze(source,controller=new AbortController()){
  controllers.push(controller);
  return outcome(analyzeSourceVocals(source,{signal:controller.signal}));
}
const source=id=>({id,audioSourceId:`audio-${id}`,audioSrc:`runtime-${id}`,path:`${id}.wav`,dur:1,timelineLaneId:'lane-1'});
const pcm=duration=>({sampleRate:44100,channels:2,samples:new Float32Array(Math.round(duration*44100)*2).buffer});
function register(sources){
  mocks.state.clips=sources;
  for(const item of sources)Wave.registerSourceWaveforms(item,{mixPeaks:original});
}
function result(worker,index,value){
  const request=worker.requests[index];
  expect(request?.type).toBe('analyze');
  expect(request.channels).toHaveLength(2);
  expect(request.channels[0]).toBeInstanceOf(Float32Array);
  const peaks=new Float32Array(Math.ceil(request.lengthSamples/441)*2);
  for(let index=0;index<peaks.length;index+=2){peaks[index]=-value;peaks[index+1]=value;}
  worker.respond({type:'result',jobId:request.jobId,peaks});
}

beforeEach(()=>{
  mocks.native.mockReset().mockImplementation(async({duration})=>pcm(duration));
  mocks.cancel.mockReset().mockResolvedValue(true);
  mocks.workers.length=0;
  mocks.state.clips=[];
  Wave.clearSources();
});
afterEach(async()=>{
  Wave.clearSources();
  for(const controller of controllers.splice(0))controller.abort();
  await tick();
  vocalWaveformClient.terminate();
});

it('不同母素材的人聲整列選擇共用單 Worker 排隊，全部完成前仍顯示原波形',async()=>{
  const left=source('a'),right=source('b');register([left,right]);
  const selection=Wave.setSourceWaveLaneSelection([left,right],'vocals');
  const completed=outcome(selection);
  await vi.waitFor(()=>expect(mocks.workers[0]?.requests).toHaveLength(1));
  expect(mocks.native.mock.calls.map(([request])=>request.path)).toEqual(['a.wav']);
  expect(Wave.getSourceWaveLaneState([left,right])).toMatchObject({selection:'mix',pending:true});
  result(mocks.workers[0],0,0.2);
  await vi.waitFor(()=>expect(mocks.workers[0]?.requests).toHaveLength(2));
  expect(mocks.native.mock.calls.map(([request])=>request.path)).toEqual(['a.wav','b.wav']);
  expect(Wave.getSourceWaveform(left).peaks).toBe(original);
  expect(Wave.getSourceWaveform(right).peaks).toBe(original);
  result(mocks.workers[0],1,0.4);
  expect(await completed).toEqual({value:['vocals','vocals']});
  expect(Wave.getSourceWaveLaneState([left,right])).toMatchObject({selection:'vocals',pending:false});
  expect(Wave.getSourceWaveform(left).peaks[1]).toBeCloseTo(0.2);
  expect(Wave.getSourceWaveform(right).peaks[1]).toBeCloseTo(0.4);
  expect(mocks.workers).toHaveLength(1);
  expect(mocks.workers[0].terminated).toBe(0);
});

it('取消單一排隊來源不取消 active 工作，同母素材其他 caller 仍取得共用結果',async()=>{
  const first=source('active'),queued=source('queued'),cancelled=source('cancelled');
  const alias={...queued,id:'split',audioSourceId:'audio-split',audioSrc:'runtime-split'};
  register([first,queued,alias,cancelled]);
  const firstResult=analyze(first);
  await vi.waitFor(()=>expect(mocks.workers[0]?.requests).toHaveLength(1));
  const one=new AbortController(),two=new AbortController();
  const queuedResult=analyze(queued,one);
  const sharedResult=analyze(alias);
  const cancelledResult=analyze(cancelled,two);
  await tick();one.abort();two.abort();
  expect(await queuedResult).toMatchObject({error:{name:'AbortError'}});
  expect(await cancelledResult).toMatchObject({error:{name:'AbortError'}});
  expect(mocks.native.mock.calls.map(([request])=>request.path)).toEqual(['active.wav']);
  expect(mocks.workers[0].terminated).toBe(0);
  result(mocks.workers[0],0,0.3);
  expect((await firstResult).value[1]).toBeCloseTo(0.3);
  await vi.waitFor(()=>expect(mocks.workers[0]?.requests).toHaveLength(2));
  result(mocks.workers[0],1,0.6);
  expect((await sharedResult).value[1]).toBeCloseTo(0.6);
  expect(mocks.native.mock.calls.map(([request])=>request.path)).toEqual(['active.wav','queued.wav']);
});

it.each(['resolve','reject'])('重開專案取消 active 讀取與排隊來源，舊 PCM 晚到 %s 不影響新專案',async late=>{
  const old=source('old'),queued=source('old-queued');register([old,queued]);
  let finishOld;
  mocks.native.mockImplementation(({path,duration})=>path==='old.wav'
    ?new Promise((resolve,reject)=>{finishOld=()=>late==='resolve'?resolve(pcm(duration)):reject(new Error('舊讀取晚到失敗'));}):Promise.resolve(pcm(duration)));
  const oldSelection=Wave.setSourceWaveLaneSelection([old,queued],'vocals').catch(error=>error);
  await vi.waitFor(()=>expect(mocks.native).toHaveBeenCalledTimes(1));
  await tick();
  const oldRequest=mocks.native.mock.calls[0][0];
  Wave.clearSources();
  const next=source('new'),last=source('new-last');register([next,last]);
  const newSelection=Wave.setSourceWaveLaneSelection([next,last],'vocals');
  const completed=outcome(newSelection);
  await vi.waitFor(()=>expect(mocks.workers[0]?.requests).toHaveLength(1));
  expect(mocks.cancel).toHaveBeenCalledWith(oldRequest.requestId);
  expect(mocks.native.mock.calls.map(([request])=>request.path)).toEqual(['old.wav','new.wav']);
  finishOld();await oldSelection;await tick();
  expect(mocks.workers[0].terminated).toBe(0);
  expect(mocks.workers[0].requests).toHaveLength(1);
  expect(Wave.getSourceWaveLaneState([next,last])).toMatchObject({selection:'mix',pending:true});
  result(mocks.workers[0],0,0.5);
  await vi.waitFor(()=>expect(mocks.workers[0]?.requests).toHaveLength(2));
  result(mocks.workers[0],1,0.7);
  expect(await completed).toEqual({value:['vocals','vocals']});
  expect(mocks.native.mock.calls.map(([request])=>request.path)).toEqual(['old.wav','new.wav','new-last.wav']);
  expect(Wave.getSourceWaveform(next).peaks[1]).toBeCloseTo(0.5);
  expect(Wave.getSourceWaveform(last).peaks[1]).toBeCloseTo(0.7);
});
