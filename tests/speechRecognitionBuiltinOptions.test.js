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
  it.each(['buffer','reader'])('%s 語音辨識自動選完整 Large v3，忽略文字匹配留下的模型與設定',async source=>{
    const buffer={duration:1,length:16000,sampleRate:16000,numberOfChannels:1,getChannelData:()=>new Float32Array(16000).fill(.1)};
    const audioBuffer=source==='reader'?{duration:1,readRange:vi.fn(async()=>buffer)}:buffer;
    await transcribeAudioStream({audioBuffer,provider:'builtin',taskMode:'transcribe',
      builtinModel:'onnx-community/whisper-tiny',temperature:1,prompt:'舊提示'});
    expect(capture.requests).toHaveLength(1);
    expect(capture.requests[0]).toMatchObject({modelId:'onnx-community/whisper-large-v3-ONNX',webgpuDtype:'q4',wasmDtype:'q8',
      taskMode:'transcribe',returnTimestamps:true,language:'auto',temperature:0,prompt:''});
    expect(capture.generation[0]).toMatchObject({return_timestamps:true,do_sample:false});
    expect(capture.generation[0]).not.toHaveProperty('language');
  });
  it('語音辨識保留指定的韓文，文字匹配自選逐詞模型並忽略舊進階偏好',async()=>{
    const audioFloat32=new Float32Array(16000);
    await transcribeWithBuiltinModel({audioFloat32,taskMode:'transcribe',language:'ko'});
    expect(capture.generation[0]).toMatchObject({language:'ko',task:'transcribe'});
    await transcribeWithBuiltinModel({audioFloat32,taskMode:'align',modelId:'onnx-community/whisper-tiny',prompt:'保留',temperature:.5});
    expect(capture.requests[1]).toMatchObject({modelId:'onnx-community/whisper-large-v3-turbo_timestamped',language:'auto',prompt:'',temperature:0,returnTimestamps:'word'});
    await transcribeWithBuiltinModel({audioFloat32,modelId:'onnx-community/whisper-tiny',prompt:'保留',temperature:.5});
    expect(capture.requests[2]).toMatchObject({modelId:'onnx-community/whisper-tiny_timestamped',prompt:'保留',temperature:.5,returnTimestamps:'word'});
  });
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
