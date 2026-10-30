/* ==============================================================================
   SUB Tool — WebCodecs diagnostics ("src/decode/diagnostics.js")
   ==============================================================================
   【維護鐵律】本檔案已納入全專案終極防禦網。
   所有修改必須遵循專案的單向資料流與職責分離原則，嚴禁在此實作越權的 DOM 操作。
============================================================================== */
/* WebCodecs 真機診斷入口（為相容既有 DevTools 用法，仍掛在 window.SUB.WC.pocTest）：
   取來源檔 → demux → VideoDecoder 解碼 → 畫到 canvas，並量測 demux/seek 時間與順序解碼 fps。
   目的：確認目前環境的 H.264 解碼、seek、色彩與吞吐量。 */
import { demuxFile } from './demux.js';
import { keyIndexBefore } from './sample-index.js';
import { readMediaBytes, WHOLE_MEDIA_BYTE_LIMIT } from './response-reader.js';

export async function pocTest(url, opts = {}){
  const hasDom = typeof document !== 'undefined';
  const el = hasDom ? document.getElementById('video') : null;
  const src = url || (el && (el.currentSrc || el.src));
  if(!src) throw new Error('無來源；請傳入 url 或先載入影片');

  const ab = await readMediaBytes(await fetch(src), WHOLE_MEDIA_BYTE_LIMIT);

  const t0 = performance.now();
  const { config, chunks, info } = await demuxFile(ab);
  const tDemux = performance.now() - t0;

  const dec = new TrackDecoder();
  try{
  const sup = await dec.init({ config, chunks }, opts);

  // 隨機存取：seek 到 3 秒
  const t1 = performance.now();
  const frame = await dec.frameAt(3e6);
  const tSeek = performance.now() - t1;
  const frameTsUs = frame ? frame.timestamp : null;

  // 畫到右下角 PoC canvas，驗證色彩／正確性
  let painted = false;
  if(frame){
    try{
    if(hasDom && !opts.noPreview){
      let cv = opts.canvas || document.getElementById('wcPocCanvas');
      if(!cv && document.body){
        cv = document.createElement('canvas'); cv.id = 'wcPocCanvas';
        cv.style.cssText = 'position:fixed;right:8px;bottom:8px;width:320px;height:auto;z-index:99999;border:2px solid #3fa9f5;background:#000';
        document.body.appendChild(cv);
      }
      if(cv && cv.getContext){
        cv.width = config.codedWidth; cv.height = config.codedHeight;
        cv.getContext('2d').drawImage(frame, 0, 0);
        painted = true;
      }
    }
    }finally{frame.close();}
  }

  // 順序解 60 幀量 fps
  const seq = await dec.decodeSeq(0, 60);
  const decodeFps = seq.frames>0 ? Math.round(seq.frames / (seq.ms/1000)) : 0;

  return {
    ok: true,
    codec: config.codec, hwSupported: !!sup.supported, hwUsed: sup.hardwareAcceleration,
    hasDescription: !!config.description, descLen: config.description ? config.description.length : 0,
    size: config.codedWidth + 'x' + config.codedHeight,
    chunks: chunks.length, keyframes: chunks.filter(c=>c.type==='key').length,
    durationUs: info.durationUs,
    tDemuxMs: Math.round(tDemux), tSeekMs: Math.round(tSeek), frameTsUs, painted,
    seqFrames: seq.frames, seqMs: Math.round(seq.ms), decodeFps,
  };
  }finally{dec.close();}
}

class TrackDecoder {
  constructor(){ this.dec=null; this.config=null; this.chunks=[]; this.keyIdx=[]; this._collect=null; }

  async init({ config, chunks }, opts = {}){
    if(!('VideoDecoder' in window)) throw new Error('此環境不支援 WebCodecs VideoDecoder');
    this.config = config; this.chunks = chunks || [];
    this.keyIdx = [];
    for(let i=0;i<this.chunks.length;i++){
      if(this.chunks[i].type==='key') this.keyIdx.push(i);
    }
    if(!this.keyIdx.length && this.chunks.length) this.keyIdx.push(0);
    const cfg = Object.assign({ optimizeForLatency: true }, config);
    cfg.hardwareAcceleration = opts.hardwareAcceleration || 'prefer-software';
    this.cfg = cfg;
    const sup = await VideoDecoder.isConfigSupported(cfg);
    if(!sup || !sup.supported) throw new Error('VideoDecoder 不支援此設定：'+config.codec);
    this.dec = new VideoDecoder({
      output: (frame)=>{ if(this._collect) this._collect.push(frame); else frame.close(); },
      error: (e)=>{ console.error('[WC] VideoDecoder error', e && (e.message||e)); },
    });
    try{this.dec.configure(cfg);}
    catch(error){this.close();throw error;}
    this.hwUsed = cfg.hardwareAcceleration;
    return { supported:true, hardwareAcceleration:cfg.hardwareAcceleration };
  }

  _keyframeIdxBefore(tUs){
    if(!this.keyIdx.length) return 0;
    return keyIndexBefore(this.chunks, this.keyIdx, tUs);
  }
  _targetIdx(tUs, from){
    for(let i=from;i<this.chunks.length;i++){ if(this.chunks[i].timestamp>=tUs) return i; }
    return this.chunks.length-1;
  }

  async frameAt(tUs){
    if(!this.dec) throw new Error('decoder 未初始化');
    const ki = this._keyframeIdxBefore(tUs);
    const ti = this._targetIdx(tUs, ki);
    const frames = []; this._collect = frames;
    let best = null;
    try{
    for(let i=ki;i<=ti;i++){
      const c = this.chunks[i];
      this.dec.decode(new EncodedVideoChunk({ type:c.type, timestamp:c.timestamp, duration:c.duration, data:c.data }));
    }
    await this.dec.flush();
    for(const f of frames){
      if(!best||Math.abs(f.timestamp-tUs)<Math.abs(best.timestamp-tUs)) best=f;
    }
    return best;
    }finally{
      this._collect=null;
      // 成功只交出一張給 caller；decode／flush 失敗則全數由本 owner 釋放。
      for(const frame of frames) if(frame!==best) frame.close();
    }
  }

  async decodeSeq(startUs, count){
    if(!this.dec) throw new Error('decoder 未初始化');
    const ki = this._keyframeIdxBefore(startUs);
    const end = Math.min(this.chunks.length, ki + count);
    const frames = [];
    this._collect = frames;
    const t0 = performance.now();
    try{
    for(let i=ki;i<end;i++){
      const c = this.chunks[i];
      this.dec.decode(new EncodedVideoChunk({ type:c.type, timestamp:c.timestamp, duration:c.duration, data:c.data }));
    }
    await this.dec.flush();
    const ms = performance.now() - t0;
    return { frames:frames.length, ms };
    }finally{
      this._collect=null;
      for(const frame of frames) frame.close();
    }
  }

  close(){ try{ this.dec && this.dec.close(); }catch(e){} this.dec = null; }
}

// 供分步診斷（window.SUB.WC）
export { demuxFile, TrackDecoder };
export { demuxIndex, SampleReader } from './demux.js'; // v4.29 串流式：索引＋按需取位元組

