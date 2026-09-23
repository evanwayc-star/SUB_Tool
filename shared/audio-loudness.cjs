/* ==============================================================================
   SUB Tool — 音訊強限制器與 ITU-R BS.1770 響度純邏輯 (shared/audio-loudness.cjs)
   ==============================================================================
   renderer 與 Electron main 共用的純規則模組。
   零相依、純 CommonJS，不讀寫全域狀態、不做 I/O。
   支援 Adobe Audition 風格 Hard Limiter 與 ITU-R BS.1770 True Peak 響度標準化。
============================================================================== */

'use strict';

const LIMITER_DB_RANGE = Object.freeze({ min: -50, max: -1 });

// 可保存的來源效果；播放快取與工作進度永遠不屬於此快照。
function normalizeAudioLimiterSpec(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const options = normalizeLimiterOptions({
    maximumAmplitude: spec.max ?? spec.maximumAmplitude,
    targetLoudness: spec.min ?? spec.targetLoudness,
    inputBoost: spec.inputBoost ?? Math.abs(Number(spec.max ?? -6) - Number(spec.min ?? -12)),
    lookAheadTime: spec.lookAhead ?? spec.lookAheadTime,
    releaseTime: spec.release ?? spec.releaseTime,
    isTruePeak: spec.isTruePeak,
    linkChannels: spec.linkChannels,
  });
  const reports = {};
  for (const [stream, report] of Object.entries(spec.reports || {})) {
    if (!/^\d+$/.test(stream) || Number(stream) > 255 || !report || typeof report !== 'object') continue;
    const safe = {};
    for (const key of ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset']) {
      const value = Number(report[key]);
      if (Number.isFinite(value)) safe[key] = value;
      else if (String(report[key]).toLowerCase() === '-inf') safe[key] = '-inf';
    }
    if (Object.keys(safe).length === 5) reports[stream] = safe;
  }
  return {
    max: options.maximumAmplitude, min: options.targetLoudness, inputBoost: options.inputBoost,
    lookAhead: options.lookAheadTime, release: options.releaseTime,
    isTruePeak: options.isTruePeak, linkChannels: options.linkChannels, silenceProtection: true,
    ...(Object.keys(reports).length ? { reports } : {}),
  };
}

function audioLimiterSnapshot(source) {
  const spec = source?.hasAudioLimiter !== false && normalizeAudioLimiterSpec(source?.audioLimiterSpec);
  return spec ? { hasAudioLimiter: true, audioLimiterSpec: spec } : {};
}

function restoreAudioLimiterState(target, saved) {
  const snapshot = audioLimiterSnapshot(saved);
  delete target.hasAudioLimiter;
  delete target.audioLimiterSpec;
  delete target.audioLimiterLabel;
  Object.assign(target, snapshot);
  if (snapshot.hasAudioLimiter) target.audioLimiterLabel = `${snapshot.audioLimiterSpec.max} dB`;
}

function audioMotherPath(source) {
  return source?._originalPath || source?.path || null;
}

function audioLimiterFilter(spec, sourceStream = 0) {
  const normalized = normalizeAudioLimiterSpec(spec);
  if (!normalized) return 'anull';
  return buildLimiterFilter({
    maximumAmplitude: normalized.max, targetLoudness: normalized.min, inputBoost: normalized.inputBoost,
    lookAheadTime: normalized.lookAhead, releaseTime: normalized.release,
    isTruePeak: normalized.isTruePeak, linkChannels: normalized.linkChannels,
  }, normalized.reports?.[String(sourceStream)] || null).filter;
}

