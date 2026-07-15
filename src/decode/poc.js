/* 階段0 PoC 驗證入口（掛在 window.SUB.WC.pocTest）：
   取來源檔 → demux → VideoDecoder 解碼 → 畫到 canvas，並量測 demux/seek 時間與順序解碼 fps。
   目的：證明 WebCodecs 在此環境可用（H.264 硬解）、seek 準、效能足，供階段1 起採用。 */
import { demuxFile } from './demux.js';
import { TrackDecoder } from './decoder.js';

export async function pocTest(url, opts){
  const el = document.getElementById('video');
  const src = url || (el && (el.currentSrc || el.src));
  if(!src) throw new Error('無來源；請傳入 url 或先載入影片');

  const ab = await (await fetch(src)).arrayBuffer();

  const t0 = performance.now();
  const { config, chunks, info } = await demuxFile(ab);
  const tDemux = performance.now() - t0;

  const dec = new TrackDecoder();
  const sup = await dec.init({ config, chunks }, opts || {});

  // 隨機存取：seek 到 3 秒
  const t1 = performance.now();
  const frame = await dec.frameAt(3e6);
  const tSeek = performance.now() - t1;
  const frameTsUs = frame ? frame.timestamp : null;

  // 畫到右下角 PoC canvas，驗證色彩／正確性
  let painted = false;
  if(frame){
    let cv = document.getElementById('wcPocCanvas');
    if(!cv){
      cv = document.createElement('canvas'); cv.id = 'wcPocCanvas';
      cv.style.cssText = 'position:fixed;right:8px;bottom:8px;width:320px;height:auto;z-index:99999;border:2px solid #3fa9f5;background:#000';
      document.body.appendChild(cv);
    }
    cv.width = config.codedWidth; cv.height = config.codedHeight;
    cv.getContext('2d').drawImage(frame, 0, 0);
    painted = true;
    frame.close();
  }

  // 順序解 60 幀量 fps
  const seq = await dec.decodeSeq(0, 60);
  const decodeFps = seq.frames>0 ? Math.round(seq.frames / (seq.ms/1000)) : 0;

  dec.close();
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
}

// 供 PoC 分步診斷（window.SUB.WC）
export { demuxFile, TrackDecoder };
