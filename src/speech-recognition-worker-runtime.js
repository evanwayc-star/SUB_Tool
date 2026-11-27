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

// Transformers.js 3.3.3 substitutes English when language is omitted. Follow
// Whisper's detect_language: decode just <|startoftranscript|> and compare
// only the language token logits from this multilingual model.
export async function detectBuiltinSpeechLanguage(transcriber, samples, Tensor) {
  const config = transcriber.model.generation_config;
  const tokens = Object.entries(config?.lang_to_id || {});
  const regions = Math.min(3, Math.max(1, Math.floor(samples.length / (SAMPLE_RATE * 30))));
  const totals = new Map();
  let used = 0;
  for (let region = 0; region < regions; region++) {
    const left = Math.floor((region * samples.length) / regions),
      right = Math.floor(((region + 1) * samples.length) / regions);
    const first = samples.subarray(left, right).findIndex((value) => value !== 0);
    if (first < 0) continue;
    if (!Number.isInteger(config?.decoder_start_token_id) || !tokens.length)
      throw new Error('本機模型缺少自動偵測語言所需的設定。');
    const start = left + first;
    const features = await transcriber.processor(
      samples.subarray(start, Math.min(right, start + SAMPLE_RATE * 30))
    );
    const decoderStart = new Tensor('int64', BigInt64Array.of(BigInt(config.decoder_start_token_id)), [1, 1]);
    let outputs;
    try {
      outputs = await transcriber.model({
        input_features: features.input_features,
        decoder_input_ids: decoderStart
      });
      const logits = outputs.logits.data;
      const highest = Math.max(...tokens.map(([, id]) => (Number.isFinite(logits[id]) ? logits[id] : -Infinity)));
      if (!Number.isFinite(highest)) continue;
      const weights = tokens.map(([, id]) => (Number.isFinite(logits[id]) ? Math.exp(logits[id] - highest) : 0));
      const total = weights.reduce((sum, x) => sum + x, 0);
      tokens.forEach(([token], i) => totals.set(token, (totals.get(token) || 0) + weights[i] / total));
      used++;
    } finally {
      for (const tensor of Object.values(outputs || {})) tensor.dispose();
      decoderStart.dispose();
      for (const tensor of Object.values(features)) tensor.dispose();
    }
  }
  if (!used && !samples.some((value) => value !== 0)) return null;
  const results = [...totals].sort((a, b) => b[1] - a[1]);
  if (!results.length || (results[0][1] - (results[1]?.[1] || 0)) / used < 0.05)
    throw new Error('不同音訊段落無法可靠辨別主要語言，請指定語言後重試。');
  return results[0][0].slice(2, -2);
}

export function hasCompleteBuiltinWordTimes(output, audioDuration) {
  const chunks = (output?.chunks || []).filter(chunk => chunk?.text?.trim());
  if (!chunks.length) return !output?.text?.trim();
  let previousEnd = 0;
  return chunks.every(chunk => {
    const [start, end] = chunk.timestamp || [];
    const valid = Number.isFinite(start) && Number.isFinite(end) && start >= previousEnd && start < audioDuration && end > start;
    previousEnd = end;
    return valid;
  });
}

export async function transcribeBuiltinSegments(transcriber, samples, options, fallbackStreamer) {
  const duration = samples.length / SAMPLE_RATE;
  const timestamps = options.return_timestamps;
  let result;
  try {
    result = await transcriber(samples, options);
  } catch (error) {
    const message = String(error?.message || '');
    if (timestamps !== 'word' || !/cross attentions|output_attentions/.test(message)) throw error;
  }
  if (timestamps === 'word' && (!result || !hasCompleteBuiltinWordTimes(result, duration))) {
    const sentenceResult = await transcriber(samples, {
      ...options, return_timestamps: true, streamer: fallbackStreamer()
    });
    return normalizeBuiltinAsrSegments(sentenceResult, duration, true);
  }
  return normalizeBuiltinAsrSegments(result, duration, timestamps);
}

export function buildBuiltinGenerationOptions({ language, prompt, temperature = 0, streamer, returnTimestamps = 'word' } = {}) {
  const value=Number(temperature);
  const samplingTemperature=Number.isFinite(value)?Math.min(1,Math.max(0,value)):0;
  const options = {
    return_timestamps: returnTimestamps,
    chunk_length_s: CHUNK_LENGTH_SECONDS,
    stride_length_s: STRIDE_LENGTH_SECONDS,
    max_new_tokens: MAX_NEW_TOKENS,
    streamer,
    do_sample: samplingTemperature>0
  };
  // Transformers 3.3.3 的 temperature warper 必須大於 0；0 明確用 greedy。
  if(samplingTemperature>0) options.temperature=samplingTemperature;
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

export function normalizeBuiltinAsrSegments(output, audioDuration, timestamps = 'word') {
  if (timestamps === true) {
    const chunks = Array.isArray(output?.chunks) ? output.chunks : [];
    const segments = [];
    for (const chunk of chunks) {
      const text = typeof chunk?.text === 'string' ? chunk.text.trim() : '';
      if (!text) continue;
      const [start, end] = Array.isArray(chunk.timestamp) ? chunk.timestamp : [];
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || start >= audioDuration) {
        throw new Error('本機模型沒有回傳完整的字幕起訖時間，請縮小辨識範圍後重試。');
      }
      segments.push({ start, end: Math.min(end, audioDuration), text });
    }
    if (!segments.length && output?.text?.trim()) throw new Error('本機模型沒有回傳字幕時間碼。');
    return segments;
  }
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
