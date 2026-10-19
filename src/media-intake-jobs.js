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
  const snapshot=()=>({sessionId:session.id,count:pending.size,hasProxy:[...pending.values()].some(job=>job.proxy)});
  const publish=()=>changed(snapshot());
  const finish=job=>{if(pending.get(job.requestId)===job){pending.delete(job.requestId);publish();}};
  function run(method,options,owner=session){
    if(owner!==session) return Promise.reject(cancelled());
    const requestId=id();
    let abort;
    const aborted=new Promise((_,reject)=>{abort=()=>reject(cancelled());});
    const job={owner,requestId,proxy:method==='streamIngest'||!!options.needsProxy,abort,terminal:false};
    owner.used=true;pending.set(requestId,job);publish();
    let native;
    try{native=bridge[method]({...options,sessionId:owner.id,requestId});}
    catch(error){native=Promise.reject(error);}
    return Promise.race([Promise.resolve(native),aborted]).then(result=>{
      if(owner!==session) throw cancelled();
      if(method!=='streamIngest'||result?.cached||job.terminal) finish(job);
      return result;
    },error=>{finish(job);throw error;});
  }
  return {
    ingest:options=>run('ingest',options),
    streamIngest:options=>run('streamIngest',options),
    capture(){
      const owner=session;
      return {ingest:options=>run('ingest',options,owner)};
    },
    snapshot,
    progress(payload){
      if(!payload||payload.sessionId!==session.id) return false;
      const job=pending.get(payload.requestId);
      if(!job||job.owner!==session) return false;
      if(payload.done){job.terminal=true;finish(job);}
      return true;
    },
    reset(){
      const previous=session;session={id:id(),used:false};
      for(const job of pending.values()) job.abort();
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
