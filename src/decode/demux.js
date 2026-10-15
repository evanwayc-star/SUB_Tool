/* ==============================================================================
   SUB Tool — Module Architecture Protection ("src/decode/demux.js")
   ==============================================================================
   【維護鐵律】本檔案已納入全專案終極防禦網。
   所有修改必須遵循專案的單向資料流與職責分離原則，嚴禁在此實作越權的 DOM 操作。
============================================================================== */
/* mp4box 封裝：把 MP4／proxy 容器 demux 成 WebCodecs 可解的素材。
   兩條路：
   ① demuxIndex(url)：【串流式，v4.29 起的主路】只讀 moov 建「索引」（每 sample 的
      offset/size/cts/is_sync 全在 stco/stsz/stts/ctts/stss 裡，不需要 mdat），位元組留在
      磁碟上、播到哪抓哪 → 記憶體與影片長度脫鉤。長片 proxy 實測 2.6–4.25Mbps，
      2 小時＝2.3–3.7GB，整檔路完全吃不下（舊上限 1.5GB）；索引則僅約 10MB。
   ② demuxFile(arrayBuffer)：整檔抽出（PoC／小檔的退路）。
   兩者都回 { config, index/chunks, info }；player.js 以 SampleReader 統一取位元組。 */
import { createFile, DataStream, MP4BoxBuffer, Endianness } from 'mp4box';
import { evictWindows, planWindow, sliceBounds, touchWindow, windowByteRange } from './sample-index.js';

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
        presentationOffsetUs: presentationEdit(vtrack)?.offsetUs ?? null,
        presentationOffsetExactUs: presentationEdit(vtrack)?.offsetExactUs ?? null,
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
          timestampExactUs: s.cts / scale * 1e6,
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
async function fetchRange(url, start, end, allowShort, signal){
  const want = end - start;
  const r = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` }, signal });
  if(!r.ok && r.status !== 206) throw new Error('取位元組失敗 HTTP ' + r.status);
  if(Number(r.headers?.get?.('content-length'))>want){
    await r.body?.cancel?.();throw new Error('Range 未生效（回傳完整來源）');
  }
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

/* Bound container IO before handing moov to MP4Box. Its stsz parser expands
   even constant-size PCM tables, and appendBuffer builds every track's sample
   list before onReady. Project the private header first; original source bytes
   and absolute stco/co64 payload addresses never change. */
const INDEX_BYTE_LIMIT = 24 << 20;
const HEADER_BYTES = 64 << 10;
const INDEX_BYTES = 4 << 20;
const HEADER_REQUEST_LIMIT = 4096;

async function readMovieHeader(url){
  let position=0,readBytes=0,requests=0,brand=null;
  const read=async(start,length)=>{
    if(++requests>HEADER_REQUEST_LIMIT||length>INDEX_BYTE_LIMIT-readBytes)
      throw new Error('moov 索引超出有界讀取範圍');
    const bytes=await fetchRange(url,start,start+length,true);
    readBytes+=bytes.byteLength;
    return bytes;
  };
  while(readBytes<INDEX_BYTE_LIMIT){
    const bytes=await read(position,Math.min(HEADER_BYTES,INDEX_BYTE_LIMIT-readBytes));
    if(bytes.byteLength<8) throw new Error('找不到完整 moov header');
    const box=movieBox(new DataView(bytes),0,bytes.byteLength,true);
    if(box.type==='ftyp'||box.type==='moov'){
      if(box.size>INDEX_BYTE_LIMIT)throw new Error('moov 索引超出有界讀取範圍');
      const complete=new Uint8Array(box.size);
      let copied=Math.min(box.size,bytes.byteLength);
      complete.set(new Uint8Array(bytes,0,copied));
      while(copied<box.size){
        const part=await read(position+copied,Math.min(INDEX_BYTES,box.size-copied));
        if(!part.byteLength)throw new Error('找不到完整 moov header');
        complete.set(new Uint8Array(part),copied);copied+=part.byteLength;
      }
      if(box.type==='moov'){
        if(!brand)throw new Error('找不到 ftyp');
        return {brand,movie:complete.buffer};
      }
      brand=complete.buffer;
    }
    const next=position+box.size;
    if(!Number.isSafeInteger(next)||next<=position)throw new Error('moov 索引解析沒有進展');
    position=next;
  }
  throw new Error('moov 索引超出有界讀取範圍');
}

function movieBox(view,position,end,partial=false){
  if(position+8>end)throw new Error('不完整的 moov box');
  let size=view.getUint32(position),header=8;
  if(size===1){
    if(position+16>end)throw new Error('不完整的 moov extended box');
    size=Number(view.getBigUint64(position+8));header=16;
  }
  const type=String.fromCharCode(...new Uint8Array(view.buffer,view.byteOffset+position+4,4));
  if(!size&&!partial)size=end-position;
  if(!Number.isSafeInteger(size)||size<header||(!partial&&position+size>end))
    throw new Error('無效或超出範圍的 moov box');
  return {type,position,size,body:position+header,end:position+size};
}

function movieChildren(view,box){
  const result=[];
  for(let position=box.body;position<box.end;){
    const child=movieBox(view,position,box.end);result.push(child);position=child.end;
  }
  return result;
}

function movieSampleTables(movie){
  const view=new DataView(movie),moov=movieBox(view,0,view.byteLength),tables=[];
  for(const trak of movieChildren(view,moov).filter(box=>box.type==='trak')){
    const children=movieChildren(view,trak),tkhd=children.find(box=>box.type==='tkhd');
    const mdia=children.find(box=>box.type==='mdia');
    if(!tkhd||!mdia)throw new Error('moov 軌道缺少 metadata');
    const idPosition=tkhd.body+(view.getUint8(tkhd.body)===1?20:12);
    if(idPosition+4>tkhd.end)throw new Error('不完整的 tkhd');
    const minf=movieChildren(view,mdia).find(box=>box.type==='minf');
    const stbl=minf&&movieChildren(view,minf).find(box=>box.type==='stbl');
    if(!stbl)throw new Error('moov 軌道缺少 sample table');
    const sizes=movieChildren(view,stbl).filter(box=>box.type==='stsz'||box.type==='stz2');
    if(sizes.some(box=>box.body+12>box.end))throw new Error('不完整的 sample size table');
    const sizeTable=sizes.find(box=>box.type==='stsz')||sizes[0];
    tables.push({id:view.getUint32(idPosition),sizes,count:sizeTable?view.getUint32(sizeTable.body+8):0});
  }
  return tables;
}

function parseMovieHeader(brand,movie,tables,selectedId=null){
  const projected=movie.slice(0),bytes=new Uint8Array(projected);
  for(const track of tables){
    if(track.id===selectedId)continue;
    for(const box of track.sizes)bytes.set([102,114,101,101],box.position+4); // free: no index for this track
  }
  const file=createFile();let ready=null,ferr=null;
  file.onReady=info=>{ready=info;};file.onError=message=>{ferr=message;};
  file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(brand.slice(0),0),false);
  file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(projected,brand.byteLength),false);
  if(ferr)throw new Error('mp4box：'+ferr);
  if(!ready)throw new Error('找不到完整 moov');
  return {file,ready};
}

/* Find the first presented audio CTS in O(STTS runs + CTTS runs), without
   allocating one PCM entry per sample. Within each intersection DTS increases,
   so only its first CTS can lower the minimum. Keep integer container ticks. */
function minimumCompositionTime(table,count){
  const stts=table.stts,ctts=table.ctts;
  if(!count||!stts||(ctts&&ctts.version!==0&&ctts.version!==1))return null;
  let timingRun=0,compositionRun=0,timingLeft=0,compositionLeft=0;
  let remaining=count,dts=0,minimum=Infinity;
  while(remaining>0){
    while(!timingLeft&&timingRun<stts.sample_counts.length)timingLeft=stts.sample_counts[timingRun++];
    while(ctts&&!compositionLeft&&compositionRun<ctts.sample_counts.length)compositionLeft=ctts.sample_counts[compositionRun++];
    if(!timingLeft||(ctts&&!compositionLeft))return null;
    const delta=stts.sample_deltas[timingRun-1];
    let offset=ctts?ctts.sample_offsets[compositionRun-1]:0;
    // MP4Box reads v0 offsets as signed; ISO BMFF defines them as unsigned.
    if(ctts?.version===0&&offset<0)offset+=0x100000000;
    if(!Number.isSafeInteger(delta)||delta<0||!Number.isSafeInteger(offset))return null;
    const length=Math.min(remaining,timingLeft,ctts?compositionLeft:remaining);
    minimum=Math.min(minimum,dts+offset);dts+=length*delta;
    if(!Number.isSafeInteger(dts)||!Number.isSafeInteger(minimum))return null;
    remaining-=length;timingLeft-=length;if(ctts)compositionLeft-=length;
  }
  return minimum;
}

/* 只讀有界容器 header 建索引，moov 可位於檔頭或檔尾。
   回 { config, index:[{type,timestamp,duration,offset,size}], keyIdx:[], info, maxEnd }。
   metadataOnly 音訊來源只回真實 metadata；視訊仍建立實際逐格證據。 */
export async function demuxIndex(url,{allowAudio=false,metadataOnly=false}={}){
  if(!await rangeWorks(url)) throw new Error('此來源不支援 Range（無法串流式讀取）');
  const {brand,movie}=await readMovieHeader(url),tables=movieSampleTables(movie);
  // First let the actual parser identify supported sample entries and edits,
  // without materializing any samples. Restore only the selected decoder table.
  const metadata=parseMovieHeader(brand,movie,tables);
  const ready=metadata.ready;

    // MOV ProRes/PCM sample entries may be reported as otherTracks. Their
    // actual media handler identifies the track even without a codec adapter.
    // Native playback/probe uses the first visual source in container order.
    // A later registered codec must not replace an earlier ProRes source.
    const videoTrack = ready.tracks.find(track=>metadata.file.getTrackById(track.id)?.mdia?.hdlr?.handler==='vide')||ready.videoTracks?.[0];
    const audioTracks=ready.tracks.filter(track=>metadata.file.getTrackById(track.id)?.mdia?.hdlr?.handler==='soun');
    const audioTrack=audioTracks[0];
    const vt = videoTrack || (allowAudio && audioTrack);
    if(!vt) throw new Error('demux：找不到視訊軌'); // 有 moov 卻無視訊軌＝加大檔頭也沒用

    const audioMetadataOnly=metadataOnly&&!videoTrack;
    const {file}=audioMetadataOnly?metadata:parseMovieHeader(brand,movie,tables,vt.id);
    const samples=audioMetadataOnly?[]:file.getTrackSamplesInfo(vt.id);
    if(!audioMetadataOnly&&(!samples||!samples.length))throw new Error('取不到 sample 索引');

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
        timestampExactUs: s.cts / scale * 1e6,
        duration: Math.round((s.duration || 0) / scale * 1e6),
        offset: s.offset, size: s.size,
      };
      const e = s.offset + s.size; if(e > maxEnd) maxEnd = e;
    }
    if(samples.length&&!keyIdx.length) keyIdx.push(0); // 無 stss＝全部都是關鍵幀（罕見）；至少讓 0 可當起點
    // 索引與 avcC 已複製成獨立資料，最多 24MB 的索引緩衝就此可回收。
    const description = extractDescription(file, vt.id);
    const edit = presentationEdit(vt);
    // Each decoder begins at its active edit, including an edit that cuts
    // through an AAC priming packet. Do not move that origin to the next
    // packet grid or retain encoded preroll that decodeAudioData discards.
    const audioOffsets=audioTracks.map(track=>{
      const active=presentationEdit(track),table=metadata.file.getTrackById(track.id)?.mdia?.minf?.stbl;
      const cts=table?minimumCompositionTime(table,tables.find(item=>item.id===track.id)?.count):null;
      if(!active||!Number.isFinite(cts)||!(track.timescale>0)) return null;
      const origin=Math.max(active.startExactUs/1e6,cts/track.timescale+active.offsetExactUs/1e6);
      return -origin||0;
    });

    return {
      config: videoTrack ? { codec: vt.codec, codedWidth: vt.video?.width||vt.track_width, codedHeight: vt.video?.height||vt.track_height, description } : null,
      index, keyIdx, maxEnd,
      info: {
        width: videoTrack?(vt.video?.width||vt.track_width):0, height: videoTrack?(vt.video?.height||vt.track_height):0, codec: vt.codec, hasVideo:!!videoTrack,
        timescale: scale, nbSamples: audioMetadataOnly?tables.find(track=>track.id===vt.id)?.count||0:samples.length,
        durationUs: Math.round((vt.movie_duration / (vt.movie_timescale || scale)) * 1e6),
        containerDurationUs: Math.round(ready.duration / ready.timescale * 1e6),
        // Container CTS includes decoder preroll. Native/HTML media time follows
        // the edit list instead; only a single rate-1 media edit is supported.
        presentationOffsetUs: edit?.offsetUs ?? null,
        presentationOffsetExactUs: edit?.offsetExactUs ?? null,
        presentationStartUs: edit?.startUs ?? null,
        audioPresentationTimestampOffset: audioOffsets[0]??null,
        audioPresentationTimestampOffsets: audioOffsets,
        decoderAudioPresentationTimestampOffsets: audioOffsets,
      },
    };
}

function presentationEdit(track){
  const edits=track.edits||[];
  if(!edits.length) return {offsetUs:0,offsetExactUs:0,startUs:0,startExactUs:0};
  let emptyDuration=0,media=null;
  for(const edit of edits){
    if(edit.media_rate_integer!==1||edit.media_rate_fraction!==0||
      !Number.isSafeInteger(edit.media_time)||!Number.isSafeInteger(edit.segment_duration)||edit.segment_duration<0) return null;
    if(edit.media_time<0){
      if(media||edit.media_time!==-1) return null;
      emptyDuration+=edit.segment_duration;if(!Number.isSafeInteger(emptyDuration))return null;
    }
    else {if(media) return null;media=edit;}
  }
  if(!media) return null;
  const startExactUs=emptyDuration/(track.movie_timescale||track.timescale)*1e6;
  const startUs=Math.round(startExactUs);
  const offsetExactUs=(emptyDuration/(track.movie_timescale||track.timescale)-media.media_time/track.timescale)*1e6;
  return {startUs,startExactUs,offsetExactUs,offsetUs:Math.round(offsetExactUs)};
}

/* CTS 是容器座標；decoder 與 HTML/mpv 都使用 edit-list 定義的來源呈現時間。
   保留 decode 順序、位元組 offset 與 payload，只在這個 seam 換一次時間域。 */
export function presentationSamples(samples,info){
  const offset=info?.presentationOffsetUs;
  if(!Number.isFinite(offset)) return null;
  const exactOffset=info?.presentationOffsetExactUs??offset;
  // CTS and edit-list ticks can each contain fractional microseconds. Rounding
  // them separately moves CFR/NTSC boundaries by one tick before frame lookup.
  const result=samples.map(sample=>({...sample,timestamp:Math.round((sample.timestampExactUs??sample.timestamp)+exactOffset)}));
  // stts duration follows decode order. With VFR B-frames it is not the
  // displayed frame's hold time; adjacent CTS define that interval.
  const ordered=[...result].sort((a,b)=>a.timestamp-b.timestamp);
  for(let index=0;index<ordered.length-1;index++){
    ordered[index].duration=ordered[index+1].timestamp-ordered[index].timestamp;
  }
  return result;
}

/* 位元組視窗讀取器：一次抓「一段連續樣本」進記憶體，播過就丟。
   視窗怎麼切、位移怎麼算、誰先被丟——全部在 sample-index.js（純函式，有測試）。
   這裡只剩「發 Range 請求」與「把位元組掛回視窗」這些真正需要 IO 的部分。 */
export class SampleReader {
  constructor(url, index, maxEnd){
    this.url = url; this.index = index; this.maxEnd = maxEnd;
    this.wins = new Map();  // startIdx → {from,to,bytes:Uint8Array|null,base,promise}
    this.order = [];        // LRU（最舊在前）
    this._disposed = false;
  }
  /* 位元組已就位 → Uint8Array；否則 null（呼叫端應先 ensure()、本幀先跳過） */
  data(i){
    if(this._disposed || i < 0 || i >= this.index.length) return null;
    const w = this.wins.get(planWindow(this.index, i).from);
    if(!w || !w.bytes) return null;
    const b = sliceBounds(this.index, i, w);
    return b ? w.bytes.subarray(b.off, b.end) : null;
  }
  /* 觸發抓取（非同步、不等待）。同一視窗重覆呼叫只會抓一次。 */
  ensure(i){
    if(this._disposed || i < 0 || i >= this.index.length) return;
    const { from, to } = planWindow(this.index, i);
    let w = this.wins.get(from);
    if(w){ this.order = touchWindow(this.order, from); return; }
    const { base, end } = windowByteRange(this.index, from, to, this.maxEnd);
    w = { from, to, base, bytes: null, controller: new AbortController() };
    this.wins.set(from, w); this.order.push(from);
    w.promise = fetchRange(this.url, base, end, false, w.controller.signal)
      .then(ab => { if(this.wins.get(from) === w) w.bytes = new Uint8Array(ab); })
      .catch(e => {
        // 同一位置可能已被淘汰再重抓；舊 IO 失敗不可刪掉新視窗。
        if(this.wins.get(from) !== w) return;
        this.wins.delete(from); const k = this.order.indexOf(from); if(k >= 0) this.order.splice(k, 1);
        console.warn('[WC] 取位元組失敗:', e && (e.message || e)); });
    const { keep, drop } = evictWindows(this.order);
    for(const k of drop){
      const evicted = this.wins.get(k);
      this.wins.delete(k);
      evicted?.controller.abort();
    }
    this.order = keep;
  }
  dispose(){
    this._disposed = true;
    for(const w of this.wins.values()) w.controller.abort();
    this.wins.clear(); this.order = [];
  }
}

/* 整檔路的同介面讀取器（位元組已全在記憶體）：讓 player.js 兩條路共用同一段程式碼 */
export class MemReader {
  constructor(chunks){ this.chunks = chunks; }
  data(i){ const c = this.chunks[i]; return c ? c.data : null; }
  ensure(){}
  dispose(){ this.chunks = null; }
}

