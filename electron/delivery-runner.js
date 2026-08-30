'use strict';

/* 單份交付工作的完整交易：讀 frozen ASS、probe、建立交付計畫、執行 ffmpeg、
   回報 queue 終態並清理暫存。Electron main 只負責提供真實 adapters。 */

const fs = require('fs');
const path = require('path');
const QueueStore = require('./queue-store');
const {
  buildDeliveryArgv,
  _normalizeAudioPlan,
  _normaliseExportTimecodeWatermark,
} = require('./export-plan');

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

  function activeRecord(jobId, controller, outPath) {
    return {
      id: jobId,
      controller,
      p: controller.process,
      stop: controller.stop,
      completion: controller.completion,
      outPath,
      stopped: false,
    };
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
    const audioPlan = _normalizeAudioPlan(rawAudioPlan, { requireStreams: !isWav });
    const timecodeWatermark = isWav ? null : _normaliseExportTimecodeWatermark(rawTimecodeWatermark, fps);

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
    try {
      fs.mkdirSync(tempDir, { recursive: true });
      if (assText && assText.trim()) {
        assName = QueueStore.burnAssFileName(jobId);
        fs.writeFileSync(path.join(tempDir, assName), assText, 'utf8');
      }

      const probe = mediaProbe();
      const audioPresence = new Map(await Promise.all(
        [...new Set((clips || [])
          .filter(clip => clip?.path && clip.type !== 'image')
          .map(clip => clip.path))]
          .map(async sourcePath => [sourcePath, await probe.hasAudio(sourcePath)]),
      ));
      const plan = buildDeliveryArgv({
        format, clips, videoTracks, width, height, fps, duration, videoKbps,
        audioPlan, timecodeWatermark, assFileName: assName, outPath,
      }, {
        hwdecArgs: encoder.hwdecArgs,
        vencArgsBitrate: encoder.bitrateArgs,
        proresArgs: encoder.proresArgs,
        encoderName: encoder.name?.() || null,
        hasAudioStream: sourcePath => audioPresence.get(sourcePath) ?? true,
        fontsDir: fonts.root?.() || null,
        timecodeFontFile: fonts.timecodeFile?.() || null,
      });
      const { args, label, duration: plannedDuration, kbps, audioBitrates } = plan;
      const startedAt = now();

      if (isWav) {
        await runFfmpeg(args, {
          duration: plannedDuration, jobId, label, outPath,
          onProgress: sendProgress,
          onProcess: controller => queue.registerActiveJob(jobId, activeRecord(jobId, controller, outPath)),
        });
        queue.clearActiveJob(jobId);
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
        duration: plannedDuration, jobId, label, cwd: tempDir, outPath,
        onProgress: sendProgress,
        onProcess: controller => queue.registerActiveJob(jobId, activeRecord(jobId, controller, outPath)),
      });
      const videoMap = (result.maps || []).find(map => /->/.test(map) && /h264|prores|hevc/i.test(map));
      const encoderMatch = videoMap && /->\s*[^(]*\(([^)]+)\)\s*$/.exec(videoMap.trim());
      if (encoderMatch) usedEncoder = encoderMatch[1].trim();

      queue.clearActiveJob(jobId);
      sendProgress({
        jobId, label, pct: 100, done: true,
        result: {
          outPath,
          encoder: usedEncoder,
          gpu: /nvenc|qsv|amf|videotoolbox|vaapi/i.test(usedEncoder),
          elapsedMs: now() - startedAt,
          videoKbps: isPro ? null : kbps,
          audioBitrates: isPro ? null : audioBitrates,
          audioActualBitrates: isPro ? null : await probe.audioBitrates(outPath),
        },
      });
    } catch (error) {
      const active = queue.activeJob(jobId);
      const progress = failureProgress({
        stopped: !!active?.stopped,
        shutdown: !!active?.shutdown,
        error,
      });
      queue.clearActiveJob(jobId);
      if (progress) sendProgress({ jobId, ...progress });
    } finally {
      if (assName) {
        try { fs.unlinkSync(path.join(tempDir, assName)); } catch (error) {}
      }
    }
  }

  return Object.freeze({ run });
}

module.exports = { createDeliveryRunner };
