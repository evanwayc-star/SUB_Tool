'use strict';

// 來源：Carbon CPF 與使用者提供的設定畫面。固定交付規格由 UI 與 main 共用。
const MOD_FHD = Object.freeze({
  format: 'mod-fhd', label: 'MOD-FHD', extension: '.ts',
  scan: 'interlaced', audioLabel: 'MPEG-2 AAC-LC / ADTS',
  width: 1920, height: 1080, fps: 29.97, videoKbps: 7280,
  muxKbps: 7980, audioKbps: 256, sampleRate: 48000,
  videoPid: 4131, audioPid: 4130, pmtPid: 1280,
});

const AIRLINE_EXW = Object.freeze({
  format: 'airline-exw', label: '航空-exW-H264-500K (立體聲)', fileLabel: '航空-exW-H264-500K', extension: '.mpg', transport: 'airline',
  displayAspect: '16:9', scan: 'progressive', audioLabel: 'AAC-LC / ADTS',
  width: 640, height: 360, fps: 29.97, videoKbps: 500, videoMaxKbps: 2000,
  videoBufferBytes: 125000, audioKbps: 64, sampleRate: 48000,
});

const AIRLINE_DMPES = Object.freeze({
  format: 'airline-dmpes', label: '航空-DMPES-H264-1.5M (立體聲)', fileLabel: '航空-DMPES-H264-1.5M', extension: '.mpg', transport: 'airline',
  displayAspect: '16:9',
  scan: 'progressive', audioLabel: 'AAC-LC / ADTS',
  width: 720, height: 480, fps: 29.97, videoKbps: 1500, muxBps: 1855594, audioKbps: 128, sampleRate: 48000,
});

const AIRLINE_DMPES_4M = Object.freeze({
  ...AIRLINE_DMPES,
  format: 'airline-dmpes-4m', label: '航空-DMPES-H264-4M (立體聲)', fileLabel: '航空-DMPES-H264-4M', videoKbps: 4000, muxBps: 4600000,
});

const DVD_ISO = Object.freeze({
  format: 'dvd-iso', label: 'DVD-ISO (4.5G)', fileLabel: 'DVD-ISO-4.5G', extension: '.iso', kind: 'disc',
  capacityBytes: 4500000000, maxVideoKbps: 8500, displayAspect: '16:9',
  scan: 'interlaced', width: 720, height: 480, fps: 29.97, videoKbps: null,
  audioLabel: 'AC-3', audioKbps: 384, sampleRate: 48000, maxAudioStreams: 8,
});

