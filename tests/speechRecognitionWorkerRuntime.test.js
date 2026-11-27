import { describe, expect, it, vi } from 'vitest';

import {
  BUILTIN_ASR_RUNTIME,
  buildBuiltinGenerationOptions,
  countBuiltinInferenceChunks,
  createBuiltinChunkProgressStreamer,
  detectBuiltinSpeechLanguage,
  hasCompleteBuiltinWordTimes,
  normalizeBuiltinAsrSegments,
  resolveBuiltinExecutionPlan
} from '../src/speech-recognition-worker-runtime.js';

describe('本機 ASR Worker runtime 規則', () => {
  it('在同一個 Whisper 上取第一個 decoder token 的語言分數，忽略更高的非語言 token 並釋放張量', async () => {
    const feature = { dispose: vi.fn() };
    const logits = { data: Float32Array.of(8, -3, 2, 5, 1), dispose: vi.fn() };
    const kv = { dispose: vi.fn() };
    const model = vi.fn(async () => ({ logits, 'present.0.encoder.key': kv }));
    model.generation_config = { decoder_start_token_id: 50258, lang_to_id: { '<|en|>': 1, '<|zh|>': 2, '<|ko|>': 3, '<|ja|>': 4 } };
    const processor = vi.fn(async () => ({ input_features: feature }));
    class Tensor {
      constructor(type, data, dims) { Object.assign(this, { type, data, dims }); }
      dispose = vi.fn();
    }
    const samples = new Float32Array(40 * 16000);
    samples[16000] = 0.4;
    await expect(detectBuiltinSpeechLanguage({ processor, model }, samples, Tensor)).resolves.toBe('ko');
    expect(processor.mock.calls[0][0]).toHaveLength(30 * 16000);
    expect(processor.mock.calls[0][0][0]).toBeCloseTo(.4);
    const inputs = model.mock.calls[0][0];
    expect(inputs.input_features).toBe(feature);
    expect(inputs.decoder_input_ids).toMatchObject({ type: 'int64', data: BigInt64Array.of(50258n), dims: [1, 1] });
    for (const tensor of [feature, logits, kv, inputs.decoder_input_ids]) expect(tensor.dispose).toHaveBeenCalledOnce();
    await expect(detectBuiltinSpeechLanguage({ processor, model }, new Float32Array(1), Tensor)).resolves.toBe(null);
    expect(model).toHaveBeenCalledOnce();
  });

  it('完整逐詞輸出才能作為文本匹配的逐詞證據', () => {
    const word = timestamp => ({ text: '電視', timestamp });
    expect(hasCompleteBuiltinWordTimes({ chunks: [word([.3, .6])] }, 1)).toBe(true);
    for (const timestamp of [[null, .3], [.3, null], [.3, .3], [-.2, .3], [1, 2]]) {
      expect(hasCompleteBuiltinWordTimes({ chunks: [word(timestamp)] }, 1)).toBe(false);
    }
    expect(hasCompleteBuiltinWordTimes({ text: '電視' }, 1)).toBe(false);
    expect(hasCompleteBuiltinWordTimes({ text: '' }, 1)).toBe(true);
  });

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
      streamer,
      do_sample: false
    });
    expect(BUILTIN_ASR_RUNTIME.maxNewTokens).toBe(256);
  });

  it('正溫度啟用sampling；零或無效溫度不傳入禁止為零的warper',()=>{
    expect(buildBuiltinGenerationOptions({temperature:0.5})).toMatchObject({do_sample:true,temperature:0.5});
    expect(buildBuiltinGenerationOptions({temperature:2})).toMatchObject({do_sample:true,temperature:1});
    for(const temperature of [0,-1,NaN,Infinity]){
      const options=buildBuiltinGenerationOptions({temperature});
      expect(options.do_sample).toBe(false);
      expect(options).not.toHaveProperty('temperature');
    }
  });

  it('支援指定 returnTimestamps 為 true 以使用原生時間戳記', () => {
    const streamer = { put() {}, end() {} };
    const options = buildBuiltinGenerationOptions({
      language: 'zh',
      prompt: '',
      streamer,
      returnTimestamps: true
    });
    expect(options.return_timestamps).toBe(true);
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

  it('完整 Large v3 的原生句級時間逐句輸出',()=>{
    const chunks=[{timestamp:[.25,1.5],text:' 第一段'},{timestamp:[1.7,3.1],text:' 第二段。'}];
    expect(normalizeBuiltinAsrSegments({chunks},3,true)).toEqual([
      {start:.25,end:1.5,text:'第一段'},{start:1.7,end:3,text:'第二段。'}
    ]);
    expect(normalizeBuiltinAsrSegments({text:'',chunks:[]},3,true)).toEqual([]);
    expect(()=>normalizeBuiltinAsrSegments({text:'無時間'},3,true)).toThrow('時間碼');
    expect(()=>normalizeBuiltinAsrSegments({chunks:[{text:'不完整',timestamp:[1,null]}]},3,true)).toThrow('起訖時間');
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
