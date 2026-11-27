import { State, DESK } from './state.js';
import { emit } from './events.js';
import { readFile } from './util.js';
import { AudioEngine } from './audio-engine.js';
import { AudioPipeline } from './audio-routing-engine.js';
import { Media } from './media.js';
import { Seq } from './sequence.js';
import { $ } from './dom.js';
import { setMediaProcessingStatus } from './ui.js';
import { MediaIntakeJobs } from './media-intake-jobs.js';
import { sourceDisplayPeaks } from './source-waveform-progress.js';
import { audioMotherPath } from '../shared/audio-loudness.cjs';

export const WAVE_DECODE_MAX = 5e8;    // 超過此大小不整檔解碼波形，改即時擷取
let pendingFileDecode = null;

// decodeAudioData resamples to the output context. Clock alignment can temporarily
// retain both the decoded PCM and a second, source-aligned AudioBuffer.
export function canDecodeWaveform(file,duration,channels,sampleRate=AudioEngine.ctx?.sampleRate || 48000){
  if(!(duration>0) || !Number.isFinite(duration) || !(file?.size>=0) || file.size>WAVE_DECODE_MAX) return false;
  const channelCount=Number.isInteger(channels)&&channels>0?channels:8;
  const pcmBytes=Math.ceil(duration*sampleRate)*channelCount*Float32Array.BYTES_PER_ELEMENT;
  return file.size+2*pcmBytes <= 256*1024*1024;
}

function pcmWaveHeader(arrayBuffer){
  const view=new DataView(arrayBuffer);
  if(view.byteLength<44||view.getUint32(0,false)!==0x52494646||view.getUint32(8,false)!==0x57415645)return null;
  let channels=0,sampleRate=0;
  for(let offset=12;offset+8<=view.byteLength;){
    const id=view.getUint32(offset,false),size=view.getUint32(offset+4,true),start=offset+8;
    if(id===0x64617461 && channels && sampleRate && start%2===0 && size%(channels*2)===0){
      return {start,length:size/(channels*2),channels,sampleRate};
    }
    if(start+size>view.byteLength)return null;
    if(id===0x666d7420){
      if(size<16||view.getUint16(start+14,true)!==16)return null;
      const format=view.getUint16(start,true);
      if(format===0xfffe){
        // KSDATAFORMAT_SUBTYPE_PCM, with all 16 valid bits in each sample.
        if(size<40 || view.getUint16(start+16,true)<22 || view.getUint16(start+18,true)!==16 ||
          view.getUint32(start+24,true)!==1 || view.getUint32(start+28,false)!==0x00001000 ||
          view.getUint32(start+32,false)!==0x800000aa || view.getUint32(start+36,false)!==0x00389b71)return null;
      } else if(format!==1)return null;
      channels=view.getUint16(start+2,true);sampleRate=view.getUint32(start+4,true);
    }
    offset=start+size+(size%2);
  }
  return null;
}

function wavePcm(arrayBuffer){
  const info=pcmWaveHeader(arrayBuffer);
  if(!info || info.start+info.length*info.channels*2>arrayBuffer.byteLength)return null;
  return {...info,samples:new Int16Array(arrayBuffer,info.start,info.length*info.channels),firstFrame:0};
}

function sourceWavePcm(arrayBuffer,duration){
  const pcm=wavePcm(arrayBuffer);
  if(!pcm||!Number.isFinite(duration)||duration<=0||!pcm.length) return null;
  const expected=Math.round(duration*pcm.sampleRate);
  return Number.isSafeInteger(expected)&&pcm.length+1>=expected ? pcm : null;
}

// 同步與協作式解碼共用同一份桶界線／逐 sample 混音；只改排程，不改波形。
function pcmPeakCalculation(streams,duration,res,channel){
  if(!streams.length||streams.some(stream=>!stream))return null;
  if(channel!=null&&(streams.length!==1||!Number.isInteger(channel)||channel<0||channel>=streams[0].channels))return null;
  const sampleRate=Math.max(...streams.map(stream=>stream.sampleRate));
  const numChannels=channel==null?streams.reduce((count,stream)=>count+stream.channels,0):1;
  const sourceDuration=Math.max(Number(duration)||0,...streams.map(stream=>stream.length/stream.sampleRate));
  const numSamples=Math.ceil(sourceDuration*sampleRate),len=Math.ceil(sourceDuration*res);
  const peaks=new Float32Array(len*2),spb=sampleRate/res;
  const fill=(first,last)=>{
    for(let i=first;i<last;i++){
      const s0=Math.floor(i*spb),s1=Math.min(numSamples,Math.floor((i+1)*spb));
      let mn=0,mx=0;
      for(let j=s0;j<s1;j++){
        let v=0;
        for(const stream of streams){
          const frame=Math.floor(j*stream.sampleRate/sampleRate);
          if(frame>=stream.length)continue;
          const base=(frame-stream.firstFrame)*stream.channels;
          if(channel!=null)v+=stream.samples[base+channel];
          else for(let c=0;c<stream.channels;c++)v+=stream.samples[base+c];
        }
        v=(v/numChannels)/32768.0;
        if(v<mn)mn=v;if(v>mx)mx=v;
      }
      peaks[i*2]=mn;peaks[i*2+1]=mx;
    }
  };
  return {peaks,len,fill,sampleRate,batchBuckets:Math.max(1,Math.floor(16384/(spb*numChannels)))};
}

async function finishPcmPeaks(calculation,owns){
  if(!calculation||!owns())return null;
  const {peaks,len,fill,batchBuckets}=calculation;
  let next=0;
  while(next<len){
    if(!owns())return null;
    const until=performance.now()+5;
    let batches=0;
    do{
      const end=Math.min(len,next+batchBuckets);
      fill(next,end);next=end;
    }while(next<len&&++batches<64&&performance.now()<until);
    // A microtask alone cannot deliver input/cancel or paint. Keep each task
    // bounded even on a fast CPU, and recheck the caller after the real yield.
    if(next<len)await new Promise(resolve=>setTimeout(resolve,0));
  }
  return owns()?peaks:null;
}

let vocalSourceModule=null;
function loadVocalSourceModule(){
  // One lazy module load also covers all subscriptions in a split audio lane.
  if(!vocalSourceModule) vocalSourceModule=import('./vocal-waveform-source.js').catch(error=>{
    vocalSourceModule=null;
    throw error;
  });
  return vocalSourceModule;
}



