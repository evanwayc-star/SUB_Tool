'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync: nodeSpawnSync } = require('child_process');

function probe(spawnSync, executable, args, requiredTokens) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = `${result?.stdout || ''}\n${result?.stderr || ''}`;
  if (result?.status !== 0) {
    throw new Error(`${path.basename(executable)} ${args.join(' ')} 執行失敗（status ${result?.status ?? 'null'}）`);
  }
  for (const token of requiredTokens) {
    if (!new RegExp(`(^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'm').test(output)) {
      throw new Error(`${path.basename(executable)} 缺少打包必要能力：${token}`);
    }
  }
}

function copyBinarySidecars(source, destination) {
  for (const suffix of ['.LICENSE', '.README']) {
    const sidecar = `${source}${suffix}`;
    if (!fs.existsSync(sidecar)) {
      throw new Error(`原生工具套件缺少 ${path.basename(source)}${suffix}：${path.dirname(source)}`);
    }
    fs.copyFileSync(sidecar, `${destination}${suffix}`);
  }
}

function assertAppleSiliconBinary(spawnSync, executable) {
  const result = spawnSync('/usr/bin/file', ['-b', executable], { encoding: 'utf8' });
  const output = `${result?.stdout || ''}\n${result?.stderr || ''}`.trim();
  if (result?.status !== 0) {
    throw new Error(`無法確認 ${path.basename(executable)} 架構（file status ${result?.status ?? 'null'}）`);
  }
  if (!/(^|\W)arm64(\W|$)/i.test(output)) {
    throw new Error(`${path.basename(executable)} 不是 Apple Silicon arm64：${output || '(無輸出)'}`);
  }
}

function prepareMacNativeBinaries(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (platform !== 'darwin' || arch !== 'arm64') {
    throw new Error(`Mac 原生執行檔只能在 darwin/arm64 準備，目前是 ${platform}/${arch}`);
  }

  const repositoryRoot = path.resolve(options.repositoryRoot || path.join(__dirname, '..', '..'));
  const ffmpegSource = options.ffmpegSource || require('ffmpeg-static');
  const ffprobeSource = options.ffprobeSource || require('@derhuerst/ffprobe-static');
  const spawnSync = options.spawnSync || nodeSpawnSync;
  if (!ffmpegSource || !ffprobeSource) throw new Error('找不到 darwin-arm64 ffmpeg-static/ffprobe-static');

  const destinationDir = path.join(repositoryRoot, 'electron', 'ffmpeg', 'darwin-arm64');
  fs.mkdirSync(destinationDir, { recursive: true });
  const ffmpegPath = path.join(destinationDir, 'ffmpeg');
  const ffprobePath = path.join(destinationDir, 'ffprobe');
  fs.copyFileSync(ffmpegSource, ffmpegPath);
  fs.copyFileSync(ffprobeSource, ffprobePath);
  fs.chmodSync(ffmpegPath, 0o755);
  fs.chmodSync(ffprobePath, 0o755);
  copyBinarySidecars(ffmpegSource, ffmpegPath);
  copyBinarySidecars(ffprobeSource, ffprobePath);
  assertAppleSiliconBinary(spawnSync, ffmpegPath);
  assertAppleSiliconBinary(spawnSync, ffprobePath);

  probe(spawnSync, ffmpegPath, ['-hide_banner', '-filters'], ['ass']);
  probe(spawnSync, ffmpegPath, ['-hide_banner', '-encoders'], ['libx264', 'prores_ks', 'pcm_s24le']);
  probe(spawnSync, ffmpegPath, ['-hide_banner', '-demuxers'], ['mxf']);
  probe(spawnSync, ffprobePath, ['-version'], []);

  return { ffmpegPath, ffprobePath };
}

function main() {
  const result = prepareMacNativeBinaries();
  console.log(`Apple Silicon 原生工具準備完成：\n- ${result.ffmpegPath}\n- ${result.ffprobePath}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}

module.exports = { prepareMacNativeBinaries };
