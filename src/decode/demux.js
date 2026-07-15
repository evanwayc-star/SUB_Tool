/* mp4box 封裝：把 MP4／proxy 容器 demux 成 WebCodecs 可解的素材。
   回傳 { config:VideoDecoderConfig, chunks:[{type,timestamp(µs),duration(µs),data}], info }。
   ── 階段0 PoC：一次抽完整檔（720p proxy 短、記憶體可接受）；大檔的串流式／分段 demux 留待後續階段。 */
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
