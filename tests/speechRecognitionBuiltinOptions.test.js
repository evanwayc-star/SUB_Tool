import {beforeEach,describe,expect,it,vi} from 'vitest';
const capture=vi.hoisted(()=>({requests:[],generation:[]}));
vi.mock('../src/speech-recognition-worker.js?worker&inline',async()=>{
  const {buildBuiltinGenerationOptions}=await import('../src/speech-recognition-worker-runtime.js');
  return {default:class {
    listeners=new Map();
    addEventListener(type,listener){this.listeners.set(type,listener);}
    terminate(){}
    postMessage(request){
      capture.requests.push(request);
      capture.generation.push(buildBuiltinGenerationOptions(request));
      queueMicrotask(()=>this.listeners.get('message')({data:{type:'result',jobId:request.jobId,segments:[]}}));
    }
  }};
});
import {transcribeAudioStream,transcribeWithBuiltinModel} from '../src/speech-recognition-engine.js';

beforeEach(()=>{capture.requests.length=0;capture.generation.length=0;});
describe('public builtin recognition option chain',()=>{
  it.each([0,0.2,0.5])('公共音訊入口把溫度%s送經Worker client並產生真正的generation選項',async temperature=>{
    const audioBuffer={duration:1,length:16000,sampleRate:16000,numberOfChannels:1,getChannelData:()=>new Float32Array(16000)};
    await transcribeAudioStream({audioBuffer,provider:'builtin',language:'en',temperature});
    expect(capture.requests).toHaveLength(1);
    expect(capture.requests[0].temperature).toBe(temperature);
    expect(capture.generation[0].do_sample).toBe(temperature>0);
    if(temperature>0)expect(capture.generation[0].temperature).toBe(temperature);
    else expect(capture.generation[0]).not.toHaveProperty('temperature');
  });
  it('低階本機入口沿用零溫度greedy預設；取消不啟動Worker',async()=>{
    await transcribeWithBuiltinModel({audioFloat32:new Float32Array([0,0]),language:'en'});
    expect(capture.requests[0].temperature).toBe(0);
    expect(capture.generation[0].do_sample).toBe(false);
    const controller=new AbortController();controller.abort();
    await expect(transcribeWithBuiltinModel({audioFloat32:new Float32Array([0]),temperature:0.5,signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
    expect(capture.requests).toHaveLength(1);
  });
});
