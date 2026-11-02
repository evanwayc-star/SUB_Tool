/* ==============================================================================
   SUB Tool — 音訊強限制器與 ITU-R BS.1770 平衡化執行環境
   (electron/audio-normalization-runtime.js)
   ============================================================================== */

'use strict';

const fs = require('node:fs');
const {
  normalizeLimiterOptions,
  normalizeAudioLimiterSpec,
  isAudioReportSilence,
  buildLimiterFilter,
  parseVolumeAnalysis,
} = require('../shared/audio-loudness.cjs');
const { sourceAudioClockFilter } = require('./media-source-clock.js');
const { buildAudioIngestPlan } = require('./media-intake-runtime.js');

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
  produceTemporaryFile = null,
  fingerprintSource = null,
  probe = null,
} = {}) {
  if (typeof createTempPath !== 'function' || typeof execute !== 'function') {
    throw new TypeError('音訊平衡化 runtime 缺少必要 adapter');
  }
  const sourceChanged = cause => Object.assign(new Error('母素材在音訊處理期間變更或無法核對', { cause }),
    { code: 'AUDIO_SOURCE_CHANGED' });
  const captureSource = async src => {
    if (!fingerprintSource) return null;
    try {
      const value = await fingerprintSource(src);
      if (typeof value !== 'string' || !value) throw new Error('母素材證據無效');
      return value;
    } catch (error) { throw sourceChanged(error); }
  };
  const verifySource = async (src, expected) => {
    if (expected !== null && await captureSource(src) !== expected) throw sourceChanged();
  };

  return {
    /**
     * 快速分析來源音訊聲量 (ITU-R BS.1770 / RMS)
     */
    async analyze(src, { duration = 0 } = {}) {
      if (typeof src !== 'string' || !src.trim()) {
        throw new TypeError('缺少有效的來源音訊路徑');
      }

      const sourceEvidence = fingerprintSource ? await captureSource(src) : null;
      const media = typeof probe === 'function' ? await probe(src) : null;
      // 面板顯示來源 MIX，沿波形的全部原始聲道等權／來源時鐘量測；
      // 這份混合報告不屬於 normalize() 的逐 stream 效果報告。
      const mix = media ? buildAudioIngestPlan(media.audio, { waveOnly: true }) : null;
      if (mix && !mix.waveLabel) throw new Error('母素材沒有可量測的音訊聲道');
      const analysisArgs = mix
        ? ['-filter_complex', [...mix.filters, `${mix.waveLabel}volumedetect,loudnorm=print_format=json[measurement]`].join(';'), '-map', '[measurement]', '-vn']
        : ['-af', 'volumedetect,loudnorm=print_format=json'];
      let stderr = '';
      await execute([
          '-hide_banner',
          '-i', src,
          ...analysisArgs,
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
      if (sourceEvidence !== null) await verifySource(src, sourceEvidence);
      const report = parseVolumeAnalysis(stderr);
      if (!report) throw new Error('音訊量測未產生有效的聲量資料');
      return report;
    },

    async normalize(src, rawOptions = {}, { duration = 0, onProgress = null, signal = null } = {}) {
      if (typeof src !== 'string' || !src.trim()) {
        throw new TypeError('缺少有效的來源音訊路徑');
      }

      const options = normalizeLimiterOptions(rawOptions);
      const sourceStream = rawOptions.sourceStream ?? 0;
      if (!Number.isInteger(sourceStream) || sourceStream < 0 || sourceStream > 255) throw new TypeError('無效的來源音訊串流');
      const check = () => { if (signal?.aborted) { const error = new Error('音訊工作已取消'); error.name = 'AbortError'; throw error; } };
      // Do not register an output name for a request that can never start.
      check();
      const outWav = createTempPath('wav');
      let ownedOutput = null;
      let sourceEvidence = null;
      const unsafe = () => Object.assign(new Error('音訊暫存輸出檔案身分已變更'), { code: 'UNSAFE_NORMALIZATION_OUTPUT' });
      const verifyOutput = () => {
        if (!ownedOutput) return;
        let current, opened;
        try { current = fs.lstatSync(outWav, { bigint: true }); opened = fs.fstatSync(ownedOutput.fd, { bigint: true }); }
        catch (_) { throw unsafe(); }
        if (!current.isFile() || current.isSymbolicLink() || !opened.isFile()
          || current.dev !== ownedOutput.owner.dev || current.ino !== ownedOutput.owner.ino
          || opened.dev !== ownedOutput.owner.dev || opened.ino !== ownedOutput.owner.ino) throw unsafe();
      };
      const run = async (args, executionOptions) => {
        check();
        if (sourceEvidence !== null) { await verifySource(src, sourceEvidence); check(); }
        verifyOutput();
        let child;
        const abort = () => child?.kill?.();
        signal?.addEventListener('abort', abort, { once: true });
        try {
          const writesOutput = ownedOutput && args.at(-1) === outWav;
          const actualArgs = writesOutput ? [...args.slice(0, -1), '-f', 'wav', 'fd:'] : args;
          const result = await execute(actualArgs, { ...executionOptions,
            ...(writesOutput ? { outputDescriptor: ownedOutput.fd } : {}),
            onProcess: process => { child = process; if (signal?.aborted) abort(); } });
          check();
          if (sourceEvidence !== null) { await verifySource(src, sourceEvidence); check(); }
          verifyOutput();
          return result;
        } finally { signal?.removeEventListener('abort', abort); }
      };
      const perform = async () => { try {
        check();
        if (fingerprintSource) { sourceEvidence = await captureSource(src); check(); }
        const media = typeof probe === 'function' ? await probe(src, { signal }) : null;
        check();
        if (sourceEvidence !== null) { await verifySource(src, sourceEvidence); check(); }
        // WAV 沒有母素材的容器時間戳；先完成母素材整段的聲量處理，再把
        // 輸出歸回影片來源第零秒，供原有片段 in/out 與 processed 預覽使用。
        // 已對齊的 processed WAV 探測值為零，不會重複移動原點。
        const clock = media?.video || media?.audio?.[sourceStream];
        const sourceDuration = Number(media?.duration);
        const outputClock = sourceAudioClockFilter(clock)
          + (sourceDuration > 0 && Number.isFinite(sourceDuration)
            ? `,apad=whole_dur=${sourceDuration.toFixed(6)},atrim=end=${sourceDuration.toFixed(6)}` : '');
        const outputFilter = effect => effect ? `${effect},${outputClock}` : outputClock;
        // 兩種模式都先量測完整母 stream，Peak 也須保留無聲保護與交付報告。
        let pass1Stderr = '';
        let pass1Succeeded = false;
        const pass1Filter = buildLimiterFilter({ ...options, isTruePeak: true }, null).filter;

        try {
          await run([
            '-y',
            '-hide_banner',
            '-i', src,
            '-map', `0:a:${sourceStream}`,
            '-vn',
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
          pass1Succeeded = true;
        } catch (err) {
          check();
          if (['UNSAFE_NORMALIZATION_OUTPUT', 'AUDIO_SOURCE_CHANGED'].includes(err?.code)) throw err;
          // 若 Pass 1 執行失敗，記錄警告並嘗試單遍處理
          console.warn('[audio-norm] Pass 1 分析失敗，退回單遍模式：', err);
        }

        // 不完整工作的 stderr 即使含有 JSON，也不能作為輸出或交付的量測證據。
        let report = pass1Succeeded ? extractLoudnormJson(pass1Stderr) : null;
        // 報告可能有短音訊無法量測的 -inf/inf，不能當成雙遍參數；單遍仍能處理。
        if (report && !isAudioReportSilence(report) &&
          !normalizeAudioLimiterSpec({ reports: { 0: report } }).reports?.[0]) report = null;

        // 無聲保護：若判定為純無聲或低於 -70 LKFS 門限，保持 0 dB 增益，不拉大底噪
        if (options.silenceProtection && report && isAudioReportSilence(report)) {
          await run([
            '-y',
            '-hide_banner',
            '-i', src,
            '-map', `0:a:${sourceStream}`,
            '-vn',
            '-af', outputFilter(null),
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

          return {
            outputPath: outWav,
            isSilence: true,
            report,
            options,
          };
        }

        if (options.isTruePeak) {
          // True Peak 正常音訊：執行 Pass 2
          const p2FilterObj = buildLimiterFilter(options, report);
          await run([
            '-y',
            '-hide_banner',
            '-i', src,
              '-map', `0:a:${sourceStream}`,
              '-vn',
            '-af', outputFilter(p2FilterObj.filter),
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

          return {
            outputPath: outWav,
            isSilence: false,
            report,
            options,
          };
        }

        // Peak 正常音訊仍使用 alimiter；量測報告隨效果保存供交付重建。
        const pFilterObj = buildLimiterFilter(options, report);
        await run([
          '-y',
          '-hide_banner',
          '-i', src,
              '-map', `0:a:${sourceStream}`,
              '-vn',
          '-af', outputFilter(pFilterObj.filter),
          '-c:a', 'pcm_s16le',
          outWav,
        ], {
          duration,
          jobId: 'limiter-peak',
          label: '套用強限制器 (Hard Limiter)',
          onProgress: p => {
            if (typeof onProgress === 'function') {
              const pct = Math.min(99, Math.round(45 + (p.pct || 0) * 0.54));
              onProgress({ ...p, pct, stage: 'peak', label: `套用強限制器 (${pct}%)` });
            }
          },
        });

        return {
          outputPath: outWav,
          isSilence: false,
          report,
          options,
        };
      } catch (error) {
        if (!produceTemporaryFile && typeof removeFile === 'function') { try { await removeFile(outWav); } catch (_) {} }
        check();
        throw error;
      } };
      let result;
      if (!produceTemporaryFile) result = await perform();
      else await produceTemporaryFile(outWav, async (_file, owner) => {
        let fd;
        try {
          const before = fs.lstatSync(outWav, { bigint: true });
          if (!owner || !before.isFile() || before.isSymbolicLink()
            || before.dev !== owner.dev || before.ino !== owner.ino) throw unsafe();
          fd = fs.openSync(outWav, 'r+');
          ownedOutput = { fd, owner };
          verifyOutput();
          result = await perform();
          check();
          verifyOutput();
        } finally {
          ownedOutput = null;
          if (fd !== undefined) fs.closeSync(fd);
        }
      });
      if (typeof onProgress === 'function') onProgress({ pct: 100, stage: 'done', label: '完成' });
      return result;
    },
  };
}

module.exports = {
  extractLoudnormJson,
  createAudioNormalizationRuntime,
};
