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
import { Seq } from '../sequence.js';
import { Media } from '../media.js';
import { demuxFile } from './demux.js';

const LOOKAHEAD_US = 400e3;        // 播放時往前解到 t+0.4s 即停（淺佇列、省記憶體）
const MAX_QUEUE   = 10;            // decoder 未輸出佇列上限（decodeQueueSize）
const SIZE_CAP = 600 * 1024 * 1024; // 階段1 整檔 demux 上限；更大檔 fallback video（proxy 階段解除）

/* 單一來源檔的 demux＋串流解碼器。frames[] 依呈現序遞增；呈現中的 frame 屬本物件、呼叫端勿 close。 */
class SourceStream {
  constructor(url){ this.url = url; this.state = 'idle'; /* idle|loading|ready|failed */ }

  async load(){
    if(this.state !== 'idle') return;
    this.state = 'loading';
    try{
      const resp = await fetch(this.url);
      const len = +resp.headers.get('content-length') || 0;
      if(len > SIZE_CAP){ try{ resp.body && resp.body.cancel(); }catch(e){} throw new Error('檔案過大（階段1 上限 600MB）'); }
      const ab = await resp.arrayBuffer();
      if(ab.byteLength > SIZE_CAP) throw new Error('檔案過大');
      const { config, chunks } = await demuxFile(ab);
      if(!chunks.length) throw new Error('無視訊樣本');
      // 預設軟解（穩定優先，720p 軟解 >3000fps；部分環境硬解連續解碼會卡住——見 decoder.js 註記）
      const cfg = Object.assign({ optimizeForLatency: true, hardwareAcceleration: 'prefer-software' }, config);
      const sup = await VideoDecoder.isConfigSupported(cfg);
      if(!sup.supported) throw new Error('VideoDecoder 不支援 ' + config.codec);
      this.cfg = cfg; this.chunks = chunks;
      this.frames = []; this.fedIdx = -1; this._flushed = false;
      this.frameDurUs = chunks[0].duration || 33e3;
      this.dec = new VideoDecoder({
        output: (f)=>{ this.frames.push(f); },   // 只收；清理集中在 request()（避免 close 到呈現中的 frame）
        error: (e)=>{ console.error('[WC] decoder error:', e && (e.message||e)); this.state = 'failed'; },
      });
      this.dec.configure(cfg);
      this.state = 'ready';
    }catch(e){
      console.warn('[WC] 來源載入失敗（fallback <video>）:', String(e && e.message || e));
      this.state = 'failed';
    }
  }

  _keyBefore(tUs){
    let k = 0;
    for(let i=0;i<this.chunks.length;i++){
      const c = this.chunks[i];
      if(c.type==='key' && c.timestamp<=tUs) k = i;
      else if(c.timestamp > tUs) break;
    }
    return k;
  }

  _reseek(tUs){
    try{ this.dec.reset(); }catch(e){}
    try{ this.dec.configure(this.cfg); }catch(e){ this.state='failed'; return; }
    for(const f of this.frames){ try{ f.close(); }catch(e){} }
    this.frames = []; this._flushed = false;
    this.fedIdx = this._keyBefore(tUs);
    this._fedFrom = this.fedIdx; // 本輪解碼路徑起點（判斷「目標是否早於本輪可達範圍」用）
  }

