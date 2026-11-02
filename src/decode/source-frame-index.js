/* HTML/mpv 的來源畫格證據。用有界容器 header 建立索引，不啟動 decoder 或抽出媒體樣本。 */
import { demuxIndex, presentationSamples } from './demux.js';
import { webmPresentationMetadata } from './webm-metadata.js';
import { sourceClockTime, playerClockTime } from '../../shared/media-source-clock.cjs';

const indexes=new Map();
const MAX_SOURCES=4;
const INCOMPLETE_RETRY_MS=1000;

function sourceIndex(url,{retryIncomplete=false}={}){
  const existing=indexes.get(url);
  if(existing&&!(existing.retryable&&(retryIncomplete||Date.now()>=existing.retryAt))){
    indexes.delete(url);indexes.set(url,existing);return existing.pending;
  }
  const previous=existing?.result||null;
  const entry={pending:null,result:null,retryable:false,retryAt:0};
  const incomplete=result=>!result||[result.metadata?.audioPresentationTimestampOffsets,
    result.metadata?.decoderAudioPresentationTimestampOffsets].some(offsets=>offsets?.includes(null));
  const evidenceCount=result=>result?[result.metadata?.audioPresentationTimestampOffsets,
    result.metadata?.decoderAudioPresentationTimestampOffsets].reduce((count,offsets)=>
    count+(offsets||[]).filter(Number.isFinite).length,0):-1;
  entry.pending=(async()=>{
    const webm=await webmPresentationMetadata(url);
    if(webm!==undefined)return webm?{samples:[],metadata:webm}:null;
    return demuxIndex(url,{allowAudio:true,metadataOnly:true});
  })().then(result=>{
    if(!result||result.metadata)return result;
    const {index,info}=result;
    const samples=presentationSamples(index,info);
    if(!samples) return null;
    const ordered=samples.map(sample=>({start:sample.timestamp,duration:sample.duration}))
      .filter(sample=>Number.isFinite(sample.start)&&sample.duration>0)
      .sort((a,b)=>a.start-b.start);
    // Ignore decoder preroll outside the active media edit. The same real
    // presentation intervals serve frame evidence and original File intake.
    const origin=info.hasVideo===false&&Number.isFinite(info.audioPresentationTimestampOffset)
      ?-info.audioPresentationTimestampOffset*1e6:ordered.find(sample=>sample.start>=info.presentationStartUs)?.start;
    if(!Number.isFinite(origin)) return null;
    const sampleEnd=ordered.reduce((end,sample)=>Math.max(end,sample.start+sample.duration),0);
    const end=info.containerDurationUs>0?info.containerDurationUs:sampleEnd;
    return {samples:info.hasVideo===false?[]:ordered,metadata:Object.freeze({
      presentationTimestampOffset:-origin/1e6||0,duration:Math.max(0,end-origin)/1e6,
      ...(Number.isFinite(info.audioPresentationTimestampOffset)
        ?{audioPresentationTimestampOffset:info.audioPresentationTimestampOffset}:{}),
      ...(info.audioPresentationTimestampOffsets?.length
        ?{audioPresentationTimestampOffsets:Object.freeze([...info.audioPresentationTimestampOffsets])}:{}),
      ...(info.decoderAudioPresentationTimestampOffsets?.length
        ?{decoderAudioPresentationTimestampOffsets:Object.freeze([...info.decoderAudioPresentationTimestampOffsets])}:{}),
    })};
  }).then(result=>{
    const chosen=evidenceCount(result)>=evidenceCount(previous)?result:previous;
    if(indexes.get(url)===entry){entry.result=chosen;entry.retryable=incomplete(chosen);entry.retryAt=Date.now()+INCOMPLETE_RETRY_MS;}
    return chosen;
  }).catch(()=>{
    // Failed I/O is retryable. An old failure must not evict a newer load for
    // this URL after reset/eviction; late completion never re-inserts itself.
    if(indexes.get(url)===entry){
      if(previous){entry.result=previous;entry.retryable=true;entry.retryAt=Date.now()+INCOMPLETE_RETRY_MS;}
      else indexes.delete(url);
    }
    return previous;
  });
  indexes.set(url,entry);
  while(indexes.size>MAX_SOURCES) indexes.delete(indexes.keys().next().value);
  return entry.pending;
}

export async function sourceFrameWindow(url,sourceTime,clock=null){
  if(!url||!Number.isFinite(sourceTime)) return null;
  const samples=(await sourceIndex(url))?.samples;
  if(!samples?.length) return null;
  const target=Math.round(playerClockTime(sourceTime,clock)*1e6);
  let lo=0,hi=samples.length-1,found=-1;
  while(lo<=hi){const middle=(lo+hi)>>1;if(samples[middle].start<=target){found=middle;lo=middle+1;}else hi=middle-1;}
  if(found<0) return null;
  const sample=samples[found],end=sample.start+sample.duration;
  if(target>=end||end<=sample.start) return null;
  return {start:sourceClockTime(sample.start/1e6,clock),end:sourceClockTime(end/1e6,clock)};
}

/* A cancelled intake stops waiting immediately; a shared bounded header read
   may still finish for another caller, but cannot publish that intake's clock. */
export async function sourcePresentationMetadata(url,{owns=()=>true,timeoutMs=10000}={}){
  if(!url||!owns()) return null;
  // 明確重新取得 metadata 可立即重試短回應；逐格查詢仍對不完整來源限流。
  const pending=sourceIndex(url,{retryIncomplete:true});
  return new Promise(resolve=>{
    let settled=false;
    const finish=value=>{
      if(settled) return;
      settled=true;clearInterval(poll);clearTimeout(timer);resolve(value);
    };
    const poll=setInterval(()=>{if(!owns()) finish(null);},25);
    const timer=setTimeout(()=>finish(null),Math.max(1,timeoutMs));
    pending.then(result=>finish(owns()?result?.metadata||null:null));
  });
}

export function clearSourceFrameIndexes(){indexes.clear();}
