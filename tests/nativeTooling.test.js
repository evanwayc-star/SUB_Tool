import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  bundledNativeRequirements,
  deliveryVideoEncoderArgs,
  detectNativeTool,
  mpvEmbeddingSupported,
  nativeToolCandidates,
  previewVideoEncoderArgs,
  videoEncoderCandidates,
} = require('../electron/native-tooling.js');

describe('原生工具候選路徑', () => {
  it('Apple Silicon 只產生 macOS arm64 路徑，不混入 Windows 執行檔', () => {
    const candidates = nativeToolCandidates('ffmpeg', {
      platform: 'darwin',
      arch: 'arm64',
      moduleDir: '/Applications/SUB Tool.app/Contents/Resources/app.asar/electron',
      resourcesPath: '/Applications/SUB Tool.app/Contents/Resources',
      env: { FFMPEG_PATH: '/custom/ffmpeg' },
      homeDir: '/Users/evan',
    });

    expect(candidates).toContain(
      '/Applications/SUB Tool.app/Contents/Resources/app.asar.unpacked/electron/ffmpeg/darwin-arm64/ffmpeg',
    );
    expect(candidates).toContain('/opt/homebrew/bin/ffmpeg');
    expect(candidates).toContain('/custom/ffmpeg');
    expect(candidates).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/\.exe$/i),
      expect.stringContaining('Program Files'),
      expect.stringContaining('\\'),
    ]));
  });

  it('內建檔不可執行時會繼續探測 Apple Silicon Homebrew 路徑', () => {
    const calls = [];
    const result = detectNativeTool('ffmpeg', {
      platform: 'darwin',
      arch: 'arm64',
      moduleDir: '/app/electron',
      resourcesPath: '/app/resources',
      env: {},
      homeDir: '/Users/evan',
      spawnSync(candidate) {
        calls.push(candidate);
        if (candidate === '/opt/homebrew/bin/ffmpeg') return { status: 0, signal: null };
        return { status: null, signal: null, error: { code: 'ENOENT', message: 'not found' } };
      },
    });

    expect(result.path).toBe('/opt/homebrew/bin/ffmpeg');
    expect(calls.at(-1)).toBe('/opt/homebrew/bin/ffmpeg');
    expect(result.attempts.at(-1)).toMatchObject({
      candidate: '/opt/homebrew/bin/ffmpeg',
      ok: true,
      status: 0,
    });
  });

  it('Apple Silicon 測試版只封裝 ffmpeg 與 ffprobe，不宣稱支援 mpv', () => {
    const requirements = bundledNativeRequirements({ platform: 'darwin', arch: 'arm64' });

    expect(requirements.map(item => item.relativePath)).toEqual([
      'electron/ffmpeg/darwin-arm64/ffmpeg',
      'electron/ffmpeg/darwin-arm64/ffprobe',
    ]);
    expect(requirements.every(item => item.executable)).toBe(true);
  });

  it('未實作的 Windows ARM 不會誤套 x64 原生檔需求', () => {
    expect(() => bundledNativeRequirements({ platform: 'win32', arch: 'arm64' }))
      .toThrow(/尚未支援 win32\/arm64/);
  });

  it('macOS 優先探測 VideoToolbox，Windows 維持既有三種硬體編碼器', () => {
    expect(videoEncoderCandidates('darwin')).toEqual(['h264_videotoolbox']);
    expect(videoEncoderCandidates('win32')).toEqual(['h264_nvenc', 'h264_qsv', 'h264_amf']);
  });

  it('VideoToolbox 探測成功後，proxy 與交付匯出真的使用該編碼器', () => {
    expect(previewVideoEncoderArgs('h264_videotoolbox')).toEqual([
      '-c:v', 'h264_videotoolbox',
      '-b:v', '4M',
      '-realtime', '1',
      '-allow_sw', '1',
    ]);
    expect(deliveryVideoEncoderArgs('h264_videotoolbox', 8000)).toEqual([
      '-c:v', 'h264_videotoolbox',
      '-b:v', '8000k',
      '-maxrate', '8000k',
      '-bufsize', '16000k',
      '-realtime', '1',
      '-allow_sw', '1',
    ]);
  });

  it('抽出參數映射後仍保留既有 Windows 與 libx264 行為', () => {
    expect(previewVideoEncoderArgs('h264_nvenc')).toContain('h264_nvenc');
    expect(previewVideoEncoderArgs('libx264')).toEqual([
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
    ]);
    expect(deliveryVideoEncoderArgs('h264_qsv', 6000)).toEqual([
      '-c:v', 'h264_qsv', '-b:v', '6000k', '-maxrate', '6000k', '-bufsize', '12000k',
    ]);
  });

  it('每個可探測的硬體編碼器都同時有 proxy 與交付參數映射', () => {
    for (const platform of ['win32', 'darwin']) {
      for (const encoder of videoEncoderCandidates(platform)) {
        expect(previewVideoEncoderArgs(encoder).slice(0, 2)).toEqual(['-c:v', encoder]);
        expect(deliveryVideoEncoderArgs(encoder, 6000).slice(0, 2)).toEqual(['-c:v', encoder]);
      }
    }
  });

  it('第一版只在 Windows 啟用已驗證的 mpv HWND 嵌入', () => {
    expect(mpvEmbeddingSupported('win32')).toBe(true);
    expect(mpvEmbeddingSupported('darwin')).toBe(false);
  });
});
