/* ==============================================================================
   SUB Tool — FFmpeg Execution & Native Tooling Engine ("electron/ffmpeg-execution-engine.js")
   ==============================================================================
   深層 FFmpeg 執行緒排程、管線建構與原生工具引擎 (FFmpeg Execution Engine)。
   負責跨平台原生工具發現、管線參數組合、進度錯誤解析與行程執行守衛：
   1. 原生執行檔與編碼器偵測 (detectNativeTool / nativeToolCandidates / videoEncoderCandidates / deliveryVideoEncoderArgs / previewVideoEncoderArgs)
   2. FFmpeg 輸出進度與錯誤解析 (FFmpegOutputParser / FFmpegErrorAnalyzer)
   3. 素材 Ingest 管線參數建構 (buildIngestArgs)
   4. FFmpeg 執行管理與 Watchdog 協調器 (createFFmpegExecution)
   ============================================================================== */
'use strict';

const path = require('path');
const nodeFs = require('fs');
const { spawn: nodeSpawn, spawnSync: nodeSpawnSync } = require('child_process');
const { StringDecoder } = require('string_decoder');
const QueueStore = require('./queue-store');
const ExportWatchdog = require('./export-watchdog');
const { artifactProgress } = require('./export-artifact');
const discTools = require('./disc-tools.json');

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function nativeToolCandidates(tool, options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const moduleDir = options.moduleDir || __dirname;
  const resourcesPath = options.resourcesPath || process.resourcesPath || '';
  const env = options.env || process.env;
  const homeDir = options.homeDir || '';
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const envPath = env[`${tool.toUpperCase()}_PATH`];

  if (platform === 'win32') {
    if (tool === 'mpv') {
      return unique([
        pathApi.join(moduleDir, 'mpv', 'mpv.exe'),
        pathApi.join(resourcesPath, 'app.asar.unpacked', 'electron', 'mpv', 'mpv.exe'),
        pathApi.join(resourcesPath, 'mpv', 'mpv.exe'),
        pathApi.join(resourcesPath, 'app', 'electron', 'mpv', 'mpv.exe'),
        envPath,
        'mpv',
        'C:\\Program Files\\mpv\\mpv.exe',
        pathApi.join(env.LOCALAPPDATA || '', 'Programs', 'mpv', 'mpv.exe'),
        homeDir && pathApi.join(homeDir, 'scoop', 'shims', 'mpv.exe'),
        homeDir && pathApi.join(homeDir, 'scoop', 'apps', 'mpv', 'current', 'mpv.exe'),
      ]);
    }
    const executable = `${tool}.exe`;
    return unique([
      pathApi.join(moduleDir, 'ffmpeg', executable),
      pathApi.join(resourcesPath, 'app.asar.unpacked', 'electron', 'ffmpeg', executable),
      envPath,
      tool,
      `C:\\Program Files\\FFMPEG\\bin\\${executable}`,
      `C:\\Program Files\\ffmpeg\\bin\\${executable}`,
      `C:\\ffmpeg\\bin\\${executable}`,
    ]);
  }

  const platformArch = `${platform}-${arch}`;
  return unique([
    pathApi.join(moduleDir, 'ffmpeg', platformArch, tool),
    pathApi.join(resourcesPath, 'app.asar.unpacked', 'electron', 'ffmpeg', platformArch, tool),
    envPath,
    tool,
    pathApi.join('/opt/homebrew/bin', tool),
    pathApi.join('/usr/local/bin', tool),
    pathApi.join('/opt/local/bin', tool),
    homeDir && pathApi.join(homeDir, '.local', 'bin', tool),
  ]);
}

function detectNativeTool(tool, options = {}) {
  const spawnSync = options.spawnSync || nodeSpawnSync;
  const versionArgs = options.versionArgs || (tool === 'mpv' ? ['--version'] : ['-version']);
  const attempts = [];

  for (const candidate of nativeToolCandidates(tool, options)) {
    let result;
    try {
      result = spawnSync(candidate, versionArgs, { timeout: 5000, stdio: 'pipe' });
    } catch (error) {
      result = { status: null, signal: null, error };
    }
    const attempt = {
      candidate,
      ok: result?.status === 0,
      status: Number.isInteger(result?.status) ? result.status : null,
      signal: result?.signal || null,
      errorCode: result?.error?.code || null,
      errorMessage: result?.error?.message || null,
    };
    attempts.push(attempt);
    if (attempt.ok) return { path: candidate, attempts };
  }

  return { path: null, attempts };
}

