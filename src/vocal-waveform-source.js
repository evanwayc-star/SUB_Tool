import { State, DESK } from './state.js';
import { Media } from './media.js';
import { AudioEngine } from './audio-engine.js';
import { audioMotherPath } from '../shared/audio-loudness.cjs';
import { vocalWaveformClient, vocalAbortError } from './vocal-waveform-worker-client.js';
import { vocalWaveformCache, vocalCacheDescriptor } from './vocal-waveform-cache.js';

function keys(source){
  return [source?.audioSourceId,source?.sourceId,source?.audioSrc,source?.source,source?.id].filter(value=>value!=null).map(String);
}
export function resolveVocalSource(source){
  const wanted=typeof source==='object'?keys(source):[String(source)];
  return [...(State.clips||[]),...(Media.externalAudioSources||[])].find(item=>keys(item).some(key=>wanted.includes(key)))||null;
}
function sourceSpec(source){
  const duration=Number(source.dur??source.duration);
  const descriptors=source.descriptors||State.audioProject?.sourceMaps?.[source.audioSourceId]?.channels||[];
  const streams=[...new Set(descriptors.map(item=>Number(item.sourceStream??0)))].sort((a,b)=>a-b);
  return {path:audioMotherPath(source),duration,streams:streams.length?streams:[0],url:source.web?.url||null,
    file:source._file||null,sourceId:source.audioSourceId||source.id};
}
const fileIds=new WeakMap();let nextFileId=1;
function signature(spec){
  if(spec.file&&!fileIds.has(spec.file))fileIds.set(spec.file,nextFileId++);
  return JSON.stringify([spec.path,spec.url,spec.duration,spec.streams,
    spec.file?fileIds.get(spec.file):(!spec.path&&!spec.url?spec.sourceId:null)]);
}
const inFlight=new Map();
const preferenceRevisions=new Map();
let preferenceSequence=0;

function sourcePreferenceKey(spec){
  if(DESK?.vocalWaveChunk&&spec.path){
    const path=spec.path.replace(/\\/g,'/');
    const canonical=/^[a-z]:\//i.test(path)||path.startsWith('//')?path.toLowerCase():path;
    return JSON.stringify(['desktop',canonical,spec.duration,spec.streams]);
  }
  if(spec.file)return JSON.stringify(['browser',spec.file.name||'',spec.file.size,spec.file.lastModified||0,spec.duration,spec.streams]);
  return null;
}

function boundedFingerprint(promise,signal){
  if(signal?.aborted)return Promise.reject(vocalAbortError());
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(value,error)=>{
      if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if(error)reject(error);else resolve(value);
    };
    const abort=()=>finish(null,vocalAbortError());
    const timer=setTimeout(()=>finish(null),5000);
    signal?.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(value=>finish(value),()=>finish(null));
  });
}

async function cacheDescriptor(spec,signal){
  let fingerprint=null;
  try{
    if(DESK?.vocalWaveFingerprint&&spec.path)
      fingerprint=await boundedFingerprint(DESK.vocalWaveFingerprint(spec.path),signal);
    else if(!DESK?.vocalWaveChunk&&spec.file&&spec.file.size<=100e6){
      // Browser File metadata alone cannot identify a replacement with preserved timestamps.
      fingerprint=await boundedFingerprint((async()=>{
        const bytes=await spec.file.arrayBuffer();
        const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
        return [...digest].map(value=>value.toString(16).padStart(2,'0')).join('');
      })(),signal);
    }
  }catch(error){if(error.name==='AbortError')throw error;}
  if(signal?.aborted)throw vocalAbortError();
  return vocalCacheDescriptor(fingerprint,spec.duration,spec.streams);
}

/** Cache-only restore; undefined permits registration to retry unresolved assets. */
export async function restoreCachedSourceVocals(source,{signal}={}){
  const resolved=resolveVocalSource(source);
  if(!resolved)return undefined;
  const spec=sourceSpec(resolved),identity=signature(spec);
  const owns=()=>!signal?.aborted&&signature(sourceSpec(resolveVocalSource(source)||{}))===identity;
  try{
    const descriptor=await cacheDescriptor(spec,signal);
    if(!owns())return null;
    const peaks=await vocalWaveformCache.read(descriptor,spec.duration,{selectedOnly:true,preferenceKey:sourcePreferenceKey(spec)});
    return owns()?peaks:null;
  }catch(_){return null;}
}

