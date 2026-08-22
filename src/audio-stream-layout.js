/* ==============================================================================
   SUB Tool — 匯出音訊 Stream 聲道佈局修復器 (Audio Export Stream Layout Repairer)
   ==============================================================================
   【架構與職責】
   防禦專案載入或 Bus 大小調整時出現的 Stream 聲道數與 Bus 數量不一致：
   - 匯出設定聲稱的 Layout 寬度（mono: 1, stereo: 2, 5.1: 6）必須與實際指派的 `busIds` 數量相符。
   - 若不相符，自動安全降級拆分為合法的 mono/stereo stream，避免在 Electron FFmpeg 編譯期拋錯。
   ============================================================================== */

/** 各聲道佈局名稱與所需聲道數寬度對應表 */
const OUTPUT_LAYOUT_WIDTH = Object.freeze({
  mono: 1,
  stereo: 2,
  stereoLtRt: 2,
  '5.1': 6,
});

/**
 * 檢查並修復音訊匯出 Stream 清單中的佈局配置。
 * 
 * @param {Array<object>} rawStreams 原始 Stream 設定陣列
 * @returns {Array<object>} 修復後的合法 Stream 設定陣列
 */
function repairAudioExportStreams(rawStreams) {
  const streams = Array.isArray(rawStreams) ? rawStreams : [];
  const reservedIds = new Set(streams.map(stream => stream?.id).filter(Boolean));
  const emittedIds = new Set();

  const uniqueGeneratedId = base => {
    let index = 1;
    let id = `${base}-mono-${index}`;
    while (reservedIds.has(id) || emittedIds.has(id)) {
      id = `${base}-mono-${++index}`;
    }
    emittedIds.add(id);
    return id;
  };

  const withoutMisleadingName = stream => {
    const { name, ...rest } = stream || {};
    return rest;
  };

  const repaired = [];
  for (const stream of streams) {
    const busIds = Array.isArray(stream?.busIds) ? stream.busIds : [];
    if (!busIds.length) continue;

    const expected = OUTPUT_LAYOUT_WIDTH[stream?.layout];
    if (expected === busIds.length) {
      repaired.push(stream);
      if (stream.id) emittedIds.add(stream.id);
      continue;
    }

    const base = withoutMisleadingName(stream);
    if (busIds.length === 1) {
      repaired.push({ ...base, layout: 'mono', busIds: [busIds[0]] });
      if (base.id) emittedIds.add(base.id);
      continue;
    }

    if (busIds.length === 2) {
      repaired.push({ ...base, layout: 'stereo', busIds: busIds.slice() });
      if (base.id) emittedIds.add(base.id);
      continue;
    }

    busIds.forEach((busId, index) => {
      const id = index === 0 && base.id ? base.id : uniqueGeneratedId(base.id || 'out');
      emittedIds.add(id);
      repaired.push({ ...base, id, layout: 'mono', busIds: [busId] });
    });
  }

  return repaired;
}

export { OUTPUT_LAYOUT_WIDTH, repairAudioExportStreams };
