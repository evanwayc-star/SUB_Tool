import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  buildIngestArgs,
  deliveryVideoEncoderArgs,
} = require('../electron/ffmpeg-execution-engine.js');

describe('Proxy 全 I 幀（All-Intra）轉檔契約', () => {
  it('離線 Ingest（isStream: false）產生的 Proxy 參數必須包含 -g 1, -keyint_min 1, -bf 0, -flags +cgop', () => {
    const args = buildIngestArgs({
      src: 'C:/media/source.mp4',
      needsProxy: true,
      proxyPath: 'C:/cache/proxy.mp4',
      encoder: 'libx264',
      isStream: false,
    });

    // 必須包含全 I 幀（GOP=1、無 B 幀、閉合 GOP）核心參數
    expect(args).toContain('-g');
    expect(args[args.indexOf('-g') + 1]).toBe('1');
    expect(args).toContain('-keyint_min');
    expect(args[args.indexOf('-keyint_min') + 1]).toBe('1');
    expect(args).toContain('-bf');
    expect(args[args.indexOf('-bf') + 1]).toBe('0');
    expect(args).toContain('-flags');
    expect(args[args.indexOf('-flags') + 1]).toBe('+cgop');
    expect(args).toContain('-movflags');
    expect(args[args.indexOf('-movflags') + 1]).toBe('+faststart');

    // 絕對不能殘留舊有的 0.5 秒強制關鍵幀表達式
    expect(args).not.toContain('-force_key_frames');
    expect(args).not.toContain('expr:gte(t,n_forced*0.5)');
  });

  it('邊轉邊看串流 Ingest（isStream: true）亦維持全 I 幀與 fragment 輸出', () => {
    const args = buildIngestArgs({
      src: 'C:/media/source.mp4',
      needsProxy: true,
      proxyPath: 'C:/cache/stream_proxy.mp4',
      encoder: 'h264_nvenc',
      isStream: true,
    });

    expect(args).toContain('-g');
    expect(args[args.indexOf('-g') + 1]).toBe('1');
    expect(args).toContain('-keyint_min');
    expect(args[args.indexOf('-keyint_min') + 1]).toBe('1');
    expect(args).toContain('-bf');
    expect(args[args.indexOf('-bf') + 1]).toBe('0');
    expect(args).toContain('-flags');
    expect(args[args.indexOf('-flags') + 1]).toBe('+cgop');
    expect(args).toContain('-movflags');
    expect(args[args.indexOf('-movflags') + 1]).toBe('frag_keyframe+empty_moov+default_base_moof');
  });

  it('硬體加速編碼器（如 h264_nvenc / h264_videotoolbox）皆正確繼承全 I 幀結構', () => {
    for (const encoder of ['h264_nvenc', 'h264_videotoolbox', 'h264_qsv', 'h264_amf']) {
      const args = buildIngestArgs({
        src: 'C:/media/source.mp4',
        needsProxy: true,
        proxyPath: `C:/cache/${encoder}_proxy.mp4`,
        encoder,
        isStream: false,
      });

      expect(args).toContain('-g');
      expect(args[args.indexOf('-g') + 1]).toBe('1');
      expect(args).toContain('-keyint_min');
      expect(args[args.indexOf('-keyint_min') + 1]).toBe('1');
      expect(args).toContain('-bf');
      expect(args[args.indexOf('-bf') + 1]).toBe('0');
      expect(args).toContain('-flags');
      expect(args[args.indexOf('-flags') + 1]).toBe('+cgop');
    }
  });

  it('最終匯出交付（deliveryVideoEncoderArgs）維持標準目標碼率與標準壓縮，絕不被 Proxy 全 I 參數污染', () => {
    const deliveryArgs = deliveryVideoEncoderArgs('libx264', 8000);
    // 匯出必須使用標準指定碼率與緩衝
    expect(deliveryArgs).toContain('-b:v');
    expect(deliveryArgs[deliveryArgs.indexOf('-b:v') + 1]).toBe('8000k');
    expect(deliveryArgs).toContain('-maxrate');
    expect(deliveryArgs[deliveryArgs.indexOf('-maxrate') + 1]).toBe('8000k');

    // 匯出不應被強制塞入全 I 幀 GOP=1，以維持合理的成品體積
    expect(deliveryArgs).not.toContain('-g');
  });
});
