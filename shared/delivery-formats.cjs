'use strict';

// 來源：fdst_MOD-FHD.cpf（Carbon Coder 3.20）。固定交付規格由 UI 與 main 共用。
const MOD_FHD = Object.freeze({
  format: 'mod-fhd', label: 'MOD-FHD', extension: '.ts',
  width: 1920, height: 1080, fps: 29.97, videoKbps: 7280,
  muxKbps: 7980, audioKbps: 256, sampleRate: 48000,
  videoPid: 4131, audioPid: 4130, pmtPid: 1280,
});

function getDeliveryFormatPreset(format) {
  return format === MOD_FHD.format ? MOD_FHD : null;
}

// 兩條 mono 可無損地編組為 L/R；其他多串流或 5.1 配置必須由使用者選擇。
// 不可直接取前兩條 bus，否則會安靜地丟掉主混音或 M&E。
function normalizeDeliveryPresetAudio(format, plan) {
  if (!getDeliveryFormatPreset(format) || !Array.isArray(plan?.streams)) return plan;
  const streams = plan.streams;
  if (streams.length !== 2 || !streams.every(s => s.layout === 'mono' && s.busIds?.length === 1)) return plan;
  const busIds = streams.flatMap(s => s.busIds);
  if (new Set(busIds).size !== 2) return plan;
  return { ...plan, streams: [{ id: 'mod-fhd-stereo', name: 'MOD-FHD Stereo', layout: 'stereo', busIds }] };
}

function deliveryPresetAudioProblem(format, plan) {
  if (!getDeliveryFormatPreset(format) || plan == null) return null;
  const normalized = normalizeDeliveryPresetAudio(format, plan);
  const streams = normalized.streams;
  // 沒有專案音訊 plan 時，既有交付流程會讀母素材或補雙聲道靜音。
  if (!Array.isArray(streams) && !Array.isArray(plan.buses)) return null;
  if (streams?.length === 1 && streams[0].layout === 'stereo'
      && streams[0].busIds?.length === 2 && new Set(streams[0].busIds).size === 2) return null;
  return 'MOD-FHD 需要單一 Stereo（2 聲道）；請在「音軌」選擇要交付的兩條專案音軌。';
}

module.exports = { MOD_FHD, getDeliveryFormatPreset, normalizeDeliveryPresetAudio, deliveryPresetAudioProblem };
