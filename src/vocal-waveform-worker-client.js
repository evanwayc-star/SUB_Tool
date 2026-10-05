import VocalWorker from './vocal-waveform-worker.js?worker&inline';
import { VOCAL_SAMPLE_RATE, VOCAL_RESOLUTION } from './vocal-waveform-engine.js';

export function vocalAbortError(){return new DOMException('人聲波形分析已取消','AbortError');}

/** Keep the model warm after success; cancellation terminates inference itself. */
export class VocalWaveformClient{
  constructor({createWorker=()=>new VocalWorker({name:'subtool-vocal-waveform'}),timeoutMs=600000}={}){
    this.createWorker=createWorker;this.timeoutMs=timeoutMs;this.worker=null;this.pending=null;this.active=false;this.nextId=1;
  }
  terminate(){this.worker?.terminate();this.worker=null;}
  chunk(channels,{signal,onProgress,offsetSamples,lengthSamples}){
    if(signal?.aborted)return Promise.reject(vocalAbortError());
    if(this.pending)return Promise.reject(new Error('已有一項人聲分離工作正在執行'));
    if(!this.worker){
      const worker=this.createWorker();this.worker=worker;
      worker.addEventListener('message',event=>{
        const job=this.pending,message=event.data||{};
        if(worker!==this.worker||!job||job.id!==message.jobId)return;
        if(message.type==='progress'){job.onProgress?.(message.progress);return;}
        if(message.type==='result')job.finish(null,message.peaks);
        if(message.type==='error')job.finish(new Error(message.error?.message||'人聲分離失敗'));
      });
      const failed=event=>{if(this.worker===worker&&this.pending)this.pending.finish(new Error(event.message||'人聲分析 Worker 中斷'));};
      worker.addEventListener('error',failed);worker.addEventListener('messageerror',failed);
    }
    return new Promise((resolve,reject)=>{
      const id=this.nextId++,worker=this.worker;
      const job={id,onProgress,finish:(error,result)=>{
        if(this.pending!==job)return;
        this.pending=null;clearTimeout(timer);signal?.removeEventListener('abort',abort);
        if(error){this.terminate();reject(error);}else resolve(result);
      }};
      const abort=()=>job.finish(vocalAbortError());
      const timer=setTimeout(()=>job.finish(new Error('人聲分析逾時，請重試')),this.timeoutMs);
      this.pending=job;signal?.addEventListener('abort',abort,{once:true});
      try{worker.postMessage({type:'analyze',jobId:id,channels,offsetSamples,lengthSamples},channels.map(channel=>channel.buffer));}
      catch(error){job.finish(error);}
    });
  }
  async analyze({readChunk,duration,signal,onProgress=()=>{}}){
    if(this.active)throw new Error('已有一項人聲分離工作正在執行，請先完成或取消');
    if(!Number.isFinite(duration)||duration<=0||duration>86400)throw new Error('素材時長不正確或超過 24 小時');
    if(signal?.aborted)throw vocalAbortError();
    const owner={};
    this.active=owner;
    // Release admission synchronously. A cancelled read may settle after the retry.
    const release=()=>{if(this.active===owner)this.active=false;};
    signal?.addEventListener('abort',release,{once:true});
    try{
      const peaks=new Float32Array(Math.ceil(Math.round(duration*VOCAL_SAMPLE_RATE)/(VOCAL_SAMPLE_RATE/VOCAL_RESOLUTION))*2);
      for(let start=0;start<duration;start+=30){
        if(signal?.aborted)throw vocalAbortError();
        const end=Math.min(duration,start+30),readStart=Math.max(0,start-2),readEnd=Math.min(duration,end+2);
        onProgress({percent:start/duration*100,label:'讀取原素材音訊…'});
        const channels=await readChunk({start:readStart,duration:readEnd-readStart,signal});
        if(signal?.aborted)throw vocalAbortError();
        const offsetSamples=Math.round((start-readStart)*VOCAL_SAMPLE_RATE),lengthSamples=Math.round((end-start)*VOCAL_SAMPLE_RATE);
        if(!channels?.every(channel=>channel instanceof Float32Array)||channels.length!==2||
          channels[0].length!==channels[1].length||channels[0].length<offsetSamples+lengthSamples)
          throw new Error('原素材音訊長度不足，請重新載入素材後重試');
        const result=await this.chunk(channels,{signal,offsetSamples,lengthSamples,onProgress:progress=>onProgress({
          ...progress,percent:progress.fraction==null?start/duration*100:(start+(end-start)*progress.fraction*.95)/duration*100
        })});
        if(!(result instanceof Float32Array)||result.length!==Math.ceil(lengthSamples/(VOCAL_SAMPLE_RATE/VOCAL_RESOLUTION))*2)
          throw new Error('人聲波形長度不正確');
        peaks.set(result,Math.round(start*VOCAL_RESOLUTION)*2);
        onProgress({percent:end/duration*100,label:end===duration?'人聲波形完成':'分離人聲…'});
      }
      return peaks;
    }finally{signal?.removeEventListener('abort',release);release();}
  }
}

export const vocalWaveformClient=new VocalWaveformClient();
