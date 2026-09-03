/* ==============================================================================
   SUB Tool — Module Architecture Protection ("src/decode/player.js")
   ==============================================================================
   【維護鐵律】本檔案已納入全專案終極防禦網。
   所有修改必須遵循專案的單向資料流與職責分離原則，嚴禁在此實作越權的 DOM 操作。
============================================================================== */
/* WebCodecs 預覽播放器（階段1：接管原生預覽「畫面」）
   —— <video> 元素照舊負責【聲音＋時鐘】（media.js 完全不動）；本模組每幀（app.js rafLoop）
   依 tlTime → active clip 來源時間，用 WebCodecs 解出對應 frame 畫到 #previewCanvas
   （不透明、蓋在 video 上；previewFade 黑幕與 videoSub 字幕仍疊在 canvas 之上）。
   —— 每個來源檔一個 SourceStream：demux 一次（mp4box）＋串流式解碼（向前餵、淺佇列、
   frame 用完即 close）；seek/後退→從最近 keyframe 重解（decoder.reset+configure）。
   —— 未就緒／失敗／檔案過大 → fallback 畫 <video> 當前畫面（與舊版行為一致、零風險）。
   —— mpv 模式（獨立 OS 視窗）／無序列 → 隱藏 canvas，不參與。
   階段2 起 tick() 將依 Seq.clipsAt(t) 擴充為多軌由下而上合成（opacity/PiP/fade/crossfade）。 */
import { $, video } from '../dom.js';
import { clamp } from '../util.js';
import { State } from '../state.js';
import { Seq } from '../sequence.js';
import { Media } from '../media.js';
import { getPlayerAdapter } from '../media-player-adapter.js';
import { emit } from '../events.js';
import { fadeAlphaAtTimeline, needsComposite, stageBox } from '../image-compositor-engine.js';
import { showToast } from '../ui.js';
import { demuxFile, demuxIndex, SampleReader, MemReader } from './demux.js';
import { keyIndexBefore } from './sample-index.js';
import { imageBoxOnStage, trackFrame } from '../image-compositor-engine.js'; // 預覽／mpv guide／匯出 三路共用的唯一幾何公式

const LOOKAHEAD_US = 400e3;        // 播放時往前解到 t+0.4s 即停（淺佇列、省記憶體）
const MAX_QUEUE   = 10;            // decoder 未輸出佇列上限（decodeQueueSize）
// 整檔 demux 上限——【僅退路用】（moov 不在檔頭／不支援 Range 的來源）。
// 主路 demuxIndex 只讀檔頭建索引、位元組按需抓，記憶體與影片長度脫鉤，不受此限。
const SIZE_CAP = 1500 * 1024 * 1024;

/* 來源解析快取（url → Promise<{config,index,keyIdx,reader}>）：同一來源疊在多條軌時，
   索引與位元組視窗共享、decoder 各自。 */
const _demuxCache = new Map();
function demuxCached(url){
  let p = _demuxCache.get(url);
  if(!p){
    p = (async()=>{
      // 主路：串流式（只讀檔頭 moov 建索引）——長片 proxy 動輒 2–4GB，整檔路吃不下
      try{
        const r = await demuxIndex(url);
        if(!r.index.length) throw new Error('無視訊樣本');
        return { config:r.config, index:r.index, keyIdx:r.keyIdx, reader:new SampleReader(url, r.index, r.maxEnd), streaming:true };
      }catch(e){
        console.warn('[WC] 串流式索引失敗，退回整檔:', e && (e.message||e));
      }
      // 退路：整檔抽出（moov 不在檔頭的外來檔／不支援 Range 的來源）
      const resp = await fetch(url);
      const len = +resp.headers.get('content-length') || 0;
      if(len > SIZE_CAP){ try{ resp.body && resp.body.cancel(); }catch(e){} throw new Error('檔案過大'); }
      const ab = await resp.arrayBuffer();
      if(ab.byteLength > SIZE_CAP) throw new Error('檔案過大');
      const r = await demuxFile(ab);
      if(!r.chunks.length) throw new Error('無視訊樣本');
      const keyIdx = [];
      r.chunks.forEach((c,i)=>{ if(c.type==='key') keyIdx.push(i); });
      if(!keyIdx.length) keyIdx.push(0);
      return { config:r.config, index:r.chunks, keyIdx, reader:new MemReader(r.chunks), streaming:false };
    })();
    p.catch(()=>{ _demuxCache.delete(url); }); // 失敗不留快取（換檔/暫時性錯誤可重試）
    _demuxCache.set(url, p);
  }
  return p;
}

