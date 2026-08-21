/* ==============================================================================
   SUB Tool — 母素材載入路徑（"src/loaders/media-loader.js"）
   ==============================================================================
   【這支是 Media 實作的一部分，不是獨立模組。】

   它收下的 `ctx` 就是 Media 本身（media.js 把每個進入點再包成方法：
   `loadDesktopMedia(p){ return loadDesktopMedia(this, p, …) }`），並直接讀寫
   Media 的 17 個私有欄位、共 40 處。那在這裡是**允許的**——它屬於 Media 的
   【內部接縫】，與 media.js 同一個實作範圍。

   但這件事以前從來沒有被寫下來，而是靠 eslint 圍籬的一個漏洞默許的：
   `mediaPrivateFence` 比對的是「物件叫不叫 Media」，而這裡叫 `ctx`，
   於是 40 處存取從頭到尾沒有被檢查過。現在明確列進
   `eslint.config.mjs` 的 MEDIA_INTERNAL_FILES，並記在這裡。

   ── 三條載入路徑（順序即優先序，前面命中就 return）──
     (mpv) 非原生格式或多音軌且 mpv 可用 → _loadViaMpv，秒開、背景抽音軌
     (A)   純原生 + 單一 mono/stereo     → 直讀 <video>，完全不碰 ffmpeg
     (B)   其餘                          → streamIngest 邊轉邊播（mpv 不可用時的退路）

   **加新東西前先問：這是 Media 的實作，還是可以獨立測的規則？**
   後者請放到自己的模組（例如 channel-layout.js／media-intake-session.js），
   不要繼續加大這支對 Media 內部的相依。
============================================================================== */
import { $, video } from '../dom.js';
import { State, DESK, setFps } from '../state.js';
import { setStatus, showToast } from '../ui.js';
import { AudioPipeline } from '../audio-pipeline.js';
import { AudioEngine } from '../audio-engine.js';
import { emit } from '../events.js';
import { escapeHTML, baseName } from '../util.js';
import { activateHtml5Transport, activateMpvTransport, getPlayerAdapter } from '../media-player-adapter.js';
import { Wave, WAVE_DECODE_MAX, probeAudioChannelDescriptors, detectFpsWeb, probeImageSize } from '../media.js'; 
import { sourceChannelLabels } from '../channel-layout.js';
import { secToEncore } from '../time.js';
import { Seq } from '../sequence.js';
import { waitForOwnedMediaMetadata } from '../media-intake-session.js';
export async function loadDesktopMedia(ctx, p, projectRestore=null){
    ctx._resetForFirstVideo(projectRestore ? { keepVideoTracks: true } : {});
    const intake=ctx._intakeSession.begin(p);
    const owns=()=>ctx._intakeSession.owns(intake);
    State.mediaPath=p; State.mediaName=baseName(p);
    const st=await DESK.stat(p);
    if(!owns()) return;
    State.mediaSize=st.size||0;
    setStatus('讀取媒體資訊…','busy');
    let info=null;
    try{ info=await DESK.probe(p); }
    catch(e){ if(!owns()) return; showToast('ffprobe 失敗：'+e.message); }
    if(!owns()) return;
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
    ctx.ensureCtx();

    // (mpv) 非原生格式或多音軌且偵測到 mpv：秒開，背景抽音軌
    const previewRuntime = typeof window !== 'undefined' && window.subtool
      ? activateMpvTransport(window.subtool)
      : getPlayerAdapter();
    if((!canNative || audio.length>1) && previewRuntime.isAvailable){
      const mpvInfo=await previewRuntime.detect();
      if(!owns()) return;
      if(mpvInfo && mpvInfo.available){ await ctx._loadViaMpv(p,info,projectRestore,intake); return; }
    }

    // (A) 純原生 + 單一 mono/stereo 音訊：完全不需 ffmpeg，直讀最快。
    // 3 聲道以上即使只有一個 audio stream 也必須走逐聲道 ingest，否則 5.1 / 8ch
    // 只會留下瀏覽器可監聽的 L/R，無法配線或正確輸出所有專案 bus。
    const audioChannelCount=probeAudioChannelDescriptors(audio).length;
    if(canNative && audio.length<=1 && audioChannelCount<=2){
      const mediaUrl=await DESK.fileURL(p);
      if(!owns()) return;
      video.src=mediaUrl; await activateHtml5Transport(video);
      const metadata=await waitForOwnedMediaMetadata(video,{owns,timeoutMs:10000});
      if(!owns()||metadata==='cancelled') return;
      if(metadata!=='ready'){ showToast('無法讀取影片 metadata，未載入'); setStatus('讀取失敗',''); return; }
      State.duration=video.duration||dur||0;
      const primary=ctx._registerPrimary({ name:State.mediaName, path:p, web:{url:video.src}, dur:State.duration||0, fps:info?.video?.fps||0 },projectRestore);
      const ownsPrimary=()=>owns()&&ctx._sourceStillReferenced(primary);
      AudioPipeline.registerSource(primary,probeAudioChannelDescriptors(audio),audio.length?0:0);
      const stereoTracks=ctx._connectStereo('video',primary);
      if(stereoTracks) ctx.tracks.push(...stereoTracks);
      ctx.activeSource='video';
      ctx.usingWebAudio=false; ctx.syncMuteState(); emit('media:audioTracks');
      // 原生播放繼續直讀；聲道 cache 在背景準備，供專案路由匯出使用。
      ctx.cacheNativeRoutingAudio(primary,p,State.duration||dur,audio);
      if(audio.length>0){
        setStatus('正在分析音訊與產生波形…','busy');
        let wavPath=null;
        try{
          wavPath=await DESK.waveAudio(p,dur);
          if(!ownsPrimary()){ try{ DESK.cleanupAudio(wavPath); }catch(e){} return; }
          const wavUrl=await DESK.fileURL(wavPath);
          if(!ownsPrimary()){ try{ DESK.cleanupAudio(wavPath); }catch(e){} return; }
          const res=await fetch(wavUrl);
          const buf=await res.arrayBuffer();
          if(!ownsPrimary()){ try{ DESK.cleanupAudio(wavPath); }catch(e){} return; }
          const ab=await AudioEngine.decodeAudioData(buf); 
          if(!ownsPrimary()){ try{ DESK.cleanupAudio(wavPath); }catch(e){} return; }
          try { DESK.cleanupAudio(wavPath); } catch(e) {}
          if(ab.duration>State.duration)State.duration=ab.duration; 
          Wave.setSourceBuffer(primary,ab); emit('media:timeline');
        }
        catch(e){ if(ownsPrimary()){ console.warn('wave',e); Wave.initLive(); } }
      }
      if(!ownsPrimary()) return;
      setStatus('媒體已載入（原生直讀，免轉 Proxy）','ok'); emit('duration:known'); return;
    }

    // (B) 非原生（需 proxy）或原生多音軌
    // 非原生且有 streamIngest：邊轉邊播（幾秒內可開始播放）
    if(!canNative && DESK.streamIngest){
      setStatus('正在背景轉檔 Proxy 與分析音訊（即將可播放）…','busy');
      let res;
      try{ res=await DESK.streamIngest({ path:p, duration:dur, audio }); }
      catch(e){ if(!owns()) return; console.error(e); showToast('讀取失敗：'+e.message); setStatus('讀取失敗',''); return; }
      if(!owns()){
        if(res?.streamLeaseId&&DESK.releaseStream) Promise.resolve(DESK.releaseStream(res.streamLeaseId)).catch(()=>{});
        return;
      }
      ctx._setActiveStreamLease(res.streamLeaseId);
      if(res.cached) setStatus('使用既有快取，秒開…','ok');

      video.src=res.streamUrl; await activateHtml5Transport(video);
      const metadata=await waitForOwnedMediaMetadata(video,{owns,timeoutMs:15000});
      if(!owns()||metadata==='cancelled') return;
      if(metadata!=='ready'){
        ctx._setActiveStreamLease(null);
        showToast('轉檔串流無法讀取影片 metadata，未載入'); setStatus('讀取失敗',''); return;
      }
      State.duration=video.duration||dur||0;
      video.muted=true;
      const primary=ctx._registerPrimary({ name:State.mediaName, path:p, web:{url:res.streamUrl}, dur:State.duration||0, fps:info?.video?.fps||0 },projectRestore);
      const ownsPrimary=()=>owns()&&ctx._sourceStillReferenced(primary);
      AudioPipeline.registerSource(primary,probeAudioChannelDescriptors(audio));
      ctx.activeSource='video';
      // 混音器立即顯示「準備中」推桿
      ctx.pendingChannels=ctx._expandChannels(audio).map(label=>({label,ready:false}));
      ctx.usingWebAudio=true; ctx.syncMuteState(); emit('media:audioTracks');
      Wave.initLive(); emit('duration:known');

      // 載入音軌+波形的共用函式（快取立即執行，非快取等轉檔完成後執行）
      /* `ctx` 就是 Media；不要寫成 `const self=this`。loadDesktopMedia 是被當
         【普通函式】呼叫的（media.js：`return loadDesktopMedia(this, p, …)`），
         ESM 一律嚴格模式，所以函式內的 `this` 是 undefined——底下每一個
         `self.*` 都會丟 TypeError，而呼叫端是
         `void loadTracksAndWave(res).catch(e => console.warn(…))`，錯誤被吞掉。
         這條路只在 mpv 偵測失敗時才走到（見上方 mpv 分支會先 return），
         所以沒有人回報，也沒有測試碰得到。 */
      const self=ctx;
      const loadTracksAndWave=async(r)=>{
        if(!ownsPrimary()) return;
        const chs=r.channels||[];
        let els=[];
        try{
          if(chs.length){
            setStatus(`載入 ${chs.length} 條聲道…`,'busy');
            els=await self._intakeSession.materializeAudioElements(chs,{
              owns:ownsPrimary,
              resolveFileURL:file=>DESK.fileURL(file),
              createAudio:()=>new Audio(),
            });
            if(!els) return;
            const descriptors=AudioPipeline.registerSource(primary,chs,chs.length);
            for(let i=0;i<chs.length;i++){
              const el=els[i]; if(!el) continue;
              const node=AudioEngine.createMediaElementSource(el);
              const g=AudioEngine.createGain(); node.connect(g); AudioEngine.connectToMaster(g);
              const tr=self.bindTrackRouting({id:'el'+i,name:chs[i].label||('音軌 '+(i+1)),kind:'element',source:'video',el,gain:g,muted:!!primary?.muted,solo:false,volume:1,file:chs[i].file},primary,descriptors[i],i);
              self.attachMeter(tr,node); self.tracks.push(tr);
              if(self.pendingChannels[i]) self.pendingChannels[i].ready=true;
              self.syncMuteState(); emit('media:audioTracks');
            }
          }
        }finally{ if(ownsPrimary()){ self.pendingChannels=[]; emit('media:audioTracks'); } }
        if(!ownsPrimary()) return;
        self.syncMuteState(); emit('media:audioTracks');
        if(r.wave){
          try{
            const u=await DESK.fileURL(r.wave);
            if(!ownsPrimary()) return;
            const fb=await fetch(u);
            const buf=await fb.arrayBuffer();
            if(ownsPrimary()){
              const pk=Wave.calcFromWav(buf);
              if(pk){ Wave.setSourceMixPeaks(primary,pk,{mixPath:r.wave,channels:chs}); emit('media:timeline'); }
              else Wave.initLive();
            }
          }catch(e2){ console.warn('wave',e2); if(ownsPrimary()) Wave.initLive(); }
        }
        if(ownsPrimary()) setStatus('媒體已載入','ok');
      };

      if(res.cached){
        void loadTracksAndWave(res).catch(error=>{ if(ownsPrimary()) console.warn('stream ingest tracks:',error); });
      } else {
        setStatus('視訊播放就緒，正在背景轉檔 Proxy 與分析音訊…','busy');
        // 只在「本次轉檔工作」完成時才載入；用 ingestJobId 過濾其他工作的完成事件，並在換檔時移除
        const handler=(ev)=>{
          if(!ownsPrimary()){ window.removeEventListener('desk:ingest-done',handler); self._ingestDoneHandler=null; return; }
          if(res.ingestJobId && ev?.detail?.jobId && ev.detail.jobId!==res.ingestJobId) return; // 非本次轉檔，忽略
          window.removeEventListener('desk:ingest-done',handler); self._ingestDoneHandler=null;
          void loadTracksAndWave(res).catch(error=>{ if(ownsPrimary()) console.warn('stream ingest tracks:',error); });
        };
        ctx._ingestDoneHandler=handler;
        window.addEventListener('desk:ingest-done', handler);
      }
      return;
    }

    // (B2) 原生多音軌 或 無 streamIngest 時的原有路徑
    setStatus(canNative?'正在分析音訊與抽取多聲道…':'正在轉檔 Proxy 與分析音訊（大檔需數分鐘）…','busy');
    let res;
    try{ res=await DESK.ingest({ path:p, duration:dur, needsProxy:!canNative, audio }); }
    catch(e){ if(!owns()) return; console.error(e); showToast('讀取/轉檔失敗：'+e.message); setStatus('讀取/轉檔失敗',''); return; }
    if(!owns()) return;
    if(res.cached) setStatus('使用既有快取，秒開…','ok');

    const mediaUrl=await DESK.fileURL(res.proxy||p);
    if(!owns()) return;
    video.src=mediaUrl; await activateHtml5Transport(video);
    const metadata=await waitForOwnedMediaMetadata(video,{owns,timeoutMs:10000});
    if(!owns()||metadata==='cancelled') return;
    if(metadata!=='ready'){ showToast('轉檔結果無法讀取影片 metadata，未載入'); setStatus('讀取失敗',''); return; }
    State.duration=video.duration||dur||0;
    video.muted=true;
    const primary=ctx._registerPrimary({ name:State.mediaName, path:p, web:{url:video.src}, dur:State.duration||0, fps:info?.video?.fps||0 },projectRestore);
    const ownsPrimary=()=>owns()&&ctx._sourceStillReferenced(primary);
    AudioPipeline.registerSource(primary,probeAudioChannelDescriptors(audio));

    const chs=res.channels||[];
    let els=[];
    if(chs.length){
      setStatus(`載入 ${chs.length} 條聲道…`,'busy');
      els=await ctx._intakeSession.materializeAudioElements(chs,{
        owns:ownsPrimary,
        resolveFileURL:file=>DESK.fileURL(file),
        createAudio:()=>new Audio(),
      });
      if(!els||!ownsPrimary()) return;
    }
    const descriptors=AudioPipeline.registerSource(primary,chs,chs.length);
    if(chs.length){
      for(let i=0;i<chs.length;i++){
        const el=els[i]; if(!el) continue;
        const node=AudioEngine.createMediaElementSource(el);
        const g=AudioEngine.createGain(); node.connect(g); AudioEngine.connectToMaster(g);
        const tr=ctx.bindTrackRouting({id:'el'+i,name:chs[i].label||('音軌 '+(i+1)),kind:'element',source:'video',el,gain:g,muted:!!primary?.muted,solo:false,volume:1,file:chs[i].file},primary,descriptors[i],i);
        ctx.attachMeter(tr,node); ctx.tracks.push(tr);
      }
    }
    ctx.activeSource='video';
    ctx.usingWebAudio=true; ctx.syncMuteState(); emit('media:audioTracks');

    if(res.wave){
      // FIX: 改用 fileURL+fetch+computeFromWav，與 streamIngest 路徑一致（避免 readB64 塞爆 IPC + decodeAudioData 耗盡記憶體）
      try{
        const waveUrl=await DESK.fileURL(res.wave);
        if(!ownsPrimary()) return;
        const buf=await fetch(waveUrl).then(r=>r.arrayBuffer());
        if(!ownsPrimary()) return;
        const pk=Wave.calcFromWav(buf);
        if(pk) Wave.setSourceMixPeaks(primary,pk,{mixPath:res.wave,channels:chs});
        else Wave.initLive();
        emit('media:timeline');
      }
      catch(e){ if(ownsPrimary()){ console.warn('wave',e); Wave.initLive(); } }
    } else if(ownsPrimary()) Wave.initLive();

    if(!ownsPrimary()) return;
    setStatus('媒體已載入（桌面模式）','ok'); emit('duration:known');
  }

