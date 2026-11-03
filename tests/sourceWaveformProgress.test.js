import { expect, it, vi } from 'vitest';
import { createSourceWaveformProgress } from '../src/source-waveform-progress.js';

const key='a'.repeat(16);
function batch(startSample=0,completedSamples=400,totalSamples=800){
  return {sourceKey:key,startSample,completedSamples,totalSamples,sampleRate:4000,resolution:100,
    peaks:Float32Array.from({length:Math.ceil((completedSamples-startSample)/40)*2},(_,i)=>i%2?.5:-.25)};
}
it('publishes only persisted contiguous buckets, including the final fractional bucket',()=>{
  const publish=vi.fn(),progress=createSourceWaveformProgress({duration:.20025,publish});
  expect(progress.accept(batch(0,400,801))).toBe(true);
  const first=publish.mock.calls[0][0];expect(first).toHaveLength(20);expect(progress.complete).toBe(false);
  expect(progress.accept(batch(400,801,801))).toBe(true);
  expect(first).toHaveLength(20);expect(publish.mock.lastCall[0]).toHaveLength(42);expect(progress.complete).toBe(true);
  expect(progress.verifyResult({wave:'wave.wav',sourceKey:key,start:0,duration:.20025,complete:true})).toBe(true);
});
it.each([
  {startSample:40}, {completedSamples:401}, {completedSamples:840}, {sourceKey:'invalid'},
  {totalSamples:801}, {sampleRate:48000}, {resolution:50}, {peaks:new Float32Array(2)},
  {peaks:Float32Array.from({length:20},()=>NaN)}, {peaks:Float32Array.from({length:20},()=>2)},
])('rejects malformed or noncontiguous incremental evidence %j',change=>{
  const publish=vi.fn(),progress=createSourceWaveformProgress({duration:.2,publish});
  expect(progress.accept({...batch(),...change})).toBe(false);expect(publish).not.toHaveBeenCalled();
});
it('late progress, duplicate batches and another source cannot overwrite prior peaks',()=>{
  let current=true;const publish=vi.fn(),progress=createSourceWaveformProgress({duration:.2,publish,owns:()=>current});
  expect(progress.accept(batch())).toBe(true);expect(progress.accept(batch())).toBe(false);
  expect(progress.accept({...batch(400,800),sourceKey:'b'.repeat(16)})).toBe(false);
  current=false;expect(progress.accept(batch(400,800))).toBe(false);expect(publish).toHaveBeenCalledOnce();
  expect(()=>progress.verifyResult({wave:'wave.wav',sourceKey:'b'.repeat(16),start:0,duration:.2,complete:true})).toThrow();
});
it('a synchronous publication that revokes ownership cannot report success',()=>{
  let current=true;const progress=createSourceWaveformProgress({duration:.2,owns:()=>current,publish:()=>{current=false;}});
  expect(progress.accept(batch())).toBe(false);
});