/* 單一來源檔的串流解碼器（每「作用層」一個：同 url 疊多軌時各自獨立游標，demux 共享）。
   frames[] 依呈現序遞增；呈現中的 frame 屬本物件、呼叫端勿 close。 */
class SourceStream {
  constructor(url){ this.url = url; this.state = 'idle'; /* idle|loading|ready|failed */ this._discarded = false; }

  async load(){
    if(this.state !== 'idle') return;
    this.state = 'loading';
    try{
      const { config, index, keyIdx, reader } = await demuxCached(this.url);
      // 預設軟解（穩定優先，720p 軟解 >3000fps；部分環境硬解連續解碼會卡住——見 decoder.js 註記）
      const cfg = Object.assign({ optimizeForLatency: true, hardwareAcceleration: 'prefer-software' }, config);
      const sup = await VideoDecoder.isConfigSupported(cfg);
      if(!sup.supported) throw new Error('VideoDecoder 不支援 ' + config.codec);
      this.cfg = cfg; this.chunks = index; this.keyIdx = keyIdx; this.reader = reader;
      this.frames = []; this.fedIdx = -1; this._flushed = false;
      this.frameDurUs = index[0].duration || 33e3;
      // 串流最早呈現時間：B-frames 編碼（如 nvenc proxy）首幀 cts 常 >0（reorder 延遲）。
      // 呈現目標須夾到此下界，否則 t=0 會被「後退」誤判 → 無限 reseek、decoder 永遠吐不出 frame。
      this.startUs = Math.min(...index.slice(0, 8).map(c => c.timestamp));
      this.dec = new VideoDecoder({
        output: (f)=>{ this.frames.push(f); },   // 只收；清理集中在 request()（避免 close 到呈現中的 frame）
        error: (e)=>{ console.error('[WC] decoder error:', e && (e.message||e)); this.state = 'failed'; },
      });
      this.dec.configure(cfg);
      this.state = 'ready';
    }catch(e){
      const msg = String(e && e.message || e);
      console.warn('[WC] 來源載入失敗（fallback 原樣顯示）:', msg);
      this.state = 'failed';
      // 讓使用者知道為什麼疊加/溶接沒有出現（每個來源只提示一次；匯出不受影響）
      try{ showToast('⚠ 此影片無法即時合成預覽（' + (/過大/.test(msg) ? '檔案過大' : '格式不支援') + '）——預覽顯示原樣，匯出不受影響'); }catch(e2){}
    }
  }

  /* 目標時間所屬 GOP 的關鍵幀 chunk 索引（二分搜尋，規則在 sample-index.js）。 */
  _keyBefore(tUs){ return keyIndexBefore(this.chunks, this.keyIdx, tUs); }

  _reseek(tUs){
    try{ this.dec.reset(); }catch(e){}
    try{ this.dec.configure(this.cfg); }catch(e){ this.state='failed'; return; }
    for(const f of this.frames){ try{ f.close(); }catch(e){} }
    this.frames = []; this._flushed = false;
    this.fedIdx = this._keyBefore(tUs);
    this._fedFrom = this.fedIdx; // 本輪解碼路徑起點（判斷「目標是否早於本輪可達範圍」用）
    this._discarded = false;
  }

