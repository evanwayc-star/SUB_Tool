const SAMPLE_RATE = 16000;
const CHUNK_LENGTH_SECONDS = 30;
const STRIDE_LENGTH_SECONDS = 5;
const MAX_NEW_TOKENS = 256;

export function resolveBuiltinExecutionPlan({
  hasWebGpu,
  webgpuDtype = 'fp32',
  wasmDtype = 'q8'
} = {}) {
  return hasWebGpu
    ? { device: 'webgpu', dtype: webgpuDtype }
    : { device: 'wasm', dtype: wasmDtype };
}

export function buildBuiltinGenerationOptions({ language, prompt, streamer } = {}) {
  const options = {
    return_timestamps: true,
    chunk_length_s: CHUNK_LENGTH_SECONDS,
    stride_length_s: STRIDE_LENGTH_SECONDS,
    max_new_tokens: MAX_NEW_TOKENS,
    streamer
  };
  if (language && language !== 'auto') {
    options.language = language;
    options.task = 'transcribe';
  }
  if (prompt && prompt.trim()) options.prompt = prompt.trim();
  return options;
}

export function countBuiltinInferenceChunks(sampleCount) {
  const windowSamples = SAMPLE_RATE * CHUNK_LENGTH_SECONDS;
  const jumpSamples = windowSamples - (2 * SAMPLE_RATE * STRIDE_LENGTH_SECONDS);
  return Math.max(1, Math.ceil((sampleCount - windowSamples) / jumpSamples) + 1);
}

export function createBuiltinChunkProgressStreamer({
  totalChunks,
  onProgress,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  tokenUpdateInterval = 8
}) {
  let completedChunks = 0;
  let putCalls = 0;
  let chunkStartedAt = now();
  return {
    put() {
      putCalls++;
      // Whisper 每個 generate 的第一次 put 是 prompt，之後每次 put 才是新 token。
      const decodedTokens = Math.max(0, putCalls - 1);
      if (decodedTokens <= 0 || (decodedTokens !== 1 && decodedTokens % tokenUpdateInterval !== 0)) return;
      onProgress?.({
        phase: 'decoding',
        activeChunk: Math.min(totalChunks, completedChunks + 1),
        decodedTokens,
        completedChunks,
        totalChunks,
        percent: Math.round((completedChunks / totalChunks) * 100),
        chunkElapsedMs: Math.max(0, Math.round(now() - chunkStartedAt))
      });
    },
    end() {
      const decodedTokens = Math.max(0, putCalls - 1);
      completedChunks = Math.min(totalChunks, completedChunks + 1);
      onProgress?.({
        phase: 'chunk-complete',
        completedChunks,
        totalChunks,
        percent: Math.round((completedChunks / totalChunks) * 100),
        decodedTokens,
        chunkElapsedMs: Math.max(0, Math.round(now() - chunkStartedAt))
      });
      putCalls = 0;
      chunkStartedAt = now();
    }
  };
}

export function normalizeBuiltinAsrSegments(output, audioDuration) {
  const segments = [];
  if (Array.isArray(output?.chunks) && output.chunks.length > 0) {
    for (const chunk of output.chunks) {
      const text = typeof chunk?.text === 'string' ? chunk.text.trim() : '';
      if (!text) continue;
      const start = chunk.timestamp?.[0] != null ? Number(chunk.timestamp[0]) : 0;
      const end = chunk.timestamp?.[1] != null ? Number(chunk.timestamp[1]) : (start + 2);
      segments.push({
        start: Number.isFinite(start) ? start : 0,
        end: Number.isFinite(end) ? end : (Number.isFinite(start) ? start + 2 : 2),
        text
      });
    }
  } else if (typeof output?.text === 'string' && output.text.trim()) {
    segments.push({ start: 0, end: audioDuration, text: output.text.trim() });
  }
  return segments;
}

export const BUILTIN_ASR_RUNTIME = Object.freeze({
  sampleRate: SAMPLE_RATE,
  chunkLengthSeconds: CHUNK_LENGTH_SECONDS,
  strideLengthSeconds: STRIDE_LENGTH_SECONDS,
  maxNewTokens: MAX_NEW_TOKENS
});