export function _expandChannels(ctx, audio){ return sourceChannelLabels(audio); }

export async function _loadViaMpv(ctx, p, info, projectRestore=null, intakeToken=null){
    const owns=()=>!intakeToken||ctx._intakeSession.owns(intakeToken);
    const adapter = typeof window !== 'undefined' && window.subtool
      ? activateMpvTransport(window.subtool)
      : getPlayerAdapter();
    const dur=info?.duration||0;
    const audio=info?.audio||[];
    setStatus('啟動 mpv（秒開）…','busy');
    let res;
    try{
      const launch=()=>adapter.enterMpv({
        src:p,
        bounds:ctx._mpvRect(),
        audio,
        boundsElement:$('videoWrap'),
        readBounds:()=>ctx._mpvRect(),
      });
      const launchAndOwn=async()=>{
        let launched;
        try{ launched=await launch(); }
        catch(error){
          // 主程序可能在建立 native window/process 後才於 pipe 連線失敗。
          // 錯誤路徑也必須在 exclusive lane 內清理，不能只清成功但失權的回傳。
          await adapter.enterHtml5(video);
          throw error;
        }
        if(!owns()){
          // launch 已跨進主程序並改寫共享 mpv 狀態；單純丟棄回傳值不夠，
          // 必須在下一個 queued launch 開始前把舊 native runtime 收掉。
          await adapter.enterHtml5(video);
          return null;
        }
        return launched;
      };
      res=intakeToken
        ? await ctx._intakeSession.runExclusive(intakeToken,launchAndOwn)
        : await launchAndOwn();
    }
    catch(e){
      if(!owns()) return;
      await adapter.enterHtml5(video);
      showToast('mpv 啟動失敗：'+e.message); setStatus('mpv 啟動失敗','');
      $('videoSub').style.display=''; video.style.display=''; return;
    }
    if(!res||!owns()) return;
    // 影片區清空為黑底，mpv 覆蓋視窗會貼合在此。必須等 ownership 確認後才改 UI，
    // 否則較舊的 launch 晚到會把新載入的 HTML video 藏起來。
    $('noVideo').style.display='none';
    video.style.display='none';
    $('videoSub').style.display=''; // 字幕由 HTML DOM (#videoSub) 統一渲染
    ctx._mpvTime=0; ctx._mpvPath=p;
    // mpv 顯示時仍要建立透明的 DOM 字幕命中層，才能直接拖曳字幕。
    emit('render:videoSub');
    ctx._mpvDuration=res.duration||dur||0;
    State.duration=ctx._mpvDuration;
    if(info?.video?.fps) setFps(info.video.fps);
    const primary=ctx._registerPrimary({ name:State.mediaName, path:p, dur:ctx._mpvDuration||0, fps:info?.video?.fps||0 },projectRestore);
    AudioPipeline.registerSource(primary,probeAudioChannelDescriptors(audio));

    emit('mpv:refreshSubs'); // 把目前字幕餵給 mpv

    // 監聽 mpv 事件（時碼同步 / 播放狀態）。序列模式：e.data 為【來源時間】，顯示前換算為時間軸時間。
    adapter.onEvent(e=>{
      if(!owns()) return;
      if(e.event==='property-change'){
        if(e.name==='time-pos'&&e.data!=null){
          // 純音訊時間軸與影片間隙都刻意讓 mpv 停住；這時殘留的 time-pos
          // 不能覆寫虛擬播放頭，否則最後一段影片刪除後會跳回舊影片時間。
          if(ctx._seqSwitching || ctx._gap || ctx.audioOnlyTimeline()) return;
          const prev=ctx._mpvTime; ctx._mpvTime=e.data;
          const _ac=ctx.seqOn()?ctx._activeClip():null;
          // FPS-SYNC（詳見 FPS_時碼一致性.md）：暫停時讓播放器時碼與時間軸播放點同源同格：
          //  - 若 mpv 回報只是 seek 後的 settling 抖動（與權威 _lastSeekTime 差 <1.5 格），
          //    維持 _lastSeekTime，避免用未對齊的原始時間經 secToEncore 進位多一格、
          //    也避免拉偏權威值而破壞逐格精度；
          //  - 若是大幅變動（例如在 mpv 視窗內拖拉），才吸附到最近格並更新 _lastSeekTime。
          // 播放中則用原始時間平滑前進。（比較與顯示一律在時間軸域）
          const driverTimeline=ctx._transport.timelineTime({sourceTime:e.data,clip:_ac});
          const t=ctx._transport.observeSourceTime(e.data,{
            clip:_ac,playing:ctx.playing,fps:State.fps,dropFrame:State.dropFrame,
          });
          $('tcCur').textContent=secToEncore(t,State.fps,State.dropFrame);
          $('seekBar').value=Math.round(t*1000);
          emit('media:playhead');
          if(Math.abs(e.data-prev)>0.5) window.dispatchEvent(new CustomEvent('mpv:seeked',{detail:driverTimeline}));
        }
        if(e.name==='pause'){
          const paused=!!e.data;
          if(ctx._seqSwitching) return; // loadfile 過程中的暫停屬內部操作
          // 進入影片間隙／純音訊模式時，是本層主動暫停 mpv 來保持黑畫面；
          // 不可把這個內部事件當成使用者停止整個時間軸，否則外部音訊會被停掉。
          if(ctx._gap || ctx.audioOnlyTimeline()) return;
          if(paused&&ctx.playing){
            // 序列：keep-open 在段尾自動暫停 → 若後面還有內容，交給推進而非停止
            const c=ctx.seqOn()?ctx._activeClip():null;
            if(c && Math.abs(ctx.vTime()-c.out)<0.3 && (Seq.clipAt(Seq.clipEnd(c)+0.001)||Seq.nextAfter(Seq.clipEnd(c))||State.duration>Seq.clipEnd(c)+0.001)){
              ctx._mpvTime=c.out; ctx.seqContinueAtEnd(); return;
            }
            ctx.stopElementSources(); ctx.playing=false; $('playBtn').textContent='▶'; video.dispatchEvent(new Event('pause'));
          }
          else if(!paused&&!ctx.playing){ ctx.ensureCtx(); ctx.startElementSources(ctx._mpvTime, ctx.tlTime()); ctx.playing=true; $('playBtn').textContent='⏸'; video.dispatchEvent(new Event('play')); }
        }
        if(e.name==='duration'&&typeof e.data==='number'&&e.data>0){
          ctx._mpvDuration=e.data;
          if(ctx.seqOn()){ const c=ctx._activeClip(); if(c) Seq.updateSourceDur(c, e.data); }
          else if(!ctx.audioOnlyTimeline()){ State.duration=e.data; emit('duration:known'); }
        }
      }
      if(e.event==='end-file'&&ctx.mpvMode){
        if(ctx._seqSwitching) return; // loadfile 造成的舊檔 end-file
        // _enterGap()/純音訊模式已主動停住 mpv；忽略其後到達的舊檔結束事件，
        // 讓虛擬播放頭與外部音訊繼續走到專案最右端。
        if(ctx._gap || ctx.audioOnlyTimeline()) return;
        if(e.reason==='error'){ // mpv 播放失敗（解碼/濾鏡錯誤）：浮上來，不當成段尾推進
          ctx.stopElementSources(); ctx.playing=false; $('playBtn').textContent='▶';
          setStatus('mpv 播放失敗（解碼或濾鏡錯誤）','err'); showToast('mpv 播放此影片段失敗');
          return;
        }
        // 序列：來源播到底（out===dur）→ 若還有後續，推進而非停止
        const c=ctx.seqOn()?ctx._activeClip():null;
        if(c && ctx.playing){ ctx._mpvTime=c.out; if(ctx.seqContinueAtEnd()) return; }
        ctx.stopElementSources(); ctx.playing=false; $('playBtn').textContent='▶';
      }
    });

    // 混音器立即顯示「準備中」推桿（聲道數在 ffprobe 階段就已知）
    ctx.pendingChannels = ctx._expandChannels(audio).map(label=>({label,ready:false}));
    emit('media:audioTracks');
    emit('duration:known');
    Wave.initLive();

    // 背景抽取音軌（不阻塞播放；完成後 element tracks 接管音訊，mpv 靜音）
    if(audio.length>0){
      setStatus('mpv 預覽就緒，正在轉檔 Proxy 與分析音訊…','busy');
      ctx.ensureCtx();
      ctx._bgAudioIngest(p,audio,dur,primary);
    } else {
      setStatus('媒體已載入（mpv 秒開，嵌入播放）','ok');
    }
  }

