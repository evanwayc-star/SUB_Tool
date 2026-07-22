/* ==============================================================================
   SUB Tool — Module Architecture Protection ("src/decode/demux.js")
   ==============================================================================
   【維護鐵律】本檔案已納入全專案終極防禦網。
   所有修改必須遵循專案的單向資料流與職責分離原則，嚴禁在此實作越權的 DOM 操作。
============================================================================== */
/* mp4box 封裝：把 MP4／proxy 容器 demux 成 WebCodecs 可解的素材。
   兩條路：
   ① demuxIndex(url)：【串流式，v4.29 起的主路】只讀檔頭 moov 建「索引」（每 sample 的
      offset/size/cts/is_sync 全在 stco/stsz/stts/ctts/stss 裡，不需要 mdat），位元組留在
      磁碟上、播到哪抓哪 → 記憶體與影片長度脫鉤。長片 proxy 實測 2.6–4.25Mbps，
      2 小時＝2.3–3.7GB，整檔路完全吃不下（舊上限 1.5GB）；索引則僅約 10MB。
   ② demuxFile(arrayBuffer)：整檔抽出（PoC／小檔／moov 不在檔頭的退路）。
   兩者都回 { config, index/chunks, info }；player.js 以 SampleReader 統一取位元組。 */
import { createFile, DataStream, MP4BoxBuffer, Endianness } from 'mp4box';

/* 從 trak 的 stsd entry 抽 avcC/hvcC 當 VideoDecoderConfig.description（去掉 8-byte box header）。
   av1/vp9 或 in-band（avc3）通常不需 description → 回 undefined。 */
function extractDescription(file, trackId){
  const trak = file.getTrackById(trackId);
  const entries = trak?.mdia?.minf?.stbl?.stsd?.entries || [];
  for(const e of entries){
    const box = e.avcC || e.hvcC || e.vpcC || e.av1C;
    if(box){
      const ds = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
      box.write(ds);
      return new Uint8Array(ds.buffer, 8); // 跳過 box 的 size(4)+type(4)
    }
  }
  return undefined;
}

export function demuxFile(arrayBuffer){
  return new Promise((resolve, reject)=>{
    const file = createFile();
    const chunks = [];
    let config = null, vtrack = null, done = false;
    const finish = ()=>{
      if(done) return; done = true;
      if(!config){ reject(new Error('demux：找不到視訊軌')); return; }
      resolve({ config, chunks, info:{
        width: vtrack.video.width, height: vtrack.video.height,
        codec: vtrack.codec, timescale: vtrack.timescale, nbSamples: vtrack.nb_samples,
        durationUs: Math.round((vtrack.movie_duration / (vtrack.movie_timescale||vtrack.timescale||1)) * 1e6),
      }});
    };
    file.onError = (msg)=>{ if(!done){ done=true; reject(new Error('mp4box：'+msg)); } };
    file.onReady = (info)=>{
      vtrack = info.videoTracks && info.videoTracks[0];
      if(!vtrack){ finish(); return; }
      config = {
        codec: vtrack.codec,
        codedWidth: vtrack.video.width,
        codedHeight: vtrack.video.height,
        description: extractDescription(file, vtrack.id),
      };
      file.setExtractionOptions(vtrack.id, null, { nbSamples: Infinity });
      file.start();
    };
    file.onSamples = (id, user, samples)=>{
      for(const s of samples){
        const scale = s.timescale || (vtrack && vtrack.timescale) || 1;
        chunks.push({
          type: s.is_sync ? 'key' : 'delta',
          timestamp: Math.round(s.cts / scale * 1e6),
          duration: Math.round((s.duration||0) / scale * 1e6),
          data: s.data,
        });
      }
    };
    try{
      const buf = MP4BoxBuffer.fromArrayBuffer(arrayBuffer, 0);
      file.appendBuffer(buf, true); // last=true：整個檔一次餵入
      file.flush();
    }catch(err){ if(!done){ done=true; reject(err); } return; }
    finish(); // onReady/onSamples 於 appendBuffer/flush 內同步觸發
  });
}

/* ===================== 串流式：索引 + 按需取位元組（v4.29） ===================== */