/** Display preferences belong to the local cache, never project State or History. */
export async function rememberSourceVocalSelection(source,enabled){
  const resolved=resolveVocalSource(source);
  if(!resolved)return false;
  const spec=sourceSpec(resolved),identity=signature(spec),revision=++preferenceSequence;
  const preferenceKey=sourcePreferenceKey(spec),revisionKey=preferenceKey||identity;
  preferenceRevisions.set(revisionKey,revision);
  // The explicit choice is durable before any async file or IndexedDB operation.
  vocalWaveformCache.rememberPreference(preferenceKey,!!enabled);
  const isCurrent=()=>preferenceRevisions.get(revisionKey)===revision&&signature(sourceSpec(resolveVocalSource(source)||{}))===identity;
  try{
    const descriptor=await cacheDescriptor(spec);
    if(!isCurrent())return false;
    return await vocalWaveformCache.select(descriptor,!!enabled,{isCurrent,order:revision});
  }catch(_){return false;}
  finally{if(preferenceRevisions.get(revisionKey)===revision)preferenceRevisions.delete(revisionKey);}
}

function splitPCM(result,duration){
  if(result?.sampleRate!==44100||result?.channels!==2||!(result.samples instanceof ArrayBuffer)||result.samples.byteLength%8)
    throw new Error('原素材音訊格式不正確');
  const interleaved=new Float32Array(result.samples),frames=interleaved.length/2;
  const expected=Math.round(duration*44100);
  // A video may outlast its audio stream. Successful EOF is silence, never a time shift.
  const channels=[new Float32Array(expected),new Float32Array(expected)];
  for(let i=0;i<Math.min(frames,expected);i++)for(let ch=0;ch<2;ch++)channels[ch][i]=interleaved[i*2+ch];
  return channels;
}