function bundledNativeRequirements(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;

  if (platform === 'darwin' && arch === 'arm64') {
    return [
      { relativePath: 'electron/ffmpeg/darwin-arm64/ffmpeg', executable: true },
      { relativePath: 'electron/ffmpeg/darwin-arm64/ffprobe', executable: true },
    ];
  }

  if (platform === 'win32' && arch === 'x64') {
    return [
      { relativePath: 'electron/ffmpeg/ffmpeg.exe', executable: true },
      { relativePath: 'electron/ffmpeg/ffprobe.exe', executable: true },
      { relativePath: 'electron/mpv/mpv.exe', executable: true },
      { relativePath: 'electron/mpv/d3dcompiler_43.dll', executable: false },
      ...discTools.files.map(file => ({
        relativePath: `electron/disc/${file.name}`, executable: !!file.executable, sha256: file.sha256,
      })),
    ];
  }

  throw new Error(`尚未支援 ${platform}/${arch} 的原生工具封裝`);
}

function videoEncoderCandidates(platform = process.platform) {
  if (platform === 'darwin') return ['h264_videotoolbox'];
  if (platform === 'win32') return ['h264_nvenc', 'h264_qsv', 'h264_amf'];
  return [];
}

function previewVideoEncoderArgs(encoderName) {
  switch (encoderName) {
    case 'h264_videotoolbox':
      return ['-c:v', 'h264_videotoolbox', '-b:v', '4M', '-realtime', '1', '-allow_sw', '1', '-bf', '0'];
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '26', '-forced-idr', '1', '-bf', '0', '-delay', '0'];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-global_quality', '26', '-bf', '0'];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-rc', 'cqp', '-qp_i', '26', '-qp_p', '26', '-bf', '0'];
    default:
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '26'];
  }
}

function deliveryVideoEncoderArgs(encoderName, kbps) {
  const bitrate = `${kbps}k`;
  const bufferSize = `${kbps * 2}k`;
  const rateArgs = ['-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bufferSize];

  switch (encoderName) {
    case 'h264_videotoolbox':
      return ['-c:v', 'h264_videotoolbox', ...rateArgs, '-realtime', '1', '-allow_sw', '1'];
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', ...rateArgs];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', ...rateArgs];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-rc', 'vbr_peak', ...rateArgs];
    default:
      return ['-c:v', 'libx264', '-preset', 'veryfast', ...rateArgs];
  }
}

function mpvEmbeddingSupported(platform = process.platform) {
  return platform === 'win32';
}

class FFmpegOutputParser {
  constructor(duration = 0) {
    this.duration = Math.max(0, Number(duration) || 0);
    this.speeds = [];
    this.maps = [];
    this.carry = '';
    this.discardingRecord = false;
  }

  parseChunk(chunk) {
    if (typeof chunk !== 'string') return null;
    let latest = null;
    let start = 0;
    for (const delimiter of chunk.matchAll(/[\r\n]/g)) {
      this.appendRecord(chunk.slice(start, delimiter.index));
      if (!this.discardingRecord) latest = this.parseRecord(this.carry) || latest;
      this.carry = '';
      this.discardingRecord = false;
      start = delimiter.index + 1;
    }
    this.appendRecord(chunk.slice(start));
    return latest;
  }

  appendRecord(text) {
    if (this.discardingRecord) return;
    // Discard the whole oversized record, including its suffix, until CR/LF.
    if (this.carry.length + text.length > 65536) {
      this.carry = '';
      this.discardingRecord = true;
    } else this.carry += text;
  }

  flush() {
    const progress = this.discardingRecord ? null : this.parseRecord(this.carry);
    this.carry = '';
    this.discardingRecord = false;
    return progress;
  }

  parseRecord(record) {
    const sMatch = /speed=\s*([\d.]+)x/.exec(record);
    if (sMatch) {
      const speedVal = parseFloat(sMatch[1]);
      if (Number.isFinite(speedVal) && speedVal > 0) {
        this.speeds.push(speedVal);
        if (this.speeds.length > 5) this.speeds.shift();
      }
    }

    const map = /^\s*Stream #\d+:\d+ -> #\d+:\d+ \((.*)\)\s*$/.exec(record);
    if (map && this.maps.length < 8) {
      let depth = 0;
      for (const char of map[1]) {
        if (char === '(') depth++;
        else if (char === ')') depth--;
        if (depth < 0) break;
      }
      if (depth === 0) this.maps.push(map[1]);
    }

    const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(record);
    if (m && this.duration > 0) {
      const t = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
      let etaS = null;
      if (this.speeds.length > 0) {
        const avgSpeed = this.speeds.reduce((a, b) => a + b, 0) / this.speeds.length;
        if (avgSpeed > 0) {
          etaS = Math.max(0, (this.duration - t) / avgSpeed);
        }
      }
      const pct = Math.max(0, Math.min(99, Math.round((t / this.duration) * 100)));
      return { pct, etaS };
    }
    return null;
  }
}

