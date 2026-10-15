'use strict';

/* 單份交付工作的完整交易：讀 frozen ASS、probe、建立交付計畫、執行 ffmpeg、
   回報 queue 終態並清理暫存。Electron main 只負責提供真實 adapters。 */

const fs = require('fs');
const path = require('path');
const QueueStore = require('./queue-store');
const { getDeliveryFormatPreset } = require('../shared/delivery-formats.cjs');
const { buildDeliveryArgv } = require('./export-plan');

function failureProgress({ stopped = false, shutdown = false, error = null } = {}) {
  const partialCleanup = error?.code === 'PARTIAL_CLEANUP_FAILED'
    || error?.watchdogResult?.cleanup?.retainedLease;
  if (stopped) {
    if (partialCleanup) return { error: true, errorMsg: error?.message || String(error) };
    return { stopped: true };
  }
  if (shutdown) return null;
  return { error: true, errorMsg: error?.message || String(error) };
}

function createDeliveryRunner(options = {}) {
  const queue = options.queue;
  const queueDir = options.queueDir;
  const tempDir = options.tempDir;
  const mediaProbe = options.mediaProbe;
  const runFfmpeg = options.runFfmpeg;
  const encoder = options.encoder || {};
  const fonts = options.fonts || {};
  const events = options.events || {};
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const sourceKey = source => {
    const resolved = path.resolve(source);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };

  if (!queue || typeof queue.reportProgress !== 'function') throw new TypeError('delivery runner 缺少 queue interface');
  if (typeof queueDir !== 'function') throw new TypeError('delivery runner 缺少 queueDir');
  if (typeof tempDir !== 'string' || !tempDir) throw new TypeError('delivery runner 缺少 tempDir');
  if (typeof mediaProbe !== 'function') throw new TypeError('delivery runner 缺少 mediaProbe adapter');
  if (typeof runFfmpeg !== 'function') throw new TypeError('delivery runner 缺少 ffmpeg adapter');

  function dispatch(target, jobId, event, data) {
    if (event === 'task-progress' && queue.reportProgress(jobId, data) === false) return false;
    const recipient = target || events.fallbackSender?.() || null;
    if (recipient) events.send?.(recipient, event, data);
    return true;
  }

  async function run(job) {
    const payload = job?.payload || {};
    const {
      clips, videoTracks, width, height, fps, format, duration, outPath, videoKbps,
      audioPlan: rawAudioPlan, timecodeWatermark: rawTimecodeWatermark,
    } = payload;
    const jobId = job.id;
    const target = events.senderForId?.(job.senderId) || null;
    const sendProgress = data => dispatch(target, jobId, 'task-progress', data);
    const isWav = format === 'wav';
    const isPro = format === 'prores';
    const preset = getDeliveryFormatPreset(format);
    const isDisc = preset?.kind === 'disc';
    const isAirline = preset?.transport === 'airline';
    const outputFiles = [path.normalize(outPath)];

    queue.assertJobCapabilities(job);

    let assText = null;
    if (job.assRef) {
      const assPath = QueueStore.safeAssPath(queueDir(), job.assRef);
      try {
        if (!assPath) throw new Error('字幕暫存路徑無效');
        assText = fs.readFileSync(assPath, 'utf8');
      } catch (cause) {
        const error = new Error(`找不到字幕快照：${assPath || job.assRef}`);
        error.code = 'MISSING_SOURCE';
        error.cause = cause;
        throw error;
      }
    }

    let assName = null;
    const abort = new AbortController();
    let finish;
    const active = {
      id: jobId, controller: null, p: null, outPath, stopped: false, shutdown: false,
      completion: new Promise(resolve => { finish = resolve; }),
      stop(reason) {
        if (reason === 'shutdown') { if (!active.stopped) active.shutdown = true; }
        else active.stopped = true;
        abort.abort();
        active.controller?.stop?.(reason);
      },
    };
    queue.registerActiveJob(jobId, active);
    const checkCancelled = () => {
      if (!abort.signal.aborted) return;
      const error = new Error('交付工作已取消');
      error.name = 'AbortError';
      throw error;
    };
    const settleProbes = async promises => {
      let firstFailure = null;
      const outcomes = await Promise.allSettled(promises.map(promise => Promise.resolve(promise).catch(error => {
        firstFailure ||= { error };
        abort.abort();
        throw error;
      })));
      if (firstFailure) throw firstFailure.error;
      return outcomes.map(outcome => outcome.value);
    };
    const ownController = controller => {
      active.controller = controller;
      active.p = controller.process;
      if (abort.signal.aborted) controller.stop?.(active.stopped ? 'user-stop' : 'shutdown');
    };
    try {
      checkCancelled();
      fs.mkdirSync(tempDir, { recursive: true });
      if (assText && assText.trim()) {
        assName = QueueStore.burnAssFileName(jobId);
        fs.writeFileSync(path.join(tempDir, assName), assText, 'utf8');
      }

      const probe = mediaProbe();
      const sourcePaths = QueueStore.collectSourcePaths({
        clips: (clips || []).filter(clip => clip.type !== 'image'), audioPlan: rawAudioPlan,
      });
      const audioPresence = new Map(await settleProbes(sourcePaths
        .map(async sourcePath => [sourceKey(sourcePath), await probe.hasAudio(sourcePath, { signal: abort.signal })])));
      checkCancelled();
      const sourceStartOffsets = new Map();
      const sourceClocks = new Map();
      if (probe.describe) {
        await settleProbes(sourcePaths.map(async sourcePath => {
          const media = await probe.describe(sourcePath, { signal: abort.signal });
          sourceClocks.set(sourceKey(sourcePath), media.video || media.audio?.[0] || null);
        }));
      }
      checkCancelled();
      if (probe.audioVideoStartOffsets) {
        await settleProbes(sourcePaths.filter(sourcePath => audioPresence.get(sourceKey(sourcePath)))
          .map(async sourcePath => sourceStartOffsets.set(sourceKey(sourcePath),
            await probe.audioVideoStartOffsets(sourcePath, { signal: abort.signal }))));
      }
      checkCancelled();
      const plan = buildDeliveryArgv({
        format, clips, videoTracks, width, height, fps, duration, videoKbps,
        audioPlan: rawAudioPlan, timecodeWatermark: rawTimecodeWatermark, assFileName: assName, outPath,
      }, {
        hwdecArgs: encoder.hwdecArgs,
        vencArgsBitrate: encoder.bitrateArgs,
        proresArgs: encoder.proresArgs,
        encoderName: encoder.name?.() || null,
        hasAudioStream: sourcePath => audioPresence.get(sourceKey(sourcePath)) ?? true,
        audioVideoStartOffset: (sourcePath, streamIndex = 0) =>
          sourceStartOffsets.get(sourceKey(sourcePath))?.[streamIndex] ?? 0,
        sourceClock: probe.describe ? sourcePath => sourceClocks.get(sourceKey(sourcePath)) : null,
        fontsDir: fonts.root?.() || null,
        timecodeFontFile: fonts.timecodeFile?.() || null,
      });
      const { args, label, duration: plannedDuration, kbps, audioBitrates } = plan;
      const startedAt = now();

      if (isWav) {
        await runFfmpeg(args, {
          executionKind: 'queued-delivery', duration: plannedDuration, jobId, label, outPath,
          onProgress: sendProgress,
          onProcess: ownController,
        });
        sendProgress({
          jobId, label, pct: 100, done: true,
          result: {
            outPath, encoder: plan.plannedEncoder, gpu: false,
            elapsedMs: now() - startedAt, videoKbps: null, audioChannels: plan.audioChannels,
          },
        });
        return;
      }

      let usedEncoder = plan.plannedEncoder;
      const result = await runFfmpeg(args, {
        executionKind: 'queued-delivery', duration: plannedDuration, jobId, label, cwd: tempDir, outPath,
        outputFormat: format,
        ...(isDisc ? { discAudioPlan: plan.discAudioPlan, discVideoFps: plan.discVideoFps } : {}),
        onProgress: sendProgress,
        onProcess: ownController,
      });
      const videoMap = (result.maps || []).find(map => /->/.test(map) && /h264|prores|hevc|mpeg[12]video/i.test(map));
      const encoderMatch = videoMap && /->\s*[^(]*\(([^)]+)\)\s*$/.exec(videoMap.trim());
      if (encoderMatch) usedEncoder = encoderMatch[1].trim();

      // watchdog 已發佈成品；結果資訊是選用 metadata，讀取失敗或取消都不能改變交付終態。
      active.controller = null;
      active.p = null;
      let audioActualBitrates = null;
      if (!isPro && !isDisc) {
        try { audioActualBitrates = await probe.audioBitrates(outPath, { signal: abort.signal }); }
        catch (error) { /* 保留 null；成品成功由 execution 裁定。 */ }
      }
      sendProgress({
        jobId, label, pct: 100, done: true,
        result: {
          outPath,
          ...(isAirline || isDisc ? { outputFiles, container: isDisc ? 'iso' : 'mpegts' } : {}),
          encoder: usedEncoder,
          gpu: /nvenc|qsv|amf|videotoolbox|vaapi/i.test(usedEncoder),
          elapsedMs: now() - startedAt,
          videoKbps: isPro ? null : kbps,
          audioBitrates: isPro ? null : audioBitrates,
          audioActualBitrates,
        },
      });
    } catch (error) {
      const progress = failureProgress({
        stopped: !!active?.stopped,
        shutdown: !!active?.shutdown,
        error,
      });
      if (progress) sendProgress({ jobId, ...progress });
    } finally {
      if (assName) {
        try { fs.unlinkSync(path.join(tempDir, assName)); } catch (error) {}
      }
      queue.clearActiveJob(jobId);
      finish();
    }
  }

  return Object.freeze({ run });
}

module.exports = { createDeliveryRunner };
