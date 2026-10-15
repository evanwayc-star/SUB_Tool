import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nativeTestTools } from './fixtures/native-tools.cjs';

describe('原生內容測試的工具來源', () => {
  it('沒有內建工具的 checkout 使用兩個獨立 CI 指定位置', () => {
    const root = path.resolve('empty-checkout');
    const env = { FFMPEG_PATH: path.resolve('encoding-tools/ffmpeg.exe'),
      FFPROBE_PATH: path.resolve('probe-tools/ffprobe.exe') };
    expect(nativeTestTools({ root, env })).toEqual({ ffmpeg: env.FFMPEG_PATH, ffprobe: env.FFPROBE_PATH });
  });

  it('只指定其中一支工具時，不從它的目錄推導另一支工具', () => {
    const root = path.resolve('checkout');
    expect(nativeTestTools({ root, env: { FFMPEG_PATH: path.resolve('encoding-tools/ffmpeg.exe') } }))
      .toMatchObject({ ffprobe: path.join(root, 'electron', 'ffmpeg', 'ffprobe.exe') });
    expect(nativeTestTools({ root, env: { FFPROBE_PATH: path.resolve('probe-tools/ffprobe.exe') } }))
      .toMatchObject({ ffmpeg: path.join(root, 'electron', 'ffmpeg', 'ffmpeg.exe') });
  });
});
