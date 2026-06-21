/* SUB Tool — 媒體引擎（影片 + Web Audio 多音軌 + ffmpeg）與波形 */
import { State, DESK, setFps } from './state.js';
import { secToEncore } from './time.js';
import { $, video } from './dom.js';
import { clamp, readFile, b64ToBytes, baseName } from './util.js';
import { setStatus, showToast, openModal, onDurationKnown, renderAudioTracks, detectFpsWeb } from './app.js';
import { drawTimeline } from './timeline.js';

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
      // 用 Web Audio 接管原生音訊，方便音量/波形
      this.ensureCtx();
      const g=this.connectNativeAudio();
      if(g){
        this.tracks.push({id:'native',name:'內建音訊 (原生)',kind:'native',gain:g,muted:false,solo:false,volume:1});
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
    setStatus('解碼音軌中…','busy');
    try{
      const buf=await readFile(file);
      const ab=await this.ctx.decodeAudioData(buf.slice(0));
      const g=this.ctx.createGain(); g.connect(this.master);
      this.tracks.push({id:'a'+Date.now(),name:file.name,kind:'buffer',buffer:ab,gain:g,muted:false,solo:false,volume:1,srcNode:null});
      this.usingWebAudio=true;
      // 切換為 Web Audio 主控：原生影片音訊靜音由 video.muted 控制
      this.syncMuteState();
      if(ab.duration>State.duration){ State.duration=ab.duration; onDurationKnown(); }
      setStatus('音軌已加入','ok');
      renderAudioTracks();
      if(this.playing){ this.stopBufferSources(); this.startBufferSources(video.currentTime); }
    }catch(e){ setStatus('音軌解碼失敗：'+e.message,''); showToast('無法解碼此音訊檔'); }
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

    // (A) 純原生 + 單一/無音軌：完全不需 ffmpeg，直讀最快
    if(canNative && audio.length<=1){
      video.src=await DESK.fileURL(p);
      await new Promise(r=>{video.onloadedmetadata=r; if(video.readyState>=1)r(); setTimeout(r,10000);});
      State.duration=video.duration||dur||0;
      const g=this.connectNativeAudio();
      if(g){ const tr={id:'native',name:'內建音訊 (原生)'+(audio[0]&&audio[0].lang?(' '+audio[0].lang):''),kind:'native',gain:g,muted:false,solo:false,volume:1}; this.attachMeter(tr,this.videoSrcNode); this.tracks.push(tr); }
      this.usingWebAudio=false; this.syncMuteState(); renderAudioTracks();
      if(audio.length>0){
        setStatus('產生波形…','busy');
        try{ const wavB64=await DESK.waveAudio(p,dur); const ab=await this.ctx.decodeAudioData(b64ToBytes(wavB64).buffer); if(ab.duration>State.duration)State.duration=ab.duration; Wave.live=false; Wave.compute(ab); drawTimeline(); }
        catch(e){ console.warn('wave',e); Wave.initLive(); }
      }
      setStatus('媒體已載入（桌面模式，原生直讀）','ok'); onDurationKnown(); return;
    }

    // (B) 非原生（需 proxy）或原生多音軌：單次讀取 ingest（整檔只讀一遍 → proxy + 每聲道 + 波形）
    setStatus(canNative?'抽取多音軌（單次讀取）…':'讀取並轉檔中（單次讀取，大檔需數分鐘）…','busy');
    let res;
    try{ res=await DESK.ingest({ path:p, duration:dur, needsProxy:!canNative, audio }); }
    catch(e){ console.error(e); showToast('讀取/轉檔失敗：'+e.message); setStatus('讀取/轉檔失敗',''); return; }
    if(res.cached) setStatus('使用既有快取，秒開…','ok');

    video.src=await DESK.fileURL(res.proxy||p);
    await new Promise(r=>{video.onloadedmetadata=r; if(video.readyState>=1)r(); setTimeout(r,10000);});
    State.duration=video.duration||dur||0;
    video.muted=true;

    // 每聲道 → 各自一個 <audio> element 音軌 + 電平表 analyser
    const chs=res.channels||[];
    for(let i=0;i<chs.length;i++){
      setStatus(`載入聲道 ${i+1}/${chs.length}…`,'busy');
      const el=new Audio(); el.src=await DESK.fileURL(chs[i].file); el.preload='auto';
      await new Promise(r=>{el.onloadedmetadata=r; if(el.readyState>=1)r(); setTimeout(r,10000);});
      const node=this.ctx.createMediaElementSource(el);
      const g=this.ctx.createGain(); node.connect(g); g.connect(this.master);
      const tr={id:'el'+i,name:chs[i].label||('音軌 '+(i+1)),kind:'element',el,gain:g,muted:false,solo:false,volume:1};
      this.attachMeter(tr,node);
      this.tracks.push(tr);
    }
    this.usingWebAudio=true; this.syncMuteState(); renderAudioTracks();

    // 波形：用 ingest 產生的 8kHz 混音 wav
    if(res.wave){
      try{ const b64=await DESK.readB64(res.wave); if(b64){ const ab=await this.ctx.decodeAudioData(b64ToBytes(b64).buffer); if(ab.duration>State.duration)State.duration=ab.duration; Wave.live=false; Wave.compute(ab); drawTimeline(); } else Wave.initLive(); }
      catch(e){ console.warn('wave',e); Wave.initLive(); }
    } else Wave.initLive();

    setStatus('媒體已載入（桌面模式）','ok'); onDurationKnown();
  },
  async addAudioFileDesktop(p){
    this.ensureCtx();
    const el=new Audio(); el.src=await DESK.fileURL(p); el.preload='auto';
    await new Promise(r=>{el.onloadedmetadata=r; if(el.readyState>=1)r(); setTimeout(r,10000);});
    const node=this.ctx.createMediaElementSource(el);
    const g=this.ctx.createGain(); node.connect(g); g.connect(this.master);
    const tr={id:'el'+Date.now(),name:baseName(p),kind:'element',el,gain:g,muted:false,solo:false,volume:1};
    this.attachMeter(tr,node); this.tracks.push(tr);
    this.usingWebAudio=true; this.syncMuteState();
    if(el.duration>State.duration){State.duration=el.duration;onDurationKnown();}
    renderAudioTracks();
    if(this.playing) this.startElementSources(video.currentTime);
    setStatus('音軌已加入','ok');
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
    if(!video.src){
      if(this._vStart!==null) return this._vTime+(performance.now()-this._vStart)/1000*(video.playbackRate||1);
      return this._vTime;
    }
    return video.currentTime||0;
  },

  /* --- 播放控制 --- */
  play(){
    if(!video.src){
      // 已在虛擬播放中：先把已累積的時間存回 _vTime，再重設計時起點
      if(this._vStart!==null) this._vTime=this.vTime();
      this._vStart=performance.now(); this.playing=true; $('playBtn').textContent='⏸'; return;
    }
    this.ensureCtx();
    if(this.tracks.some(t=>t.kind==='buffer')) this.startBufferSources(video.currentTime);
    this.startElementSources(video.currentTime);
    video.play();
    this.playing=true; $('playBtn').textContent='⏸';
  },
  pause(){
    if(!video.src){
      if(this._vStart!==null){ this._vTime+=(performance.now()-this._vStart)/1000*(video.playbackRate||1); this._vStart=null; }
      this.playing=false; $('playBtn').textContent='▶'; return;
    }
    video.pause(); this.stopBufferSources(); this.stopElementSources(); this.playing=false; $('playBtn').textContent='▶';
  },
  toggle(){ this.playing?this.pause():this.play(); },
  seek(t){
    if(!video.src){
      this._vTime=Math.max(0,t); if(this._vStart!==null)this._vStart=performance.now();
      $('tcCur').textContent=secToEncore(this._vTime,State.fps);
      $('seekBar').value=Math.round(this._vTime*1000);
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
    // 有混音(buffer/element)音軌時，原生影片音訊靜音，改由 Web Audio 播放
    const mix=this.hasMix();
    video.muted = mix ? true : State.muted;
    const nat=this.tracks.find(t=>t.kind==='native');
    if(nat&&nat.gain) nat.gain.gain.value = mix?0:(nat.muted?0:nat.volume);
    this.applyGains();
  },
  applyGains(){
    const anySolo=this.tracks.some(t=>t.solo);
    const mix=this.hasMix();
    for(const tr of this.tracks){
      const audible = anySolo ? tr.solo : !tr.muted;
      if(tr.gain) tr.gain.gain.value = audible ? tr.volume : 0;
      if(tr.kind==='native' && mix && !(anySolo && tr.solo)) tr.gain.gain.value=0;
    }
    if(this.master) this.master.gain.value = State.muted?0:1;
  },
  setRate(r){
    // 虛擬模式中更改速度前，先把已累積時間存回 _vTime，重設計時起點，防止位置跳躍
    if(!video.src && this._vStart!==null){ this._vTime=this.vTime(); this._vStart=performance.now(); }
    video.playbackRate=r;
    for(const tr of this.tracks){ if(tr.kind==='element'&&tr.el)tr.el.playbackRate=r; }
    if(this.playing&&this.tracks.some(t=>t.kind==='buffer')){ this.stopBufferSources(); this.startBufferSources(video.currentTime); }
  },
  reset(){
    this.stopBufferSources(); this.stopElementSources();
    for(const tr of this.tracks){ if(tr.el){try{tr.el.src='';}catch(e){}} }
    this.tracks=[]; this.usingWebAudio=false;
    // 注意：videoSrcNode 需重用，不可 null（同一 video 只能建立一次 source）
    this.objectURLs.forEach(u=>{try{URL.revokeObjectURL(u);}catch(e){}}); this.objectURLs=[];
    State.duration=0;
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
    this.peaks=new Float32Array(len*2); this.live=true; drawTimeline();
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