class FFmpegErrorAnalyzer {
  static analyze(fullLog = '', code, watchdogFailure, watchdogResult, outPath) {
    let summary = '';
    const logStr = typeof fullLog === 'string' ? fullLog : '';
    const mNoSuchFile = logStr.match(/(.*): No such file or directory/);

    if (watchdogFailure?.code === 'OUTPUT_BUSY') {
      summary = `同一個輸出檔案正在由另一份工作使用：${outPath || ''}`;
    } else if (watchdogFailure?.message) {
      summary = watchdogFailure.message;
    } else if (watchdogResult?.cleanup?.retainedLease) {
      summary = watchdogResult.cleanup.error?.message || '半成品尚未安全刪除，輸出鎖已保留';
    } else if (mNoSuchFile) {
      summary = `找不到來源檔：${mNoSuchFile[1]}`;
    } else if (logStr.includes('No space left on device')) {
      summary = '磁碟空間不足';
    } else if (logStr.match(/Unknown encoder '([^']+)'/)) {
      summary = `編碼器不可用：${logStr.match(/Unknown encoder '([^']+)'/)[1]}`;
    } else if (logStr.includes('Permission denied')) {
      const mPerm = logStr.match(/(.*): Permission denied/);
      summary = '輸出路徑無寫入權限' + (mPerm ? `：${mPerm[1]}` : '');
    } else if (logStr.includes('Filtergraph') && (logStr.includes('parse error') || logStr.includes('error parsing'))) {
      summary = 'Filtergraph 解析失敗';
    } else {
      const lines = logStr.split('\n');
      if (lines.length <= 40) {
        summary = lines.join('\n');
      } else {
        summary = lines.slice(0, 20).join('\n') + '\n...\n' + lines.slice(-20).join('\n');
      }
    }

    const errorCode = watchdogFailure?.code || (watchdogResult?.cleanup?.retainedLease ? 'PARTIAL_CLEANUP_FAILED' : 'FFMPEG_EXIT');
    return { summary, errorCode };
  }
}

function buildIngestArgs({
  src,
  needsProxy,
  proxyPath,
  fc,
  channels,
  chMaps,
  waveLabel,
  wavePath,
  encoder,
  isStream = false,
}) {
  let hwdec = [];
  if (encoder && encoder !== 'libx264') {
    hwdec = ['-hwaccel', 'auto'];
  }

  const args = ['-y', ...hwdec, '-i', src];

  if (fc && fc.length) args.push('-filter_complex', fc.join(';'));

  if (needsProxy && proxyPath) {
    let vf = 'scale=-2:720,format=yuv420p';
    const vencArgs = previewVideoEncoderArgs(encoder);
    args.push('-map', '0:v:0', '-an', '-vf', vf, ...vencArgs);

    // 全 I 幀 (All-Intra / Ultra-Short GOP) 預覽規格：
    // NVIDIA NVENC SDK 強制要求 gopLength > numBFrames + 1，在 -bf 0 條件下其硬體最小合法 GOP 為 2；
    // 其他編碼器 (libx264, QSV, VideoToolbox) 則支援 GOP = 1。
    // 兩者皆關閉 B 幀 (-bf 0) 並使用閉合 GOP (-flags +cgop)，減少隨機 seek 的解碼依賴；實際呈現延遲仍取決於 I/O 與播放器。
    const gop = encoder === 'h264_nvenc' ? '2' : '1';
    args.push('-g', gop, '-keyint_min', gop, '-bf', '0', '-flags', '+cgop');

    if (isStream) {
      args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', proxyPath);
    } else {
      args.push('-movflags', '+faststart', proxyPath);
    }
  }

  (channels || []).forEach((c, k) => {
    args.push('-map', chMaps[k], '-c:a', 'aac', '-b:a', '128k', c.file);
  });

  if (waveLabel && wavePath) {
    args.push('-map', waveLabel, '-ac', '1', '-ar', '4000', '-c:a', 'pcm_s16le', wavePath);
  }

  return args;
}