const BD_ISO = Object.freeze({
  format: 'bd-iso', label: 'BD-ISO (24G)', fileLabel: 'BD-ISO-24G', extension: '.iso', kind: 'disc',
  capacityBytes: 24000000000, maxVideoKbps: 30000, displayAspect: '16:9',
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

const MP3_BITRATES = Object.freeze([96, 128, 160, 192, 224, 256, 320]);

function normalizeMp3Kbps(value) {
  if (value == null) return 320;
  const kbps = Number(value);
  if (!MP3_BITRATES.includes(kbps)) throw new Error('MP3 音訊碼率不在支援範圍內。');
  return kbps;
}

const DELIVERY_FORMAT_PRESETS = Object.freeze([DVD_ISO, BD_ISO, MOD_FHD, AIRLINE_DMPES, AIRLINE_DMPES_4M, AIRLINE_EXW]);
const DELIVERY_FORMAT_OPTIONS = Object.freeze([
  Object.freeze({ format: 'prores', label: 'ProRes422HQ-MOV', extension: '.mov' }),
  Object.freeze({ format: 'h264', label: 'H264-MP4', extension: '.mp4' }),
  Object.freeze({ format: 'wav', label: 'WAV', extension: '.wav' }),
  Object.freeze({ format: 'mp3', label: 'MP3', extension: '.mp3' }),
  ...DELIVERY_FORMAT_PRESETS,
]);

function getDeliveryFormatPreset(format) {
  return DELIVERY_FORMAT_PRESETS.find(preset => preset.format === format) || null;
}

function getDeliveryFormatOption(format) {
  return DELIVERY_FORMAT_OPTIONS.find(option => option.format === format) || null;
}

function isAudioDeliveryFormat(format) {
  return format === 'wav' || format === 'mp3';
}

// 留 64 MiB 給光碟結構，並為封裝保留 8%。預估與實際編碼共用這個容量預算。
function discVideoKbps(preset, duration, streamCount) {
  const audioKbps = preset.audioKbps * streamCount;
  const budget = (preset.capacityBytes - 64 * 1024 * 1024) * 0.92 * 8 / duration / 1000 - audioKbps;
  const peak = preset.format === 'dvd-iso' ? 10080 - audioKbps - 500 : 48000 - audioKbps - 2000;
  return Math.floor(Math.min(preset.maxVideoKbps, budget, peak) / 100) * 100;
}

function aacKbps(channels) {
  return channels >= 6 ? 640 : channels >= 2 ? 320 : 192;
}

function validStreamBuses(stream, count) {
  return Number.isInteger(count) && Array.isArray(stream?.busIds) && stream.busIds.length === count
    && stream.busIds.every(id => typeof id === 'string' && id.trim().length > 0)
    && new Set(stream.busIds).size === count;
}

// 兩條 mono 可依序編組為 L/R。MP3 也能將單一 5.1 混為立體聲。
// 多套主混音、語言或 M&E 由使用者選定，不能擷取前兩條 bus 當作輸出。
function normalizeDeliveryPresetAudio(format, plan) {
  const preset = getDeliveryFormatPreset(format);
  if (format === 'mp3' && Array.isArray(plan?.buses) && (plan.streams == null || (Array.isArray(plan.streams) && !plan.streams.length))) {
    // WAV 快照只有選取順序；能無歧義重建的只有一或兩個聲道。
    const busIds = plan.buses.map(bus => bus?.id);
    if (busIds.length === 1 || busIds.length === 2) {
      return { ...plan, streams: [{ id: 'mp3-output', layout: busIds.length === 1 ? 'mono' : 'stereo', busIds }] };
    }
  }
  if ((format !== 'mp3' && !preset) || preset?.kind === 'disc' || !Array.isArray(plan?.streams)) return plan;
  const streams = plan.streams;
  if (streams.length !== 2 || !streams.every(s => s?.layout === 'mono' && validStreamBuses(s, 1))) return plan;
  const busIds = streams.flatMap(s => s.busIds);
  if (new Set(busIds).size !== 2) return plan;
  return { ...plan, streams: [{ id: `${format}-stereo`, name: `${preset?.label || 'MP3'} Stereo`, layout: 'stereo', busIds }] };
}

function deliveryPresetAudioProblem(format, plan) {
  const preset = getDeliveryFormatPreset(format);
  if (format === 'mp3') {
    const streams = normalizeDeliveryPresetAudio(format, plan)?.streams;
    const stream = Array.isArray(streams) && streams.length === 1 ? streams[0] : null;
    const channels = { mono: 1, stereo: 2, stereoLtRt: 2, '5.1': 6 };
    if (stream && validStreamBuses(stream, channels[stream.layout])) return null;
    return 'MP3 需要一組音軌，請在「音軌」選擇 Mono、Stereo、Lt/Rt 或一組 5.1（混為立體聲）。';
  }
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

// Return a planning estimate in decimal bytes. Encoded payload, mux headers and
// optical-disc authoring vary with the material, especially for ProRes and exW.
function estimateDeliveryBytes(spec) {
  if (!spec || !Number.isFinite(spec.duration) || spec.duration <= 0) return null;
  const { format, duration, audioPlan } = spec;
  const preset = getDeliveryFormatPreset(format);
  const streams = audioPlan?.streams ?? [{ layout: 'stereo' }];
  if (!Array.isArray(streams)) return null;
  const channels = streams.map(s => ({ mono: 1, stereo: 2, stereoLtRt: 2, '5.1': 6 })[s?.layout] || 0);
  const bytes = kbps => Math.round(kbps * 125 * duration);
  if (format === 'wav') {
    const count = audioPlan?.buses?.length;
    return count > 0 ? bytes(48 * 24 * count) : null;
  }
  if (format === 'mp3') {
    try { return bytes(normalizeMp3Kbps(spec.mp3Kbps)); } catch { return null; }
  }
  if (preset?.kind === 'disc') {
    const video = discVideoKbps(preset, duration, streams.length);
    if (video < 1000 || !streams.length || streams.length > preset.maxAudioStreams) return null;
    // Modeled 5% mux overhead plus a small filesystem / navigation allowance.
    return Math.min(preset.capacityBytes, bytes((video + preset.audioKbps * streams.length) * 1.05) + 1024 * 1024);
  }
  if (preset?.muxBps) return bytes(preset.muxBps / 1000);
  if (preset?.muxKbps) return bytes(preset.muxKbps);
  if (preset?.transport === 'airline') return bytes((preset.videoKbps + preset.audioKbps) * 1.05);
  if (!(spec.width > 0 && spec.height > 0)) return null;

  if (format === 'h264') {
    const video = spec.videoKbps;
    const encodedKbps = Math.max(100, Math.min(200000, Math.round(video || 5000)));
    return bytes(encodedKbps + channels.reduce((sum, n) => sum + aacKbps(n), 0));
  }
  if (format === 'prores') {
    // ProRes 422 HQ nominal target at 1920×1080 / 29.97 fps, plus 24-bit PCM.
    if (!(spec.fps > 0)) return null;
    const video = 220000 * spec.width * spec.height / (1920 * 1080) * spec.fps / 29.97;
    return bytes(video + channels.reduce((sum, n) => sum + 48 * 24 * n, 0));
  }
  return null;
}

function deliverySizeLabel(spec) {
  const bytes = estimateDeliveryBytes(spec);
  if (!(bytes > 0) || !Number.isFinite(bytes)) return '預估大小待確認';
  const [scale, unit] = bytes >= 1e9 ? [1e9, 'GB'] : bytes >= 1e6 ? [1e6, 'MB'] : [1e3, 'kB'];
  return `預估約 ${Number((bytes / scale).toFixed(1))} ${unit}`;
}

module.exports = {
  estimateDeliveryBytes, deliverySizeLabel,
  MOD_FHD, AIRLINE_EXW, AIRLINE_DMPES, AIRLINE_DMPES_4M, DVD_ISO, BD_ISO,
  MP3_BITRATES, normalizeMp3Kbps,
  discVideoKbps, aacKbps,
  BD_VIDEO_MODES, bdVideoMode, availableBdVideoModes,
  DELIVERY_FORMAT_PRESETS, DELIVERY_FORMAT_OPTIONS, getDeliveryFormatPreset, getDeliveryFormatOption,
  isAudioDeliveryFormat, normalizeDeliveryPresetAudio, deliveryPresetAudioProblem,
};
