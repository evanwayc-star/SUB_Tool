/* 交付音訊規格是匯出列自己的可序列化資料：它可選擇專案 bus、改變 stream 編組，
   卻不能暫時改寫正在播放中的 State.audioProject。這個模組刻意不讀 State／Media，
   讓交付列在開啟設定、取消或同時送出多份交付時都沒有隱藏的全域副作用。 */

const MAX_DELIVERY_AUDIO_BUSES = 1024;

function clone(value) {
  return value == null ? value : structuredClone(value);
}

/* 若交付列尚未儲存自己的音訊設定，從目前專案複製一次作為草稿；一旦已有紀錄，
   就只讀該列自己的 buses / streams。所有結果都是深複製，呼叫端可安全編輯。 */
function createDeliveryAudioSpec(projectAudio, deliveryRecord = {}) {
  const availableBuses = Array.isArray(projectAudio?.buses) ? projectAudio.buses : [];
  const availableById = new Map(availableBuses.map(bus => [String(bus?.id), bus]));
  const savedBuses = Array.isArray(deliveryRecord?.audioBuses) ? deliveryRecord.audioBuses : null;
  // 交付列只可選擇既有的專案 bus；已儲存的外觀欄位可覆蓋，但 id 必須仍存在。
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

/* 將送出當下重新編譯的母素材 plan 與某一交付列的 bus/stream 選擇合成。
   交付列只擁有編組資料，絕不可取代 compiled buses 的 inputs；否則主程序會把有聲的
   A7/A8 當作空 bus，最後以 anullsrc 交付靜音。 */
function composeDeliveryAudioPlan(compiledPlan, deliveryRecord = {}) {
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

/* 交付列可有自己的 bus 數量，但那只是這一列輸出選擇的草稿。縮減時只移除
   這份 spec 的 stream 參照；絕不清理專案 sourceMaps，避免取消交付設定後讓預覽斷音。 */
function resizeDeliveryAudioBuses(spec, rawCount) {
  const next = clone(spec || { buses: [], streams: [] });
  next.buses = Array.isArray(next.buses) ? next.buses : [];
  next.streams = Array.isArray(next.streams) ? next.streams : [];
  next.availableBuses = Array.isArray(next.availableBuses) ? next.availableBuses : [];
  const availableById = new Map(next.availableBuses.map(bus => [String(bus?.id), bus]));
  // Legacy callers that did not supply availability may still shrink, but may never invent a
  // delivery-only bus: unknown ids would otherwise become anullsrc in the export compiler.
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

/* 與專案層的預設規則相同，但只處理交付列草稿。既有自訂編組不會因重新開啟
   對話框而被補滿；只有完全沒有 stream 時才建立可交付的 Mono 預設。 */
function ensureDeliveryAudioExportDefaults(spec, { appendMissing = true } = {}) {
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

/* 將已編輯的純 spec 寫回單一交付列。不碰原物件，也保留列上格式、碼率、檔名等非音訊欄位。 */
function applyDeliveryAudioSpec(deliveryRecord = {}, spec = {}) {
  const next = clone(deliveryRecord) || {};
  next.audioBuses = clone(Array.isArray(spec.buses) ? spec.buses : []);
  next.audioPlan = {
    ...(clone(deliveryRecord?.audioPlan) || {}),
    streams: clone(Array.isArray(spec.streams) ? spec.streams : []),
  };
  if (Array.isArray(spec.wavBusIds)) next.wavBusIds = clone(spec.wavBusIds);
  return next;
}

export {
  MAX_DELIVERY_AUDIO_BUSES,
  applyDeliveryAudioSpec,
  composeDeliveryAudioPlan,
  createDeliveryAudioSpec,
  ensureDeliveryAudioExportDefaults,
  resizeDeliveryAudioBuses,
};
