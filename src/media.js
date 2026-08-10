/* ==============================================================================
   SUB Tool — 媒體播放引擎與音訊路由模組 (Media Engine)
   ==============================================================================
   
   【架構與職責總覽】
   本檔案 (media.js) 是本專案最核心、最龐大的模組，主要負責以下三大領域：
   
   1. 雙重播放引擎 (Dual-Engine Playback)
      為了兼顧 Web 的輕量以及專業級編碼 (如 MXF, 10-bit ProRes) 的支援，
      本模組會動態決定使用底層 Chromium 的 HTMLMediaElement 或是透過 IPC
      喚起 `mpv` 作為原生子視窗進行渲染。兩者皆統一抽象為 Media API，對上層
      (如時間軸、字幕操作) 隱藏底層差異。
      
   2. 時間同步機制 (Time Synchronization)
      因為音訊、影片、以及 mpv IPC 都有各自的時間來源，
      本模組使用 `requestAnimationFrame` 與定期 Tick，將這三者的時間軸
      強制對齊。所有的 `currentTime` 必須經由 `sequence.js` 轉換為
      「來源時間 (Source Time)」後，才能餵給底層播放器，以實現影片裁切
      (In/Out) 與偏移 (Offset) 的視覺連貫。
      
   3. 多軌音訊與匯流排 (Web Audio API Routing & Bus)
      為了讓使用者能在一條時間軸上排列多支影片並對其音軌進行混音，
      本檔案建立了一套 AudioContext 的連線圖 (Audio Graph)。
      將不同的音訊來源 (AudioSourceNode) 映射至各匯流排 (AudioBusNode)，
      並最終輸出。同時，這也為波形 (Waveform) 的繪製提供了 PCM 資料來源。

   【維護鐵律】
   - 所有牽涉播放頭時間的操作，請務必先釐清目前變數是「專案全局時間軸」還是
     「該片段的影片來源時間」。這兩者的轉換請統一呼叫 sequence 模組的方法，
     千萬不要在此檔案內手刻算式。
============================================================================== */
let _extTrackIdCounter = 0; // Fix #6：全域遞增序號取代 Date.now()+i，避免同毫秒碰撞
import { AudioEngine } from './audio-engine.js';
import { AudioPipeline } from './audio-pipeline.js';
import { State, DESK, setFps, snapFps, ensureVideoTrackCount, resetVideoTracks, ensureAudioSourceMap, deselect } from './state.js';
import { getPlayerAdapter, setPlayerAdapter, Html5Adapter, MpvAdapter } from './media-player-adapter.js';
import { secToEncore, snapTimeToFrame } from './time.js';
import { $, video } from './dom.js';
import { clamp, readFile, b64ToBytes, baseName, escapeHTML } from './util.js';
import { ExternalAudioLibrary, makeAudioSourceId, sourceChannelDescriptors, serializeAsset } from './external-audio.js';
import { MediaIntakeSession, waitForOwnedMediaMetadata } from './media-intake-session.js';
import { ResetEpoch } from './reset-epoch.js';
import { clipSourceFingerprint, liveClipForSource } from './media-source-lease.js';
import { createProjectAudioInterpretation } from './project-audio.js';
import { emit, on } from './events.js';
import { fadeAlphaAtTimeline } from './clip-fade.js';   // 淡入淡出：預覽與匯出共用同一份規格
import { sourceChannelLabels } from './channel-layout.js'; // 來源聲道展開順序：與主程序 ingest 同一份約定
import { setStatus, showToast, openModal, closeModal } from './ui.js';
import { Seq } from './sequence.js';
import { TimelineTransport } from './timeline-transport.js';
import { loadDesktopMedia, _expandChannels, _loadViaMpv, loadVideoFile, canPlayNatively, webAudioCapabilityNotice, FFMPEG_MAX_BYTES, WEB_LARGE_NATIVE_AUDIO_NOTICE, WEB_LARGE_UNSUPPORTED_MEDIA_NOTICE } from './loaders/media-loader.js';

/* 專案音訊路由使用的持久來源 ID。audioSrc 仍保留給既有播放同步（video / clip:<id>），
   但它會隨本次載入的 clip id 改變，因此不能拿來儲存聲道配線。 */
/* id 產生與聲道座標的正規化與外部音訊素材共用，實作在 external-audio.js。 */
function audioSourceIdForClip(c){
  if(!c) return null;
  if(!c.audioSourceId) c.audioSourceId=makeAudioSourceId();
  return c.audioSourceId;
}
export function probeAudioChannelDescriptors(audio){
  const out=[];
  (audio||[]).forEach((stream,sourceStream)=>{
    const count=Math.max(0,Math.floor(Number(stream?.channels)||0));
    for(let sourceChannel=0;sourceChannel<count;sourceChannel++) out.push({sourceStream,sourceChannel});
  });
  return out;
}

/* ===== 播放窗：自動偵測 FPS（網頁版，播放時取樣） =====
   FPS-SYNC：影格率一律【實測】——這裡用 requestVideoFrameCallback 量真實影格時間戳，
   桌面版則用 ffprobe（DESK.probe → info.video.fps）。【絕不可依檔名判斷 FPS】，
   因為檔名可能寫錯（例：標 24FPS 實為 29.97）。詳見 FPS_時碼一致性.md。 */
export function detectFpsWeb(owns=()=>true){
  if(!('requestVideoFrameCallback' in HTMLVideoElement.prototype))return;
  let last=null, deltas=[], frames=0;
  const cb=(now,meta)=>{
    if(!owns()) return;
    if(last!=null){ const d=meta.mediaTime-last; if(d>0.0005)deltas.push(d); }
    last=meta.mediaTime; frames++;
    if(deltas.length<12 && frames<60){ try{ if(owns()) video.requestVideoFrameCallback(cb); }catch(e){} return; }
    if(deltas.length>=6){ deltas.sort((a,b)=>a-b); const med=deltas[deltas.length>>1]; const raw=1/med;
      // 不可先 Math.round：整數化會把 29.97→30、23.976→24，毀掉 NTSC 分數影格率的偵測；
      // 直接把實測值交給 snapFps 對齊到支援集合（23.976/24/25/29.97/30）
      if(raw>=10&&raw<=120&&owns()){ const fps=snapFps(raw); setFps(String(fps)); // 經 setFps 統一處理：偵測到的影格率一律視為非 Drop-frame，清除殘留的 dropFrame
        setStatus('偵測到影片 FPS：'+fps,'ok'); } }
  };
  try{ if(owns()) video.requestVideoFrameCallback(cb); }catch(e){}
}

/* 圖片原始像素尺寸（v4.7）。互動框要貼合 contain 之後的圖片本體，沒有這組數字
   就只能退回「整個畫框」＝把手離素材老遠、下緣還會被播放列蓋住。
   還原專案時 geo 已帶著存檔值，直接沿用不必再解一次。 */
export function probeImageSize(url, geo = null){
  const gw = Number(geo?.natW), gh = Number(geo?.natH);
  if(gw > 0 && gh > 0) return Promise.resolve({ w:gw, h:gh });
  return new Promise(res => {
    let done = false;
    const finish = (w, h) => { if(done) return; done = true; res({ w: w || 0, h: h || 0 }); };
    const im = new Image();
    im.onload = () => finish(im.naturalWidth, im.naturalHeight);
    im.onerror = () => finish(0, 0);      // 讀不到不擋匯入：app.js 之後還會再補量一次
    setTimeout(() => finish(im.naturalWidth, im.naturalHeight), 4000);
    im.src = url;
  });
}

/* 圖片預設落在哪一條視訊軌（v4.7）。
   舊行為是「每匯入一張就 State.videoTracks.length ＝永遠開新軌」，而視訊軌只增不減，
   匯入十張圖就多十條軌。改成：由上往下找一條「只放圖片、且此時段沒有東西」的軌重用，
   真的都被占用才開新軌。
   ── 不可與影片段共軌：匯出是每軌各自 concat 成一條時間軸，同軌重疊會讓 cursor 倒退。 */
function pickImageTrack(c){
  const start = c.offset, end = c.offset + Math.max(0.001, (c.out ?? 0) - (c.in ?? 0));
  for(let v = State.videoTracks.length - 1; v >= 0; v--){
    const on = State.clips.filter(x => x !== c && (x.vtrack || 0) === v);
    if(on.some(x => x.type !== 'image')) continue;                       // 有影片段 → 跳過
    const busy = on.some(x => x.offset < end - 1e-4 && Seq.clipEnd(x) > start + 1e-4);
    if(!busy) return v;
  }
  return State.videoTracks.length;
}

