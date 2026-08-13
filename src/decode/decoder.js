/* ==============================================================================
   SUB Tool — Module Architecture Protection ("src/decode/decoder.js")
   ==============================================================================
   【維護鐵律】本檔案已納入全專案終極防禦網。
   所有修改必須遵循專案的單向資料流與職責分離原則，嚴禁在此實作越權的 DOM 操作。
============================================================================== */
/* 單軌 VideoDecoder 封裝：隨機存取（frameAt）＝從目標時間前最近的 keyframe 解到該時間的 VideoFrame。
   診斷用 `frameAt` 每次從 keyframe 重解（正確但非最省）；順序播放另走 decodeSeq 量 fps。
   B-frame：依 dts 餵、output 依 cts 回，故收集 flush 後全部 output 再挑最接近目標者。 */
export class TrackDecoder {
  constructor(){ this.dec=null; this.config=null; this.chunks=[]; this._collect=null; }

  async init({ config, chunks }, opts = {}){
    if(!('VideoDecoder' in window)) throw new Error('此環境不支援 WebCodecs VideoDecoder');
    this.config = config; this.chunks = chunks;
    const cfg = Object.assign({ optimizeForLatency: true }, config); // 儘早吐 frame、不多囤
    // 預設軟解：720p proxy 軟解已 >3000fps（解一幀 ~0.3ms）遠超即時，且**硬解在部分環境對連續解碼不穩**
    // （診斷實測：硬解可解單幀、但連續解到約第 18 幀就吞 chunk 不吐 frame）。需硬解（高解析度/多軌）時
    // 傳 opts.hardwareAcceleration:'no-preference'；「持續輸出探針 + fallback」留待階段4 效能優化再做。
    cfg.hardwareAcceleration = opts.hardwareAcceleration || 'prefer-software';
    this.cfg = cfg;
    const sup = await VideoDecoder.isConfigSupported(cfg);
    if(!sup || !sup.supported) throw new Error('VideoDecoder 不支援此設定：'+config.codec);
    this.dec = new VideoDecoder({
      output: (frame)=>{ if(this._collect) this._collect.push(frame); else frame.close(); },
      error: (e)=>{ console.error('[WC] VideoDecoder error', e && (e.message||e)); },
    });
    this.dec.configure(cfg);
    this.hwUsed = cfg.hardwareAcceleration;
    return { supported:true, hardwareAcceleration:cfg.hardwareAcceleration };
  }

  _keyframeIdxBefore(tUs){
    let k = 0;
    for(let i=0;i<this.chunks.length;i++){
      const c = this.chunks[i];
      if(c.type==='key' && c.timestamp<=tUs) k = i;
      else if(c.timestamp > tUs) break;
    }
    return k;
  }
  _targetIdx(tUs, from){
    for(let i=from;i<this.chunks.length;i++){ if(this.chunks[i].timestamp>=tUs) return i; }
    return this.chunks.length-1;
  }

  /* 解出最接近 tUs 的 presentation frame；呼叫端用完須 frame.close()。 */
  async frameAt(tUs){
    if(!this.dec) throw new Error('decoder 未初始化');
    const ki = this._keyframeIdxBefore(tUs);
    const ti = this._targetIdx(tUs, ki);
    const frames = []; this._collect = frames;
    for(let i=ki;i<=ti;i++){
      const c = this.chunks[i];
      this.dec.decode(new EncodedVideoChunk({ type:c.type, timestamp:c.timestamp, duration:c.duration, data:c.data }));
    }
    await this.dec.flush();
    this._collect = null;
    let best = null;
    for(const f of frames){
      if(!best){ best = f; continue; }
      if(Math.abs(f.timestamp - tUs) < Math.abs(best.timestamp - tUs)){ best.close(); best = f; }
      else f.close();
    }
    return best;
  }

  /* 順序解 count 幀（從 startUs 所在 keyframe 起），量測 decode 吞吐；每幀即 close。回傳 {frames, ms}。 */
  async decodeSeq(startUs, count){
    if(!this.dec) throw new Error('decoder 未初始化');
    const ki = this._keyframeIdxBefore(startUs);
    const end = Math.min(this.chunks.length, ki + count);
    let n = 0; const frames = [];
    this._collect = frames;
    const t0 = performance.now();
    for(let i=ki;i<end;i++){
      const c = this.chunks[i];
      this.dec.decode(new EncodedVideoChunk({ type:c.type, timestamp:c.timestamp, duration:c.duration, data:c.data }));
    }
    await this.dec.flush();
    this._collect = null;
    const ms = performance.now() - t0;
    for(const f of frames){ n++; f.close(); }
    return { frames:n, ms };
  }

  close(){ try{ this.dec && this.dec.close(); }catch(e){} this.dec = null; }
}