async function runSourceVocals(spec,resolved,{signal,onProgress,identity}){
  const owns=()=>!signal.aborted&&[...(State.clips||[]),...(Media.externalAudioSources||[])]
    .some(item=>signature(sourceSpec(item))===identity);
  const assertOwned=()=>{if(!owns())throw vocalAbortError();};
  const descriptor=await cacheDescriptor(spec,signal);assertOwned();
  const cached=await vocalWaveformCache.read(descriptor,spec.duration);assertOwned();
  if(cached){onProgress?.({percent:100,label:'已載入人聲快取'});return cached;}
  let webBuffers=null;
  const readChunk=async ({start,duration})=>{
    assertOwned();
    if(DESK?.vocalWaveChunk&&spec.path){
      const channels=[new Float32Array(Math.round(duration*44100)),new Float32Array(Math.round(duration*44100))];
      for(const sourceStream of spec.streams){
        assertOwned();
        const requestId=`vocals-${crypto.randomUUID()}`;
        const cancel=()=>{void DESK.cancelVocalWaveChunk(requestId).catch(()=>{});};
        signal?.addEventListener('abort',cancel,{once:true});
        let result;
        try{
          result=await DESK.vocalWaveChunk({path:spec.path,start,duration,requestId,sourceStream});
        }finally{signal?.removeEventListener('abort',cancel);}
        assertOwned();
        const decoded=splitPCM(result,duration);
        for(let ch=0;ch<2;ch++)for(let i=0;i<channels[ch].length;i++)channels[ch][i]+=decoded[ch][i]/spec.streams.length;
      }
      return channels;
    }
    if(!webBuffers){
      if(spec.duration>300)throw new Error('瀏覽器人聲分離目前支援 5 分鐘內素材；長片請使用桌面版');
      // Use original decoded tracks only; an effect buffer is not the mother audio.
      const original=(Media.tracks||[]).filter(track=>!track._audioEffect&&track.buffer&&
        keys(resolved).includes(String(track.audioSourceId||track.source))&&spec.streams.includes(Number(track.sourceStream??0)));
      const originalStreams=new Set(original.map(track=>Number(track.sourceStream??0)));
      if(original.length&&spec.streams.every(stream=>originalStreams.has(stream)))
        webBuffers=[...new Set(original.map(track=>track.buffer))];
      else{
        if(spec.streams.length>1)throw new Error('尚未載入全部原始音軌，請先抽取多軌混音或使用桌面版');
        const file=resolved._file;
        if(file?.size>100e6)throw new Error('瀏覽器人聲分離目前支援 100 MB 內素材；請使用桌面版');
        if(!file&&!spec.url)throw new Error('找不到原素材音訊，請重新載入檔案');
        const response=file?null:await fetch(spec.url,{signal});
        if(response&&!response.ok)throw new Error('無法讀取原素材音訊');
        const blob=file||await response.blob();
        if(blob.size>100e6)throw new Error('瀏覽器人聲分離目前支援 100 MB 內素材；請使用桌面版');
        assertOwned();
        webBuffers=[await AudioEngine.decodeAudioData(await blob.arrayBuffer())];
        assertOwned();
      }
    }
    const count=Math.round(duration*44100);
    const context=new OfflineAudioContext(2,count,44100);
    for(const buffer of webBuffers){
      const node=context.createBufferSource(),gain=context.createGain();
      node.buffer=buffer;gain.gain.value=1/webBuffers.length;node.connect(gain);gain.connect(context.destination);node.start(0,start,duration);
    }
    const rendered=await context.startRendering();assertOwned();
    return [Float32Array.from(rendered.getChannelData(0)),Float32Array.from(rendered.getChannelData(1))];
  };
  const peaks=await vocalWaveformClient.analyze({readChunk,duration:spec.duration,signal,onProgress});
  assertOwned();
  if(descriptor){
    const after=await cacheDescriptor(spec,signal);assertOwned();
    if(after&&after!==descriptor)throw new Error('母素材在分析期間變更，請重試');
    if(after===descriptor){await vocalWaveformCache.write(descriptor,spec.duration,peaks);assertOwned();}
  }
  return peaks;
}

/** Split placements share one mother analysis; each display still owns its own selection. */
export async function analyzeSourceVocals(source,{signal,onProgress}={}){
  if(signal?.aborted)throw vocalAbortError();
  const resolved=resolveVocalSource(source);
  if(!resolved||resolved.type==='image')throw new Error('找不到可分析的音訊素材');
  const spec=sourceSpec(resolved),identity=signature(spec);
  const owns=()=>!signal?.aborted&&signature(sourceSpec(resolveVocalSource(source)||{}))===identity;
  let job=inFlight.get(identity);
  if(!job){
    job={controller:new AbortController(),listeners:new Set(),progress:null,promise:null};
    inFlight.set(identity,job);
    job.promise=Promise.resolve().then(()=>runSourceVocals(spec,resolved,{
      identity,signal:job.controller.signal,onProgress:progress=>{
        job.progress=progress;
        for(const listener of job.listeners)listener.progress(progress);
      }
    }));
    const cleanup=()=>{if(inFlight.get(identity)===job)inFlight.delete(identity);};
    job.promise.then(cleanup,cleanup);
  }
  return new Promise((resolve,reject)=>{
    let settled=false;
    const listener={progress:progress=>{if(owns())onProgress?.(progress);}};
    const finish=(error,peaks)=>{
      if(settled)return;settled=true;
      signal?.removeEventListener('abort',abort);job.listeners.delete(listener);
      if(!job.listeners.size){
        if(inFlight.get(identity)===job)inFlight.delete(identity);
        job.controller.abort();
      }
      if(error)reject(error);else if(!owns())reject(vocalAbortError());else resolve(peaks);
    };
    const abort=()=>finish(vocalAbortError());
    job.listeners.add(listener);signal?.addEventListener('abort',abort,{once:true});
    if(job.progress)listener.progress(job.progress);
    job.promise.then(peaks=>finish(null,peaks),error=>finish(error));
  });
}
