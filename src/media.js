/* SUB Tool — 媒體引擎（影片 + Web Audio 多音軌 + ffmpeg）與波形 */
let _extTrackIdCounter = 0; // Fix #6：全域遞增序號取代 Date.now()+i，避免同毫秒碰撞
import { State, DESK, setFps, snapFps, ensureVideoTrackCount, resetVideoTracks } from './state.js';
import { secToEncore, snapTimeToFrame } from './time.js';
import { $, video } from './dom.js';
import { clamp, readFile, b64ToBytes, baseName, escapeHTML } from './util.js';
import { emit } from './events.js';
import { setStatus, showToast, openModal, closeModal } from './ui.js';
import { Seq } from './sequence.js';
import { renderAudioTracks, clearMeterStrips } from './mixer.js';
import { drawTimeline, updatePlayhead } from './timeline.js';

/* ===== 播放窗：自動偵測 FPS（網頁版，播放時取樣） =====
   FPS-SYNC：影格率一律【實測】——這裡用 requestVideoFrameCallback 量真實影格時間戳，
   桌面版則用 ffprobe（DESK.probe → info.video.fps）。【絕不可依檔名判斷 FPS】，
   因為檔名可能寫錯（例：標 24FPS 實為 29.97）。詳見 FPS_時碼一致性.md。 */
function detectFpsWeb(){
  if(!('requestVideoFrameCallback' in HTMLVideoElement.prototype))return;
  let last=null, deltas=[], frames=0;
  const cb=(now,meta)=>{
    if(last!=null){ const d=meta.mediaTime-last; if(d>0.0005)deltas.push(d); }
    last=meta.mediaTime; frames++;
    if(deltas.length<12 && frames<60){ try{video.requestVideoFrameCallback(cb);}catch(e){} return; }
    if(deltas.length>=6){ deltas.sort((a,b)=>a-b); const med=deltas[deltas.length>>1]; const raw=1/med;
      // 不可先 Math.round：整數化會把 29.97→30、23.976→24，毀掉 NTSC 分數影格率的偵測；
      // 直接把實測值交給 snapFps 對齊到支援集合（23.976/24/25/29.97/30）
      if(raw>=10&&raw<=120){ const fps=snapFps(raw); setFps(String(fps)); // 經 setFps 統一處理：偵測到的影格率一律視為非 Drop-frame，清除殘留的 dropFrame
        setStatus('偵測到影片 FPS：'+fps,'ok'); } }
  };
  try{ video.requestVideoFrameCallback(cb); }catch(e){}
}

