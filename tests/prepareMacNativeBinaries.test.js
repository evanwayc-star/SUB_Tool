import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { prepareMacNativeBinaries } = require('../scripts/release/prepare-macos-native-binaries.js');

describe('Apple Silicon 原生執行檔準備', () => {
  it('複製 ffmpeg/ffprobe 並以實際能力探針擋下功能殘缺的 build', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'prepare-mac-native-'));
    const ffmpegSource = path.join(root, 'ffmpeg-package', 'ffmpeg');
    const ffprobeSource = path.join(root, 'ffprobe-package', 'ffprobe');
    mkdirSync(path.dirname(ffmpegSource), { recursive: true });
    mkdirSync(path.dirname(ffprobeSource), { recursive: true });
    writeFileSync(ffmpegSource, 'ffmpeg-arm64');
    writeFileSync(ffprobeSource, 'ffprobe-arm64');
    writeFileSync(`${ffmpegSource}.LICENSE`, 'ffmpeg arm64 license');
    writeFileSync(`${ffmpegSource}.README`, 'ffmpeg arm64 build info');
    writeFileSync(`${ffprobeSource}.LICENSE`, 'ffprobe arm64 license');
    writeFileSync(`${ffprobeSource}.README`, 'ffprobe arm64 build info');
    const probes = [];

    try {
      const result = prepareMacNativeBinaries({
        platform: 'darwin',
        arch: 'arm64',
        repositoryRoot: root,
        ffmpegSource,
        ffprobeSource,
        spawnSync(executable, args) {
          probes.push([path.basename(executable), ...args]);
          if (path.basename(executable) === 'file') {
            return { status: 0, stdout: 'Mach-O 64-bit executable arm64' };
          }
          if (args.includes('-filters')) return { status: 0, stdout: ' ... ass ... ' };
          if (args.includes('-encoders')) {
            return { status: 0, stdout: ' libx264 prores_ks pcm_s24le ' };
          }
          if (args.includes('-demuxers')) return { status: 0, stdout: ' ... mxf ... ' };
          return { status: 0, stdout: 'ffprobe version 6.1.1' };
        },
      });

      expect(readFileSync(result.ffmpegPath, 'utf8')).toBe('ffmpeg-arm64');
      expect(readFileSync(result.ffprobePath, 'utf8')).toBe('ffprobe-arm64');
      expect(readFileSync(`${result.ffmpegPath}.LICENSE`, 'utf8')).toBe('ffmpeg arm64 license');
      expect(readFileSync(`${result.ffmpegPath}.README`, 'utf8')).toBe('ffmpeg arm64 build info');
      expect(readFileSync(`${result.ffprobePath}.LICENSE`, 'utf8')).toBe('ffprobe arm64 license');
      expect(readFileSync(`${result.ffprobePath}.README`, 'utf8')).toBe('ffprobe arm64 build info');
      expect(probes).toEqual(expect.arrayContaining([
        ['file', '-b', result.ffmpegPath],
        ['file', '-b', result.ffprobePath],
        ['ffmpeg', '-hide_banner', '-filters'],
        ['ffmpeg', '-hide_banner', '-encoders'],
        ['ffmpeg', '-hide_banner', '-demuxers'],
        ['ffprobe', '-version'],
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('套件授權檔缺失時停止打包，不產生來源不明的原生工具', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'prepare-mac-license-'));
    const ffmpegSource = path.join(root, 'ffmpeg-package', 'ffmpeg');
    const ffprobeSource = path.join(root, 'ffprobe-package', 'ffprobe');
    mkdirSync(path.dirname(ffmpegSource), { recursive: true });
    mkdirSync(path.dirname(ffprobeSource), { recursive: true });
    writeFileSync(ffmpegSource, 'ffmpeg-arm64');
    writeFileSync(ffprobeSource, 'ffprobe-arm64');

    try {
      expect(() => prepareMacNativeBinaries({
        platform: 'darwin',
        arch: 'arm64',
        repositoryRoot: root,
        ffmpegSource,
        ffprobeSource,
      })).toThrow(/缺少.*LICENSE/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('Rosetta 可執行的 x64 工具仍會因不是 arm64 而停止打包', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'prepare-mac-arch-'));
    const ffmpegSource = path.join(root, 'ffmpeg-package', 'ffmpeg');
    const ffprobeSource = path.join(root, 'ffprobe-package', 'ffprobe');
    mkdirSync(path.dirname(ffmpegSource), { recursive: true });
    mkdirSync(path.dirname(ffprobeSource), { recursive: true });
    for (const source of [ffmpegSource, ffprobeSource]) {
      writeFileSync(source, 'x64-binary');
      writeFileSync(`${source}.LICENSE`, 'license');
      writeFileSync(`${source}.README`, 'readme');
    }

    try {
      expect(() => prepareMacNativeBinaries({
        platform: 'darwin',
        arch: 'arm64',
        repositoryRoot: root,
        ffmpegSource,
        ffprobeSource,
        spawnSync(executable) {
          if (path.basename(executable) === 'file') {
            return { status: 0, stdout: 'Mach-O 64-bit executable x86_64' };
          }
          return { status: 0, stdout: '' };
        },
      })).toThrow(/不是 Apple Silicon arm64/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
