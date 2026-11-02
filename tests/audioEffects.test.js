import { describe, it, expect, vi } from 'vitest';
import { createAudioEffects } from '../src/audio-effects.js';
import { Seq } from '../src/sequence.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { vocalSourceFingerprint }=createRequire(import.meta.url)('../electron/vocal-waveform-fingerprint.js');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const spec={max:-6,min:-12,inputBoost:0,isTruePeak:true};
const clip=id=>({id,audioSourceId:id,path:`C:/${id}.mp4`,in:0,out:10,dur:10,offset:0});
const splitClip=source=>({id:source.id+'-split',...Seq.planSplit(source,5).right});

describe('音訊效果母素材證據',()=>{
  async function withSource(run){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'subtool-audio-evidence-'));
    const file=path.join(dir,'mother.wav');fs.writeFileSync(file,'first source');
    try{await run(file);}finally{fs.unlinkSync(file);fs.rmdirSync(dir);}
  }
  function setup(file,overrides={}){
    const source={...clip('evidence'),path:file};
    const process=vi.fn(async(s,options)=>({outputPath:fs.readFileSync(s.path,'utf8'),spec:options,sourceFingerprint:await vocalSourceFingerprint(s.path)}));
    const install=vi.fn(),record=vi.fn();
    const effects=createAudioEffects({sources:()=>[source],fingerprintSource:vocalSourceFingerprint,process,
      prepare:async(s,result)=>result,install,record,...overrides});
    return {source,process,install,record,effects};
  }
  it('相同路徑的母素材換檔後重新運算，內容不變時重用結果',()=>withSource(async file=>{
    const f=setup(file);
    await f.effects.apply(f.source,spec);await f.effects.apply(f.source,null);
    await f.effects.apply(f.source,spec);expect(f.process).toHaveBeenCalledTimes(1);
    await f.effects.apply(f.source,null);fs.writeFileSync(file,'replacement source with different bytes');
    await f.effects.apply(f.source,spec);
    expect(f.process).toHaveBeenCalledTimes(2);
    expect(f.install.mock.lastCall[1].outputPath).toBe('replacement source with different bytes');
  }));
  it('證據暫時不可讀時不重用已有快取',()=>withSource(async file=>{
    let available=true;
    const f=setup(file,{fingerprintSource:async file=>{if(!available)throw new Error('offline');return vocalSourceFingerprint(file);}});
    await f.effects.apply(f.source,spec);await f.effects.apply(f.source,null);available=false;
    await f.effects.apply(f.source,spec);expect(f.process).toHaveBeenCalledTimes(2);
  }));
  it('舊 bridge 不提供來源證據時不重用快取',()=>withSource(async file=>{
    const f=setup(file,{fingerprintSource:undefined});
    await f.effects.apply(f.source,spec);await f.effects.apply(f.source,null);
    await f.effects.apply(f.source,spec);expect(f.process).toHaveBeenCalledTimes(2);
  }));
  it('重用快取的準備期間換檔時不安裝舊內容或寫入歷史',()=>withSource(async file=>{
    const gate=deferred();let hold=false,entered=false;
    const f=setup(file,{prepare:async(s,result)=>{if(hold&&result){entered=true;await gate.promise;}return result;}});
    await f.effects.apply(f.source,spec);await f.effects.apply(f.source,null);f.install.mockClear();f.record.mockClear();hold=true;
    const pending=f.effects.apply(f.source,spec);
    await vi.waitFor(()=>expect(entered).toBe(true));
    fs.writeFileSync(file,'replacement during prepare');gate.resolve();
    expect((await pending).status).not.toBe('completed');
    expect(f.install).not.toHaveBeenCalled();expect(f.record).not.toHaveBeenCalled();
  }));
  it('新產生的批次結果準備期間換檔，也不能安裝或寫入歷史',()=>withSource(async file=>{
    const gate=deferred(),discardResult=vi.fn();let entered=false;
    const f=setup(file,{discardResult,prepare:async(s,result)=>{entered=true;await gate.promise;return result;}});
    const pending=f.effects.apply(f.source,spec);await vi.waitFor(()=>expect(entered).toBe(true));
    fs.writeFileSync(file,'replacement after batch processing');gate.resolve();
    expect((await pending).status).not.toBe('completed');
    expect(f.install).not.toHaveBeenCalled();expect(f.record).not.toHaveBeenCalled();
    expect(discardResult).toHaveBeenCalledTimes(1);
  }));
  it('快取結果未能安裝時不回收其他工作可共用的輸出',()=>withSource(async file=>{
    const gate=deferred(),discardResult=vi.fn();let hold=false,entered=false;
    const f=setup(file,{discardResult,prepare:async(s,result)=>{if(hold&&result){entered=true;await gate.promise;}return result;}});
    await f.effects.apply(f.source,spec);await f.effects.apply(f.source,null);hold=true;
    const pending=f.effects.apply(f.source,spec);await vi.waitFor(()=>expect(entered).toBe(true));
    fs.writeFileSync(file,'replacement while loading cache');gate.resolve();await pending;
    expect(discardResult).not.toHaveBeenCalled();
  }));
  it('取消後遲到的新結果先等回收完成才結束工作',()=>withSource(async file=>{
    const produced=deferred(),cleaned=deferred(),discardResult=vi.fn(()=>cleaned.promise);
    let finished=false;
    const f=setup(file,{process:()=>produced.promise,discardResult});
    const pending=f.effects.apply(f.source,spec).then(result=>{finished=true;return result;});
    f.effects.invalidate({clear:true});produced.resolve({outputPath:'unused.wav',spec});
    await vi.waitFor(()=>expect(discardResult).toHaveBeenCalledTimes(1));
    expect(finished).toBe(false);cleaned.resolve();
    expect(await pending).toEqual({status:'replaced'});expect(f.install).not.toHaveBeenCalled();
  }));
  it('等待快取來源證據期間換檔，不能把舊證據當作目前素材',()=>withSource(async file=>{
    const gate=deferred();let hold=false,entered=false;
    const f=setup(file,{fingerprintSource:async p=>{const evidence=await vocalSourceFingerprint(p);if(hold){entered=true;hold=false;await gate.promise;}return evidence;}});
    await f.effects.apply(f.source,spec);await f.effects.apply(f.source,null);f.install.mockClear();hold=true;
    const pending=f.effects.apply(f.source,spec);await vi.waitFor(()=>expect(entered).toBe(true));
    fs.writeFileSync(file,'replacement while awaiting fingerprint');gate.resolve();
    const result=await pending;
    if(result.status==='completed')expect(f.install.mock.lastCall[1].outputPath).toBe('replacement while awaiting fingerprint');
    else expect(f.install).not.toHaveBeenCalled();
  }));
  it('等待快取指紋時失權不得啟動舊運算',()=>withSource(async file=>{
    const gate=deferred();let hold=false,entered=false;
    const f=setup(file,{fingerprintSource:async p=>{if(hold){entered=true;await gate.promise;}return vocalSourceFingerprint(p);}});
    await f.effects.apply(f.source,spec);await f.effects.apply(f.source,null);f.process.mockClear();hold=true;
    const pending=f.effects.apply(f.source,spec);await vi.waitFor(()=>expect(entered).toBe(true));
    f.effects.invalidate({clear:true});gate.resolve();
    expect(await pending).toEqual({status:'replaced'});expect(f.process).not.toHaveBeenCalled();
  }));
  it('清空工作區並重新取得相同來源身分後，舊指紋失敗不得觸發原生運算',()=>withSource(async file=>{
    const gate=deferred();let hold=false,entered=false;
    const f=setup(file,{fingerprintSource:async p=>{if(hold){entered=true;await gate.promise;throw new Error('offline');}return vocalSourceFingerprint(p);}});
    await f.effects.apply(f.source,spec);await f.effects.apply(f.source,null);f.process.mockClear();f.install.mockClear();hold=true;
    const pending=f.effects.apply(f.source,spec);await vi.waitFor(()=>expect(entered).toBe(true));
    f.effects.invalidate({clear:true});hold=false;
    expect(await f.effects.apply(f.source,spec)).toEqual({status:'completed'});
    gate.resolve();expect(await pending).toEqual({status:'replaced'});
    expect(f.process).toHaveBeenCalledTimes(1);expect(f.install).toHaveBeenCalledTimes(1);
  }));
});
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
  it('佈局變更撤銷舊工作時，abort 同步啟動的較新設定不可被自動重啟覆蓋',async()=>{
    const source=clip('layout'),pending=[];let layout='first',effects,latest;
    const process=vi.fn((s,options,work)=>{
      const d=deferred();pending.push({...d,options});
      if(pending.length===1) work.signal.addEventListener('abort',()=>{latest=effects.apply(source,{...spec,max:-18});},{once:true});
      return d.promise;
    });
    effects=createAudioEffects({sources:()=>[source],sourceLayout:()=>layout,process,prepare:async(s,result)=>result,install:vi.fn()});
    const old=effects.apply(source,spec);layout='second';effects.sync();
    expect(pending).toHaveLength(2);expect(pending[1].options.max).toBe(-18);
    pending[1].resolve({spec:pending[1].options});expect((await latest).status).toBe('completed');
    pending[0].resolve({spec});expect(await old).toEqual({status:'replaced'});
    expect(source.audioLimiterSpec.max).toBe(-18);
  });
  it('進度通知同步失權後不啟動舊音訊運算',async()=>{
    const source=clip('a'),process=vi.fn(async()=>({spec}));let effects;
    effects=createAudioEffects({sources:()=>[source],process,prepare:async()=>null,install:vi.fn(),
      changed:()=>effects.invalidate()});
    expect(await effects.apply(source,spec)).toEqual({status:'replaced'});
    expect(process).not.toHaveBeenCalled();
  });
  it('提交通知同步換專案後不向新專案寫入舊歷史',async()=>{
    const source=clip('a'),live=[source],record=vi.fn();let effects;
    effects=createAudioEffects({sources:()=>live,process:async()=>({spec}),prepare:async()=>({}),install:vi.fn(),record,
      changed:state=>{if(state?.committed){effects.invalidate({clear:true});live.splice(0,1,clip('next'));}}});
    await effects.apply(source,spec);
    expect(record).not.toHaveBeenCalled();
  });
  it('安裝效果同步換專案後不再提交舊來源狀態或歷史',async()=>{
    const source=clip('a'),live=[source],record=vi.fn(),changed=vi.fn();let effects;
    effects=createAudioEffects({sources:()=>live,process:async()=>({spec,outputPath:'C:/cache/old.wav'}),
      prepare:async()=>({}),install:()=>{effects.invalidate({clear:true});live.splice(0,1,clip('next'));},record,changed});
    expect(await effects.apply(source,spec)).toEqual({status:'replaced'});
    expect(source.audioLimiterSpec).toBeUndefined();expect(source.normalizedAudioPath).toBeUndefined();
    expect(record).not.toHaveBeenCalled();expect(changed).not.toHaveBeenCalledWith({committed:true});
  });
  it('取消舊工作同步啟動較新工作時，外層舊呼叫不能取代較新工作',async()=>{
    const source=clip('a'),pending=[],install=vi.fn();let effects,latest;
    const process=vi.fn((s,options,work)=>{
      const d=deferred();pending.push({...d,options,work});
      if(pending.length===1)work.signal.addEventListener('abort',()=>{latest=effects.apply(source,{...spec,max:-18});},{once:true});
      return d.promise;
    });
    effects=createAudioEffects({sources:()=>[source],process,prepare:async(s,result)=>result,install});
    const first=effects.apply(source,spec);
    const middle=effects.apply(source,{...spec,max:-12});
    expect(pending).toHaveLength(2);
    pending[1].resolve({spec:pending[1].options});
    await expect(latest).resolves.toEqual({status:'completed'});
    pending[0].resolve({spec:pending[0].options});
    await expect(first).resolves.toEqual({status:'replaced'});
    await expect(middle).resolves.toEqual({status:'replaced'});
    expect(source.audioLimiterSpec.max).toBe(-18);
  });
  it('相同母素材的不同來源身分不共用效果或 UI 狀態',()=>{
    const f=fixture();f.live[1].path=f.live[0].path;
    expect(f.effects.targets({id:'b',path:f.live[0].path})).toEqual([f.live[1]]);
    expect(f.effects.targets({asset:f.live[1]})).toEqual([f.live[1]]);
  });
  it('失效播放快取會從母素材重建一次',async()=>{
    const source=clip('a');let missing=false;
    const process=vi.fn(async()=>({outputPath:'new.wav',spec,sourceFingerprint:'a'.repeat(64)}));
    const prepare=vi.fn(async(s,result)=>{if(result&&missing){missing=false;throw new Error('cache removed');}return result;});
    const effects=createAudioEffects({sources:()=>[source],process,prepare,install:vi.fn(),fingerprintSource:async()=>'a'.repeat(64)});
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
  it('運算中切分的片段在完成後清除進度',async()=>{
    const f=fixture();const pending=f.effects.apply(f.live[0],spec);
    const split=splitClip(f.live[0]);f.live.push(split);
    f.pending[0].work.progress({pct:61,label:'分析中'});
    expect(split.audioNormalizing).toBe(true);
    f.complete(0);expect(await pending).toEqual({status:'completed'});
    for(const source of [f.live[0],split]){
      expect(source.audioLimiterSpec.max).toBe(-6);
      expect(source.audioNormalizing).toBeUndefined();
      expect(source.audioNormalizeProgress).toBeUndefined();
      expect(source.audioNormalizeLabel).toBeUndefined();
    }
    expect(f.record).toHaveBeenCalledTimes(1);
  });
  it('失效舊工作時 abort listener 啟動的另一來源新工作不可被舊清理取消',async()=>{
    const a=clip('a'),b=clip('b'),pending=[];let effects,latest;
    const process=vi.fn((source,options,work)=>{
      const d=deferred();pending.push({...d,source,options,work});
      if(source===a)work.signal.addEventListener('abort',()=>{latest=effects.apply(b,{...spec,max:-18});},{once:true});
      return d.promise;
    });
    effects=createAudioEffects({sources:()=>[a,b],process,prepare:async(s,result)=>result,install:vi.fn()});
    const oldA=effects.apply(a,spec),oldB=effects.apply(b,spec);
    effects.invalidate();
    expect(pending).toHaveLength(3);expect(pending[2].work.signal.aborted).toBe(false);
    pending[2].resolve({spec:pending[2].options});await expect(latest).resolves.toEqual({status:'completed'});
    pending[0].resolve({spec});pending[1].resolve({spec});await Promise.all([oldA,oldB]);
    expect(b.audioLimiterSpec.max).toBe(-18);
  });
  it('清除專案快取時 abort listener 的新工作不能重用舊工作區結果',async()=>{
    const a=clip('a'),oldB=clip('b'),live=[a,oldB],pendingA=deferred(),install=vi.fn();
    let effects,latest,bCalls=0;
    const process=vi.fn((source,options,work)=>{
      if(source===a){
        work.signal.addEventListener('abort',()=>{const newB=clip('b');live[1]=newB;latest=effects.apply(newB,spec);},{once:true});
        return pendingA.promise;
      }
      bCalls++;return Promise.resolve({spec:options,outputPath:`C:/cache/fresh-${bCalls}.wav`});
    });
    effects=createAudioEffects({sources:()=>live,process,prepare:async(s,result)=>result,install});
    await effects.apply(oldB,spec);
    const old=effects.apply(a,spec);
    effects.invalidate({clear:true});
    await expect(latest).resolves.toEqual({status:'completed'});
    expect(bCalls).toBe(2);
    expect(live[1].normalizedAudioPath).toBe('C:/cache/fresh-2.wav');
    pendingA.resolve({spec});await expect(old).resolves.toEqual({status:'replaced'});
  });
  it('同步重建時取消已移除來源，不能將舊快照套到同 id 的新來源',async()=>{
    const a=clip('a'),oldB={...clip('b'),audioLimiterSpec:spec,hasAudioLimiter:true},live=[a,oldB];
    const pendingA=deferred(),process=vi.fn((source,options,work)=>{
      if(source===a){
        work.signal.addEventListener('abort',()=>{
          live.splice(0,live.length,{...clip('b'),audioLimiterSpec:{...spec,max:-18},hasAudioLimiter:true});
        },{once:true});
        return pendingA.promise;
      }
      return Promise.resolve({spec:options,outputPath:'C:/cache/obsolete.wav'});
    });
    const effects=createAudioEffects({sources:()=>live,process,prepare:async(s,result)=>result,install:vi.fn(),isInstalled:()=>false});
    const old=effects.apply(a,spec);live.shift();effects.sync();
    await Promise.resolve();await Promise.resolve();
    expect(process).toHaveBeenCalledTimes(1);
    expect(live[0].audioLimiterSpec.max).toBe(-18);
    pendingA.resolve({spec});await expect(old).resolves.toEqual({status:'replaced'});
  });
  it('取消清除動態切片與已移除片段的進度，保留另一來源的進行中工作',async()=>{
    const f=fixture(),original=f.live[0];
    const first=f.effects.apply(original,spec),other=f.effects.apply(f.live[1],spec);
    const split=splitClip(original);f.live.push(split);
    f.pending[0].work.progress({pct:61});f.live.splice(f.live.indexOf(split),1);
    await f.effects.apply(original,null);
    expect(original.audioNormalizing).toBeUndefined();expect(split.audioNormalizing).toBeUndefined();
    expect(f.live[1].audioNormalizing).toBe(true);
    f.complete(0);f.complete(1);await Promise.all([first,other]);
    expect(f.live[1].audioNormalizing).toBeUndefined();
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
  it.each(['相同身分的新物件','同物件換路徑'])('同步時 %s 會立即取消舊效果並准許新來源重建',async change=>{
    const f=fixture(),oldSource=f.live[0],old=f.effects.apply(oldSource,spec);
    if(change==='相同身分的新物件') f.live[0]={...clip('a'),hasAudioLimiter:true,audioLimiterSpec:spec};
    else {oldSource.path='C:/relinked.mp4';oldSource.hasAudioLimiter=true;oldSource.audioLimiterSpec=spec;}
    f.effects.sync();
    expect(f.pending[0].work.signal.aborted).toBe(true);
    expect(f.pending).toHaveLength(2);
    f.complete(1);await new Promise(resolve=>setTimeout(resolve,0));
    f.complete(0);await expect(old).resolves.toEqual({status:'replaced'});
    expect(f.install).toHaveBeenCalledTimes(1);
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
