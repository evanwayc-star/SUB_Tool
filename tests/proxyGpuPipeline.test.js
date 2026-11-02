import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { buildIngestArgs, previewPipelineCandidates, previewFallbackAllowed, deliveryVideoEncoderArgs } = require('../electron/ffmpeg-execution-engine.js');
const video = { codec: 'h264', width: 1920, height: 1080, pixelFormat: 'yuv420p', fieldOrder: 'progressive',
  colorSpace: 'bt709', colorPrimaries: 'bt709', colorTransfer: 'bt709', colorRange: 'tv' };
const input = { src: 'source.mp4', needsProxy: true, proxyPath: 'proxy.mp4', encoder: 'h264_nvenc', video };
const value = (args, key) => args[args.indexOf(key) + 1];

describe('Proxy GPU 管線與相容退路', () => {
  it('NVDEC 畫格留在 CUDA 完成縮放後交給 NVENC，維持格網與短 GOP', () => {
    const args = buildIngestArgs({ ...input, pipeline: { mode: 'cuda', encoder: 'h264_nvenc' } });
    expect(value(args, '-hwaccel')).toBe('cuda');
    expect(value(args, '-hwaccel_output_format')).toBe('cuda');
    expect(value(args, '-vf')).toBe('setpts=PTS-STARTPTS,scale_cuda=-2:720:format=yuv420p:interp_algo=bicubic');
    expect(value(args, '-preset')).toBe('p4');
    expect(value(args, '-cq')).toBe('26');
    expect(value(args, '-g')).toBe('2');
    expect(value(args, '-bf')).toBe('0');
    expect(value(args, '-movflags')).toBe('+faststart');
  });

  it('ProRes 軟體解碼後交 GPU 縮放編碼，保留同次音訊與串流容器', () => {
    const args = buildIngestArgs({ ...input, video: { ...video, codec: 'prores', pixelFormat: 'yuv422p10le' },
      pipeline: { mode: 'cuda-upload', encoder: 'h264_nvenc' }, isStream: true,
      fc: ['[0:a:0]asplit=2[a][w]'], channels: [{ file: 'ch.m4a' }], chMaps: ['[a]'], waveLabel: '[w]', wavePath: 'wave.wav' });
    expect(args).not.toContain('-hwaccel');
    expect(value(args, '-vf')).toContain('format=yuv420p,hwupload_cuda,scale_cuda=-2:720');
    expect(value(args, '-filter_complex')).toBe('[0:a:0]asplit=2[a][w]');
    expect(args).toContain('ch.m4a');
    expect(args).toContain('wave.wav');
    expect(value(args, '-movflags')).toBe('frag_keyframe+empty_moov+default_base_moof');
  });

  it('相容回退取消硬解但仍優先使用 NVENC，最後才切 CPU', () => {
    const attempts = previewPipelineCandidates(input);
    expect(attempts.map(({ mode, encoder }) => [mode, encoder])).toEqual([
      ['cuda', 'h264_nvenc'], ['cuda-upload', 'h264_nvenc'], ['software', 'h264_nvenc'], ['software', 'libx264'],
    ]);
    const args = buildIngestArgs({ ...input, pipeline: attempts.at(-1) });
    expect(args).not.toContain('-hwaccel');
    expect(value(args, '-c:v')).toBe('libx264');
    expect(value(args, '-g')).toBe('1');
  });

  it.each([
    { displayTransform: true }, { fieldOrder: 'tt' }, { fieldOrder: '' }, { fieldOrder: null },
    { colorTransfer: 'smpte2084' }, { colorTransfer: 'arib-std-b67' }, { colorRange: 'pc' },
    { pixelFormat: 'gbrp' }, { colorSpace: 'gbr' }, { width: 0 },
  ])('不把需特殊處理的來源 %j 送進未驗證的 GPU 縮放', extra => {
    expect(previewPipelineCandidates({ ...input, video: { ...video, ...extra } })[0].mode).toBe('compatible');
  });

  it('未知 metadata 與其他 GPU 保留原相容管線，純音訊不建立硬體重試', () => {
    expect(previewPipelineCandidates({ ...input, video: null })[0].mode).toBe('compatible');
    expect(previewPipelineCandidates({ ...input, encoder: 'h264_qsv' })[0].mode).toBe('compatible');
    expect(previewPipelineCandidates({ ...input, needsProxy: false })).toHaveLength(1);
    expect(previewPipelineCandidates({ ...input, encoder: 'libx264' })).toHaveLength(1);
  });

  it('來源未標色彩時沿用原高度判定，在 GPU resize 前凍結 601／709 解讀', () => {
    const args = buildIngestArgs({ ...input, video: { codec: 'h264', pixelFormat: 'yuv420p', width: 640, height: 480 },
      pipeline: { mode: 'cuda', encoder: 'h264_nvenc' } });
    expect(value(args, '-vf')).toContain('setparams=colorspace=smpte170m:color_primaries=smpte170m:color_trc=smpte170m:range=limited,scale_cuda=');
  });

  it.each(['CUDA_ERROR_NO_DEVICE', "No such filter: 'scale_cuda'", 'Impossible to convert between the formats supported by the filter',
    'No device available for decoder: device type cuda needed for codec h264.\nHardware device setup failed for decoder: Generic error in an external library'])
  ('辨認 GPU 管線失敗 %s，容許在尚未發布時退路', stderr => {
    expect(previewFallbackAllowed({ mode: 'cuda', encoder: 'h264_nvenc' }, Object.assign(new Error('ffmpeg failed'), { code: 'FFMPEG_EXIT' }), stderr)).toBe(true);
  });

  it.each([
    { code: 'ABORT_ERR', message: 'CUDA_ERROR_NO_DEVICE' },
    { code: 'FFMPEG_EXIT', signal: 'SIGTERM', message: 'CUDA_ERROR_NO_DEVICE' },
    { code: 'FFMPEG_EXIT', message: 'Permission denied CUDA_ERROR_NO_DEVICE' },
    { code: 'FFMPEG_EXIT', message: 'No space left on device CUDA_ERROR_NO_DEVICE' },
    { code: 'FFMPEG_EXIT', message: 'Invalid data found when processing input' },
  ])('取消、儲存錯誤或壞素材不能被硬體重試吞掉：%j', failure => {
    expect(previewFallbackAllowed({ mode: 'cuda', encoder: 'h264_nvenc' }, failure)).toBe(false);
  });

  it('軟體與正式交付設定不受 GPU Proxy 策略污染', () => {
    expect(previewFallbackAllowed({ mode: 'software', encoder: 'libx264' }, { code: 'FFMPEG_EXIT', message: 'CUDA_ERROR_NO_DEVICE' })).toBe(false);
    expect(value(deliveryVideoEncoderArgs('h264_nvenc', 8000), '-preset')).toBe('p4');
    expect(deliveryVideoEncoderArgs('h264_nvenc', 8000)).not.toContain('scale_cuda');
  });
});
