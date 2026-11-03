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
  const recoveries=new Map();
  // 終態事件可能早於 IPC 回覆：畫面可移除已完成工作，交接仍由 session 持有。
  const awaitingReply=new Set();
  const snapshot=()=>({sessionId:session.id,count:pending.size,hasProxy:[...pending.values()].some(job=>job.proxy),
    jobs:[...pending.values()].map(job=>({requestId:job.requestId,path:job.path,proxy:job.proxy,local:job.local,
      progress:job.progress?{...job.progress}:null})),
    recoveries:[...recoveries.values()].filter(entry=>entry.owns()&&entry.status!=='working').map(entry=>({
      id:entry.id,path:entry.path,status:entry.status,message:entry.message,saved:entry.saved||null,
    }))});
  const publish=()=>changed(snapshot());
  const finish=job=>{if(pending.get(job.requestId)===job){pending.delete(job.requestId);publish();}};
  function run(method,options,owner=session,action=null,onWaveform=null){
    if(owner!==session) return Promise.reject(cancelled());
    const requestId=id();
    let abort;
    const aborted=new Promise((_,reject)=>{abort=()=>reject(cancelled());});
    const local=method==='prepareWaveform',sourceWave=method==='prepareSourceWaveform';
    const job={owner,requestId,path:options.path||null,recoveryId:recoveries.get(options.path)?.id,proxy:!sourceWave&&(method==='streamIngest'||!!options.needsProxy),local,abort,terminal:false,onWaveform,
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
    prepareWaveform:(action,options={})=>run('prepareWaveform',options,session,action),
    registerRecovery({path,owns,retry}){
      const entry={id:id(),path,owns,retry,status:'working',message:''};
      recoveries.set(path,entry);
      const current=()=>recoveries.get(path)===entry&&owns();
      return {
        fail(error){if(current()){entry.status='failed';entry.message=error?.message||String(error);publish();}},
        complete(){if(current()){recoveries.delete(path);publish();}},
      };
    },
    hasRecovery(path){return !!recoveries.get(path)?.owns();},
    async refreshRecoveryInfo(){
      if(typeof bridge?.cacheInfo!=='function')return;
      const owner=session;
      await Promise.all([...recoveries.values()].map(async entry=>{
        if(!entry.owns()||entry.status==='working')return;
        try{
          const info=await bridge.cacheInfo(entry.path);
          if(owner===session&&recoveries.get(entry.path)===entry&&entry.owns()&&entry.status!=='working'
            &&info?.source?.path===entry.path){entry.saved=info.source;publish();}
        }catch(_){/* No evidence is safer than inferring a saved prefix from displayed peaks. */}
      }));
    },
    failRecovery(path,error){
      const entry=recoveries.get(path);
      if(entry?.owns()){entry.status='failed';entry.message=error?.message||String(error);publish();}
    },
    async retry(recoveryId){
      const entry=[...recoveries.values()].find(value=>value.id===recoveryId);
      if(!entry||!entry.owns()||entry.status==='working')return false;
      const owner=session;
      const owns=()=>owner===session&&recoveries.get(entry.path)===entry&&entry.owns();
      entry.status='working';publish();
      try{if(!owns())return false;await entry.retry(owns);if(owns()&&entry.status==='working'){recoveries.delete(entry.path);publish();}return entry.status!=='failed';}
      catch(error){if(owns()){entry.status='failed';entry.message=error?.message||String(error);publish();}return false;}
    },
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
      if(payload.done){
        const recovery=recoveries.get(job.path);
        if(payload.outcome==='failed'&&recovery&&recovery.id===job.recoveryId&&recovery.owns()){
          recovery.status='failed';recovery.message=payload.errorMsg||`${payload.label||'背景處理'}失敗`;
        }
        job.terminal=true;finish(job);
      }
      else {job.progress=status;publish();}
      return job.owner===session;
    },
    reset({retainRecovery=false}={}){
      const previous=session;session={id:id(),used:false};
      if(retainRecovery){for(const entry of recoveries.values())if(entry.owns()){
        entry.status='stopped';entry.message='背景處理已停止；已保存的快取會在繼續時重新驗證。';
      }}else recoveries.clear();
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
