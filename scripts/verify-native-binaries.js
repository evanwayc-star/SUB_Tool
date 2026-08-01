'use strict';

const fs = require('fs');
const path = require('path');
const { bundledNativeRequirements } = require('../electron/native-tooling');

const MIN_BYTES = {
  ffmpeg: 10 * 1024 * 1024,
  'ffmpeg.exe': 50 * 1024 * 1024,
  ffprobe: 10 * 1024 * 1024,
  'ffprobe.exe': 50 * 1024 * 1024,
  'mpv.exe': 20 * 1024 * 1024,
  'd3dcompiler_43.dll': 1024 * 1024,
};

function readOption(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function verifyNativeBinaries(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot || path.join(__dirname, '..'));
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const failures = [];

  for (const requirement of bundledNativeRequirements({ platform, arch })) {
    const fullPath = path.join(repositoryRoot, ...requirement.relativePath.split('/'));
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        failures.push(`缺少 ${requirement.relativePath}`);
        continue;
      }
      throw error;
    }

    if (!stat.isFile()) {
      failures.push(`${requirement.relativePath} 不是檔案`);
      continue;
    }
    const minimum = MIN_BYTES[path.basename(fullPath)] || 1;
    if (stat.size < minimum) {
      failures.push(`${requirement.relativePath} 只有 ${stat.size} bytes，看起來是損毀或未下載完整的殘檔`);
    }
    if (platform !== 'win32' && requirement.executable && (stat.mode & 0o111) === 0) {
      failures.push(`${requirement.relativePath} 沒有執行權限（請執行 chmod +x）`);
    }
  }

  return { ok: failures.length === 0, platform, arch, failures };
}

function remediationFor(platform, arch) {
  if (platform === 'darwin' && arch === 'arm64') {
    return '請先執行 npm ci，再執行 npm run native:prepare:mac 下載並核對 Apple Silicon 原生工具。';
  }
  if (platform === 'win32' && arch === 'x64') {
    return '請依 docs/Electron_維護手冊.md §4／§5，將指定版本放入 electron/ffmpeg 與 electron/mpv。';
  }
  return '請先確認此平台的原生工具封裝規格。';
}

function main(argv) {
  const result = verifyNativeBinaries({
    repositoryRoot: readOption(argv, 'repository-root', path.join(__dirname, '..')),
    platform: readOption(argv, 'platform', process.platform),
    arch: readOption(argv, 'arch', process.arch),
  });

  if (!result.ok) {
    console.error(
      `找不到 ${result.platform}/${result.arch} 打包必須的內建執行檔：\n- ${result.failures.join('\n- ')}\n${remediationFor(result.platform, result.arch)}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`內建執行檔核對通過：${result.platform}/${result.arch}`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { verifyNativeBinaries };
