'use strict';

const path = require('path');
const { spawnSync: nodeSpawnSync } = require('child_process');

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
  const attempts = [];

  for (const candidate of nativeToolCandidates(tool, options)) {
    let result;
    try {
      result = spawnSync(candidate, ['-version'], { timeout: 5000, stdio: 'pipe' });
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

module.exports = {
  bundledNativeRequirements,
  deliveryVideoEncoderArgs,
  detectNativeTool,
  mpvEmbeddingSupported,
  nativeToolCandidates,
  previewVideoEncoderArgs,
  videoEncoderCandidates,
};