export async function loadVideoFile(ctx, file, projectRestore=null){
    ctx._resetForFirstVideo(projectRestore ? { keepVideoTracks: true } : {});
    const intake=ctx._intakeSession.begin(file);
    const owns=()=>ctx._intakeSession.owns(intake);
    ctx.audioPanelNotice=null;
    emit('media:audioTracks');
    State.mediaName=file.name; State.mediaSize=file.size;
    const url=URL.createObjectURL(file); ctx.objectURLs.push(url);
    video.src=url; await activateHtml5Transport(video);
    const native = await canPlayNatively(file, video);
    if(!owns()) return;
    ctx.audioPanelNotice=webAudioCapabilityNotice(file,{nativePreview:native});
    emit('media:audioTracks');
    $('noVideo').style.display='none';
    if(native){
      const metadata=await waitForOwnedMediaMetadata(video,{owns,timeoutMs:10000});
      if(!owns()||metadata==='cancelled') return;
      if(metadata!=='ready'){ showToast('無法讀取此影片，未載入'); setStatus('讀取失敗',''); return; }
      State.duration=video.duration||0;
      State.videoWidth=video.videoWidth||0;
      State.videoHeight=video.videoHeight||0;
      const primary=ctx._registerPrimary({ name:file.name, web:{url}, dur:State.duration||0 },projectRestore); // 登錄為序列第一段
      const ownsPrimary=()=>owns()&&ctx._sourceStillReferenced(primary);
      detectFpsWeb(ownsPrimary); // 播放時自動偵測 FPS；刪除／換掉來源後晚到 callback 必須失效
      // 用 Web Audio 接管原生音訊，L / R 分頻顯示於混音器
      AudioPipeline.registerSource(primary,[],2);
      const stereoTracks=ctx._connectStereo('video',primary);
      if(stereoTracks){
        stereoTracks.forEach(t => t.file = file); // 保存 File 參考供匯出
        ctx.tracks.push(...stereoTracks);
        ctx.activeSource='video';
        ctx.usingWebAudio=false;
        setStatus('已載入原生影音','ok');
      }
      // 探測是否有多音軌
      await ctx.probeAndMaybeExtract(file,{owns:ownsPrimary});
      if(!ownsPrimary()) return;
      // 產生波形：小檔整檔解碼；大檔（如長片）改用播放時即時擷取，避免記憶體爆掉
      if(file.size <= WAVE_DECODE_MAX){
        Wave.fromFile(file,primary,{owns:ownsPrimary}).catch(()=>{ if(ownsPrimary()) Wave.initLive(); });
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
      await ctx.transcodeAndExtract(file,projectRestore,{owns});
    }
    if(owns()) emit('duration:known');
  }

export const FFMPEG_MAX_BYTES = 1.6e9; // 超過此大小不送 ffmpeg.wasm

export const WEB_LARGE_NATIVE_AUDIO_NOTICE =
  '網頁版無法完整讀取此大型檔案的多音軌，目前僅提供 Stereo 預覽；請使用 macOS 或 Windows 桌面版載入全部 Mono 聲道。';
export const WEB_LARGE_UNSUPPORTED_MEDIA_NOTICE =
  '網頁版無法載入此大型非原生格式的影音與多音軌；請使用 macOS 或 Windows 桌面版載入全部 Mono 聲道。';

export function webAudioCapabilityNotice(file,{nativePreview=false}={}){
  if(Number(file?.size)<=FFMPEG_MAX_BYTES) return null;
  return nativePreview ? WEB_LARGE_NATIVE_AUDIO_NOTICE : WEB_LARGE_UNSUPPORTED_MEDIA_NOTICE;
}

export async function canPlayNatively(file,vid){
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