  /* 每幀呼叫：推進解碼並回傳「最接近且不晚於 tUs」的 frame（無則 null）。 */
  request(tUs){
    if(this.state === 'idle'){ this.load(); return null; }
    if(this.state !== 'ready') return null;
    const cs = this.chunks, half = this.frameDurUs/2;
    if(tUs < this.startUs) tUs = this.startUs; // 目標早於串流首幀 → 呈現首幀（勿誤判為後退）

    // 跳轉偵測（對長/短 GOP 皆最優）：
    //  ①尚未開始 ②後退：目標早於「本輪已解/可達」最早點（frames[0]，尚無輸出則用本輪起點 chunk）
    //  ③前跳：目標 GOP 的 keyframe 在已餵位置之後 → 跳過中間直接從該 keyframe 解
    //  （若目標在前方但同一 GOP 內＝keyframe 不在前方 → 不 reseek，繼續向前餵即會到；
    //    切勿用「目標 vs 已餵位置」距離判斷——長 GOP 從頭重解時會每幀誤判成再跳轉而無限重來）
    const ki = this._keyBefore(tUs);
    const earliestTs = this.frames.length ? this.frames[0].timestamp : null;
    // 如果目標所需的最早關鍵影格小於本輪餵入起點，代表絕對往回跳轉了 GOP；
    // 否則在同一個 GOP 內，只有當我們已經開始丟棄舊影格，且目標時間早於目前可達的最早影格時，才算是後退。
    const seekBack = (this._fedFrom != null && ki < this._fedFrom) ||
                     (earliestTs != null && tUs < earliestTs - half && this._discarded);
    if(this.fedIdx < 0 || seekBack || ki > this.fedIdx) this._reseek(tUs);

    // 餵：直到「最後已解 frame」涵蓋 t+lookahead、或 decoder 佇列滿、或檔尾、或位元組還沒到
    let starved = false;
    while(this.fedIdx < cs.length && this.dec.decodeQueueSize < MAX_QUEUE){
      const lastOutTs = this.frames.length ? this.frames[this.frames.length-1].timestamp : -1;
      if(lastOutTs >= tUs + LOOKAHEAD_US) break;
      // 串流式：位元組按需抓，尚未到位就這幀先不餵（下一幀再來；期間沿用上一張畫面）
      const data = this.reader.data(this.fedIdx);
      if(!data){ this.reader.ensure(this.fedIdx); starved = true; break; }
      const c = cs[this.fedIdx++];
      try{ this.dec.decode(new EncodedVideoChunk({ type:c.type, timestamp:c.timestamp, duration:c.duration, data })); }
      catch(e){ console.error('[WC] decode err:', e && (e.message||e)); this.state='failed'; return null; }
    }
    if(!starved) this.reader.ensure(this.fedIdx); // 預取下一個視窗（播放時永遠領先游標一格）
    if(this.fedIdx >= cs.length && !this._flushed){ this._flushed = true; this.dec.flush().catch(()=>{}); } // 檔尾 drain

    // 挑 frame：最後一個 ts ≤ t＋半幀；都還沒解到但第一張已很近（<200ms）→ 先用它避免黑幀
    let best = null;
    for(const f of this.frames){ if(f.timestamp <= tUs + half) best = f; else break; }
    // 放寬對首幀的容忍度到 1000ms，避免某些 proxy mp4 的 pts 偏移過大導致完全無法接管
    if(!best && this.frames.length && this.frames[0].timestamp - tUs < 1000e3) best = this.frames[0];
    if(best){
      while(this.frames.length && this.frames[0] !== best){
        const f = this.frames.shift();
        try{ f.close(); }catch(e){}
        this._discarded = true;
      }
    }
    return best;
  }

  dispose(){
    try{ this.dec && this.dec.close(); }catch(e){}
    if(this.frames) for(const f of this.frames){ try{ f.close(); }catch(e){} }
    this.frames = []; this.chunks = null; this.keyIdx = null;
    this.reader = null; // 視窗位元組隨 reader 一起放掉（reader 由 _demuxCache 持有、同來源共用）
    this.state = 'failed';
  }
}