/* ===== 4. 波形 ======================================================== */
export const Wave = {
  peaks:null,        // Float32Array [min0,max0,min1,max1,...]
  resolution:100,    // 每秒桶數

  /* --- 多音源選擇（主混音 / 各聲道） --- */
  sources:[],   // [{label, path, peaks}]
  srcIdx:-1,
  _generation:0, // reset/replacement fence for async waveform work

  /*
   * 來源級波形 registry。
   *
   * `sources` 是早期播放器下拉選單的全域清單；它只有一個目前選項，無法表示
   * 「A 檔看 Ch 3，同時 B 檔看 MIX」。時間軸需要後者，所以用 audioSourceId
   * 建一個純 runtime registry。它刻意不寫進 State / 專案檔，避免把大型
   * Float32Array 序列化；檔案重新載入後會由 ingest / decode 重新補齊。
   */
  sourceWaveforms:new Map(), // key -> {key,runtimeSourceId,mix,channels:Map,vocals,selection}
  liveElementSources:new Map(),

  _sourceKey(source){
    if(source&&typeof source==='object'){
      const key=source.audioSourceId??source.sourceId??source.audioSrc??source.source??source.id;
      return key==null?'':String(key);
    }
    return source==null?'':String(source);
  },
  _runtimeSourceKey(source){
    if(source&&typeof source==='object'){
      const key=source.audioSrc??source.source??null;
      return key==null?'':String(key);
    }
    return '';
  },
  _registeredSource(source,state){
    if(source&&typeof source==='object') return source;
    return [...(State.clips||[]),...(Media.externalAudioSources||[])].find(item=>
      this._sourceKey(item)===state.key||this._runtimeSourceKey(item)===state.runtimeSourceId);
  },
  _channelKey(stream,channel){ return `${stream}:${channel}`; },
  _channelDescriptor(channel,index=0){
    const sourceStream=Math.max(0,Math.floor(Number(channel?.sourceStream??0)||0));
    const sourceChannel=Math.max(0,Math.floor(Number(channel?.sourceChannel??index)||0));
    return {sourceStream,sourceChannel,key:this._channelKey(sourceStream,sourceChannel)};
  },
  _sourceState(source,create=false){
    const key=this._sourceKey(source);
    const runtime=this._runtimeSourceKey(source);
    let state=key?this.sourceWaveforms.get(key):null;
    // 舊路徑可能只用 runtime audioSrc（video / clip:<id>）登錄；在有持久
    // audioSourceId 時把同一份 state 加一個 alias，避免舊專案重新載入後失去波形。
    if(!state&&runtime&&runtime!==key){
      state=this.sourceWaveforms.get(runtime)||null;
      if(state&&key){ this.sourceWaveforms.set(key,state); state.key=key; }
    }
    if(!state&&create&&key){
      state={
        key,
        runtimeSourceId:runtime||key,
        mix:{peaks:null,path:null,loading:null},
        channels:new Map(),
        channelsRegistered:false,
        vocals:{peaks:null,loading:null,controller:null,percent:0,label:'',error:null},
        vocalIntent:null,
        vocalRevision:0,
        vocalRestore:null,
        vocalRestoreComplete:false,
        vocalRestoreKey:null,
        vocalChoiceMade:false,
        originalSelection:'mix',
        selection:'mix'
      };
      this.sourceWaveforms.set(key,state);
    }
    if(state&&runtime) state.runtimeSourceId=runtime;
    return state;
  },
  _ensureSourceWaveforms(source){
    const state=this._sourceState(source,true);
    if(!state||state.channelsRegistered||state.channels.size) return state;
    const key=this._sourceKey(source);
    const runtime=this._runtimeSourceKey(source);
    const channels=[];
    // 已就緒的播放 track 最可靠：它們同時帶著 sourceStream/sourceChannel 與 cache file。
    for(const track of Media.tracks||[]){
      if((track.audioSourceId&&String(track.audioSourceId)===key)||
        (!key&&runtime&&(track.source||'')===runtime)){
        const mix=state.mix.path;
        const pcmStream=Array.isArray(mix?.sourceStreams)?mix.sourceStreams.indexOf(track.sourceStream):track.sourceStream;
        // Processed playback files retain their full sample rate. An opaque
        // PCM mix descriptor also owns the low-rate members used on reload.
        const file=track._audioEffect&&Array.isArray(mix?.paths)?mix.paths[pcmStream]:track.file;
        channels.push({
          sourceStream:track.sourceStream,
          sourceChannel:track.sourceChannel,
          label:track.name,
          file,
          pcmChannel:track._audioEffect?track.sourceChannel:null,
          ...(track._audioEffect&&mix?.effectPeaksCache?{effectPeaksCache:{...mix.effectPeaksCache,
            channel:{sourceStream:track.sourceStream,sourceChannel:track.sourceChannel}}}:{}),
          peaks:track.peaks
        });
      }
    }
    // ingest 尚未結束時沒有 track，仍從 routing 描述列出可選聲道。
    if(!channels.length){
      const map=State.audioProject?.sourceMaps?.[key];
      for(const route of map?.channels||[]){
        if(route&&route.sourceChannel!=null) channels.push({
          sourceStream:route.sourceStream,
          sourceChannel:route.sourceChannel
        });
      }
    }
    if(channels.length) this.registerSourceWaveforms(source,{channels});
    return state;
  },
  registerSourceWaveforms(source,{mixPath,mixPeaks,channels}={}){
    const state=this._sourceState(source,true);
    if(!state) return null;
    const nextMixPath=mixPath!==undefined?mixPath||null:state.mix.path;
    if(state.mix.path&&nextMixPath!==state.mix.path) this._cancelSourceVocals(state,{clear:true});
    if(nextMixPath!==state.mix.path||(mixPeaks?.length&&mixPeaks!==state.mix.peaks)){
      this.liveElementSources.delete(state.runtimeSourceId);
      // A new file or supplied peaks supersedes any in-flight decode for the old entry.
      state.mix={path:nextMixPath,peaks:nextMixPath===state.mix.path?state.mix.peaks:null,loading:null};
    }
    if(mixPeaks&&mixPeaks.length) state.mix.peaks=mixPeaks;
    if(Array.isArray(channels)){
      const retained=new Set();
      for(let index=0;index<channels.length;index++){
        const raw=channels[index]||{};
        const desc=this._channelDescriptor(raw,index);
        retained.add(desc.key);
        const old=state.channels.get(desc.key);
        const nextPath=raw.file||raw.path||old?.path||null;
        const nextPeaks=raw.peaks||null;
        const pcmChannel=raw.pcmChannel??old?.pcmChannel??null;
        const effectPeaksCache=raw.effectPeaksCache||(old?.path===nextPath?old.effectPeaksCache:null);
        if(!old||nextPath!==old.path||pcmChannel!==old.pcmChannel||(nextPeaks&&nextPeaks!==old.peaks)){
          old?.controller?.abort();
          state.channels.set(desc.key,{
            ...desc,
            label:raw.label||old?.label||`Ch ${desc.sourceChannel+1}`,
            path:nextPath,
            pcmChannel,
            effectPeaksCache,
            peaks:nextPeaks||(old&&nextPath===old.path&&pcmChannel===old.pcmChannel?old.peaks:null)||null,
            loading:null
          });
        }else{
          old.label=raw.label||old.label||`Ch ${desc.sourceChannel+1}`;
          old.effectPeaksCache=effectPeaksCache;
        }
      }
      // An explicit list describes the complete source, including zero audio.
      // Removing the entry also revokes any decode still waiting for its file.
      for(const [key,entry] of state.channels) if(!retained.has(key)){
        entry.controller?.abort();
        state.channels.delete(key);
      }
      state.channelsRegistered=true;
      for(const field of ['selection','originalSelection']){
        if(state[field]!=='mix'&&state[field]!=='vocals'&&!state.channels.has(state[field])) state[field]='mix';
      }
    }
    this._restoreSourceVocals(source,state);
    return state;
  },
  setSourceMixPeaks(source,peaks,{mixPath,channels}={}){
    const state=this.registerSourceWaveforms(source,{mixPath,mixPeaks:peaks,channels});
    if(!state) return peaks||null;
    const runtime=this._runtimeSourceKey(source);
    if(!this.peaks||runtime===Media.activeSource||(!Media.activeSource&&runtime==='video')){
      this.live=false;
      this.peaks=peaks;
    }
    return peaks||null;
  },
  getSourceMixPeaks(source){ return this._sourceState(source,false)?.mix?.peaks || null; },
  clearSourceMixPeaks(source,expected){
    const state=this._sourceState(source,false);
    if(!state||state.mix.peaks!==expected) return false;
    state.mix={path:null,peaks:null,loading:null};
    if(this.peaks===expected) this.peaks=null;
    return true;
  },
  setSourceBuffer(source,ab,{channels}={}){
    if(!ab) return null;
    const buffers=Array.isArray(ab)?ab:[ab];
    if(!buffers.length) return null;
    const mixPeaks=this.calcPeaks(ab,-1);
    const supplied=Array.isArray(channels)?channels:null;
    const channelInfo=[];
    for(let stream=0;stream<buffers.length;stream++){
      const buffer=buffers[stream];
      for(let channel=0;channel<buffer.numberOfChannels;channel++){
        const raw=supplied?.[channelInfo.length]||{sourceStream:stream,sourceChannel:channel};
        const desc=this._channelDescriptor(raw,channel);
        channelInfo.push({...raw,...desc,label:raw.label||`Ch ${desc.sourceChannel+1}`,
          peaks:this.calcPeaks(buffer,channel)});
      }
    }
    this.setSourceMixPeaks(source,mixPeaks,{channels:channelInfo});
    return mixPeaks;
  },
  _normaliseSelection(selection){
    const raw=selection&&typeof selection==='object'
      ? (selection.id??selection.key??(selection.sourceChannel==null?'mix':this._channelKey(
        Math.max(0,Math.floor(Number(selection.sourceStream??0)||0)),
        Math.max(0,Math.floor(Number(selection.sourceChannel)||0))
      ))) : selection;
    const value=raw==null?'mix':String(raw);
    if(value==='mix'||value==='-1'||value==='MIX') return 'mix';
    return value.replace(/^channel:/,'');
  },
  getSourceWaveSelection(source){
    return this._ensureSourceWaveforms(source)?.selection||'mix';
  },
  getSourceWaveOptions(source){
    const state=this._ensureSourceWaveforms(source);
    const selected=state?.selection||'mix';
    const channels=state?[...state.channels.values()].sort((a,b)=>
      a.sourceStream-b.sourceStream||a.sourceChannel-b.sourceChannel
    ):[];
    const multiStream=channels.some(item=>item.sourceStream!==0);
    return [
      {id:'mix',kind:'mix',label:'MIX（所有聲道）',selected:selected==='mix'},
      ...channels.map(item=>({
        id:item.key,
        kind:'channel',
        sourceStream:item.sourceStream,
        sourceChannel:item.sourceChannel,
        label:multiStream?`S${item.sourceStream+1} Ch ${item.sourceChannel+1}`:`Ch ${item.sourceChannel+1}`,
        sourceLabel:item.label,
        selected:selected===item.key,
        ready:!!item.peaks,preparing:!!item.loading,error:item.error||null,progress:item.progress??null,phase:item.phase,statusLabel:true
      })),
      {
        id:'vocals',kind:'vocals',
        label:state?.vocals.loading||state?.vocalIntent
          ? `人聲（分離配樂 ${state.vocals.percent}%）`
          : state?.vocals.error?'人聲（分離配樂，重試）':'人聲（分離配樂）',
        selected:selected==='vocals',
        ready:!!state?.vocals.peaks,
        preparing:!!state?.vocals.loading||!!state?.vocalIntent,
        // 分離在選取後才開始；未分析的選項不是待載入的聲道 cache。
        statusLabel:true,
        progress:state?.vocals.percent||0,
        detail:state?.vocals.label||'',
      }
    ];
  },
  _waveLaneSources(sources){
    const unique=new Map();
    for(const source of Array.isArray(sources)?sources:[]){
      const key=this._sourceKey(source);
      if(key&&!unique.has(key)) unique.set(key,source);
    }
    return [...unique.values()];
  },
  getSourceWaveLaneState(sources){
    const unique=this._waveLaneSources(sources);
    const selections=unique.map(source=>this.getSourceWaveSelection(source));
    const selectionSet=new Set(selections);
    const mixed=selectionSet.size>1;
    const selection=mixed?'mixed':selections[0]||'mix';
    const allOptions=unique.map(source=>this.getSourceWaveOptions(source));
    const vocalOptions=allOptions.map(options=>options.find(option=>option.id==='vocals'));
    const pending=vocalOptions.some(option=>option?.preparing);
    const progress=Math.round(vocalOptions.reduce((sum,option)=>sum+(option?.ready?100:option?.progress||0),0)/Math.max(1,unique.length));
    const detail=vocalOptions.find(option=>option?.preparing)?.detail||'';
    const options=(allOptions[0]||[]).filter(option=>allOptions.every(list=>list.some(item=>item.id===option.id))).map(option=>{
      const corresponding=allOptions.map(list=>list.find(item=>item.id===option.id));
      return {
        ...option,selected:selection===option.id,
        ready:corresponding.every(item=>item.ready!==false),
        ...(option.kind==='channel'?{
          preparing:corresponding.some(item=>item.preparing),
          phase:corresponding.find(item=>item.preparing&&item.phase==='generating')?.phase
            ||corresponding.find(item=>item.preparing)?.phase,
          error:corresponding.find(item=>item.error&&item.error.name!=='AbortError')?.error
            ||corresponding.find(item=>item.error)?.error||null,
          progress:corresponding.every(item=>item.ready||item.progress!=null)
            ?Math.round(corresponding.reduce((sum,item)=>sum+(item.ready?100:item.progress),0)/corresponding.length):null,
        }:{}),
        ...(option.id==='vocals'?{
          ready:vocalOptions.every(item=>item?.ready),preparing:pending,progress,detail,
          label:pending?`人聲（分離配樂 ${progress}%）`:'人聲（分離配樂）',
        }:{}),
      };
    });
    return {selection,mixed,pending,progress,detail,options,
      vocalsSelected:!!unique.length&&selections.every(value=>value==='vocals'),
      label:mixed?'混合（依各片段）':options.find(option=>option.id===selection)?.label||'MIX（所有聲道）'};
  },
  setSourceWaveLaneSelection(sources,selection){
    const unique=this._waveLaneSources(sources);
    if(this._normaliseSelection(selection)!=='vocals') return Promise.all(unique.map(source=>
      Promise.resolve(this.setSourceWaveSelection(source,selection))));
    // A lane can contain several mother files. Keep its existing waveforms until
    // every requested result is ready, then commit the still-owned intents together.
    const requests=unique.map(source=>this._prepareVocalSelection(source));
    emit('media:waveform',{controls:true});
    return Promise.all(requests.map(request=>request?.promise)).then(async()=>{
      const remembered=[];
      if(requests.every(request=>this._ownsVocalIntent(request)&&request.state.vocals.peaks)){
        for(const request of requests) remembered.push(this._commitVocalSelection(request));
      }else{
        for(const request of requests) if(this._ownsVocalIntent(request)) this._cancelSourceVocals(request.state);
      }
      emit('media:waveform',{controls:true});
      await Promise.all(remembered);
      return unique.map(source=>this.getSourceWaveSelection(source));
    }).catch(error=>{
      for(const request of requests) if(this._ownsVocalIntent(request)) this._cancelSourceVocals(request.state);
      emit('media:waveform',{controls:true});
      throw error;
    });
  },
  async loadSourceWaveform(source,selection='mix'){
    const state=this._ensureSourceWaveforms(source);
    if(!state) return null;
    const key=this._normaliseSelection(selection);
    if(key==='vocals') return this.loadSourceVocals(source);
    const entry=key==='mix'?state.mix:state.channels.get(key);
    if(!entry) return null;
    if(entry.peaks) return entry.peaks;
    if(entry.loading) return entry.loading;
    if(key==='mix'&&(!entry.path||!DESK?.fileURL))return null;
    const controller=new AbortController();
    entry.controller=controller;
    entry.error=null;
    entry.progress=null;
    entry.phase=key!=='mix'&&(entry.effectPeaksCache||entry.pcmChannel==null&&DESK?.prepareSourceWaveform)?'cache-check':'reading';
    const generation=this._generation;
    const owns=()=>!controller.signal.aborted&&this._generation===generation&&
      [...this.sourceWaveforms.values()].some(value=>value===state)&&
      (key==='mix'?state.mix===entry:state.channels.get(key)===entry);
    const updateProgress=(value,phase)=>{
      const percent=Number.isFinite(value)?Math.max(0,Math.min(99,Math.round(value))):null;
      if(owns()&&(percent!==entry.progress||phase!==entry.phase)){
        entry.progress=percent;
        entry.phase=phase;
        emit('media:waveform',{controls:true});
      }
    };
    const promise=(async()=>{
      try{
        const mother=key!=='mix'&&entry.pcmChannel==null&&DESK?.prepareSourceWaveform
          ?this._registeredSource(source,state):null;
        const path=audioMotherPath(mother),duration=Number(mother?.dur??mother?.duration);
        if(path&&duration>0&&Number.isFinite(duration)){
          // Publish the loading promise before native intake notifies synchronous UI observers.
          await Promise.resolve();
          if(!owns())return null;
          const channel={sourceStream:entry.sourceStream,sourceChannel:entry.sourceChannel};
          const result=await MediaIntakeJobs.prepareSourceWaveform({path,duration,continuous:true,displayPeaks:true,
            channel},null,{
            signal:controller.signal,onProgress:data=>updateProgress(Number.isFinite(data.pct)?data.pct*.95:null,data.phase||'generating'),
          });
          if(!owns())return null;
          if(!result?.complete||!result.wave)throw new Error('聲道波形未完成，請重試');
          const cached=sourceDisplayPeaks(result,duration,this.resolution,channel);
          if(cached){entry.peaks=cached;return cached;}
          const peaks=await MediaIntakeJobs.prepareWaveform(({owns:ownsRead,report})=>{
            updateProgress(null,'reading');
            report({label:'讀取聲道波形',pct:0});
            return this._loadPcmMix({paths:[result.wave]},()=>owns()&&ownsRead(),0,value=>{
              report({label:'讀取聲道波形',pct:Math.round(value*100)});
              updateProgress(value*100,'reading');
            });
          },{path,channel},{signal:controller.signal});
          if(!owns())return null;
          if(!peaks?.length)throw new Error('聲道波形檔案無法讀取，請重試');
          entry.peaks=peaks;
          return peaks;
        }
        if(!entry.path||!DESK?.fileURL){
          await Promise.resolve();
          throw new Error('尚未取得此聲道的音訊，請確認素材可讀後重試');
        }
        if(Array.isArray(entry.path.paths)||entry.pcmChannel!=null){
          const effectCache=entry.effectPeaksCache;
          if(effectCache&&DESK.audioEffectPeaks){
            let saved;
            try{saved=await DESK.audioEffectPeaks(effectCache);}catch{/* Read the prepared PCM if the display cache is unavailable. */}
            if(!owns())return null;
            if(saved?.peaks instanceof Float32Array&&saved.peaks.length){entry.peaks=saved.peaks;return entry.peaks;}
          }
          const descriptor=Array.isArray(entry.path.paths)?entry.path:{paths:[entry.path]};
          if(effectCache)updateProgress(null,'reading');
          const peaks=await this._loadPcmMix(descriptor,owns,entry.pcmChannel);
          if(!owns())return null;
          if(!peaks?.length)throw new Error('聲道波形檔案無法讀取，請重試');
          if(effectCache&&DESK.audioEffectPeaks){
            try{await DESK.audioEffectPeaks({...effectCache,peaks});}catch(error){console.warn('保存平衡後聲道波形失敗',error);}
            if(!owns())return null;
          }
          entry.peaks=peaks;
          return peaks;
        }
        const url=await DESK.fileURL(entry.path);
        if(!owns()) return null;
        const response=await fetch(url);
        if(!owns()) return null;
        if(response.ok===false)throw new Error('無法讀取波形檔案');
        const buffer=await response.arrayBuffer();
        if(!owns()) return null;
        let peaks=await this.calcFromWavAsync(buffer,0,{channel:entry.pcmChannel,owns});
        if(!owns())return null;
        if(!peaks){
          const ctx=Media.ensureCtx();
          const ab=await ctx.decodeAudioData(buffer.slice(0));
          if(!owns()) return null;
          peaks=this.calcPeaks(ab,entry.pcmChannel??-1);
        }
        if(!owns()) return null;
        entry.peaks=peaks;
        if(key==='mix'&&peaks) this.setSourceMixPeaks(source,peaks,{mixPath:entry.path});
        return peaks;
      }catch(error){
        await Promise.resolve();
        if(!owns()) return null;
        entry.error=error;
        console.warn('source waveform load',error);
        return null;
      }finally{
        if(entry.controller===controller){entry.loading=null;entry.controller=null;}
        if(owns())emit('media:waveform',{controls:true});
      }
    })();
    entry.loading=promise;
    return promise;
  },
  _cancelSourceVocals(state,{clear=false}={}){
    const entry=state?.vocals;
    if(!entry) return;
    state.vocalRevision+=1;
    state.vocalIntent=null;
    state.vocalRestore?.controller.abort();
    state.vocalRestore=null;
    entry.controller?.abort();
    entry.controller=null;
    entry.loading=null;
    entry.percent=0;
    entry.label='';
    if(clear){
      state.vocalRestoreComplete=false;
      state.vocalRestoreKey=null;
      state.vocalChoiceMade=false;
      state.vocals={peaks:null,loading:null,controller:null,percent:0,label:'',error:null};
      if(state.selection==='vocals') state.selection='mix';
    }
  },
  _restoreSourceVocals(source,state){
    if(!state||state.vocalChoiceMade||state.vocalIntent||state.vocals.loading) return;
    const registered=this._registeredSource(source,state);
    // Intake can first register a runtime alias, then add the mother path,
    // duration and stream descriptors. Only a changed lookup retries a cache miss.
    const restoreKey=JSON.stringify([
      registered?._originalPath,registered?.path,registered?.web?.url,
      registered?.dur??registered?.duration,
      registered?.descriptors?.map(item=>item.sourceStream??0),
      State.audioProject?.sourceMaps?.[registered?.audioSourceId]?.channels?.map(item=>item.sourceStream??0),
    ]);
    if((state.vocalRestoreComplete&&state.vocalRestoreKey===restoreKey)||state.vocalRestore?.key===restoreKey) return;
    state.vocalRestore?.controller.abort();
    state.vocalRestoreComplete=false;
    state.vocalRestoreKey=restoreKey;
    const generation=this._generation,revision=state.vocalRevision;
    const controller=new AbortController(),restore={controller,key:restoreKey};
    state.vocalRestore=restore;
    const owns=()=>!controller.signal.aborted&&generation===this._generation&&state.vocalRevision===revision&&
      state.vocalRestore===restore&&[...this.sourceWaveforms.values()].includes(state);
    void (async()=>{
      try{
        const {restoreCachedSourceVocals}=await loadVocalSourceModule();
        if(!owns()||!restoreCachedSourceVocals) return;
        const peaks=await restoreCachedSourceVocals(source,{signal:controller.signal});
        if(!owns()) return;
        // Registration can precede media intake. Retry at a later registration
        // when the cache API could not resolve the mother source yet.
        if(peaks===undefined) return;
        state.vocalRestoreComplete=true;
        if(!(peaks instanceof Float32Array)||!peaks.length) return;
        state.vocals.peaks=peaks;
        state.vocals.percent=100;
        state.vocals.label='已讀取人聲波形快取';
        state.originalSelection=state.selection||'mix';
        state.selection='vocals';
        emit('media:waveform',{controls:true});
      }catch{/* A missing or unreadable cache must keep the original waveform usable. */}
      finally{if(state.vocalRestore===restore) state.vocalRestore=null;}
    })();
  },
  _rememberVocalSelection(source,state,enabled){
    const revision=state.vocalRevision,generation=this._generation;
    return loadVocalSourceModule().then(({rememberSourceVocalSelection})=>{
      if(revision!==state.vocalRevision||generation!==this._generation||
        ![...this.sourceWaveforms.values()].includes(state)) return;
      return rememberSourceVocalSelection?.(source,enabled);
    }).catch(()=>{});
  },
  _prepareVocalSelection(source){
    const state=this._ensureSourceWaveforms(source);
    if(!state) return null;
    state.vocalRevision+=1;
    state.vocalRestore?.controller.abort();
    state.vocalRestore=null;
    // An explicit choice owns the display for this session, including a cache miss.
    state.vocalRestoreComplete=true;
    state.vocalChoiceMade=true;
    if(state.selection!=='vocals') state.originalSelection=state.selection||'mix';
    const request={source,state,generation:this._generation,revision:state.vocalRevision,promise:null};
    state.vocalIntent=request;
    request.promise=this.loadSourceVocals(source);
    return request;
  },
  _ownsVocalIntent(request){
    return !!request&&request.generation===this._generation&&request.state.vocalRevision===request.revision&&
      request.state.vocalIntent===request&&[...this.sourceWaveforms.values()].includes(request.state);
  },
  _commitVocalSelection(request){
    if(!this._ownsVocalIntent(request)||!request.state.vocals.peaks) return;
    request.state.selection='vocals';
    request.state.vocalIntent=null;
    return this._rememberVocalSelection(request.source,request.state,true);
  },
  loadSourceVocals(source){
    const state=this._ensureSourceWaveforms(source);
    if(!state) return Promise.resolve(null);
    const entry=state.vocals;
    if(entry.peaks) return Promise.resolve(entry.peaks);
    if(entry.loading) return entry.loading;
    const controller=new AbortController();
    const generation=this._generation;
    entry.controller=controller;
    entry.error=null;
    entry.percent=0;
    entry.label='準備人聲分離';
    const owns=()=>!controller.signal.aborted&&this._generation===generation&&
      state.vocals===entry&&entry.controller===controller&&
      [...this.sourceWaveforms.values()].some(value=>value===state);
    const promise=(async()=>{
      try{
        const {analyzeSourceVocals}=await loadVocalSourceModule();
        if(!owns()) return null;
        const peaks=await analyzeSourceVocals(source,{
          signal:controller.signal,
          onProgress:({percent,label}={})=>{
            if(!owns()) return;
            entry.percent=Math.min(100,Math.max(0,Math.round(Number(percent)||0)));
            entry.label=label||'分離人聲';
            emit('media:waveform',{controls:true});
          }
        });
        if(!owns()) return null;
        if(!(peaks instanceof Float32Array)||!peaks.length) throw new Error('未取得人聲波形，請重試');
        entry.peaks=peaks;
        entry.percent=100;
        entry.label=entry.label.includes('快取')?'已讀取人聲波形快取':'人聲波形已完成';
        emit('media:waveform',{controls:true});
        return peaks;
      }catch(error){
        if(!owns()) return null;
        entry.error=error;
        state.selection=state.originalSelection||'mix';
        emit('media:waveform',{controls:true});
        throw error;
      }finally{
        if(entry.loading===promise){
          entry.loading=null;
          entry.controller=null;
          emit('media:waveform',{controls:true});
        }
      }
    })();
    entry.loading=promise;
    return promise;
  },
  getSourceWaveform(source,fallbackPeaks=null){
    const state=this._ensureSourceWaveforms(source);
    if(!state) return {peaks:fallbackPeaks||null,selection:'mix',fallback:!!fallbackPeaks};
    const selection=state.selection||'mix';
    if(selection==='vocals'){
      // Only completed, owned results can select the human-voice display.
      return {peaks:state.vocals.peaks,selection,fallback:false,pending:!!state.vocals.loading};
    }
    const wanted=selection==='mix'?state.mix:state.channels.get(selection);
    if(wanted?.peaks) return {peaks:wanted.peaks,selection,fallback:false,pending:!!state.vocalIntent};
    if(wanted&&!wanted.error&&!wanted.controller&&(wanted.path||selection!=='mix'))void this.loadSourceWaveform(source,selection);
    // Until the selected channel is ready, never draw another channel's peaks under its label.
    return {peaks:selection==='mix'?fallbackPeaks:null,selection,fallback:false,pending:!!state.vocalIntent||!!wanted?.loading};
  },
  setSourceWaveSelection(source,selection){
    const state=this._ensureSourceWaveforms(source);
    if(!state) return 'mix';
    const next=this._normaliseSelection(selection);
    if(next==='vocals'){
      const request=this._prepareVocalSelection(source);
      emit('media:waveform',{controls:true});
      return request.promise.then(async()=>{
        const remembered=this._commitVocalSelection(request);
        if(this._ownsVocalIntent(request)) state.vocalIntent=null;
        emit('media:waveform',{controls:true});
        await remembered;
        return state.selection;
      }).catch(error=>{
        if(this._ownsVocalIntent(request)) state.vocalIntent=null;
        emit('media:waveform',{controls:true});
        throw error;
      });
    }
    this._cancelSourceVocals(state);
    state.vocalRestoreComplete=true;
    state.vocalChoiceMade=true;
    if(next!=='cancel-vocals'){
      if(state.selection!==next)this._stopChannelLoad(state.channels.get(state.selection));
      state.selection=next==='mix'||state.channels.has(next)?next:'mix';
      const entry=state.selection==='mix'?state.mix:state.channels.get(state.selection);
      if(entry)entry.error=null;
    }
    void this._rememberVocalSelection(source,state,state.selection==='vocals');
    // 立即重繪 MIX／已快取聲道；尚未解碼的單聲道會在背景載入後再重繪。
    this.getSourceWaveform(source);
    emit('media:waveform',{controls:true});
    return state.selection;
  },
  _stopChannelLoad(entry){
    if(!entry?.controller)return;
    entry.controller.abort();
    entry.controller=null;
    entry.loading=null;
    entry.progress=null;
  },
  forgetSourceWaveforms(source){
    const state=this._sourceState(source,false);
    if(!state) return;
    this.liveElementSources.delete(state.runtimeSourceId);
    this._cancelSourceVocals(state,{clear:true});
    for(const entry of state.channels.values())this._stopChannelLoad(entry);
    for(const [key,value] of this.sourceWaveforms){ if(value===state) this.sourceWaveforms.delete(key); }
  },

  registerSources(wavePath, channels, sourceId='video'){
    this.sources=[];
    if(wavePath) this.sources.push({label:'主混音',path:wavePath,peaks:this.peaks, sourceId,kind:'mix',sourceKey:sourceId});
    (channels||[]).forEach((ch,i)=>{
      const desc=this._channelDescriptor(ch,i);
      this.sources.push({
        label:ch.label||('音軌 '+(i+1)),path:ch.file,peaks:null,sourceId,
        kind:'channel',sourceKey:sourceId,sourceStream:desc.sourceStream,sourceChannel:desc.sourceChannel
      });
    });
    this.registerSourceWaveforms(sourceId,{mixPath:wavePath,mixPeaks:this.peaks,channels});
    this.srcIdx=0;
    emit('media:srcSel');
  },
  async selectSource(idx){
    if(idx<0||idx>=this.sources.length) return;
    this.srcIdx=idx;
    const src=this.sources[idx];
    if(src?.sourceKey||src?.sourceId){
      this.setSourceWaveSelection(src.sourceKey||src.sourceId,src.kind==='channel'
        ? this._channelKey(src.sourceStream||0,src.sourceChannel||0) : 'mix');
    }
    if(src.peaks){ this.peaks=src.peaks; emit('media:waveform',{controls:true}); return; }
    if(!DESK||!AudioEngine.isReady) return;
    const generation=this._generation;
    const owns=()=>this._generation===generation&&this.srcIdx===idx&&this.sources[idx]===src;
    try{
      const wavUrl = await DESK.fileURL(src.path);
      if(!owns()) return;
      const res = await fetch(wavUrl);
      if(!owns()) return;
      const buf = await res.arrayBuffer();
      if(!owns()) return;
      const ab=await AudioEngine.decodeAudioData(buf);
      if(!owns()) return;
      const peaks=this.calcPeaks(ab);
      if(!owns()) return;
      this.live=false; this.peaks=peaks;
      src.peaks=peaks;
      emit('media:waveform',{controls:true});
    }catch(e){ if(owns()) console.warn('wave selectSource',e); }
  },
  clearSources({keep=[]}={}){
    const retained=new Set(keep.map(source=>this._sourceState(source)).filter(Boolean));
    if(!retained.size) this._generation+=1;
    for(const state of new Set(this.sourceWaveforms.values())) if(!retained.has(state)){
      this.liveElementSources.delete(state.runtimeSourceId);
      this._cancelSourceVocals(state,{clear:true});
      for(const entry of state.channels.values())this._stopChannelLoad(entry);
    }
    for(const [key,state] of this.sourceWaveforms) if(!retained.has(state)) this.sourceWaveforms.delete(key);
    this.sources=[]; this.srcIdx=-1; emit('media:srcSel');
  },
  fromFile(file,source='video',options={}){
    // A batch can import many files before the first decode releases its PCM.
    const decode=()=>this._decodeFile(file,source,options);
    const work=pendingFileDecode?pendingFileDecode.then(decode,decode):decode();
    pendingFileDecode=work;
    return work.finally(()=>{ if(pendingFileDecode===work) pendingFileDecode=null; });
  },
  async _decodeFile(file,source,{owns=()=>true}){
    const currentSource=()=>{
      if(!source||typeof source!=='object') return source;
      if(Media.externalAudioSources.includes(source)) return source;
      return Media._liveClipForSource(source);
    };
    const sourceIsCurrent=()=>{
      if(!owns()) return false;
      if(!source||typeof source!=='object') return true;
      return !!currentSource();
    };
    if(!sourceIsCurrent()) return false;
    Media.ensureCtx();
    const buf=await readFile(file);
    if(!sourceIsCurrent()) return false;
    const ab=await AudioEngine.decodeSourceAudioData(buf,{file,owns:sourceIsCurrent});
    if(!sourceIsCurrent()) return false;
    // 波形使用完整來源時間；時間軸長度由 trim/offset 的 owner 決定。
    if(source&&typeof source==='object') Media.recomputeTimelineDuration?.();
    else if(ab.duration>State.duration){State.duration=ab.duration;emit('duration:known');}
    if(!sourceIsCurrent()) return false;
    this.setSourceBuffer(currentSource(),ab); emit('media:waveform',{controls:true});
    setMediaProcessingStatus('波形已產生','ok');
    return true;
  },
  async fromVideoElement(){ /* fallback：無法解碼時略過 */ },
  live:false,
  initLive(){ // 為長片配置空波形，播放時逐桶填入
    const primary=Seq.primary();
    const len=Math.ceil(Math.max(primary?.dur||State.duration,1)*this.resolution);
    this.peaks=new Float32Array(len*2); this.live=true;
    // 這裡只初始化主播放器的即時波形；其他仍在時間軸上的來源不隨之重設。
    this.clearSources({keep:[...State.clips,...Media.externalAudioSources]});
    emit('media:waveform',{controls:true});
    if(!Media.audioPanelState().notice&&!Media.audioPanelState().extraction) $('atHint').textContent='播放以逐步產生波形（或載入音訊檔）';
  },
  prepareLiveSource(source,duration){
    if(!(duration>0) || !Number.isFinite(duration)) return;
    const state=this._sourceState(source,true);
    if(state && !state.mix.peaks) this.liveElementSources.set(state.runtimeSourceId,{state,duration});
  },
  captureLive(){ // 由 rafLoop 於播放時呼叫
    if(this.live&&this.peaks) this._captureBuckets(this.peaks,Media.liveWaveSourceTime(),'video');
    if(!this.liveElementSources.size) return;
    for(const [id,time] of Media.liveElementWaveTimes(this.liveElementSources)){
      if(time==null) continue;
      const {state,duration}=this.liveElementSources.get(id);
      state.mix.peaks ||= new Float32Array(2*Math.ceil(duration*this.resolution));
      this._captureBuckets(state.mix.peaks,time,id);
    }
  },
  _captureBuckets(peaks,t,source){
    if(t==null) return;
    const buf=AudioEngine.readTimeDomain({source}); if(!buf) return;
    let mn=0,mx=0; for(let i=0;i<buf.length;i++){const v=buf[i]; if(v<mn)mn=v; if(v>mx)mx=v;}
    const b=Math.floor(t*this.resolution);
    const n=peaks.length/2;
    // 寫入目前時間附近的桶（analyser 視窗約涵蓋數桶）
    for(let k=b;k<=b+2 && k<n;k++){
      if(mn<peaks[k*2])peaks[k*2]=mn;
      if(mx>peaks[k*2+1])peaks[k*2+1]=mx;
    }
  },
  /* 純計算版（不改 this.peaks）：影片序列的每段 clip 各自持有 peaks 時使用 */
  calcPeaks(ab, chIdx = -1){
    // A decoded source may contain several streams. Use their original PCM,
    // not the first Mono runtime track, and keep shorter streams silent at tail.
    const buffers=Array.isArray(ab)?ab:[ab];
    const res=this.resolution;
    const duration=Math.max(0,...buffers.map(buffer=>buffer.duration));
    const sampleRate=Math.max(1,...buffers.map(buffer=>buffer.sampleRate));
    const len=Math.ceil(duration*res);
    const peaks=new Float32Array(len*2);
    const chData = [];
    for(const buffer of buffers){
      const channels=chIdx===-1?Array.from({length:buffer.numberOfChannels},(_,index)=>index):[chIdx];
      for(const channel of channels)chData.push({data:buffer.getChannelData(channel),ratio:buffer.sampleRate/sampleRate});
    }
    const spb=sampleRate/res; // samples per bucket
    for(let i=0;i<len;i++){
      const s0=Math.floor(i*spb), s1=Math.min(Math.ceil(duration*sampleRate),Math.floor((i+1)*spb));
      let mn=0,mx=0;
      for(let j=s0;j<s1;j++){
        let v=0;
        for(const channel of chData) v += channel.data[channel.ratio===1?j:Math.floor(j*channel.ratio)]||0;
        if (chData.length > 1) v /= chData.length;
        if(v<mn)mn=v; if(v>mx)mx=v;
      }
      peaks[i*2]=mn; peaks[i*2+1]=mx;
    }
    return peaks;
  },
  compute(ab, chIdx = -1){
    const peaks=this.calcPeaks(ab, chIdx);
    this.peaks=peaks;
    return peaks;
  },
  computeFromWav(arrayBuffer){
    const pk = this.calcFromWav(arrayBuffer);
    if(pk) this.peaks = pk;
    return pk;
  },
  // 優先來源波形必須覆蓋宣稱的整段；一般多軌混音仍允許較短音軌補零。
  calcSourceWaveform(arrayBuffer,duration){
    if(!sourceWavePcm(arrayBuffer,duration))return null;
    return this.calcFromWav(arrayBuffer,duration);
  },
  async calcSourceWaveformAsync(arrayBuffer,duration,{owns=()=>true}={}){
    if(!owns())return null;
    const pcm=sourceWavePcm(arrayBuffer,duration);
    return pcm?finishPcmPeaks(pcmPeakCalculation([pcm],duration,this.resolution,null),owns):null;
  },
  async calcFromWavAsync(arrayBuffer,duration=0,{channel=null,owns=()=>true}={}){
    if(!owns())return null;
    const streams=(Array.isArray(arrayBuffer)?arrayBuffer:[arrayBuffer]).map(wavePcm);
    return finishPcmPeaks(pcmPeakCalculation(streams,duration,this.resolution,channel),owns);
  },
  /* 純計算版（不改 this.peaks） */
  calcFromWav(arrayBuffer,duration=0,channel=null){
    const streams=(Array.isArray(arrayBuffer)?arrayBuffer:[arrayBuffer]).map(wavePcm);
    const calculation=pcmPeakCalculation(streams,duration,this.resolution,channel);
    if(!calculation)return null;
    calculation.fill(0,calculation.len);
    return calculation.peaks;
  },
  async preparePcmMix(paths,{duration=0,owns=()=>true,onProgress}={}){
    // A reload descriptor represents original PCM members, never already
    // reduced extrema. Copy/freeze it so callers cannot change an active mix.
    const path=Object.freeze({paths:Object.freeze([...paths]),duration:Math.max(0,Number(duration)||0)});
    const peaks=await this._loadPcmMix(path,owns,null,onProgress);
    return owns()?{path,peaks}:null;
  },
  async _loadPcmMix(descriptor,owns,channel=null,onProgress){
    // 平衡後的多聲道波形可達數 GB。先讀 FFmpeg 產生的 WAV header，
    // 只為當前這一批時間桶讀取各串流對應的樣本。
    const inputs=[];
    for(const path of descriptor.paths){
      if(!owns())return null;
      const url=await DESK.fileURL(path);
      if(!owns())return null;
      const response=await fetch(url,{headers:{Range:'bytes=0-65535'}});
      if(!owns())return null;
      if(response.ok===false)throw new Error('無法讀取波形檔案');
      const buffer=await response.arrayBuffer();
      if(!owns())return null;
      const info=pcmWaveHeader(buffer);
      if(!info)return null;
      const complete=info.start+info.length*info.channels*2<=buffer.byteLength;
      if(!complete && response.status!==206)throw new Error('波形檔案不完整');
      inputs.push({...info,url,firstFrame:0,buffer:complete?buffer:null});
    }
    if(inputs.every(input=>input.buffer))
      return this.calcFromWavAsync(inputs.map(input=>input.buffer),descriptor.duration,{channel,owns});
    const res=this.resolution, calc=pcmPeakCalculation(inputs,descriptor.duration,res,channel);
    if(!calc)return null;
    const bytesPerBucket=inputs.reduce((sum,s)=>sum+2*s.channels*Math.ceil(s.sampleRate/res),0);
    const step=Math.max(1,Math.floor(1024*1024/bytesPerBucket));
    for(let first=0; first<calc.len; first+=step){
      if(!owns())return null;
      const last=Math.min(calc.len,first+step);
      for(const input of inputs){
        if(input.buffer){
          input.samples ||= new Int16Array(input.buffer,input.start,input.length*input.channels);
          continue;
        }
        const startSample=Math.floor(first*(calc.sampleRate/res));
        const stopSample=Math.floor(last*(calc.sampleRate/res));
        const begin=Math.min(input.length,Math.floor(startSample*input.sampleRate/calc.sampleRate));
        const end=Math.min(input.length,Math.ceil(stopSample*input.sampleRate/calc.sampleRate));
        if(end<=begin)continue;
        const startByte=input.start+begin*input.channels*2, byteCount=(end-begin)*input.channels*2;
        const response=await fetch(input.url,{headers:{Range:`bytes=${startByte}-${startByte+byteCount-1}`}});
        if(!owns())return null;
        if(response.status!==206)throw new Error('無法分段讀取波形檔案');
        const bytes=await response.arrayBuffer();
        if(!owns())return null;
        if(bytes.byteLength!==byteCount)throw new Error('波形檔案不完整');
        input.firstFrame=begin;
        input.samples=new Int16Array(bytes);
      }
      calc.fill(first,last);
      onProgress?.(last/calc.len);
    }
    return owns()?calc.peaks:null;
  }
};

