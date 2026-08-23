/* ==============================================================================
   SUB Tool — Export Job & Safety Engine ("src/export-job-engine.js")
   ==============================================================================
   深層匯出作業規劃、檔案路徑安全與能力檢查引擎 (Export Job Engine)。
   負責匯出檔名淨化、平台視訊匯出能力判定與交付音訊規格合成：
   1. 樣式與檔案匯出路徑安全淨化 (sanitizeFolderSegment / sanitizeFileNameSegment / presetExportRelativePath)
   2. 桌面版能力檢查與命令執行 (videoExportCapability / runVideoExportCommand / WEB_VIDEO_EXPORT_MESSAGE)
   3. 交付列音訊規格合成與 WAV 萃取判定 (MAX_DELIVERY_AUDIO_BUSES / createDeliveryAudioSpec / composeDeliveryAudioPlan / resizeDeliveryAudioBuses / ensureDeliveryAudioExportDefaults / applyDeliveryAudioSpec)
   ============================================================================== */

const FORBIDDEN_CHARS = /[<>:"/\\|?*]/g;

/**
 * 淨化資料夾/分組名稱段落（去除禁用字元，將純點 `.` 或 `..` 替換為底線）。
 */
export function sanitizeFolderSegment(name) {
  return String(name || '').replace(FORBIDDEN_CHARS, '_').replace(/^\.+$/, '_');
}

/**
 * 淨化檔案名稱段落（去除禁用字元）。
 */
export function sanitizeFileNameSegment(name) {
  return String(name || '').replace(FORBIDDEN_CHARS, '_');
}

/**
 * 產生樣式匯出時的相對路徑字串 (`分組/樣式名稱.json`)。
 */
export function presetExportRelativePath(preset) {
  const safeGroup = sanitizeFolderSegment(preset?.group || '');
  const folder = safeGroup ? `${safeGroup}/` : '';
  const safeName = sanitizeFileNameSegment(preset?.name || '');
  return `${folder}${safeName}.json`;
}

export const WEB_VIDEO_EXPORT_MESSAGE = '網頁版不支援影片／多聲道 WAV 交付，請使用 Electron 桌面版';

/**
 * 檢查當前平台是否具備視訊交付匯出能力。
 */
export function videoExportCapability(isDesktop) {
  return isDesktop
    ? Object.freeze({ supported: true, message: '' })
    : Object.freeze({ supported: false, message: WEB_VIDEO_EXPORT_MESSAGE });
}

/**
 * 執行開啟視訊匯出對話框之命令。
 */
export async function runVideoExportCommand({
  isDesktop,
  openExport,
  notify = () => {},
  reportError = () => {},
} = {}) {
  const capability = videoExportCapability(isDesktop);
  if (!capability.supported) {
    notify(capability.message);
    return false;
  }
  try {
    if (typeof openExport === 'function') {
      await openExport();
    }
    return true;
  } catch (error) {
    reportError(error);
    return false;
  }
}

export const MAX_DELIVERY_AUDIO_BUSES = 1024;

function clone(value) {
  return value == null ? value : structuredClone(value);
}

/**
 * 建立交付列音訊規格草稿。
 */
export function createDeliveryAudioSpec(projectAudio, deliveryRecord = {}) {
  const availableBuses = Array.isArray(projectAudio?.buses) ? projectAudio.buses : [];
  const availableById = new Map(availableBuses.map(bus => [String(bus?.id), bus]));
  const savedBuses = Array.isArray(deliveryRecord?.audioBuses) ? deliveryRecord.audioBuses : null;
  const buses = savedBuses
    ? savedBuses.filter(bus => availableById.has(String(bus?.id))).map(bus => ({ ...availableById.get(String(bus.id)), ...bus }))
    : availableBuses;
  const streams = Array.isArray(deliveryRecord?.audioPlan?.streams)
    ? deliveryRecord.audioPlan.streams
    : (Array.isArray(projectAudio?.exportLayout?.streams) ? projectAudio.exportLayout.streams : []);
  const spec = { buses: clone(buses), streams: clone(streams), availableBuses: clone(availableBuses) };
  if (Array.isArray(deliveryRecord?.wavBusIds)) spec.wavBusIds = clone(deliveryRecord.wavBusIds);
  return spec;
}

/**
 * 將編譯後的音訊計畫與特定交付列設定進行合成。
 */
export function composeDeliveryAudioPlan(compiledPlan, deliveryRecord = {}) {
  if (!compiledPlan) return null;
  const finalPlan = clone(compiledPlan);
  const savedBuses = deliveryRecord?.audioBuses;
  if (Array.isArray(savedBuses)) {
    const inputsById = new Map(finalPlan.buses.map(bus => [String(bus.id), bus.inputs]));
    const unknownIds = savedBuses
      .map(bus => String(bus?.id || ''))
      .filter(id => id && !inputsById.has(id));
    if (unknownIds.length) {
      throw new Error(`交付音訊設定引用不存在的專案音軌：${unknownIds.join(', ')}`);
    }
    finalPlan.buses = savedBuses.map(bus => ({
      ...clone(bus),
      inputs: clone(inputsById.get(String(bus?.id)) || []),
    }));
  }
  if (Array.isArray(deliveryRecord?.audioPlan?.streams)) {
    finalPlan.streams = clone(deliveryRecord.audioPlan.streams);
  }
  if (deliveryRecord?.format === 'wav' && Array.isArray(deliveryRecord.wavBusIds)) {
    const busesById = new Map(finalPlan.buses.map(bus => [String(bus.id), bus]));
    const seen = new Set();
    finalPlan.buses = deliveryRecord.wavBusIds
      .map(id => String(id))
      .filter(id => id && !seen.has(id) && (seen.add(id), true))
      .map(id => busesById.get(id))
      .filter(Boolean);
  }
  return finalPlan;
}

function _nextDeliveryId(prefix, values) {
  const used = new Set(values.map(value => String(value?.id || value)));
  let index = 1;
  let id = `${prefix}${index}`;
  while (used.has(id)) id = `${prefix}${++index}`;
  return id;
}

export function resizeDeliveryAudioBuses(spec, rawCount) {
  const next = clone(spec || { buses: [], streams: [] });
  next.buses = Array.isArray(next.buses) ? next.buses : [];
  next.streams = Array.isArray(next.streams) ? next.streams : [];
  next.availableBuses = Array.isArray(next.availableBuses) ? next.availableBuses : [];
  const availableById = new Map(next.availableBuses.map(bus => [String(bus?.id), bus]));
  next.buses = next.buses.filter(bus => availableById.has(String(bus?.id)));
  const count = Math.max(0, Math.min(MAX_DELIVERY_AUDIO_BUSES, availableById.size, Math.floor(Number(rawCount) || 0)));
  if (count < next.buses.length) {
    next.buses = next.buses.slice(0, count);
    const available = new Set(next.buses.map(bus => String(bus.id)));
    next.streams = next.streams
      .map(stream => ({ ...stream, busIds: (Array.isArray(stream?.busIds) ? stream.busIds : []).filter(id => available.has(String(id))) }))
      .filter((stream, index) => stream.busIds.length || index === 0);
  }
  while (next.buses.length < count) {
    const existing = new Set(next.buses.map(bus => String(bus.id)));
    const available = next.availableBuses.find(bus => !existing.has(String(bus?.id)));
    if (!available) break;
    next.buses.push(clone(available));
  }
  return next;
}

export function ensureDeliveryAudioExportDefaults(spec, { appendMissing = true } = {}) {
  const next = clone(spec || { buses: [], streams: [] });
  next.buses = Array.isArray(next.buses) ? next.buses : [];
  next.streams = Array.isArray(next.streams) ? next.streams : [];
  if (!next.streams.length) {
    const used = [];
    next.streams = next.buses.map(bus => {
      const id = _nextDeliveryId('delivery-stream-', used);
      used.push({ id });
      return { id, layout: 'mono', busIds: [bus.id] };
    });
    return next;
  }
  if (appendMissing) {
    const assigned = new Set(next.streams.flatMap(stream => Array.isArray(stream?.busIds) ? stream.busIds.map(String) : []));
    const used = next.streams;
    for (const bus of next.buses) {
      if (!assigned.has(String(bus.id))) {
        const id = _nextDeliveryId('delivery-stream-', used);
        used.push({ id });
        next.streams.push({ id, layout: 'mono', busIds: [bus.id] });
      }
    }
  }
  return next;
}

export function applyDeliveryAudioSpec(deliveryRecord = {}, spec = {}) {
  const next = clone(deliveryRecord) || {};
  next.audioBuses = clone(Array.isArray(spec.buses) ? spec.buses : []);
  next.audioPlan = {
    ...(clone(deliveryRecord?.audioPlan) || {}),
    streams: clone(Array.isArray(spec.streams) ? spec.streams : []),
  };
  if (Array.isArray(spec.wavBusIds)) next.wavBusIds = clone(spec.wavBusIds);
  return next;
}

export function isSingleDeliveryJobWavAudioOnly(job) {
  return job?.format === 'wav';
}
