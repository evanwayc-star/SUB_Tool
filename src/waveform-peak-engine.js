/* ==============================================================================
   SUB Tool — 音訊波形峰值運算與降採樣引擎 ("src/waveform-peak-engine.js")
   ==============================================================================
   【架構與職責】
   純領域計算深層模組：以 TypedArray 極速演算法由原始音訊 PCM 數據中萃取
   最小/最大峰值 (Min/Max Peaks)，並支援多解析度多層級 LOD 降採樣運算。
   ============================================================================== */

/**
 * 從單聲道 Float32Array PCM 樣本陣列中萃取指定解析度的 Min/Max 峰值數據。
 * 
 * @param {Float32Array} channelData 單聲道 PCM 採樣數據
 * @param {number} sampleRate 音訊採樣率 (Hz)
 * @param {number} targetPeaksPerSec 目標每秒峰值採樣點數 (例如 100)
 * @returns {Float32Array} 萃取出的 Min/Max 陣列 [min0, max0, min1, max1, ...]
 */
export function extractChannelPeaks(channelData, sampleRate, targetPeaksPerSec = 100) {
  if (!channelData || !channelData.length || sampleRate <= 0 || targetPeaksPerSec <= 0) {
    return new Float32Array(0);
  }

  const blockSize = Math.max(1, Math.floor(sampleRate / targetPeaksPerSec));
  const numBlocks = Math.floor(channelData.length / blockSize);
  const peaks = new Float32Array(numBlocks * 2);

  for (let i = 0; i < numBlocks; i++) {
    const start = i * blockSize;
    const end = Math.min(channelData.length, start + blockSize);
    let min = 1.0;
    let max = -1.0;

    for (let j = start; j < end; j++) {
      const v = channelData[j];
      if (v < min) min = v;
      if (v > max) max = v;
    }

    peaks[i * 2] = min > max ? 0 : min;
    peaks[i * 2 + 1] = min > max ? 0 : max;
  }

  return peaks;
}

/**
 * 將高解析度峰值陣列降採樣至較低解析度（用於時間軸廣域縮放）。
 * 
 * @param {Float32Array} sourcePeaks 來源峰值陣列 [min0, max0, ...]
 * @param {number} factor 降採樣因子（整數，如 2, 4, 8）
 * @returns {Float32Array} 降採樣後的峰值陣列
 */
export function downsamplePeaks(sourcePeaks, factor = 2) {
  if (!sourcePeaks || !sourcePeaks.length || factor <= 1) {
    return sourcePeaks ? new Float32Array(sourcePeaks) : new Float32Array(0);
  }

  const f = Math.max(1, Math.floor(factor));
  const sourceCount = Math.floor(sourcePeaks.length / 2);
  const targetCount = Math.floor(sourceCount / f);
  const result = new Float32Array(targetCount * 2);

  for (let i = 0; i < targetCount; i++) {
    let min = 1.0;
    let max = -1.0;
    const start = i * f;
    const end = start + f;

    for (let j = start; j < end; j++) {
      const mn = sourcePeaks[j * 2];
      const mx = sourcePeaks[j * 2 + 1];
      if (mn < min) min = mn;
      if (mx > max) max = mx;
    }

    result[i * 2] = min;
    result[i * 2 + 1] = max;
  }

  return result;
}
