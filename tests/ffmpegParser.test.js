import { describe, it, expect } from 'vitest';
import { FFmpegOutputParser, FFmpegErrorAnalyzer } from '../electron/ffmpeg-execution-engine.js';

describe('FFmpegOutputParser', () => {
  it('parses stream maps correctly', () => {
    const parser = new FFmpegOutputParser(100);
    parser.parseChunk('Stream #0:0 -> #0:0 (h264 (native) -> h264 (h264_nvenc))');
    expect(parser.maps.length).toBe(1);
    expect(parser.maps[0]).toBe('h264 (native) -> h264 (h264_nvenc)');
  });

  it('parses progress and estimates ETA based on speed', () => {
    const parser = new FFmpegOutputParser(3600); // 1 hour duration
    // Speed chunk
    parser.parseChunk('frame=  100 fps= 50 q=28.0 size=    256kB time=00:00:02.00 bitrate=1048.5kbits/s speed=2.0x');
    expect(parser.speeds).toEqual([2.0]);
    
    // Time chunk (same chunk)
    const result = parser.parseChunk('frame=  100 fps= 50 q=28.0 size=    256kB time=00:10:00.00 bitrate=1048.5kbits/s speed=2.0x');
    expect(result.pct).toBe(17); // 10 minutes out of 60 minutes = 16.66% -> rounded to 17
    
    // Remaining time: 50 minutes (3000s). Speed is 2.0x, so ETA should be 1500s.
    expect(result.etaS).toBe(1500);
  });
});

describe('FFmpegErrorAnalyzer', () => {
  it('identifies OUTPUT_BUSY from watchdog failure', () => {
    const result = FFmpegErrorAnalyzer.analyze('some logs', 1, { code: 'OUTPUT_BUSY' }, null, 'C:/out.mp4');
    expect(result.errorCode).toBe('OUTPUT_BUSY');
    expect(result.summary).toBe('同一個輸出檔案正在由另一份工作使用：C:/out.mp4');
  });

  it('identifies no such file', () => {
    const log = `ffmpeg version 6.0
C:/missing.mp4: No such file or directory
Exiting normally.`;
    const result = FFmpegErrorAnalyzer.analyze(log, 1, null, null, 'out.mp4');
    expect(result.summary).toBe('找不到來源檔：C:/missing.mp4');
  });

  it('identifies permission denied', () => {
    const log = `ffmpeg version 6.0
C:/out.mp4: Permission denied`;
    const result = FFmpegErrorAnalyzer.analyze(log, 1, null, null, 'C:/out.mp4');
    expect(result.summary).toBe('輸出路徑無寫入權限：C:/out.mp4');
  });

  it('falls back to generic log slicing for unknown errors', () => {
    const log = 'line 1\nline 2\nline 3';
    const result = FFmpegErrorAnalyzer.analyze(log, 1, null, null, 'out.mp4');
    expect(result.summary).toBe('line 1\nline 2\nline 3');
    expect(result.errorCode).toBe('FFMPEG_EXIT');
  });
});