const HARD_LIMITER_PRESETS = Object.freeze([
  {
    id: 'limit_minus_1db',
    label: '提高限制到 -1 db',
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
    id: 'limit_minus_6db',
    label: '提高限制到 -6 db',
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
    id: 'limit_minus_12db',
    label: '提高限制到 -12 db',
    maximumAmplitude: -12.0,
    inputBoost: 0.0,
    targetLoudness: -18.0,
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
  const maximumAmplitude = _clamp(raw.maximumAmplitude, LIMITER_DB_RANGE.min, LIMITER_DB_RANGE.max, -6.0);
  const inputBoost = _clamp(raw.inputBoost, -100, 50, 0.0);
  const targetLoudness = _clamp(raw.targetLoudness, LIMITER_DB_RANGE.min, LIMITER_DB_RANGE.max, -12.0);
  const isTruePeak = raw.isTruePeak !== false; // 預設使用 True Peak (ITU 1770)
  const lookAheadTime = _clamp(raw.lookAheadTime, 1, 50, 7); // ms
  const releaseTime = _clamp(raw.releaseTime, 10, 1000, 100); // ms
  const linkChannels = raw.linkChannels !== false; // 預設 true
  const silenceProtection = true; // 固定保留無聲保護；保留欄位相容性，忽略舊專案的 false
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
  if (String(report.input_i).toLowerCase() === '-inf' || String(report.input_tp).toLowerCase() === '-inf') return true;
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
    // loudnorm 的 I 上限為 -5 LUFS、TP 下限為 -9 dBTP。以中間 I / TP 和後級增益
    // 支援完整 UI 範圍；兩者無法同時達成時優先保留峰值上限，原始目標值不被改寫。
    // Pass 1 / 2 使用相同中間目標，量測的輸入值不需換算。
    const postGain = Math.min(maxAmp + 9, Math.max(0, norm.targetLoudness + 5));
    const loudnormPeak = maxAmp - postGain;
    // 自訂目標若高於低峰值上限可實現的範圍，仍須遵守 loudnorm 的 I 上限 -5。
    const loudnormTarget = Math.min(-5, norm.targetLoudness - postGain);
    const postFilter = postGain !== 0 ? `,volume=${postGain.toFixed(2)}dB` : '';
    
    // 若已有 Pass 1 測量結果，組裝精準 Two-Pass loudnorm
    if (measuredReport) {
      const parts = [
        `loudnorm=I=${loudnormTarget.toFixed(1)}`,
        `TP=${loudnormPeak.toFixed(1)}`,
        `LRA=${lra.toFixed(1)}`,
        `measured_I=${Number(measuredReport.input_i ?? -24).toFixed(1)}`,
        `measured_TP=${Number(measuredReport.input_tp ?? -2).toFixed(1)}`,
        `measured_LRA=${Number(measuredReport.input_lra ?? 7).toFixed(1)}`,
        `measured_thresh=${Number(measuredReport.input_thresh ?? -34).toFixed(1)}`,
        `offset=${Number(measuredReport.target_offset || 0).toFixed(2)}`,
        'linear=true',
        'print_format=summary',
      ];
      return {
        filter: parts.join(':') + postFilter,
        isSilence: false,
        gainOffset: Number(measuredReport.target_offset || 0),
        mode: 'itu1770_two_pass',
      };
    }

    // 單遍 Pass 1 或即時模式
    const parts = [
      `loudnorm=I=${loudnormTarget.toFixed(1)}`,
      `TP=${loudnormPeak.toFixed(1)}`,
      `LRA=${lra.toFixed(1)}`,
      'linear=true',
      'print_format=json',
    ];
    return {
      filter: parts.join(':') + postFilter,
      isSilence: false,
      gainOffset: 0,
      mode: 'itu1770_single_pass',
    };
  }

  // 3. Peak 模式 (Hard Limiter: alimiter)
  // alimiter 的 limit 下限為 0.0625。較低上限須前級提高、後級等量衰減，
  // 使低於上限的聲音仍只套用原 inputBoost；關閉 auto level，避免峰值被拉回 0 dB。
  const nativeLimit = Math.max(0.0625, limitLinear);
  const postGain = linearToDb(limitLinear / nativeLimit);
  const inputGain = boost - postGain;
  const gainDigits = postGain < 0 ? 6 : 2;
  const filterParts = [];
  if (postGain < 0 || Math.abs(inputGain) > 0.01) {
    filterParts.push(`volume=${inputGain.toFixed(gainDigits)}dB`);
  }
  filterParts.push(`alimiter=limit=${nativeLimit.toFixed(6)}:attack=${norm.lookAheadTime}:release=${norm.releaseTime}:asc=0:level=false`);
  if (postGain < 0) {
    filterParts.push(`volume=${postGain.toFixed(gainDigits)}dB`);
  }

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
  normalizeAudioLimiterSpec,
  audioLimiterSnapshot,
  restoreAudioLimiterState,
  audioMotherPath,
  audioLimiterFilter,
  LIMITER_DB_RANGE,
  HARD_LIMITER_PRESETS,
  dbToLinear,
  linearToDb,
  normalizeLimiterOptions,
  isAudioReportSilence,
  buildLimiterFilter,
  analyzePeaksLoudness,
  parseVolumeAnalysis,
};
