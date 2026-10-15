import { describe, expect, it, vi } from 'vitest';
import { createAudioEngineForTest } from '../src/audio-engine.js';

function pcm(channels, rate=10) {
  const data=channels.map(channel=>Float32Array.from(channel));
  return {numberOfChannels:data.length,length:data[0].length,sampleRate:rate,duration:data[0].length/rate,
    getChannelData:channel=>data[channel]};
}
function engine(decoded, sourceMetadata=vi.fn()) {
  const context={state:'running',destination:{},createGain:()=>({connect(){}}),
    createAnalyser:()=>({fftSize:8}),decodeAudioData:vi.fn(async()=>decoded),
    createBuffer:(channels,length,rate)=>pcm(Array.from({length:channels},()=>Array(length).fill(0)),rate)};
  return {audio:createAudioEngineForTest({createContext:()=>context,sourceMetadata}),context};
}

describe('decoded original audio shares the normalized source epoch',()=>{
  it('drops only the pre-video PCM, keeps both channels and pads a shorter audio tail',async()=>{
    const original=pcm([[1,2,3,4,5,6,7],[11,12,13,14,15,16,17]]);
    const {audio}=engine(original);
    const normalized=await audio.decodeSourceAudioData(new ArrayBuffer(1),{metadata:{
      presentationTimestampOffset:-5.5,audioPresentationTimestampOffset:-5,duration:1}});
    expect([...normalized.getChannelData(0)]).toEqual([6,7,0,0,0,0,0,0,0,0]);
    expect([...normalized.getChannelData(1)]).toEqual([16,17,0,0,0,0,0,0,0,0]);
    expect([...original.getChannelData(0)]).toEqual([1,2,3,4,5,6,7]);
    expect(normalized.duration).toBe(1);
  });

  it('preserves a real audio leading gap and a stream starting beyond source EOF stays silent',async()=>{
    const {audio}=engine(pcm([[1,2,3,4]]));
    const metadata={presentationTimestampOffset:-5,audioPresentationTimestampOffset:-5.2,duration:1};
    const normalized=await audio.normalizeSourceAudioBuffer(pcm([[1,2,3,4]]),{metadata});
    expect([...normalized.getChannelData(0)]).toEqual([0,0,1,2,3,4,0,0,0,0]);
    const silent=await audio.normalizeSourceAudioBuffer(pcm([[1,2]]),{metadata:{...metadata,audioPresentationTimestampOffset:-7}});
    expect([...silent.getChannelData(0)]).toEqual(Array(10).fill(0));
  });

  it('uses the selected original stream epoch and cannot normalize an unsupported stream with stream zero',async()=>{
    const original=pcm([[1,2,3,4,5,6,7,8,9,10]]),{audio}=engine(original);
    const metadata={presentationTimestampOffset:-5.5,audioPresentationTimestampOffset:-5,
      audioPresentationTimestampOffsets:[-5,-5.2,null],duration:.5};
    const second=await audio.normalizeSourceAudioBuffer(original,{metadata,sourceStream:1});
    expect([...second.getChannelData(0)]).toEqual([4,5,6,7,8]);
    expect(await audio.normalizeSourceAudioBuffer(original,{metadata,sourceStream:2})).toBe(original);
    expect(await audio.normalizeSourceAudioBuffer(original,{metadata:{...metadata,decoderAudioPresentationTimestampOffsets:[null]}})).toBe(original);
  });

  it('a normalized original, inherited mono copy and explicitly processed WAV never shift twice',async()=>{
    const original=pcm([[1,2,3,4,5,6,7,8,9,10]]),{audio}=engine(original);
    const metadata={presentationTimestampOffset:-5.5,audioPresentationTimestampOffset:-5,duration:.5};
    const normalized=await audio.normalizeSourceAudioBuffer(original,{metadata});
    expect(await audio.normalizeSourceAudioBuffer(normalized,{metadata})).toBe(normalized);
    const mono=audio.inheritSourceAudioClock(normalized,pcm([[6,7,8,9,10]]));
    expect(await audio.normalizeSourceAudioBuffer(mono,{metadata})).toBe(mono);
    const wav=audio.markSourceAudioBuffer(pcm([[.2,.3,.4,.5,.6]]));
    expect(await audio.normalizeSourceAudioBuffer(wav,{metadata})).toBe(wav);
  });

  it('only exact decoded-active audio epoch moves PCM; absence of proof keeps the original buffer',async()=>{
    const original=pcm([[1,2,3,4]]),{audio}=engine(original);
    expect(await audio.normalizeSourceAudioBuffer(original,{metadata:{presentationTimestampOffset:-5.5,duration:1}})).toBe(original);
    const ordinaryAAC=await audio.normalizeSourceAudioBuffer(original,{metadata:{
      presentationTimestampOffset:0,audioPresentationTimestampOffset:0,duration:.4}});
    expect(ordinaryAAC).toBe(original);
  });

  it('replacement while decoding or reading metadata rejects late PCM before any normalization',async()=>{
    const original=pcm([[1,2,3,4]]),metadata=vi.fn();
    const {audio,context}=engine(original,metadata);
    let finish,owns=true;
    context.decodeAudioData.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const pending=audio.decodeSourceAudioData(new ArrayBuffer(1),{url:'blob:old',owns:()=>owns});
    owns=false;finish(original);
    await expect(pending).rejects.toMatchObject({name:'AbortError'});
    expect(metadata).not.toHaveBeenCalled();
    owns=true;metadata.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const header=audio.normalizeSourceAudioBuffer(original,{url:'blob:old',owns:()=>owns});
    owns=false;finish({presentationTimestampOffset:-5.5,audioPresentationTimestampOffset:-5,duration:1});
    await expect(header).rejects.toMatchObject({name:'AbortError'});
  });
});