function createFFmpegExecution(options = {}) {
  const fs = options.fs || nodeFs;
  const spawnDirect = options.spawnDirect || nodeSpawn;
  const spawnWatchdog = options.spawnWatchdog || ExportWatchdog.spawnExportWatchdog;
  const getFFmpegPath = options.getFFmpegPath || (() => null);
  const getUserDataDir = options.getUserDataDir || (() => process.cwd());
  const getQueueDir = options.getQueueDir || (() => null);
  const now = options.now || (() => Date.now());
  const directExecutions = new Set();
  let shuttingDown = false;
  let resumeWhenIdle = false;

  const shutdownError = () => {
    const error = new Error('FFmpeg 執行環境正在關閉');
    error.code = 'FFMPEG_SHUTTING_DOWN';
    return error;
  };
  function execute(args, executionOptions = {}) {
    const startedAt = now();
    let lastPct = 0;
    const isDirect = executionOptions.executionKind === 'direct';
    const entry = isDirect && !shuttingDown ? { process: null, cancelled: false, completion: null } : null;
    if (entry) directExecutions.add(entry);
    const work = isDirect && shuttingDown ? Promise.reject(shutdownError()) : executeProcess(args, {
      ...executionOptions,
      isCancelled: () => Boolean(entry?.cancelled),
      onProgress: progress => {
        lastPct = progress.pct;
        executionOptions.onProgress?.(progress);
      },
      onProcess: process => {
        if (entry) {
          entry.process = process;
          if (entry.cancelled) { try { process.kill(); } catch (error) {} }
        }
        executionOptions.onProcess?.(process);
      },
    });
    const terminal = (outcome, error) => {
      // 媒體快取 owner 還須原子提交索引，由它發布整個工作終態。
      if (executionOptions.deferTerminal) return;
      const payload = {
        jobId: executionOptions.jobId, label: executionOptions.label,
        pct: outcome === 'success' ? 100 : lastPct,
        done: true, outcome, elapsedMs: now() - startedAt,
        ...(error ? { errorCode: error.code || 'FFMPEG_EXIT', errorMsg: error.message || String(error) } : {}),
      };
      // A progress observer cannot change the native result after it has settled.
      try {
        if (executionOptions.sender && (typeof executionOptions.shouldSend !== 'function' || executionOptions.shouldSend())) {
          options.send?.(executionOptions.sender, 'task-progress', payload);
        }
      } catch (ignored) {}
      // Queued callbacks describe encoding/authoring; only the artifact owner completes them.
      if (isDirect) { try { executionOptions.onProgress?.(payload); } catch (ignored) {} }
    };
    const completion = work.then(result => {
      terminal('success');
      return result;
    }, error => {
      terminal('failed', error);
      throw error;
    });
    if (entry) {
      entry.completion = completion.catch(() => {}).finally(() => {
        directExecutions.delete(entry);
        if (resumeWhenIdle && !directExecutions.size) shuttingDown = false;
      });
    }
    return completion;
  }

  async function cancelAllAndWait({ timeoutMs = 10000 } = {}) {
    shuttingDown = true;
    resumeWhenIdle = false;
    for (const entry of directExecutions) {
      const wasCancelled = entry.cancelled;
      entry.cancelled = true;
      if (entry.process && entry.process.exitCode == null && entry.process.signalCode == null) {
        try { entry.process.kill(wasCancelled ? 'SIGKILL' : 'SIGTERM'); } catch (error) {}
      }
    }
    let timer;
    try {
      await Promise.race([
        Promise.all([...directExecutions].map(entry => entry.completion)),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error('FFmpeg 尚未確認關閉，不能清除暫存檔');
            error.code = 'FFMPEG_TERMINATION_PENDING';
            reject(error);
          }, timeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }

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

  function executeProcess(args, {
    executionKind,
    onStderr,
    onProgress,
    duration,
    sender,
    jobId,
    label,
    onProcess,
    cwd,
    outPath,
    shouldSend,
    outputFormat,
    discAudioPlan,
    discVideoFps,
    isCancelled,
  } = {}) {
    return new Promise((resolve, reject) => {
      if (executionKind !== 'direct' && executionKind !== 'queued-delivery') {
        reject(new TypeError('FFmpeg 執行缺少有效的 executionKind'));
        return;
      }
      const isQueueExport = executionKind === 'queued-delivery';
      const queueDir = isQueueExport ? getQueueDir() : null;
      if (isQueueExport && (typeof queueDir !== 'string' || !queueDir.trim()
        || typeof jobId !== 'string' || !jobId.trim()
        || typeof outPath !== 'string' || !outPath.trim())) {
        reject(new Error('匯出 watchdog 缺少佇列目錄、工作識別或輸出路徑'));
        return;
      }
      const ffmpegPath = getFFmpegPath();
      if (!ffmpegPath) {
        reject(new Error('找不到 ffmpeg'));
        return;
      }

      if (isQueueExport) options.ensureQueueDir?.();

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
      const stderrDecoder = new StringDecoder('utf8');
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
      const reportParsedProgress = progress => {
        if (progress && (sender || onProgress)) report({ ...progress, pct: artifactProgress(outputFormat, 'encode', progress.pct) });
      };
      const consumeText = text => {
        if (!text) return;
        if (typeof onStderr === 'function') onStderr(text);
        tail += text;
        if (tail.length > 8000) tail = tail.slice(-8000);
        reportParsedProgress(parser.parseChunk(text));
      };
      const consumeStderr = data => {
        if (settled) return;
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
        writeLog(bytes); // retain the original pipe bytes in the diagnostic log
        consumeText(stderrDecoder.write(bytes));
      };

      const finishProcess = async (code, watchdogResult = null, processError = null, signal = null) => {
        if (settled) return;
        settled = true;
        consumeText(stderrDecoder.end());
        reportParsedProgress(parser.flush());
        await finishLog();
        if (processError) { reject(processError); return; }
        if (isCancelled?.()) {
          const error = new Error('FFmpeg 工作已取消');
          error.name = 'AbortError'; error.code = 'ABORT_ERR';
          reject(error); return;
        }
        if (code === 0 && !signal && (!watchdogResult || watchdogResult.ok)) {
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
        if (signal) failure.signal = signal;
        reject(failure);
      };

      writeLog(`> ffmpeg ${args.map(value => value.includes(' ') ? `"${value}"` : value).join(' ')}\n\n`);
      if (isQueueExport) {
        let controller;
        try { controller = spawnWatchdog({
          ffmpegPath,
          args,
          cwd,
          outPath,
          jobId,
          queueDir,
          ...(outputFormat ? { outputFormat } : {}),
          ...(discAudioPlan ? { discAudioPlan } : {}),
          ...(discVideoFps ? { discVideoFps } : {}),
        }, {
          scriptPath: watchdogScriptPath(),
          onStderr: consumeStderr,
          onMessage: message => {
            if (message?.type === 'error' && !watchdogFailure) watchdogFailure = message;
            if (message?.type === 'progress') report(message.progress);
          },
        }); } catch (error) { void finishProcess(1, null, error); return; }
        controller.ready.catch(() => {});
        let processError = null;
        try { onProcess?.(controller); }
        catch (error) { processError = error; try { controller.stop(); } catch (ignored) {} }
        controller.completion.then(result => {
          const code = result.ok ? 0 : (Number.isInteger(result.code) ? result.code : 1);
          return finishProcess(code, result, processError);
        }).catch(error => {
          watchdogFailure ||= error;
          return finishProcess(1, { ok: false, startupError: true });
        });
        return;
      }

      let process;
      try { process = spawnDirect(ffmpegPath, args, cwd ? { cwd } : {}); }
      catch (error) { void finishProcess(1, null, error); return; }
      let processError = null;
      process.stderr?.on('data', consumeStderr);
      process.once('error', error => { processError ||= error; });
      process.once('close', (code, signal) => { void finishProcess(code, null, processError, signal); });
      // listener 必須先裝好：取消可在 onProcess 内同步 kill，仍須等 close 才settle。
      try { onProcess?.(process); }
      catch (error) { processError = error; try { process.kill(); } catch (ignored) {} }
    });
  }

  return Object.freeze({
    execute,
    cancelAllAndWait,
    resume() {
      // 關閉被上層取消時，只在既有 writer 全部 settle 後重新准入。
      resumeWhenIdle = true;
      if (directExecutions.size) return false;
      shuttingDown = false;
      return true;
    },
  });
}

module.exports = {
  buildIngestArgs,
  bundledNativeRequirements,
  createFFmpegExecution,
  deliveryVideoEncoderArgs,
  detectNativeTool,
  FFmpegErrorAnalyzer,
  FFmpegOutputParser,
  mpvEmbeddingSupported,
  nativeToolCandidates,
  previewVideoEncoderArgs,
  videoEncoderCandidates,
};
