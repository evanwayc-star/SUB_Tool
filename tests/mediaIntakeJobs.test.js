import { describe, expect, it, vi } from 'vitest';
import { createMediaIntakeJobs } from '../src/media-intake-jobs.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function setup(){
  const pending=[],changed=vi.fn();let serial=0;
  const bridge={
    ingest:vi.fn(()=>{const job=deferred();pending.push(job);return job.promise;}),
    streamIngest:vi.fn(()=>{const job=deferred();pending.push(job);return job.promise;}),
    prepareSourceWaveform:vi.fn(()=>{const job=deferred();pending.push(job);return job.promise;}),
    cleanupAudio:vi.fn(async()=>{}),
    cancelMediaIntake:vi.fn(async()=>1),
  };
  return {bridge,pending,changed,jobs:createMediaIntakeJobs({bridge,changed,id:()=>`id-${++serial}`})};
}

describe('renderer media intake ownership',()=>{
  it('cancels the old project and admits a fresh job before native cleanup finishes',async()=>{
    const {jobs,bridge,pending}=setup(), barrier=deferred();
    bridge.cancelMediaIntake.mockReturnValue(barrier.promise);
    const old=jobs.ingest({path:'old.mxf',needsProxy:true,queue:true});
    const oldOptions=bridge.ingest.mock.calls[0][0];
    const rejected=expect(old).rejects.toMatchObject({name:'AbortError'});
    const cancel=jobs.reset();
    const next=jobs.ingest({path:'new.mxf',needsProxy:true,queue:true});
    const nextOptions=bridge.ingest.mock.calls[1][0];
    expect(nextOptions.sessionId).not.toBe(oldOptions.sessionId);
    expect(nextOptions.requestId).not.toBe(oldOptions.requestId);
    expect(bridge.cancelMediaIntake).toHaveBeenCalledWith({sessionId:oldOptions.sessionId});
    await rejected;
    pending[0].resolve({proxy:'old.mp4'});
    pending[1].resolve({proxy:'new.mp4'});
    await expect(next).resolves.toEqual({proxy:'new.mp4'});
    barrier.resolve();await cancel;
  });

  it('ignores late progress and completion from cancelled work without hiding a newer job',async()=>{
    const {jobs,bridge,pending}=setup();
    const old=jobs.ingest({path:'old',needsProxy:true});
    const rejected=expect(old).rejects.toMatchObject({name:'AbortError'});
    const oldOptions=bridge.ingest.mock.calls[0][0];
    await jobs.reset();await rejected;
    const next=jobs.ingest({path:'new',needsProxy:true});
    const nextOptions=bridge.ingest.mock.calls[1][0];
    expect(jobs.progress({...oldOptions,jobId:'ingest-old',done:true,outcome:'success'})).toBe(false);
    expect(jobs.snapshot().count).toBe(1);
    expect(jobs.progress({...nextOptions,jobId:'ingest-new',pct:35})).toBe(true);
    expect(jobs.progress({jobId:'export-1',pct:35})).toBe(false);
    pending[1].resolve({});await next;
    pending[0].reject(new Error('old process stopped'));
    expect(jobs.snapshot().count).toBe(0);
  });

  it('keeps a returned streaming proxy cancellable until its actual terminal event',async()=>{
    const {jobs,bridge,pending}=setup();
    const load=jobs.streamIngest({path:'stream.mxf'});
    const options=bridge.streamIngest.mock.calls[0][0];
    pending[0].resolve({streamUrl:'http://local/video',ingestJobId:'stream-1',cached:false});
    await load;
    expect(jobs.snapshot()).toMatchObject({count:1,hasProxy:true});
    expect(jobs.progress({...options,jobId:'stream-1',pct:75})).toBe(true);
    expect(jobs.progress({...options,jobId:'stream-1',done:true,outcome:'success'})).toBe(true);
    expect(jobs.snapshot().count).toBe(0);
  });

  it('handles a stream completion that arrives before its IPC reply and cache hits with no progress',async()=>{
    const {jobs,bridge,pending}=setup();
    const early=jobs.streamIngest({path:'early'}), options=bridge.streamIngest.mock.calls[0][0];
    expect(jobs.progress({...options,done:true,outcome:'success'})).toBe(true);
    pending[0].resolve({cached:false,streamUrl:'url'});await early;
    expect(jobs.snapshot().count).toBe(0);
    const cached=jobs.streamIngest({path:'cached'});
    pending[1].resolve({cached:true,streamUrl:'url'});await cached;
    expect(jobs.snapshot().count).toBe(0);
  });

  it('does not cancel unrelated native work when there were no requests in this session',async()=>{
    const {jobs,bridge}=setup();
    await jobs.reset();expect(bridge.cancelMediaIntake).not.toHaveBeenCalled();
  });
  it('rejects a request prepared by a previous project even if its probe finished after reset',async()=>{
    const {jobs,bridge}=setup();
    const previous=jobs.capture();await jobs.reset();
    await expect(previous.ingest({path:'old'})).rejects.toMatchObject({name:'AbortError'});
    expect(bridge.ingest).not.toHaveBeenCalled();
  });

  it('本機波形進度沿用session，取消後拒絕晚到結果且不發原生取消',async()=>{
    const {jobs,bridge,changed}=setup(),done=deferred();let control;
    const wave=jobs.prepareWaveform(value=>{control=value;return done.promise;});
    expect(control.owns()).toBe(true);
    expect(control.report({label:'讀取波形',pct:40})).toBe(true);
    expect(jobs.snapshot()).toMatchObject({count:1,hasProxy:false,jobs:[{local:true,progress:{stage:'waveform',label:'讀取波形',pct:40}}]});
    const rejected=expect(wave).rejects.toMatchObject({name:'AbortError'});
    await jobs.reset();await rejected;
    expect(bridge.cancelMediaIntake).not.toHaveBeenCalled();
    expect(control.owns()).toBe(false);
    const calls=changed.mock.calls.length;
    expect(control.report({label:'過期',pct:100})).toBe(false);
    done.resolve({old:true});await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(calls);
    expect(jobs.snapshot().count).toBe(0);
  });

  it('波形讀取失敗會釋放工作，保留失敗結果給caller',async()=>{
    const {jobs}=setup();
    await expect(jobs.prepareWaveform(()=>Promise.reject(new Error('波形讀取失敗')))).rejects.toThrow('波形讀取失敗');
    expect(jobs.snapshot().count).toBe(0);
  });

  it('原生優先波形使用相同session取消，開始前標記排隊並在成功後釋放',async()=>{
    const {jobs,bridge,pending}=setup();
    const wave=jobs.prepareSourceWaveform({path:'mother.mxf',duration:10,audio:[{index:1}],needsProxy:true});
    const options=bridge.prepareSourceWaveform.mock.calls[0][0];
    expect(options).toMatchObject({path:'mother.mxf',sessionId:jobs.snapshot().sessionId});
    expect(jobs.snapshot()).toMatchObject({count:1,hasProxy:false,jobs:[{local:false,progress:{stage:'source-waveform',queued:true}}]});
    expect(jobs.progress({...options,stage:'source-waveform',label:'優先產生波形',queued:false,pct:35})).toBe(true);
    expect(jobs.snapshot().jobs[0].progress).toMatchObject({queued:false,pct:35});
    pending[0].resolve({wave:'wave.wav',temporary:true});
    await expect(wave).resolves.toEqual({wave:'wave.wav',temporary:true});
    expect(jobs.snapshot().count).toBe(0);
    expect(bridge.cleanupAudio).not.toHaveBeenCalled();
  });

  it.each([true,false])('取消後晚到原生波形temporary=%s僅清理本次暫存，不刪快取',async temporary=>{
    const {jobs,bridge,pending}=setup();
    const wave=jobs.prepareSourceWaveform({path:'old.mxf'});
    const options=bridge.prepareSourceWaveform.mock.calls[0][0];
    const rejected=expect(wave).rejects.toMatchObject({name:'AbortError'});
    await jobs.reset();await rejected;
    expect(bridge.cancelMediaIntake).toHaveBeenCalledWith({sessionId:options.sessionId});
    pending[0].resolve({wave:'old.wav',temporary});
    await Promise.resolve();await Promise.resolve();await Promise.resolve();
    expect(bridge.cleanupAudio.mock.calls).toEqual(temporary?[['old.wav']]:[]);
    expect(jobs.progress({...options,pct:100})).toBe(false);
    expect(jobs.snapshot().count).toBe(0);
  });

  it('原生波形resolve與caller交接之間取消，仍只清理一次暫存',async()=>{
    const {jobs,bridge,pending}=setup();
    const wave=jobs.prepareSourceWaveform({path:'old.mxf'});
    const rejected=expect(wave).rejects.toMatchObject({name:'AbortError'});
    pending[0].resolve({wave:'handoff.wav',temporary:true});
    await Promise.resolve();await jobs.reset();await rejected;
    expect(bridge.cleanupAudio).toHaveBeenCalledExactlyOnceWith('handoff.wav');
  });
});
