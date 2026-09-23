import { describe, it, expect, vi } from 'vitest';
import { createAudioEffects } from '../src/audio-effects.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const spec={max:-6,min:-12,inputBoost:0,isTruePeak:true};
const clip=id=>({id,audioSourceId:id,path:`C:/${id}.mp4`});
function fixture(){
  const live=[clip('a'),clip('b')];
  const pending=[];
  const install=vi.fn();const record=vi.fn();const failed=vi.fn();
  const effects=createAudioEffects({sources:()=>live,process:vi.fn((source,options,work)=>{
    const d=deferred();pending.push({...d,source,options,work});return d.promise;
  }),prepare:async(source,result)=>result,install,record,failed});
  const complete=(n)=>pending[n].resolve({outputPath:`C:/cache/${n}.wav`,spec:pending[n].options});
  return {live,pending,effects,install,record,failed,complete};
}
describe('來源效果工作 interface',()=>{
  it('相同母素材的不同來源身分不共用效果或 UI 狀態',()=>{
    const f=fixture();f.live[1].path=f.live[0].path;
    expect(f.effects.targets({id:'b',path:f.live[0].path})).toEqual([f.live[1]]);
    expect(f.effects.targets({asset:f.live[1]})).toEqual([f.live[1]]);
  });
  it('失效播放快取會從母素材重建一次',async()=>{
    const source=clip('a');let missing=false;
    const process=vi.fn(async()=>({outputPath:'new.wav',spec}));
    const prepare=vi.fn(async(s,result)=>{if(result&&missing){missing=false;throw new Error('cache removed');}return result;});
    const effects=createAudioEffects({sources:()=>[source],process,prepare,install:vi.fn()});
    await effects.apply(source,spec);await effects.apply(source,null);missing=true;
    await effects.apply(source,spec);
    expect(process).toHaveBeenCalledTimes(2);expect(source.hasAudioLimiter).toBe(true);
  });
  it('同來源最後一次套用有效，即使舊adapter忽略取消並晚到',async()=>{
    const f=fixture();const old=f.effects.apply(f.live[0],spec);const latest=f.effects.apply(f.live[0],{...spec,max:-12});
    expect(f.pending[0].work.signal.aborted).toBe(true);
    f.complete(1);await latest;f.complete(0);await old;
    expect(f.live[0].audioLimiterSpec.max).toBe(-12);
    expect(f.install).toHaveBeenCalledTimes(1);expect(f.record).toHaveBeenCalledTimes(1);
    expect(f.live[0].path).toBe('C:/a.mp4');
  });
  it('不同來源的進度不互相覆寫',async()=>{
    const f=fixture();const a=f.effects.apply(f.live[0],spec);const b=f.effects.apply(f.live[1],spec);
    f.pending[0].work.progress({pct:31});f.pending[1].work.progress({pct:72});
    expect(f.live.map(c=>c.audioNormalizeProgress)).toEqual([31,72]);
    f.complete(0);f.complete(1);await Promise.all([a,b]);
    expect(f.record).toHaveBeenCalledTimes(2);
  });
  it('還原會取消待處理效果，晚到結果不能再啟用',async()=>{
    const f=fixture();const pending=f.effects.apply(f.live[0],spec);
    await f.effects.apply(f.live[0],null);f.complete(0);await pending;
    expect(f.live[0].hasAudioLimiter).toBeUndefined();expect(f.live[0].normalizedAudioPath).toBeUndefined();
    expect(f.install).toHaveBeenCalledTimes(1);
  });
  it('專案切換或相同id的新物件不接受舊結果',async()=>{
    const f=fixture();const pending=f.effects.apply(f.live[0],spec);
    f.effects.invalidate({clear:true});f.live.splice(0,2,clip('a'));
    f.complete(0);await pending;
    expect(f.install).not.toHaveBeenCalled();expect(f.record).not.toHaveBeenCalled();
  });
  it('來源移除及換路徑也不接受舊結果',async()=>{
    const f=fixture();const pending=f.effects.apply(f.live[0],spec);
    f.live[0].path='C:/relinked.mp4';f.complete(0);await pending;
    expect(f.install).not.toHaveBeenCalled();
  });
  it('失敗保留既有效果，清除進度並允許重新套用',async()=>{
    const f=fixture();const a=f.effects.apply(f.live[0],spec);f.complete(0);await a;
    const b=f.effects.apply(f.live[0],{...spec,max:-1});f.pending[1].reject(new Error('disk full'));await b;
    expect(f.live[0].audioLimiterSpec.max).toBe(-6);expect(f.live[0].audioNormalizing).toBeUndefined();
    expect(f.record).toHaveBeenCalledTimes(1);expect(f.failed).toHaveBeenCalledTimes(1);
  });
  it('還原與重開依效果資料重建，快取不進入來源路徑且不另記history',async()=>{
    const f=fixture();f.live[0].hasAudioLimiter=true;f.live[0].audioLimiterSpec=spec;
    f.effects.sync();f.complete(0);await new Promise(r=>setTimeout(r,0));
    expect(f.install).toHaveBeenCalledTimes(1);expect(f.record).not.toHaveBeenCalled();
    delete f.live[0].audioLimiterSpec;delete f.live[0].hasAudioLimiter;f.effects.sync();await new Promise(r=>setTimeout(r,0));
    expect(f.install).toHaveBeenLastCalledWith(f.live[0],null,null);
    expect(f.live[0].path).toBe('C:/a.mp4');
  });
  it('準備播放器時失效會釋放尚未安裝的資源',async()=>{
    const source=clip('a');const prepared=deferred();const dispose=vi.fn();const install=vi.fn();
    const effects=createAudioEffects({sources:()=>[source],process:async()=>({spec}),prepare:()=>prepared.promise,install});
    const pending=effects.apply(source,spec);await Promise.resolve();effects.invalidate();prepared.resolve({dispose});await pending;
    expect(dispose).toHaveBeenCalledOnce();expect(install).not.toHaveBeenCalled();
  });
});
