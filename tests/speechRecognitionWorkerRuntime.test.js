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
  it('2 分 31 秒音訊依 30 秒 window／5 秒 stride 計為 8 個真實推論段', () => {
    expect(countBuiltinInferenceChunks(151 * 16000)).toBe(8);
    expect(countBuiltinInferenceChunks(30 * 16000)).toBe(1);
    expect(countBuiltinInferenceChunks(31 * 16000)).toBe(2);
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

  it('每個 30 秒 window 有 256 個新 token 的硬上限，避免無 EOS 無限拖慢', () => {
    const streamer = { put() {}, end() {} };
    expect(buildBuiltinGenerationOptions({
      language: 'zh',
      prompt: '',
      streamer
    })).toEqual({
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
      max_new_tokens: BUILTIN_ASR_RUNTIME.maxNewTokens,
      language: 'zh',
      task: 'transcribe',
      streamer
    });
    expect(BUILTIN_ASR_RUNTIME.maxNewTokens).toBe(256);
  });

  it('把 Whisper chunks 正規化成字幕段落並保留真正時間戳', () => {
    expect(normalizeBuiltinAsrSegments({
      chunks: [
        { timestamp: [0.25, 1.75], text: ' 第一段 ' },
        { timestamp: [1.75, 3], text: '第二段' }
      ]
    }, 5)).toEqual([
      { start: 0.25, end: 1.75, text: '第一段' },
      { start: 1.75, end: 3, text: '第二段' }
    ]);
  });
});
