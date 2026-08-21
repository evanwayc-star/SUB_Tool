'use strict';

const nodeFs = require('fs');
const path = require('path');
const { spawn: nodeSpawn } = require('child_process');
const QueueStore = require('./queue-store');
const ExportWatchdog = require('./export-watchdog');
const { FFmpegOutputParser, FFmpegErrorAnalyzer } = require('./ffmpeg-parser');

function createFFmpegExecution(options = {}) {
  const fs = options.fs || nodeFs;
  const spawnDirect = options.spawnDirect || nodeSpawn;
  const spawnWatchdog = options.spawnWatchdog || ExportWatchdog.spawnExportWatchdog;
  const getFFmpegPath = options.getFFmpegPath || (() => null);
  const getUserDataDir = options.getUserDataDir || (() => process.cwd());
  const getQueueDir = options.getQueueDir || (() => null);
  const now = options.now || (() => Date.now());

  function watchdogScriptPath() {
    const moduleDir = options.moduleDir || __dirname;
    const localPath = path.join(moduleDir, 'export-watchdog.js');
    if (!options.isPackaged?.()) return localPath;
    const unpackedPath = path.join(
      options.getResourcesPath?.() || '',
      'app.asar.unpacked',
      'electron',
      'export-watchdog.js',
    );
    return fs.existsSync(unpackedPath) ? unpackedPath : localPath;
  }

  function execute(args, {
    onProgress,
    duration,
    sender,
    jobId,
    label,
    onProcess,
    cwd,
    outPath,
    shouldSend,
  } = {}) {
    return new Promise((resolve, reject) => {
      const ffmpegPath = getFFmpegPath();
      if (!ffmpegPath) {
        reject(new Error('找不到 ffmpeg'));
        return;
      }

      const queueDir = getQueueDir();
      const isQueueExport = typeof jobId === 'string' && jobId.startsWith('export-') && queueDir;
      if (isQueueExport) options.ensureQueueDir?.();
      if (isQueueExport && (typeof outPath !== 'string' || !outPath)) {
        reject(new Error('匯出 watchdog 缺少輸出路徑'));
        return;
      }

      const startedAt = now();
      const logPath = isQueueExport
        ? QueueStore.logPath(queueDir, jobId)
        : path.join(getUserDataDir(), `export-${startedAt}-${jobId || 'task'}.log`);
      const logStream = fs.createWriteStream(logPath, { flags: isQueueExport ? 'w' : 'a' });
      let logError = null;
      let logFinishPromise = null;
      let tail = '';
      let settled = false;
      let watchdogFailure = null;
      const parser = new FFmpegOutputParser(duration);
      const maySend = () => typeof shouldSend !== 'function' || shouldSend();

      logStream.on('error', error => {
        logError = error;
        try { options.onLogError?.(logPath, error); } catch (ignored) {}
      });
      const writeLog = data => {
        if (logError) return;
        try { logStream.write(data); } catch (error) { logError = error; }
      };
      const finishLog = () => {
        if (logFinishPromise) return logFinishPromise;
        logFinishPromise = new Promise(done => {
          if (logError || logStream.writableFinished || logStream.destroyed) {
            done();
            return;
          }
          let finished = false;
          const settle = () => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            done();
          };
          const timer = setTimeout(settle, 1000);
          logStream.once('finish', settle);
          logStream.once('error', settle);
          try { logStream.end(); } catch (error) { settle(); }
        });
        return logFinishPromise;
      };
      const report = data => {
        const payload = { jobId, label, ...data, elapsedMs: now() - startedAt };
        if (sender && maySend() && typeof options.send === 'function') {
          options.send(sender, 'task-progress', payload);
        }
        if (onProgress) onProgress(payload);
      };
      const consumeStderr = data => {
        const text = data.toString();
        writeLog(text);
        tail += text;
        if (tail.length > 8000) tail = tail.slice(-8000);
        const progress = parser.parseChunk(text);
        if (progress && (sender || onProgress)) report(progress);
      };

      const finishProcess = async (code, watchdogResult = null) => {
        if (settled) return;
        settled = true;
        await finishLog();
        if (sender && maySend() && typeof options.send === 'function') {
          options.send(sender, 'task-progress', { jobId, label, pct: 100, done: true });
        }
        if (code === 0 && (!watchdogResult || watchdogResult.ok)) {
          fs.unlink(logPath, () => {});
          resolve({ tail, maps: parser.maps });
          return;
        }

        let fullLog = tail;
        try { fullLog = fs.readFileSync(logPath, 'utf8'); } catch (error) {
          if (logError) fullLog += `\n\n[無法寫入完整記錄：${logError.message || logError}]`;
        }
        const { summary, errorCode } = FFmpegErrorAnalyzer.analyze(
          fullLog,
          code,
          watchdogFailure,
          watchdogResult,
          outPath,
        );
        const failure = new Error(`[LOG_PATH]${logPath}[/LOG_PATH]ffmpeg 結束碼 ${code}\n${summary}`);
        failure.code = errorCode;
        failure.watchdogResult = watchdogResult;
        reject(failure);
      };

      writeLog(`> ffmpeg ${args.map(value => value.includes(' ') ? `"${value}"` : value).join(' ')}\n\n`);
      if (isQueueExport) {
        const controller = spawnWatchdog({
          ffmpegPath,
          args,
          cwd,
          outPath,
          jobId,
          queueDir,
        }, {
          scriptPath: watchdogScriptPath(),
          onStderr: consumeStderr,
          onMessage: message => {
            if (message?.type === 'error' && !watchdogFailure) watchdogFailure = message;
          },
        });
        controller.ready.catch(() => {});
        if (onProcess) onProcess(controller);
        controller.completion.then(result => {
          const code = result.ok ? 0 : (Number.isInteger(result.code) ? result.code : 1);
          return finishProcess(code, result);
        }).catch(error => {
          watchdogFailure ||= error;
          return finishProcess(1, { ok: false, startupError: true });
        });
        return;
      }

      const process = spawnDirect(ffmpegPath, args, cwd ? { cwd } : {});
      if (onProcess) onProcess(process);
      process.stderr.on('data', consumeStderr);
      process.on('error', async error => {
        if (settled) return;
        settled = true;
        await finishLog();
        reject(error);
      });
      process.on('close', async code => {
        await finishProcess(code);
      });
    });
  }

  return Object.freeze({ execute });
}

module.exports = { createFFmpegExecution };
