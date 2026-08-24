import { describe, it, expect } from 'vitest';
import {
  encodeASS,
  encodeSRT,
  encodeVTT,
  parseSubtitleStream,
} from '../src/subtitle-transcoding-engine.js';

describe('subtitle-transcoding-engine', () => {
  const mockCues = [
    { id: '1', start: 1.0, end: 3.5, text: '第一行字幕' },
    { id: '2', start: 4.0, end: 6.0, text: '第二行字幕\n包含換行' },
  ];

  it('正確將字幕序列化為 ASS 格式並符合 ADR-0002 字幕畫布與標頭規範', () => {
    const ass = encodeASS(mockCues, {
      title: '測試專案',
      styles: [{ name: 'Default', font: '更紗黑體', size: 60, color: '#ffffff' }],
    });

    expect(ass).toContain('[Script Info]');
    expect(ass).toContain('PlayResX: 1920');
    expect(ass).toContain('PlayResY: 1080');
    expect(ass).toContain('Style: Default,更紗黑體,60');
    expect(ass).toContain('Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,第一行字幕');
    expect(ass).toContain('Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,第二行字幕\\N包含換行');
  });

  it('正確將字幕序列化為 SRT 與 WebVTT 格式', () => {
    const srt = encodeSRT(mockCues);
    expect(srt).toContain('00:00:01,000 --> 00:00:03,500');
    expect(srt).toContain('第一行字幕');

    const vtt = encodeVTT(mockCues);
    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('00:00:01.000 --> 00:00:03.500');
    expect(vtt).toContain('第一行字幕');
  });

  it('正確解析輸入串流並識別格式', () => {
    const rawSrt = `1\n00:00:01,000 --> 00:00:03,500\n測試 SRT 解析\n\n`;
    const res = parseSubtitleStream(rawSrt);
    expect(res.format).toBe('srt');
    expect(res.cues.length).toBe(1);
    expect(res.cues[0].text).toBe('測試 SRT 解析');
  });
});
