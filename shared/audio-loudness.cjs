/* ==============================================================================
   SUB Tool — 音訊強限制器與 ITU-R BS.1770 響度純邏輯 (shared/audio-loudness.cjs)
   ==============================================================================
   renderer 與 Electron main 共用的純規則模組。
   零相依、純 CommonJS，不讀寫全域狀態、不做 I/O。
   支援 Adobe Audition 風格 Hard Limiter 與 ITU-R BS.1770 True Peak 響度標準化。
============================================================================== */

'use strict';

const HARD_LIMITER_PRESETS = Object.freeze([
  {
    id: 'balance_minus_12_to_minus_6',
    label: '整體平衡 (-12 dB ~ -6 dB，建議)',
    maximumAmplitude: -6.0,
    inputBoost: 6.0,
    targetLoudness: -12.0,
    isTruePeak: true,
    lookAheadTime: 7,
    releaseTime: 100,
    linkChannels: true,
    silenceProtection: true,
  },
  {
    id: 'limit_minus_6db',
    label: '限制至 -6 dB (強限制器)',
    maximumAmplitude: -6.0,
    inputBoost: 0.0,
    targetLoudness: -12.0,
    isTruePeak: true,
    lookAheadTime: 7,
    releaseTime: 100,
    linkChannels: true,
    silenceProtection: true,
  },
  {
    id: 'limit_minus_3db',
    label: '限制至 -3 dB (保留動態)',
    maximumAmplitude: -3.0,
    inputBoost: 0.0,
    targetLoudness: -14.0,
    isTruePeak: true,
    lookAheadTime: 7,
    releaseTime: 100,
    linkChannels: true,
    silenceProtection: true,
  },
  {
    id: 'limit_minus_1db',
    label: '限制至 -1 dB (防止破音削波)',
    maximumAmplitude: -1.0,
    inputBoost: 0.0,
    targetLoudness: -14.0,
    isTruePeak: true,
    lookAheadTime: 5,
    releaseTime: 100,
    linkChannels: true,
    silenceProtection: true,
  },
  {
    id: 'streaming_youtube',
    label: 'YouTube 串流標準 (-14 LUFS / -1 dBTP)',
    maximumAmplitude: -1.0,
    inputBoost: 0.0,
    targetLoudness: -14.0,
    isTruePeak: true,
    lookAheadTime: 7,
    releaseTime: 100,
    linkChannels: true,
    silenceProtection: true,
  },
  {
    id: 'broadcast_ebu_r128',
    label: '電視廣播標準 EBU R128 (-23 LUFS / -1 dBTP)',
    maximumAmplitude: -1.0,
    inputBoost: 0.0,
    targetLoudness: -23.0,
    isTruePeak: true,
    lookAheadTime: 7,
    releaseTime: 100,
    linkChannels: true,
    silenceProtection: true,
  },
]);

