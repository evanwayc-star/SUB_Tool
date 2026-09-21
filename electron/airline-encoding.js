'use strict';

// Carbon CPF codecs encoded directly into the Panasonic delivery transport.
// Keep codec arguments separate from output paths, mappings and the timeline graph.
function airlineEncoding(format) {
  if (format === 'airline-s3k') {
    return {
      videoExtension: '.m1v',
      audioExtension: '.m1a',
      // MPEG-1 aspect code 12 stores 1.0950 height/width, the inverse of SAR.
      // Compose in display space, then scale to the stored raster and set SAR.
      sar: '200/219',
      sampleAspectRatio: 200 / 219,
      displayAspect: '880/657',
      videoArgs: [
        '-c:v', 'mpeg1video', '-pix_fmt', 'yuv420p', '-s:v', '352x240',
        '-r', '30000/1001', '-aspect:v', '880:657',
        '-b:v', '1500k', '-minrate:v', '1500k', '-maxrate:v', '1500k',
        '-bufsize:v', '1835008', '-g', '15', '-bf', '2', '-b_strategy', '0',
        '-sc_threshold', '1000000000', '-flags:v', '-ildct-ilme-cgop',
      ],
      audioArgs: [
        '-c:a', 'libtwolame', '-b:a', '128k', '-ar', '48000', '-ac', '2',
        '-sample_fmt', 's16', '-mode', 'stereo', '-error_protection', '1',
        '-copyright', '0', '-original', '0',
      ],
    };
  }
  if (!['airline-dmpes', 'airline-dmpes-4m'].includes(format)) return null;
  const videoKbps = format === 'airline-dmpes-4m' ? 4000 : 1500;
  return {
    videoExtension: '.h264',
    audioExtension: '.aac',
    // User-confirmed delivery: 720x480 displayed at exactly 16:9.
    // This intentionally overrides the reference sample's 40:33 SAR.
    sar: '32/27',
    sampleAspectRatio: 32 / 27,
    displayAspect: '16/9',
    videoArgs: [
      '-c:v', 'libx264', '-preset', 'medium', '-profile:v', 'main', '-level:v', '3.0',
      '-pix_fmt', 'yuv420p', '-s:v', '720x480', '-r', '30000/1001',
      '-aspect:v', '16:9', '-b:v', `${videoKbps}k`, '-minrate:v', `${videoKbps}k`, '-maxrate:v', `${videoKbps}k`,
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
      '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '128k',
      '-ar', '48000', '-ac', '2',
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

module.exports = { airlineEncoding, airlineMuxArgs, airlineTransportProfile };
