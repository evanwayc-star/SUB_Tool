'use strict';

const { previewVideoEncoderArgs } = require('./native-tooling');

/**
 * 組合 Ingest 與 StreamIngest 的 FFmpeg 參數。
 * 根據編碼器 (VENC) 決定啟用硬體加速，並組裝所有 `-map` 與 `-filter_complex`。
 * 注意：不強制指定 scale_cuda 或 hwaccel_output_format，以確保當遇到
 * nvdec 不支援的專業格式（如 4:2:2 10-bit MXF）時，能優雅退回軟體解碼，不致崩潰。
 */
function buildIngestArgs({
  src,
  needsProxy,
  proxyPath,
  fc,
  channels,
  chMaps,
  waveLabel,
  wavePath,
  encoder,
  isStream = false
}) {
  const isCuda = encoder === 'h264_nvenc';
  const isQsv = encoder === 'h264_qsv';

  let hwdec = [];
  if (encoder && encoder !== 'libx264') {
    hwdec = ['-hwaccel', 'auto'];
  }

  const args = ['-y', ...hwdec, '-i', src];

  if (fc && fc.length) args.push('-filter_complex', fc.join(';'));

  if (needsProxy && proxyPath) {
    let vf = 'scale=-2:720,format=yuv420p';

    const vencArgs = previewVideoEncoderArgs(encoder);
    args.push('-map', '0:v:0', '-an', '-vf', vf, ...vencArgs);

    if (isStream) {
      args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', proxyPath);
    } else {
      // proxyGopArgs: 短 GOP 讓 WebCodecs seek 幾乎即時
      args.push('-force_key_frames', 'expr:gte(t,n_forced*0.5)');
      args.push('-movflags', '+faststart', proxyPath);
    }
  }

  (channels || []).forEach((c, k) => {
    args.push('-map', chMaps[k], '-c:a', 'aac', '-b:a', '128k', c.file);
  });

  if (waveLabel && wavePath) {
    args.push('-map', waveLabel, '-ac', '1', '-ar', '4000', '-c:a', 'pcm_s16le', wavePath);
  }

  return args;
}

module.exports = {
  buildIngestArgs
};
