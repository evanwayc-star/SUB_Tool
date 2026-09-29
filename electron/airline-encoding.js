'use strict';

const { getDeliveryFormatPreset } = require('../shared/delivery-formats.cjs');
const { deliveryFrameRateRatio } = require('../shared/delivery-frame-rate.cjs');

// Carbon CPF codecs encoded directly into the Panasonic delivery transport.
// Keep codec arguments separate from output paths, mappings and the timeline graph.
function airlineEncoding(format) {
  const preset = getDeliveryFormatPreset(format);
  if (preset?.transport !== 'airline') return null;
  const { videoKbps, audioKbps, sampleRate, width, height } = preset;
  const size = `${width}x${height}`;
  const rate = deliveryFrameRateRatio(preset.fps);
  const muxArgs = airlineMuxArgs(format);
  const exw = format === 'airline-exw';
  return {
    plannedEncoder: 'libx264', muxArgs,
    videoExtension: '.h264',
    audioExtension: '.aac',
    // exW is square-pixel 640x360; DMPES is anamorphic 720x480.
    sar: exw ? '1/1' : '32/27',
    sampleAspectRatio: exw ? 1 : 32 / 27,
    displayAspect: '16/9',
    videoArgs: [
      '-c:v', 'libx264', '-preset', 'medium', '-profile:v', 'main', '-level:v', '3.0',
      '-pix_fmt', 'yuv420p', '-s:v', size, '-r', rate,
      '-aspect:v', preset.displayAspect, '-b:v', `${videoKbps}k`,
      ...(exw ? [] : ['-minrate:v', `${videoKbps}k`]), '-maxrate:v', `${exw ? preset.videoMaxKbps : videoKbps}k`,
      // CPF bytes -> FFmpeg bits. libx264 internally uses whole kilobits.
      '-bufsize:v', String(exw ? preset.videoBufferBytes * 8 : Math.floor(1041616 * videoKbps / 1500)), '-flags:v', '-ildct-ilme',
      '-x264-params', [
        'interlaced=0', ...(exw ? [] : ['nal-hrd=cbr', 'filler=1']), 'force-cfr=1',
        // Keep exW picture timing explicit for both TSA6 and TSA7.
        ...(exw ? ['pic-struct=1'] : []), 'videoformat=ntsc', 'fullrange=off',
        // Early scene-cut IDRs make TSA6 infer reorder depth 4 and reject PTS;
        // fixed 15-frame GOPs keep both TSA6 and TSA7 at depth 2.
        'aud=1', 'repeat-headers=1', 'keyint=15', 'min-keyint=1',
        exw ? 'scenecut=0' : 'scenecut=40',
        'open-gop=0', 'ref=2', 'bframes=3', 'b-adapt=0', 'b-pyramid=none',
        'cabac=1', 'slices=1', 'weightp=0', 'weightb=0', 'no-deblock=1',
        // Psy RDO otherwise silently subtracts 2 from the signalled chroma QP.
        'chroma-qp-offset=1', 'psy=0', 'aq-mode=0', 'mbtree=0',
      ].join(':'),
    ],
    audioArgs: [
      // Media Foundation chooses HE-AAC at exW's 64 kbps, despite the CPF
      // disabling HE mode. The native encoder explicitly produces AAC-LC.
      '-c:a', exw ? 'aac' : 'aac_mf',
      ...(exw ? ['-profile:a', 'aac_low'] : []), '-b:a', `${audioKbps}k`,
      '-ar', String(sampleRate), '-ac', '2',
    ],
  };
}

function airlineTransportProfile(format = 'airline-dmpes') {
  if (format === 'airline-exw') return {
    muxRate: 2500000, variableRate: true, videoDrain: 2400000,
    videoBuffer: 125000, initialLead: 0.4, audioLead: 0.35,
  };
  const high = format === 'airline-dmpes-4m';
  return { muxRate: high ? 4600000 : 1855594,
    videoDrain: high ? 4800000 : 1799961.6,
    videoBuffer: high ? 347124 : 130124, initialLead: 0.7, audioLead: 0.1 };
}

// FFmpeg produces PES timestamps; the final packet scheduler applies the
// decoder-buffer and transport-buffer constraints before publication.
function airlineMuxArgs(format) {
  const profile = airlineTransportProfile(format);
  return ['-mpegts_transport_stream_id', '1', '-mpegts_service_id', '1',
    '-mpegts_pmt_start_pid', '63', '-streamid', '0:48', '-streamid', '1:49',
    ...(profile.variableRate ? [] : ['-muxrate', String(profile.muxRate)]),
    '-muxdelay', '1', '-pcr_period', '90', '-pat_period', '0.1',
    '-pes_payload_size', '0', '-mpegts_m2ts_mode', '0', '-f', 'mpegts'];
}

module.exports = { airlineEncoding, airlineMuxArgs, airlineTransportProfile };
