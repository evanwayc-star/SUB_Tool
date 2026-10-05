import { expect, it } from 'vitest';
import { PffftSTFT } from 'web-audio-separation';
import { MDX, separateStereo, speechMono16k, speechRanges, vocalPeaks } from '../src/vocal-waveform-engine.js';

it('完整覆蓋極短音訊、重疊窗與不足一窗的尾端，保持左右聲道與 sample 位置',async()=>{
  for(const length of [123,MDX.chunk+6789]){
    const left=new Float32Array(length),right=new Float32Array(length);
    for(const at of [0,Math.floor(length/2),length-1]){left[at]=.2;right[at]=-.3;}
    let input;
    const stft={forward:data=>{input=data;return new Float32Array(4*MDX.dimF*MDX.dimT);},inverse:()=>input};
    const output=await separateStereo([left,right],{stft,predict:async data=>data});
    expect(output[0].length).toBe(length);
    for(let i=0;i<length;i++){
      expect(output[0][i]).toBeCloseTo(left[i]*MDX.compensate,6);
      expect(output[1][i]).toBeCloseTo(right[i]*MDX.compensate,6);
    }
  }
});

it('使用真實 PFFFT/STFT 往返後，音訊仍同時對齊且保留振幅',async()=>{
  const stft=new PffftSTFT(MDX.nFft,MDX.hop,MDX.dimF);await stft.init();
  const length=44100*2,channels=[new Float32Array(length),new Float32Array(length)];
  for(let i=0;i<length;i++){
    channels[0][i]=.2*Math.sin(2*Math.PI*441*i/44100);
    channels[1][i]=.3*Math.sin(2*Math.PI*882*i/44100);
  }
  const output=await separateStereo(channels,{stft,predict:async spectrum=>spectrum});
  let squared=0;
  for(let ch=0;ch<2;ch++)for(let i=4000;i<length-4000;i++)squared+=(output[ch][i]-channels[ch][i]*MDX.compensate)**2;
  expect(Math.sqrt(squared/(2*(length-8000)))).toBeLessThan(.0001);
});

it('語音降採樣保留時長與低頻訊號，抑制會混疊的高頻配樂',()=>{
  const sine=hz=>{
    const x=Float32Array.from({length:44100},(_,i)=>Math.sin(2*Math.PI*hz*i/44100));
    return speechMono16k([x,x]);
  };
  const rms=values=>Math.sqrt(values.slice(100,-100).reduce((sum,x)=>sum+x*x,0)/(values.length-200));
  expect(sine(1000)).toHaveLength(16000);
  expect(rms(sine(1000))).toBeGreaterThan(.69);
  expect(rms(sine(12000))).toBeLessThan(.03);
  const left=Float32Array.from({length:44100},(_,i)=>.3*Math.sin(2*Math.PI*220*i/44100));
  const right=Float32Array.from(left,value=>-value);
  expect(rms(speechMono16k([left,right]))).toBeGreaterThan(.2);
});

it('只繪製語音區段，保留弱尾音 padding 且不提前後移動來源桶',()=>{
  const probabilities=[...Array(10).fill(.01),...Array(10).fill(.9),...Array(10).fill(.01)];
  const ranges=speechRanges(probabilities,.96);
  expect(ranges).toEqual([[.24,.76]]);
  const audio=Float32Array.from({length:44100},()=>.3);
  const peaks=vocalPeaks([audio,audio],ranges);
  expect(peaks).toHaveLength(200);
  expect(peaks[23*2+1]).toBe(0);
  expect(peaks[24*2+1]).toBeCloseTo(.3);
  expect(peaks[77*2+1]).toBe(0);
  const center=vocalPeaks([audio,audio],ranges,{offsetSamples:4410,lengthSamples:4410});
  expect(center).toHaveLength(20);
  expect(center.every(value=>value===0)).toBe(true);
  expect(vocalPeaks([new Float32Array(3087),new Float32Array(3087)],[])).toHaveLength(14);
});

it('有說話但未結束時保留最後一個不完整 VAD frame，零語音則平線',()=>{
  expect(speechRanges([.9,.9,.9,.9],.101)).toEqual([[0,.101]]);
  expect(speechRanges([.1,.2,.3,.1],.128)).toEqual([]);
});
