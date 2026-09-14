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
  format: 'airline-s3k', label: '航空-S3K', extension: '.mpg', transport: 'airline',
  scan: 'progressive', audioLabel: 'MPEG-1 Audio Layer-2 / CRC',
  width: 352, height: 240, fps: 29.97, videoKbps: 1500, audioKbps: 128, sampleRate: 48000,
});

const AIRLINE_DMPES = Object.freeze({
  format: 'airline-dmpes', label: '航空-DMPES', extension: '.mpg', transport: 'airline',
  displayAspect: '16:9',
  scan: 'progressive', audioLabel: 'AAC-LC / ADTS',
  width: 720, height: 480, fps: 29.97, videoKbps: 1500, audioKbps: 128, sampleRate: 48000,
});

const DELIVERY_FORMAT_PRESETS = Object.freeze([MOD_FHD, AIRLINE_S3K, AIRLINE_DMPES]);

function getDeliveryFormatPreset(format) {
  return DELIVERY_FORMAT_PRESETS.find(preset => preset.format === format) || null;
}

// 每份交付輸出單一成品；航空影音在 SubTool 內合成為 .mpg。
// 只推導檔名，路徑解析與寫入授權仍由主程序負責。
function deliveryOutputNames(_format, primaryName) {
  return [String(primaryName || '')];
}

// 兩條 mono 可無損地編組為 L/R；其他多串流或 5.1 配置必須由使用者選擇。
// 不可直接取前兩條 bus，否則會安靜地丟掉主混音或 M&E。
function normalizeDeliveryPresetAudio(format, plan) {
  const preset = getDeliveryFormatPreset(format);
  if (!preset || !Array.isArray(plan?.streams)) return plan;
  const streams = plan.streams;
  if (streams.length !== 2 || !streams.every(s => s.layout === 'mono' && s.busIds?.length === 1)) return plan;
  const busIds = streams.flatMap(s => s.busIds);
  if (new Set(busIds).size !== 2) return plan;
  return { ...plan, streams: [{ id: `${format}-stereo`, name: `${preset.label} Stereo`, layout: 'stereo', busIds }] };
}

function deliveryPresetAudioProblem(format, plan) {
  const preset = getDeliveryFormatPreset(format);
  if (!preset || plan == null) return null;
  const normalized = normalizeDeliveryPresetAudio(format, plan);
  const streams = normalized.streams;
  // 沒有專案音訊 plan 時，既有交付流程會讀母素材或補雙聲道靜音。
  if (!Array.isArray(streams) && !Array.isArray(plan.buses)) return null;
  if (streams?.length === 1 && streams[0].layout === 'stereo'
      && streams[0].busIds?.length === 2 && new Set(streams[0].busIds).size === 2) return null;
  return `${preset.label} 需要單一 Stereo（2 聲道）；請在「音軌」選擇要交付的兩條專案音軌。`;
}

module.exports = {
  MOD_FHD, AIRLINE_S3K, AIRLINE_DMPES, DELIVERY_FORMAT_PRESETS, getDeliveryFormatPreset,
  deliveryOutputNames, normalizeDeliveryPresetAudio, deliveryPresetAudioProblem,
};
