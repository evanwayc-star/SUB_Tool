import { describe, expect, it, vi } from 'vitest';

import {
  BUILTIN_ASR_RUNTIME,
  buildBuiltinGenerationOptions,
  countBuiltinInferenceChunks,
  createBuiltinChunkProgressStreamer,
  normalizeBuiltinAsrSegments,
  resolveBuiltinExecutionPlan
} from '../src/speech-recognition-worker-runtime.js';

describe('本機 ASR Worker runtime 規則', () => {
  it('2 分 31 秒音訊依 29 秒 window／5 秒 stride 計為 8 個真實推論段', () => {
    expect(countBuiltinInferenceChunks(151 * 16000)).toBe(8);
    expect(countBuiltinInferenceChunks(29 * 16000)).toBe(1);
    expect(countBuiltinInferenceChunks(30 * 16000)).toBe(2);
  });

  it('只有每個外層推論段真正 end 時才增加百分比', () => {
    const onProgress = vi.fn();
    let nowMs = 1000;
    const streamer = createBuiltinChunkProgressStreamer({
      totalChunks: 2,
      onProgress,
      now: () => nowMs
    });

    streamer.put();
    expect(onProgress).not.toHaveBeenCalled();
    nowMs = 1250;
    streamer.put();
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: 'decoding',
      activeChunk: 1,
      decodedTokens: 1,
      completedChunks: 0,
      totalChunks: 2
    }));
    nowMs = 1500;
    streamer.end();
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: 'chunk-complete',
      completedChunks: 1,
      totalChunks: 2,
      percent: 50,
      decodedTokens: 1,
      chunkElapsedMs: 500
    }));
    streamer.end();
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: 'chunk-complete',
      completedChunks: 2,
      totalChunks: 2,
      percent: 100
    }));
  });

  it('WebGPU 使用 Whisper 官方混合精度，CPU fallback 改用 q8', () => {
    const webgpuDtype = { encoder_model: 'fp32', decoder_model_merged: 'q4' };
    expect(resolveBuiltinExecutionPlan({
      hasWebGpu: true,
      webgpuDtype,
      wasmDtype: 'q8'
    })).toEqual({ device: 'webgpu', dtype: webgpuDtype });
    expect(resolveBuiltinExecutionPlan({
      hasWebGpu: false,
      webgpuDtype,
      wasmDtype: 'q8'
    })).toEqual({ device: 'wasm', dtype: 'q8' });
  });

  it('逐字時間模式以 29 秒 window 推論並保留 256 個新 token 的硬上限', () => {
    const streamer = { put() {}, end() {} };
    expect(buildBuiltinGenerationOptions({
      language: 'zh',
      prompt: '',
      streamer
    })).toEqual({
      return_timestamps: 'word',
      chunk_length_s: 29,
      stride_length_s: 5,
      max_new_tokens: BUILTIN_ASR_RUNTIME.maxNewTokens,
      language: 'zh',
      task: 'transcribe',
      streamer
    });
    expect(BUILTIN_ASR_RUNTIME.maxNewTokens).toBe(256);
  });

  it('把 Whisper 逐字 chunks 合成字幕段落並保留每個真正的 word timestamp', () => {
    expect(normalizeBuiltinAsrSegments({
      chunks: [
        { timestamp: [0.25, 0.7], text: ' Hello' },
        { timestamp: [0.7, 1.2], text: ' world.' },
        { timestamp: [2.8, 3.2], text: ' Next' },
        { timestamp: [3.2, 3.6], text: ' line!' }
      ]
    }, 5)).toEqual([
      {
        start: 0.25,
        end: 1.2,
        text: 'Hello world.',
        words: [
          { start: 0.25, end: 0.7, text: 'Hello' },
          { start: 0.7, end: 1.2, text: 'world.' }
        ]
      },
      {
        start: 2.8,
        end: 3.6,
        text: 'Next line!',
        words: [
          { start: 2.8, end: 3.2, text: 'Next' },
          { start: 3.2, end: 3.6, text: 'line!' }
        ]
      }
    ]);
  });

  it('修補 Whisper 的零長度 word timestamp 並維持時間單調', () => {
    const result = normalizeBuiltinAsrSegments({
      chunks: [
        { timestamp: [0, 0], text: ' Start' },
        { timestamp: [0.4, 0.8], text: ' now.' }
      ]
    }, 1);

    expect(result[0].words[0]).toEqual({ start: 0, end: 0.4, text: 'Start' });
    expect(result[0].words[1]).toEqual({ start: 0.4, end: 0.8, text: 'now.' });
    expect(result[0].end).toBeGreaterThan(result[0].start);
  });

  it('繁中逐字時間合句時不會在漢字間插入空白', () => {
    expect(normalizeBuiltinAsrSegments({
      chunks: [
        { timestamp: [0, 0.3], text: '你' },
        { timestamp: [0.3, 0.6], text: '好' },
        { timestamp: [0.6, 0.8], text: '！' }
      ]
    }, 1)).toEqual([{
      start: 0,
      end: 0.8,
      text: '你好！',
      words: [
        { start: 0, end: 0.3, text: '你' },
        { start: 0.3, end: 0.6, text: '好' },
        { start: 0.6, end: 0.8, text: '！' }
      ]
    }]);
  });
});
