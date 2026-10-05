import { State, DESK } from './state.js';
import { emit } from './events.js';
import { readFile } from './util.js';
import { AudioEngine } from './audio-engine.js';
import { AudioPipeline } from './audio-routing-engine.js';
import { Media } from './media.js';
import { $, video } from './dom.js';
import { setStatus } from './ui.js';

export const WAVE_DECODE_MAX = 5e8;    // 超過此大小不整檔解碼波形，改即時擷取

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
    if(!state||state.channels.size) return state;
    const key=this._sourceKey(source);
    const runtime=this._runtimeSourceKey(source);
    const channels=[];
    // 已就緒的播放 track 最可靠：它們同時帶著 sourceStream/sourceChannel 與 cache file。
    for(const track of Media.tracks||[]){
      if((track.audioSourceId&&String(track.audioSourceId)===key)||
        (!key&&runtime&&(track.source||'')===runtime)){
        channels.push({
          sourceStream:track.sourceStream,
          sourceChannel:track.sourceChannel,
          label:track.name,
          file:track.file,
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
      // A new file or supplied peaks supersedes any in-flight decode for the old entry.
      state.mix={path:nextMixPath,peaks:nextMixPath===state.mix.path?state.mix.peaks:null,loading:null};
    }
    if(mixPeaks&&mixPeaks.length) state.mix.peaks=mixPeaks;
    if(Array.isArray(channels)){
      for(let index=0;index<channels.length;index++){
        const raw=channels[index]||{};
        const desc=this._channelDescriptor(raw,index);
        const old=state.channels.get(desc.key);
        const nextPath=raw.file||raw.path||old?.path||null;
        const nextPeaks=raw.peaks||null;
        if(!old||nextPath!==old.path||(nextPeaks&&nextPeaks!==old.peaks)){
          state.channels.set(desc.key,{
            ...desc,
            label:raw.label||old?.label||`Ch ${desc.sourceChannel+1}`,
            path:nextPath,
            peaks:nextPeaks||(nextPath===old?.path?old?.peaks:null)||null,
            loading:null
          });
        }else old.label=raw.label||old.label||`Ch ${desc.sourceChannel+1}`;
      }
    }
    this._restoreSourceVocals(source,state);
    return state;
  },
  setSourceMixPeaks(source,peaks,{mixPath,channels}={}){
    const state=this.registerSourceWaveforms(source,{mixPath,mixPeaks:peaks,channels});
    if(!state) return peaks||null;
    this.live=false;
    const runtime=this._runtimeSourceKey(source);
    if(!this.peaks||runtime===Media.activeSource||(!Media.activeSource&&runtime==='video')) this.peaks=peaks;
    return peaks||null;
  },
  setSourceBuffer(source,ab,{channels}={}){
    if(!ab) return null;
    const mixPeaks=this.calcPeaks(ab,-1);
    const supplied=Array.isArray(channels)?channels:null;
    const channelInfo=[];
    for(let index=0;index<ab.numberOfChannels;index++){
      const raw=supplied?.[index]||{};
      const desc=this._channelDescriptor(raw,index);
      channelInfo.push({
        ...raw,
        ...desc,
        label:raw.label||`Ch ${desc.sourceChannel+1}`,
        peaks:this.calcPeaks(ab,index)
      });
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
        ready:!!item.peaks
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
    emit('media:timeline');
    return Promise.all(requests.map(request=>request?.promise)).then(async()=>{
      const remembered=[];
      if(requests.every(request=>this._ownsVocalIntent(request)&&request.state.vocals.peaks)){
        for(const request of requests) remembered.push(this._commitVocalSelection(request));
      }else{
        for(const request of requests) if(this._ownsVocalIntent(request)) this._cancelSourceVocals(request.state);
      }
      emit('media:timeline');
      await Promise.all(remembered);
      return unique.map(source=>this.getSourceWaveSelection(source));
    }).catch(error=>{
      for(const request of requests) if(this._ownsVocalIntent(request)) this._cancelSourceVocals(request.state);
      emit('media:timeline');
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
    if(!entry.path||!DESK?.fileURL) return null;
    const generation=this._generation;
    const owns=()=>this._generation===generation&&
      [...this.sourceWaveforms.values()].some(value=>value===state)&&
      (key==='mix'?state.mix===entry:state.channels.get(key)===entry);
    const promise=(async()=>{
      try{
        const url=await DESK.fileURL(entry.path);
        if(!owns()) return null;
        const response=await fetch(url);
        if(!owns()) return null;
        const buffer=await response.arrayBuffer();
        if(!owns()) return null;
        let peaks=this.calcFromWav(buffer);
        if(!peaks){
          const ctx=Media.ensureCtx();
          const ab=await ctx.decodeAudioData(buffer.slice(0));
          if(!owns()) return null;
          peaks=this.calcPeaks(ab,-1);
        }
        if(!owns()) return null;
        entry.peaks=peaks;
        if(key==='mix'&&peaks) this.setSourceMixPeaks(source,peaks,{mixPath:entry.path});
        emit('media:timeline');
        return peaks;
      }catch(error){
        if(!owns()) return null;
        console.warn('source waveform load',error);
        return null;
      }finally{ if(entry.loading===promise) entry.loading=null; }
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
    const registered=source&&typeof source==='object'?source:
      [...(State.clips||[]),...(Media.externalAudioSources||[])].find(item=>
        this._sourceKey(item)===state.key||this._runtimeSourceKey(item)===state.runtimeSourceId);
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
        emit('media:timeline');
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
            emit('media:timeline');
          }
        });
        if(!owns()) return null;
        if(!(peaks instanceof Float32Array)||!peaks.length) throw new Error('未取得人聲波形，請重試');
        entry.peaks=peaks;
        entry.percent=100;
        entry.label=entry.label.includes('快取')?'已讀取人聲波形快取':'人聲波形已完成';
        emit('media:timeline');
        return peaks;
      }catch(error){
        if(!owns()) return null;
        entry.error=error;
        state.selection=state.originalSelection||'mix';
        emit('media:timeline');
        throw error;
      }finally{
        if(entry.loading===promise){
          entry.loading=null;
          entry.controller=null;
          emit('media:timeline');
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
    // 選擇的 cache 尚未讀取時仍先畫 MIX，避免時間軸空白；非同步完成後自行重繪。
    if(wanted?.path) void this.loadSourceWaveform(source,selection);
    const mix=state.mix.peaks||fallbackPeaks||null;
    return {peaks:mix,selection,fallback:selection!=='mix'&&!!mix,pending:!!state.vocalIntent||!!wanted?.path};
  },
  setSourceWaveSelection(source,selection){
    const state=this._ensureSourceWaveforms(source);
    if(!state) return 'mix';
    const next=this._normaliseSelection(selection);
    if(next==='vocals'){
      const request=this._prepareVocalSelection(source);
      emit('media:timeline');
      return request.promise.then(async()=>{
        const remembered=this._commitVocalSelection(request);
        if(this._ownsVocalIntent(request)) state.vocalIntent=null;
        emit('media:timeline');
        await remembered;
        return state.selection;
      }).catch(error=>{
        if(this._ownsVocalIntent(request)) state.vocalIntent=null;
        emit('media:timeline');
        throw error;
      });
    }
    this._cancelSourceVocals(state);
    state.vocalRestoreComplete=true;
    state.vocalChoiceMade=true;
    if(next!=='cancel-vocals') state.selection=next==='mix'||state.channels.has(next)?next:'mix';
    void this._rememberVocalSelection(source,state,state.selection==='vocals');
    // 立即重繪 MIX／已快取聲道；尚未解碼的單聲道會在背景載入後再重繪。
    this.getSourceWaveform(source);
    emit('media:timeline');
    return state.selection;
  },
  forgetSourceWaveforms(source){
    const state=this._sourceState(source,false);
    if(!state) return;
    this._cancelSourceVocals(state,{clear:true});
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
  setFromBuffer(ab, sourceId = 'video') {
    this.sources = this.sources.filter(s => s.sourceId !== sourceId);
    const mixPeaks = this.compute(ab, -1);
    const sourceChannels=[];
    this.sources.push({ label: '主混音', path: null, peaks: mixPeaks, sourceId,kind:'mix',sourceKey:sourceId });
    for(let i=0; i<ab.numberOfChannels; i++){
      const chPeaks = this.compute(ab, i);
      sourceChannels.push({sourceStream:0,sourceChannel:i,label:'音軌 '+(i+1),peaks:chPeaks});
      this.sources.push({ label: '音軌 ' + (i+1), path: null, peaks: chPeaks, sourceId,
        kind:'channel',sourceKey:sourceId,sourceStream:0,sourceChannel:i });
    }
    this.registerSourceWaveforms(sourceId,{mixPeaks,channels:sourceChannels});
    this.live = false;
    this.peaks = mixPeaks;
    this.srcIdx = this.sources.findIndex(s => s.sourceId === sourceId);
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
    if(src.peaks){ this.peaks=src.peaks; emit('media:timeline'); return; }
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
      emit('media:timeline');
    }catch(e){ if(owns()) console.warn('wave selectSource',e); }
  },
  clearSources(){
    this._generation+=1;
    for(const state of new Set(this.sourceWaveforms.values())) this._cancelSourceVocals(state,{clear:true});
    this.sources=[]; this.srcIdx=-1; this.sourceWaveforms.clear(); emit('media:srcSel');
  },
  async fromFile(file,source='video',{owns=()=>true}={}){
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
    const ab=await AudioEngine.decodeAudioData(buf.slice(0));
    if(!sourceIsCurrent()) return false;
    // 波形使用完整來源時間；時間軸長度由 trim/offset 的 owner 決定。
    if(source&&typeof source==='object') Media.recomputeTimelineDuration?.();
    else if(ab.duration>State.duration){State.duration=ab.duration;emit('duration:known');}
    if(!sourceIsCurrent()) return false;
    this.setSourceBuffer(currentSource(),ab); emit('media:timeline');
    setStatus('波形已產生','ok');
    return true;
  },
  async fromVideoElement(){ /* fallback：無法解碼時略過 */ },
  live:false,
  initLive(){ // 為長片配置空波形，播放時逐桶填入
    const len=Math.ceil(Math.max(State.duration,1)*this.resolution);
    this.peaks=new Float32Array(len*2); this.live=true;
    this.clearSources();
    emit('media:timeline');
    if(!Media.audioPanelNotice) $('atHint').textContent='播放以逐步產生波形（或載入音訊檔）';
  },
  captureLive(){ // 由 rafLoop 於播放時呼叫
    if(!this.live||!this.peaks)return;
    // 序列：Wave.peaks 屬主媒體來源（來源時間索引）；非主媒體片段播放中或間隙時不得寫入（會污染波形）。
    // 主媒體切割出的片段（audioSrc==='video'）寫入是正確的——同一來源、同一索引域。
    if(Media.seqOn()){ const c=Media._activeClip(); if(Media._gap || !c || (c.audioSrc||(c.primary?'video':''))!=='video') return; }
    const buf=AudioEngine.readTimeDomain(); if(!buf) return;
    let mn=0,mx=0; for(let i=0;i<buf.length;i++){const v=buf[i]; if(v<mn)mn=v; if(v>mx)mx=v;}
    const t=video.currentTime||0; const b=Math.floor(t*this.resolution);
    const n=this.peaks.length/2;
    // 寫入目前時間附近的桶（analyser 視窗約涵蓋數桶）
    for(let k=b;k<=b+2 && k<n;k++){
      if(mn<this.peaks[k*2])this.peaks[k*2]=mn;
      if(mx>this.peaks[k*2+1])this.peaks[k*2+1]=mx;
    }
  },
  fromTracks(){
    const b=Media.tracks.find(t=>t.kind==='buffer'); 
    if(b){ Wave.setFromBuffer(b.buffer, 'video'); emit('media:timeline'); }
  },
  /* 純計算版（不改 this.peaks）：影片序列的每段 clip 各自持有 peaks 時使用 */
  calcPeaks(ab, chIdx = -1){
    const res=this.resolution;
    const len=Math.ceil(ab.duration*res);
    const peaks=new Float32Array(len*2);
    const chData = [];
    if (chIdx === -1) {
      for(let c=0; c<ab.numberOfChannels; c++) chData.push(ab.getChannelData(c));
    } else {
      chData.push(ab.getChannelData(chIdx));
    }
    const spb=ab.sampleRate/res; // samples per bucket
    for(let i=0;i<len;i++){
      const s0=Math.floor(i*spb), s1=Math.min(chData[0].length,Math.floor((i+1)*spb));
      let mn=0,mx=0;
      for(let j=s0;j<s1;j++){
        let v=0;
        for(let c=0; c<chData.length; c++) v += chData[c][j];
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
  /* 純計算版（不改 this.peaks） */
  calcFromWav(arrayBuffer){
    const view = new DataView(arrayBuffer);
    if(view.byteLength < 44 || view.getUint32(0, false) !== 0x52494646) return null;
    const numChannels = view.getUint16(22, true);
    const sampleRate = view.getUint32(24, true);
    let offset = 12;
    while(offset < view.byteLength) {
      const chunkId = view.getUint32(offset, false);
      const chunkSize = view.getUint32(offset + 4, true);
      if(chunkId === 0x64617461) { offset += 8; break; }
      offset += 8 + chunkSize;
    }
    const samples = new Int16Array(arrayBuffer, offset, Math.floor((arrayBuffer.byteLength - offset)/2));
    const numSamples = samples.length / numChannels;
    const res = this.resolution;
    const len = Math.ceil((numSamples / sampleRate) * res);
    const peaks = new Float32Array(len * 2);
    const spb = sampleRate / res;
    for(let i=0; i<len; i++){
      const s0 = Math.floor(i * spb);
      const s1 = Math.min(numSamples, Math.floor((i+1) * spb));
      let mn = 0, mx = 0;
      for(let j=s0; j<s1; j++){
        let v = 0;
        for(let c=0; c<numChannels; c++) v += samples[j * numChannels + c];
        v = (v / numChannels) / 32768.0;
        if(v < mn) mn = v;
        if(v > mx) mx = v;
      }
      peaks[i*2] = mn; peaks[i*2+1] = mx;
    }
    return peaks;
  }
};

