/* HTML/mpv 的來源畫格證據。用有界容器 header 建立索引，不啟動 decoder 或抽出媒體樣本。 */
import { demuxIndex, presentationSamples } from './demux.js';
import { webmPresentationMetadata } from './webm-metadata.js';
import { sourceClockTime, playerClockTime } from '../../shared/media-source-clock.cjs';

const indexes=new Map();
const MAX_SOURCES=4;

function sourceIndex(url){
  let pending=indexes.get(url);
  if(pending){indexes.delete(url);indexes.set(url,pending);return pending;}
  pending=(async()=>{
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
  }).catch(()=>{
    // Failed I/O is retryable. An old failure must not evict a newer load for
    // this URL after reset/eviction; late completion never re-inserts itself.
    if(indexes.get(url)===pending) indexes.delete(url);
    return null;
  });
  indexes.set(url,pending);
  while(indexes.size>MAX_SOURCES) indexes.delete(indexes.keys().next().value);
  return pending;
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
  const pending=sourceIndex(url);
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
