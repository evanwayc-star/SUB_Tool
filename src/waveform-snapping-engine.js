/* ==============================================================================
   SUB Tool — 音訊波形能量特徵智慧磁吸引擎 ("src/waveform-snapping-engine.js")
   ==============================================================================
   【架構與職責】
   純領域計算引擎：分析音訊波形 Peaks 峰值數據，自動辨識語音能量起始點
   (Onsets) 與結束點 (Offsets)，在時間軸拖曳或微調字幕邊緣時提供智慧磁吸：
   1. 波形能量轉折點偵測 (detectWaveformTransients)
   2. 最近波形吸附點計算 (findNearestWaveformSnap)
   ============================================================================== */

/**
 * 從音訊波形 Peak 陣列中偵測語音能量轉折點（語音起點與終點）。
 * 
 * @param {Float32Array|Array<number>} peaks 波形峰值陣列（格式：[min0, max0, min1, max1, ...]）
 * @param {number} samplesPerSec 每秒對應的 Peak 採樣點數（Waveform Resolution）
 * @param {object} [options]
 * @param {number} [options.threshold=0.08] 判定為有聲的能量閾值（0~1）
 * @param {number} [options.minSilenceDuration=0.12] 最小無聲間隙判定秒數
 * @returns {Array<{time: number, type: 'onset'|'offset', energy: number}>} 能量轉折點清單
 */
export function detectWaveformTransients(peaks, samplesPerSec, {
  threshold = 0.08,
  minSilenceDuration = 0.12,
} = {}) {
  if (!peaks || peaks.length < 2 || !samplesPerSec || samplesPerSec <= 0) return [];
  const count = Math.floor(peaks.length / 2);
  const minSilenceBlocks = Math.max(1, Math.round(minSilenceDuration * samplesPerSec));
  const transients = [];

  let inSpeech = false;
  let silenceBlocks = minSilenceBlocks; // 初始假設前段為無聲

  for (let i = 0; i < count; i++) {
    const mn = peaks[i * 2];
    const mx = peaks[i * 2 + 1];
    const energy = Math.max(Math.abs(mn), Math.abs(mx));
    const isLoud = energy >= threshold;
    const time = i / samplesPerSec;

    if (!inSpeech && isLoud && silenceBlocks >= minSilenceBlocks) {
      inSpeech = true;
      silenceBlocks = 0;
      transients.push({
        time,
        type: 'onset',
        energy,
      });
    } else if (inSpeech && !isLoud) {
      silenceBlocks++;
      if (silenceBlocks >= minSilenceBlocks) {
        inSpeech = false;
        // 記錄回到無聲的起始時間
        const offsetTime = Math.max(0, (i - minSilenceBlocks + 1) / samplesPerSec);
        transients.push({
          time: offsetTime,
          type: 'offset',
          energy,
        });
      }
    } else if (inSpeech && isLoud) {
      silenceBlocks = 0;
    } else {
      silenceBlocks++;
    }
  }

  return transients;
}

/**
 * 尋找距離指定目標時間最近的波形特徵吸附點。
 * 
 * @param {number} targetTime 目標時間（秒）
 * @param {Array<{time: number, type: string}>} transients 能量轉折點清單
 * @param {number} [snapThresholdSec=0.08] 最大允許磁吸容差半徑（秒）
 * @returns {{snappedTime: number, diff: number, type: string}|null} 吸附結果或 null
 */
export function findNearestWaveformSnap(targetTime, transients, snapThresholdSec = 0.08) {
  if (!Array.isArray(transients) || !transients.length) return null;
  const t = Number(targetTime) || 0;
  const threshold = Math.max(0.001, Number(snapThresholdSec) || 0.08);

  let best = null;
  let minDiff = Infinity;

  for (const item of transients) {
    const diff = Math.abs(item.time - t);
    if (diff <= threshold && diff < minDiff) {
      minDiff = diff;
      best = {
        snappedTime: item.time,
        diff: item.time - t,
        type: item.type,
      };
    }
  }

  return best;
}
