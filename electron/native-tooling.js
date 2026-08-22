/* ==============================================================================
   SUB Tool — 原生執行檔與編碼器偵測 (Native Tooling & Hardware Encoders)
   ==============================================================================
   【架構與職責】
   負責跨平台（Windows、macOS）偵測 FFmpeg、FFprobe、MPV 執行檔路徑，
   並根據目前作業系統與 GPU 支援情況，配置最合適的硬體加速與軟體編碼參數。
   
   【支援之編碼器】
   - macOS: `h264_videotoolbox` (Apple Silicon / Intel VideoToolbox)
   - Windows: `h264_nvenc` (NVIDIA), `h264_qsv` (Intel QuickSync), `h264_amf` (AMD), `libx264` (軟解後援)
   ============================================================================== */
'use strict';

const path = require('path');
const { spawnSync: nodeSpawnSync } = require('child_process');

/** 去除陣列重複項與空值 */
function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

/**
 * 取得指定原生工具（ffmpeg, ffprobe, mpv）在當前平台的候選搜尋路徑清單。
 * 
 * @param {string} tool 工具名稱 ('ffmpeg' | 'ffprobe' | 'mpv')
 * @param {object} [options]
 * @returns {string[]} 候選路徑陣列
 */
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

/**
 * 實際探測並驗證原生工具是否可用（執行 --version 或 -version 檢查 return code）。
 * 
 * @param {string} tool 工具名稱
 * @param {object} [options]
 * @returns {{path: string|null, attempts: Array<object>}} 探測結果與嘗試歷史
 */
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

/**
 * 取得打包發布時必須隨附的原生二進位清單。
 */
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

/**
 * 依平台回傳優先嘗試的硬體加速 H.264 視訊編碼器清單。
 */
function videoEncoderCandidates(platform = process.platform) {
  if (platform === 'darwin') return ['h264_videotoolbox'];
  if (platform === 'win32') return ['h264_nvenc', 'h264_qsv', 'h264_amf'];
  return [];
}

/**
 * 產生即時預覽 / Proxy 轉檔所需的 FFmpeg 快速編碼參數。
 */
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

/**
 * 產生正式交付匯出所需的 FFmpeg 視訊編碼參數（包含位元率與緩衝區控制）。
 */
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

/** 檢查當前平台是否支援 MPV 視窗嵌入（目前僅限 Windows HWND 嵌入） */
function mpvEmbeddingSupported(platform = process.platform) {
  return platform === 'win32';
}

module.exports = {
  bundledNativeRequirements,
  deliveryVideoEncoderArgs,
  detectNativeTool,
  mpvEmbeddingSupported,
  nativeToolCandidates,
  previewVideoEncoderArgs,
  videoEncoderCandidates,
};