  /* 每幀呼叫：推進解碼並回傳「最接近且不晚於 tUs」的 frame（無則 null）。 */
  request(tUs){
    if(this.state === 'idle'){ this.load(); return null; }
    if(this.state !== 'ready') return null;
    const cs = this.chunks, half = this.frameDurUs/2;

    // 跳轉偵測（對長/短 GOP 皆最優）：
    //  ①尚未開始 ②後退：目標早於「本輪已解/可達」最早點（frames[0]，尚無輸出則用本輪起點 chunk）
    //  ③前跳：目標 GOP 的 keyframe 在已餵位置之後 → 跳過中間直接從該 keyframe 解
    //  （若目標在前方但同一 GOP 內＝keyframe 不在前方 → 不 reseek，繼續向前餵即會到；
    //    切勿用「目標 vs 已餵位置」距離判斷——長 GOP 從頭重解時會每幀誤判成再跳轉而無限重來）
    const ki = this._keyBefore(tUs);
    const earliestTs = this.frames.length ? this.frames[0].timestamp
                     : (this.fedIdx > 0 ? cs[this._fedFrom].timestamp : null);
    if(this.fedIdx < 0 || (earliestTs != null && tUs < earliestTs - half) || ki > this.fedIdx) this._reseek(tUs);

    // 餵：直到「最後已解 frame」涵蓋 t+lookahead、或 decoder 佇列滿、或檔尾
    while(this.fedIdx < cs.length && this.dec.decodeQueueSize < MAX_QUEUE){
      const lastOutTs = this.frames.length ? this.frames[this.frames.length-1].timestamp : -1;
      if(lastOutTs >= tUs + LOOKAHEAD_US) break;
      const c = cs[this.fedIdx++];
      try{ this.dec.decode(new EncodedVideoChunk({ type:c.type, timestamp:c.timestamp, duration:c.duration, data:c.data })); }
      catch(e){ console.error('[WC] decode err:', e && (e.message||e)); this.state='failed'; return null; }
    }
    if(this.fedIdx >= cs.length && !this._flushed){ this._flushed = true; this.dec.flush().catch(()=>{}); } // 檔尾 drain

    // 挑 frame：最後一個 ts ≤ t＋半幀；都還沒解到但第一張已很近（<200ms）→ 先用它避免黑幀
    let best = null;
    for(const f of this.frames){ if(f.timestamp <= tUs + half) best = f; else break; }
    if(!best && this.frames.length && this.frames[0].timestamp - tUs < 200e3) best = this.frames[0];
    if(best){ while(this.frames.length && this.frames[0] !== best){ const f = this.frames.shift(); try{ f.close(); }catch(e){} } }
    return best;
  }

  dispose(){
    try{ this.dec && this.dec.close(); }catch(e){}
    if(this.frames) for(const f of this.frames){ try{ f.close(); }catch(e){} }
    this.frames = []; this.chunks = null; this.state = 'failed';
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

  /* rafLoop 每幀呼叫（含暫停/捲動）。 */
  tick(){
    if(!this._ensure()) return;
    const on = this.enabled && !Media.mpvMode && Media.seqOn();
    if(!on){
      if(this.canvas.style.display !== 'none') this.canvas.style.display = 'none';
      if(this.sources.size && !Media.seqOn()) this.disposeAll(); // 媒體已卸載 → 釋放 demux/解碼資源
      this.mode = 'off'; return;
    }
    if(this.canvas.style.display !== '') this.canvas.style.display = '';

    // 尺寸同步（wrap 客座尺寸 × dpr）
    const wrap = this.canvas.parentElement;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if(!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(w*dpr), bh = Math.round(h*dpr);
    if(this.canvas.width !== bw || this.canvas.height !== bh){ this.canvas.width = bw; this.canvas.height = bh; }

    const ctx = this.ctx;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, bw, bh);
    if(Media._gap){ this.mode = 'black'; this.lastPresentedUs = null; return; }

    const t = Media.tlTime();
    const c = Media._activeClip ? Media._activeClip() : Seq.clipAt(t);
    if(!c){ this.mode = 'black'; this.lastPresentedUs = null; return; }
    const su = Math.round(clamp(Seq.toSource(t, c), c.in, Math.max(c.in, c.out - 1/120)) * 1e6);
    const url = (c.web && c.web.url) || video.currentSrc || video.src || null;

    let f = null;
    if(url){
      let ss = this.sources.get(url);
      if(!ss){ ss = new SourceStream(url); this.sources.set(url, ss); }
      f = ss.request(su);
    }
    if(f){
      this._paint(f, f.displayWidth || f.codedWidth, f.displayHeight || f.codedHeight);
      this.mode = 'wc'; this.lastPresentedUs = f.timestamp; this.lastSrcKey = url;
    }else if(video.readyState >= 2 && (video.videoWidth||0) > 0){
      this._paint(video, video.videoWidth, video.videoHeight);   // fallback：與舊版所見相同
      this.mode = 'video'; this.lastPresentedUs = null;
    }else{
      this.mode = 'black'; this.lastPresentedUs = null;
    }
  },

  _paint(src, sw, sh){
    if(!sw || !sh) return;
    const cw = this.canvas.width, ch = this.canvas.height;
    const s = Math.min(cw/sw, ch/sh);
    const dw = Math.round(sw*s), dh = Math.round(sh*s);
    try{ this.ctx.drawImage(src, Math.round((cw-dw)/2), Math.round((ch-dh)/2), dw, dh); }catch(e){}
  },

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