export const WCPreview = {
  enabled: true,
  canvas: null, ctx: null,
  sources: new Map(),           // url → SourceStream
  mode: 'off',                  // off|wc|video|black（診斷/驗證用）
  lastPresentedUs: null, lastSrcKey: null,

  _ensure(){
    if(this.canvas) return true;
    const cv = $('previewCanvas'); if(!cv) return false;
    this.canvas = cv; this.ctx = cv.getContext('2d');
    return true;
  },

  /* 來源 url 解析：加入的片段優先用自己的 proxy（v4.25：原檔可能非原生或過大 → 引擎解不了）；
     mpv 模式主媒體（含切割片段）走主 proxy；原生走 clip.web / video 元素來源。 */
  _clipUrl(c, isTop){
    if(c.proxyUrl) return c.proxyUrl;
    if(Media.mpvMode){
      if(c.path && c.path === Media.webCodecsProxyPath()) return Media.webCodecsProxyUrl();
      if((c.audioSrc || 'video') === 'video' || c.primary) return Media.webCodecsProxyUrl();
      return (c.web && c.web.url) || null; // mpv 模式下加入的檔目前無 proxy/web → 該層不可解
    }
    return (c.web && c.web.url) || (isTop ? (video.currentSrc || video.src) : null) || null;
  },

  /* mpv 畫面接管開關：WC 能呈現時隱藏 mpv 視窗、改用 HTML 字幕；讓回時還原 libass。 */
  _setTakeover(v){
    v = !!v;
    if(Media.webCodecsTakeover() === v) return;
    Media.setWebCodecsTakeover(v);
    // mpv 回來顯示時仍保留透明 DOM 命中層，否則暫停畫面切回 mpv 後字幕又無法直接拖曳。
    const vs = $('videoSub');
    if(vs){
      vs.style.display='';
      vs.classList.toggle('mpv-hit-layer', !v);
    }
    emit('mpv:sync'); // _syncMpvPanel 讓 mpv 視窗讓位／回歸
  },

  _hideCanvas(){ if(this.canvas.style.display !== 'none') this.canvas.style.display = 'none'; },

  /* 目前合成畫面的來源解析度（第一個可畫層＝base 層）。字幕層據此對齊實際畫面區域，
     讓字幕大小/位置不隨各片解析度或畫面比例（16:9／2.39:1…）而跑掉。無合成時回 null。 */
  stageSize(){ return (this._stageW && this._stageH) ? { w:this._stageW, h:this._stageH } : null; },

  /* rafLoop 每幀呼叫（含暫停/捲動）。 */
  tick(){
    if(!this._ensure()) return;
    const mpv = Media.mpvMode;
    // mpv 模式下，即使沒有全域的 proxy URL，也必須放行，
    // 以便後續能夠透過片段的 c.proxyUrl 進行解碼與接管
    const on = this.enabled && Media.seqOn();
    if(!on){
      this._hideCanvas();
      if(this.sources.size && !Media.seqOn()) this.disposeAll(); // 媒體已卸載 → 釋放 demux/解碼資源
      if(mpv) this._setTakeover(false);
      Media.setWebCodecsComposited(false); this.mode = 'off'; return;
    }

    // 尺寸同步（wrap 客座尺寸 × dpr）
    const wrap = this.canvas.parentElement;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if(!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(w*dpr), bh = Math.round(h*dpr);
    const resized = (this.canvas.width !== bw || this.canvas.height !== bh);

    const t = Media.tlTime();
    const acts = Media.inGap() ? [] : Seq.clipsAt(t).filter(c => c.type !== 'image' && State.videoTracks[c.vtrack||0]?.visible !== false);

    // 單一、滿版、無淡變的片段不需要 WebCodecs 合成：讓 mpv 繼續呈現可避免切換影片軌眼睛後，
    // 字幕在 libass 與 DOM 兩個渲染器之間跳成不同視覺大小。多軌／子母畫面／淡變才接管。
    // (註：單純的圖片疊層已改交由 mpv-host 的透明 guide 在原生 MPV 上方顯示，不再強制 WebCodecs 接管，確保流暢度與字體大小不變)
    // 判斷在 compositor-plan.js（純函式、可測）；這裡只依結果決定要不要讓回 mpv。
    const mustComposite = needsComposite(acts, State.videoTracks);
    if(mpv && acts.length && !mustComposite){
      this._hideCanvas(); this._setTakeover(false);
      Media.setWebCodecsComposited(false); this.mode='mpv'; return;
    }

    // 預熱（v4.25）：即將作用（t..t+PRELOAD_S）的片段先開始載入——否則播放進入疊層區時上層還在
    // fetch/demux，那一刻只畫得出下層（要暫停等它載完才出現）＝「播放時不會切到最上層」。
    const PRELOAD_S = 3;
    for(const c of State.clips){
      if(c.type === 'image') continue;
      if(acts.indexOf(c) >= 0) continue;
      if(c.offset > t + PRELOAD_S || Seq.clipEnd(c) <= t) continue;
      if(State.videoTracks[c.vtrack||0]?.visible === false) continue;
      const url = this._clipUrl(c, false); if(!url) continue;
      const key = url + '#' + (c.vtrack||0);
      let ss = this.sources.get(key);
      if(!ss){ ss = new SourceStream(url); this.sources.set(key, ss); }
      if(ss.state === 'idle') ss.load();
    }

    // 第一遍：逐層取得 frame（多軌合成；clipsAt 已由下而上排序）
    const layers = [];
    let topBlocked = null; // mpv：'nourl'＝頂層不可解（讓回 mpv）；'decoding'＝頂層解碼中（保留上一幀）
    for(const c of acts){
      const isTop = (c === acts[acts.length-1]);
      const url = this._clipUrl(c, isTop);
      if(!url){ if(mpv && isTop) topBlocked = 'nourl'; continue; }
      const key = url + '#' + (c.vtrack||0);
      let ss = this.sources.get(key);
      if(!ss){ ss = new SourceStream(url); this.sources.set(key, ss); }
      if(ss.state === 'failed'){ if(mpv && isTop) topBlocked = 'nourl'; continue; } // 不可解（如 mpv 下加入的非原生檔）
      const su = Math.round(clamp(Seq.toSource(t, c), c.in, Math.max(c.in, c.out - 1/120)) * 1e6);
      const f = ss.request(su);
      const vt = State.videoTracks[c.vtrack||0] || {};
      const alpha = (vt.opacity != null ? vt.opacity : 1) * this._clipFadeAlpha(c, t);
      if(f) layers.push({ src:f, sw:f.displayWidth||f.codedWidth, sh:f.displayHeight||f.codedHeight, vt, clip:c, alpha, ts:f.timestamp, url });
      else if(isTop) topBlocked = 'decoding'; // 頂層未就緒（原生與 mpv 同）
    }

    // 【v4.25.2 關鍵】完全沒有任何層可解（來源解不動／仍在載入）→ **隱藏 canvas**，讓底下的
    // <video>（原生）或 mpv 自己顯示畫面。canvas 是不透明的：留著畫黑會整個蓋住 →
    // 症狀＝「看得到字幕、看不到影像」。原生模式字幕層照常可見；mpv 模式才需讓回（字幕改由 libass）。
    // 上層解不動但下層可解時不走這裡：繼續合成可解的層並保持接管，字幕照常（v4.25.1）。
    if(!layers.length && !Media.inGap() && acts.length > 0){
      if(mpv){
        if(topBlocked === 'decoding' && Media.webCodecsTakeover() && !resized){ Media.setWebCodecsComposited(true); return; } // 已接管：保留上一幀防閃
        this._setTakeover(false);
      }
      this._hideCanvas(); Media.setWebCodecsComposited(false); this.mode = 'off'; return;
    }

    // 【必須寫死 'block'，不可用 ''】：.preview-canvas 的 CSS 基礎規則就是 display:none，
    // 清掉 inline 樣式會回退到那條規則 → 畫布永遠不顯示。而 WebCodecs takeover 又會讓 mpv 讓位，
    // 結果兩邊都不見＝黑畫面只剩 HTML 字幕層（v4.33.2 修；此 bug 自 WebCodecs 預覽上線起就在，
    // 因為過去驗證都用 getImageData 讀畫布像素——隱藏的畫布照樣讀得到——所以測不出來）。
    if(this.canvas.style.display !== 'block') this.canvas.style.display = 'block';
    if(resized){ this.canvas.width = bw; this.canvas.height = bh; }
    const ctx = this.ctx;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, bw, bh);
    Media.setWebCodecsComposited(false);

    if(Media.inGap() || !acts.length){ // 間隙／無作用層＝黑（mpv 下接管黑幕，gap 機制本就隱藏 mpv）
      if(mpv) this._setTakeover(true);
      this.mode = 'black'; this.lastPresentedUs = null; return;
    }

    // 第二遍：由下而上繪製（與 ffmpeg:exportVideo 對齊：scale＝大小、posX/posY＝(可用空間)×比例、opacity×fade）
    let base = null, painted = 0, lastTs = null, lastUrl = null;
    const presentedTimelineTimes = [];
    for(const L of layers){
      if(L.alpha <= 0.003){ painted++; continue; } // 全透明：視為已處理（下層已見）
      // 【v4.25.3】畫布＝專案輸出解析度（State.videoWidth/Height，與 ffmpeg:exportVideo 同一張畫布），
      // 不是「第一層的解析度」——否則換到不同比例/解析度的片時整個畫面區跟著變，
      // 字幕大小也跟著跳（症狀＝「字幕在各個影片上大小不同」）。各層再 contain 進這張畫布（比例不同就留黑邊，與匯出一致）。
      if(!base){
        const pw = State.videoWidth || 1920, ph = State.videoHeight || 1080;
        base = stageBox({ canvasW: bw, canvasH: bh, projectW: pw, projectH: ph });
        this._stageW = pw; this._stageH = ph; // 供字幕層對齊畫面區（見 app.js _stageRect）
      }
      /* 幾何一律走 image-geometry.imageBoxOnStage()：軌影格（available-space 定位）
         → 片段方框＝scale×影格 → 素材 contain 進方框 → 方框【中心】對到 (posX,posY)。
         這正是匯出 filtergraph 的模型，兩邊共用同一份實作才談得上三路一致。

         v5.7.0 前這裡是「素材直接 contain 進 base 再乘軌 scale、以 available-space 定位」，
         少了「軌影格」這一層——素材比例與專案畫布不同、且該軌是 PiP 或非置中時，
         預覽與匯出會差好幾十到上百 px（實測 4:3 影片放進 16:9 專案、軌 scale=0.5、
         posX=1 時差 120px）。 */
      const cl = L.clip || {};
      const box = imageBoxOnStage({
        stageW: base.w, stageH: base.h, track: L.vt,
        natW: L.sw, natH: L.sh,
        scale: cl.scale, posX: cl.posX, posY: cl.posY,
      });
      const dw = Math.max(1, Math.round(box.w)), dh = Math.max(1, Math.round(box.h));
      /* 裁進軌影格：匯出是把片段疊到一張【軌影格大小】的透明底上，再把那張底疊到畫布，
         所以超出軌影格的部分會被切掉。預覽不裁的話，PiP 軌上做了偏移／放大的片段
         會溢出影格外，跟成品對不上（實測 4:3 素材在 0.5 PiP 軌上偏移時差 24px 寬、
         54px 高）。 */
      const fr = trackFrame({ stageW: base.w, stageH: base.h,
        scale: L.vt?.scale, posX: L.vt?.posX, posY: L.vt?.posY });
      ctx.save();
      ctx.beginPath();
      ctx.rect(base.x + Math.round(fr.x), base.y + Math.round(fr.y),
               Math.round(fr.w), Math.round(fr.h));
      ctx.clip();
      ctx.globalAlpha = clamp(L.alpha, 0, 1);
      try{
        ctx.drawImage(L.src, base.x + Math.round(box.x), base.y + Math.round(box.y), dw, dh);
        painted++;
        if(L.ts != null){
          lastTs = L.ts; lastUrl = L.url;
          const presentedTimeline=Seq.toTimeline(L.ts/1e6,L.clip);
          if(Number.isFinite(presentedTimeline)) presentedTimelineTimes.push(presentedTimeline);
        }
      }catch(e){}
      ctx.globalAlpha = 1;
      ctx.restore();
    }
    if(painted && lastTs != null){
      this.mode = 'wc'; this.lastPresentedUs = lastTs; this.lastSrcKey = lastUrl; Media.setWebCodecsComposited(true);
      if(mpv) this._setTakeover(true);
      const visibleLayerCount=layers.filter(layer=>layer.alpha>0.003).length;
      if(layers.length===acts.length&&presentedTimelineTimes.length===visibleLayerCount){
        Media.reportWebCodecsPresentation?.(presentedTimelineTimes);
      }
    }
    else if(painted){ // 全部層皆全透明（淡出到底）＝黑畫面，屬正確結果
      this.mode = 'black'; this.lastPresentedUs = null; Media.setWebCodecsComposited(true);
      if(mpv) this._setTakeover(true);
      if(layers.length===acts.length) Media.reportWebCodecsPresentation?.([t]);
    }else{ this.mode = 'black'; this.lastPresentedUs = null; }
  },

  /* 片段淡入/淡出在**時間軸時間** t 的可見度。公式與時間域轉換都只有
     clip-fade.js 一份——這裡、app.js 的圖片疊層、media.js 的 previewFadeDarkness
     原本各自內聯了同一組算式（且對缺 offset 的片段結果不一致）。 */
  _clipFadeAlpha(c, t){ return fadeAlphaAtTimeline(c, t); },

  setEnabled(v){
    this.enabled = !!v;
    if(!v){ this.disposeAll(); if(this.canvas) this.canvas.style.display = 'none'; this.mode = 'off'; }
  },
  disposeAll(){ for(const ss of this.sources.values()) ss.dispose(); this.sources.clear(); },
  stats(){
    const o = { mode:this.mode, lastPresentedUs:this.lastPresentedUs, srcKey:(this.lastSrcKey||'').slice(-42), sources:[] };
    for(const [u, s] of this.sources) o.sources.push({ url:u.slice(-42), state:s.state,
      frames:s.frames ? s.frames.length : 0, fedIdx:s.fedIdx == null ? -1 : s.fedIdx, chunks:s.chunks ? s.chunks.length : 0 });
    return o;
  },
};

