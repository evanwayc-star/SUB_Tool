/* ==============================================================================
   SUB Tool — 音訊強限制器與 ITU-R BS.1770 平衡化執行環境
   (electron/audio-normalization-runtime.js)
   ============================================================================== */

'use strict';

const {
  normalizeLimiterOptions,
  isAudioReportSilence,
  buildLimiterFilter,
  parseVolumeAnalysis,
} = require('../shared/audio-loudness.cjs');

function extractLoudnormJson(stderrText) {
  if (typeof stderrText !== 'string') return null;
  const match = stderrText.match(/\{\s*"input_i"[\s\S]*?"target_offset"[\s\S]*?\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (e) {
    return null;
  }
}

function createAudioNormalizationRuntime({
  createTempPath,
  execute,
  removeFile,
} = {}) {
  if (typeof createTempPath !== 'function' || typeof execute !== 'function') {
    throw new TypeError('音訊平衡化 runtime 缺少必要 adapter');
  }

  return {
    /**
     * 快速分析來源音訊聲量 (ITU-R BS.1770 / RMS)
     */
    async analyze(src, { duration = 0 } = {}) {
      if (typeof src !== 'string' || !src.trim()) {
        throw new TypeError('缺少有效的來源音訊路徑');
      }

      let stderr = '';
      try {
        await execute([
          '-hide_banner',
          '-i', src,
          '-af', 'volumedetect,loudnorm=print_format=json',
          '-f', 'null',
          '-',
        ], {
          duration,
          jobId: 'audio-volume-analyze',
          label: '量測音訊聲量 (ITU 1770 / RMS)',
          onStderr: chunk => {
            stderr += chunk;
          },
        });
      } catch (err) {
        console.warn('[audio-norm] 快速量測 stderr 截取：', err.message || err);
      }

      return parseVolumeAnalysis(stderr);
    },

    async normalize(src, rawOptions = {}, { duration = 0, onProgress = null } = {}) {
      if (typeof src !== 'string' || !src.trim()) {
        throw new TypeError('缺少有效的來源音訊路徑');
      }

      const options = normalizeLimiterOptions(rawOptions);
      const outWav = createTempPath('wav');

      // 1. True Peak 模式：兩遍分析 (Two-Pass) 確保 ITU-R BS.1770 精準度與無聲保護
      if (options.isTruePeak) {
        let pass1Stderr = '';
        const pass1Filter = buildLimiterFilter(options, null).filter;

        try {
          await execute([
            '-y',
            '-hide_banner',
            '-i', src,
            '-af', pass1Filter,
            '-f', 'null',
            '-',
          ], {
            duration,
            jobId: 'loudnorm-p1',
            label: '分析音訊響度 (Pass 1)',
            onStderr: chunk => {
              pass1Stderr += chunk;
            },
            onProgress: p => {
              if (typeof onProgress === 'function') {
                const mappedPct = Math.min(45, Math.round((p.pct || 0) * 0.45));
                onProgress({ ...p, pct: mappedPct, stage: 'pass1', label: `分析音訊響度 (${mappedPct}%)` });
              }
            },
          });
        } catch (err) {
          // 若 Pass 1 執行失敗，記錄警告並嘗試單遍處理
          console.warn('[audio-norm] Pass 1 分析失敗，退回單遍模式：', err);
        }

        const report = extractLoudnormJson(pass1Stderr);

        // 無聲保護：若判定為純無聲或低於 -70 LKFS 門限，保持 0 dB 增益，不拉大底噪
        if (options.silenceProtection && report && isAudioReportSilence(report)) {
          await execute([
            '-y',
            '-hide_banner',
            '-i', src,
            '-c:a', 'pcm_s16le',
            outWav,
          ], {
            duration,
            jobId: 'loudnorm-p2-silence',
            label: '無聲保護輸出 (維持 0 dB)',
            onProgress: p => {
              if (typeof onProgress === 'function') {
                const mappedPct = Math.min(99, Math.round(45 + (p.pct || 0) * 0.54));
                onProgress({ ...p, pct: mappedPct, stage: 'silence', label: `無聲保護輸出 (${mappedPct}%)` });
              }
            },
          });

          if (typeof onProgress === 'function') {
            onProgress({ pct: 100, stage: 'done', label: '完成' });
          }

          return {
            outputPath: outWav,
            isSilence: true,
            report,
            options,
          };
        }

        // 正常音訊：執行 Pass 2
        const p2FilterObj = buildLimiterFilter(options, report);
        await execute([
          '-y',
          '-hide_banner',
          '-i', src,
          '-af', p2FilterObj.filter,
          '-c:a', 'pcm_s16le',
          outWav,
        ], {
          duration,
          jobId: 'loudnorm-p2',
          label: '套用平衡化效果 (Pass 2)',
          onProgress: p => {
            if (typeof onProgress === 'function') {
              const mappedPct = Math.min(99, Math.round(45 + (p.pct || 0) * 0.54));
              onProgress({ ...p, pct: mappedPct, stage: 'pass2', label: `套用平衡化 (${mappedPct}%)` });
            }
          },
        });

        if (typeof onProgress === 'function') {
          onProgress({ pct: 100, stage: 'done', label: '完成' });
        }

        return {
          outputPath: outWav,
          isSilence: false,
          report,
          options,
        };
      }

      // 2. Peak 模式 (Hard Limiter：直接使用 alimiter)
      const pFilterObj = buildLimiterFilter(options, null);
      await execute([
        '-y',
        '-hide_banner',
        '-i', src,
        '-af', pFilterObj.filter,
        '-c:a', 'pcm_s16le',
        outWav,
      ], {
        duration,
        jobId: 'limiter-peak',
        label: '套用強限制器 (Hard Limiter)',
        onProgress: p => {
          if (typeof onProgress === 'function') {
            const pct = Math.min(99, Math.round(p.pct || 0));
            onProgress({ ...p, pct, stage: 'peak', label: `套用強限制器 (${pct}%)` });
          }
        },
      });

      if (typeof onProgress === 'function') {
        onProgress({ pct: 100, stage: 'done', label: '完成' });
      }

      return {
        outputPath: outWav,
        isSilence: false,
        report: null,
        options,
      };
    },
  };
}

module.exports = {
  extractLoudnormJson,
  createAudioNormalizationRuntime,
};
