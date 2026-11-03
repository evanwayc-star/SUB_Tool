/* Desktop intake lifetime: one project session, many queued native requests.
   Cancellation revokes renderer results immediately; native cleanup owns the
   writer barrier, so a fresh project never waits for the old encode to finish. */
import { DESK } from './state.js';
import { emit } from './events.js';

function cancelled(){
  const error=new Error('媒體處理已取消');error.name='AbortError';return error;
}

export function createMediaIntakeJobs({bridge,changed=()=>{},id=()=>globalThis.crypto.randomUUID()}){
  let session={id:id(),used:false};
  const pending=new Map();
  // 終態事件可能早於 IPC 回覆：畫面可移除已完成工作，交接仍由 session 持有。
  const awaitingReply=new Set();
  const snapshot=()=>({sessionId:session.id,count:pending.size,hasProxy:[...pending.values()].some(job=>job.proxy),
    jobs:[...pending.values()].map(job=>({requestId:job.requestId,proxy:job.proxy,local:job.local,
      progress:job.progress?{...job.progress}:null}))});
  const publish=()=>changed(snapshot());
  const finish=job=>{if(pending.get(job.requestId)===job){pending.delete(job.requestId);publish();}};
  function run(method,options,owner=session,action=null,onWaveform=null){
    if(owner!==session) return Promise.reject(cancelled());
    const requestId=id();
    let abort;
    const aborted=new Promise((_,reject)=>{abort=()=>reject(cancelled());});
    const local=method==='prepareWaveform',sourceWave=method==='prepareSourceWaveform';
    const job={owner,requestId,proxy:!sourceWave&&(method==='streamIngest'||!!options.needsProxy),local,abort,terminal:false,onWaveform,
      progress:local?{stage:'waveform',label:'準備波形',pct:null}:sourceWave?{stage:'source-waveform',label:'等候優先產生波形',pct:null,queued:true}:null};
    if(!local) owner.used=true;
    pending.set(requestId,job);awaitingReply.add(job);publish();
    // A synchronous observer may already have replaced the session in publish().
    if(owner!==session){awaitingReply.delete(job);return aborted;}
    let native;
    try{native=local?action({
      owns:()=>owner===session&&pending.get(requestId)===job,
      report(data){
        if(owner!==session||pending.get(requestId)!==job) return false;
        job.progress={stage:'waveform',label:data?.label||'準備波形',pct:data?.pct,
          overall:!!data?.overall,queued:!!data?.queued};publish();
        return owner===session&&pending.get(requestId)===job;
      },
    }):bridge[method]({...options,sessionId:owner.id,requestId});}
    catch(error){native=Promise.reject(error);}
    let delivered,discarded=false;
    const discard=result=>{
      if(!sourceWave||discarded||!result?.temporary||!result.wave) return;
      discarded=true;
      Promise.resolve().then(()=>bridge.cleanupAudio(result.wave)).catch(error=>console.warn('過期暫存波形清理失敗:',error));
    };
    // 取消先回應 caller；原生結果晚到或在 Promise 交接間失權，仍需清掉本次私有波形。
    const resultPromise=Promise.resolve(native).then(result=>{
      delivered=result;if(owner!==session) discard(result);return result;
    });
    return Promise.race([resultPromise,aborted]).then(result=>{
      awaitingReply.delete(job);
      if(owner!==session){discard(result);throw cancelled();}
      if(method!=='streamIngest'||result?.cached||job.terminal) finish(job);
      // finish() synchronously notifies observers; they can replace the
      // workspace before this result is handed over to its original caller.
      if(owner!==session){discard(result);throw cancelled();}
      if(job.progressError){discard(result);throw job.progressError;}
      return result;
    },error=>{awaitingReply.delete(job);if(owner!==session) discard(delivered);finish(job);throw error;});
  }
  return {
    ingest:options=>run('ingest',options),
    streamIngest:options=>run('streamIngest',options),
    prepareSourceWaveform:(options,onWaveform)=>run('prepareSourceWaveform',options,session,null,onWaveform),
    prepareWaveform:action=>run('prepareWaveform',{},session,action),
    capture(){
      const owner=session;
      return {ingest:options=>run('ingest',options,owner)};
    },
    snapshot,
    progress(payload){
      if(!payload||payload.sessionId!==session.id) return false;
      const job=pending.get(payload.requestId);
      if(!job||job.owner!==session) return false;
      // Peak batches belong to this request; do not retain them in status snapshots.
      const {waveform,...status}=payload;
      if(waveform&&!job.progressError&&typeof job.onWaveform==='function'){
        try{job.onWaveform(waveform);}catch(error){job.progressError=error;}
      }
      if(job.owner!==session||pending.get(payload.requestId)!==job) return false;
      if(payload.done){job.terminal=true;finish(job);}
      else {job.progress=status;publish();}
      return job.owner===session;
    },
    reset(){
      const previous=session;session={id:id(),used:false};
      for(const job of new Set([...pending.values(),...awaitingReply])) job.abort();
      pending.clear();publish();
      if(!previous.used||!bridge?.cancelMediaIntake) return Promise.resolve();
      try{return Promise.resolve(bridge.cancelMediaIntake({sessionId:previous.id}));}
      catch(error){return Promise.reject(error);}
    },
  };
}

export const MediaIntakeJobs=createMediaIntakeJobs({bridge:DESK,
  changed:state=>emit('media:intakeJobs',state),
});