/* ===== 3. 媒體引擎 ==================================================== */
const Media = {
  ctx:null,            // AudioContext
  master:null,         // master gain
  videoSrcNode:null,   // MediaElementSource (原生單軌)
  tracks:[],           // {id,name,kind:'native'|'buffer',buffer?,gain,muted,solo,volume,srcNode?,offset}
  playing:false,
  startCtxTime:0,      // ctx.currentTime 對應播放起點
  startMediaTime:0,    // 對應 media 時間
  usingWebAudio:false, // 是否用 Web Audio 混音（多軌）
  ffmpeg:null, ffmpegLoading:null,
  objectURLs:[],
  mpvMode:false, _mpvTime:0, _mpvDuration:0, _bgVersion:0,
  activeSource:null, // null=全部混音；'video'=影片原音；'ext-xxx'=外部檔案
  pendingChannels:[], // 背景抽取音軌時的「準備中」聲道（讓混音器立即顯示推桿，逐一就緒）

  // 由 ffprobe 的 audio[] 推算出每個聲道的標籤（須與 main.js ingest 的展開規則一致）
  _expandChannels(audio){
    const out=[];
    let globalCh = 1;
    (audio||[]).forEach((a,i)=>{
      const ch=Math.max(1,a.channels||1);
      for(let k=0;k<ch;k++) {
        out.push(`聲道${globalCh}`);
        globalCh++;
      }
    });
    return out;
  },

  ensureCtx(){
    if(!this.ctx){
      this.ctx=new (window.AudioContext||window.webkitAudioContext)();
      this.master=this.ctx.createGain(); this.master.connect(this.ctx.destination);
      // 分接 analyser 供「即時波形」擷取（不影響輸出）
      this.analyser=this.ctx.createAnalyser(); this.analyser.fftSize=2048;
      this.master.connect(this.analyser);
      this._anBuf=new Float32Array(this.analyser.fftSize);
    }
    if(this.ctx.state==='suspended')this.ctx.resume();
    return this.ctx;
  },

  async loadVideoFile(file){
    this.reset();
    State.mediaName=file.name; State.mediaSize=file.size;
    const url=URL.createObjectURL(file); this.objectURLs.push(url);
    video.src=url;
    const native = await canPlayNatively(file, video);
    $('noVideo').style.display='none';
    if(native){
      await new Promise((res)=>{ video.onloadedmetadata=res; if(video.readyState>=1)res(); });
      State.duration=video.duration||0;
      State.videoWidth=video.videoWidth||0;
      State.videoHeight=video.videoHeight||0;
      detectFpsWeb(); // 播放時自動偵測 FPS
      this._registerPrimary({ name:file.name, web:{url}, dur:State.duration||0 }); // 登錄為序列第一段
      // 用 Web Audio 接管原生音訊，L / R 分頻顯示於混音器
      const stereoTracks=this._connectStereo();
      if(stereoTracks){
        this.tracks.push(...stereoTracks);
        this.activeSource='video';
        this.usingWebAudio=false;
        setStatus('已載入原生影音','ok');
      }
      // 探測是否有多音軌
      await this.probeAndMaybeExtract(file);
      // 產生波形：小檔整檔解碼；大檔（如長片）改用播放時即時擷取，避免記憶體爆掉
      if(file.size <= WAVE_DECODE_MAX){
        Wave.fromFile(file).catch(()=>Wave.initLive());
      }else{
        Wave.initLive();
        // Fix #18：區分 500MB-1.6GB（可播放但波形受限）與更大檔案的提示
        if(file.size <= FFMPEG_MAX_BYTES){
          showToast('檔案較大（>500MB）：波形將逐步產生。如需完整波形，可另載入音訊檔。');
        }else{
          showToast('檔案較大：波形將於播放時逐步產生（或可另載入音訊檔）');
        }
      }
    }else{
      // 非原生格式：ffmpeg 轉檔給預覽 + 抽音軌
      setStatus('格式非瀏覽器原生，啟動 ffmpeg…','busy');
      await this.transcodeAndExtract(file);
    }
    emit('duration:known');
  },

  async probeAndMaybeExtract(file){
    // 嘗試以原生 audioTracks 偵測；多數瀏覽器不支援，故主要靠 ffmpeg
    try{
      const at=video.audioTracks;
      if(at && at.length>1){
        setStatus(`偵測到 ${at.length} 條原生音軌`,'ok');
        for(let i=0;i<at.length;i++){
          this.tracks.push({id:'nat'+i,name:'音軌 '+(i+1)+(at[i].language?(' '+at[i].language):''),kind:'nativeTrack',
            index:i,enabled:i===0});
          at[i].enabled=(i===0);
        }
        renderAudioTracks(); return;
      }
    }catch(e){}
    // 用 ffmpeg 探測（不阻塞主流程，量力而為）
    if(file.size <= FFMPEG_MAX_BYTES){
      this.ffprobeTracks(file).then(streams=>{
        if(streams && streams.aCount>1){
          showToast(`此檔含 ${streams.aCount} 條音軌，點音軌面板的「抽取多軌」以同時混音`);
          $('atHint').innerHTML=`含 ${streams.aCount} 條音軌 · <a href="#" id="extractLink" style="color:var(--accent)">抽取多軌混音</a>`;
          $('extractLink').onclick=(e)=>{e.preventDefault();this.extractAllAudio(file,streams.aCount);};
        }
      }).catch(()=>{});
    }else{
      $('atHint').textContent='檔案過大，略過多軌偵測（建議用 Electron 版）';
    }
    renderAudioTracks();
  },

  async addAudioFile(file){
    this.ensureCtx();
    setStatus('載入音訊中…','busy');
    try{
      const src='ext-'+file.name;
      const url=URL.createObjectURL(file); this.objectURLs.push(url);
      const el=new Audio(); el.src=url; el.preload='auto';
      await new Promise((r,rj)=>{
        el.onloadedmetadata=r; if(el.readyState>=1)r();
        el.onerror=()=>rj(new Error('無法讀取此音訊檔 ('+file.name+')'));
        setTimeout(r,10000);
      });
      const node=this.ctx.createMediaElementSource(el);
      const chCount=Math.max(1,node.channelCount||2);
      const newTracks=this._splitToChannelTracks(node,src,el,chCount);
      this.tracks.push(...newTracks);
      this.switchSource(src);
      this.usingWebAudio=true;
      this.syncMuteState();
      if(el.duration>State.duration){ State.duration=el.duration; emit('duration:known'); }
      if(!Wave.peaks) Wave.initLive();
      setStatus('音軌已加入','ok');
      renderAudioTracks();
      if(this.playing) this.startElementSources(this.vTime());
    }catch(e){ setStatus('音訊載入失敗：'+e.message,''); showToast('音訊載入失敗：'+e.message); }
  },

  /* --- 桌面 (Electron) 媒體：系統 ffmpeg，單次讀取多輸出，逐聲道音軌 + 電平表 --- */
  async loadDesktopMedia(p){
    this.reset();
    State.mediaPath=p; State.mediaName=baseName(p);
    const st=await DESK.stat(p); State.mediaSize=st.size||0;
    setStatus('讀取媒體資訊…','busy');
    let info=null; try{ info=await DESK.probe(p); }catch(e){ showToast('ffprobe 失敗：'+e.message); }
    const dur=info?info.duration:0;
    if(info&&info.video&&info.video.fps){ setFps(info.video.fps); }
    if(info&&info.video){ State.videoWidth=info.video.width||0; State.videoHeight=info.video.height||0; }
    const nativeCodecs=['h264','hevc','vp8','vp9','av1','mpeg4'];
    const vCodec=info&&info.video?info.video.codec:null;
    const ext=(State.mediaName.split('.').pop()||'').toLowerCase();
    const containerOK=['mp4','mov','m4v','webm','mkv'].includes(ext);
    const canNative = !!(info&&info.video && nativeCodecs.includes(vCodec) && containerOK);
    const audio=info?info.audio:[];
    $('noVideo').style.display='none';
    this.ensureCtx();

    // (mpv) 非原生格式或多音軌且偵測到 mpv：秒開，背景抽音軌
    if((!canNative || audio.length>1) && DESK.mpv){
      const mpvInfo=await DESK.mpv.detect();
      if(mpvInfo.available){ await this._loadViaMpv(p,info); return; }
    }

    // (A) 純原生 + 單一/無音軌：完全不需 ffmpeg，直讀最快
    if(canNative && audio.length<=1){
      video.src=await DESK.fileURL(p);
      await new Promise(r=>{video.onloadedmetadata=r; if(video.readyState>=1)r(); setTimeout(r,10000);});
      State.duration=video.duration||dur||0;
      this._registerPrimary({ name:State.mediaName, path:p, web:{url:video.src}, dur:State.duration||0, fps:info?.video?.fps||0 });
      const stereoTracks=this._connectStereo();
      if(stereoTracks) this.tracks.push(...stereoTracks);
      this.activeSource='video';
      this.usingWebAudio=false; this.syncMuteState(); renderAudioTracks();
      if(audio.length>0){
        setStatus('產生波形…','busy');
        try{ 
          const wavPath=await DESK.waveAudio(p,dur); 
          const wavUrl=await DESK.fileURL(wavPath);
          const res=await fetch(wavUrl);
          const buf=await res.arrayBuffer();
          const ab=await this.ctx.decodeAudioData(buf); 
          try { DESK.cleanupAudio(wavPath); } catch(e) {}
          if(ab.duration>State.duration)State.duration=ab.duration; 
          Wave.setFromBuffer(ab, 'video'); drawTimeline(); 
        }
        catch(e){ console.warn('wave',e); Wave.initLive(); }
      }
      setStatus('媒體已載入（桌面模式，原生直讀）','ok'); emit('duration:known'); return;
    }

    // (B) 非原生（需 proxy）或原生多音軌
    // 非原生且有 streamIngest：邊轉邊播（幾秒內可開始播放）
    if(!canNative && DESK.streamIngest){
      const myVer=this._bgVersion; // 此次載入的版本；使用者中途換檔時用來放棄陳舊工作
      setStatus('讀取中（背景轉檔，即將可播放）…','busy');
      let res;
      try{ res=await DESK.streamIngest({ path:p, duration:dur, audio }); }
      catch(e){ console.error(e); showToast('讀取失敗：'+e.message); setStatus('讀取失敗',''); return; }
      if(this._bgVersion!==myVer) return; // 已換檔
      if(res.cached) setStatus('使用既有快取，秒開…','ok');

      video.src=res.streamUrl;
      await new Promise(r=>{video.onloadedmetadata=r; if(video.readyState>=1)r(); setTimeout(r,15000);});
      if(this._bgVersion!==myVer) return;
      State.duration=video.duration||dur||0;
      video.muted=true;
      this._registerPrimary({ name:State.mediaName, path:p, web:{url:res.streamUrl}, dur:State.duration||0, fps:info?.video?.fps||0 });
      this.activeSource='video';
      // 混音器立即顯示「準備中」推桿
      this.pendingChannels=this._expandChannels(audio).map(label=>({label,ready:false}));
      this.usingWebAudio=true; this.syncMuteState(); renderAudioTracks();
      Wave.initLive(); emit('duration:known');

      // 載入音軌+波形的共用函式（快取立即執行，非快取等轉檔完成後執行）
      const self=this;
      const loadTracksAndWave=async(r)=>{
        if(self._bgVersion!==myVer) return;
        const chs=r.channels||[];
        try{
          if(chs.length){
            setStatus(`載入 ${chs.length} 條聲道…`,'busy');
            // 並行取得所有聲道的 file URL + 等待 metadata（避免 N 次序列 await）
            const els=await Promise.all(chs.map(ch=>
              DESK.fileURL(ch.file).then(url=>new Promise(res=>{
                const el=new Audio(); el.src=url; el.preload='auto';
                el.onloadedmetadata=()=>res(el); if(el.readyState>=1)res(el);
                setTimeout(()=>res(el),10000);
              }))
            ));
            if(self._bgVersion!==myVer) return;
            for(let i=0;i<chs.length;i++){
              const el=els[i]; if(!el) continue;
              const node=self.ctx.createMediaElementSource(el);
              const g=self.ctx.createGain(); node.connect(g); g.connect(self.master);
              const tr={id:'el'+i,name:chs[i].label||('音軌 '+(i+1)),kind:'element',el,gain:g,muted:false,solo:false,volume:1,file:chs[i].file};
              self.attachMeter(tr,node); self.tracks.push(tr);
              if(self.pendingChannels[i]) self.pendingChannels[i].ready=true;
              self.syncMuteState(); renderAudioTracks();
            }
          }
        }finally{ if(self._bgVersion===myVer){ self.pendingChannels=[]; renderAudioTracks(); } }
        if(self._bgVersion!==myVer) return;
        self.syncMuteState(); renderAudioTracks();
        if(r.wave){
          try{ const u=await DESK.fileURL(r.wave); const fb=await fetch(u); const buf=await fb.arrayBuffer(); if(self._bgVersion===myVer){ const pk=Wave.computeFromWav(buf); if(pk){ Wave.live=false; Wave.registerSources(r.wave,chs); Wave.sources[0].peaks=pk; drawTimeline(); } else Wave.initLive(); } }
          catch(e2){ console.warn('wave',e2); if(self._bgVersion===myVer) Wave.initLive(); }
        }
        if(self._bgVersion===myVer) setStatus('媒體已載入','ok');
      };

      if(res.cached){
        loadTracksAndWave(res);
      } else {
        setStatus('視訊播放就緒，音軌轉檔中（背景）…','busy');
        // 只在「本次轉檔工作」完成時才載入；用 ingestJobId 過濾其他工作的完成事件，並在換檔時移除
        const handler=(ev)=>{
          if(self._bgVersion!==myVer){ window.removeEventListener('desk:ingest-done',handler); self._ingestDoneHandler=null; return; }
          if(res.ingestJobId && ev?.detail?.jobId && ev.detail.jobId!==res.ingestJobId) return; // 非本次轉檔，忽略
          window.removeEventListener('desk:ingest-done',handler); self._ingestDoneHandler=null;
          loadTracksAndWave(res);
        };
        this._ingestDoneHandler=handler;
        window.addEventListener('desk:ingest-done', handler);
      }
      return;
    }

    // (B2) 原生多音軌 或 無 streamIngest 時的原有路徑
    setStatus(canNative?'抽取多音軌（單次讀取）…':'讀取並轉檔中（單次讀取，大檔需數分鐘）…','busy');
    let res;
    try{ res=await DESK.ingest({ path:p, duration:dur, needsProxy:!canNative, audio }); }
    catch(e){ console.error(e); showToast('讀取/轉檔失敗：'+e.message); setStatus('讀取/轉檔失敗',''); return; }
    if(res.cached) setStatus('使用既有快取，秒開…','ok');

    video.src=await DESK.fileURL(res.proxy||p);
    await new Promise(r=>{video.onloadedmetadata=r; if(video.readyState>=1)r(); setTimeout(r,10000);});
    State.duration=video.duration||dur||0;
    video.muted=true;
    this._registerPrimary({ name:State.mediaName, path:p, web:{url:video.src}, dur:State.duration||0, fps:info?.video?.fps||0 });

    const chs=res.channels||[];
    if(chs.length){
      setStatus(`載入 ${chs.length} 條聲道…`,'busy');
      const els=await Promise.all(chs.map(ch=>
        DESK.fileURL(ch.file).then(url=>new Promise(r=>{
          const el=new Audio(); el.src=url; el.preload='auto';
          el.onloadedmetadata=()=>r(el); if(el.readyState>=1)r(el);
          setTimeout(()=>r(el),10000);
        }))
      ));
      for(let i=0;i<chs.length;i++){
        const el=els[i]; if(!el) continue;
        const node=this.ctx.createMediaElementSource(el);
        const g=this.ctx.createGain(); node.connect(g); g.connect(this.master);
        const tr={id:'el'+i,name:chs[i].label||('音軌 '+(i+1)),kind:'element',el,gain:g,muted:false,solo:false,volume:1,file:chs[i].file};
        this.attachMeter(tr,node); this.tracks.push(tr);
      }
    }
    this.activeSource='video';
    this.usingWebAudio=true; this.syncMuteState(); renderAudioTracks();

    if(res.wave){
      // FIX: 改用 fileURL+fetch+computeFromWav，與 streamIngest 路徑一致（避免 readB64 塞爆 IPC + decodeAudioData 耗盡記憶體）
      try{ const buf=await fetch(await DESK.fileURL(res.wave)).then(r=>r.arrayBuffer()); Wave.live=false; const pk=Wave.computeFromWav(buf); Wave.registerSources(res.wave,chs); if(pk)Wave.sources[0].peaks=pk; drawTimeline(); }
      catch(e){ console.warn('wave',e); Wave.initLive(); }
    } else Wave.initLive();

    setStatus('媒體已載入（桌面模式）','ok'); emit('duration:known');
  },
  async addAudioFileDesktop(p){
    this.ensureCtx();
    try{
      const name=baseName(p);
      const src='ext-'+name;
      let chCount=2;
      try{ const info=await DESK.probe(p); chCount=info?.audio?.[0]?.channels||2; }catch(e){}
      const el=new Audio(); el.src=await DESK.fileURL(p); el.preload='auto';
      await new Promise((r,rj)=>{
        el.onloadedmetadata=r; if(el.readyState>=1)r();
        el.onerror=()=>rj(new Error('音訊元素載入失敗：'+p));
        setTimeout(r,10000);
      });
      const node=this.ctx.createMediaElementSource(el);
      const newTracks=this._splitToChannelTracks(node,src,el,chCount);
      this.tracks.push(...newTracks);
      this.switchSource(src);
      this.usingWebAudio=true; this.syncMuteState();
      if(el.duration>State.duration){State.duration=el.duration;emit('duration:known');}
      renderAudioTracks();
      if(this.playing) this.startElementSources(this.vTime());
      setStatus('產生波形…','busy');
      try {
        const wavPath = await DESK.waveAudio(p, el.duration);
        const wavUrl = await DESK.fileURL(wavPath);
        const res = await fetch(wavUrl);
        const buf = await res.arrayBuffer();
        try { DESK.cleanupAudio(wavPath); } catch(e) {}
        
        const pk = Wave.computeFromWav(buf);
        if(pk) {
          Wave.sources = Wave.sources.filter(s => s.sourceId !== src);
          Wave.sources.push({ label: '主混音', path: null, peaks: pk, sourceId: src });
          Wave.live = false;
          Wave.srcIdx = Wave.sources.findIndex(s => s.sourceId === src);
          Wave._renderSrcSel();
        } else {
          const ab = await this.ctx.decodeAudioData(buf);
          Wave.setFromBuffer(ab, src);
        }
        setStatus('音軌與波形已加入','ok');
      } catch(e) { console.warn('waveAudio error', e); setStatus('音軌已加入','ok'); }
    }catch(e){ setStatus('音軌載入失敗：'+e.message,''); showToast('無法載入音訊檔：'+e.message); }
  },

  /* --- mpv 即時開啟路徑（偵測到 mpv.exe 時使用，無需等 proxy 轉檔） --- */
  _mpvRect(){ const vw=$('videoWrap'); const r=vw.getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height}; },
  _startMpvBoundsFeeder(){
    const send=()=>{ if(!this.mpvMode||!DESK?.mpv)return; DESK.mpv.setBounds(this._mpvRect()).catch(()=>{}); };
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
  async _loadViaMpv(p, info){
    const dur=info?.duration||0;
    const audio=info?.audio||[];
    setStatus('啟動 mpv（秒開）…','busy');
    // 影片區清空為黑底，mpv 覆蓋視窗會貼合在此
    $('noVideo').style.display='none';
    video.style.display='none';
    $('videoSub').style.display='none'; // 字幕改由 mpv/libass 渲染
    let res;
    try{ res=await DESK.mpv.launch({src:p, bounds:this._mpvRect(), audio}); }
    catch(e){ showToast('mpv 啟動失敗：'+e.message); setStatus('mpv 啟動失敗',''); $('videoSub').style.display=''; video.style.display=''; return; }
    this.mpvMode=true; this._mpvTime=0; this._mpvPath=p;
    // mpv 顯示時仍要建立透明的 DOM 字幕命中層，才能直接拖曳字幕。
    emit('render:videoSub');
    this._mpvDuration=res.duration||dur||0;
    State.duration=this._mpvDuration;
    if(info?.video?.fps) setFps(info.video.fps);
    this._registerPrimary({ name:State.mediaName, path:p, dur:this._mpvDuration||0, fps:info?.video?.fps||0 });

    this._startMpvBoundsFeeder();
    emit('mpv:refreshSubs'); // 把目前字幕餵給 mpv

    // 監聽 mpv 事件（時碼同步 / 播放狀態）。序列模式：e.data 為【來源時間】，顯示前換算為時間軸時間。
    DESK.mpv.onEvent(e=>{
      if(e.event==='property-change'){
        if(e.name==='time-pos'&&e.data!=null){
          if(this._seqSwitching || this._gap) return; // 換檔/間隙期間忽略殘留回報
          const prev=this._mpvTime; this._mpvTime=e.data;
          const _ac=this.seqOn()?this._activeClip():null;
          const toTl=(s)=>_ac?Seq.toTimeline(s,_ac):s;
          // FPS-SYNC（詳見 FPS_時碼一致性.md）：暫停時讓播放器時碼與時間軸播放點同源同格：
          //  - 若 mpv 回報只是 seek 後的 settling 抖動（與權威 _lastSeekTime 差 <1.5 格），
          //    維持 _lastSeekTime，避免用未對齊的原始時間經 secToEncore 進位多一格、
          //    也避免拉偏權威值而破壞逐格精度；
          //  - 若是大幅變動（例如在 mpv 視窗內拖拉），才吸附到最近格並更新 _lastSeekTime。
          // 播放中則用原始時間平滑前進。（比較與顯示一律在時間軸域）
          let t=toTl(e.data);
          if(!this.playing){
            const frame=1/(State.fps||25);
            if(this._lastSeekTime!=null && Math.abs(t-this._lastSeekTime)<2.5*frame){
              t=this._lastSeekTime;
            } else {
              t=snapTimeToFrame(t, State.fps, State.dropFrame); this._lastSeekTime=t;
            }
          }
          $('tcCur').textContent=secToEncore(t,State.fps,State.dropFrame);
          $('seekBar').value=Math.round(t*1000);
          updatePlayhead();
          if(Math.abs(e.data-prev)>0.5) window.dispatchEvent(new CustomEvent('mpv:seeked',{detail:toTl(e.data)}));
        }
        if(e.name==='pause'){
          const paused=!!e.data;
          if(this._seqSwitching) return; // loadfile 過程中的暫停屬內部操作
          if(paused&&this.playing){
            // 序列：keep-open 在段尾自動暫停 → 若後面還有內容，交給推進而非停止
            const c=this.seqOn()?this._activeClip():null;
            if(c && Math.abs(this.vTime()-c.out)<0.3 && (Seq.clipAt(Seq.clipEnd(c)+0.001)||Seq.nextAfter(Seq.clipEnd(c)))){
              this._mpvTime=c.out; this.seqContinueAtEnd(); return;
            }
            this.stopElementSources(); this.playing=false; $('playBtn').textContent='▶'; video.dispatchEvent(new Event('pause'));
          }
          else if(!paused&&!this.playing){ this.ensureCtx(); this.startElementSources(this._mpvTime, this.tlTime()); this.playing=true; $('playBtn').textContent='⏸'; video.dispatchEvent(new Event('play')); }
        }
        if(e.name==='duration'&&typeof e.data==='number'&&e.data>0){
          this._mpvDuration=e.data;
          if(this.seqOn()){ const c=this._activeClip(); if(c) Seq.updateSourceDur(c, e.data); }
          else { State.duration=e.data; emit('duration:known'); }
        }
      }
      if(e.event==='end-file'&&this.mpvMode){
        if(this._seqSwitching) return; // loadfile 造成的舊檔 end-file
        if(e.reason==='error'){ // mpv 播放失敗（解碼/濾鏡錯誤）：浮上來，不當成段尾推進
          this.stopElementSources(); this.playing=false; $('playBtn').textContent='▶';
          setStatus('mpv 播放失敗（解碼或濾鏡錯誤）','err'); showToast('mpv 播放此影片段失敗');
          return;
        }
        // 序列：來源播到底（out===dur）→ 若還有後續，推進而非停止
        const c=this.seqOn()?this._activeClip():null;
        if(c && this.playing){ this._mpvTime=c.out; if(this.seqContinueAtEnd()) return; }
        this.stopElementSources(); this.playing=false; $('playBtn').textContent='▶';
      }
    });

    // 混音器立即顯示「準備中」推桿（聲道數在 ffprobe 階段就已知）
    this.pendingChannels = this._expandChannels(audio).map(label=>({label,ready:false}));
    renderAudioTracks();
    setStatus('媒體已載入（mpv 秒開，嵌入播放）','ok');
    emit('duration:known');
    Wave.initLive();

    // 背景抽取音軌（不阻塞播放；完成後 element tracks 接管音訊，mpv 靜音）
    if(audio.length>0){
      this.ensureCtx();
      this._bgAudioIngest(p,audio,dur);
    }
  },

  async _bgAudioIngest(p, audio, dur){
    const myVer=this._bgVersion;
    setStatus('背景抽取音軌中（不影響播放）…','busy');
    let res;
    // needsProxy:true（v4.22 WebCodecs 階段5）：mpv 路徑同 pass 一併產 720p proxy——
    // proxy 就緒後 WebCodecs 預覽引擎接管畫面（即時多軌合成），mpv 退居時鐘＋兜底
    try{ res=await DESK.ingest({path:p,duration:dur,needsProxy:true,audio}); }
    catch(e){ if(this._bgVersion!==myVer) return; console.warn('bg audio ingest:',e); this.pendingChannels=[]; renderAudioTracks(); setStatus('音軌抽取失敗：'+e.message,''); return; }
    if(this._bgVersion!==myVer) return; // 使用者已換另一個檔，丟棄結果
    if(res.proxy){
      try{
        const u=await DESK.fileURL(res.proxy);
        if(this._bgVersion===myVer){ 
          this._wcProxyUrl=u; 
          this._wcProxyPath=p; 
          this.seek(this.displayTime()); // 強制全域跳躍以觸發 WCPreview 接管與解碼
        }
      }catch(e){ console.warn('proxy url:',e); }
    }

    const chs=res.channels||[];
    if(chs.length){
      // 並行載入所有聲道，大幅縮短多聲道（8ch MXF 等）的等待時間
      const els=await Promise.all(chs.map(ch=>
        DESK.fileURL(ch.file).then(url=>new Promise(r=>{
          const el=new Audio(); el.src=url; el.preload='auto';
          el.onloadedmetadata=()=>r(el); if(el.readyState>=1)r(el);
          setTimeout(()=>r(el),10000);
        }))
      ));
      // Fix #12：bail-out 前清空已建立的 Audio 元素 src，停止背景緩衝
      if(this._bgVersion!==myVer) { els.forEach(el=>{ if(el) try{el.src='';}catch(e){} }); return; }
      for(let i=0;i<chs.length;i++){
        const el=els[i]; if(!el) continue;
        const node=this.ctx.createMediaElementSource(el);
        const g=this.ctx.createGain(); node.connect(g); g.connect(this.master);
        const tr={id:'el'+i,name:chs[i].label||('音軌 '+(i+1)),kind:'element',el,gain:g,muted:false,solo:false,volume:1,file:chs[i].file};
        this.attachMeter(tr,node); this.tracks.push(tr);
        if(this.pendingChannels[i]) this.pendingChannels[i].ready=true;
        this.usingWebAudio=true; this.syncMuteState();
        renderAudioTracks();
      }
    }
    this.pendingChannels=[];
    this.usingWebAudio=true; this.syncMuteState();
    // element tracks 接管後，mpv 靜音（避免雙重音訊）
    if(chs.length>0) DESK.mpv.mute(true).catch(()=>{});
    if(this.playing) this.startElementSources(this._mpvTime);
    renderAudioTracks();

      if(res.wave){
        try{
          const wavUrl=await DESK.fileURL(res.wave);
          const r=await fetch(wavUrl);
          const buf=await r.arrayBuffer();
          if(this._bgVersion===myVer){
            const ab=await this.ctx.decodeAudioData(buf);
            Wave.live=false; Wave.compute(ab); Wave.registerSources(res.wave,chs); drawTimeline();
          }
        }catch(e){}
      }
    setStatus('音軌與波形已就緒','ok');
  },

  /* --- ffmpeg.wasm --- */
  async loadFFmpeg(){
    if(this.ffmpeg)return this.ffmpeg;
    if(this.ffmpegLoading)return this.ffmpegLoading;
    this.ffmpegLoading=(async()=>{
      setStatus('載入 ffmpeg.wasm（首次需下載 ~25MB）…','busy');
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
        $('stEngine').textContent='音訊引擎：ffmpeg.wasm';
        setStatus('ffmpeg 就緒','ok');
        return ff;
      }catch(e){
        setStatus('ffmpeg 載入失敗（需網路；或改用本機伺服器/Electron 版）','');
        showToast('ffmpeg.wasm 載入失敗：需網路連線，或以本機伺服器開啟本頁');
        throw e;
      }
    })();
    return this.ffmpegLoading;
  },
  async ffprobeTracks(file){
    const ff=await this.loadFFmpeg();
    const data=new Uint8Array(await readFile(file));
    ff.FS('writeFile','probe.in',data);
    let log=''; ff.setLogger(({message})=>{ log+=message+'\n'; });
    try{ await ff.run('-i','probe.in'); }catch(e){}
    ff.setLogger(()=>{});
    try{ ff.FS('unlink','probe.in'); }catch(e){}
    const aCount=(log.match(/Stream #\d+:\d+.*: Audio:/g)||[]).length;
    const vCount=(log.match(/Stream #\d+:\d+.*: Video:/g)||[]).length;
    return {aCount,vCount,log};
  },
  async extractAllAudio(file,count){
    let ff;
    try{
      ff=await this.loadFFmpeg();
      this.ensureCtx();
      const data=new Uint8Array(await readFile(file));
      ff.FS('writeFile','in.media',data);
      for(let i=0;i<count;i++){
        setStatus(`抽取音軌 ${i+1}/${count}…`,'busy');
        await ff.run('-i','in.media','-map',`0:a:${i}`,'-ac','2','-ar','48000',`a${i}.wav`);
        const wav=ff.FS('readFile',`a${i}.wav`);
        const ab=await this.ctx.decodeAudioData(wav.buffer.slice(0));
        const g=this.ctx.createGain(); g.connect(this.master);
        this.tracks.push({id:'ex'+i,name:'抽取音軌 '+(i+1),kind:'buffer',buffer:ab,gain:g,muted:false,solo:false,volume:1});
      }
      this.usingWebAudio=true; this.syncMuteState();
      setStatus('多音軌抽取完成','ok'); renderAudioTracks();
      if(this.playing){ this.stopBufferSources(); this.startBufferSources(video.currentTime); }
    }catch(e){ setStatus('音軌抽取失敗','');console.error(e);
    }finally{
      // Fix #5：不論成功或失敗都清除 ffmpeg 虛擬 FS，防記憶體洩漏與後續「file already exists」
      if(ff){
        try{ ff.FS('unlink','in.media'); }catch(e){}
        for(let i=0;i<count;i++) try{ ff.FS('unlink',`a${i}.wav`); }catch(e){}
      }
    }
  },
  async transcodeAndExtract(file){
    if(file.size>FFMPEG_MAX_BYTES){
      setStatus('','');
      openModal('檔案過大',
        `<b>${file.name}</b> 約 ${(file.size/1e9).toFixed(2)} GB。<br><br>`+
        `瀏覽器內的 ffmpeg.wasm 受記憶體限制，無法處理數 GB 的 MXF/非原生影片。<br><br>`+
        `建議：<br>• 先用本機 ffmpeg 轉成 MP4(H.264/AAC) 後再匯入<br>`+
        `• 或改用 <b>Electron 桌面版</b>（可直接讀 MXF 與多音軌同時播放）<br><br>`+
        `字幕編輯、時間軸與所有匯入/匯出功能仍可正常使用（可先載入波形用的音訊檔）。`);
      return;
    }
    try{
      const ff=await this.loadFFmpeg();
      this.ensureCtx();
      const data=new Uint8Array(await readFile(file));
      ff.FS('writeFile','in.media',data);
      const probe=await (async()=>{ let log='';ff.setLogger(({message})=>log+=message+'\n');try{await ff.run('-i','in.media');}catch(e){}ff.setLogger(()=>{});return log;})();
      const aCount=(probe.match(/Stream #\d+:\d+.*: Audio:/g)||[]).length; // 0=無音軌：跳過抽取，不可 ||1 強抽（會整段誤報「轉檔失敗」）
      setStatus('轉檔預覽影片中…','busy');
      await ff.run('-i','in.media','-c:v','libx264','-preset','ultrafast','-crf','26','-an','-movflags','+faststart','prev.mp4');
      const mp4=ff.FS('readFile','prev.mp4');
      const url=URL.createObjectURL(new Blob([mp4.buffer],{type:'video/mp4'})); this.objectURLs.push(url);
      video.src=url; video.muted=true;
      await new Promise(res=>{video.onloadedmetadata=res;});
      $('noVideo').style.display='none';
      State.duration=video.duration||0;
      this._registerPrimary({ name:file.name, web:{url}, dur:State.duration||0 });
      // 抽音軌
      for(let i=0;i<aCount;i++){
        setStatus(`抽取音軌 ${i+1}/${aCount}…`,'busy');
        await ff.run('-i','in.media','-map',`0:a:${i}`,'-ac','2','-ar','48000',`a${i}.wav`);
        const wav=ff.FS('readFile',`a${i}.wav`);
        const ab=await this.ctx.decodeAudioData(wav.buffer.slice(0));
        const g=this.ctx.createGain(); g.connect(this.master);
        this.tracks.push({id:'ex'+i,name:'音軌 '+(i+1),kind:'buffer',buffer:ab,gain:g,muted:false,solo:false,volume:1});
        try{ff.FS('unlink',`a${i}.wav`);}catch(e){}
      }
      try{ff.FS('unlink','in.media');ff.FS('unlink','prev.mp4');}catch(e){}
      this.usingWebAudio=true; this.syncMuteState();
      setStatus('轉檔完成','ok'); renderAudioTracks();
      Wave.fromTracks();
      emit('duration:known');
    }catch(e){ setStatus('轉檔失敗','');console.error(e);showToast('ffmpeg 轉檔失敗'); }
  },

  /* 把影片內建音訊接到 Web Audio（同一 video 元素只能 createMediaElementSource 一次，故重用） */
  connectNativeAudio(){
    this.ensureCtx();
    if(!this.videoSrcNode){
      try{ this.videoSrcNode=this.ctx.createMediaElementSource(video); }
      catch(e){ console.warn('MediaElementSource',e); return null; }
    } else { try{ this.videoSrcNode.disconnect(); }catch(e){} }
    const g=this.ctx.createGain(); this.videoSrcNode.connect(g); g.connect(this.master);
    return g;
  },
  /* 立體聲分頻：L / R 各自一條 native 音軌，可獨立靜音/獨奏/電平表 */
  _connectStereo(){
    this.ensureCtx();
    if(!this.videoSrcNode){
      try{ this.videoSrcNode=this.ctx.createMediaElementSource(video); }
      catch(e){ console.warn('MediaElementSource',e); return null; }
    } else { try{ this.videoSrcNode.disconnect(); }catch(e){} }
    const splitter=this.ctx.createChannelSplitter(2);
    const gL=this.ctx.createGain(), gR=this.ctx.createGain();
    const merger=this.ctx.createChannelMerger(2);
    this.videoSrcNode.connect(splitter);
    splitter.connect(gL,0); splitter.connect(gR,1);
    gL.connect(merger,0,0); gR.connect(merger,0,1);
    merger.connect(this.master);
    const mkAn=()=>{ const a=this.ctx.createAnalyser(); a.fftSize=1024; a.smoothingTimeConstant=0.3; return a; };
    const anL=mkAn(), anR=mkAn();
    splitter.connect(anL,0); splitter.connect(anR,1);
    const mk=(id,nm,g,an)=>({id,name:nm,kind:'native',gain:g,muted:false,solo:false,volume:1,
      analyser:an,_mbuf:new Float32Array(an.fftSize),level:0,peak:0,peakT:0});
    return [mk('native-L','L 聲道',gL,anL), mk('native-R','R 聲道',gR,anR)];
  },
  /* 將 MediaElementSourceNode 按聲道分頻，回傳音軌陣列 */
  _splitToChannelTracks(node, sourceName, el, chCount){
    const n=Math.max(1,chCount);
    const labels=n===1?['Mono']:n===2?['L','R']:n===6?['FL','FR','C','LFE','SL','SR']:Array.from({length:n},(_,i)=>`Ch${i+1}`);
    const splitter=this.ctx.createChannelSplitter(n);
    node.connect(splitter);
    return labels.map((lbl,i)=>{
      const g=this.ctx.createGain();
      const an=this.ctx.createAnalyser(); an.fftSize=1024; an.smoothingTimeConstant=0.3;
      splitter.connect(an,i); splitter.connect(g,i); g.connect(this.master);
      return {id:'ext'+(_extTrackIdCounter++),name:lbl,kind:'element',source:sourceName,
        el,gain:g,muted:false,solo:false,volume:1,
        analyser:an,_mbuf:new Float32Array(an.fftSize),level:0,peak:0,peakT:0};
    });
  },
  /* 為音軌掛上電平表 analyser：取「源頭」訊號（與 mute/solo 無關），播放時即有資料，
     讓使用者就算某聲道沒開也能從表頭看出它有沒有內容 */
  attachMeter(tr, sourceNode){
    if(!this.ctx||!sourceNode)return;
    try{
      const an=this.ctx.createAnalyser(); an.fftSize=1024; an.smoothingTimeConstant=0.3;
      sourceNode.connect(an);
      tr.analyser=an; tr._mbuf=new Float32Array(an.fftSize); tr.level=0; tr.peak=0; tr.peakT=0;
    }catch(e){}
  },
  hasMix(){ return this.tracks.some(t=>t.kind==='buffer'||t.kind==='element'); },

  /* --- 虛擬播放（無媒體載入時）--- */
  _vTime: 0, _vStart: null,
  _lastSeekTime: null,
  vTime(){
    if(this.mpvMode) return this._mpvTime;
    if(!video.hasAttribute('src')){
      if(this._vStart!==null) return this._vTime+(performance.now()-this._vStart)/1000*(video.playbackRate||1);
      return this._vTime;
    }
    return video.currentTime||0;
  },
  // FPS-SYNC：播放點的【權威位置】。暫停時回傳已對齊影格的 _lastSeekTime，播放中才回傳原始
  // 時間。所有「靜止」讀數（播放器時碼 tcCur、時間軸播放點、seekBar）都【必須】以此為來源，
  // 不可直接讀 video.currentTime / mpv e.data，否則會與刻度差一格。詳見 FPS_時碼一致性.md。
  // 序列模式後 displayTime/_lastSeekTime 一律為【時間軸時間】。
  displayTime(){
    if(!this.playing && this._lastSeekTime !== null) {
      return this._lastSeekTime;
    }
    return this.tlTime();
  },

  /* ===== 影片序列層（多 clip；見 sequence.js） =====================================
     時間域約定：對外（seek/displayTime/字幕/播放頭/tcCur/seekBar）一律「時間軸時間」；
     播放器內部（video.currentTime / mpv time-pos / _mpvTime / vTime()）一律「來源時間」，
     由本層透過 Seq.toSource/toTimeline 互轉。單一 clip 且 offset=0、in=0 時為恆等映射。
     「間隙」（時間軸上沒有影片的區段）：畫面黑、播放頭以虛擬時鐘（_gapT/_gapStart）續走。 */
  activeClipId:null,
  _gap:false, _gapT:0, _gapStart:null, _seqSwitching:false,
  seqOn(){ return State.clips.length > 0; },
  _activeClip(){ return Seq.byId(this.activeClipId); },
  /* 時間軸權威時間（播放中） */
  tlTime(){
    if(!this.seqOn()) return this.vTime();
    if(this._gap) return this._gapStart !== null
      ? this._gapT + (performance.now() - this._gapStart) / 1000 * (video.playbackRate || 1)
      : this._gapT;
    const c = this._activeClip();
    return c ? Seq.toTimeline(this.vTime(), c) : this.vTime();
  },
  /* 預覽淡出入黑「黑暗程度」0..1：依最上層片段的淡入/淡出與該視訊軌透明度計算（間隙本就是黑，回 0 不另疊） */
  previewFadeDarkness(){
    if(!this.seqOn() || this._gap) return 0;
    const c = this._activeClip(); if(!c) return 0;
    const t = this.tlTime();
    let vis = 1;
    const fi = +c.fadeIn || 0, fo = +c.fadeOut || 0, s = c.offset, e = Seq.clipEnd(c);
    if(fi > 0 && t < s + fi) vis = Math.min(vis, Math.max(0, (t - s) / fi));
    if(fo > 0 && t > e - fo) vis = Math.min(vis, Math.max(0, (e - t) / fo));
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
      if(this._mpvBright){ this._mpvBright = 0; try{ DESK?.mpv?.brightness(0); }catch(e){} }
      return;
    }
    const d = this.previewFadeDarkness();
    if(this.mpvMode){
      const b = Math.round(-100 * d);
      if(b !== this._mpvBright){ this._mpvBright = b; try{ DESK?.mpv?.brightness(b); }catch(e){} }
      if(ov && ov.style.opacity !== '0') ov.style.opacity = '0';
    }else{
      if(ov){ const sv = d.toFixed(3); if(ov.style.opacity !== sv) ov.style.opacity = sv; }
      if(this._mpvBright){ this._mpvBright = 0; try{ DESK?.mpv?.brightness(0); }catch(e){} }
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
    if(!this.ctx) return null;
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
          if(lt!=null){ try{ el.currentTime=clamp(lt,0,el.duration||lt); el.playbackRate=video.playbackRate||1; el.play(); }catch(e){} } }
      }, {once:true});
      const node = this.ctx.createMediaElementSource(el);
      const g = this.ctx.createGain(); node.connect(g); g.connect(this.master);
      tr = { id:'altpri', name:'主影片音訊', kind:'element', el, gain:g, muted:false, solo:false, volume:1, source:'video', _altPrimary:true, _srcHidden:true };
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
    const audible = new Set([src]);
    for(const cl of act) audible.add(cl.audioSrc || (cl.primary ? 'video' : ('clip:' + cl.id)));
    // 原生主影片處於重疊時 → 用獨立 <audio> 播其聲音（native 會被 activeMix 抑制）
    const videoOverlap = audible.has('video') && act.length > 1;
    if(videoOverlap) this._ensureAltPrimaryEl();
    for(const tr of this.tracks){
      if(tr._altPrimary){ tr._srcHidden = !videoOverlap; continue; }
      const s = tr.source || 'video';
      if(s === 'video' || s.startsWith('clip:')) tr._srcHidden = !audible.has(s);
    }
    this.applyGains(); renderAudioTracks();
  },
  _enterGap(t){
    this._gap = true; this._gapT = t;
    this._gapStart = this.playing ? performance.now() : null;
    this.activeClipId = null;
    this.stopElementSources(); this.stopBufferSources();
    if(this.mpvMode){ DESK?.mpv?.pause().catch(()=>{}); emit('mpv:sync'); } // _syncMpvPanel 依 Media._gap 隱藏 mpv
    else if(video.hasAttribute('src')){ try{ video.pause(); }catch(e){} video.style.visibility='hidden'; }
  },
  _leaveGap(){
    this._gap = false; this._gapStart = null;
    if(!this.mpvMode) video.style.visibility = '';
    emit('mpv:sync');
  },
  /* 把播放器對到指定 clip 的來源時間（必要時換檔）。resume=切換後是否續播 */
  async _ensureClip(c, localT, resume){
    if(this._seqSwitching) return;
    if(resume === undefined) resume = this.playing;
    if(this.activeClipId === c.id && !this._gap){ this._playerSeekSource(localT); return; }
    this._seqSwitching = true;
    try{
      this.activeClipId = c.id;
      this._leaveGap();
      this.stopBufferSources(); // buffer 音軌隸屬 primary：換段先停，resume 時依 _srcHidden 決定是否重啟
      const _tl = Seq.toTimeline(localT, c);
      this._applyClipAudio(c, _tl);
      this._lastOverlapKey = Seq.clipsAt(_tl).map(x=>x.id).join('|'); // 與 seqTick 疊合偵測同步，避免切段後多餘重同步
      if(this.mpvMode){
        if(c.path && DESK?.mpv?.loadfile){
          this.stopElementSources();
          if(this._mpvPath !== c.path){ // 不同來源檔才需 loadfile（同檔切割片段只 seek，近乎無縫）
            const r = await DESK.mpv.loadfile(c.path).catch(err=>{ console.error('mpv loadfile', err); return null; });
            if(!r || r.ok === false){ // 無聲失敗要浮上來（先前被吞掉，看起來像「無法播放」）
              setStatus(`mpv 無法載入「${c.name}」`, 'err');
              showToast(`mpv 無法載入影片段「${c.name}」（格式不支援或檔案無法讀取）`);
            }
            if(r && r.duration) Seq.updateSourceDur(c, r.duration);
            this._mpvPath = c.path;
          }
          this._mpvTime = localT;
          DESK.mpv.seek(localT).catch(()=>{});
          // mpv 靜音隨「當前段是否已有元素音軌」同步：有→靜音（元素接管），無→出聲
          //（否則主媒體音軌就緒後 mute(true) 會讓沒有元素音軌的新段完全無聲）
          const _srcKey = c.audioSrc || (c.primary ? 'video' : ('clip:' + c.id));
          const _hasEls = this.tracks.some(tr => (tr.source||'video') === _srcKey && tr.kind === 'element');
          DESK.mpv.mute(_hasEls || State.muted).catch(()=>{});
          emit('mpv:refreshSubs'); // 換 clip 後字幕需以新映射重擠（app.js 會做 offset 位移）
          if(resume){ DESK.mpv.play().catch(()=>{}); this.startElementSources(localT, Seq.toTimeline(localT, c)); }
          else DESK.mpv.pause().catch(()=>{});
        }
      } else {
        const url = c.web && c.web.url;
        if(url && video.src !== url){
          this.stopElementSources();
          video.src = url;
          await new Promise(res=>{ video.onloadedmetadata = ()=>{ video.onloadedmetadata=null; res(); }; if(video.readyState>=1)res(); setTimeout(res, 8000); });
          if(video.duration) Seq.updateSourceDur(c, video.duration);
        }
        try{ video.currentTime = localT; }catch(e){}
        if(resume){
          try{ video.play(); }catch(e){}
          this.startElementSources(localT, Seq.toTimeline(localT, c));
          if(this.tracks.some(t=>t.kind==='buffer'&&!t._srcHidden)) this.startBufferSources(localT);
        }
        else { try{ video.pause(); }catch(e){} }
      }
    } finally { this._seqSwitching = false; }
    emit('render:videoSub');
  },
  _playerSeekSource(s){
    if(this.mpvMode){ this._mpvTime = s; DESK?.mpv?.seek(s).catch(()=>{}); }
    else if(video.hasAttribute('src')){ try{ video.currentTime = s; }catch(e){} }
  },
  /* 播放中的每幀檢查（rafLoop 呼叫）：段尾切換 / 間隙進出 / 序列結尾停止 */
  seqTick(){
    if(!this.seqOn() || !this.playing || this._seqSwitching) return;
    // 恆等模式（單一未修剪 clip 從 0 開始）：完全交給原生 ended / mpv keep-open，行為與舊版一致
    const c0 = State.clips[0];
    if(State.clips.length === 1 && !this._gap && c0.offset === 0 && c0.in === 0
       && Math.abs(c0.out - c0.dur) < 0.05 && this.activeClipId === c0.id) return;
    const t = this.tlTime();
    if(this._gap){
      const hit = Seq.clipAt(t);
      if(hit){ this._ensureClip(hit, Seq.toSource(t, hit), true); return; }
      if(!Seq.nextAfter(t)){ this.pause(); }   // 間隙之後已無內容：停在序列尾
      return;
    }
    const c = this._activeClip();
    if(!c){ const hit = Seq.clipAt(t); if(hit) this._ensureClip(hit, Seq.toSource(t, hit), true); else this._enterGap(t); return; }
    // 疊合試聽：作用中片段集合變化 → 重設可聽音源並同步各自 element/buffer（讓滑入/滑出重疊的片段跟著出/停聲）。
    // okey 相同時不動，避免逐幀 churn；不改變影像的 active clip。
    const okey = Seq.clipsAt(t).map(x=>x.id).join('|');
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
      if(nxt) this._ensureClip(nxt, nxt.in + Math.max(0, end - nxt.offset), true);
      else if(Seq.nextAfter(end)) this._enterGap(end);
      else { this.pause(); this.seek(end); }
    }
  },
  /* video 'ended'（原生模式段尾）：序列還有後續 → 立即推進並回 true（呼叫端不 pause） */
  seqContinueAtEnd(){
    if(!this.seqOn() || !this.playing || this._seqSwitching) return false;
    const c = this._activeClip(); if(!c) return false;
    const end = Seq.clipEnd(c);
    const nxt = Seq.clipAt(end + 0.001);
    if(nxt){ this._ensureClip(nxt, nxt.in + Math.max(0, end - nxt.offset), true); return true; }
    if(Seq.nextAfter(end)){ this._enterGap(end); return true; }
    return false;
  },
  /* 第一支影片載入完成時登錄為 primary clip（reset() 已清空舊序列） */
  _registerPrimary(meta){
    const c = Seq.add({ ...meta, primary: true, audioSrc: 'video', offset: 0 });
    this.activeClipId = c.id;
    // 開啟專案時還原其餘 clip（桌面：以路徑重建；同一來源的切割片段共用資源、只 ingest 一次）
    const pend = State._pendingClips; delete State._pendingClips;
    if(DESK && Array.isArray(pend)){
      const pri = pend.find(x=>x.primary) || pend.find(x=>x.path===c.path);
      if(pri){ c.in = pri.in ?? 0; c.out = Math.min(pri.out ?? c.dur, c.dur); c.offset = pri.offset ?? 0; c.vtrack = pri.vtrack || 0; c.fadeIn = pri.fadeIn || 0; c.fadeOut = pri.fadeOut || 0; Seq.sort(); Seq.recomputeDuration(); }
      (async()=>{
        const made = new Map(); if(c.path) made.set(c.path, c); // 來源路徑 → 首段（提供共用資源）
        for(const pc of pend){
          if(pc === pri || !pc.path) continue;
          const base = made.get(pc.path);
          if(base){ // 同來源的切割片段：直接建 clip 共用資源
            const piece = Seq.add({ name: pc.name || base.name, path: base.path, web: base.web || null,
              dur: base.dur, fps: base.fps || 0, peaks: base.peaks, vtrack: pc.vtrack || 0,
              audioSrc: base.audioSrc || ('clip:' + base.id), fadeIn: pc.fadeIn || 0, fadeOut: pc.fadeOut || 0,
              in: pc.in ?? 0, out: Math.min(pc.out ?? base.dur, base.dur), offset: pc.offset ?? undefined });
            if(pc.offset != null) piece.offset = pc.offset;
          } else {
            const added = await this.addClipDesktop(pc.path, pc).catch(()=>null);
            if(added) made.set(pc.path, added);
          }
        }
        Seq.sort(); Seq.recomputeDuration(); drawTimeline();
      })();
    }
    return c;
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
  /* 加入影片到序列（桌面）：probe 取長度/FPS → 建 clip → 背景 ingest 音軌+波形（沿用每檔快取） */
  async addClipDesktop(p, geo = null){
    setStatus('讀取影片資訊…', 'busy');
    let info = null; try{ info = await DESK.probe(p); }catch(e){ showToast('ffprobe 失敗：' + e.message); setStatus('', ''); return; }
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
    const meta = { name: baseName(p), path: p, dur, fps };
    // 一律附 web url（v4.22）：mpv 模式下 WebCodecs 預覽引擎也能直接解「加入的原生檔」做即時合成
    //（非原生加入檔 demux 會失敗 → WCPreview 視同不可解、讓回 mpv 顯示，無害）
    try{ meta.web = { url: await DESK.fileURL(p) }; }catch(e){}
    const c = Seq.add(meta);
    c.audioSrc = 'clip:' + c.id; // 此來源的音軌識別（切割片段將共用）
    if(geo){ c.in = geo.in ?? 0; c.out = Math.min(geo.out ?? dur, dur); c.offset = geo.offset ?? c.offset; if(geo.vtrack){ c.vtrack = geo.vtrack; ensureVideoTrackCount(geo.vtrack+1); } c.fadeIn = geo.fadeIn || 0; c.fadeOut = geo.fadeOut || 0; Seq.sort(); Seq.recomputeDuration(); }
    drawTimeline();
    emit('history:record', '加入影片：' + c.name);
    setStatus(`已加入序列：${c.name}（背景抽取音訊與波形…）`, 'busy');
    this._clipIngest(c, info);
    return c;
  },
  /* 加入 clip 的背景音訊/波形（模式同 _bgAudioIngest；音軌以 source='clip:<id>' 標記） */
  async _clipIngest(c, info){
    const myVer = this._bgVersion;
    this.ensureCtx();
    // queue:true —— 不可搶佔/殺掉進行中的 ingest（可能正是餵播放器的 streamIngest 背景轉檔
    // 或主媒體音軌抽取，殺掉會讓播放中斷）；改為排入佇列、依序執行
    // needsProxy:true（v4.25）：加入的片段一律備 720p 短 GOP proxy——原檔可能非原生（ProRes/MXF）
    // 或過大（>600MB WebCodecs 讀不進來）；沒有 proxy 時預覽引擎解不了它 →【無法參與疊層合成】
    // 且 mpv 模式會讓回 mpv 顯示（HTML 字幕層被隱藏 →「字幕完全不見」）。proxy 走同一份快取、只轉一次。
    let res; try{ res = await DESK.ingest({ path: c.path, duration: c.dur, needsProxy: true, audio: info?.audio || [], queue: true }); }
    catch(e){ if(this._bgVersion === myVer) setStatus('影片音訊抽取失敗：' + (e?.message||e), ''); return; }
    if(!res || this._bgVersion !== myVer || !Seq.byId(c.id)) return;
    if(res.proxy){
      try{ const u = await DESK.fileURL(res.proxy);
        if(this._bgVersion === myVer && Seq.byId(c.id)){ c.proxyUrl = u; this.seek(this.displayTime()); }
      }catch(e){ console.warn('clip proxy url:', e); }
    }
    const chs = res.channels || [];
    if(chs.length){
      const els = await Promise.all(chs.map(ch =>
        DESK.fileURL(ch.file).then(url => new Promise(r => {
          const el = new Audio(); el.src = url; el.preload = 'auto';
          el.onloadedmetadata = () => r(el); if(el.readyState >= 1) r(el);
          setTimeout(() => r(el), 10000);
        }))
      ));
      if(this._bgVersion !== myVer || !Seq.byId(c.id)){ els.forEach(el => { if(el) try{ el.src=''; }catch(e){} }); return; }
      for(let i = 0; i < chs.length; i++){
        const el = els[i]; if(!el) continue;
        const node = this.ctx.createMediaElementSource(el);
        const g = this.ctx.createGain(); node.connect(g); g.connect(this.master);
        const tr = { id: 'cl-' + c.id + '-' + i, name: c.name + '·' + (chs[i].label || ('軌 ' + (i + 1))),
          kind: 'element', source: 'clip:' + c.id, el, gain: g, muted: false, solo: false, volume: 1, file: chs[i].file };
        this.attachMeter(tr, node); this.tracks.push(tr);
      }
      // 依目前 active clip 重新套用可聽集合（新加入的預設隱藏，除非它正是 active）
      const ac = this._activeClip(); if(ac) this._applyClipAudio(ac);
      // 若正在播這個新段：元素音軌接管 → mpv 靜音並啟動元素
      if(this.mpvMode && ac && (ac.audioSrc || '') === ('clip:' + c.id)){
        DESK.mpv.mute(true).catch(()=>{});
        if(this.playing) this._restartElements();
      }
    }
    if(res.wave){
      try{
        const buf = await fetch(await DESK.fileURL(res.wave)).then(r => r.arrayBuffer());
        if(this._bgVersion === myVer && Seq.byId(c.id)){ c.peaks = Wave.calcFromWav(buf); drawTimeline(); }
      }catch(e){ console.warn('clip wave', e); }
    }
    if(this._bgVersion === myVer) { renderAudioTracks(); setStatus(`影片已加入序列：${c.name}`, 'ok'); }
  },
  /* 加入影片到序列（網頁版）：objectURL + metadata 取長度；小檔另算波形 */
  async addClipWeb(f){
    setStatus('讀取影片資訊…', 'busy');
    const url = URL.createObjectURL(f); this.objectURLs.push(url);
    const dur = await new Promise(r => {
      const test = document.createElement('video');
      test.onloadedmetadata = () => r(test.duration || 0);
      test.onerror = () => r(0);
      test.src = url; setTimeout(() => r(test.duration || 0), 8000);
    });
    if(!dur){ showToast('無法讀取此影片，未加入'); setStatus('', ''); URL.revokeObjectURL(url); return; }
    const c = Seq.add({ name: f.name, web: { url }, dur });
    c.audioSrc = 'clip:' + c.id;
    drawTimeline();
    emit('history:record', '加入影片：' + c.name);
    setStatus(`已加入序列：${c.name}`, 'ok');
    // 音訊（整檔混音一軌，經聲道分離）＋波形：僅小檔（記憶體考量）
    if(f.size <= WAVE_DECODE_MAX){
      try{
        this.ensureCtx();
        const buf = await readFile(f);
        const ab = await this.ctx.decodeAudioData(buf.slice(0));
        if(!Seq.byId(c.id)) return;
        c.peaks = Wave.calcPeaks(ab, -1);
        const el = new Audio(); el.src = url; el.preload = 'auto';
        const node = this.ctx.createMediaElementSource(el);
        const chN = Math.max(1, node.channelCount || 2);
        const trs = this._splitToChannelTracks(node, 'clip:' + c.id, el, chN);
        trs.forEach(tr => { tr.name = c.name + '·' + tr.name; tr.source = 'clip:' + c.id; });
        this.tracks.push(...trs);
        const ac = this._activeClip(); if(ac) this._applyClipAudio(ac);
        renderAudioTracks(); drawTimeline();
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
    Seq.add({
      name: c.name, path: c.path || null, web: c.web || null, dur: c.dur, fps: c.fps || 0,
      peaks: c.peaks, // 共用來源波形（來源時間索引，兩段各取自己的窗）
      audioSrc: c.audioSrc || (c.primary ? 'video' : ('clip:' + c.id)),
      in: cut, out: c.out, offset: t,
    });
    c.out = cut;
    Seq.sort(); Seq.recomputeDuration();
    drawTimeline();
    emit('history:record', '切割影片：' + c.name);
    setStatus(`已於 ${secToEncore(t, State.fps, State.dropFrame)} 切割「${c.name}」`, 'ok');
    return true;
  },
  /* 自序列移除 clip（至少保留一段；音軌僅在無其他片段共用時清理） */
  removeClip(id){
    const c = Seq.byId(id); if(!c) return false;
    if(State.clips.length <= 1){ showToast('序列至少需保留一段（請用「開新專案」或載入取代）'); return false; }
    const src = c.audioSrc || (c.primary ? 'video' : ('clip:' + c.id));
    const stillUsed = State.clips.some(o => o !== c && (o.audioSrc || (o.primary ? 'video' : ('clip:' + o.id))) === src);
    if(!stillUsed && src.startsWith('clip:')){
      this.tracks = this.tracks.filter(tr => {
        if(tr.source === src){
          try{ if(tr.el){ tr.el.pause(); tr.el.src = ''; } }catch(e){}
          try{ tr.gain && tr.gain.disconnect(); }catch(e){}
          return false;
        }
        return true;
      });
    }
    if(this.activeClipId === id) this.activeClipId = null;
    Seq.remove(id); Seq.compact(); // 移除後收斂空的頂部視訊軌
    this.seek(Math.min(this.displayTime(), State.duration || 0)); // 重新解析目前位置（可能已成間隙）
    renderAudioTracks();
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
        this._ensureClip(hit, Seq.toSource(t, hit), true);
        return;
      }
    }
    if(this.mpvMode){
      this.ensureCtx();
      DESK.mpv.play().catch(()=>{});
      this.startElementSources(this._mpvTime, this.tlTime());
      this.playing=true; $('playBtn').textContent='⏸'; video.dispatchEvent(new Event('play')); return;
    }
    if(!video.hasAttribute('src')){
      if(this._vStart!==null) this._vTime=this.vTime();
      this._vStart=performance.now();
      this.ensureCtx();
      if(this.tracks.some(t=>t.kind==='buffer')) this.startBufferSources(this._vTime);
      this.startElementSources(this._vTime);
      this.playing=true; $('playBtn').textContent='⏸'; video.dispatchEvent(new Event('play')); return;
    }
    this.ensureCtx();
    if(this.tracks.some(t=>t.kind==='buffer')) this.startBufferSources(video.currentTime);
    this.startElementSources(video.currentTime, this.tlTime());
    video.play();
    this.playing=true; $('playBtn').textContent='⏸';
    this._lastSeekTime=null;
  },
  pause(){
    this._lastSeekTime = snapTimeToFrame(this.tlTime(), State.fps, State.dropFrame); // FPS-SYNC：snap 到最近格（時間軸域）
    if(this.seqOn() && this._gap){
      // 間隙中暫停：凍結虛擬時鐘
      this._gapT = this._lastSeekTime; this._gapStart = null;
      this.stopElementSources();
      this.playing=false; $('playBtn').textContent='▶'; video.dispatchEvent(new Event('pause')); return;
    }
    const _c = this.seqOn() ? this._activeClip() : null;
    const _ps = _c ? Seq.toSource(this._lastSeekTime, _c) : this._lastSeekTime; // 播放器（來源）時間
    if(this.mpvMode){
      DESK.mpv.pause().catch(()=>{});
      this._mpvTime = _ps;
      DESK.mpv.seek(_ps).catch(()=>{});
      this.stopElementSources();
      this.playing=false; $('playBtn').textContent='▶'; return;
    }
    if(!video.hasAttribute('src')){
      if(this._vStart!==null){ this._vTime+=(performance.now()-this._vStart)/1000*(video.playbackRate||1); this._vStart=null; }
      this.stopBufferSources(); this.stopElementSources();
      this.playing=false; $('playBtn').textContent='▶'; return;
    }
    video.pause(); this.stopBufferSources(); this.stopElementSources(); this.playing=false; $('playBtn').textContent='▶';
    try { video.currentTime = _ps; } catch(e) {}
  },
  toggle(){ this.playing?this.pause():this.play(); },
  seek(t){
    // 有影片時才設上限；無影片時允許任意位置（空專案先排字幕）
    t = State.duration > 0 ? clamp(t, 0, State.duration) : Math.max(0, t);
    t=snapTimeToFrame(t, State.fps, State.dropFrame); // FPS-SYNC：每次 seek 皆精準對齊影格，避免浮點誤差導致 +1 格
    this._lastSeekTime=t; // 時間軸域
    /* 序列：t 為時間軸時間 → 解析所在 clip（間隙→黑畫面；跨 clip→換檔；同 clip→來源時間） */
    if(this.seqOn()){
      $('tcCur').textContent=secToEncore(t,State.fps,State.dropFrame);
      $('seekBar').value=Math.round(t*1000);
      // ext-* 參考音一律跟時間軸
      for(const tr of this.tracks){ if(tr.kind==='element'&&tr.el&&(tr.source||'').startsWith('ext-')){ try{tr.el.currentTime=clamp(t,0,tr.el.duration||t);}catch(e){} } }
      const hit = Seq.clipAt(t);
      if(!hit){
        this._enterGap(t);
        if(this.playing){ this._gapStart = performance.now(); this.startElementSources(t, t); } // ext-* 參考音續播（clip 音軌因 _srcHidden 跳過）
        window.dispatchEvent(new CustomEvent('mpv:seeked',{detail:t})); // 讓播放頭/字幕/備註重繪
        return;
      }
      const local = Seq.toSource(t, hit);
      if(hit.id !== this.activeClipId || this._gap){
        this._ensureClip(hit, local, this.playing);
        window.dispatchEvent(new CustomEvent('mpv:seeked',{detail:t}));
        return;
      }
      if(this.mpvMode){
        this._mpvTime=local;
        DESK.mpv.seek(local).catch(()=>{});
        this._syncSeqElements(t);
        window.dispatchEvent(new CustomEvent('mpv:seeked',{detail:t}));
        return;
      }
      if(video.hasAttribute('src')){
        video.currentTime=local;
        this._syncSeqElements(t);
        if(this.playing && this.tracks.some(tr=>tr.kind==='buffer')){ this.stopBufferSources(); this.startBufferSources(local); }
        return;
      }
    }
    if(this.mpvMode){
      t=clamp(t,0,this._mpvDuration||0);
      this._mpvTime=t;
      DESK.mpv.seek(t).catch(()=>{});
      for(const tr of this.tracks){ if(tr.kind==='element'&&tr.el){ try{tr.el.currentTime=clamp(t,0,tr.el.duration||t);}catch(e){} } }
      $('tcCur').textContent=secToEncore(t,State.fps,State.dropFrame);
      $('seekBar').value=Math.round(t*1000);
      window.dispatchEvent(new CustomEvent('mpv:seeked',{detail:t}));
      return;
    }
    if(!video.hasAttribute('src')){
      this._vTime=Math.max(0,t); if(this._vStart!==null)this._vStart=performance.now();
      $('tcCur').textContent=secToEncore(this._vTime,State.fps,State.dropFrame);
      $('seekBar').value=Math.round(this._vTime*1000);
      for(const tr of this.tracks){ if(tr.kind==='element'&&tr.el){ try{tr.el.currentTime=clamp(t,0,tr.el.duration||t);}catch(e){} } }
      if(this.playing&&this.tracks.some(tr=>tr.kind==='buffer')){ this.stopBufferSources(); this.startBufferSources(t); }
      return;
    }
    video.currentTime=t;
    for(const tr of this.tracks){ if(tr.kind==='element'&&tr.el){ try{tr.el.currentTime=clamp(t,0,tr.el.duration||t);}catch(e){} } }
    if(this.playing && this.tracks.some(tr=>tr.kind==='buffer')){ this.stopBufferSources(); this.startBufferSources(t); }
  },
  // localT=當前 clip 的來源時間；tlT=時間軸時間（ext-* 參考音用；未給則同 localT）。
  // 序列模式：被 _srcHidden 的（其他 clip / 已切換音源）不播，避免多段音訊同時出聲。
  startElementSources(localT, tlT){
    if(tlT === undefined) tlT = this.seqOn() ? this.tlTime() : localT;
    for(const tr of this.tracks){ if(tr.kind!=='element'||!tr.el)continue;
      if(tr._srcHidden){ try{ tr.el.pause(); }catch(e){} continue; }        // 隱藏音軌暫停（換段/離開重疊/主影片非重疊時停聲）
      const s = tr.source || 'video';
      let off;
      if(s.startsWith('ext-')) off = tlT;                                   // 外部參考音：跟時間軸
      else if(this.seqOn()){ const lt = this._srcLocalT(s, tlT); if(lt == null){ try{ tr.el.pause(); }catch(e){} continue; } off = lt; } // 各音源對到自己片段來源時間；無作用片段則停
      else off = localT;
      try{ tr.el.currentTime=clamp(off,0,tr.el.duration||off); tr.el.playbackRate=video.playbackRate||1; tr.el.play(); }catch(e){} }
  },
  // 音源切換／clip 切換後，若正在播放需重啟可聽元素（先前隱藏者已被跳過、未在播）
  _restartElements(){
    if(!this.playing) return;
    const c = this.seqOn() ? this._activeClip() : null;
    const tl = this.tlTime();
    this.startElementSources(c ? Seq.toSource(tl, c) : this.vTime(), tl);
  },
  stopElementSources(){
    for(const tr of this.tracks){ if(tr.kind==='element'&&tr.el){ try{tr.el.pause();}catch(e){} } }
  },
  startBufferSources(offset){
    if(!this.ctx)return;
    // buffer 音軌隸屬 primary（'video'）：疊合時對到 primary 片段【自己的】來源時間（非最上層片段的）
    let off = offset;
    if(this.seqOn()){ const lt = this._srcLocalT('video', this.tlTime()); if(lt != null) off = lt; }
    this.startCtxTime=this.ctx.currentTime; this.startMediaTime=off;
    for(const tr of this.tracks){
      if(tr.kind!=='buffer')continue;
      if(tr._srcHidden)continue; // 序列：無作用中片段的 buffer 音軌不播（buffer 隸屬 primary）
      try{
        const src=this.ctx.createBufferSource(); src.buffer=tr.buffer;
        src.playbackRate.value=video.playbackRate||1;
        src.connect(tr.gain); tr.srcNode=src;
        src.start(0, clamp(off,0,tr.buffer.duration));
      }catch(e){}
    }
  },
  stopBufferSources(){
    for(const tr of this.tracks){
      if(tr.srcNode){
        try{tr.srcNode.stop();}catch(e){}
        try{tr.srcNode.disconnect();}catch(e){} // Fix #7：切斷 AudioGraph 參照，讓 AudioBuffer 盡快被 GC
        tr.srcNode=null;
      }
    }
  },
  scrubAudio(t, duration = 0.15) {
    if(this.playing || State.muted) return;
    // 序列：t 為時間軸時間 → 換算為當前 clip 的來源時間；間隙或未切到該 clip 時無聲
    let localT = t;
    if(this.seqOn()){
      const c = Seq.clipAt(t);
      if(!c || c.id !== this.activeClipId) return;
      localT = Seq.toSource(t, c);
    }

    let hasWebAudioMix = false;
    if(this.ctx){
      for(const tr of this.tracks){
        if(tr._srcHidden) continue;
        if(tr.kind==='buffer'){
          const audible = this.tracks.some(x=>x.solo) ? tr.solo : !tr.muted;
          if(audible) {
            if(tr._scrubNode) { try{tr._scrubNode.stop();}catch(e){} }
            try{
              const src=this.ctx.createBufferSource(); src.buffer=tr.buffer;
              src.playbackRate.value=video.playbackRate||1;
              src.connect(tr.gain);
              src.start(0, clamp(localT,0,tr.buffer.duration), duration);
              tr._scrubNode = src;
              hasWebAudioMix = true;
            }catch(e){}
          }
        }
      }
    }

    const scrubEl = (el, tt) => {
       if(!el.src) return;
       if(!el._scrubEl) {
           el._scrubEl = document.createElement('video');
           el._scrubEl.preload = 'auto';
       }

       const doPlay = () => {
           el._scrubEl.playbackRate = el.playbackRate || 1;
           el._scrubEl.currentTime = clamp(tt, 0, el.duration || tt);
           el._scrubEl.volume = State.muted ? 0 : 1;
           const p = el._scrubEl.play();
           if(p !== undefined) {
             p.then(() => {
               clearTimeout(el._scrubTimer);
               el._scrubTimer = setTimeout(() => { el._scrubEl.pause(); }, 150);
             }).catch((err)=>{
               console.warn("Scrub play error:", err);
             });
           }
       };

       if(el._scrubEl.src !== el.src) {
           el._scrubEl.src = el.src;
           el._scrubEl.onloadedmetadata = () => {
               el._scrubEl.onloadedmetadata = null;
               doPlay();
           };
       } else if (el._scrubEl.readyState >= 1) {
           doPlay();
       } else {
           el._scrubEl.onloadedmetadata = () => {
               el._scrubEl.onloadedmetadata = null;
               doPlay();
           };
       }
    };

    const anySolo = this.tracks.some(tr=>tr.solo&&!tr._srcHidden);
    const activeMix = anySolo
      ? this.tracks.some(tr=>(tr.kind==='buffer'||tr.kind==='element')&&!tr._srcHidden&&tr.solo)
      : this.tracks.some(tr=>(tr.kind==='buffer'||tr.kind==='element')&&!tr._srcHidden&&!tr.muted);
      
    if (!activeMix && (this.activeSource==='video' || this.activeSource===null)) {
       scrubEl(video, localT);
    }
    for(const tr of this.tracks){
      if(tr._srcHidden) continue;
      if(tr.kind==='element' && tr.el){
         const audible = anySolo ? tr.solo : !tr.muted;
         if (audible) scrubEl(tr.el, (tr.source||'').startsWith('ext-') ? t : localT);
      }
    }
  },
  syncMuteState(){
    const mix=this.hasMix();
    video.muted = mix ? true : State.muted;
    this.applyGains();
  },
  applyGains(){
    const anySolo=this.tracks.some(t=>t.solo&&!t._srcHidden);
    // activeMix：solo 模式下看有無 mix 軌被 solo；否則看有無未靜音且未隱藏的 mix 軌
    const activeMix = anySolo
      ? this.tracks.some(t=>(t.kind==='buffer'||t.kind==='element')&&!t._srcHidden&&t.solo)
      : this.tracks.some(t=>(t.kind==='buffer'||t.kind==='element')&&!t._srcHidden&&!t.muted);
    for(const tr of this.tracks){
      if(tr._srcHidden){ if(tr.gain)tr.gain.gain.value=0; continue; }
      const audible = anySolo ? tr.solo : !tr.muted;
      if(tr.gain) tr.gain.gain.value = audible ? tr.volume : 0;
      // 只有當有「真正可聽見」的 mix 音軌時才壓制 native
      if(tr.kind==='native' && activeMix && !(anySolo && tr.solo)) tr.gain.gain.value=0;
    }
    if(this.master) this.master.gain.value = State.muted?0:1;
  },
  getSources(){
    const seen=new Set(); const srcs=[];
    for(const tr of this.tracks.filter(t=>t.kind==='buffer'||t.kind==='native'||t.kind==='element'||t.kind==='nativeTrack')){
      const s=tr.source||'video';
      if(!seen.has(s)){ seen.add(s); srcs.push({id:s, label:s==='video'?'原音':s.replace(/^ext-/,'')}); }
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
  toggleSourceMute(srcId){ const ch=this.sourceChannels(srcId); const m=!(ch.length>0&&ch.every(t=>t.muted)); for(const t of ch)t.muted=m; this.applyGains(); renderAudioTracks(); },
  sourceSolo(srcId){ const ch=this.sourceChannels(srcId); return ch.length>0 && ch.some(t=>t.solo); },
  toggleSourceSolo(srcId){ const ch=this.sourceChannels(srcId); const s=!(ch.length>0&&ch.some(t=>t.solo)); for(const t of ch)t.solo=s; this.applyGains(); renderAudioTracks(); },
  sourceVolume(srcId){ const ch=this.sourceChannels(srcId); return ch.length? ch.reduce((m,t)=>Math.max(m,t.volume==null?1:t.volume),0) : 1; },
  setSourceVolume(srcId,v){ for(const t of this.sourceChannels(srcId))t.volume=v; this.applyGains(); },
  switchSource(id){
    this.activeSource=id;
    for(const tr of this.tracks) tr._srcHidden=(id!==null && (tr.source||'video')!==id);
    this.applyGains();
    this._restartElements(); // 播放中切換音源：新的可聽元素需重新啟動（隱藏者未在播）
    renderAudioTracks();
    // 自動切換波形
    let targetIdx = -1;
    if(id === 'video' || id === null) targetIdx = Wave.sources.findIndex(s => (s.sourceId || 'video') === 'video');
    else targetIdx = Wave.sources.findIndex(s => s.sourceId === id);
    if(targetIdx >= 0) { Wave.selectSource(targetIdx); }
    Wave._renderSrcSel();
  },
  setRate(r){
    if(this.mpvMode){
      video.playbackRate=r; // 保持同步供 startElementSources 使用
      DESK.mpv.rate(r).catch(()=>{});
      for(const tr of this.tracks){ if(tr.kind==='element'&&tr.el)tr.el.playbackRate=r; }
      return;
    }
    // 虛擬模式中更改速度前，先把已累積時間存回 _vTime，重設計時起點，防止位置跳躍
    if(!video.hasAttribute('src') && this._vStart!==null){ this._vTime=this.vTime(); this._vStart=performance.now(); }
    video.playbackRate=r;
    for(const tr of this.tracks){ if(tr.kind==='element'&&tr.el)tr.el.playbackRate=r; }
    if(this.playing&&this.tracks.some(t=>t.kind==='buffer')){ this.stopBufferSources(); this.startBufferSources(this.vTime()); }
  },
  reset(){
    if(this.mpvMode && DESK?.mpv){
      this._stopMpvBoundsFeeder();
      DESK.mpv.quit().catch(()=>{});
      this.mpvMode=false; this._mpvTime=0; this._mpvDuration=0;
      video.style.display='';
      const vs=$('videoSub'); if(vs) vs.style.display='';
    }
    this._bgVersion++; this.activeSource=null; // 讓進行中的 _bgAudioIngest 知道要放棄；清除音源選擇
    this._wcProxyUrl=null; this._wcProxyPath=null; this._wcTakeover=false; // WC 接管狀態隨媒體卸載歸零
    this.pendingChannels=[];
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
    clearMeterStrips(); // Fix #10：清除 mixer 的舊音軌參照，避免 rafLoop 讀取廢棄 analyser
    // 注意：videoSrcNode 需重用，不可 null（同一 video 只能建立一次 source）
    this.objectURLs.forEach(u=>{try{URL.revokeObjectURL(u);}catch(e){}}); this.objectURLs=[];
    this.playing=false; this._vTime=0; this._vStart=null;
    // 影片序列：清空（取代式載入=開新序列；載入完成後由 _registerPrimary 重新登錄第一段）
    Seq.clear(); this.activeClipId=null; this._mpvPath=null; State.selectedClipId=null; resetVideoTracks();
    this._gap=false; this._gapT=0; this._gapStart=null; this._seqSwitching=false;
    video.style.visibility='';
    const pb=$('playBtn'); if(pb) pb.textContent='▶';
    State.duration=0;
    Wave.live=false; Wave.peaks=null; Wave.clearSources();
  }
};
/* 序列切換安全網：rafLoop 於背景分頁/最小化時完全暫停（rAF 凍結），但音訊元素照播——
   若無此網，跨段切換與間隙進出會凍結、音畫脫節。interval 在背景仍以 ~1s 節流執行，
   足以推進切換；前景時 rAF 主導、seqTick 冪等，多呼叫無害。 */
setInterval(()=>{ try{ Media.seqTick(); }catch(e){} }, 500);

const FFMPEG_MAX_BYTES = 1.6e9; // 超過此大小不送 ffmpeg.wasm
const WAVE_DECODE_MAX = 5e8;    // 超過此大小不整檔解碼波形，改即時擷取

function loadScript(src){return new Promise((res,rej)=>{
  if([...document.scripts].some(s=>s.src===src))return res();
  const s=document.createElement('script');s.src=src;s.onload=res;s.onerror=rej;document.head.appendChild(s);
});}
async function canPlayNatively(file,vid){
  const ext=(file.name.split('.').pop()||'').toLowerCase();
  if(['mxf','mts','m2ts','vob','avi','wmv','flv','ts'].includes(ext))return false;
  // 嘗試讀取 metadata
  return await new Promise(res=>{
    const test=document.createElement('video'); const url=URL.createObjectURL(file);
    let done=false; const fin=(v)=>{if(done)return;done=true;URL.revokeObjectURL(url);res(v);};
    test.onloadedmetadata=()=>fin(true);
    test.onerror=()=>fin(false);
    test.src=url; setTimeout(()=>fin(test.readyState>=1),4000);
  });
}

/* ===== 4. 波形 ======================================================== */
const Wave = {
  peaks:null,        // Float32Array [min0,max0,min1,max1,...]
  resolution:100,    // 每秒桶數

  /* --- 多音源選擇（主混音 / 各聲道） --- */
  sources:[],   // [{label, path, peaks}]
  srcIdx:-1,

  registerSources(wavePath, channels, sourceId='video'){
    this.sources=[];
    if(wavePath) this.sources.push({label:'主混音',path:wavePath,peaks:this.peaks, sourceId});
    (channels||[]).forEach((ch,i)=>{
      this.sources.push({label:ch.label||('音軌 '+(i+1)),path:ch.file,peaks:null, sourceId});
    });
    this.srcIdx=0;
    this._renderSrcSel();
  },
  setFromBuffer(ab, sourceId = 'video') {
    this.sources = this.sources.filter(s => s.sourceId !== sourceId);
    const mixPeaks = this.compute(ab, -1);
    this.sources.push({ label: '主混音', path: null, peaks: mixPeaks, sourceId });
    for(let i=0; i<ab.numberOfChannels; i++){
      const chPeaks = this.compute(ab, i);
      this.sources.push({ label: '音軌 ' + (i+1), path: null, peaks: chPeaks, sourceId });
    }
    this.live = false;
    this.peaks = mixPeaks;
    this.srcIdx = this.sources.findIndex(s => s.sourceId === sourceId);
    this._renderSrcSel();
  },
  async selectSource(idx){
    if(idx<0||idx>=this.sources.length) return;
    this.srcIdx=idx;
    const src=this.sources[idx];
    if(src.peaks){ this.peaks=src.peaks; drawTimeline(); return; }
    if(!DESK||!Media.ctx) return;
    const myIdx=idx; // Fix #11：快照索引作取消令牌，防止非同步競爭覆蓋結果
    try{
      const wavUrl = await DESK.fileURL(src.path);
      const res = await fetch(wavUrl);
      const buf = await res.arrayBuffer();
      if(this.srcIdx !== myIdx) return; // 已切換至其他音源，丟棄結果
      const ab=await Media.ctx.decodeAudioData(buf);
      if(this.srcIdx !== myIdx) return; // 解碼期間再次確認
      this.live=false; this.compute(ab);
      src.peaks=this.peaks;
      drawTimeline();
    }catch(e){ console.warn('wave selectSource',e); }
  },
  clearSources(){
    this.sources=[]; this.srcIdx=-1; this._renderSrcSel();
  },
  _renderSrcSel(){
    const sel=$('waveSrcSel'); if(!sel) return;
    const activeSrcId = Media.activeSource || 'video';
    const matching = this.sources.map((s,i) => ({s, i}))
        .filter(x => (x.s.sourceId || 'video') === activeSrcId);
    const show = matching.length > 1;
    sel.innerHTML = matching.map(x => `<option value="${x.i}">${x.s.label}</option>`).join('');
    if(!matching.find(x => x.i === this.srcIdx) && matching.length > 0){
      this.selectSource(matching[0].i);
    }
    sel.value = String(Math.max(0, this.srcIdx));
    sel.style.display = show ? '' : 'none';
  },

  async fromFile(file){
    Media.ensureCtx();
    const buf=await readFile(file);
    const ab=await Media.ctx.decodeAudioData(buf.slice(0));
    if(ab.duration>State.duration){State.duration=ab.duration;emit('duration:known');}
    this.compute(ab); drawTimeline();
    setStatus('波形已產生','ok');
  },
  async fromVideoElement(){ /* fallback：無法解碼時略過 */ },
  live:false,
  initLive(){ // 為長片配置空波形，播放時逐桶填入
    const len=Math.ceil(Math.max(State.duration,1)*this.resolution);
    this.peaks=new Float32Array(len*2); this.live=true;
    this.clearSources();
    drawTimeline();
    $('atHint').textContent='播放以逐步產生波形（或載入音訊檔）';
  },
  captureLive(){ // 由 rafLoop 於播放時呼叫
    if(!this.live||!this.peaks||!Media.analyser)return;
    // 序列：Wave.peaks 屬主媒體來源（來源時間索引）；非主媒體片段播放中或間隙時不得寫入（會污染波形）。
    // 主媒體切割出的片段（audioSrc==='video'）寫入是正確的——同一來源、同一索引域。
    if(Media.seqOn()){ const c=Media._activeClip(); if(Media._gap || !c || (c.audioSrc||(c.primary?'video':''))!=='video') return; }
    const buf=Media._anBuf; Media.analyser.getFloatTimeDomainData(buf);
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
    if(b){ Wave.setFromBuffer(b.buffer, 'video'); drawTimeline(); }
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

export { Media, Wave, FFMPEG_MAX_BYTES, WAVE_DECODE_MAX, loadScript, canPlayNatively };