/* 取 [start,end) 的位元組。
   ── 鐵律：不可看 HTTP 狀態碼。實測 Chromium 的 file:// loader 會【套用 Range 但回 200
      且不給 Content-Range】，而真正忽略 Range 的實作會回「整個檔案」。兩者狀態碼相同，
      只有長度能分辨。長度不符一律報錯——絕不把「整檔」當成「某一段」餵進 decoder
      （那會解出花屏，而且錯得很安靜）。 */
async function fetchRange(url, start, end, allowShort){
  const want = end - start;
  const r = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` } });
  if(!r.ok && r.status !== 206) throw new Error('取位元組失敗 HTTP ' + r.status);
  const ab = await r.arrayBuffer();
  if(ab.byteLength !== want && !(allowShort && ab.byteLength < want))
    throw new Error(`Range 未生效（要 ${want} bytes、得 ${ab.byteLength}）`);
  return ab;
}

/* 開場探針：先用 1KB 確認此 url 真的支援 Range，之後的取用才可信。
   （檔案必大於 1KB——不到 1KB 的不會是影片。） */
async function rangeWorks(url){
  try{ return (await fetchRange(url, 0, 1024, false)).byteLength === 1024; }
  catch(e){ return false; }
}

/* 檔頭嘗試值：moov 大小 ≈ 樣本數 ×~10B（stsz/stts/ctts/stco/stss）。實測 10 萬顆樣本
   （67 分鐘）的 moov 在 4MB 內；24MB 可涵蓋約 8 小時。再大一律當「moov 不在檔頭」處理，
   讓呼叫端退回整檔路——與其為罕見的外來檔多讀幾十 MB，不如早點認賠。 */
const HEAD_TRY = [4 << 20, 24 << 20];

/* 只讀檔頭建索引。回 { config, index:[{type,timestamp,duration,offset,size}], keyIdx:[], info, maxEnd }。
   需要 moov 在檔頭（+faststart）——本專案產生的 proxy 必為 faststart；外來檔失敗則由呼叫端退回整檔路。 */
export async function demuxIndex(url){
  if(!await rangeWorks(url)) throw new Error('此來源不支援 Range（無法串流式讀取）');
  let lastErr = null;
  for(const head of HEAD_TRY){
    const file = createFile();
    let ready = null, ferr = null;
    file.onError = m => { ferr = m; };
    file.onReady = info => { ready = info; };
    try{
      // allowShort：檔案比 head 小＝直接拿到整個檔，一樣能解析（Range 已由探針證實有效）
      const ab = await fetchRange(url, 0, head, true);
      file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(ab, 0), false); // fileStart=0
    }catch(e){ lastErr = e; continue; }
    if(!ready){ lastErr = new Error(ferr || `檔頭 ${head >> 20}MB 內找不到 moov`); continue; }

    const vt = ready.videoTracks && ready.videoTracks[0];
    if(!vt) throw new Error('demux：找不到視訊軌'); // 有 moov 卻無視訊軌＝加大檔頭也沒用

    file.setExtractionOptions(vt.id, null, { nbSamples: 1 });
    file.start(); // 觸發 buildSampleLists()：由 stco/stsz/stts/ctts/stss 算出每 sample 的 offset
    const samples = file.getTrackSamplesInfo(vt.id);
    if(!samples || !samples.length){ lastErr = new Error('取不到 sample 索引'); continue; }

    const scale = vt.timescale || 1;
    const index = new Array(samples.length);
    const keyIdx = [];
    let maxEnd = 0;
    for(let i = 0; i < samples.length; i++){
      const s = samples[i];
      if(s.is_sync) keyIdx.push(i);
      index[i] = {
        type: s.is_sync ? 'key' : 'delta',
        timestamp: Math.round(s.cts / scale * 1e6),
        duration: Math.round((s.duration || 0) / scale * 1e6),
        offset: s.offset, size: s.size,
      };
      const e = s.offset + s.size; if(e > maxEnd) maxEnd = e;
    }
    if(!keyIdx.length) keyIdx.push(0); // 無 stss＝全部都是關鍵幀（罕見）；至少讓 0 可當起點
    // 索引與 avcC 都已複製成獨立資料 → file（含最多 64MB 檔頭緩衝）就此不可達，交給 GC
    const description = extractDescription(file, vt.id);

    return {
      config: { codec: vt.codec, codedWidth: vt.video.width, codedHeight: vt.video.height, description },
      index, keyIdx, maxEnd,
      info: {
        width: vt.video.width, height: vt.video.height, codec: vt.codec,
        timescale: scale, nbSamples: samples.length,
        durationUs: Math.round((vt.movie_duration / (vt.movie_timescale || scale)) * 1e6),
      },
    };
  }
  throw lastErr || new Error('無法建立索引');
}

/* 位元組視窗讀取器：一次抓「一段連續樣本」進記憶體，播過就丟。
   視窗同時受樣本數與位元組數上限拘束——長 GOP／高位元率的原生檔，48 顆樣本可能是好幾十 MB。 */
const WIN_SAMPLES = 48;            // ≈2s @24fps（proxy 短 GOP 每 0.5s 一個關鍵幀）
const WIN_BYTES   = 4 * 1024 * 1024;
const WIN_KEEP    = 4;             // 常駐視窗數（≈16MB 上限）

export class SampleReader {
  constructor(url, index, maxEnd){
    this.url = url; this.index = index; this.maxEnd = maxEnd;
    this.wins = new Map();  // startIdx → {from,to,bytes:Uint8Array|null,base,promise}
    this.order = [];        // LRU（最舊在前）
  }
  /* 視窗起點對齊到固定格線 → 各層游標不同也能共用同一批視窗 */
  _winStart(i){ return Math.floor(i / WIN_SAMPLES) * WIN_SAMPLES; }
  _winEnd(from){
    let to = Math.min(from + WIN_SAMPLES, this.index.length);
    const base = this.index[from].offset;
    for(let i = from + 1; i < to; i++){
      if(this.index[i].offset + this.index[i].size - base > WIN_BYTES){ to = i; break; }
    }
    return Math.max(to, from + 1); // 單顆樣本自己就超過 WIN_BYTES 時仍須抓得動
  }
  /* 位元組已就位 → Uint8Array；否則 null（呼叫端應先 ensure()、本幀先跳過） */
  data(i){
    const w = this.wins.get(this._winStart(i));
    if(!w || !w.bytes || i < w.from || i >= w.to) return null;
    const s = this.index[i], off = s.offset - w.base;
    return w.bytes.subarray(off, off + s.size);
  }
  /* 觸發抓取（非同步、不等待）。同一視窗重覆呼叫只會抓一次。 */
  ensure(i){
    if(i < 0 || i >= this.index.length) return;
    const from = this._winStart(i);
    let w = this.wins.get(from);
    if(w){ this._touch(from); return; }
    const to = this._winEnd(from);
    const base = this.index[from].offset;
    const end = Math.min(this.index[to - 1].offset + this.index[to - 1].size, this.maxEnd);
    w = { from, to, base, bytes: null };
    this.wins.set(from, w); this.order.push(from);
    w.promise = fetchRange(this.url, base, end, false)
      .then(ab => { if(this.wins.get(from) === w) w.bytes = new Uint8Array(ab); })
      .catch(e => { this.wins.delete(from); const k = this.order.indexOf(from); if(k >= 0) this.order.splice(k, 1);
        console.warn('[WC] 取位元組失敗:', e && (e.message || e)); });
    this._evict();
  }
  _touch(from){ const k = this.order.indexOf(from); if(k >= 0){ this.order.splice(k, 1); this.order.push(from); } }
  _evict(){ while(this.order.length > WIN_KEEP) this.wins.delete(this.order.shift()); }
  dispose(){ this.wins.clear(); this.order = []; }
}

/* 整檔路的同介面讀取器（位元組已全在記憶體）：讓 player.js 兩條路共用同一段程式碼 */
export class MemReader {
  constructor(chunks){ this.chunks = chunks; }
  data(i){ const c = this.chunks[i]; return c ? c.data : null; }
  ensure(){}
  dispose(){ this.chunks = null; }
}

