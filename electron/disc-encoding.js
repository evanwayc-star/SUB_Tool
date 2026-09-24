'use strict';

// 光碟的純編碼與容量規則；原生工具、檔案與程序生命週期留在 disc-authoring。
const { DVD_ISO, BD_ISO, bdVideoMode } = require('../shared/delivery-formats.cjs');

const DISC_FORMATS = Object.freeze({
  'dvd-iso': Object.freeze({ ...DVD_ISO, maxStreams: DVD_ISO.maxAudioStreams, maxVideoKbps: 8500, extension: '.mpg' }),
  'bd-iso': Object.freeze({ ...BD_ISO, maxStreams: BD_ISO.maxAudioStreams, maxVideoKbps: 30000, extension: '.ts' }),
});

function fail(code, message) { return Object.assign(new Error(message), { code }); }
function discFormat(format) {
  const spec = DISC_FORMATS[format];
  if (!spec) throw fail('INVALID_DISC_FORMAT', `不支援的光碟格式：${format}`);
  return spec;
}

function discAudioStreams(format, audioPlan) {
  const spec = discFormat(format);
  const streams = audioPlan == null ? [{ layout: 'stereo' }] : audioPlan.streams;
  if (!Array.isArray(streams) || !streams.length || streams.length > spec.maxStreams) {
    throw fail('INVALID_DISC_AUDIO', `此光碟格式需要 1–${spec.maxStreams} 組音訊`);
  }
  return streams.map(stream => {
    const channels = stream.layout === 'mono' ? 1 : stream.layout === '5.1' ? 6
      : ['stereo', 'stereoLtRt'].includes(stream.layout) ? 2 : 0;
    if (!channels) throw fail('INVALID_DISC_AUDIO', '光碟音訊僅支援 Mono、Stereo、LtRt 或 5.1 編組');
    return { channels, layout: stream.layout };
  });
}

// Reserve filesystem/navigation space and mux overhead before assigning video bits.
// A CBR elementary stream keeps the single encoding pass within this conservative budget.
function discEncoding(format, { duration, audioPlan, fps } = {}) {
  const spec = discFormat(format);
  const bdMode = format === 'bd-iso' ? bdVideoMode(fps ?? spec.fps) : null;
  if (format === 'bd-iso' && !bdMode) throw fail('INVALID_BD_FPS', 'BD 輸出不支援此影格率');
  const audio = discAudioStreams(format, audioPlan);
  if (!Number.isFinite(duration) || duration <= 0) throw fail('INVALID_DISC_DURATION', '光碟時長必須大於零');
  const audioKbps = spec.audioKbps * audio.length;
  const budgetKbps = Math.floor(((spec.capacityBytes - 64 * 1024 * 1024) * 0.92 * 8 / duration / 1000 - audioKbps) / 100) * 100;
  const peakLimit = format === 'dvd-iso' ? 10080 - audioKbps - 500 : 48000 - audioKbps - 2000;
  const videoKbps = Math.min(spec.maxVideoKbps, budgetKbps, Math.floor(peakLimit / 100) * 100);
  if (videoKbps < 1000) throw fail('DISC_CAPACITY_EXCEEDED', '影片長度或音訊組數超過光碟容量；請縮短交付範圍或減少音訊組數');
  const audioArgs = audio.flatMap((stream, index) => [
    `-c:a:${index}`, 'ac3', `-b:a:${index}`, `${spec.audioKbps}k`, `-ar:a:${index}`, String(spec.sampleRate),
    ...(stream.layout === 'stereoLtRt' ? [`-dsur_mode:a:${index}`, 'on'] : []),
  ]);
  const rate = ['-b:v', `${videoKbps}k`, '-minrate:v', `${videoKbps}k`, '-maxrate:v', `${videoKbps}k`];
  if (format === 'dvd-iso') return {
    ...spec, videoKbps, sar: '32/27', plannedEncoder: 'mpeg2video',
    videoArgs: ['-c:v', 'mpeg2video', '-pix_fmt', 'yuv420p', '-g', '18', '-bf', '2', ...rate,
      '-bufsize:v', '1835008', '-flags:v', '+ilme+ildct', '-top', '1', '-aspect', spec.displayAspect],
    audioArgs,
    muxArgs: ['-f', 'dvd', '-muxrate', '10080k', '-packetsize', '2048'],
  };
  const keyint = Math.round(bdMode.fps);
  return {
    ...spec, ...bdMode, videoKbps, sar: '1/1', plannedEncoder: 'libx264',
    videoArgs: ['-c:v', 'libx264', '-preset', 'medium', '-profile:v', 'high', '-level:v', '4.1', '-pix_fmt', 'yuv420p',
      ...rate, '-bufsize:v', '30000k',
      ...(bdMode.scan === 'interlaced' ? ['-flags:v', '+ilme+ildct', '-top', '1'] : []),
      '-x264-params',
      `bluray-compat=1:ref=3:bframes=3:b-pyramid=strict:keyint=${keyint}:min-keyint=1:open-gop=0:aud=1:nal-hrd=cbr:force-cfr=1${bdMode.scan === 'interlaced' ? ':tff=1' : ''}`],
    audioArgs,
    muxArgs: ['-f', 'mpegts', '-mpegts_start_pid', '256', '-streamid', '0:256',
      ...audio.flatMap((_, index) => ['-streamid', `${index + 1}:${index + 257}`])],
  };
}

module.exports = { DISC_FORMATS, discFormat, discAudioStreams, discEncoding };
