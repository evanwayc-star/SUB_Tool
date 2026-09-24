'use strict';

// 來源：Carbon CPF 與使用者提供的設定畫面。固定交付規格由 UI 與 main 共用。
const MOD_FHD = Object.freeze({
  format: 'mod-fhd', label: 'MOD-FHD', extension: '.ts',
  scan: 'interlaced', audioLabel: 'MPEG-2 AAC-LC / ADTS',
  width: 1920, height: 1080, fps: 29.97, videoKbps: 7280,
  muxKbps: 7980, audioKbps: 256, sampleRate: 48000,
  videoPid: 4131, audioPid: 4130, pmtPid: 1280,
});

const AIRLINE_S3K = Object.freeze({
  format: 'airline-s3k', label: '航空-S3K-MPEG1-1.5M (立體聲)', fileLabel: '航空-S3K-MPEG1-1.5M', extension: '.mpg', transport: 'airline',
  scan: 'progressive', audioLabel: 'MPEG-1 Audio Layer-2 / CRC',
  width: 352, height: 240, fps: 29.97, videoKbps: 1500, audioKbps: 128, sampleRate: 48000,
});

const AIRLINE_DMPES = Object.freeze({
  format: 'airline-dmpes', label: '航空-DMPES-H264-1.5M (立體聲)', fileLabel: '航空-DMPES-H264-1.5M', extension: '.mpg', transport: 'airline',
  displayAspect: '16:9',
  scan: 'progressive', audioLabel: 'AAC-LC / ADTS',
  width: 720, height: 480, fps: 29.97, videoKbps: 1500, audioKbps: 128, sampleRate: 48000,
});

const AIRLINE_DMPES_4M = Object.freeze({
  ...AIRLINE_DMPES,
  format: 'airline-dmpes-4m', label: '航空-DMPES-H264-4M (立體聲)', fileLabel: '航空-DMPES-H264-4M', videoKbps: 4000,
});

const DVD_ISO = Object.freeze({
  format: 'dvd-iso', label: 'DVD-ISO (4.5G)', fileLabel: 'DVD-ISO-4.5G', extension: '.iso', kind: 'disc',
  capacityBytes: 4500000000, displayAspect: '16:9',
  scan: 'interlaced', width: 720, height: 480, fps: 29.97, videoKbps: null,
  audioLabel: 'AC-3', audioKbps: 384, sampleRate: 48000, maxAudioStreams: 8,
});

const BD_ISO = Object.freeze({
  format: 'bd-iso', label: 'BD-ISO (24G)', fileLabel: 'BD-ISO-24G', extension: '.iso', kind: 'disc',
  capacityBytes: 24000000000, displayAspect: '16:9',
  scan: 'progressive', width: 1920, height: 1080, fps: 24, videoKbps: null,
  audioLabel: 'AC-3', audioKbps: 640, sampleRate: 48000, maxAudioStreams: 32,
});

// BD-ROM 1080p 僅支援電影格率；25／29.97 以 1080i 交付。產品上限為 29.97 FPS。
const BD_VIDEO_MODES = Object.freeze([
  [23.976, 1920, 1080, 'progressive', '1080p'],
  [24, 1920, 1080, 'progressive', '1080p'],
  [25, 1920, 1080, 'interlaced', '1080i50'],
  [29.97, 1920, 1080, 'interlaced', '1080i59.94'],
].map(([fps, width, height, scan, label]) => Object.freeze({ fps, width, height, scan, label })));

function bdVideoMode(fps) {
  const rate = Number(fps);
  return Number.isFinite(rate) ? BD_VIDEO_MODES.find(mode => Math.abs(mode.fps - rate) < 0.01) || null : null;
}

function availableBdVideoModes(projectFps) {
  const source = Number(projectFps);
  return BD_VIDEO_MODES.filter(mode => !Number.isFinite(source) || mode.fps + 0.001 >= source);
}

const DELIVERY_FORMAT_PRESETS = Object.freeze([DVD_ISO, BD_ISO, MOD_FHD, AIRLINE_DMPES, AIRLINE_DMPES_4M, AIRLINE_S3K]);
const DELIVERY_FORMAT_OPTIONS = Object.freeze([
  Object.freeze({ format: 'prores', label: 'ProRes422HQ-MOV', extension: '.mov' }),
  Object.freeze({ format: 'h264', label: 'H264-MP4', extension: '.mp4' }),
  Object.freeze({ format: 'wav', label: 'WAV', extension: '.wav' }),
  ...DELIVERY_FORMAT_PRESETS,
]);

function getDeliveryFormatPreset(format) {
  return DELIVERY_FORMAT_PRESETS.find(preset => preset.format === format) || null;
}

function getDeliveryFormatOption(format) {
  return DELIVERY_FORMAT_OPTIONS.find(option => option.format === format) || null;
}

function validStreamBuses(stream, count) {
  return Number.isInteger(count) && Array.isArray(stream?.busIds) && stream.busIds.length === count
    && stream.busIds.every(id => typeof id === 'string' && id.trim().length > 0)
    && new Set(stream.busIds).size === count;
}

// 兩條 mono 可無損地編組為 L/R；其他多串流或 5.1 配置必須由使用者選擇。
// 不可直接取前兩條 bus，否則會安靜地丟掉主混音或 M&E。
function normalizeDeliveryPresetAudio(format, plan) {
  const preset = getDeliveryFormatPreset(format);
  if (!preset || preset.kind === 'disc' || !Array.isArray(plan?.streams)) return plan;
  const streams = plan.streams;
  if (streams.length !== 2 || !streams.every(s => s?.layout === 'mono' && validStreamBuses(s, 1))) return plan;
  const busIds = streams.flatMap(s => s.busIds);
  if (new Set(busIds).size !== 2) return plan;
  return { ...plan, streams: [{ id: `${format}-stereo`, name: `${preset.label} Stereo`, layout: 'stereo', busIds }] };
}

function deliveryPresetAudioProblem(format, plan) {
  const preset = getDeliveryFormatPreset(format);
  if (!preset || plan == null) return null;
  const normalized = normalizeDeliveryPresetAudio(format, plan);
  const streams = normalized.streams;
  // 只有省略 plan 才能由主程序從母素材選取音訊；空或不合法的編組必須修正。
  if (preset.kind === 'disc') {
    const channels = { mono: 1, stereo: 2, stereoLtRt: 2, '5.1': 6 };
    if (Array.isArray(streams) && streams.length > 0 && streams.length <= preset.maxAudioStreams
        && streams.every(stream => validStreamBuses(stream, channels[stream?.layout]))) return null;
    return `${preset.label} 需要 1–${preset.maxAudioStreams} 條 Mono、Stereo、Lt/Rt 或 5.1 音訊串流；請在「音軌」設定完整的交付編組。`;
  }
  if (Array.isArray(streams) && streams.length === 1 && streams[0]?.layout === 'stereo'
      && validStreamBuses(streams[0], 2)) return null;
  return `${preset.label} 需要單一 Stereo（2 聲道）；請在「音軌」選擇要交付的兩條專案音軌。`;
}

module.exports = {
  MOD_FHD, AIRLINE_S3K, AIRLINE_DMPES, AIRLINE_DMPES_4M, DVD_ISO, BD_ISO,
  BD_VIDEO_MODES, bdVideoMode, availableBdVideoModes,
  DELIVERY_FORMAT_PRESETS, DELIVERY_FORMAT_OPTIONS, getDeliveryFormatPreset, getDeliveryFormatOption,
  normalizeDeliveryPresetAudio, deliveryPresetAudioProblem,
};