/* ===== 3. 媒體引擎 ==================================================== */
const Media = {
  // AudioContext 與引擎封裝在 AudioEngine 中，這裡不再維護 ctx 等細節。
  master:null,         // master gain
  videoSrcNode:null,   // MediaElementSource (原生單軌)
  tracks:[],           // {id,name,kind:'native'|'buffer',buffer?,gain,muted,solo,volume,srcNode?,offset}
  playing:false,
  startCtxTime:0,      // ctx.currentTime 對應播放起點
  startMediaTime:0,    // 對應 media 時間
  usingWebAudio:false, // 是否用 Web Audio 混音（多軌）
  ffmpeg:null, ffmpegLoading:null,
  // ffmpeg.wasm exposes one worker, logger, and virtual filesystem.  Every
  // command using that instance must enter this lane; otherwise an old probe
  // can overwrite a current transcode's in.media or logger mid-run.
  _webFfmpegTail:Promise.resolve(),
  objectURLs:[],
  mpvMode:false, _mpvTime:0, _mpvDuration:0, _bgVersion:0,
  /* mpv 畫面接管旗標：true＝WebCodecs 已接管、mpv 視窗讓位。
     這個旗標曾被搬到 WebCodecsAdapter.compositing，但那個 wrapper 在生產環境
     【從來沒有被裝上】——9 個 setPlayerAdapter() 呼叫點全部裝裸 adapter，
     唯一會產生 wrapper 的 resetPlayerAdapter() 只有測試在呼叫。
     結果 setCompositing() 是 undefined、呼叫時丟 TypeError 被 try/catch 吞掉，
     而 mpvPresenting() 讀 `!undefined` → mpv 模式下【永遠回 true】。
     旗標的家在這裡，公開入口是 webCodecsTakeover() / setWebCodecsTakeover()。 */
  _wcTakeover:false,
  _intakeSession:new MediaIntakeSession(),
  _assetEpoch:new ResetEpoch(),
  // Pending project restoration and History can touch the same sequence while
  // filesystem work is still in flight. This monotonic generation makes that
  // ownership boundary explicit without tying source work to one clip object.
  _sequenceEditVersion:0,
  _externalRestoreVersion:0,
  _externalAssetEditVersions:new WeakMap(),
  _assetOperation(operation, identity=null, upstreamOwns=null){
    return operation || this._assetEpoch.capture(identity,upstreamOwns);
  },
  _ownsAssetOperation(operation){ return this._assetEpoch.owns(operation); },
  _liveClipForSource(sourceClip){ return liveClipForSource(State.clips,sourceClip); },
  _sourceStillReferenced(sourceClip){ return !!this._liveClipForSource(sourceClip); },
  _beginExternalAssetEdit(asset){
    const version=(this._externalAssetEditVersions.get(asset)||0)+1;
    this._externalAssetEditVersions.set(asset,version);
    return Object.freeze({asset,version,restoreVersion:this._externalRestoreVersion});
  },
  _ownsExternalAssetEdit(token){
    return !!token&&this._externalRestoreVersion===token.restoreVersion&&
      this._externalAssetEditVersions.get(token.asset)===token.version&&
      this.externalAudioSources.includes(token.asset);
  },
  _invalidateExternalAssetEdit(asset){
    if(asset) this._externalAssetEditVersions.set(asset,(this._externalAssetEditVersions.get(asset)||0)+1);
  },
  _releaseObjectURL(url){
    if(!url) return;
    this.objectURLs=this.objectURLs.filter(item=>item!==url);
    try{ URL.revokeObjectURL(url); }catch(error){}
  },
  _disposeMediaElement(element){
    if(!element) return;
    try{ element.pause?.(); }catch(error){}
    try{ element.removeAttribute?.('src'); element.src=''; element.load?.(); }catch(error){}
  },
  activeSource:null, // null=全部混音；'video'=影片原音；'ext-xxx'=外部檔案
  pendingChannels:[], // 背景抽取音軌時的「準備中」聲道（讓混音器立即顯示推桿，逐一就緒）
  audioPanelNotice:null, // 網頁版能力限制的持續提示；renderAudioTracks 不得用 bus 數覆蓋
  // 外部音檔不是影片 clip，但仍是可路由／可輸出的專案音源。
  // 每筆都提供 clip 相容的 id/name/audioSourceId/audioSrc/offset/in/out，供路由 UI
  // 或匯出端以同一套資料模型讀取；真正的播放群組仍用 audioSrc（ext-*）。
  //
  // 素材本身（建立／查詢／移動／修剪／切點／序列化／時間換算）住在
  // external-audio.js —— 那裡不碰 AudioElement 也不重繪，可以直接測。
  // 這裡留下的是「素材變了之後 runtime 要做什麼」：拆 element、重算增益、重畫。
  externalAudio:new ExternalAudioLibrary(),
  get externalAudioSources(){ return this.externalAudio.assets; },
  getExternalAudioSource(id){ return this.externalAudio.find(id); },
  set externalAudioSources(list){ this.externalAudio.assets=Array.isArray(list)?list:[]; },
  // 播放中只在外部音訊跨越片段邊界時重新同步，避免每幀重設 Audio.currentTime。
  _externalActivityKey:null,

  /* 由 ffprobe 的 audio[] 推算出每個聲道的標籤。展開順序**必須**與 main.js ingest
     一致（它依同一順序抽出 ch_01.m4a、ch_02.m4a…），規則在 channel-layout.js，
     由 tests/channelLayoutContract.test.js 鎖住兩邊不漂掉。 */
  /* 將 ffprobe / ingest 的實體聲道資料登錄到可儲存的 project audio model。
     `sourceStream` / `sourceChannel` 一律採 0-based；UI 才加 1 顯示。 */
  /* registerAudioRouting moved to AudioPipeline */
  /* sourceDescriptorFor moved to AudioPipeline */
  bindTrackRouting(track, clip, channel, index=0){
    if(!track) return track;
    Object.assign(track,AudioPipeline.sourceDescriptorFor(clip,channel,index));
    if(clip && clip.muted) track.muted = true;
    return track;
  },
  /* 同一媒體來源被切開／解除影音連結時，保留使用者已設定的來源聲道→專案 bus 配線。 */
  copyAudioSourceRouting(fromSourceId,toSourceId){
    const from=String(fromSourceId||''),to=String(toSourceId||'');
    const map=State.audioProject?.sourceMaps?.[from];
    if(!from||!to||!map) return false;
    try{ State.audioProject.sourceMaps[to]=structuredClone(map); return true; }catch(e){ return false; }
  },
  /* 外部音檔的持久（本次專案工作階段）來源描述。audioSrc 是播放群組鍵，
     audioSourceId 則永遠不依檔名或 runtime track id 推導，避免同名檔彼此覆蓋路由。 */
  createExternalAudioSource(details={}){
    const asset=this.externalAudio.add(details);
    const fallbackCount=Math.max(0,Math.floor(Number(details.fallbackCount)||0));
    AudioPipeline.registerSource(asset,asset.descriptors,fallbackCount);
    this.recomputeTimelineDuration();
    return asset;
  },
  /* 對 State / History 暴露的只會是純資料，絕不帶 File、AudioElement 或波形。 */
  _serializableExternalAudioSource(asset){ return serializeAsset(asset); },
  _syncExternalAudioState(){
    State.externalAudioState=this.externalAudio.serialize().filter(Boolean);
    State.externalAudioEnd=this.externalAudio.timelineEnd();
    return State.externalAudioEnd;
  },
  /* 給 audio-routing 的後續入口使用：回傳具 clip 相容欄位的 external source。 */
  /* project.js 可直接儲存 getExternalAudioSources() 的回傳資料，並在讀檔後呼叫此函式。
     目前僅桌面版可依原始 path 重建實際 audio element / cache。 */
  async restoreExternalAudioSource(serialized, operation=null, upstreamOwns=null){
    if(!serialized||typeof serialized!=='object'||!serialized.path) return null;
    if(!DESK) return null;
    const assetOperation=this._assetOperation(operation,{kind:'project-external-audio',path:serialized.path},upstreamOwns);
    return this.addAudioFileDesktop(serialized.path,{...serialized,_restore:true},assetOperation);
  },
  /* History 只保存純資料；還原時優先重用仍在 runtime 的 asset，已被刪除的桌面檔案則非同步重建。
     這個入口刻意不紀錄新的 history，避免 Ctrl+Z/Redo 產生遞迴項目。 */
  restoreExternalAudioEditState(rawSources){
    const restoreVersion=++this._externalRestoreVersion;
    const restoreOwns=()=>this._externalRestoreVersion===restoreVersion;
    const assetOperation=this._assetOperation(null,'history-external-audio-restore',restoreOwns);
    const owns=()=>this._ownsAssetOperation(assetOperation);
    // 「誰留下、誰要移除、誰得重建」是資料判斷 → library；
    // 移除要拆 AudioElement、重建要開檔 → 留在這裡。
    const plan=this.externalAudio.planRestore(rawSources);
    for(const asset of plan.removed) this.removeExternalAudio(asset.id,{record:false});
    for(const { asset, source } of plan.kept) this.externalAudio.applyRestored(asset,source);
    // 尚未完成非同步重建前仍保留快照的總長，避免 undo 後時間軸立刻縮短。
    State.externalAudioState=plan.wanted;
    State.externalAudioEnd=plan.timelineEnd;
    Seq.recomputeDuration();
    this.applyGains(); if(this.playing) this._restartElements(); emit('media:audioTracks'); emit('media:timeline');
    for(const source of plan.pending){
      if(!DESK) continue; // 只有桌面版能依原始 path 重建
      void this.restoreExternalAudioSource({...source,_restore:true},assetOperation).then(()=>{
        if(!owns()) return;
        this.recomputeTimelineDuration(); this.applyGains(); emit('media:audioTracks'); emit('media:timeline');
      }).catch(error=>console.warn('restore history external audio:',error));
    }
  },
  updateExternalAudioSourceDuration(asset, rawDuration){
    if(!this.externalAudio.updateDuration(asset,rawDuration)) return;
    this.recomputeTimelineDuration();
  },
  /* 外部音訊編輯完成後統一同步總長度、播放位置與 mixer／timeline。 */
  _commitExternalAudioEdit(asset,label=''){
    if(asset) this.externalAudio.normalize(asset);
    this.recomputeTimelineDuration();
    this.applyGains();
    if(this.playing) this._restartElements();
    emit('media:audioTracks'); emit('media:timeline');
    if(label) emit('history:record',label);
    return asset?this._serializableExternalAudioSource(asset):null;
  },
  /* 時間軸總長必須同時涵蓋影片、外部音訊與已排版字幕。 */
  recomputeTimelineDuration(){
    this._syncExternalAudioState();
    Seq.recomputeDuration();
    return State.duration;
  },
  moveExternalAudio(key, offset){
    const current=this.externalAudio.find(key);
    this._invalidateExternalAssetEdit(current);
    const asset=this.externalAudio.move(key,offset);
    if(!asset) return null;
    return this._commitExternalAudioEdit(asset,'移動音訊：'+(asset.name||''));
  },
  /* edge 可用 start/left/in 或 end/right/out；timelineTime 一律是時間軸秒數。 */
  trimExternalAudio(key, edge, timelineTime){
    const current=this.externalAudio.find(key);
    this._invalidateExternalAssetEdit(current);
    const asset=this.externalAudio.trim(key,edge,timelineTime);
    if(!asset) return null;
    return this._commitExternalAudioEdit(asset,'修剪音訊：'+(asset.name||''));
  },
  /* 在播放點切開一個外部音訊。
     每個切片都建立獨立 audioSourceId / AudioElement，才能同時被移動、靜音、輸出與播放；
     快取可由 Electron 的 ingest 命中，不共用同一個 element 而造成兩段互相 seek。 */
  async splitExternalAudio(key, timelineTime){
    // 切點與左右兩段的規格是純計算 → library；把右段真的載進來要開檔 → 這裡。
    const plan=this.externalAudio.planSplit(key,timelineTime);
    if(!plan){
      if(this.externalAudio.find(key)) showToast('切點太靠近音訊段落邊界');
      return null;
    }
    const { asset, left, right: cloneDetails }=plan;
    const editToken=this._beginExternalAssetEdit(asset);
    const assetOperation=this._assetOperation(null,{kind:'split-external-audio',key},()=>this._ownsExternalAssetEdit(editToken));
    const owns=()=>this._ownsAssetOperation(assetOperation);
    let right=null;
    try{
      if(asset.path&&DESK) right=await this.addAudioFileDesktop(asset.path,cloneDetails,assetOperation);
      else if(asset._file) right=await this.addAudioFile(asset._file,cloneDetails,assetOperation);
      else throw new Error('找不到可重新載入的音訊來源');
    }catch(e){
      console.warn('split external audio:',e);
    }
    if(!owns()){
      if(right&&this.externalAudioSources.includes(right)) this.removeExternalAudio(right.id,{record:false});
      return null;
    }
    if(!right){
      showToast('無法建立右側音訊片段');
      return null;
    }
    // Do not optimistically shorten the left side before the async right-side
    // asset exists.  Otherwise a move/undo during the await records the
    // temporary half-clip in History and cancellation cannot safely restore it.
    asset.out=left.out;
    asset.fadeOut=left.fadeOut;
    // 切開的是同一份來源，不是重新匯入一個「不同語言／不同交付」；沿用原段已設定的
    // project bus 對應，後續若 descriptor 在背景補齊，ensureAudioSourceMap 仍會保留它。
    this.copyAudioSourceRouting(asset.audioSourceId,right.audioSourceId);
    this._commitExternalAudioEdit(right,'切割音訊：'+(asset.name||''));
    return right;
  },
  removeExternalAudio(key,{record=true}={}){
    const asset=this.externalAudio.find(key);
    if(!asset) return false;
    this._invalidateExternalAssetEdit(asset);
    const source=asset.audioSrc;
    const oldTracks=this.tracks.filter(track=>track.source===source);
    this.tracks=this.tracks.filter(track=>track.source!==source);
    for(const track of oldTracks){
      try{track.el?.pause(); track.el&&(track.el.src='');}catch(e){}
      try{track.gain?.disconnect();}catch(e){}
    }
    this.externalAudio.remove(asset);
    Wave.forgetSourceWaveforms(asset);
    if(this.activeSource===source) this.activeSource=null;
    deselect('audio', asset.id);
    this._commitExternalAudioEdit(null,record?'刪除音訊：'+(asset.name||''):'' );
    return true;
  },
  toggleExternalAudioEnabled(key, enabled){
    const current=this.externalAudio.find(key);
    this._invalidateExternalAssetEdit(current);
    const asset=this.externalAudio.setEnabled(key,enabled);
    if(!asset) return null;
    return this._commitExternalAudioEdit(asset,(asset.enabled?'開啟音訊：':'靜音音訊：')+(asset.name||''));
  },
  /* 將外部 asset 的 timeline placement 換算成來源秒數；null 表示此時間點不該播放。
     沒有 asset metadata 的舊 ext-* runtime track 保持原本「從 0 秒跟 timeline」行為。 */
  /* 原生直讀的影片平常不需要 ffmpeg 音訊快取；但多聲道路由匯出必須有各聲道檔案。
     因此在背景補抽，不改變原生播放路徑，只把 cache file 掛回既有 L/R runtime track。 */
  async cacheNativeRoutingAudio(clip, path, duration, audio){
    if(!DESK?.ingest || !clip || !path || !(audio||[]).length) return;
    const myVer=this._bgVersion;
    try{
      // 與解除影音／外部音檔共用 ingest 佇列，避免同一路徑同時寫入 cache。
      const res=await DESK.ingest({path,duration,needsProxy:false,audio,queue:true});
      const liveClip=this._liveClipForSource(clip);
      if(this._bgVersion!==myVer || !liveClip) return;
      const chs=res?.channels||[];
      const descriptors=AudioPipeline.registerSource(liveClip,chs,chs.length);
      const tracks=this.tracks.filter(track=>(track.source||'video')==='video'&&track.audioSourceId===liveClip.audioSourceId);
      for(let i=0;i<Math.min(tracks.length,chs.length);i++){
        tracks[i].file=chs[i].file;
        Object.assign(tracks[i],AudioPipeline.sourceDescriptorFor(liveClip,descriptors[i],i));
      }
      emit('media:timeline');
    }catch(e){ console.warn('native audio cache:',e); }
  },
  /* 外部音檔初次以原檔快速播放；背景 ingest 完成後改用每條單聲道快取。
     如此預覽、來源聲道路由與 export audioPlan 都對到同一組 descriptor/file。 */
  async cacheExternalRoutingAudio(asset, path, duration, audio){
    if(!DESK?.ingest || !asset || !path || !(audio||[]).length) return null;
    const myVer=this._bgVersion;
    try{
      const res=await DESK.ingest({path,duration,needsProxy:false,audio,queue:true});
      if(this._bgVersion!==myVer || !this.externalAudioSources.includes(asset)) return null;
      const channels=res?.channels||[];
      const descriptors=AudioPipeline.registerSource(asset,channels,channels.length||(asset.descriptors||[]).length);
      asset.descriptors=descriptors;
      if(channels.length) await this._replaceExternalTracksWithCached(asset,channels,descriptors,myVer);
      if(res?.wave) await this._setExternalWaveFromPath(asset,res.wave,myVer);
      if(this._bgVersion===myVer && this.externalAudioSources.includes(asset)){
        this.applyGains(); emit('media:audioTracks'); emit('media:timeline');
        setStatus('音軌與波形已加入','ok');
      }
      return res;
    }catch(e){
      // 不移除快速播放中的原檔音訊；匯出端只會略過尚未有逐聲道快取的路由。
      if(this._bgVersion===myVer && this.externalAudioSources.includes(asset)){
        console.warn('external audio cache:',e);
        setStatus('音軌已加入（匯出聲道準備失敗）','');
      }
      return null;
    }
  },
  /* 已抽取過的影片／音訊來源可直接複製成新的 AudioElement 群組。這比再次餵原始
     影片容器給 <audio> 更可靠，也確保每個解除連結後的段落能各自 seek／同時播放。 */
  _cachedDesktopChannelsForSource(source){
    const wanted=String(source||'');
    const byDescriptor=new Map();
    for(const track of this.tracks){
      if((track.source||'')!==wanted||!track.file) continue;
      const sourceStream=Math.max(0,Math.floor(Number(track.sourceStream)||0));
      const sourceChannel=Math.max(0,Math.floor(Number(track.sourceChannel)||0));
      const key=sourceStream+':'+sourceChannel;
      if(!byDescriptor.has(key)){
        byDescriptor.set(key,{
          file:track.file,
          label:track.name||('音軌 '+(byDescriptor.size+1)),
          sourceStream,
          sourceChannel
        });
      }
    }
    return [...byDescriptor.values()].sort((a,b)=>a.sourceStream-b.sourceStream||a.sourceChannel-b.sourceChannel);
  },
  /* 任何桌面媒體（包含 MXF、ProRes MOV 等）都可由 ffmpeg 轉成 Chromium 可播放的
     單聲道 m4a 快取。這是「解除影音」與重開專案時的保底，不依賴原容器 codec。 */
  async _prepareDesktopAudioCache(path, durationHint=0, infoHint=null){
    if(!DESK?.ingest||!DESK?.probe) throw new Error('桌面版音訊快取工具不可用');
    const info=infoHint||await DESK.probe(path);
    const audio=Array.isArray(info?.audio)?info.audio:[];
    if(!audio.length) throw new Error('此影片沒有可解除的音訊');
    const duration=Math.max(0,Number(info?.duration)||0,Number(durationHint)||0);
    const result=await DESK.ingest({path,duration,needsProxy:false,audio,queue:true});
    const channels=Array.isArray(result?.channels)?result.channels:[];
    if(!channels.length) throw new Error('無法抽取影片音訊聲道');
    return {info,duration,channels,wave:result?.wave||null};
  },
  /* 由 ffmpeg 已抽取的單聲道檔建立一個獨立時間軸音訊素材。它持有自己的
     AudioElements，因此移動／修剪／切割時不會再影響影片原音的播放位置。 */
  async _addDesktopCachedAudio(path, restoredSource=null, prepared=null, operation=null){
    const assetOperation=this._assetOperation(operation,{kind:'desktop-audio-cache',path});
    const version=this._bgVersion;
    const owns=()=>this._ownsAssetOperation(assetOperation)&&this._bgVersion===version;
    if(!owns()) return null;
    this.ensureCtx();
    const cache=prepared||await this._prepareDesktopAudioCache(path,restoredSource?.duration||0);
    if(!owns()) return null;
    const channels=Array.isArray(cache?.channels)?cache.channels:[];
    if(!channels.length) throw new Error('找不到可播放的音訊快取');
    const duration=Math.max(0,Number(cache?.duration)||0,Number(restoredSource?.duration)||0);
    const descriptors=sourceChannelDescriptors(channels,channels.length);
    let asset=null;
    try{
      if(!owns()) return null;
      asset=this.createExternalAudioSource({
        name:restoredSource?.name||baseName(path),
        path,
        audioSourceId:restoredSource?.audioSourceId,
        timelineLaneId:restoredSource?.timelineLaneId,
        duration,
        offset:restoredSource?.offset ?? ((!restoredSource && (State.clips.length > 0 || State.audioSources.length > 0)) ? this.displayTime() : 0),
        in:restoredSource?.in,
        out:restoredSource?.out,
        gain:restoredSource?.gain,
        fadeIn:restoredSource?.fadeIn,
        fadeOut:restoredSource?.fadeOut,
        enabled:restoredSource?.enabled,
        // 一旦走過此保底路徑，之後切割／專案重開都不要再讀原始影片容器。
        preferCache:true,
        descriptors,
        fallbackCount:channels.length
      });
      this.updateExternalAudioSourceDuration(asset,duration);
      const ready=await this._replaceExternalTracksWithCached(asset,channels,descriptors,version,owns);
      if(!owns()){
        if(asset&&this.externalAudioSources.includes(asset)) this.removeExternalAudio(asset.id,{record:false});
        return null;
      }
      if(!ready) throw new Error('音訊快取已失效或無法載入');
      // 外部素材永遠由自己的 timeline placement 決定是否出聲，不能被目前影片 source
      // 的選擇狀態隱藏。
      for(const track of this.tracks){ if(track.source===asset.audioSrc) track._srcHidden=false; }
      this.usingWebAudio=true;
      this.syncMuteState();
      this.recomputeTimelineDuration();
      if(cache.wave) void this._setExternalWaveFromPath(asset,cache.wave,version);
      emit('media:audioTracks'); emit('media:timeline');
      if(this.playing) this._restartElements();
      if(!(restoredSource?._restore)&&!(restoredSource?._internalSplit)) emit('history:record','加入音訊：'+asset.name);
      return asset;
    }catch(error){
      if(asset&&this.externalAudioSources.includes(asset)) this.removeExternalAudio(asset.id,{record:false});
      if(!owns()) return null;
      throw error;
    }
  },
  async _replaceExternalTracksWithCached(asset, channels, descriptors, version, upstreamOwns=()=>true){
    const owns=()=>this._bgVersion===version&&this.externalAudioSources.includes(asset)&&upstreamOwns();
    if(!channels.length || !owns()) return false;
    const els=await this._intakeSession.materializeAudioElements(channels,{
      owns,
      resolveFileURL:file=>DESK.fileURL(file),
      createAudio:()=>new Audio(),
    });
    if(!els||!owns()) return false;
    const source=asset.audioSrc;
    const oldTracks=this.tracks.filter(track=>track.source===source);
    const oldByDescriptor=new Map();
    for(const track of oldTracks){
      const key=track.sourceStream+':'+track.sourceChannel;
      if(!oldByDescriptor.has(key)) oldByDescriptor.set(key,track);
    }
    const fallback=oldTracks[0]||null;
    const hidden=oldTracks.length ? !!oldTracks[0]._srcHidden : (this.activeSource!==null&&this.activeSource!==source);
    const oldElements=new Set(oldTracks.map(track=>track.el).filter(Boolean));
    this.tracks=this.tracks.filter(track=>track.source!==source);
    for(const track of oldTracks){ try{track.gain?.disconnect();}catch(e){} }
    for(const el of oldElements){ try{el.pause(); el.src='';}catch(e){} }
    for(let i=0;i<channels.length;i++){
      if(!owns()) return false;
      const el=els[i]; if(!el) continue;
      const node=AudioEngine.createMediaElementSource(el);
      const gain=AudioEngine.createGain(); node.connect(gain); AudioEngine.connectToMaster(gain);
      const descriptor=descriptors[i]||{sourceStream:0,sourceChannel:i};
      const prior=oldByDescriptor.get(descriptor.sourceStream+':'+descriptor.sourceChannel)||fallback;
      const track=this.bindTrackRouting({
        id:'ext'+(_extTrackIdCounter++),
        name:channels[i].label||('音軌 '+(i+1)),
        kind:'element', source, el, gain,
        muted:prior?!!prior.muted:false,
        solo:prior?!!prior.solo:false,
        volume:prior&&prior.volume!=null?prior.volume:1,
        file:channels[i].file,
        _srcHidden:hidden,
        analyser:null,_mbuf:null,level:0,peak:0,peakT:0
      },asset,descriptor,i);
      this.attachMeter(track,node); this.tracks.push(track);
    }
    if(this.playing) this._restartElements();
    return true;
  },
  async _setExternalWaveFromPath(asset, wavePath, version){
    if(!wavePath || !DESK?.fileURL || this._bgVersion!==version || !this.externalAudioSources.includes(asset)) return;
    try{
      const wavUrl=await DESK.fileURL(wavePath);
      const buf=await fetch(wavUrl).then(res=>res.arrayBuffer());
      if(this._bgVersion!==version || !this.externalAudioSources.includes(asset)) return;
      let pk=Wave.calcFromWav(buf);
      if(!pk){
        const ab=await AudioEngine.decodeAudioData(buf);
        pk=Wave.calcPeaks(ab,-1);
      }
      if(this._bgVersion===version && this.externalAudioSources.includes(asset)){
        Wave.setSourceMixPeaks(asset,pk,{mixPath:wavePath,channels:asset.descriptors});
      }
    }catch(e){ console.warn('external wave cache:',e); }
  },

  /* 把播放狀態接給 AudioEngine（只做一次）。

     transport 需要的東西全部來自這裡，而且整個播放期間都是同一組來源。
     以前是每次呼叫都推一次參數——scrubAudio 收 11 個、startElementSources 收 7 個，
     其中好幾個是回呼。位置或名字寫錯時型別又都對得上，會靜默跑出錯的行為。
     注入一次之後，呼叫端只傳「這一刻要做什麼」。

     每一項都是 getter：Media 的狀態一直在變，存值會拿到 bind 當下的快照。 */
  _bindAudioEngine(){
    if(this._audioEngineBound) return;
    this._audioEngineBound = true;
    AudioEngine.bind({
      tracks: () => this.tracks,
      seqOn: () => this.seqOn(),
      playing: () => this.playing,
      muted: () => State.muted,
      activeSource: () => this.activeSource,
      activeClipId: () => this.activeClipId,
      playbackRate: () => video.playbackRate || 1,
      timelineTime: () => this.tlTime(),
      sourceTimeFor: (s, t) => this._srcLocalT(s, t),
      externalSourceTimeFor: (s, t) => this.externalAudio.sourceTime(s, t),
      clipSourceTimeFor: (t, c) => this._transport.sourceTime(t, c),
    });
  },

  ensureCtx(){
    this._bindAudioEngine();
    return AudioEngine.ensureCtx();
  },

  /* 使用者可先放置圖片、之後才匯入第一支影片。這時圖片已是有效的時間軸
     內容，不能被「建立主影片」的 reset 當成舊影片序列清掉。 */
  _captureImageOnlyTimeline(){
    const clips=(State.clips||[]).filter(clip=>clip?.type==='image');
    if(!clips.length || clips.length!==(State.clips||[]).length) return null;
    const urls=new Set(clips.map(clip=>clip.web?.url).filter(url=>this.objectURLs.includes(url)));
    return {
      clips:clips.map(clip=>({...clip,web:clip.web?{...clip.web}:null})),
      videoTracks:(State.videoTracks||[]).map(track=>({...track})),
      objectURLs:urls
    };
  },
  _resetForFirstVideo(options={}){
    const preserved=this._captureImageOnlyTimeline();
    this.reset({keepObjectURLs:preserved?.objectURLs, ...options});
    this._preservedImageTimeline=preserved;
    return !!preserved;
  },
  _restorePreservedImageTimeline(){
    const preserved=this._preservedImageTimeline;
    delete this._preservedImageTimeline;
    if(!preserved?.clips?.length) return false;
    if(Array.isArray(preserved.videoTracks)&&preserved.videoTracks.length)
      State.videoTracks=preserved.videoTracks.map(track=>({...track}));
    for(const image of preserved.clips){
      const vtrack=Math.max(0,Math.round(Number(image.vtrack)||0));
      ensureVideoTrackCount(vtrack+1);
      State.clips.push({...image,type:'image',primary:false,vtrack,web:image.web?{...image.web}:null});
    }
    Seq.sort(); Seq.recomputeDuration();
    emit('render:videoSub');
    return true;
  },

  async probeAndMaybeExtract(file,{owns=()=>true}={}){
    if(!owns()) return false;
    // 大檔限制必須先於 audioTracks 早退判斷；即使瀏覽器列得出多個 stream，
    // HTMLMediaElement 仍只提供 Stereo 播放路徑，不能宣稱已載入全部來源聲道。
    this.audioPanelNotice=webAudioCapabilityNotice(file,{nativePreview:true});
    // 嘗試以原生 audioTracks 偵測；多數瀏覽器不支援，故主要靠 ffmpeg
    try{
      const at=video.audioTracks;
      if(at && at.length>1){
        if(!owns()) return false;
        setStatus(`偵測到 ${at.length} 條原生音軌`,'ok');
        for(let i=0;i<at.length;i++){
          this.tracks.push({id:'nat'+i,name:'音軌 '+(i+1)+(at[i].language?(' '+at[i].language):''),kind:'nativeTrack',
            index:i,enabled:i===0});
          at[i].enabled=(i===0);
        }
        emit('media:audioTracks'); return true;
      }
    }catch(e){}
    // 用 ffmpeg 探測（不阻塞主流程，量力而為）
    if(file.size <= FFMPEG_MAX_BYTES){
      this.ffprobeTracks(file,{owns}).then(streams=>{
        if(!owns()) return;
        if(streams && streams.aCount>1){
          showToast(`此檔含 ${streams.aCount} 條音軌，點音軌面板的「抽取多軌」以同時混音`);
          $('atHint').innerHTML=`含 ${streams.aCount} 條音軌 · <a href="#" id="extractLink" style="color:var(--accent)">抽取多軌混音</a>`;
          $('extractLink').onclick=(e)=>{e.preventDefault();this.extractAllAudio(file,streams.aCount,{owns});};
        }
      }).catch(()=>{});
    }else{
      if(!owns()) return false;
      showToast(WEB_LARGE_NATIVE_AUDIO_NOTICE);
    }
    if(owns()) emit('media:audioTracks');
    return owns();
  },

  async addAudioFile(file, restoredSource=null, operation=null){
    const assetOperation=this._assetOperation(operation,{kind:'web-audio',name:file?.name});
    const owns=()=>this._ownsAssetOperation(assetOperation);
    if(!owns()) return null;
    this.ensureCtx();
    setStatus('載入音訊中…','busy');
    let url=null,el=null;
    try{
      url=URL.createObjectURL(file); this.objectURLs.push(url);
      el=new Audio(); el.src=url; el.preload='auto';
      const metadata=await waitForOwnedMediaMetadata(el,{owns,timeoutMs:10000});
      if(metadata==='cancelled'||!owns()){ this._disposeMediaElement(el); this._releaseObjectURL(url); return null; }
      if(metadata!=='ready') throw new Error('無法讀取此音訊檔 ('+file.name+')');
      const node=AudioEngine.createMediaElementSource(el);
      const chCount=Math.max(1,node.channelCount||2);
      const asset=this.createExternalAudioSource({
        name:restoredSource?.name||file.name,
        timelineLaneId:restoredSource?.timelineLaneId,
        duration:el.duration||0,
        offset:restoredSource?.offset ?? ((!restoredSource && (State.clips.length > 0 || State.audioSources.length > 0)) ? this.displayTime() : 0),
        in:restoredSource?.in,
        out:restoredSource?.out,
        gain:restoredSource?.gain,
        fadeIn:restoredSource?.fadeIn,
        fadeOut:restoredSource?.fadeOut,
        enabled:restoredSource?.enabled,
        descriptors:restoredSource?.descriptors,
        fallbackCount:chCount,
        file
      });
      this.updateExternalAudioSourceDuration(asset,el.duration||0);
      const newTracks=this._splitToChannelTracks(node,asset.audioSrc,el,chCount,asset,asset.descriptors);
      this.tracks.push(...newTracks);
      // 外部音檔是時間軸素材，不是「切換成唯一可聽音源」的播放器模式。
      // 保持既有影片與先前加入的音檔可同時依專案 bus 路由／混音。
      newTracks.forEach(track=>{ track._srcHidden=false; });
      this.usingWebAudio=true;
      this.syncMuteState();
      this.recomputeTimelineDuration();
      // 網頁版沒有 ffmpeg 的逐聲道 cache，仍可直接從原檔解碼出 MIX / 每條聲道峰值。
      // 這個狀態只留在 Wave 的 runtime registry，不會被寫入專案檔。
      const ownsWave=()=>owns()&&this.externalAudioSources.includes(asset);
      if(file.size<=WAVE_DECODE_MAX) void Wave.fromFile(file,asset,{owns:ownsWave}).catch(()=>{});
      if(!Wave.peaks) Wave.initLive();
      setStatus('音軌已加入','ok');
      emit('media:audioTracks');
      if(this.playing) this.startElementSources(this.vTime());
      if(!(restoredSource?._restore)&&!(restoredSource?._internalSplit)) emit('history:record','加入音訊：'+asset.name);
      return asset;
    }catch(e){
      if(!owns()){ this._disposeMediaElement(el); this._releaseObjectURL(url); return null; }
      this._disposeMediaElement(el); this._releaseObjectURL(url);
      setStatus('音訊載入失敗：'+e.message,''); showToast('音訊載入失敗：'+e.message);
      return null;
    }
  },

  /* --- 桌面 (Electron) 媒體：平台原生 ffmpeg，單次讀取多輸出，逐聲道音軌 + 電平表 --- */
  async addAudioFileDesktop(p, restoredSource=null, operation=null){
    const assetOperation=this._assetOperation(operation,{kind:'desktop-audio',path:p});
    const owns=()=>this._ownsAssetOperation(assetOperation);
    if(!owns()) return null;
    this.ensureCtx();
    // 解除自影片容器的音訊、以及其後重開專案／切割出來的副本，必須固定走
    // ffmpeg 快取。MXF 或部分 MOV 雖可由 mpv 播放，卻不能保證 Chromium <audio>
    // 可以解碼；直接讀容器會讓解除連結看似失敗。
    if(restoredSource?.preferCache){
      try{ return await this._addDesktopCachedAudio(p,restoredSource,null,assetOperation); }
      catch(e){
        if(!owns()) return null;
        console.warn('cached desktop audio load:',e);
        setStatus('音訊載入失敗：'+(e?.message||e),'');
        showToast('無法載入音訊檔：'+(e?.message||e));
        return null;
      }
    }
    let asset=null;
    let el=null;
    try{
      const name=baseName(p);
      let info=null;
      let chCount=2;
      try{ info=await DESK.probe(p); chCount=info?.audio?.[0]?.channels||2; }catch(e){}
      if(!owns()) return null;
      const fileUrl=await DESK.fileURL(p);
      if(!owns()) return null;
      el=new Audio(); el.src=fileUrl; el.preload='auto';
      const metadata=await waitForOwnedMediaMetadata(el,{owns,timeoutMs:10000});
      if(metadata==='cancelled'||!owns()){ this._disposeMediaElement(el); return null; }
      if(metadata!=='ready') throw new Error('音訊元素載入失敗：'+p);
      const node=AudioEngine.createMediaElementSource(el);
      const probedDescriptors=probeAudioChannelDescriptors(info?.audio);
      asset=this.createExternalAudioSource({
        name:restoredSource?.name||name,
        path:p,
        audioSourceId:restoredSource?.audioSourceId,
        timelineLaneId:restoredSource?.timelineLaneId,
        duration:el.duration||info?.duration||0,
        offset:restoredSource?.offset ?? ((!restoredSource && (State.clips.length > 0 || State.audioSources.length > 0)) ? this.displayTime() : 0),
        in:restoredSource?.in,
        out:restoredSource?.out,
        gain:restoredSource?.gain,
        fadeIn:restoredSource?.fadeIn,
        fadeOut:restoredSource?.fadeOut,
        enabled:restoredSource?.enabled,
        descriptors:probedDescriptors.length?probedDescriptors:restoredSource?.descriptors,
        fallbackCount:chCount
      });
      this.updateExternalAudioSourceDuration(asset,el.duration||info?.duration||0);
      // <audio> 直接播放時通常只提供第一條 stream；先以它快速出聲，背景 cache 完成後
      // 會替換成所有來源聲道的獨立 mono element。
      const directCount=Math.max(1,Math.min(chCount,asset.descriptors.length||chCount));
      const directDescriptors=asset.descriptors.slice(0,directCount);
      const newTracks=this._splitToChannelTracks(node,asset.audioSrc,el,directCount,asset,directDescriptors);
      this.tracks.push(...newTracks);
      if(restoredSource?._restore){
        // 專案重開時外部音檔仍是時間軸參考音，不搶走正在載入的主影片音源選擇。
        newTracks.forEach(track=>{ track._srcHidden=false; });
        this.applyGains(); emit('media:audioTracks');
      }else{
        // 和還原專案的行為一致：新加入的外部素材不能把其他外部／影片來源隱藏掉。
        newTracks.forEach(track=>{ track._srcHidden=false; });
      }
      this.usingWebAudio=true; this.syncMuteState();
      this.recomputeTimelineDuration();
      emit('media:audioTracks');
      if(this.playing) this.startElementSources(this.vTime());
      if(!(restoredSource?._restore)&&!(restoredSource?._internalSplit)) emit('history:record','加入音訊：'+asset.name);
      if(Array.isArray(info?.audio)&&info.audio.length){
        setStatus('產生波形與匯出聲道…','busy');
        void this.cacheExternalRoutingAudio(asset,p,asset.duration,info.audio);
      }else{
        // probe 失敗時保留舊有的單獨波形退路；播放仍可正常使用，只是沒有可靠的逐聲道輸出快取。
        const version=this._bgVersion;
        setStatus('產生波形…','busy');
        void DESK.waveAudio(p,asset.duration).then(async wavPath=>{
          try{
            await this._setExternalWaveFromPath(asset,wavPath,version);
            try{ DESK.cleanupAudio(wavPath); }catch(e){}
            if(this._bgVersion===version&&this.externalAudioSources.includes(asset)) setStatus('音軌與波形已加入','ok');
          }catch(e){ console.warn('waveAudio error',e); }
        }).catch(e=>{
          console.warn('waveAudio error',e);
          if(this._bgVersion===version&&this.externalAudioSources.includes(asset)) setStatus('音軌已加入','ok');
        });
      }
      return asset;
    }catch(e){
      // 若原始檔是影片容器，Audio element 可能在 metadata／decode 階段失敗。先把
      // 半建立的 runtime asset 清掉，再改用 ffmpeg 的可播放單聲道快取；這條路徑也
      // 會把 preferCache 寫入專案，往後重開就不會重踩同一個 codec 限制。
      if(asset&&this.externalAudioSources.includes(asset)) this.removeExternalAudio(asset.id,{record:false});
      this._disposeMediaElement(el);
      if(!owns()) return null;
      try{
        const cached=await this._addDesktopCachedAudio(p,{...(restoredSource||{}),preferCache:true},null,assetOperation);
        if(!owns()) return null;
        if(cached) return cached;
      }catch(cacheError){
        console.warn('desktop audio cache fallback:',cacheError);
      }
      setStatus('音軌載入失敗：'+(e?.message||e),'');
      showToast('無法載入音訊檔：'+(e?.message||e));
      return null;
    }
  },

  /* --- mpv 即時開啟路徑（偵測到 mpv.exe 時使用，無需等 proxy 轉檔） --- */
  _mpvRect(){ const vw=$('videoWrap'); const r=vw.getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height}; },
  _startMpvBoundsFeeder(){
    /* 矩形沒變就不要送。

       下面那個 2000ms 的計時器是面板拖移的安全網，但它【無條件】送出同一個矩形，
       於是只要 mpv 在跑，主行程就每 2 秒把 mpv 與 guide 兩個 transparent 子視窗
       各重設一次位置。那在 Windows 上是 layered window 的 SetWindowPos，會強制
       DWM 重新合成；而原生檔案對話框的訊息迴圈就在主行程的 UI 執行緒上，
       於是「開啟檔案總管」與「在對話框裡切換資料夾」每 2 秒被打斷一次。

       主行程側另有一道相同的守衛（mpvHost.setBounds 比對絕對座標），因為視窗移動時
       矩形不變但絕對位置會變——那一層才是正確性的保證，這裡只是省掉沒必要的 IPC。 */
    /* 先停掉舊的。原本沒有這一行：重開素材時 media-loader 會再呼叫一次本函式，
       舊的 setInterval 與 ResizeObserver 沒被清掉就會累積，每個各自送自己的 bounds。
       現在 last 是每個 feeder 各自的閉包，殘留的舊 feeder 會拿自己的舊 last 判斷，
       更容易送出多餘的 IPC——所以這一行同時是效能與正確性的保險。 */
    this._stopMpvBoundsFeeder();
    let last=null;
    const send=()=>{
      if(!this.mpvMode||!getPlayerAdapter())return;
      const r=this._mpvRect();
      if(last && last.x===r.x && last.y===r.y && last.w===r.w && last.h===r.h) return;
      last=r;
      getPlayerAdapter().setBounds(r).catch(()=>{});
    };
    this._mpvBoundsSend=send;
    try{ this._mpvRO=new ResizeObserver(send); this._mpvRO.observe($('videoWrap')); }catch(e){}
    window.addEventListener('resize',send);
    this._mpvBoundsTimer=setInterval(send,2000); // Fix #17：安全網（面板拖移），降至 2000ms 減少 IPC 呼叫
  },
  _stopMpvBoundsFeeder(){
    if(this._mpvRO){ try{this._mpvRO.disconnect();}catch(e){} this._mpvRO=null; }
    if(this._mpvBoundsSend){ window.removeEventListener('resize',this._mpvBoundsSend); this._mpvBoundsSend=null; }
    if(this._mpvBoundsTimer){ clearInterval(this._mpvBoundsTimer); this._mpvBoundsTimer=null; }
  },

  async _bgAudioIngest(p, audio, dur, primary=Seq.primary()){
    const myVer=this._bgVersion;
    // Background work belongs to the exact mother-source object that started
    // it.  Deleting the final clip does not reset the whole Media singleton,
    // so generation alone cannot prevent a late cache result from recreating
    // that source in audioProject/Wave.
    const current=()=>this._bgVersion===myVer&&!!this._liveClipForSource(primary);
    setStatus('背景抽取音軌中（不影響播放）…','busy');
    let res;
    // needsProxy:true（v4.22 WebCodecs 階段5）：mpv 路徑同 pass 一併產 720p proxy——
    // proxy 就緒後 WebCodecs 預覽引擎接管畫面（即時多軌合成），mpv 退居時鐘＋兜底
    // 解除影音也可能在背景抽取尚未完成時觸發；排入同一佇列可避免兩個 ffmpeg
    // 同時覆寫此來源的 cache（尤其是大型 MXF）。
    try{ res=await DESK.ingest({path:p,duration:dur,needsProxy:true,audio,queue:true}); }
    catch(e){ if(!current()) return; console.warn('bg audio ingest:',e); this.pendingChannels=[]; emit('media:audioTracks'); setStatus('音軌抽取失敗：'+e.message,''); return; }
    if(!current()) return; // 使用者已換另一個檔，丟棄結果
    if(res.proxy){
      try{
        const u=await DESK.fileURL(res.proxy);
        if(!current()) return;
        this._wcProxyUrl=u;
        this._wcProxyPath=p;
        this.seek(this.displayTime()); // 強制全域跳躍以觸發 WCPreview 接管與解碼
      }catch(e){ if(!current()) return; console.warn('proxy url:',e); }
    }

    if(!current()) return;
    const chs=res.channels||[];
    const livePrimary=this._liveClipForSource(primary);
    if(!livePrimary) return;
    const descriptors=AudioPipeline.registerSource(livePrimary,chs,chs.length);
    if(chs.length){
      // 並行載入所有聲道，大幅縮短多聲道（8ch MXF 等）的等待時間
      const els=await this._intakeSession.materializeAudioElements(chs,{
        owns:current,
        resolveFileURL:file=>DESK.fileURL(file),
        createAudio:()=>new Audio(),
      });
      if(!els||!current()) return;
      for(let i=0;i<chs.length;i++){
        const el=els[i]; if(!el) continue;
        const node=AudioEngine.createMediaElementSource(el);
        const g=AudioEngine.createGain(); node.connect(g); AudioEngine.connectToMaster(g);
        const sourceClip=this._liveClipForSource(primary);
        if(!sourceClip) return;
        const tr=this.bindTrackRouting({id:'el'+i,name:chs[i].label||('音軌 '+(i+1)),kind:'element',source:'video',el,gain:g,muted:!!sourceClip.muted,solo:false,volume:1,file:chs[i].file},sourceClip,descriptors[i],i);
        this.attachMeter(tr,node); this.tracks.push(tr);
        if(this.pendingChannels[i]) this.pendingChannels[i].ready=true;
        this.usingWebAudio=true; this.syncMuteState();
        emit('media:audioTracks');
      }
    }
    if(!current()) return;
    this.pendingChannels=[];
    this.usingWebAudio=true; this.syncMuteState();
    // element tracks 接管後，mpv 靜音（避免雙重音訊）
    if(chs.length>0) getPlayerAdapter().mute(true).catch(()=>{});
    if(this.playing) this.startElementSources(this._mpvTime);
    emit('media:audioTracks');

    if(res.wave){
      try{
        const wavUrl=await DESK.fileURL(res.wave);
        if(!current()) return;
        const r=await fetch(wavUrl);
        if(!current()) return;
        const buf=await r.arrayBuffer();
        if(!current()) return;
        let pk=Wave.calcFromWav(buf);
        if(!pk){
          const ab=await AudioEngine.decodeAudioData(buf);
          if(!current()) return;
          pk=Wave.calcPeaks(ab,-1);
        }
        if(!current()) return;
        const sourceClip=this._liveClipForSource(primary);
        if(!sourceClip) return;
        Wave.setSourceMixPeaks(sourceClip,pk,{mixPath:res.wave,channels:chs}); emit('media:timeline');
      }catch(e){ if(!current()) return; }
    }
    if(current()) setStatus('音軌與波形已就緒','ok');
  },

  /* --- ffmpeg.wasm --- */
  async loadFFmpeg(){
    if(this.ffmpeg)return this.ffmpeg;
    if(this.ffmpegLoading)return this.ffmpegLoading;
    this.ffmpegLoading=(async()=>{
      try{
        // Fix #3：優先使用 jsDelivr（更穩定），fallback unpkg
        const CDN_JSDELIVR='https://cdn.jsdelivr.net/npm/@ffmpeg';
        const CDN_UNPKG='https://unpkg.com/@ffmpeg';
        let baseUrl=CDN_JSDELIVR;
        try{ await loadScript(CDN_JSDELIVR+'/ffmpeg@0.11.6/dist/ffmpeg.min.js'); }
        catch(e){ await loadScript(CDN_UNPKG+'/ffmpeg@0.11.6/dist/ffmpeg.min.js'); baseUrl=CDN_UNPKG; }
        const { createFFmpeg } = window.FFmpeg;
        const ff=createFFmpeg({ log:false, corePath:baseUrl+'/core@0.11.0/dist/ffmpeg-core.js' });
        await ff.load();
        this.ffmpeg=ff;
        return ff;
      }catch(e){
        throw e;
      }
    })();
    return this.ffmpegLoading;
  },
  /* Resource loading is shared, but an intake's status belongs to its lease.
     Keep loader UI out of loadFFmpeg(): a stale A can finish downloading the
     worker after B becomes current, so only the caller that still owns its
     intake may announce ready/failed. */
  async _loadFFmpegForIntake(owns=()=>true){
    const stillOwns=typeof owns==='function'?owns:()=>true;
    if(!stillOwns()) return null;
    if(!this.ffmpeg) setStatus('載入 ffmpeg.wasm（首次需下載 ~25MB）…','busy');
    try{
      const ff=await this.loadFFmpeg();
      if(!stillOwns()) return null;
      $('stEngine').textContent='音訊引擎：ffmpeg.wasm';
      setStatus('ffmpeg 就緒','ok');
      return ff;
    }catch(e){
      if(stillOwns()){
        setStatus('ffmpeg 載入失敗（需網路；或改用本機伺服器/Electron 版）','');
        showToast('ffmpeg.wasm 載入失敗：需網路連線，或以本機伺服器開啟本頁');
      }
      throw e;
    }
  },
  runWebFfmpeg(work,{owns=()=>true}={}){
    if(typeof work!=='function') return Promise.reject(new TypeError('ffmpeg.wasm work must be a function'));
    const stillOwns=typeof owns==='function'?owns:()=>true;
    const run=()=>stillOwns()?work():null;
    const result=this._webFfmpegTail.then(run,run);
    this._webFfmpegTail=result.then(()=>undefined,()=>undefined);
    return result;
  },
  async ffprobeTracks(file,{owns=()=>true}={}){
    return this.runWebFfmpeg(async()=>{
      let ff=null, loggerSet=false;
      try{
        if(!owns()) return null;
        ff=await this._loadFFmpegForIntake(owns);
        if(!owns()) return null;
        const data=new Uint8Array(await readFile(file));
        if(!owns()) return null;
        ff.FS('writeFile','probe.in',data);
        let log=''; ff.setLogger(({message})=>{ log+=message+'\n'; }); loggerSet=true;
        try{ await ff.run('-i','probe.in'); }catch(e){}
        if(!owns()) return null;
        const aCount=(log.match(/Stream #\d+:\d+.*: Audio:/g)||[]).length;
        const vCount=(log.match(/Stream #\d+:\d+.*: Video:/g)||[]).length;
        return {aCount,vCount,log};
      }finally{
        if(ff){
          if(loggerSet) try{ff.setLogger(()=>{});}catch(e){}
          try{ff.FS('unlink','probe.in');}catch(e){}
        }
      }
    },{owns});
  },
  async extractAllAudio(file,count,{owns=()=>true}={}){
    return this.runWebFfmpeg(()=>this._extractAllAudio(file,count,{owns}),{owns});
  },
  async _extractAllAudio(file,count,{owns=()=>true}={}){
    let ff;
    try{
      if(!owns()) return false;
      ff=await this._loadFFmpegForIntake(owns);
      if(!owns()) return false;
      this.ensureCtx();
      const data=new Uint8Array(await readFile(file));
      if(!owns()) return false;
      ff.FS('writeFile','in.media',data);
      for(let i=0;i<count;i++){
        if(!owns()) return false;
        setStatus(`抽取音軌 ${i+1}/${count}…`,'busy');
        await ff.run('-i','in.media','-map',`0:a:${i}`,'-ac','2','-ar','48000',`a${i}.wav`);
        if(!owns()) return false;
        const wav=ff.FS('readFile',`a${i}.wav`);
        const ab=await AudioEngine.decodeAudioData(wav.buffer.slice(0));
        if(!owns()) return false;
        const g=AudioEngine.createGain(); AudioEngine.connectToMaster(g);
        this.tracks.push({id:'ex'+i,name:'抽取音軌 '+(i+1),kind:'buffer',buffer:ab,gain:g,muted:false,solo:false,volume:1});
      }
      if(!owns()) return false;
      this.usingWebAudio=true; this.syncMuteState();
      setStatus('多音軌抽取完成','ok'); emit('media:audioTracks');
      if(this.playing){ this.stopBufferSources(); this.startBufferSources(video.currentTime); }
      return true;
    }catch(e){
      if(!owns()) return false;
      setStatus('音軌抽取失敗','');console.error(e);
      return false;
    }finally{
      // Fix #5：不論成功或失敗都清除 ffmpeg 虛擬 FS，防記憶體洩漏與後續「file already exists」
      if(ff){
        try{ ff.FS('unlink','in.media'); }catch(e){}
        for(let i=0;i<count;i++) try{ ff.FS('unlink',`a${i}.wav`); }catch(e){}
      }
    }
  },
  async transcodeAndExtract(file,projectRestore=null,{owns=()=>true}={}){
    if(!owns()) return false;
    if(file.size>FFMPEG_MAX_BYTES){
      if(!owns()) return false;
      this.audioPanelNotice=webAudioCapabilityNotice(file,{nativePreview:false});
      emit('media:audioTracks');
      setStatus('','');
      openModal('檔案過大',
        `<b>${file.name}</b> 約 ${(file.size/1e9).toFixed(2)} GB。<br><br>`+
        `瀏覽器內的 ffmpeg.wasm 受記憶體限制，無法處理數 GB 的 MXF/非原生影片。<br><br>`+
        `建議：<br>• 先用本機 ffmpeg 轉成 MP4(H.264/AAC) 後再匯入<br>`+
        `• 或改用 <b>Electron 桌面版</b>（可直接讀 MXF 與多音軌同時播放）<br><br>`+
        `字幕編輯、時間軸與所有匯入/匯出功能仍可正常使用（可先載入波形用的音訊檔）。`);
      return false;
    }
    /* ffmpeg.wasm has one virtual filesystem and cannot run two primary
       transcodes concurrently.  A stale A cleans up before B may write the
       same in.media / prev.mp4, and probes/exports use the same lane. */
    const work=()=>this._transcodeAndExtract(file,projectRestore,{owns});
    return this.runWebFfmpeg(work,{owns});
  },
  async _transcodeAndExtract(file,projectRestore=null,{owns=()=>true}={}){
    let ff=null;
    let ownsWork=owns;
    const tempAudioFiles=[];
    try{
      ff=await this._loadFFmpegForIntake(owns);
      if(!owns()) return false;
      this.ensureCtx();
      const data=new Uint8Array(await readFile(file));
      if(!owns()) return false;
      ff.FS('writeFile','in.media',data);
      const probe=await (async()=>{ let log='';ff.setLogger(({message})=>log+=message+'\n');try{await ff.run('-i','in.media');}catch(e){}ff.setLogger(()=>{});return log;})();
      if(!owns()) return false;
      const aCount=(probe.match(/Stream #\d+:\d+.*: Audio:/g)||[]).length; // 0=無音軌：跳過抽取，不可 ||1 強抽（會整段誤報「轉檔失敗」）
      setStatus('轉檔預覽影片中…','busy');
      await ff.run('-i','in.media','-c:v','libx264','-preset','ultrafast','-crf','26','-an','-movflags','+faststart','prev.mp4');
      if(!owns()) return false;
      const mp4=ff.FS('readFile','prev.mp4');
      const url=URL.createObjectURL(new Blob([mp4.buffer],{type:'video/mp4'})); this.objectURLs.push(url);
      video.src=url; video.muted=true; setPlayerAdapter(new Html5Adapter(video));
      const metadataOutcome=await waitForOwnedMediaMetadata(video,{owns,timeoutMs:10000});
      if(metadataOutcome==='cancelled'||!owns()) return false;
      if(metadataOutcome!=='ready') throw new Error(`轉檔預覽影片 metadata ${metadataOutcome}`);
      $('noVideo').style.display='none';
      State.duration=video.duration||0;
      const primary=this._registerPrimary({ name:file.name, web:{url}, dur:State.duration||0 },projectRestore);
      ownsWork=()=>owns()&&this._sourceStillReferenced(primary);
      AudioPipeline.registerSource(primary,Array.from({length:aCount},(_,sourceStream)=>({sourceStream,sourceChannel:0})));
      // 抽音軌
      for(let i=0;i<aCount;i++){
        if(!ownsWork()) return false;
        setStatus(`抽取音軌 ${i+1}/${aCount}…`,'busy');
        tempAudioFiles.push(`a${i}.wav`);
        await ff.run('-i','in.media','-map',`0:a:${i}`,'-ac','2','-ar','48000',`a${i}.wav`);
        if(!ownsWork()) return false;
        const wav=ff.FS('readFile',`a${i}.wav`);
        const ab=await AudioEngine.decodeAudioData(wav.buffer.slice(0));
        if(!ownsWork()) return false;
        const g=AudioEngine.createGain(); AudioEngine.connectToMaster(g);
        const sourceClip=this._liveClipForSource(primary);
        if(!sourceClip) return false;
        this.tracks.push(this.bindTrackRouting({id:'ex'+i,name:'音軌 '+(i+1),kind:'buffer',source:'video',buffer:ab,gain:g,muted:!!sourceClip.muted,solo:false,volume:1,file:file},sourceClip,{sourceStream:i,sourceChannel:0},i));
        try{ff.FS('unlink',`a${i}.wav`);}catch(e){}
      }
      if(!ownsWork()) return false;
      this.usingWebAudio=true; this.syncMuteState();
      setStatus('轉檔完成','ok'); emit('media:audioTracks');
      Wave.fromTracks();
      emit('duration:known');
      return true;
    }catch(e){
      // A cancellation can surface as a rejected ff.run.  It is not an error
      // for the now-current B intake and must not overwrite B's UI status.
      if(!ownsWork()) return false;
      setStatus('轉檔失敗','');console.error(e);showToast('ffmpeg 轉檔失敗');
      return false;
    }finally{
      // The ffmpeg lane above prevents a stale A from deleting B's virtual
      // files while B runs.  Always release partial files on every exit path.
      if(ff){
        try{ff.FS('unlink','in.media');}catch(e){}
        try{ff.FS('unlink','prev.mp4');}catch(e){}
        for(const name of tempAudioFiles) try{ff.FS('unlink',name);}catch(e){}
      }
    }
  },

  /* 把影片內建音訊接到 Web Audio（同一 video 元素只能 createMediaElementSource 一次，故重用） */
  connectNativeAudio(){
    this.ensureCtx();
    if(!this.videoSrcNode){
      try{ this.videoSrcNode=AudioEngine.createMediaElementSource(video); }
      catch(e){ console.warn('MediaElementSource',e); return null; }
    } else { try{ this.videoSrcNode.disconnect(); }catch(e){} }
    const g=AudioEngine.createGain(); this.videoSrcNode.connect(g); AudioEngine.connectToMaster(g);
    return g;
  },
  /* 立體聲分頻：L / R 各自一條 native 音軌，可獨立靜音/獨奏/電平表 */
  _connectStereo(sourceName='video', clip=null){
    this.ensureCtx();
    if(!this.videoSrcNode){
      try{ this.videoSrcNode=AudioEngine.createMediaElementSource(video); }
      catch(e){ console.warn('MediaElementSource',e); return null; }
    } else { try{ this.videoSrcNode.disconnect(); }catch(e){} }
    const splitter=AudioEngine.createChannelSplitter(2);
    const gL=AudioEngine.createGain(), gR=AudioEngine.createGain();
    const merger=AudioEngine.createChannelMerger(2);
    this.videoSrcNode.connect(splitter);
    splitter.connect(gL,0); splitter.connect(gR,1);
    gL.connect(merger,0,0); gR.connect(merger,0,1);
    AudioEngine.connectToMaster(merger);
    const mkAn=()=>AudioEngine.createAnalyser();
    const anL=mkAn(), anR=mkAn();
    splitter.connect(anL,0); splitter.connect(anR,1);
    const mk=(id,nm,g,an,index)=>this.bindTrackRouting(
      {id,name:nm,kind:'native',source:sourceName,gain:g,muted:!!clip?.muted,solo:false,volume:1,
        analyser:an,_mbuf:new Float32Array(an.fftSize),level:0,peak:0,peakT:0},
      clip,null,index
    );
    return [mk('native-L','L 聲道',gL,anL,0), mk('native-R','R 聲道',gR,anR,1)];
  },
  /* 將 MediaElementSourceNode 按聲道分頻，回傳音軌陣列 */
  _splitToChannelTracks(node, sourceName, el, chCount, clip=null, descriptors=null){
    const n=Math.max(1,chCount);
    const labels=n===1?['Mono']:n===2?['L','R']:n===6?['FL','FR','C','LFE','SL','SR']:Array.from({length:n},(_,i)=>`Ch${i+1}`);
    const splitter=AudioEngine.createChannelSplitter(n);
    node.connect(splitter);
    return labels.map((lbl,i)=>{
      const g=AudioEngine.createGain();
      const an=AudioEngine.createAnalyser();
      splitter.connect(an,i); splitter.connect(g,i); AudioEngine.connectToMaster(g);
      return this.bindTrackRouting(
        {id:'ext'+(_extTrackIdCounter++),name:lbl,kind:'element',source:sourceName,
          el,gain:g,muted:!!clip?.muted,solo:false,volume:1,
          analyser:an,_mbuf:new Float32Array(an.fftSize),level:0,peak:0,peakT:0},
        clip,Array.isArray(descriptors)?descriptors[i]:null,i
      );
    });
  },
  /* 為音軌掛上電平表 analyser：取「源頭」訊號（與 mute/solo 無關），播放時即有資料，
     讓使用者就算某聲道沒開也能從表頭看出它有沒有內容 */
  attachMeter(tr, sourceNode){
    if(!AudioEngine.isReady||!sourceNode)return;
    try{
      const an=AudioEngine.createAnalyser();
      sourceNode.connect(an);
      tr.analyser=an; tr._mbuf=new Float32Array(an.fftSize); tr.level=0; tr.peak=0; tr.peakT=0;
    }catch(e){}
  },
  hasMix(){ return this.tracks.some(t=>t.kind==='buffer'||t.kind==='element'); },

  /* --- 時間軸 transport：driver 只提供來源時間，時間軸位置由此單一核心管理。 --- */
  _transport: new TimelineTransport({
    toTimeline: (sourceTime, clip) => Seq.toTimeline(sourceTime, clip),
    toSource: (timelineTime, clip) => Seq.toSource(timelineTime, clip),
  }),
  // 兼容既有的 Media 私有欄位讀取（History / WebCodecs / app）；值仍只存於 _transport。
  get _vTime(){ return this._transport.virtualTime; },
  set _vTime(value){ this._transport.virtualTime = value; },
  get _vStart(){ return this._transport.virtualStartedAt; },
  set _vStart(value){ this._transport.virtualStartedAt = value; },
  get _lastSeekTime(){ return this._transport.pausedTime; },
  set _lastSeekTime(value){ this._transport.pausedTime = value; },
  vTime(){
    // 所有影片段都被移除後，仍可保留／播放獨立音訊素材；這時不能再讀取
    // 停住的 <video> currentTime，必須改由虛擬時鐘推進時間軸。
    const virtual=this.audioOnlyTimeline()||(!this.mpvMode&&!video.hasAttribute('src'));
    if(virtual) return this._transport.virtualTimeAt(video.playbackRate||1);
    if(this.mpvMode) return this._mpvTime;
    return video.currentTime||0;
  },
  // FPS-SYNC：播放點的【權威位置】。暫停時回傳已對齊影格的 _lastSeekTime，播放中才回傳原始
  // 時間。所有「靜止」讀數（播放器時碼 tcCur、時間軸播放點、seekBar）都【必須】以此為來源，
  // 不可直接讀 video.currentTime / mpv e.data，否則會與刻度差一格。詳見 FPS_時碼一致性.md。
  // 序列模式後 displayTime/_lastSeekTime 一律為【時間軸時間】。
  displayTime(){
    const virtual=this.audioOnlyTimeline()||(!this.mpvMode&&!video.hasAttribute('src'));
    const clip=this.seqOn()?this._activeClip():null;
    return this._transport.displayTime({
      playing:this.playing, sourceTime:this.vTime(), clip, virtual,
      playbackRate:video.playbackRate||1,useGap:this.seqOn(),
    });
  },

  /* ===== 影片序列層（多 clip；見 sequence.js） =====================================
     時間域約定：對外（seek/displayTime/字幕/播放頭/tcCur/seekBar）一律「時間軸時間」；
     播放器內部（video.currentTime / mpv time-pos / _mpvTime / vTime()）一律「來源時間」，
     由本層透過 Seq.toSource/toTimeline 互轉。單一 clip 且 offset=0、in=0 時為恆等映射。
     「間隙」（時間軸上沒有影片的區段）：畫面黑、播放頭以虛擬時鐘（_gapT/_gapStart）續走。 */
  activeClipId:null,
  get _gap(){ return this._transport.gap; },
  set _gap(value){ this._transport.gap = value; },
  get _gapT(){ return this._transport.gapTime; },
  set _gapT(value){ this._transport.gapTime = value; },
  get _gapStart(){ return this._transport.gapStartedAt; },
  set _gapStart(value){ this._transport.gapStartedAt = value; },
  _seqSwitching:false,
  _seqSwitchToken:null,
  seqOn(){ return State.clips.some(c => c.type !== 'image'); },
  audioOnlyTimeline(){ return !this.seqOn() && this.externalAudio.timelineEnd()>0; },
  _activeClip(){ return Seq.byId(this.activeClipId); },

  /* ===== 播放呈現狀態的對外查詢 ===============================================
     以下五個是給 app.js／pointer-interaction.js／decode/player.js 用的公開入口。
     它們背後的 _gap / _wcTakeover / _activeClip 以前是被【模組外直接讀】的底線
     名稱——呼叫端因此得知道 Media 的內部欄位長什麼樣，改名就會靜默壞掉。

     mpvPresenting() 特別值得存在：`mpvMode && !_wcTakeover` 這個組合原本在
     app.js 與 pointer-interaction.js 手寫了七次，任何一處漏掉 `!_wcTakeover`，
     WebCodecs 接管期間就會把 guide／命中層送去 mpv——畫面看起來正常，但點不到。 */
  activeClip(){ return this._activeClip(); },
  inGap(){ return !!this._gap; },
  sourceLocalTime(srcId, t){ return this._srcLocalT(srcId, t); },
  /* mpv 正在自己出圖（WebCodecs 尚未接管） */
  mpvPresenting(){ return !!(this.mpvMode && !this._wcTakeover); },
  /* WebCodecs 是否已接管畫面（mpv 視窗讓位）。與 _wcComposited 不同：
     這個是「有沒有叫 mpv 讓位」，_wcComposited 是「WC 這一輪有沒有真的畫出東西」。 */
  webCodecsTakeover(){ return !!this._wcTakeover; },
  setWebCodecsTakeover(v){ this._wcTakeover = !!v; },
  setWebCodecsComposited(v){ this._wcComposited = !!v; },
  webCodecsProxyUrl(){ return this._wcProxyUrl; },
  webCodecsProxyPath(){ return this._wcProxyPath; },
  /* 時間軸權威時間（播放中） */
  tlTime(){
    const virtual=this.audioOnlyTimeline()||(!this.mpvMode&&!video.hasAttribute('src'));
    const clip=this.seqOn()?this._activeClip():null;
    return this._transport.timelineTime({
      sourceTime:this.vTime(), clip, virtual, playbackRate:video.playbackRate||1,useGap:this.seqOn(),
    });
  },
  /* 預覽淡出入黑「黑暗程度」0..1：依最上層片段的淡入/淡出與該視訊軌透明度計算（間隙本就是黑，回 0 不另疊） */
  previewFadeDarkness(){
    if(!this.seqOn() || this._gap) return 0;
    const c = this._activeClip(); if(!c) return 0;
    const t = this.tlTime();
    // 淡入淡出公式與時間域轉換只有 clip-fade.js 一份；這裡原本內聯了一份相同的算式。
    let vis = fadeAlphaAtTimeline(c, t);
    const vt = State.videoTracks[c.vtrack || 0];
    if(vt && vt.opacity != null && vt.opacity < 1) vis *= Math.max(0, vt.opacity);
    return clamp(1 - vis, 0, 1);
  },
  /* 每幀套用預覽淡出入黑：原生用黑幕 opacity；mpv 用 brightness（-100＝最暗，僅在變動時送 IPC） */
  applyPreviewFade(){
    const ov = $('previewFade');
    // WebCodecs 真合成呈現中（WCPreview 每幀設旗標）：淡變/透明度已由 canvas 逐層 alpha 承擔，
    // 黑幕與 mpv brightness 都歸零否則雙重變暗（mpv 模式下 WC 接管時 mpv 視窗已隱藏）。
    if(this._wcComposited){
      if(ov && ov.style.opacity !== '0') ov.style.opacity = '0';
      if(this._mpvBright){ this._mpvBright = 0; try{ getPlayerAdapter()?.brightness(0); }catch(e){} }
      return;
    }
    const d = this.previewFadeDarkness();
    if(this.mpvMode){
      const b = Math.round(-100 * d);
      if(b !== this._mpvBright){ this._mpvBright = b; try{ getPlayerAdapter()?.brightness(b); }catch(e){} }
      if(ov && ov.style.opacity !== '0') ov.style.opacity = '0';
    }else{
      if(ov){ const sv = d.toFixed(3); if(ov.style.opacity !== sv) ov.style.opacity = sv; }
      if(this._mpvBright){ this._mpvBright = 0; try{ getPlayerAdapter()?.brightness(0); }catch(e){} }
    }
  },
  /* 依 clip 切換「可聽見」的音軌集合：clip 綁定的（'video' 或 'clip:*'）只留當前 clip，
     ext-*（外部參考音檔）不受影響、永遠跟時間軸。
     audioSrc：同一來源檔切割出的片段共用同一組音軌（'video'＝主媒體、'clip:<原始id>'＝加入的影片） */
  /* 音源 srcId 在時間軸時間 t 的來源時間（取該音源於 t 作用中的片段）；無則 null */
  _srcLocalT(srcId, t){
    for(const cl of State.clips){
      const s = cl.audioSrc || (cl.primary ? 'video' : ('clip:' + cl.id));
      if(s === srcId && Seq.isActiveAt(cl, t)) return Seq.toSource(t, cl);
    }
    return null;
  },
  /* seek 時把各 clip 綁定 element 音軌同步到【自己音源】的來源時間（疊合時各段 offset 不同，不能一律用 active 的 local） */
  _syncSeqElements(t){
    for(const tr of this.tracks){
      if(tr.kind!=='element'||!tr.el) continue;
      if(tr._srcHidden || (tr.source||'').startsWith('ext-')) continue;
      const lt = this._srcLocalT(tr.source || 'video', t);
      if(lt == null) continue;
      try{ tr.el.currentTime = clamp(lt, 0, tr.el.duration || lt); }catch(e){}
    }
  },
  /* 原生主影片（source 'video' 僅有 native 音軌、無獨立 element/buffer）疊合試聽用的獨立播放器：
     建一個 <audio> 載入主影片檔、接進混音圖。重疊時 native 會被其他片段 element 的 activeMix 抑制而消失，
     改用此獨立播放器播主影片聲音（見 _applyClipAudio 的 _srcHidden 判定；MXF 等已有獨立音軌者不建）。 */
  _ensureAltPrimaryEl(){
    if(!AudioEngine.isReady) return null;
    let tr = this.tracks.find(t => t._altPrimary);
    if(tr) return tr;
    if(this.tracks.some(t => (t.source||'video')==='video' && (t.kind==='element'||t.kind==='buffer'))) return null; // 已有獨立音軌
    const pri = Seq.primary(); const url = pri && pri.web && pri.web.url; if(!url) return null;
    try{
      const el = new Audio(); el.src = url; el.preload='auto';
      // 載入完成後校正一次：建立當下檔案常尚未載入，seek 不準（會慢/停在低點）→ ready 後重對來源時間
      el.addEventListener('canplay', ()=>{
        const at = this.tracks.find(x=>x._altPrimary);
        if(this.playing && at && !at._srcHidden){ const lt=this._srcLocalT('video', this.tlTime());
          if(lt!=null){ try{ el.currentTime=clamp(lt,0,el.duration||lt); el.playbackRate=video.playbackRate||1; if('preservesPitch' in el) el.preservesPitch = (el.playbackRate >= 0.25 && el.playbackRate <= 4); el.play(); }catch(e){} } }
      }, {once:true});
      const node = AudioEngine.createMediaElementSource(el);
      const g = AudioEngine.createGain(); node.connect(g); AudioEngine.connectToMaster(g);
      tr = { id:'altpri', name:'主影片音訊', kind:'element', el, gain:g, muted:!!pri?.muted, solo:false, volume:1, source:'video', _altPrimary:true, _srcHidden:true };
      this.tracks.push(tr);
      return tr;
    }catch(e){ console.warn('altPrimary', e); return null; }
  },
  _applyClipAudio(c, t){
    const src = c.audioSrc || (c.primary ? 'video' : ('clip:' + c.id));
    this.activeSource = src;
    // 疊合試聽：所有在該時間點【作用中】的片段音源都可聽（不只最上層），其餘才靜音。
    const tt = (t != null) ? t : (this.seqOn() ? Seq.toTimeline(this.vTime(), c) : this.vTime());
    const act = Seq.clipsAt(tt);
    // 解除影音連結後，影片畫面仍在序列中，但其原始音軌不可再出聲；獨立建立的
    // ext-* 音訊素材會按自己的 placement 播放。相同來源的切割段會一併設為
    // audioDetached，避免共用的 Web Audio source 在某一段又意外恢復聲音。
    const audible = new Set();
    for(const cl of act){
      if(!cl.audioDetached) audible.add(cl.audioSrc || (cl.primary ? 'video' : ('clip:' + cl.id)));
    }
    // 原生主影片處於重疊時 → 用獨立 <audio> 播其聲音（native 會被 activeMix 抑制）
    const videoOverlap = audible.has('video') && act.filter(cl=>!cl.audioDetached).length > 1;
    if(videoOverlap) this._ensureAltPrimaryEl();
    for(const tr of this.tracks){
      if(tr._altPrimary){ tr._srcHidden = !videoOverlap; continue; }
      const s = tr.source || 'video';
      if(s === 'video' || s.startsWith('clip:')) tr._srcHidden = !audible.has(s);
    }
    if(!this.mpvMode) video.muted=this.hasMix()?true:(State.muted||!!c.audioDetached);
    this.applyGains(); emit('media:audioTracks');
  },
  _enterGap(t){
    this._transport.enterGap(t,{running:this.playing});
    this.activeClipId = null;
    this.stopElementSources(); this.stopBufferSources();
    if(this.mpvMode){ getPlayerAdapter()?.pause().catch(()=>{}); emit('mpv:sync'); } // _syncMpvPanel 依 Media._gap 隱藏 mpv
    else if(video.hasAttribute('src')){ try{ video.pause(); }catch(e){} video.style.visibility='hidden'; }
  },
  _leaveGap(){
    this._transport.leaveGap();
    if(!this.mpvMode) video.style.visibility = '';
    emit('mpv:sync');
  },
  /* 把播放器對到指定 clip 的來源時間（必要時換檔）。resume=切換後是否續播 */
  async _ensureClip(c, localT, resume){
    if(this._seqSwitching||!State.clips.includes(c)) return;
    if(c.type === 'image') return; // 圖片是純視覺疊層，不經過播放引擎
    if(resume === undefined) resume = this.playing;
    if(this.activeClipId === c.id && !this._gap){ this._playerSeekSource(localT); return; }
    const projectOperation=this._assetOperation(null,{kind:'sequence-switch',id:c.id});
    const switchToken=Object.freeze({projectOperation,clip:c});
    const owns=()=>this._seqSwitchToken===switchToken&&this._ownsAssetOperation(projectOperation)&&
      State.clips.includes(c)&&this.activeClipId===c.id;
    this._seqSwitchToken=switchToken;
    this._seqSwitching = true;
    let retryIfSuperseded=true;
    try{
      this.activeClipId = c.id;
      this._leaveGap();
      this.stopBufferSources(); // buffer 音軌隸屬 primary：換段先停，resume 時依 _srcHidden 決定是否重啟
      const _tl = Seq.toTimeline(localT, c);
      this._applyClipAudio(c, _tl);
      this._lastOverlapKey = Seq.clipsAt(_tl).filter(x=>x.type !== 'image').map(x=>x.id).join('|');
      if(this.mpvMode){
        if(c.path && getPlayerAdapter().isAvailable){
          this.stopElementSources();
          if(this._mpvPath !== c.path){ // 不同來源檔才需 loadfile（同檔切割片段只 seek，近乎無縫）
            const r = await getPlayerAdapter().loadfile(c.path).catch(err=>{ console.error('mpv loadfile', err); return null; });
            if(!owns()) return;
            if(!r || r.ok === false){ // 無聲失敗要浮上來（先前被吞掉，看起來像「無法播放」）
              retryIfSuperseded=false;
              setStatus(`mpv 無法載入「${c.name}」`, 'err');
              showToast(`mpv 無法載入影片段「${c.name}」（格式不支援或檔案無法讀取）`);
              this._enterGap(_tl);
              return;
            }
            if(r && r.duration) Seq.updateSourceDur(c, r.duration);
            this._mpvPath = c.path;
          }
          this._mpvTime = localT;
          getPlayerAdapter().seek(localT).catch(()=>{});
          // mpv 靜音隨「當前段是否已有元素音軌」同步：有→靜音（元素接管），無→出聲
          //（否則主媒體音軌就緒後 mute(true) 會讓沒有元素音軌的新段完全無聲）
          const _srcKey = c.audioSrc || (c.primary ? 'video' : ('clip:' + c.id));
          const _hasEls = this.tracks.some(tr => (tr.source||'video') === _srcKey && tr.kind === 'element');
          getPlayerAdapter().mute(_hasEls || c.audioDetached || State.muted).catch(()=>{});
          emit('mpv:refreshSubs'); // 換 clip 後字幕需以新映射重擠（app.js 會做 offset 位移）
          if(resume){ getPlayerAdapter().play().catch(()=>{}); this.startElementSources(localT, Seq.toTimeline(localT, c)); }
          else getPlayerAdapter().pause().catch(()=>{});
        }
      } else {
        const url = c.web && c.web.url;
        if(url && video.src !== url){
          this.stopElementSources();
          video.src = url; setPlayerAdapter(new Html5Adapter(video));
          const metadata=await waitForOwnedMediaMetadata(video,{owns,timeoutMs:8000});
          if(!owns()) return;
          if(metadata!=='ready'){
            retryIfSuperseded=false;
            setStatus(`無法載入影片段「${c.name}」`,'err');
            showToast(`無法載入影片段「${c.name}」（metadata ${metadata}）`);
            try{ video.pause(); video.removeAttribute?.('src'); video.src=''; video.load?.(); }catch(error){}
            this._enterGap(_tl);
            return;
          }
          if(video.duration) Seq.updateSourceDur(c, video.duration);
        }
        if(!owns()) return;
        try{ video.currentTime = localT; }catch(e){}
        if(resume){
          try{ video.play(); }catch(e){}
          this.startElementSources(localT, Seq.toTimeline(localT, c));
          if(this.tracks.some(t=>t.kind==='buffer'&&!t._srcHidden)) this.startBufferSources(localT);
        }
        else { try{ video.pause(); }catch(e){} }
      }
      if(owns()) emit('render:videoSub');
    } finally {
      if(this._seqSwitchToken===switchToken){
        const retryCurrentTimeline=retryIfSuperseded&&!owns();
        const retryAt=this.displayTime();
        this._seqSwitchToken=null;
        this._seqSwitching=false;
        if(retryCurrentTimeline){
          if(this.activeClipId===c.id) this.activeClipId=null;
          queueMicrotask(()=>{
            if(!this._seqSwitching&&this.seqOn()) this.seek(retryAt);
          });
        }
      }
    }
  },
  _playerSeekSource(s){
    if(this.mpvMode){ this._mpvTime = s; getPlayerAdapter()?.seek(s).catch(()=>{}); }
    else if(video.hasAttribute('src')){ try{ video.currentTime = s; }catch(e){} }
  },
  /* 播放中的每幀檢查（rafLoop 呼叫）：段尾切換 / 間隙進出 / 序列結尾停止 */
  seqTick(){
    if(!this.playing || this._seqSwitching) return;
    // 純音訊專案（或影片全數刪除後）以虛擬時鐘繼續走到所有音訊素材的最右端。
    if(this.audioOnlyTimeline()){
      const t=this.tlTime();
      this._syncExternalElementActivity(t);
      if(t >= Math.max(0,State.duration)-0.02){ this.pause(); this.seek(State.duration); }
      return;
    }
    if(!this.seqOn()) return;
    const t = this.tlTime();
    // 外部音檔可在影片播放中、影片間隙，或影片結束後才開始／結束；其邊界
    // 不會改變 video clip 集合，因此必須獨立偵測。
    this._syncExternalElementActivity(t);
    // 恆等模式（單一未修剪 clip 從 0 開始）：完全交給原生 ended / mpv keep-open，行為與舊版一致
    // 圖片不計入：它們是純視覺疊層，不影響影片播放引擎
    const _videoClips = State.clips.filter(c => c.type !== 'image');
    const c0 = _videoClips[0];
    if(_videoClips.length === 1 && c0 && !this._gap && c0.offset === 0 && c0.in === 0
       && Math.abs(c0.out - c0.dur) < 0.05 && this.activeClipId === c0.id) return;
    if(this._gap){
      const hit = Seq.clipAt(t);
      if(hit){ this._ensureClip(hit, this._transport.sourceTime(t,hit), true); return; }
      if(!Seq.nextAfter(t) && t >= Math.max(0,State.duration)-0.02){ this.pause(); } // 影片結束後仍可能有外部音訊
      return;
    }
    const c = this._activeClip();
    if(!c){ const hit = Seq.clipAt(t); if(hit) this._ensureClip(hit, this._transport.sourceTime(t,hit), true); else this._enterGap(t); return; }
    // 疊合試聽：作用中片段集合變化 → 重設可聽音源並同步各自 element/buffer（讓滑入/滑出重疊的片段跟著出/停聲）。
    // okey 相同時不動，避免逐幀 churn；不改變影像的 active clip。
    const okey = Seq.clipsAt(t).filter(x=>x.type !== 'image').map(x=>x.id).join('|');
    if(okey !== this._lastOverlapKey){
      this._lastOverlapKey = okey;
      this._applyClipAudio(c, t);
      this.startElementSources(this.vTime(), t);
      this.stopBufferSources();
      if(this.tracks.some(x=>x.kind==='buffer'&&!x._srcHidden)) this.startBufferSources(this.vTime());
    }
    const end = Seq.clipEnd(c);
    if(t >= end - 0.02){
      const nxt = Seq.clipAt(end + 0.001);
      if(nxt) this._ensureClip(nxt, this._transport.sourceTime(end,nxt), true);
      else if(Seq.nextAfter(end)) this._enterGap(end);
      else if(State.duration > end + 0.001){
        this._enterGap(end);
        this.startElementSources(end,end); // 黑畫面期間外部音訊仍依時間軸繼續播
      }else { this.pause(); this.seek(end); }
    }
  },
  /* video 'ended'（原生模式段尾）：序列還有後續 → 立即推進並回 true（呼叫端不 pause） */
  seqContinueAtEnd(){
    if(!this.seqOn() || !this.playing || this._seqSwitching) return false;
    const c = this._activeClip(); if(!c) return false;
    const end = Seq.clipEnd(c);
    const nxt = Seq.clipAt(end + 0.001);
    if(nxt){ this._ensureClip(nxt, this._transport.sourceTime(end,nxt), true); return true; }
    if(Seq.nextAfter(end)){ this._enterGap(end); return true; }
    if(State.duration > end + 0.001){ this._enterGap(end); this.startElementSources(end,end); return true; }
    return false;
  },
  /* 第一支影片載入完成時登錄為 primary clip（reset() 已清空舊序列） */
  _registerPrimary(meta,projectRestore=null){
    // 已開啟的 v3 專案會在 ProjectLoadSession 的 restore plan 保留片段幾何；
    // 主片段需沿用其 audioSourceId，否則重新載入後原本設定的聲道路由會找不到來源。
    // Keep restore material in the plan until this transaction commits. A
    // destructive take here loses every remaining clip if History or a newer
    // project supersedes one slow probe halfway through restoration.
    const pending=[...(projectRestore?.pendingClips?.()||[])];
    const pendingPrimary=pending.find(x=>x?.primary)||pending.find(x=>x?.path&&x.path===meta.path)||pending.find(x=>x?.name&&x.name===meta.name)||null;
    const projectRelink=projectRestore?.consumeMediaRelink?.()===true;
    const audioSourceId=meta.audioSourceId||pendingPrimary?.audioSourceId||makeAudioSourceId();
    const c = Seq.add({ ...meta, primary: true, audioSrc: 'video', audioSourceId, audioDetached:!!pendingPrimary?.audioDetached, offset: 0 });
    const restoreSequenceVersion=this._sequenceEditVersion;
    const restoreBaseOwns=()=>
      (!projectRestore?.owns||projectRestore.owns())&&
      this._sequenceEditVersion===restoreSequenceVersion&&
      this._sourceStillReferenced(c);
    const restoreOperation=this._assetOperation(null,{kind:'project-clip-restore',id:c.id},restoreBaseOwns);
    const restoreOwns=()=>this._ownsAssetOperation(restoreOperation);
    this.activeClipId = c.id;
    this._restorePreservedImageTimeline();
    // 開啟專案時還原其餘 clip（桌面：同一路徑且同 audioSourceId 的切割片段共用資源、只 ingest 一次）
    const pend = pending;
    const restoredProjectClips=[];
    const transactionClips=[];
    const rememberTransactionClip=clip=>{
      if(clip){ transactionClips.push(clip); restoredProjectClips.push(clip); }
      return clip;
    };
    const rollbackTransaction=()=>{
      for(const clip of transactionClips.splice(0).reverse()){
        if(clip?.id&&Seq.byId(clip.id)===clip) this.removeClip(clip.id);
      }
    };
    if(projectRelink) restoredProjectClips.push(c);
    let pendingRestore=Promise.resolve();
    const pri = pendingPrimary;
    if(pri){
      // 首段幾何不論 desktop/browser 都要先回到專案快照；後者無法自動重開
      // 所有本機 File，但至少不會在使用者重新選回主檔時遺失 trim/offset/track。
      c.in = pri.in ?? 0; c.out = Math.min(pri.out ?? c.dur, c.dur); c.offset = pri.offset ?? 0;
      c.vtrack = pri.vtrack || 0; c.fadeIn = pri.fadeIn || 0; c.fadeOut = pri.fadeOut || 0;
      if (pri.muted != null) c.muted = pri.muted;
      c.audioDetached=!!pri.audioDetached;
      Seq.sort(); Seq.recomputeDuration();
    }
    if(DESK && Array.isArray(pend)){
      if(pri&&!restoredProjectClips.includes(c)) restoredProjectClips.push(c);
      pendingRestore=(async()=>{
        // 同一實體檔可被使用者匯入成兩個獨立媒體 asset；它們的路由必須保持分開。
        // 舊專案尚無 audioSourceId 時才退回 path-only 相容鍵。
        const resourceKey=item=>{
          const path=String(item?.path||'');
          const sourceId=typeof item?.audioSourceId==='string'?item.audioSourceId.trim():'';
          return path+'\u0000'+(sourceId?'asset:'+sourceId:'legacy');
        };
        const made = new Map(); if(c.path) made.set(resourceKey(pri||c), c);
        const remaining=[];
        for(const pc of pend){
          if(!restoreOwns()){ rollbackTransaction(); return; }
          if(pc === pri) continue;
          if(!pc.path){ remaining.push(pc); continue; }
          // 圖片是靜態視覺疊層，不可走 addClipDesktop（它會以 ffprobe 當成
          // 影片，因而在重開專案時遺失）。每一個圖片 placement 都要獨立
          // 重建，才能保留自己的裁切時間、大小與位置。
          if(pc.type==='image'){
            const image=await this.addImageDesktop(pc.path,{...pc,_restore:true},restoreOperation).catch(()=>null);
            if(!restoreOwns()){
              if(image?.id&&Seq.byId(image.id)===image) transactionClips.push(image);
              rollbackTransaction();
              return;
            }
            if(image) rememberTransactionClip(image); else remaining.push(pc);
            continue;
          }
          const key=resourceKey(pc);
          const base = made.get(key);
          if(base){ // 同一 asset 的切割片段：直接建 clip 共用資源
            const piece = Seq.add({ name: pc.name || base.name, path: base.path, web: base.web || null,
              dur: base.dur, fps: base.fps || 0, peaks: base.peaks, vtrack: pc.vtrack || 0,
              audioSrc: base.audioSrc || ('clip:' + base.id),
              audioSourceId: base.audioSourceId || pc.audioSourceId || makeAudioSourceId(),
              audioDetached:!!pc.audioDetached,
              fadeIn: pc.fadeIn || 0, fadeOut: pc.fadeOut || 0,
              in: pc.in ?? 0, out: Math.min(pc.out ?? base.dur, base.dur), offset: pc.offset ?? undefined });
            if(pc.offset != null) piece.offset = pc.offset;
            rememberTransactionClip(piece);
          } else {
            const added = await this.addClipDesktop(pc.path, pc, restoreOperation).catch(()=>null);
            if(!restoreOwns()){
              if(added?.id&&Seq.byId(added.id)===added) transactionClips.push(added);
              rollbackTransaction();
              return;
            }
            if(added){ made.set(key, added); rememberTransactionClip(added); }
            else remaining.push(pc);
          }
        }
        if(restoreOwns()){
          projectRestore?.replaceClips?.(remaining);
          Seq.sort(); Seq.recomputeDuration(); emit('media:timeline');
        }else rollbackTransaction();
      })();
    }else if(projectRestore&&Array.isArray(pend)){
      // Browser 不能憑路徑重開其他 File；保留未選回的 segment metadata，避免
      // 使用者只先選主檔就把其餘序列永久從下一次存檔中抹掉。
      projectRestore.replaceClips(pend.filter(item=>item!==pri));
    }
    this._pendingProjectRestorePromise=pendingRestore;
    void pendingRestore.catch(error=>{
      rollbackTransaction();
      console.warn('restore pending project clips:',error);
    }).finally(()=>{
      if(this._pendingProjectRestorePromise===pendingRestore) this._pendingProjectRestorePromise=null;
      if(!restoreOwns()) return;
      const restoredIds=new Set(restoredProjectClips.filter(clip=>State.clips.includes(clip)).map(clip=>clip.id));
      emit('media:projectReady',{clips:Seq.snapshot().filter(clip=>restoredIds.has(clip.id))});
    });
    return c;
  },
  async waitForPendingProjectRestore(){
    const pending=this._pendingProjectRestorePromise;
    if(pending) await pending;
  },
  _enterNoVideoTimeline(playhead,wasPlaying=this.playing){
    const target=Math.min(Math.max(0,Number(playhead)||0),Math.max(0,State.duration||0));
    this.activeClipId=null;
    this._transport.enterGap(target,{running:wasPlaying});
    this.stopBufferSources(); this.stopElementSources();
    if(this.mpvMode){ getPlayerAdapter()?.pause?.().catch(()=>{}); emit('mpv:sync'); }
    else { try{ video.pause(); }catch(error){} video.style.visibility='hidden'; }
    for(const track of this.tracks){
      const source=track.source||'video';
      if(source==='video'||source.startsWith('clip:')) track._srcHidden=true;
    }
    this.applyGains();
    this._transport.seekVirtual(target,{running:this.audioOnlyTimeline()&&wasPlaying});
    if(this.audioOnlyTimeline()){
      this.seek(target);
      if(wasPlaying) this.startElementSources(target,target);
    }else{
      this._vStart=null;
      this.playing=false;
      if(wasPlaying){
        $('playBtn').textContent='▶';
        video.dispatchEvent(new Event('pause'));
      }
    }
    return target;
  },
  restoreSequenceEditState(timelineTime){
    this._sequenceEditVersion+=1;
    const wanted=new Map();
    for(const clip of State.clips){
      if(!clip||clip.type==='image') continue;
      const sourceId=clip.audioSrc||(clip.primary?'video':('clip:'+clip.id));
      if(sourceId.startsWith('clip:')&&!wanted.has(sourceId)) wanted.set(sourceId,clip);
    }
    this.tracks=this.tracks.filter(track=>{
      const sourceId=track.source||'video';
      if(!sourceId.startsWith('clip:')||wanted.has(sourceId)) return true;
      try{ if(track.el){ track.el.pause(); track.el.src=''; } }catch(error){}
      try{ track.gain?.disconnect?.(); }catch(error){}
      // The removed track no longer carries enough locator data to rebuild a
      // full fingerprint.  Clearing is safe: still-live sources with tracks
      // are skipped below, while trackless sources are revalidated.
      this._clipRuntimeReadySources?.clear();
      return false;
    });
    if(this.activeClipId&&!Seq.byId(this.activeClipId)) this.activeClipId=null;

    const pending=[];
    for(const [sourceId,clip] of wanted){
      const hasTrack=this.tracks.some(track=>(track.source||'video')===sourceId);
      if(!hasTrack&&!this._clipRuntimeReadySources?.has(clipSourceFingerprint(clip))) pending.push(this.ensureClipRuntime(clip));
    }
    emit('media:audioTracks');
    if(this.seqOn()) this.seek(Math.max(0,Number(timelineTime)||0));
    else this._enterNoVideoTimeline(timelineTime,this.playing);
    const restorePromise=Promise.allSettled(pending);
    this._historySequenceRestorePromise=restorePromise;
    void restorePromise.finally(()=>{
      if(this._historySequenceRestorePromise===restorePromise) this._historySequenceRestorePromise=null;
    });
    return restorePromise;
  },
  async waitForHistorySequenceRestore(){
    const pending=this._historySequenceRestorePromise;
    if(pending) await pending;
  },
  /* 已有影片時的新影片路由：詢問「加入序列」或「取代」 */
  openIncoming({ path = null, file = null }){
    if(!this.seqOn()){ path ? this.loadDesktopMedia(path) : this.loadVideoFile(file); return; }
    const nm = baseName(path || (file && file.name) || '影片');
    openModal('已載入影片',
      `<p>要把 <b>${escapeHTML(nm)}</b> 加入時間軸序列（接在最後一段之後），還是取代目前影片？</p>`,
      [{ label: '➕ 加入序列', primary: true, act: () => { closeModal(); path ? this.addClipDesktop(path) : this.addClipWeb(file); } },
       { label: '取代目前影片', act: () => { closeModal(); path ? this.loadDesktopMedia(path) : this.loadVideoFile(file); } },
       { label: '取消', act: closeModal }]);
  },
  async loadDesktopMedia(p, projectRestore=null) { return loadDesktopMedia(this, p, projectRestore); },
  async loadVideoFile(file, projectRestore=null) { return loadVideoFile(this, file, projectRestore); },
  async _loadViaMpv(p, info, projectRestore=null, intakeToken=null) { return _loadViaMpv(this, p, info, projectRestore, intakeToken); },
  _expandChannels(audio) { return _expandChannels(this, audio); },

  /* 加入影片到序列（桌面）：probe 取長度/FPS → 建 clip → 背景 ingest 音軌+波形（沿用每檔快取） */
  async addClipDesktop(p, geo = null, operation=null){
    const assetOperation=this._assetOperation(operation,{kind:'desktop-clip',path:p});
    const owns=()=>this._ownsAssetOperation(assetOperation);
    if(!owns()) return null;
    setStatus('讀取影片資訊…', 'busy');
    let info = null; try{ info = await DESK.probe(p); }catch(e){ if(owns()){ showToast('ffprobe 失敗：' + e.message); setStatus('', ''); } return null; }
    if(!owns()) return null;
    const dur = info?.duration || 0;
    if(!dur){ showToast('無法取得影片長度，未加入'); setStatus('', ''); return; }
    if(!this.mpvMode){
      // 無 mpv：只有原生可播格式能跨段切換（單一 <video> 換 src）
      const nativeCodecs = ['h264','hevc','vp8','vp9','av1','mpeg4'];
      const ext = (baseName(p).split('.').pop() || '').toLowerCase();
      const ok = info?.video && nativeCodecs.includes(info.video.codec) && ['mp4','mov','m4v','webm','mkv'].includes(ext);
      if(!ok){ showToast('未偵測到 mpv：序列僅支援加入原生格式（MP4/MOV/WebM/MKV）'); setStatus('', ''); return; }
    }
    const fps = info?.video?.fps || 0;
    if(fps && Math.abs(snapFps(fps) - State.fps) > 0.002)
      showToast(`注意：${baseName(p)} 為 ${fps}fps，與序列 ${State.fps}${State.dropFrame?'df':''}fps 不同——時碼以序列 FPS 為準`);
    // natW/natH 與圖片共用同一組欄位名，讓 imagegeom 的公式對兩者一體適用。
    // 舊專案沒有這兩個值時，匯出仍可由 ffmpeg 自行 contain（結果相同），
    // 只是對話框的「符合視窗」少了精確依據。
    const meta = { name: baseName(p), path: p, dur, fps,
      natW: +info?.video?.width || 0, natH: +info?.video?.height || 0 };
    // 一律附 web url（v4.22）：mpv 模式下 WebCodecs 預覽引擎也能直接解「加入的原生檔」做即時合成
    //（非原生加入檔 demux 會失敗 → WCPreview 視同不可解、讓回 mpv 顯示，無害）
    try{
      const fileUrl=await DESK.fileURL(p);
      if(!owns()) return null;
      meta.web={url:fileUrl};
    }catch(e){}
    if(!owns()) return null;
    let overrides = {};
    if (!geo && State.clips.length > 0) {
      overrides.vtrack = State.videoTracks.length;
      ensureVideoTrackCount(overrides.vtrack + 1);
      overrides.offset = this.displayTime();
    }
    const c = Seq.add({ ...meta, ...overrides, audioSourceId: geo?.audioSourceId || makeAudioSourceId(), audioDetached:!!geo?.audioDetached });
    c.audioSrc = 'clip:' + c.id; // 此來源的音軌識別（切割片段將共用）
    AudioPipeline.registerSource(c,probeAudioChannelDescriptors(info?.audio));
    if(geo){ c.in = geo.in ?? 0; c.out = Math.min(geo.out ?? dur, dur); c.offset = geo.offset ?? c.offset; if(geo.vtrack){ c.vtrack = geo.vtrack; ensureVideoTrackCount(geo.vtrack+1); } c.fadeIn = geo.fadeIn || 0; c.fadeOut = geo.fadeOut || 0; c.audioDetached=!!geo.audioDetached; Seq.sort(); Seq.recomputeDuration(); }
    else { Seq.sort(); Seq.recomputeDuration(); }
    emit('media:timeline');
    emit('history:record', '加入影片：' + c.name);
    setStatus(`已加入序列：${c.name}（背景抽取音訊與波形…）`, 'busy');
    void this.ensureClipRuntime(c,info,assetOperation);
    return c;
  },
  ensureClipRuntime(c,knownInfo=null,operation=null){
    if(!c||c.type==='image'||!c.path||!DESK) return Promise.resolve();
    const assetOperation=this._assetOperation(operation,{kind:'clip-runtime',id:c.id});
    const owns=()=>this._ownsAssetOperation(assetOperation)&&this._sourceStillReferenced(c);
    if(!owns()) return Promise.resolve();
    const sourceId=c.audioSrc||(c.primary?'video':('clip:'+c.id));
    if(sourceId==='video'||this.tracks.some(track=>(track.source||'video')===sourceId)) return Promise.resolve();
    if(!this._clipRuntimePromises) this._clipRuntimePromises=new Map();
    const fingerprint=clipSourceFingerprint(c);
    const existing=this._clipRuntimePromises.get(sourceId);
    // History snapshots recreate plain clip objects.  Reusing work by sourceId
    // alone creates an ABA bug: Undo can remove the old object and Redo can
    // insert a new clone with the same id while the old probe is still pending.
    if(existing?.fingerprint===fingerprint) return existing.promise;
    const entry={fingerprint,promise:null};
    const pending=(async()=>{
      const info=knownInfo||await DESK.probe(c.path);
      if(!owns()) return;
      let liveClip=this._liveClipForSource(c);
      if(!liveClip) return;
      if(!liveClip.web?.url){
        try{
          const fileUrl=await DESK.fileURL(liveClip.path);
          if(!owns()) return;
          liveClip=this._liveClipForSource(c);
          if(!liveClip) return;
          liveClip.web={url:fileUrl};
        }catch(error){}
      }
      if(!owns()) return;
      liveClip=this._liveClipForSource(c);
      if(!liveClip) return;
      AudioPipeline.registerSource(liveClip,probeAudioChannelDescriptors(info?.audio));
      await this._clipIngest(liveClip,info,assetOperation);
      if(!owns()) return;
      if(!this._clipRuntimeReadySources) this._clipRuntimeReadySources=new Set();
      this._clipRuntimeReadySources.add(fingerprint);
    })().catch(error=>console.warn('restore clip runtime:',error)).finally(()=>{
      if(this._clipRuntimePromises?.get(sourceId)===entry) this._clipRuntimePromises.delete(sourceId);
    });
    entry.promise=pending;
    this._clipRuntimePromises.set(sourceId,entry);
    return pending;
  },
  /* 加入 clip 的背景音訊/波形（模式同 _bgAudioIngest；音軌以 source='clip:<id>' 標記） */
  async _clipIngest(c, info, operation=null){
    const assetOperation=this._assetOperation(operation,{kind:'clip-ingest',id:c?.id});
    const sourceId=c.audioSrc||('clip:'+c.id);
    const myVer = this._bgVersion;
    const owns=()=>this._ownsAssetOperation(assetOperation)&&this._bgVersion===myVer&&this._sourceStillReferenced(c);
    if(!owns()) return;
    this.ensureCtx();
    // queue:true —— 不可搶佔/殺掉進行中的 ingest（可能正是餵播放器的 streamIngest 背景轉檔
    // 或主媒體音軌抽取，殺掉會讓播放中斷）；改為排入佇列、依序執行
    // needsProxy:true（v4.25）：加入的片段一律備 720p 短 GOP proxy——原檔可能非原生（ProRes/MXF）
    // 或過大（>600MB WebCodecs 讀不進來）；沒有 proxy 時預覽引擎解不了它 →【無法參與疊層合成】
    // 且 mpv 模式會讓回 mpv 顯示（HTML 字幕層被隱藏 →「字幕完全不見」）。proxy 走同一份快取、只轉一次。
    let res; try{ res = await DESK.ingest({ path: c.path, duration: c.dur, needsProxy: true, audio: info?.audio || [], queue: true }); }
    catch(e){ if(owns()) setStatus('影片音訊抽取失敗：' + (e?.message||e), ''); return; }
    if(!res || !owns()) return;
    if(res.proxy){
      try{ const u = await DESK.fileURL(res.proxy);
        if(owns()){
          const sourceClip=this._liveClipForSource(c);
          if(sourceClip) sourceClip.proxyUrl=u;
          this.seek(this.displayTime());
        }
      }catch(e){ console.warn('clip proxy url:', e); }
    }
    if(!owns()) return;
    const chs = res.channels || [];
    let sourceClip=this._liveClipForSource(c);
    if(!sourceClip) return;
    const descriptors=AudioPipeline.registerSource(sourceClip,chs,chs.length);
    if(chs.length){
      const els=await this._intakeSession.materializeAudioElements(chs,{
        owns,
        resolveFileURL:file=>DESK.fileURL(file),
        createAudio:()=>new Audio(),
      });
      if(!els) return;
      for(let i = 0; i < chs.length; i++){
        const el = els[i]; if(!el) continue;
        const node = AudioEngine.createMediaElementSource(el);
        const g = AudioEngine.createGain(); node.connect(g); AudioEngine.connectToMaster(g);
        sourceClip=this._liveClipForSource(c);
        if(!sourceClip) return;
        const tr = this.bindTrackRouting({ id: 'cl-' + sourceClip.id + '-' + i, name: sourceClip.name + '·' + (chs[i].label || ('軌 ' + (i + 1))),
          kind: 'element', source: sourceId, el, gain: g, muted: false, solo: false, volume: 1, file: chs[i].file },sourceClip,descriptors[i],i);
        this.attachMeter(tr, node); this.tracks.push(tr);
      }
      // 依目前 active clip 重新套用可聽集合（新加入的預設隱藏，除非它正是 active）
      const ac = this._activeClip(); if(ac) this._applyClipAudio(ac);
      // 若正在播這個新段：元素音軌接管 → mpv 靜音並啟動元素
      if(this.mpvMode && ac && (ac.audioSrc || ('clip:'+ac.id)) === sourceId){
        getPlayerAdapter().mute(true).catch(()=>{});
        if(this.playing) this._restartElements();
      }
    }
    if(res.wave){
      try{
        const buf = await fetch(await DESK.fileURL(res.wave)).then(r => r.arrayBuffer());
        if(owns()){
          sourceClip=this._liveClipForSource(c);
          if(!sourceClip) return;
          sourceClip.peaks = Wave.calcFromWav(buf);
          if(sourceClip.peaks) Wave.setSourceMixPeaks(sourceClip,sourceClip.peaks,{mixPath:res.wave,channels:chs});
          emit('media:timeline');
        }
      }catch(e){ console.warn('clip wave', e); }
    }
    if(owns()) { emit('media:audioTracks'); setStatus(`影片已加入序列：${this._liveClipForSource(c)?.name||c.name}`, 'ok'); }
  },
  /* v4.7：圖片原始像素尺寸。互動框（.img-wrap）要貼合「contain 之後的圖片」而非整個畫框，
     沒有 natW/natH 就只能退回舊的滿框行為，把手會離素材很遠。舊專案讀不到時 app.js 會補量。 */
  async addImageDesktop(p, geo = null, operation=null){
    const assetOperation=this._assetOperation(operation,{kind:'desktop-image',path:p});
    const owns=()=>this._ownsAssetOperation(assetOperation);
    if(!owns()) return null;
    const name = baseName(p);
    let url = null;
    try { if(DESK?.fileURL) url = await DESK.fileURL(p); } catch(e){}
    if(!owns()) return null;
    if(!url || (!url.startsWith('http') && !url.startsWith('file:') && !url.startsWith('blob:'))){
      // fileURL 被權威拒絕時不可自行組 file:/// 繞過它；這裡只會在未經可信入口的
      // 專案圖片路徑或 preload 失敗時觸發，交給既有的 pending-relink 流程保留素材資訊。
      console.warn('image file URL unavailable:', p);
      return null;
    }
    const imgOffset = geo?.offset ?? this.displayTime();
    const imgOut = geo ? Math.min(geo.out ?? 10, 36000) : 10;
    const imgIn = geo?.in ?? 0;
    const geoNumber=(value,fallback)=>Number.isFinite(Number(value))?Number(value):fallback;
    const geoRatio=(value,fallback)=>Math.max(0,Math.min(1,geoNumber(value,fallback)));
    const nat = await probeImageSize(url, geo);
    if(!owns()) return null;
    const c = Seq.add({ type: 'image', name, path: p, web: { url }, dur: 36000, fps: State.fps || 25,
      scale:Math.max(0.01,geoNumber(geo?.scale,1)), posX:geoRatio(geo?.posX,0.5), posY:geoRatio(geo?.posY,0.5),
      natW:nat.w, natH:nat.h,
      offset: imgOffset, out: imgOut, in: imgIn });
    if(geo){
      if(geo.vtrack != null){ c.vtrack = geo.vtrack; ensureVideoTrackCount(c.vtrack + 1); }
      c.fadeIn = geo.fadeIn || 0; c.fadeOut = geo.fadeOut || 0;
    }
    if (!geo || geo.vtrack == null) {
      if (!geo && State.clips.length > 1) { // Wait, c is already added to State.clips by Seq.add!
        c.vtrack = State.videoTracks.length;
      } else if (State.clips.length === 1) { // Only this newly added clip exists
        c.vtrack = 0;
      } else {
        c.vtrack = pickImageTrack(c); // fallback
      }
      ensureVideoTrackCount(c.vtrack + 1);
    }
    Seq.sort(); Seq.recomputeDuration();
    emit('media:timeline');
    // 圖片疊層由 app.js 的 render:videoSub 事件建立；僅重繪時間軸不會
    // 立即產生可拖曳的 .img-wrap，導致剛匯入時看得到素材卻不能直接調整。
    emit('render:videoSub');
    if(!geo?._restore) emit('history:record', '加入圖片：' + c.name);
    setStatus(`已加入圖片：${c.name}`, 'ok');
    return c;
  },
  /* 無主影片的桌面專案仍可能只含圖片。Project.apply 會先把所有 clip
     放入明確的 restore plan；此處直接重建其中圖片，保留讀不到的項目
     以便下次重新連結，不讓一次開檔就遺失。 */
  async restorePendingImageClips(projectRestore=null){
    const restoreSequenceVersion=this._sequenceEditVersion;
    const restoreBaseOwns=()=>
      (!projectRestore?.owns||projectRestore.owns())&&
      this._sequenceEditVersion===restoreSequenceVersion;
    const restoreOperation=this._assetOperation(null,'pending-image-restore',restoreBaseOwns);
    const owns=()=>this._ownsAssetOperation(restoreOperation);
    // Keep restore material in the plan until this transaction commits. A
    // destructive take here loses every remaining clip if History or a newer
    // project supersedes one slow probe halfway through restoration.
    const pending=[...(projectRestore?.pendingClips?.()||[])];
    if(!pending.length) return {restored:0,pending:0};
    const remaining=[];
    const transactionClips=[];
    const rollback=()=>{
      for(const clip of transactionClips.splice(0).reverse()){
        if(clip?.id&&Seq.byId(clip.id)===clip) this.removeClip(clip.id);
      }
    };
    let restored=0;
    for(const raw of pending){
      if(raw?.type!=='image' || !raw.path){ remaining.push(raw); continue; }
      let exists=true;
      if(typeof DESK?.stat==='function'){
        try{ exists=!!(await DESK.stat(raw.path))?.exists; }catch(e){ exists=false; }
      }
      if(!owns()){ rollback(); return {restored:0,pending:pending.length,cancelled:true}; }
      if(!exists){ remaining.push(raw); continue; }
      const image=await this.addImageDesktop(raw.path,{...raw,_restore:true},restoreOperation).catch(()=>null);
      if(!owns()){
        if(image?.id&&Seq.byId(image.id)===image) transactionClips.push(image);
        rollback();
        return {restored:0,pending:pending.length,cancelled:true};
      }
      if(image){ transactionClips.push(image); restored++; }
      else remaining.push(raw);
    }
    projectRestore?.replaceClips?.(remaining);
    Seq.sort(); Seq.recomputeDuration();
    if(restored) { emit('media:timeline'); emit('render:videoSub'); }
    return {restored,pending:remaining.length};
  },
  async addImageWeb(f, operation=null){
    const assetOperation=this._assetOperation(operation,{kind:'web-image',name:f?.name});
    const owns=()=>this._ownsAssetOperation(assetOperation);
    if(!owns()) return null;
    const url = URL.createObjectURL(f); this.objectURLs.push(url);
    const imgOffset = this.displayTime();
    const nat = await probeImageSize(url);
    if(!owns()){ this._releaseObjectURL(url); return null; }
    const c = Seq.add({ type: 'image', name: f.name, web: { url }, dur: 36000, fps: State.fps || 25, scale: 1, posX: 0.5, posY: 0.5, natW:nat.w, natH:nat.h, offset: imgOffset, out: 10 });
    if (State.clips.length > 1) { // c is already added by Seq.add!
      c.vtrack = State.videoTracks.length;
    } else if (State.clips.length === 1) {
      c.vtrack = 0;
    } else {
      c.vtrack = pickImageTrack(c);
    }
    ensureVideoTrackCount(c.vtrack + 1);
    Seq.sort(); Seq.recomputeDuration();
    emit('media:timeline');
    emit('render:videoSub');
    emit('history:record', '加入圖片：' + c.name);
    setStatus(`已加入圖片：${c.name}`, 'ok');
    return c;
  },
  /* 加入影片到序列（網頁版）：objectURL + metadata 取長度；小檔另算波形 */
  async addClipWeb(f, operation=null){
    const assetOperation=this._assetOperation(operation,{kind:'web-clip',name:f?.name});
    const owns=()=>this._ownsAssetOperation(assetOperation);
    if(!owns()) return null;
    setStatus('讀取影片資訊…', 'busy');
    const url = URL.createObjectURL(f); this.objectURLs.push(url);
    const test=document.createElement('video');
    test.src=url;
    const metadata=await waitForOwnedMediaMetadata(test,{owns,timeoutMs:8000});
    const dur=metadata==='ready'?(test.duration||0):0;
    this._disposeMediaElement(test);
    if(metadata==='cancelled'||!owns()){ this._releaseObjectURL(url); return null; }
    if(!dur){ showToast('無法讀取此影片，未加入'); setStatus('', ''); this._releaseObjectURL(url); return null; }
    let overrides = {};
    if (State.clips.length > 0) {
      overrides.vtrack = State.videoTracks.length;
      ensureVideoTrackCount(overrides.vtrack + 1);
      overrides.offset = this.displayTime();
    }
    const c = Seq.add({ name: f.name, web: { url }, dur, audioSourceId: makeAudioSourceId(), ...overrides });
    c.audioSrc = 'clip:' + c.id;
    emit('media:timeline');
    emit('history:record', '加入影片：' + c.name);
    setStatus(`已加入序列：${c.name}`, 'ok');
    // 音訊（整檔混音一軌，經聲道分離）＋波形：僅小檔（記憶體考量）
    if(f.size <= WAVE_DECODE_MAX){
      try{
        this.ensureCtx();
        const buf = await readFile(f);
        if(!owns()||!this._sourceStillReferenced(c)) return null;
        const ab = await AudioEngine.decodeAudioData(buf.slice(0));
        if(!owns()||!this._sourceStillReferenced(c)) return null;
        const sourceClip=this._liveClipForSource(c);
        if(!sourceClip) return null;
        sourceClip.peaks = Wave.setSourceBuffer(sourceClip,ab);
        const el = new Audio(); el.src = url; el.preload = 'auto';
        const node = AudioEngine.createMediaElementSource(el);
        const chN = Math.max(1, node.channelCount || 2);
        AudioPipeline.registerSource(sourceClip,[],chN);
        const runtimeSource=sourceClip.audioSrc||('clip:'+sourceClip.id);
        const trs = this._splitToChannelTracks(node,runtimeSource,el,chN,sourceClip);
        trs.forEach(tr => { tr.name = sourceClip.name + '·' + tr.name; tr.source = runtimeSource; });
        this.tracks.push(...trs);
        const ac = this._activeClip(); if(ac) this._applyClipAudio(ac);
        emit('media:audioTracks'); emit('media:timeline');
      }catch(e){ console.warn('addClipWeb audio', e); }
    } else showToast('檔案較大：此段不產生波形（可另載入音訊檔）');
    return c;
  },
  /* 在播放點切割影片段（Ctrl+K）：一段變兩段，共用來源（音軌/波形/播放資源） */
  splitClipAt(t){
    if(!this.seqOn()){ showToast('尚未載入影片'); return false; }
    t = snapTimeToFrame(t, State.fps, State.dropFrame);
    const c = Seq.clipAt(t);
    if(!c){ showToast('播放點不在任何影片段上'); return false; }
    if(State.videoTracks[c.vtrack||0]?.locked){ showToast('此視訊軌已鎖定，無法切割'); return false; }
    const cut = Seq.toSource(t, c);
    const MIN = 0.2;
    if(cut < c.in + MIN || cut > c.out - MIN){ showToast('切點太靠近段落邊界'); return false; }
    this._sequenceEditVersion+=1;
    Seq.add({
      name: c.name, path: c.path || null, web: c.web || null, dur: c.dur, fps: c.fps || 0,
      peaks: c.peaks, // 共用來源波形（來源時間索引，兩段各取自己的窗）
      audioSrc: c.audioSrc || (c.primary ? 'video' : ('clip:' + c.id)),
      audioSourceId: c.audioSourceId || audioSourceIdForClip(c),
      audioDetached:!!c.audioDetached,
      in: cut, out: c.out, offset: t,
    });
    c.out = cut;
    Seq.sort(); Seq.recomputeDuration();
    emit('media:timeline');
    emit('history:record', '切割影片：' + c.name);
    setStatus(`已於 ${secToEncore(t, State.fps, State.dropFrame)} 切割「${c.name}」`, 'ok');
    return true;
  },
  /* 將影片原音轉成可獨立剪輯的外部音訊素材。
     同一個來源檔切出的影片段共用一組 runtime 音軌，故解除連結時會為該來源的每個
     現有影片段建立一份對應音訊 placement，再一併關閉影片原音。這樣切過影片後
     不會遺失其他段的聲音，而且每份音訊都能自行移動、切割或刪除。 */
  async detachClipAudio(id){
    const clip=Seq.byId(id);
    if(!clip){ showToast('找不到要解除連結的影片段'); return null; }
    const sourceId=audioSourceIdForClip(clip);
    const sourceFingerprint=clipSourceFingerprint(clip);
    const timelineLaneId='detached:'+sourceId;
    const linked=State.clips.filter(item=>clipSourceFingerprint(item)===sourceFingerprint);
    const pending=linked.filter(item=>!item.audioDetached);
    if(!pending.length){ showToast('此影片的原音已解除連結'); return null; }
    const sourceOwns=()=>{
      const current=State.clips.filter(item=>clipSourceFingerprint(item)===sourceFingerprint);
      return current.length===linked.length&&linked.every(item=>current.includes(item));
    };
    const assetOperation=this._assetOperation(null,{kind:'detach-clip-audio',id},sourceOwns);
    const owns=()=>this._ownsAssetOperation(assetOperation);

    setStatus('建立可獨立剪輯的音訊…','busy');
    const made=[];
    const webFiles=new Map();
    const fileFor=async item=>{
      const url=item.web?.url;
      if(!url) return null;
      if(webFiles.has(url)) return webFiles.get(url);
      const task=(async()=>{
        const response=await fetch(url);
        if(!owns()) return null;
        if(!response.ok) throw new Error('無法讀取影片原音');
        const blob=await response.blob();
        if(!owns()) return null;
        return new File([blob],item.name||'video-audio',{type:blob.type||'audio/*'});
      })();
      webFiles.set(url,task);
      return task;
    };
    try{
      for(let index=0;index<pending.length;index++){
        if(!owns()) throw new Error('asset operation cancelled');
        const item=pending[index];
        const restore={
          // _restore 只抑制「加入音訊」的中間 history；完成後改記錄一筆解除連結。
          _restore:true,
          name:pending.length>1?`${item.name||'影片'} · 原音 ${index+1}`:`${item.name||'影片'} · 原音`,
          timelineLaneId,
          // 解除的是影片本身的音訊，不可再把原容器交給 <audio> 嘗試解碼；交由
          // addAudioFileDesktop 的 ffmpeg cache 路徑建立獨立聲道元素。duration 要存
          // 下來，專案重開時即使 ffprobe 的 format duration 缺失仍可還原 trim。
          preferCache:true,
          duration:item.dur,
          offset:item.offset, in:item.in, out:item.out, gain:1, enabled:true
        };
        let asset=null;
        // 直接呼叫 cache 建立器，讓 catch 能保留 ffprobe／ffmpeg 的具體失敗原因；
        // addAudioFileDesktop 仍保留同一 fallback，供一般外部音檔與專案還原使用。
        if(item.path&&DESK) asset=await this._addDesktopCachedAudio(item.path,restore,null,assetOperation);
        else {
          const file=await fileFor(item);
          if(file) asset=await this.addAudioFile(file,restore,assetOperation);
        }
        // A helper may commit the runtime asset just before this operation
        // loses clip ownership.  Track it for rollback before the final gate.
        if(asset) made.push(asset);
        if(!owns()) throw new Error('asset operation cancelled');
        if(!asset) throw new Error('無法建立獨立音訊');
        this.copyAudioSourceRouting?.(sourceId,asset.audioSourceId);
      }
    }catch(error){
      for(const asset of made){ if(this.externalAudioSources.includes(asset)) this.removeExternalAudio(asset.id,{record:false}); }
      if(!owns()) return null;
      console.warn('detach clip audio:',error);
      setStatus('解除影音連結失敗','');
      const reason=String(error?.message||'').trim();
      showToast(reason?`無法建立獨立音訊：${reason}（影片原音維持不變）`:'無法建立獨立音訊，影片原音維持不變');
      return null;
    }

    if(!owns()) return null;
    for(const item of linked) item.audioDetached=true;
    const active=this._activeClip();
    if(active) this._applyClipAudio(active,this.tlTime());
    else {
      for(const track of this.tracks){
        const source=track.source||'video';
        if(source==='video'||source.startsWith('clip:')) track._srcHidden=true;
      }
      this.applyGains();
    }
    this.recomputeTimelineDuration();
    emit('media:timeline'); emit('media:audioTracks');
    emit('history:record','解除影音連結：'+(clip.name||''));
    setStatus('已解除影音連結，可分別剪輯影片與音訊','ok');
    return made.map(asset=>this.externalAudio.get(asset.id));
  },
  /* 自序列移除 clip；可刪除最後一段影片，保留已解除連結／外部音訊做純音訊時間軸。 */
  removeClip(id){
    const c = Seq.byId(id); if(!c) return false;
    this._sequenceEditVersion+=1;
    const wasPlaying=this.playing;
    const playhead=this.displayTime();
    const src = c.audioSrc || (c.primary ? 'video' : ('clip:' + c.id));
    const fingerprint=clipSourceFingerprint(c);
    const stillUsed = State.clips.some(o => o !== c && clipSourceFingerprint(o)===fingerprint);
    if(!stillUsed && src.startsWith('clip:')){
      this._clipRuntimeReadySources?.delete(fingerprint);
      this.tracks = this.tracks.filter(tr => {
        if(tr.source === src){
          try{ if(tr.el){ tr.el.pause(); tr.el.src = ''; } }catch(e){}
          try{ tr.gain && tr.gain.disconnect(); }catch(e){}
          return false;
        }
        return true;
      });
    }
    if(!stillUsed && src==='video'){
      // video 的 MediaElementSource 不能安全地重新建立；保留節點但讓它不再進入 mixer。
      for(const track of this.tracks){ if((track.source||'video')==='video') track._srcHidden=true; }
    }
    if(!stillUsed){
      const hadPendingSourceWork=this.pendingChannels.length>0||!!this._ingestDoneHandler;
      this.pendingChannels=[];
      if(this._ingestDoneHandler){
        window.removeEventListener('desk:ingest-done',this._ingestDoneHandler);
        this._ingestDoneHandler=null;
      }
      if(hadPendingSourceWork) setStatus('影片來源已移除','');
    }
    if(this.activeClipId === id) this.activeClipId = null;
    Seq.remove(id); Seq.compact(); // 移除後收斂空的頂部視訊軌
    this.recomputeTimelineDuration();
    if(!this.seqOn()){
      // 最後影片被刪除：保留黑畫面與外部音訊，不讓先前影片停留在最後一格。
      this._enterNoVideoTimeline(playhead,wasPlaying);
    }else this.seek(Math.min(playhead, State.duration || 0)); // 重新解析目前位置（可能已成間隙）
    emit('media:audioTracks');
    emit('media:timeline'); emit('render:videoSub');
    return true;
  },

  /* --- 播放控制 --- */
  play(){
    // 序列：起播位置可能在間隙或另一個 clip 上，先路由
    if(this.seqOn()){
      const t = this.displayTime();
      const hit = Seq.clipAt(t);
      if(!hit){
        // 間隙起播：黑畫面、播放頭以虛擬時鐘續走（seqTick 進入 clip 時自動切換）
        this.ensureCtx();
        this.playing=true; $('playBtn').textContent='⏸'; video.dispatchEvent(new Event('play'));
        this._lastSeekTime=null;
        this._enterGap(t);
        this.startElementSources(t, t); // ext-* 參考音照播（clip 綁定音軌因 _srcHidden 跳過）
        return;
      }
      if(hit.id !== this.activeClipId || this._gap){
        this.ensureCtx();
        this.playing=true; $('playBtn').textContent='⏸'; video.dispatchEvent(new Event('play'));
        this._lastSeekTime=null;
        this._ensureClip(hit, this._transport.sourceTime(t,hit), true);
        return;
      }
    }
    // 影片片段已全部移除時仍可把外部音訊當成一條完整時間軸播放；保留黑畫面，
    // 不讓先前載入的 video/mpv 在背景重新發聲或把播放頭鎖回影片長度。
    if(this.audioOnlyTimeline()){
      const t=Math.min(Math.max(0,this.displayTime()),Math.max(0,State.duration));
      this._transport.startVirtual(t,{playbackRate:video.playbackRate||1});
      this.ensureCtx();
      getPlayerAdapter().pause().catch(()=>{});
      if(!this.mpvMode) video.style.visibility='hidden';
      this.playing=true; $('playBtn').textContent='⏸'; this._lastSeekTime=null;
      this.startElementSources(t,t);
      video.dispatchEvent(new Event('play'));
      return;
    }
    this.ensureCtx();
    if(!this.mpvMode && !video.hasAttribute('src')){
      this._transport.resumeVirtual({playbackRate:video.playbackRate||1});
      if(this.tracks.some(t=>t.kind==='buffer')) this.startBufferSources(this._vTime);
      this.startElementSources(this._vTime);
    } else {
      getPlayerAdapter().play().catch(()=>{});
      const current = this.mpvMode ? this._mpvTime : video.currentTime;
      if(this.tracks.some(t=>t.kind==='buffer')) this.startBufferSources(current);
      this.startElementSources(current, this.tlTime());
    }
    this.playing=true; $('playBtn').textContent='⏸'; video.dispatchEvent(new Event('play'));
    this._lastSeekTime=null;
  },
  pause(){
    const virtual=this.audioOnlyTimeline()||(!this.mpvMode&&!video.hasAttribute('src'));
    const _c=this.seqOn()?this._activeClip():null;
    const paused=this._transport.pause({
      sourceTime:this.vTime(),clip:_c,virtual,playbackRate:video.playbackRate||1,
      useGap:this.seqOn(),fps:State.fps,dropFrame:State.dropFrame,
    }); // FPS-SYNC：暫停時由 transport 統一吸附到時間軸影格
    if(this.seqOn() && this._gap){
      // 間隙中暫停：凍結虛擬時鐘
      this.stopElementSources();
      this.playing=false; $('playBtn').textContent='▶'; video.dispatchEvent(new Event('pause')); return;
    }
    if(this.audioOnlyTimeline()){
      this.stopBufferSources(); this.stopElementSources();
      getPlayerAdapter().pause().catch(()=>{});
      this.playing=false; $('playBtn').textContent='▶'; video.dispatchEvent(new Event('pause')); return;
    }
    const _ps=this._transport.sourceTime(paused,_c); // 播放器（來源）時間
    getPlayerAdapter().pause().catch(()=>{});
    if(this.mpvMode) this._mpvTime = _ps;

    if(!this.mpvMode && !video.hasAttribute('src')){
      this.stopBufferSources(); this.stopElementSources();
      this.playing=false; $('playBtn').textContent='▶'; return;
    }
    
    getPlayerAdapter().seek(_ps).catch(()=>{});
    this.stopBufferSources(); this.stopElementSources(); this.playing=false; $('playBtn').textContent='▶';
  },
  toggle(){ this.playing?this.pause():this.play(); },
  seek(t){
    // 有影片時才設上限；無影片時允許任意位置（空專案先排字幕）。
    // FPS-SYNC：每次 seek 都由 transport 以唯一格網吸附，並記下暫停權威位置。
    t=this._transport.seek(t,{duration:State.duration,fps:State.fps,dropFrame:State.dropFrame});
    /* 序列：t 為時間軸時間 → 解析所在 clip（間隙→黑畫面；跨 clip→換檔；同 clip→來源時間） */
    if(this.seqOn()){
      $('tcCur').textContent=secToEncore(t,State.fps,State.dropFrame);
      $('seekBar').value=Math.round(t*1000);
      // 外部音檔依其 placement 換算來源時間；尚無 metadata 的舊 ext-* 仍等同從 timeline 0 秒開始。
      for(const tr of this.tracks){
        const source=tr.source||'';
        if(tr.kind!=='element'||!tr.el||!source.startsWith('ext-')) continue;
        const off=this.externalAudio.sourceTime(source,t);
        try{ if(off==null) tr.el.pause(); else tr.el.currentTime=clamp(off,0,tr.el.duration||off); }catch(e){}
      }
      const hit = Seq.clipAt(t);
      if(!hit){
        this._enterGap(t);
        if(this.playing){ this._transport.enterGap(t,{running:true}); this.startElementSources(t, t); } // ext-* 參考音續播（clip 音軌因 _srcHidden 跳過）
        window.dispatchEvent(new CustomEvent('mpv:seeked',{detail:t})); // 讓播放頭/字幕/備註重繪
        return;
      }
      const local = this._transport.sourceTime(t,hit);
      if(hit.id !== this.activeClipId || this._gap){
        this._ensureClip(hit, local, this.playing);
        window.dispatchEvent(new CustomEvent('mpv:seeked',{detail:t}));
        return;
      }
      if(this.mpvMode || video.hasAttribute('src')){
        if(this.mpvMode) this._mpvTime=local;
        getPlayerAdapter().seek(local).catch(()=>{});
        this._syncSeqElements(t);
        if(!this.mpvMode && this.playing && this.tracks.some(tr=>tr.kind==='buffer')){ this.stopBufferSources(); this.startBufferSources(local); }
        if(this.mpvMode) window.dispatchEvent(new CustomEvent('mpv:seeked',{detail:t}));
        return;
      }
    }
    if(this.audioOnlyTimeline()){
      this._transport.seekVirtual(t,{running:this._transport.virtualStartedAt!==null});
      if(this.mpvMode) getPlayerAdapter()?.pause?.().catch(()=>{});
      else { try{ video.pause(); }catch(e){} video.style.visibility='hidden'; }
      $('tcCur').textContent=secToEncore(t,State.fps,State.dropFrame);
      $('seekBar').value=Math.round(t*1000);
      for(const tr of this.tracks){
        if(tr.kind!=='element'||!tr.el) continue;
        const source=tr.source||'';
        if(!source.startsWith('ext-')){ try{tr.el.pause();}catch(e){} continue; }
        const off=this.externalAudio.sourceTime(source,t);
        try{ if(off==null) tr.el.pause(); else tr.el.currentTime=clamp(off,0,tr.el.duration||off); }catch(e){}
      }
      window.dispatchEvent(new CustomEvent('mpv:seeked',{detail:t}));
      return;
    }
    if(this.mpvMode || video.hasAttribute('src')){
      if (this.mpvMode) {
        t = clamp(t, 0, this._mpvDuration || 0);
        this._mpvTime = t;
      }
      getPlayerAdapter().seek(t).catch(()=>{});
      for(const tr of this.tracks){ if(tr.kind==='element'&&tr.el){
        const source=tr.source||'';
        const off=source.startsWith('ext-')?this.externalAudio.sourceTime(source,t):t;
        try{ if(off==null) tr.el.pause(); else tr.el.currentTime=clamp(off,0,tr.el.duration||off); }catch(e){}
      } }
      
      if(this.mpvMode) {
        $('tcCur').textContent=secToEncore(t,State.fps,State.dropFrame);
        $('seekBar').value=Math.round(t*1000);
        window.dispatchEvent(new CustomEvent('mpv:seeked',{detail:t}));
      } else {
        if(this.playing && this.tracks.some(tr=>tr.kind==='buffer')){ this.stopBufferSources(); this.startBufferSources(t); }
      }
      return;
    }
    
    this._transport.seekVirtual(t,{running:this._transport.virtualStartedAt!==null});
    $('tcCur').textContent=secToEncore(t,State.fps,State.dropFrame);
    $('seekBar').value=Math.round(t*1000);
    for(const tr of this.tracks){ if(tr.kind==='element'&&tr.el){
      const source=tr.source||'';
      const off=source.startsWith('ext-')?this.externalAudio.sourceTime(source,t):t;
      try{ if(off==null) tr.el.pause(); else tr.el.currentTime=clamp(off,0,tr.el.duration||off); }catch(e){}
    } }
    if(this.playing&&this.tracks.some(tr=>tr.kind==='buffer')){ this.stopBufferSources(); this.startBufferSources(t); }
  },
  /* 外部音訊不隸屬影片 clip；在它自己的開始／結束邊界才一次性 seek/play 或 pause。
     這可處理「影片已結束但音檔稍後才開始」與修剪後的音檔尾端，且不會每幀造成播放抖動。 */
  _syncExternalElementActivity(t){
    const active=[];
    for(const tr of this.tracks){
      if(tr.kind!=='element'||!tr.el) continue;
      const source=tr.source||'';
      if(!source.startsWith('ext-')) continue;
      active.push(`${source}:${!tr._srcHidden&&this.externalAudio.sourceTime(source,t)!=null?'1':'0'}`);
    }
    const key=active.join('|');
    if(key===this._externalActivityKey) return;
    this._externalActivityKey=key;
    for(const tr of this.tracks){
      if(tr.kind!=='element'||!tr.el) continue;
      const source=tr.source||'';
      if(!source.startsWith('ext-')) continue;
      const off=!tr._srcHidden?this.externalAudio.sourceTime(source,t):null;
      try{
        if(off==null){ tr.el.pause(); continue; }
        tr.el.currentTime=clamp(off,0,tr.el.duration||off);
        tr.el.playbackRate=video.playbackRate||1;
        if('preservesPitch' in tr.el) tr.el.preservesPitch = (tr.el.playbackRate >= 0.25 && tr.el.playbackRate <= 4);
        const result=tr.el.play(); if(result?.catch) result.catch(()=>{});
      }catch(e){}
    }
  },
  // localT=當前 clip 的來源時間；tlT=時間軸時間（ext-* 參考音用；未給則同 localT）。
  // 序列模式：被 _srcHidden 的（其他 clip / 已切換音源）不播，避免多段音訊同時出聲。
  startElementSources(localT, tlT){
    AudioEngine.startElements(localT, tlT);
  },
  // 音源切換／clip 切換後，若正在播放需重啟可聽元素（先前隱藏者已被跳過、未在播）
  _restartElements(){
    if(!this.playing) return;
    const c = this.seqOn() ? this._activeClip() : null;
    const tl = this.tlTime();
    this.startElementSources(c ? Seq.toSource(tl, c) : this.vTime(), tl);
  },
  stopElementSources(){
    AudioEngine.stopElements();
  },
  startBufferSources(offset){
    const res = AudioEngine.startBuffers(offset);
    if (res) {
      this.startCtxTime = res.startCtxTime;
      this.startMediaTime = res.startMediaTime;
    }
  },
  stopBufferSources(){
    AudioEngine.stopBuffers();
  },
  scrubAudio(t, duration = 0.15) {
    const res = AudioEngine.scrub(t, duration); // t＝時間軸時間（§0.5）
    if (res && res.scrubMainVideo) {
      if(!video.src) return;
      if(!video._scrubEl) {
          video._scrubEl = document.createElement('video');
          video._scrubEl.preload = 'auto';
      }

      const doPlay = () => {
          video._scrubEl.playbackRate = video.playbackRate || 1;
          if('preservesPitch' in video._scrubEl) video._scrubEl.preservesPitch = (video._scrubEl.playbackRate >= 0.25 && video._scrubEl.playbackRate <= 4);
          video._scrubEl.currentTime = clamp(res.localT, 0, video.duration || res.localT);
          video._scrubEl.volume = State.muted ? 0 : 1;
          const p = video._scrubEl.play();
          if(p !== undefined) {
            p.then(() => {
              clearTimeout(video._scrubTimer);
              video._scrubTimer = setTimeout(() => { video._scrubEl.pause(); }, 150);
            }).catch(()=>{});
          }
      };

      if(video._scrubEl.src !== video.src) {
          video._scrubEl.src = video.src;
          video._scrubEl.onloadedmetadata = () => {
              video._scrubEl.onloadedmetadata = null;
              doPlay();
          };
      } else if (video._scrubEl.readyState >= 1) {
          doPlay();
      } else {
          video._scrubEl.onloadedmetadata = () => {
              video._scrubEl.onloadedmetadata = null;
              doPlay();
          };
      }
    }
  },
  syncMuteState(){
    const mix=this.hasMix();
    const active=this._activeClip();
    video.muted = mix ? true : (State.muted || !!active?.audioDetached);
    this.applyGains();
  },
  /* 專案 bus 的 M/S/音量套在每個來源聲道路由之後。
     預覽為立體聲監聽，複製到多個 bus 時取可聽 route 的最大有效增益，避免把同一個
     聲道在瀏覽器預覽中不必要地疊加數次；匯出端則會依 bus 逐一完整混音。 */
  projectAudioInterpretation(){
    return createProjectAudioInterpretation({
      audioProject:State.audioProject,
      mediaTracks:this.tracks,
      externalSources:this.externalAudioSources,
    });
  },
  projectRouteState(track){
    return this.projectAudioInterpretation().projectRouteState(track);
  },
  projectBusById(id){ return (State.audioProject?.buses||[]).find(bus=>String(bus.id)===String(id))||null; },
  toggleProjectBusMute(id){ const bus=this.projectBusById(id); if(!bus)return; bus.muted=!bus.muted; this.applyGains(); emit('media:audioTracks'); emit('media:timeline'); },
  toggleProjectBusSolo(id){ const bus=this.projectBusById(id); if(!bus)return; bus.solo=!bus.solo; this.applyGains(); emit('media:audioTracks'); emit('media:timeline'); },
  setProjectBusVolume(id,value){ const bus=this.projectBusById(id); if(!bus)return; bus.volume=Math.max(0,Number(value)||0); this.applyGains(); },
  /* 「這條聲道現在聽得到嗎」的唯一判定。applyGains 與混音器電平表都必須走它。

     以前混音器自己在 mixer.js 重寫了一份（_busRouteTracks），漏掉 projectRouteState
     裡的外部素材 placement gain——外部音檔被停用（enabled===false）時實際增益是 0，
     但電平表照樣把它算進來，於是【表在跳、卻沒有聲音】。
     兩份判定回答同一個問題卻各寫一次，遲早分歧；已收斂到這裡。 */
  trackAudible(track){
    return this.projectAudioInterpretation().trackState(track).audible;
  },

  /* 相容入口：只取某條 project bus 的可聽聲道。電平表本身必須改用下方 states，
     因為裸 track 不帶 route／placement／bus 的最終 gain。 */
  routedTracksForBus(busId){
    return this.projectAudioInterpretation().routedTracksForBus(busId);
  },
  routedTrackStatesForBus(busId){
    return this.projectAudioInterpretation().routedTrackStatesForBus(busId);
  },

  applyGains(){
    const interpretation=this.projectAudioInterpretation();
    const activeMix=this.tracks.some(t=>(t.kind==='buffer'||t.kind==='element')
      &&interpretation.trackState(t).audible);
    for(const tr of this.tracks){
      const state=interpretation.trackState(tr);
      if(tr.gain) tr.gain.gain.value=state.audible?state.gain:0;
      // 只有當有「真正可聽見」的 mix 音軌時才壓制 native
      if(tr.kind==='native'&&activeMix&&!(interpretation.anyVisibleSourceSolo&&tr.solo)) tr.gain.gain.value=0;
    }
    AudioEngine.setMasterGain(State.muted?0:1);
  },
  getSources(){
    const seen=new Set(); const srcs=[];
    for(const tr of this.tracks.filter(t=>t.kind==='buffer'||t.kind==='native'||t.kind==='element'||t.kind==='nativeTrack')){
      const s=tr.source||'video';
      if(!seen.has(s)){
        seen.add(s);
        const external=this.externalAudioSources.find(asset=>asset.audioSrc===s||asset.source===s);
        srcs.push({id:s,label:s==='video'?'原音':(external?.name||s.replace(/^ext-/,''))});
      }
    }
    return srcs;
  },
  /* ===== 音訊軌列（階段2）：把序列片段依 audioSrc 分組，每組＝一條音訊軌（一個音源） =====
     'video'＝主影片原音（含其切割片段，共用同一音源）；'clip:x'＝各自加入的影片音訊。
     依時間軸首次出現排序，供時間軸畫「每音源一條波形列」。 */
  audioSources(){
    const map=new Map();
    for(const c of State.clips){
      const s=c.audioSrc || (c.primary?'video':('clip:'+c.id));
      let g=map.get(s); if(!g){ g={srcId:s, clips:[], firstOff:c.offset}; map.set(s,g); }
      g.clips.push(c); if(c.offset<g.firstOff)g.firstOff=c.offset;
    }
    const arr=[...map.values()].sort((a,b)=>a.firstOff-b.firstOff);
    for(const g of arr) g.label = g.srcId==='video' ? '原音（主影片）' : (g.clips[0]?.name || g.srcId.replace(/^clip:/,'片段 '));
    return arr;
  },
  /* 某音源的混音器聲道（Media.tracks 內 source 相符者）；音源層級的 靜音/獨奏/音量＝對其所有聲道聚合套用 */
  sourceChannels(srcId){ return this.tracks.filter(t=>(t.source||'video')===srcId && (t.kind==='buffer'||t.kind==='native'||t.kind==='element'||t.kind==='nativeTrack')); },
  sourceMuted(srcId){ const ch=this.sourceChannels(srcId); return ch.length>0 && ch.every(t=>t.muted); },
  toggleSourceMute(srcId){ 
    const ch=this.sourceChannels(srcId); 
    const m=!(ch.length>0&&ch.every(t=>t.muted)); 
    for(const t of ch)t.muted=m; 
    
    // Persist clip mute state to State so it saves
    let clip = null;
    if (srcId === 'video' || srcId === 'altpri') {
       clip = State.clips?.find(c=>c.primary);
    } else if (srcId.startsWith('clip:')) {
       clip = State.clips?.find(c=>c.id===srcId.substring(5));
    }
    if (clip) clip.muted = m;

    this.applyGains(); 
    emit('media:audioTracks'); 
  },
  sourceSolo(srcId){ const ch=this.sourceChannels(srcId); return ch.length>0 && ch.some(t=>t.solo); },
  toggleSourceSolo(srcId){ const ch=this.sourceChannels(srcId); const s=!(ch.length>0&&ch.some(t=>t.solo)); for(const t of ch)t.solo=s; this.applyGains(); emit('media:audioTracks'); },
  sourceVolume(srcId){ const ch=this.sourceChannels(srcId); return ch.length? ch.reduce((m,t)=>Math.max(m,t.volume==null?1:t.volume),0) : 1; },
  setSourceVolume(srcId,v){ for(const t of this.sourceChannels(srcId))t.volume=v; this.applyGains(); },
  switchSource(id){
    this.activeSource=id;
    for(const tr of this.tracks) tr._srcHidden=(id!==null && (tr.source||'video')!==id);
    this.applyGains();
    this._restartElements(); // 播放中切換音源：新的可聽元素需重新啟動（隱藏者未在播）
    emit('media:audioTracks');
    // 自動切換波形
    let targetIdx = -1;
    if(id === 'video' || id === null) targetIdx = Wave.sources.findIndex(s => (s.sourceId || 'video') === 'video');
    else targetIdx = Wave.sources.findIndex(s => s.sourceId === id);
    if(targetIdx >= 0) { Wave.selectSource(targetIdx); }
    emit('media:srcSel');
  },
  setRate(r){
    if(this._transport.virtualStartedAt!==null && (this.audioOnlyTimeline() || !video.hasAttribute('src'))){
      this._transport.reanchorVirtual({playbackRate:video.playbackRate||1});
    }
    const pp = (r >= 0.25 && r <= 4);
    video.playbackRate=r; if('preservesPitch' in video) video.preservesPitch=pp;
    getPlayerAdapter().rate(r).catch(()=>{});
    for(const tr of this.tracks){ if(tr.kind==='element'&&tr.el){ tr.el.playbackRate=r; if('preservesPitch' in tr.el) tr.el.preservesPitch=pp; } }
    if(!this.mpvMode && this.playing&&this.tracks.some(t=>t.kind==='buffer')){ this.stopBufferSources(); this.startBufferSources(this.vTime()); }
  },
  reset(options={}){
    this._intakeSession.invalidate();
    this._assetEpoch.invalidate();
    this._sequenceEditVersion+=1;
    if(this.mpvMode && getPlayerAdapter().isAvailable){
      this._stopMpvBoundsFeeder();
      const adapter=getPlayerAdapter();
      // 已載入 mpv 的 quit 與下一支素材的 launch 共用同一條 system-effect lane。
      this._intakeSession.queueExclusive(()=>adapter.quit()).catch(()=>{});
      this.mpvMode=false; this._mpvTime=0; this._mpvDuration=0;
      setPlayerAdapter(new Html5Adapter(video));
      video.style.display='';
      const vs=$('videoSub'); if(vs) vs.style.display='';
    }
    this._bgVersion++; this.activeSource=null; // 讓進行中的 _bgAudioIngest 知道要放棄；清除音源選擇
    this._wcProxyUrl=null; this._wcProxyPath=null; // WC 接管狀態隨媒體卸載歸零
    this.pendingChannels=[];
    this.audioPanelNotice=null;
    // 只清 runtime asset registry；State.audioProject 的 sourceMaps 由 project reset/load 負責，
    // 以便讀取專案時可在之後用 restoreExternalAudioSource 沿用相同 audioSourceId 重建。
    this.externalAudioSources=[];
    this._externalActivityKey=null;
    State.externalAudioState=[];
    State.externalAudioEnd=0;
    if(this._ingestDoneHandler){ window.removeEventListener('desk:ingest-done',this._ingestDoneHandler); this._ingestDoneHandler=null; }
    this.stopBufferSources(); this.stopElementSources();
    for(const tr of this.tracks){
      if(tr.el){
        // Fix #4：清除 scrubAudio 建立的隱藏 video 元素，避免跨檔案累積記憶體洩漏
        if(tr.el._scrubEl){ try{tr.el._scrubEl.src=''; tr.el._scrubEl=null;}catch(e){} }
        try{tr.el.src='';}catch(e){}
      }
    }
    this.tracks=[]; this.usingWebAudio=false;
    this._clipRuntimeReadySources?.clear();
    this._clipRuntimePromises?.clear();
    emit('media:clearMeters'); // Fix #10：清除 mixer 的舊音軌參照，避免 rafLoop 讀取廢棄 analyser
    // 注意：videoSrcNode 需重用，不可 null（同一 video 只能建立一次 source）
    const keepObjectURLs=options.keepObjectURLs instanceof Set?options.keepObjectURLs:new Set();
    this.objectURLs.forEach(u=>{ if(!keepObjectURLs.has(u)) try{URL.revokeObjectURL(u);}catch(e){} });
    this.objectURLs=this.objectURLs.filter(u=>keepObjectURLs.has(u));
    this.playing=false; this._transport.reset();
    // 影片序列：清空（取代式載入=開新序列；載入完成後由 _registerPrimary 重新登錄第一段）
    Seq.clear(); this.activeClipId=null; this._mpvPath=null; deselect('video'); deselect('audio'); 
    if(!options.keepVideoTracks) resetVideoTracks();
    if(!options.keepObjectURLs) delete this._preservedImageTimeline;
    this._seqSwitchToken=null;
    this._seqSwitching=false;
    video.style.visibility='';
    const pb=$('playBtn'); if(pb) pb.textContent='▶';
    State.duration=0;
    Wave.live=false; Wave.peaks=null; Wave.clearSources();
  }
};
// timeline 的 bus 控制以事件通知，讓 timeline 不需反向依賴 Media；在載入順序不同時也安全。
on('audio:externalRestored',detail=>{
  try{ Media.restoreExternalAudioEditState(detail?.sources); }catch(error){ console.warn('restore external audio history:',error); }
});
on('media:sequenceWillRestore',()=>{
  try{ Media._historyRestoreTimelineTime=Media.displayTime(); }
  catch(error){ Media._historyRestoreTimelineTime=0; }
});
on('media:sequenceRestored',()=>{
  const time=Math.max(0,Number(Media._historyRestoreTimelineTime)||0);
  Media._historyRestoreTimelineTime=null;
  try{ void Media.restoreSequenceEditState(time); }catch(error){ console.warn('restore media history:',error); }
});
/* 專案音訊 bus 的 M／S／音量變更 → 重新套用增益並重繪音軌列與時間軸。
   走 events.js 而非 window CustomEvent，理由見 docs/開發與驗證.md 的事件表。 */
on('audio:busChanged',()=>{
  try{ Media.applyGains(); emit('media:audioTracks'); emit('media:timeline'); }
  catch(error){ console.warn('bus changed:',error); }
});
/* 序列切換安全網：rafLoop 於背景分頁/最小化時完全暫停（rAF 凍結），但音訊元素照播——
   若無此網，跨段切換與間隙進出會凍結、音畫脫節。interval 在背景仍以 ~1s 節流執行，
   足以推進切換；前景時 rAF 主導、seqTick 冪等，多呼叫無害。 */
setInterval(()=>{ try{ Media.seqTick(); }catch(e){} }, 500);

export const WAVE_DECODE_MAX = 5e8;    // 超過此大小不整檔解碼波形，改即時擷取

function loadScript(src){return new Promise((res,rej)=>{
  if([...document.scripts].some(s=>s.src===src))return res();
  const s=document.createElement('script');s.src=src;s.onload=res;s.onerror=rej;document.head.appendChild(s);
});}


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
  sourceWaveforms:new Map(), // key -> {key,runtimeSourceId,mix,channels:Map,selection}

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
    if(mixPath!==undefined) state.mix.path=mixPath||null;
    if(mixPeaks&&mixPeaks.length) state.mix.peaks=mixPeaks;
    if(Array.isArray(channels)){
      for(let index=0;index<channels.length;index++){
        const raw=channels[index]||{};
        const desc=this._channelDescriptor(raw,index);
        const old=state.channels.get(desc.key);
        state.channels.set(desc.key,{
          ...desc,
          label:raw.label||old?.label||`Ch ${desc.sourceChannel+1}`,
          path:raw.file||raw.path||old?.path||null,
          peaks:raw.peaks||old?.peaks||null,
          loading:old?.loading||null
        });
      }
    }
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
      }))
    ];
  },
  async loadSourceWaveform(source,selection='mix'){
    const state=this._ensureSourceWaveforms(source);
    if(!state) return null;
    const key=this._normaliseSelection(selection);
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
  getSourceWaveform(source,fallbackPeaks=null){
    const state=this._ensureSourceWaveforms(source);
    if(!state) return {peaks:fallbackPeaks||null,selection:'mix',fallback:!!fallbackPeaks};
    const selection=state.selection||'mix';
    const wanted=selection==='mix'?state.mix:state.channels.get(selection);
    if(wanted?.peaks) return {peaks:wanted.peaks,selection,fallback:false};
    // 選擇的 cache 尚未讀取時仍先畫 MIX，避免時間軸空白；非同步完成後自行重繪。
    if(wanted?.path) void this.loadSourceWaveform(source,selection);
    const mix=state.mix.peaks||fallbackPeaks||null;
    return {peaks:mix,selection,fallback:selection!=='mix'&&!!mix,pending:!!wanted?.path};
  },
  setSourceWaveSelection(source,selection){
    const state=this._ensureSourceWaveforms(source);
    if(!state) return 'mix';
    const next=this._normaliseSelection(selection);
    state.selection=next==='mix'||state.channels.has(next)?next:'mix';
    // 立即重繪 MIX／已快取聲道；尚未解碼的單聲道會在背景載入後再重繪。
    this.getSourceWaveform(source);
    emit('media:timeline');
    return state.selection;
  },
  forgetSourceWaveforms(source){
    const state=this._sourceState(source,false);
    if(!state) return;
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
    if(ab.duration>State.duration){State.duration=ab.duration;emit('duration:known');}
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

export { Media, FFMPEG_MAX_BYTES, loadScript };
