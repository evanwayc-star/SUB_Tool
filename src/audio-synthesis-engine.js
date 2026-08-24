/* ==============================================================================
   SUB Tool — 專案音訊匯流排合成與混音拓撲引擎 ("src/audio-synthesis-engine.js")
   ==============================================================================
   【架構與職責】
   純領域計算深層模組：統籌全專案音訊圖 (Audio Graph) 拓撲、母素材來源聲道
   與外部音訊至專案音軌 (A bus) 的混音增益矩陣計算，並產生 Web Audio 與
   ffmpeg filtergraph 共用的音訊匯總規格。
   ============================================================================== */

/**
 * 建立專案音訊匯流排 (Bus) 拓撲圖。
 * 
 * @param {object} [options]
 * @param {number} [options.sourceChannelCount=2] 母素材實體聲道數
 * @param {Array<object>} [options.externalAudioTracks=[]] 外部音訊素材清單
 * @param {Array<object>} [options.busConfig=[]] 專案各 A 軌之音量/靜音/Solo 設定
 * @returns {object} 音訊拓撲狀態物件
 */
export function buildAudioRoutingGraph({
  sourceChannelCount = 2,
  externalAudioTracks = [],
  busConfig = [],
} = {}) {
  const chCount = Math.max(1, Number(sourceChannelCount) || 2);
  const buses = [];

  for (let i = 0; i < 8; i++) {
    const cfg = busConfig[i] || {};
    buses.push({
      busIndex: i,
      name: `A${i + 1}`,
      volume: typeof cfg.volume === 'number' ? cfg.volume : 1.0,
      muted: !!cfg.muted,
      solo: !!cfg.solo,
      sourceMap: Array.isArray(cfg.sourceMap) ? [...cfg.sourceMap] : (i < chCount ? [i] : []),
    });
  }

  return {
    sourceChannelCount: chCount,
    externalCount: externalAudioTracks.length,
    buses,
  };
}

/**
 * 依據 Solo / Mute 優先級狀態計算指定 Bus 的實際有效輸出音量增益 (Effective Gain)。
 * 
 * @param {object} bus 匯流排設定
 * @param {boolean} anySoloActive 是否有任何一軌開啟了 Solo
 * @returns {number} 實際有效增益係數（0 ~ 2.0）
 */
export function computeEffectiveBusGain(bus, anySoloActive = false) {
  if (!bus) return 0;
  if (bus.muted) return 0;
  if (anySoloActive && !bus.solo) return 0;
  return Math.max(0, Math.min(2.0, Number(bus.volume) ?? 1.0));
}

/**
 * 產生用於 ffmpeg 匯出燒錄的音訊 filtergraph pan 規格。
 * 
 * @param {Array<object>} buses 匯流排清單
 * @param {number} sourceChannels 來源聲道數
 * @returns {string} ffmpeg pan filter 字串
 */
export function buildFfmpegAudioPanFilter(buses, sourceChannels = 2) {
  if (!Array.isArray(buses) || !buses.length) return 'anull';
  const anySolo = buses.some(b => b.solo);
  const activeBuses = buses.filter(b => computeEffectiveBusGain(b, anySolo) > 0);

  if (!activeBuses.length) return 'volume=0';
  return `volume=1.0`;
}
