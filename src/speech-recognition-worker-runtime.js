const SAMPLE_RATE = 16000;
const CHUNK_LENGTH_SECONDS = 29;
const STRIDE_LENGTH_SECONDS = 5;
const MAX_NEW_TOKENS = 256;
const WORD_GROUP_MAX_GAP_SECONDS = 1.25;
const WORD_GROUP_MAX_DURATION_SECONDS = 12;
const WORD_GROUP_MAX_WORDS = 40;

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
    return_timestamps: 'word',
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
  if (!Array.isArray(output?.chunks) || output.chunks.length === 0) {
    return typeof output?.text === 'string' && output.text.trim()
      ? [{ start: 0, end: audioDuration, text: output.text.trim() }]
      : [];
  }

  const duration = Number(audioDuration);
  const boundedDuration = Number.isFinite(duration) && duration > 0 ? duration : null;
  const sourceWords = output.chunks
    .map(chunk => ({
      rawText: typeof chunk?.text === 'string' ? chunk.text : '',
      text: typeof chunk?.text === 'string' ? chunk.text.trim() : '',
      timestamp: Array.isArray(chunk?.timestamp) ? chunk.timestamp : []
    }))
    .filter(word => word.text);
  const words = [];
  let previousEnd = 0;

  for (let index = 0; index < sourceWords.length; index += 1) {
    const source = sourceWords[index];
    const rawStart = Number(source.timestamp[0]);
    const rawEnd = Number(source.timestamp[1]);
    const nextStart = Number(sourceWords[index + 1]?.timestamp?.[0]);
    const start = Math.max(previousEnd, Number.isFinite(rawStart) ? rawStart : previousEnd);
    if (boundedDuration != null && start >= boundedDuration) continue;

    let end = Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : null;
    if (end == null && Number.isFinite(nextStart) && nextStart > start) end = nextStart;
    if (end == null) end = start + 0.08;
    if (boundedDuration != null) end = Math.min(boundedDuration, end);
    if (!(end > start)) continue;

    words.push({
      start,
      end,
      text: source.text,
      rawText: source.rawText
    });
    previousEnd = end;
  }

  const segments = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    let text = '';
    for (const word of group) {
      const punctuation = /^[,.;:!?%)\]}，。！？、：；」』】）》…]/u.test(word.text);
      const cjkBoundary = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(text) ||
        /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(word.text);
      const needsSpace = text && !punctuation && !cjkBoundary && (/^\s/u.test(word.rawText) || /[\p{L}\p{N}]$/u.test(text));
      text += `${needsSpace ? ' ' : ''}${word.text}`;
    }
    segments.push({
      start: group[0].start,
      end: group.at(-1).end,
      text,
      words: group.map(({ start, end, text: wordText }) => ({ start, end, text: wordText }))
    });
    group = [];
  };

  for (const word of words) {
    const gap = group.length ? word.start - group.at(-1).end : 0;
    if (group.length && gap > WORD_GROUP_MAX_GAP_SECONDS) flush();
    group.push(word);
    const durationSeconds = group.at(-1).end - group[0].start;
    const endsSentence = /[.!?。！？…]["'”’」』）】]*$/u.test(word.text);
    if (endsSentence || durationSeconds >= WORD_GROUP_MAX_DURATION_SECONDS || group.length >= WORD_GROUP_MAX_WORDS) {
      flush();
    }
  }
  flush();
  return segments;
}

export const BUILTIN_ASR_RUNTIME = Object.freeze({
  sampleRate: SAMPLE_RATE,
  chunkLengthSeconds: CHUNK_LENGTH_SECONDS,
  strideLengthSeconds: STRIDE_LENGTH_SECONDS,
  maxNewTokens: MAX_NEW_TOKENS
});
