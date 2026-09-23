'use strict';

const { getDeliveryFormatPreset } = require('../shared/delivery-formats.cjs');
const { deliveryFrameRateRatio } = require('../shared/delivery-frame-rate.cjs');

// libtwolame primes 481 samples within its first 1152-sample MP2 frame.
// Fill the rest of that frame with silence so the transport can discard only
// that frame while preserving the first sample of the actual programme audio.
const S3K_AUDIO_PREROLL_SAMPLES = 1152 - 481;

// Carbon CPF codecs encoded directly into the Panasonic delivery transport.
// Keep codec arguments separate from output paths, mappings and the timeline graph.
function airlineEncoding(format) {
  const preset = getDeliveryFormatPreset(format);
  if (preset?.transport !== 'airline') return null;
  const { videoKbps, audioKbps, sampleRate, width, height } = preset;
  const size = `${width}x${height}`;
  const rate = deliveryFrameRateRatio(preset.fps);
  const muxArgs = airlineMuxArgs(format);
  if (format === 'airline-s3k') {
    return {
      plannedEncoder: 'mpeg1video', muxArgs,
      videoExtension: '.m1v',
      audioExtension: '.m1a',
      audioPrerollSamples: S3K_AUDIO_PREROLL_SAMPLES,
      // MPEG-1 aspect code 12 stores 1.0950 height/width, the inverse of SAR.
      // Compose in display space, then scale to the stored raster and set SAR.
      sar: '200/219',
      sampleAspectRatio: 200 / 219,
      displayAspect: '880/657',
      videoArgs: [
        '-c:v', 'mpeg1video', '-pix_fmt', 'yuv420p', '-s:v', size,
        '-r', rate, '-aspect:v', '880:657',
        '-b:v', `${videoKbps}k`, '-minrate:v', `${videoKbps}k`, '-maxrate:v', `${videoKbps}k`,
        '-bufsize:v', '1835008', '-g', '15', '-bf', '2', '-b_strategy', '0',
        '-drop_frame_timecode', '1',
        '-sc_threshold', '1000000000', '-flags:v', '-ildct-ilme-cgop',
      ],
      audioArgs: [
        '-c:a', 'libtwolame', '-b:a', `${audioKbps}k`, '-ar', String(sampleRate), '-ac', '2',
        '-sample_fmt', 's16', '-mode', 'stereo', '-error_protection', '1',
        '-copyright', '0', '-original', '0',
      ],
    };
  }
  return {
    plannedEncoder: 'libx264', muxArgs,
    videoExtension: '.h264',
    audioExtension: '.aac',
    // User-confirmed delivery: 720x480 displayed at exactly 16:9.
    // This intentionally overrides the reference sample's 40:33 SAR.
    sar: '32/27',
    sampleAspectRatio: 32 / 27,
    displayAspect: '16/9',
    videoArgs: [
      '-c:v', 'libx264', '-preset', 'medium', '-profile:v', 'main', '-level:v', '3.0',
      '-pix_fmt', 'yuv420p', '-s:v', size, '-r', rate,
      '-aspect:v', preset.displayAspect, '-b:v', `${videoKbps}k`, '-minrate:v', `${videoKbps}k`, '-maxrate:v', `${videoKbps}k`,
      // CPF bytes -> FFmpeg bits. libx264 internally uses whole kilobits.
      '-bufsize:v', String(Math.floor(1041616 * videoKbps / 1500)), '-flags:v', '-ildct-ilme',
      '-x264-params', [
        'interlaced=0', 'nal-hrd=cbr', 'filler=1', 'force-cfr=1', 'videoformat=ntsc', 'fullrange=off',
        'aud=1', 'repeat-headers=1', 'keyint=15', 'min-keyint=1', 'scenecut=40',
        'open-gop=0', 'ref=2', 'bframes=3', 'b-adapt=0', 'b-pyramid=none',
        'cabac=1', 'slices=1', 'weightp=0', 'weightb=0', 'no-deblock=1',
        // Psy RDO otherwise silently subtracts 2 from the signalled chroma QP.
        'chroma-qp-offset=1', 'psy=0', 'aq-mode=0', 'mbtree=0',
      ].join(':'),
    ],
    audioArgs: [
      // Windows Media Foundation AAC emits the first programme sample at the
      // video's start PTS, without the native AAC encoder's 1024-sample primer.
      '-c:a', 'aac_mf', '-b:a', `${audioKbps}k`,
      '-ar', String(sampleRate), '-ac', '2',
    ],
  };
}

function airlineTransportProfile(format = 'airline-dmpes') {
  const high = format === 'airline-dmpes-4m';
  return { muxRate: high ? 4600000 : 1855594,
    videoDrain: high ? 4800000 : 1799961.6,
    videoBuffer: format === 'airline-s3k' ? 229376 : high ? 347124 : 130124,
    initialLead: format === 'airline-s3k' ? 1 : 0.7 };
}

// FFmpeg produces PES timestamps; the final packet scheduler applies the
// decoder-buffer and transport-buffer constraints before publication.
function airlineMuxArgs(format) {
  return ['-mpegts_transport_stream_id', '1', '-mpegts_service_id', '1',
    '-mpegts_pmt_start_pid', '63', '-streamid', '0:48', '-streamid', '1:49',
    '-muxrate', String(airlineTransportProfile(format).muxRate), '-muxdelay', '1', '-pcr_period', '90', '-pat_period', '0.1',
    '-pes_payload_size', '0', '-mpegts_m2ts_mode', '0', '-f', 'mpegts'];
}

module.exports = { airlineEncoding, airlineMuxArgs, airlineTransportProfile, S3K_AUDIO_PREROLL_SAMPLES };
