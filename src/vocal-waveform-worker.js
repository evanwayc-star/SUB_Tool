import * as ort from 'onnxruntime-web/webgpu';
import { PffftSTFT } from 'web-audio-separation';
import { MDX, separateStereo, speechMono16k, speechRanges, vocalPeaks } from './vocal-waveform-engine.js';
import { VOCAL_MODELS, verifiedModel } from './vocal-waveform-models.js';

ort.env.wasm.wasmPaths='https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
ort.env.wasm.numThreads=1;
ort.env.wasm.proxy=false;
let runtime=null;

async function initialize(progress){
  if(runtime)return runtime;
  const model=await verifiedModel(VOCAL_MODELS.vocals,progress);
  const speechModel=await verifiedModel(VOCAL_MODELS.speech,progress);
  progress({label:'載入人聲分離模型…',percent:0});
  let separator, device='CPU';
  if(globalThis.navigator?.gpu){
    try{separator=await ort.InferenceSession.create(model,{executionProviders:['webgpu'],graphOptimizationLevel:'all'});device='GPU';}
    catch(error){console.warn('Vocal waveform WebGPU fallback',error);}
  }
  separator??=await ort.InferenceSession.create(model,{executionProviders:['wasm'],graphOptimizationLevel:'all'});
  let detector;
  try{
    detector=await ort.InferenceSession.create(speechModel,{executionProviders:['wasm']});
    const stft=new PffftSTFT(MDX.nFft,MDX.hop,MDX.dimF); await stft.init();
    runtime={separator,detector,stft,device};
    return runtime;
  }catch(error){await separator.release();await detector?.release();throw error;}
}

async function detectSpeech(detector,channels){
  const mono=speechMono16k(channels);
  let state=new ort.Tensor('float32',new Float32Array(256),[2,1,128]);
  const rate=new ort.Tensor('int64',new BigInt64Array([16000n]),[]);
  const context=new Float32Array(64), probabilities=[];
  try{
    for(let at=0;at<mono.length;at+=512){
      const window=new Float32Array(576); window.set(context);
      window.set(mono.subarray(at,Math.min(at+512,mono.length)),64);
      const input=new ort.Tensor('float32',window,[1,576]);
      const result=await detector.run({input,state,sr:rate});
      probabilities.push(result.output.data[0]);
      state.dispose();state=result.stateN;
      result.output.dispose();input.dispose();
      context.set(window.subarray(512));
    }
  }finally{state.dispose();rate.dispose();}
  return speechRanges(probabilities,channels[0].length/44100);
}

let busy=false;
self.addEventListener('message',async event=>{
  const {type,jobId,channels,offsetSamples,lengthSamples}=event.data||{};
  if(type!=='analyze'||busy)return;
  busy=true;
  const progress=payload=>self.postMessage({type:'progress',jobId,progress:payload});
  try{
    const {separator,detector,stft,device}=await initialize(progress);
    const separated=await separateStereo(channels,{stft,predict:async spectrum=>{
      const input=new ort.Tensor('float32',spectrum,[1,4,MDX.dimF,MDX.dimT]);
      const result=await separator.run({input});
      try{return Float32Array.from(result.output.data);}
      finally{input.dispose();result.output.dispose();}
    },onProgress:fraction=>progress({fraction,label:`分離人聲（${device}）…`})});
    progress({fraction:1,label:'辨識說話區段…'});
    const ranges=await detectSpeech(detector,separated);
    const peaks=vocalPeaks(separated,ranges,{offsetSamples,lengthSamples});
    self.postMessage({type:'result',jobId,peaks},[peaks.buffer]);
  }catch(error){self.postMessage({type:'error',jobId,error:{name:error.name,message:error.message}});}
  finally{busy=false;}
});
