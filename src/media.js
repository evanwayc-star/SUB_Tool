/* SUB Tool — 媒體引擎（影片 + Web Audio 多音軌 + ffmpeg）與波形 */
import { State, DESK, setFps } from './state.js';
import { secToEncore } from './time.js';
import { $, video } from './dom.js';
import { clamp, readFile, b64ToBytes, baseName } from './util.js';
import { setStatus, showToast, openModal, onDurationKnown, renderAudioTracks, detectFpsWeb, refreshMpvSubs } from './app.js';
import { drawTimeline, updatePlayhead } from './timeline.js';

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
    (audio||[]).forEach((a,i)=>{
      const ch=Math.max(1,a.channels||1);
      const base=a.title||a.lang||('音軌 '+(i+1));
      if(ch===1) out.push(base);
      else for(let k=0;k<ch;k++) out.push(base+' · 聲道'+(k+1));
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
      detectFpsWeb(); // 播放時自動偵測 FPS
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
        showToast('檔案較大：波形將於播放時逐步產生（或可另載入音訊檔）');
      }
    }else{
      // 非原生格式：ffmpeg 轉檔給預覽 + 抽音軌
      setStatus('格式非瀏覽器原生，啟動 ffmpeg…','busy');
      await this.transcodeAndExtract(file);
    }
    onDurationKnown();
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
      if(el.duration>State.duration){ State.duration=el.duration; onDurationKnown(); }
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
      const stereoTracks=this._connectStereo();
      if(stereoTracks) this.tracks.push(...stereoTracks);
      this.activeSource='video';
      this.usingWebAudio=false; this.syncMuteState(); renderAudioTracks();
      if(audio.length>0){
        setStatus('產生波形…','busy');
        try{ const wavB64=await DESK.waveAudio(p,dur); const ab=await this.ctx.decodeAudioData(b64ToBytes(wavB64).buffer); if(ab.duration>State.duration)State.duration=ab.duration; Wave.live=false; Wave.compute(ab); drawTimeline(); }
        catch(e){ console.warn('wave',e); Wave.initLive(); }
      }
      setStatus('媒體已載入（桌面模式，原生直讀）','ok'); onDurationKnown(); return;
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
      this.activeSource='video';
      // 混音器立即顯示「準備中」推桿
      this.pendingChannels=this._expandChannels(audio).map(label=>({label,ready:false}));
      this.usingWebAudio=true; this.syncMuteState(); renderAudioTracks();
      Wave.initLive(); onDurationKnown();

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
              const tr={id:'el'+i,name:chs[i].label||('音軌 '+(i+1)),kind:'element',el,gain:g,muted:false,solo:false,volume:1};
              self.attachMeter(tr,node); self.tracks.push(tr);
              if(self.pendingChannels[i]) self.pendingChannels[i].ready=true;
              self.syncMuteState(); renderAudioTracks();
            }
          }
        }finally{ if(self._bgVersion===myVer){ self.pendingChannels=[]; renderAudioTracks(); } }
        if(self._bgVersion!==myVer) return;
        self.syncMuteState(); renderAudioTracks();
        if(r.wave){
          try{ const b64=await DESK.readB64(r.wave); if(b64&&self._bgVersion===myVer){ const ab=await self.ctx.decodeAudioData(b64ToBytes(b64).buffer); if(ab.duration>State.duration)State.duration=ab.duration; Wave.live=false; Wave.compute(ab); Wave.registerSources(r.wave,chs); drawTimeline(); } else if(self._bgVersion===myVer) Wave.initLive(); }
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
        const tr={id:'el'+i,name:chs[i].label||('音軌 '+(i+1)),kind:'element',el,gain:g,muted:false,solo:false,volume:1};
        this.attachMeter(tr,node); this.tracks.push(tr);
      }
    }
    this.activeSource='video';
    this.usingWebAudio=true; this.syncMuteState(); renderAudioTracks();

    if(res.wave){
      try{ const b64=await DESK.readB64(res.wave); if(b64){ const ab=await this.ctx.decodeAudioData(b64ToBytes(b64).buffer); if(ab.duration>State.duration)State.duration=ab.duration; Wave.live=false; Wave.compute(ab); Wave.registerSources(res.wave,chs); drawTimeline(); } else Wave.initLive(); }
      catch(e){ console.warn('wave',e); Wave.initLive(); }
    } else Wave.initLive();

    setStatus('媒體已載入（桌面模式）','ok'); onDurationKnown();
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
      if(el.duration>State.duration){State.duration=el.duration;onDurationKnown();}
      renderAudioTracks();
      if(this.playing) this.startElementSources(this.vTime());
      setStatus('產生波形…','busy');
      try {
        const wavB64 = await DESK.waveAudio(p, el.duration);
        const ab = await this.ctx.decodeAudioData(b64ToBytes(wavB64).buffer);
        const srcObj = { label: name, path: null, peaks: null, sourceId: src };
        Wave.sources.push(srcObj);
        Wave.live=false;
        const oldPeaks = Wave.peaks;
        Wave.compute(ab);
        srcObj.peaks = Wave.peaks;
        Wave.peaks = oldPeaks;
        Wave._renderSrcSel();
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
    this._mpvBoundsTimer=setInterval(send,500); // 安全網：面板拖移/版面位移
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
    try{ res=await DESK.mpv.launch({src:p, bounds:this._mpvRect()}); }
    catch(e){ showToast('mpv 啟動失敗：'+e.message); setStatus('mpv 啟動失敗',''); $('videoSub').style.display=''; video.style.display=''; return; }
    this.mpvMode=true; this._mpvTime=0;
    this._mpvDuration=res.duration||dur||0;
    State.duration=this._mpvDuration;
    if(info?.video?.fps) setFps(info.video.fps);

    this._startMpvBoundsFeeder();
    refreshMpvSubs(); // 把目前字幕餵給 mpv

    // 監聽 mpv 事件（時碼同步 / 播放狀態）
    DESK.mpv.onEvent(e=>{
      if(e.event==='property-change'){
        if(e.name==='time-pos'&&e.data!=null){
          const prev=this._mpvTime; this._mpvTime=e.data;
          // 直接更新 UI（確保暫停時在 mpv 視窗拖拉時我們的時碼也同步）
          $('tcCur').textContent=secToEncore(e.data,State.fps,State.dropFrame);
          $('seekBar').value=Math.round(e.data*1000);
          updatePlayhead();
          if(Math.abs(e.data-prev)>0.5) window.dispatchEvent(new CustomEvent('mpv:seeked',{detail:e.data}));
        }
        if(e.name==='pause'){
          const paused=!!e.data;
          if(paused&&this.playing){ this.stopElementSources(); this.playing=false; $('playBtn').textContent='▶'; }
          else if(!paused&&!this.playing){ this.ensureCtx(); this.startElementSources(this._mpvTime); this.playing=true; $('playBtn').textContent='⏸'; }
        }
        if(e.name==='duration'&&typeof e.data==='number'&&e.data>0){
          this._mpvDuration=e.data; State.duration=e.data; onDurationKnown();
        }
      }
      if(e.event==='end-file'&&this.mpvMode){ this.stopElementSources(); this.playing=false; $('playBtn').textContent='▶'; }
    });

    // 混音器立即顯示「準備中」推桿（聲道數在 ffprobe 階段就已知）
    this.pendingChannels = this._expandChannels(audio).map(label=>({label,ready:false}));
    renderAudioTracks();
    setStatus('媒體已載入（mpv 秒開，嵌入播放）','ok');
    onDurationKnown();
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
    try{ res=await DESK.ingest({path:p,duration:dur,needsProxy:false,audio}); }
    catch(e){ if(this._bgVersion!==myVer) return; console.warn('bg audio ingest:',e); this.pendingChannels=[]; renderAudioTracks(); setStatus('音軌抽取失敗：'+e.message,''); return; }
    if(this._bgVersion!==myVer) return; // 使用者已換另一個檔，丟棄結果

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
      if(this._bgVersion!==myVer) return;
      for(let i=0;i<chs.length;i++){
        const el=els[i]; if(!el) continue;
        const node=this.ctx.createMediaElementSource(el);
        const g=this.ctx.createGain(); node.connect(g); g.connect(this.master);
        const tr={id:'el'+i,name:chs[i].label||('音軌 '+(i+1)),kind:'element',el,gain:g,muted:false,solo:false,volume:1};
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
        const b64=await DESK.readB64(res.wave);
        if(b64&&this._bgVersion===myVer){
          const ab=await this.ctx.decodeAudioData(b64ToBytes(b64).buffer);
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
        await loadScript('https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js');
        const { createFFmpeg } = window.FFmpeg;
        const ff=createFFmpeg({ log:false, corePath:'https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js' });
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
    try{
      const ff=await this.loadFFmpeg();
      this.ensureCtx();
      const data=new Uint8Array(await readFile(file));
      ff.FS('writeFile','in.media',data);
      // 移除既有 buffer 音軌、保留 native gain（但靜音）
      for(let i=0;i<count;i++){
        setStatus(`抽取音軌 ${i+1}/${count}…`,'busy');
        const outName=`a${i}.wav`;
        await ff.run('-i','in.media','-map',`0:a:${i}`,'-ac','2','-ar','48000',outName);
        const wav=ff.FS('readFile',outName);
        const ab=await this.ctx.decodeAudioData(wav.buffer.slice(0));
        const g=this.ctx.createGain(); g.connect(this.master);
        this.tracks.push({id:'ex'+i,name:'抽取音軌 '+(i+1),kind:'buffer',buffer:ab,gain:g,muted:false,solo:false,volume:1});
        try{ ff.FS('unlink',outName); }catch(e){}
      }
      try{ ff.FS('unlink','in.media'); }catch(e){}
      this.usingWebAudio=true; this.syncMuteState();
      setStatus('多音軌抽取完成','ok'); renderAudioTracks();
      if(this.playing){ this.stopBufferSources(); this.startBufferSources(video.currentTime); }
    }catch(e){ setStatus('音軌抽取失敗','');console.error(e); }
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
      const aCount=(probe.match(/Stream #\d+:\d+.*: Audio:/g)||[]).length||1;
      setStatus('轉檔預覽影片中…','busy');
      await ff.run('-i','in.media','-c:v','libx264','-preset','ultrafast','-crf','26','-an','-movflags','+faststart','prev.mp4');
      const mp4=ff.FS('readFile','prev.mp4');
      const url=URL.createObjectURL(new Blob([mp4.buffer],{type:'video/mp4'})); this.objectURLs.push(url);
      video.src=url; video.muted=true;
      await new Promise(res=>{video.onloadedmetadata=res;});
      $('noVideo').style.display='none';
      State.duration=video.duration||0;
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
      onDurationKnown();
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
      return {id:'ext'+Date.now()+i,name:lbl,kind:'element',source:sourceName,
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
  vTime(){
    if(this.mpvMode) return this._mpvTime;
    if(!video.src){
      if(this._vStart!==null) return this._vTime+(performance.now()-this._vStart)/1000*(video.playbackRate||1);
      return this._vTime;
    }
    return video.currentTime||0;
  },

  /* --- 播放控制 --- */
  play(){
    if(this.mpvMode){
      this.ensureCtx();
      DESK.mpv.play().catch(()=>{});
      this.startElementSources(this._mpvTime);
      this.playing=true; $('playBtn').textContent='⏸'; return;
    }
    if(!video.src){
      if(this._vStart!==null) this._vTime=this.vTime();
      this._vStart=performance.now();
      this.ensureCtx();
      if(this.tracks.some(t=>t.kind==='buffer')) this.startBufferSources(this._vTime);
      this.startElementSources(this._vTime);
      this.playing=true; $('playBtn').textContent='⏸'; return;
    }
    this.ensureCtx();
    if(this.tracks.some(t=>t.kind==='buffer')) this.startBufferSources(video.currentTime);
    this.startElementSources(video.currentTime);
    video.play();
    this.playing=true; $('playBtn').textContent='⏸';
  },
  pause(){
    if(this.mpvMode){
      DESK.mpv.pause().catch(()=>{});
      this.stopElementSources();
      this.playing=false; $('playBtn').textContent='▶'; return;
    }
    if(!video.src){
      if(this._vStart!==null){ this._vTime+=(performance.now()-this._vStart)/1000*(video.playbackRate||1); this._vStart=null; }
      this.stopBufferSources(); this.stopElementSources();
      this.playing=false; $('playBtn').textContent='▶'; return;
    }
    video.pause(); this.stopBufferSources(); this.stopElementSources(); this.playing=false; $('playBtn').textContent='▶';
  },
  toggle(){ this.playing?this.pause():this.play(); },
  seek(t){
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
    if(!video.src){
      this._vTime=Math.max(0,t); if(this._vStart!==null)this._vStart=performance.now();
      $('tcCur').textContent=secToEncore(this._vTime,State.fps,State.dropFrame);
      $('seekBar').value=Math.round(this._vTime*1000);
      for(const tr of this.tracks){ if(tr.kind==='element'&&tr.el){ try{tr.el.currentTime=clamp(t,0,tr.el.duration||t);}catch(e){} } }
      if(this.playing&&this.tracks.some(tr=>tr.kind==='buffer')){ this.stopBufferSources(); this.startBufferSources(t); }
      return;
    }
    t=clamp(t,0,State.duration||0); video.currentTime=t;
    for(const tr of this.tracks){ if(tr.kind==='element'&&tr.el){ try{tr.el.currentTime=clamp(t,0,tr.el.duration||t);}catch(e){} } }
    if(this.playing && this.tracks.some(t=>t.kind==='buffer')){ this.stopBufferSources(); this.startBufferSources(t); }
  },
  startElementSources(offset){
    for(const tr of this.tracks){ if(tr.kind!=='element'||!tr.el)continue;
      try{ tr.el.currentTime=clamp(offset,0,tr.el.duration||offset); tr.el.playbackRate=video.playbackRate||1; tr.el.play(); }catch(e){} }
  },
  stopElementSources(){
    for(const tr of this.tracks){ if(tr.kind==='element'&&tr.el){ try{tr.el.pause();}catch(e){} } }
  },
  startBufferSources(offset){
    if(!this.ctx)return;
    this.startCtxTime=this.ctx.currentTime; this.startMediaTime=offset;
    for(const tr of this.tracks){
      if(tr.kind!=='buffer')continue;
      try{
        const src=this.ctx.createBufferSource(); src.buffer=tr.buffer;
        src.playbackRate.value=video.playbackRate||1;
        src.connect(tr.gain); tr.srcNode=src;
        src.start(0, clamp(offset,0,tr.buffer.duration));
      }catch(e){}
    }
  },
  stopBufferSources(){
    for(const tr of this.tracks){ if(tr.srcNode){try{tr.srcNode.stop();}catch(e){} tr.srcNode=null;} }
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
      if(!seen.has(s)){ seen.add(s); srcs.push({id:s, label:s==='video'?'影片音軌（原音）':s.replace(/^ext-/,'')}); }
    }
    return srcs;
  },
  switchSource(id){
    this.activeSource=id;
    for(const tr of this.tracks) tr._srcHidden=(id!==null && (tr.source||'video')!==id);
    this.applyGains();
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
    if(!video.src && this._vStart!==null){ this._vTime=this.vTime(); this._vStart=performance.now(); }
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
    this.pendingChannels=[];
    if(this._ingestDoneHandler){ window.removeEventListener('desk:ingest-done',this._ingestDoneHandler); this._ingestDoneHandler=null; }
    this.stopBufferSources(); this.stopElementSources();
    for(const tr of this.tracks){ if(tr.el){try{tr.el.src='';}catch(e){}} }
    this.tracks=[]; this.usingWebAudio=false;
    // 注意：videoSrcNode 需重用，不可 null（同一 video 只能建立一次 source）
    this.objectURLs.forEach(u=>{try{URL.revokeObjectURL(u);}catch(e){}}); this.objectURLs=[];
    this.playing=false; this._vTime=0; this._vStart=null;
    const pb=$('playBtn'); if(pb) pb.textContent='▶';
    State.duration=0;
    Wave.live=false; Wave.peaks=null; Wave.clearSources();
  }
};
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
  async selectSource(idx){
    if(idx<0||idx>=this.sources.length) return;
    this.srcIdx=idx;
    const src=this.sources[idx];
    if(src.peaks){ this.peaks=src.peaks; drawTimeline(); return; }
    if(!DESK||!Media.ctx) return;
    try{
      const b64=await DESK.readB64(src.path);
      if(!b64) return;
      const ab=await Media.ctx.decodeAudioData(b64ToBytes(b64).buffer);
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
    if(ab.duration>State.duration){State.duration=ab.duration;onDurationKnown();}
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
    const b=Media.tracks.find(t=>t.kind==='buffer'); if(b){this.compute(b.buffer);drawTimeline();}
  },
  compute(ab){
    const res=this.resolution;
    const len=Math.ceil(ab.duration*res);
    const peaks=new Float32Array(len*2);
    const ch0=ab.getChannelData(0);
    const ch1=ab.numberOfChannels>1?ab.getChannelData(1):null;
    const spb=ab.sampleRate/res; // samples per bucket
    for(let i=0;i<len;i++){
      const s0=Math.floor(i*spb), s1=Math.min(ch0.length,Math.floor((i+1)*spb));
      let mn=0,mx=0;
      for(let j=s0;j<s1;j++){
        let v=ch0[j]; if(ch1)v=(v+ch1[j])*0.5;
        if(v<mn)mn=v; if(v>mx)mx=v;
      }
      peaks[i*2]=mn; peaks[i*2+1]=mx;
    }
    this.peaks=peaks;
  }
};

export { Media, Wave, FFMPEG_MAX_BYTES, WAVE_DECODE_MAX, loadScript, canPlayNatively };
