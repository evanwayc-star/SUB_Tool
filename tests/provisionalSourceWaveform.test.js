import { describe, expect, it, vi } from 'vitest';
import { createProvisionalSourceWaveform } from '../src/provisional-source-waveform.js';

const key='a'.repeat(16);
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function fixture(){
  const jobs={prepareWaveform:fn=>fn({owns:()=>true,report:()=>true}),prepareSourceWaveform:vi.fn(async()=>({wave:'wave',sourceKey:key,start:0,duration:1,temporary:true}))};
  const bridge={fileURL:vi.fn(async()=> 'url'),cleanupAudio:vi.fn(async()=>{}),mediaSourceKey:vi.fn(async()=>key)};
  const changed=vi.fn(),decode=vi.fn(()=>Float32Array.from([-.5,.5]));
  const owner=createProvisionalSourceWaveform({jobs,bridge,decode,read:async()=>new ArrayBuffer(1),changed,resolution:1});
  return {jobs,bridge,changed,decode,owner};
}
describe('獨立來源波形交接',()=>{
  it('保存失敗保留原因供可重試提示，不能偽裝成單純取消',async()=>{
    const f=fixture(),failure=new Error('ENOSPC: 磁碟空間不足');
    f.jobs.prepareSourceWaveform.mockRejectedValueOnce(failure);
    const entry=f.owner.begin({path:'A',name:'A',audio:[{channels:1}],duration:1,owns:()=>true});
    await entry.finished;
    expect(entry.error).toBe(failure);expect(entry.complete).toBe(false);
  });
  it('連續工作只啟動一次，完成前已顯示保存的峰值，完成後不重讀 WAV',async()=>{
    const f=fixture(),gate=deferred();let send;
    f.bridge.sourceWaveformContinuous=true;
    f.jobs.prepareSourceWaveform.mockImplementation((request,onWaveform)=>{send=onWaveform;return gate.promise;});
    const entry=f.owner.begin({path:'A',name:'A',audio:[{channels:1}],duration:2,owns:()=>true});
    await vi.waitFor(()=>expect(send).toBeTypeOf('function'));
    const event={sourceKey:key,startSample:0,completedSamples:4000,totalSamples:8000,sampleRate:4000,resolution:1,peaks:new Float32Array([-.25,.5])};
    send(event);expect(f.owner.snapshot().peaks).toEqual(event.peaks);
    expect(f.jobs.prepareSourceWaveform).toHaveBeenCalledWith({path:'A',audio:[{channels:1}],duration:2,continuous:true},expect.any(Function));
    send({...event,startSample:4000,completedSamples:8000});
    gate.resolve({wave:'shared/wave.wav',sourceKey:key,start:0,duration:2,complete:true,temporary:false});
    await entry.finished;expect(f.jobs.prepareSourceWaveform).toHaveBeenCalledOnce();
    expect(f.owner.snapshot().peaks).toHaveLength(4);expect(f.decode).not.toHaveBeenCalled();
    expect(f.bridge.cleanupAudio).not.toHaveBeenCalled();entry.cancel();
  });
  it('連續工作取消後的進度不能重新顯示，完成來源不一致時撤回已顯示波形',async()=>{
    const f=fixture(),gate=deferred();let send;f.bridge.sourceWaveformContinuous=true;
    f.jobs.prepareSourceWaveform.mockImplementation((_request,onWaveform)=>{send=onWaveform;return gate.promise;});
    const entry=f.owner.begin({path:'A',name:'A',audio:[{channels:1}],duration:2,owns:()=>true});
    await vi.waitFor(()=>expect(send).toBeTypeOf('function'));
    send({sourceKey:key,startSample:0,completedSamples:4000,totalSamples:8000,sampleRate:4000,resolution:1,peaks:new Float32Array([-.25,.5])});
    expect(f.owner.snapshot()).not.toBeNull();
    gate.resolve({wave:'other.wav',sourceKey:'b'.repeat(16),start:0,duration:2,complete:true});
    await entry.finished;expect(f.owner.snapshot()).toBeNull();
    send({sourceKey:key,startSample:4000,completedSamples:8000,totalSamples:8000,sampleRate:4000,resolution:1,peaks:new Float32Array([-.25,.5])});
    expect(f.owner.snapshot()).toBeNull();
  });
  it('母素材波形可在串流未完成時讀取，交接時重核同一來源證據',async()=>{
    const f=fixture(),entry=f.owner.begin({path:'A',name:'A',audio:[{channels:1}],duration:1,owns:()=>true});
    await entry.finished;
    expect(f.owner.snapshot().peaks).toEqual(Float32Array.from([-.5,.5]));
    const transfer=vi.fn();expect(await entry.handoff(key,transfer)).toBe(true);
    expect(transfer).toHaveBeenCalledOnce();expect(f.bridge.cleanupAudio).toHaveBeenCalledWith('wave');
    expect(f.owner.snapshot()).toBeNull();
  });
  it('交接查驗期間失權或來源變更時不發布舊波形',async()=>{
    const f=fixture(),gate=deferred();let current=true;
    const entry=f.owner.begin({path:'A',name:'A',audio:[{channels:1}],duration:1,owns:()=>current});await entry.finished;
    f.bridge.mediaSourceKey.mockReturnValueOnce(gate.promise);const transfer=vi.fn(),work=entry.handoff(key,transfer);
    current=false;gate.resolve(key);expect(await work).toBe(false);expect(transfer).not.toHaveBeenCalled();
    expect(f.owner.snapshot()).toBeNull();
  });
  it('不同 sourceKey 不能交接，並撤回暫時顯示',async()=>{
    const f=fixture(),entry=f.owner.begin({path:'A',name:'A',audio:[{channels:1}],duration:1,owns:()=>true});await entry.finished;
    const transfer=vi.fn();expect(await entry.handoff('b'.repeat(16),transfer)).toBe(false);
    expect(transfer).not.toHaveBeenCalled();expect(f.owner.snapshot()).toBeNull();
  });
  it('取消後才回來的私有 WAV 仍清理，但不能遮掉新工作的波形',async()=>{
    const f=fixture(),gate=deferred();
    f.jobs.prepareSourceWaveform.mockReturnValueOnce(gate.promise);
    const old=f.owner.begin({path:'A',name:'A',audio:[{channels:1}],duration:1,owns:()=>true});
    await vi.waitFor(()=>expect(f.jobs.prepareSourceWaveform).toHaveBeenCalledOnce());
    const next=f.owner.begin({path:'B',name:'B',audio:[{channels:1}],duration:1,owns:()=>true});await next.finished;
    gate.resolve({wave:'old-wave',sourceKey:key,start:0,duration:1,temporary:true});await old.finished;
    expect(f.bridge.cleanupAudio).toHaveBeenCalledWith('old-wave');expect(f.owner.snapshot().name).toBe('B');
    next.cancel();
  });
  it('解碼讓出期間新來源接手，舊解碼晚到只清理自己的 WAV',async()=>{
    const f=fixture(),gate=deferred();
    f.jobs.prepareSourceWaveform.mockResolvedValueOnce({wave:'old-wave',sourceKey:key,start:0,duration:1,temporary:true});
    f.decode.mockReturnValueOnce(gate.promise);
    const old=f.owner.begin({path:'A',name:'A',audio:[{channels:1}],duration:1,owns:()=>true});
    await vi.waitFor(()=>expect(f.decode).toHaveBeenCalledOnce());
    const oldOwns=f.decode.mock.calls[0][2].owns;
    const next=f.owner.begin({path:'B',name:'B',audio:[{channels:1}],duration:1,owns:()=>true});
    await next.finished;expect(oldOwns()).toBe(false);
    gate.resolve(Float32Array.from([-.9,.9]));await old.finished;
    expect(f.owner.snapshot()).toMatchObject({name:'B',peaks:Float32Array.from([-.5,.5])});
    expect(f.bridge.cleanupAudio.mock.calls.filter(([path])=>path==='old-wave')).toHaveLength(1);
    expect(f.jobs.prepareSourceWaveform).toHaveBeenCalledTimes(2);
    next.cancel();
  });
  it('交接等待首段期間取消，無須等待 native 完成即可撤銷交接並在晚到後清理',async()=>{
    const f=fixture(),gate=deferred();
    f.jobs.prepareSourceWaveform.mockReturnValueOnce(gate.promise);
    const entry=f.owner.begin({path:'A',name:'A',audio:[{channels:1}],duration:1,owns:()=>true});
    await vi.waitFor(()=>expect(f.jobs.prepareSourceWaveform).toHaveBeenCalledOnce());
    const transfer=vi.fn(),handoff=entry.handoff(key,transfer);
    entry.cancel();expect(await handoff).toBe(false);expect(transfer).not.toHaveBeenCalled();
    gate.resolve({wave:'late',sourceKey:key,start:0,duration:1,temporary:true});await entry.finished;
    expect(f.bridge.cleanupAudio).toHaveBeenCalledWith('late');
  });
  it('來源工作未啟動就結束時，等待首段的交接會解除',async()=>{
    const f=fixture();f.jobs.prepareWaveform=vi.fn(async()=>undefined);
    const entry=f.owner.begin({path:'A',name:'A',audio:[{channels:1}],duration:1,owns:()=>true});
    const transfer=vi.fn(),handoff=entry.handoff(key,transfer);
    await entry.finished;expect(await handoff).toBe(false);expect(transfer).not.toHaveBeenCalled();
  });
  it('交接清除通知同步啟動新來源時，舊波形不再移交',async()=>{
    const f=fixture(),transfer=vi.fn();let next,trigger=false;
    const owner=createProvisionalSourceWaveform({jobs:f.jobs,bridge:f.bridge,decode:()=>Float32Array.from([-.5,.5]),
      read:async()=>new ArrayBuffer(1),resolution:1,changed:()=>{
        if(trigger){trigger=false;next=owner.begin({path:'B',name:'B',audio:[{channels:1}],duration:1,owns:()=>true});}
      }});
    const old=owner.begin({path:'A',name:'A',audio:[{channels:1}],duration:1,owns:()=>true});await old.finished;
    trigger=true;expect(await old.handoff(key,transfer)).toBe(false);expect(transfer).not.toHaveBeenCalled();
    await next.finished;expect(owner.snapshot().name).toBe('B');next.cancel();
  });
  it('完成交接、取消、錯誤和失權都釋放 owner 的 timer',async()=>{
    vi.useFakeTimers();
    try{
      for(const outcome of ['handoff','cancel','error','stale']){
        const f=fixture();let current=true;
        if(outcome==='error')f.jobs.prepareSourceWaveform.mockRejectedValueOnce(new Error('decode failed'));
        const entry=f.owner.begin({path:'A',name:'A',audio:[{channels:1}],duration:1,owns:()=>current});
        await entry.finished;
        if(outcome==='handoff')await entry.handoff(key,()=>{});
        if(outcome==='cancel')entry.cancel();
        if(outcome==='stale'){current=false;vi.advanceTimersByTime(100);}
        expect(vi.getTimerCount()).toBe(0);
      }
    }finally{vi.useRealTimers();}
  });
});
