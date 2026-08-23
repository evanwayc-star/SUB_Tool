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
const QueueStore = require('./queue-store');
const ExportWatchdog = require('./export-watchdog');

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
      return ['-c:v', 'h264_videotoolbox', '-b:v', '4M', '-realtime', '1', '-allow_sw', '1'];
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '26', '-forced-idr', '1'];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-global_quality', '26'];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-rc', 'cqp', '-qp_i', '26', '-qp_p', '26'];
    default:
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26'];
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
  }

  parseChunk(chunk) {
    if (typeof chunk !== 'string') return null;

    const sMatch = /speed=\s*([\d.]+)x/.exec(chunk);
    if (sMatch) {
      const speedVal = parseFloat(sMatch[1]);
      if (Number.isFinite(speedVal) && speedVal > 0) {
        this.speeds.push(speedVal);
        if (this.speeds.length > 5) this.speeds.shift();
      }
    }

    for (const mm of chunk.matchAll(/Stream #\d+:\d+ -> #\d+:\d+ \(([^\n]*)\)/g)) {
      if (this.maps.length < 8) this.maps.push(mm[1]);
    }

    const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(chunk);
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

    if (isStream) {
      args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', proxyPath);
    } else {
      args.push('-force_key_frames', 'expr:gte(t,n_forced*0.5)');
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