function _clamp(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * dB 轉換為線性振幅倍率 (Linear Amplitude Ratio)
 * 0 dB -> 1.0, -6 dB -> ~0.501187, -12 dB -> ~0.251189
 */
function dbToLinear(db) {
  const n = Number(db);
  if (!Number.isFinite(n) || n <= -100) return 0;
  return Math.pow(10, n / 20);
}

/**
 * 線性振幅倍率轉換為 dB
 */
function linearToDb(linear) {
  const n = Number(linear);
  if (!Number.isFinite(n) || n <= 0.00000001) return -100;
  return 20 * Math.log10(n);
}

/**
 * 正規化限制器／平衡化參數
 */
function normalizeLimiterOptions(raw = {}) {
  const maximumAmplitude = _clamp(raw.maximumAmplitude, -100, 0, -6.0);
  const inputBoost = _clamp(raw.inputBoost, -100, 50, 0.0);
  const targetLoudness = _clamp(raw.targetLoudness, -70, -5, -12.0);
  const isTruePeak = raw.isTruePeak !== false; // 預設使用 True Peak (ITU 1770)
  const lookAheadTime = _clamp(raw.lookAheadTime, 1, 50, 7); // ms
  const releaseTime = _clamp(raw.releaseTime, 10, 1000, 100); // ms
  const linkChannels = raw.linkChannels !== false; // 預設 true
  const silenceProtection = raw.silenceProtection !== false; // 預設 true（無聲維持 0dB）
  const preset = typeof raw.preset === 'string' ? raw.preset : '';

  return {
    maximumAmplitude: +maximumAmplitude.toFixed(2),
    inputBoost: +inputBoost.toFixed(2),
    targetLoudness: +targetLoudness.toFixed(2),
    isTruePeak,
    lookAheadTime: Math.round(lookAheadTime),
    releaseTime: Math.round(releaseTime),
    linkChannels,
    silenceProtection,
    preset,
  };
}

/**
 * 判斷 Pass 1 量測報告是否屬於無聲（Silence / Extreme Low Level）
 * ITU-R BS.1770 絕對門限為 -70 LKFS。若低於 -70 或全無聲，應保持 0 dB 增益，避免拉大底噪。
 */
function isAudioReportSilence(report) {
  if (!report || typeof report !== 'object') return false;
  const i = Number(report.input_i);
  const thresh = Number(report.input_thresh);
  const tp = Number(report.input_tp);

  // 若 input_i <= -70 或 input_thresh <= -70 或 input_tp <= -90，判定為無聲
  if (Number.isFinite(i) && i <= -70) return true;
  if (Number.isFinite(thresh) && thresh <= -70) return true;
  if (Number.isFinite(tp) && tp <= -90) return true;
  return false;
}

/**
 * 構建 FFmpeg 濾鏡參數
 * @param {Object} opts 正規化後的選項
 * @param {Object} [measuredReport] Pass 1 量測結果（若有，則進行精準 Two-Pass 或無聲保護）
 */
function buildLimiterFilter(opts, measuredReport = null) {
  const norm = normalizeLimiterOptions(opts);
  const maxAmp = norm.maximumAmplitude;
  const limitLinear = Math.max(0.00001, Math.min(1.0, dbToLinear(maxAmp)));
  const boost = norm.inputBoost;

  // 1. 若有測量報告且已偵測為無聲，且啟用了無聲保護：維持 0 dB 增益（pass-through 不放大）
  if (norm.silenceProtection && measuredReport && isAudioReportSilence(measuredReport)) {
    return {
      filter: 'anull',
      isSilence: true,
      gainOffset: 0,
      mode: 'silence_bypass',
    };
  }

  // 2. True Peak 模式 (ITU-R BS.1770)
  if (norm.isTruePeak) {
    const lra = Math.max(1, Math.min(50, Math.round(Math.abs(maxAmp - norm.targetLoudness)) || 6));
    
    // 若已有 Pass 1 測量結果，組裝精準 Two-Pass loudnorm
    if (measuredReport) {
      const parts = [
        `loudnorm=I=${norm.targetLoudness.toFixed(1)}`,
        `TP=${maxAmp.toFixed(1)}`,
        `LRA=${lra.toFixed(1)}`,
        `measured_I=${Number(measuredReport.input_i || -24).toFixed(1)}`,
        `measured_TP=${Number(measuredReport.input_tp || -2).toFixed(1)}`,
        `measured_LRA=${Number(measuredReport.input_lra || 7).toFixed(1)}`,
        `measured_thresh=${Number(measuredReport.input_thresh || -34).toFixed(1)}`,
        `offset=${Number(measuredReport.target_offset || 0).toFixed(2)}`,
        'linear=true',
        'print_format=summary',
      ];
      return {
        filter: parts.join(':'),
        isSilence: false,
        gainOffset: Number(measuredReport.target_offset || 0),
        mode: 'itu1770_two_pass',
      };
    }

    // 單遍 Pass 1 或即時模式
    const parts = [
      `loudnorm=I=${norm.targetLoudness.toFixed(1)}`,
      `TP=${maxAmp.toFixed(1)}`,
      `LRA=${lra.toFixed(1)}`,
      'linear=true',
      'print_format=json',
    ];
    return {
      filter: parts.join(':'),
      isSilence: false,
      gainOffset: 0,
      mode: 'itu1770_single_pass',
    };
  }

  // 3. Peak 模式 (Hard Limiter: alimiter)
  // alimiter 濾鏡：limit=線性振幅, attack=ms, release=ms, asc=0 (手動模式)
  const filterParts = [];
  if (Math.abs(boost) > 0.01) {
    filterParts.push(`volume=${boost.toFixed(2)}dB`);
  }
  filterParts.push(`alimiter=limit=${limitLinear.toFixed(6)}:attack=${norm.lookAheadTime}:release=${norm.releaseTime}:asc=0`);

  return {
    filter: filterParts.join(','),
    isSilence: false,
    gainOffset: boost,
    mode: 'hard_limiter_peak',
  };
}

/**
 * 根據波形 peaks (Float32Array [min0, max0, min1, max1, ...]) 進行快速估算
 * 回傳最大、平均與最小有效聲量 (dB)
 */
function analyzePeaksLoudness(peaks) {
  if (!peaks || !peaks.length) {
    return {
      maxDb: -100,
      meanDb: -100,
      minDb: -100,
      dynamicRangeDb: 0,
      isSilence: true,
      sampleCount: 0,
    };
  }

  const n = Math.floor(peaks.length / 2);
  let maxAbs = 0;
  let sumSquare = 0;
  const bucketEnergies = [];

  for (let i = 0; i < n; i++) {
    const mn = peaks[i * 2];
    const mx = peaks[i * 2 + 1];
    const absVal = Math.max(Math.abs(mn), Math.abs(mx));
    if (absVal > maxAbs) maxAbs = absVal;

    const energy = Math.sqrt((mn * mn + mx * mx) / 2);
    sumSquare += energy * energy;
    if (energy > 0.0001) { // 排除純靜音 (-80dB 以下)
      bucketEnergies.push(energy);
    }
  }

  const rms = Math.sqrt(sumSquare / Math.max(1, n));
  const maxDb = maxAbs > 0.00001 ? +(20 * Math.log10(maxAbs)).toFixed(1) : -100;
  const meanDb = rms > 0.00001 ? +(20 * Math.log10(rms)).toFixed(1) : -100;

  let minDb = -100;
  if (bucketEnergies.length > 0) {
    bucketEnergies.sort((a, b) => a - b);
    // 取非靜音段落中較弱的第 5 百分位數作為底層門限聲量
    const p5Idx = Math.floor(bucketEnergies.length * 0.05);
    const floorEnergy = bucketEnergies[p5Idx] || bucketEnergies[0];
    minDb = +(20 * Math.log10(floorEnergy)).toFixed(1);
  }

  const isSilence = maxDb <= -70 || meanDb <= -70;
  const dynamicRangeDb = isSilence ? 0 : Math.max(0, +(maxDb - minDb).toFixed(1));

  return {
    maxDb,
    meanDb,
    minDb,
    dynamicRangeDb,
    isSilence,
    sampleCount: n,
  };
}

/**
 * 解析 FFmpeg volumedetect 與 loudnorm json 輸出報告
 */
function parseVolumeAnalysis(stderrText) {
  if (typeof stderrText !== 'string' || !stderrText) {
    return null;
  }

  // 1. 嘗試解析 loudnorm json
  let loudnormData = null;
  const jsonMatch = stderrText.match(/\{\s*"input_i"[\s\S]*?"target_offset"[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      loudnormData = JSON.parse(jsonMatch[0]);
    } catch (_) {}
  }

  // 2. 嘗試解析 volumedetect
  let maxVolume = null;
  let meanVolume = null;
  const maxMatch = stderrText.match(/max_volume:\s*([-+]?\d+(?:\.\d+)?)\s*dB/);
  if (maxMatch) maxVolume = parseFloat(maxMatch[1]);
  const meanMatch = stderrText.match(/mean_volume:\s*([-+]?\d+(?:\.\d+)?)\s*dB/);
  if (meanMatch) meanVolume = parseFloat(meanMatch[1]);

  // 3. 整合最精確的指標
  const maxDb = loudnormData?.input_tp != null
    ? +parseFloat(loudnormData.input_tp).toFixed(1)
    : (maxVolume != null ? +maxVolume.toFixed(1) : -100);

  const meanDb = loudnormData?.input_i != null
    ? +parseFloat(loudnormData.input_i).toFixed(1)
    : (meanVolume != null ? +meanVolume.toFixed(1) : -100);

  let minDb = -100;
  if (loudnormData?.input_thresh != null) {
    minDb = +parseFloat(loudnormData.input_thresh).toFixed(1);
  } else if (meanVolume != null) {
    minDb = +Math.max(-90, meanVolume - 20).toFixed(1);
  }

  let dynamicRangeDb = 0;
  if (loudnormData?.input_lra != null) {
    dynamicRangeDb = +parseFloat(loudnormData.input_lra).toFixed(1);
  } else if (maxDb > -90 && minDb > -90) {
    dynamicRangeDb = Math.max(0, +(maxDb - minDb).toFixed(1));
  }

  const isSilence = maxDb <= -70 || meanDb <= -70;

  return {
    maxDb,
    meanDb,
    minDb,
    dynamicRangeDb,
    isSilence,
    rawLoudnorm: loudnormData,
  };
}

module.exports = {
  HARD_LIMITER_PRESETS,
  dbToLinear,
  linearToDb,
  normalizeLimiterOptions,
  isAudioReportSilence,
  buildLimiterFilter,
  analyzePeaksLoudness,
  parseVolumeAnalysis,
};
