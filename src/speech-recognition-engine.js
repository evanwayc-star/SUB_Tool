/* ==============================================================================
   SUB Tool — Speech Recognition Engine (src/speech-recognition-engine.js)
   ==============================================================================
   深層語音辨識推論模組（Audio Inference Engine）。
   封裝 16kHz PCM 降採樣、WAV 二進位編碼、雲端 REST 多模態模型通訊
   （Google Gemini / Azure Speech / Groq Whisper / OpenAI Whisper）與本機 ONNX WebGPU/WASM 管線。
   ============================================================================== */
import { transcribeBuiltinAudioInWorker } from './speech-recognition-worker-client.js';
import { b64ToBytes } from './util.js';
import { fetchSpeech } from './speech-cloud.js';
import { normalizeRecognitionTerms } from './recognition-terms.js';
import { matchRecognitionTranscript } from './transcript-alignment-client.js';
import { recognitionCheckpointKey } from './speech-recognition-checkpoints.js';
import { addSpeechChannel, addSpeechChannelInBlocks } from './speech-resampler.js';
import OpenCC from 'opencc-js/cn2t';

// 16 kHz / 16-bit / mono PCM 每秒 32,000 bytes。雲端 Whisper 單段固定控制在
// 10 分鐘（約 19.2 MB WAV），為 OpenAI/Groq 的 multipart 封裝與供應商差異保留餘裕。
const WHISPER_CLOUD_CHUNK_SECONDS = 600;
const WHISPER_CLOUD_CHUNK_OVERLAP_SECONDS = 10;
const WHISPER_CLOUD_MAX_WAV_BYTES = 20_000_000;
// Gemini inline requests include base64 expansion: 300 seconds of lossless
// 16 kHz mono WAV is about 12.8 MB in JSON, within a conservative 20 MB budget
// compatible with the inline-audio guide as well as newer, larger API limits.
const GEMINI_INLINE_CHUNK_SECONDS = 300;
const WHISPER_OVERLAP_WORD_MATCH_TOLERANCE_SECONDS = 1.25;
let whisperCompressionRequestSequence = 0;

const isEditorSpeechTask = taskMode => taskMode === 'transcribe' || taskMode === 'align';

function throwIfRecognitionAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof DOMException === 'function') {
    throw new DOMException('語音辨識已取消', 'AbortError');
  }
  const error = new Error('語音辨識已取消');
  error.name = 'AbortError';
  throw error;
}

/** 內建支援之本機模型清單 */
const WEBGPU_WHISPER_MIXED_DTYPE = Object.freeze({
  encoder_model: 'fp32',
  decoder_model_merged: 'q4'
});

export const BUILTIN_MODELS = {
  'onnx-community/whisper-tiny': {
    id: 'onnx-community/whisper-tiny_timestamped',
    name: 'Tiny 逐字時間版',
    size: 'CPU 約 39MB／GPU 約 150MB',
    webgpuDtype: 'fp32',
    wasmDtype: 'q8',
    desc: '速度極快，佔用記憶體極少，適合快速草稿。'
  },
  'onnx-community/whisper-base': {
    id: 'onnx-community/whisper-base_timestamped',
    name: 'Base 逐字時間版',
    size: 'CPU 約 73MB／GPU 約 290MB',
    webgpuDtype: 'fp32',
    wasmDtype: 'q8',
    desc: '速度與準確度均衡，適合日常對白剪輯。'
  },
  'onnx-community/whisper-small': {
    id: 'onnx-community/whisper-small_timestamped',
    name: 'Small 逐字時間版',
    size: 'CPU 約 240MB／GPU 約 560MB',
    webgpuDtype: WEBGPU_WHISPER_MIXED_DTYPE,
    wasmDtype: 'q8',
    desc: '中文與繁體字辨識度更佳；GPU 使用高精度 encoder 與高效率 decoder。'
  },
  'onnx-community/whisper-large-v3-turbo': {
    id: 'onnx-community/whisper-large-v3-turbo_timestamped',
    name: 'Large v3 Turbo q4 逐字時間版',
    size: 'CPU 約 1.09 GB／GPU 約 760 MB',
    webgpuDtype: 'q4',
    wasmDtype: 'q8',
    desc: '多語言模型，提供文本匹配所需的逐詞時間碼。'
  },
  'onnx-community/whisper-large-v3': {
    id: 'onnx-community/whisper-large-v3-ONNX',
    name: 'Large v3 旗艦多語言版',
    size: 'CPU 約 1.83 GB／GPU 約 1.22 GB',
    webgpuDtype: 'q4',
    wasmDtype: 'q8',
    returnTimestamps: true,
    desc: '完整 Large v3 多語言模型，提供原生句級時間碼。'
  }
};

const simplifiedToTraditional = OpenCC.Converter({ from: 'cn', to: 't' });
const normalizeChineseAlignmentEvidence = OpenCC.Converter({ from: 'cn', to: 'twp' });
const asrLanguageEvidence = Symbol('asrLanguageEvidence');

function knownAsrLanguage(language) {
  const code = typeof language === 'string' ? language.trim().toLowerCase().replaceAll('_', '-') : '';
  return code === 'auto' || code === 'und' ? '' : code;
}

function isChineseAsrLanguage(language) {
  return /^(?:zh|zho|chi|cmn|chinese|mandarin)(?:-|$)/u.test(language);
}

function inferAsrLanguage(segments) {
  const transcript = segments.map(segment => segment.text).join(' ');
  // Japanese can contain only kanji, including forms such as 国, 学 and 会.
  // Without a provider locale, require a stronger Mandarin cue than Han text alone.
  if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(transcript)) return '';
  return /[这们吗请谢软库标识认语华东听简汉]|你好|您好|謝謝|對不起|國語|普通話/u.test(normalizeSubtitleSpacing(transcript)) ? 'zh' : '';
}

function recordAsrLanguage(segments, requestedLanguage, detectedLanguage) {
  // Provider labels are local to one response. A second request can call a
  // different person "speaker_0", even when it covers the same recording.
  const hasSpeaker = segment => segment.speaker !== undefined && segment.speaker !== null && segment.speaker !== '';
  if (segments.some(hasSpeaker)) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    const speakerScope = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    segments = segments.map(segment => hasSpeaker(segment) ? { ...segment, speakerScope } : segment);
  }
  if (knownAsrLanguage(requestedLanguage)) return segments;
  const language = knownAsrLanguage(detectedLanguage) || inferAsrLanguage(segments);
  if (!language) return segments;
  return segments.map(segment => ({ ...segment, [asrLanguageEvidence]: language }));
}

/**
 * 正規化字幕空白間距：
 * 消除中日文斷詞空白，保留韓語詞界以及中英／數字混排的空格。
 */
export function normalizeSubtitleSpacing(text, locale = 'zh') {
  if (typeof text !== 'string' || !text) return '';
  let result = text.trim();
  const compact = azureUsesCompactSpacing(locale, result);
  if (compact) {
    // 韓文詞與詞之間的空白承載詞義，即使出現在中文或日文字幕中也要保留。
    result = result.replace(/(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, '');
    // 2. 去除 CJK 與中文/通用標點符號之間的空白
    result = result.replace(/(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\s\u3000\u00A0]+(?=[，。！？、；：“‘”’「」『』（）【】《》〈〉!?,.:;])/gu, '');
    result = result.replace(/(?<=[，。！？、；：“‘」』）】》〉「『（【《〈!?,.:;])[\s\u3000\u00A0]+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, '');
  }
  // 3. 多重空白收斂為單一空格
  result = result.replace(/[\s\u3000\u00A0]+/gu, ' ').trim();
  return result;
}

export function convertAsrSegmentsToTraditionalChinese(segments, language = 'zh', { taskMode, provider } = {}) {
  const requestedLanguage = knownAsrLanguage(language);
  if (!Array.isArray(segments) || (requestedLanguage && !isChineseAsrLanguage(requestedLanguage))) return segments;
  // Text matching uses a copy of the speech evidence; its subtitles use the supplied script.
  const forAlignment = taskMode === 'align';
  const convert = forAlignment ? normalizeChineseAlignmentEvidence : simplifiedToTraditional;
  return segments.map(segment => {
    const { [asrLanguageEvidence]: responseLanguage, ...result } = segment || {};
    const detectedLanguage = !forAlignment || provider === 'builtin'
      ? knownAsrLanguage(result.locale) || responseLanguage
      : '';
    const effectiveLanguage = requestedLanguage || detectedLanguage;
    if (isChineseAsrLanguage(effectiveLanguage) && typeof result.text === 'string') {
      const original = result.text;
      result.text = convert(normalizeSubtitleSpacing(original, 'zh'));
      if (result.text !== original) result.originalText ??= original;
    }
    return result;
  });
}

/**
 * 將 Blob 轉換為 Base64 字串
 */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result;
      const base64 = typeof dataUrl === 'string' ? dataUrl.split(',')[1] : '';
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * 萃取指定區間並重採樣為 16,000 Hz 單聲道 Float32Array
 * （供 Transformers.js 本機推論引擎直接使用）
 */
function downmixAndResampleMono16k(audioBuffer, startSec = 0, endSec = null) {
  if (!audioBuffer) return null;
  const srcSampleRate = audioBuffer.sampleRate;
  const numChannels = audioBuffer.numberOfChannels;
  const startSample = Math.max(0, Math.floor(startSec * srcSampleRate));
  // A complete range-reader buffer already has an exact sample count. Avoid
  // losing its final sample when duration * sampleRate rounds just below it.
  const endSample = endSec == null || endSec >= audioBuffer.duration
    ? audioBuffer.length
    : Math.min(audioBuffer.length, Math.floor(endSec * srcSampleRate));
  const srcLength = Math.max(0, endSample - startSample);
  if (srcLength <= 0) return null;

  const targetSampleRate = 16000;
  const targetLength = Math.floor(srcLength * (targetSampleRate / srcSampleRate));
  if (targetLength <= 0) return null;

  const targetSamples = new Float32Array(targetLength);
  for (let ch = 0; ch < numChannels; ch++) {
    addSpeechChannel(targetSamples,audioBuffer.getChannelData(ch),srcSampleRate,startSample,{gain:1/numChannels});
  }

  return targetSamples;
}

function normalizeRecognitionPeak(targetSamples) {
  if (!targetSamples?.length) return targetSamples;
  // 音訊波形峰值正規化（強化低音量對白特徵並抑制噪訊）
  let maxPeak = 0;
  for (let i = 0; i < targetSamples.length; i++) {
    const abs = Math.abs(targetSamples[i]);
    if (abs > maxPeak) maxPeak = abs;
  }
  if (maxPeak > 0.005 && maxPeak < 0.95) {
    const gain = Math.min(8.0, 0.95 / maxPeak);
    for (let i = 0; i < targetSamples.length; i++) {
      targetSamples[i] *= gain;
    }
  }
  return targetSamples;
}

/**
 * 人聲頻帶增強 DSP 濾波器（線性二階高通/低通濾波，純數值運算，零外部相依）：
 * 1. 75Hz 二階高通濾波（Butterworth High-Pass）：濾除超低頻風切聲、空調轟鳴與麥克風爆音。
 * 2. 8000Hz 二階低通濾波（Butterworth Low-Pass）：濾除超高頻電氣雜訊。
 * 採純線性直接 II 型轉置架構，不包含任何非線性噪音門，杜絕交越失真，100% 保持微弱子音訊號完整。
 */
export function applyVocalEnhancementFilter(samples, sampleRate = 16000) {
  if (!samples || samples.length === 0) return samples;
  const output = new Float32Array(samples.length);

  // 1. High-Pass Filter: f0 = 75Hz, Q = 0.7071
  const hp_f0 = 75;
  const hp_w0 = (2 * Math.PI * hp_f0) / sampleRate;
  const hp_cos = Math.cos(hp_w0);
  const hp_alpha = Math.sin(hp_w0) / (2 * 0.7071);
  const hp_b0 = (1 + hp_cos) / 2;
  const hp_b1 = -(1 + hp_cos);
  const hp_b2 = (1 + hp_cos) / 2;
  const hp_a0 = 1 + hp_alpha;
  const hp_a1 = -2 * hp_cos;
  const hp_a2 = 1 - hp_alpha;

  // 2. Low-Pass Filter: f0 = 8000Hz, Q = 0.7071
  const lp_f0 = 8000;
  const lp_w0 = (2 * Math.PI * lp_f0) / sampleRate;
  const lp_cos = Math.cos(lp_w0);
  const lp_alpha = Math.sin(lp_w0) / (2 * 0.7071);
  const lp_b0 = (1 - lp_cos) / 2;
  const lp_b1 = 1 - lp_cos;
  const lp_b2 = (1 - lp_cos) / 2;
  const lp_a0 = 1 + lp_alpha;
  const lp_a1 = -2 * lp_cos;
  const lp_a2 = 1 - lp_alpha;

  let hp_d1 = 0, hp_d2 = 0;
  let lp_d1 = 0, lp_d2 = 0;

  const hp_b0_n = hp_b0 / hp_a0, hp_b1_n = hp_b1 / hp_a0, hp_b2_n = hp_b2 / hp_a0;
  const hp_a1_n = hp_a1 / hp_a0, hp_a2_n = hp_a2 / hp_a0;

  const lp_b0_n = lp_b0 / lp_a0, lp_b1_n = lp_b1 / lp_a0, lp_b2_n = lp_b2 / lp_a0;
  const lp_a1_n = lp_a1 / lp_a0, lp_a2_n = lp_a2 / lp_a0;

  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];

    // High-pass filter
    const hp_y = hp_b0_n * x + hp_d1;
    hp_d1 = hp_b1_n * x - hp_a1_n * hp_y + hp_d2;
    hp_d2 = hp_b2_n * x - hp_a2_n * hp_y;

    // Low-pass filter
    const lp_y = lp_b0_n * hp_y + lp_d1;
    lp_d1 = lp_b1_n * hp_y - lp_a1_n * lp_y + lp_d2;
    lp_d2 = lp_b2_n * hp_y - lp_a2_n * lp_y;

    output[i] = Math.max(-1, Math.min(1, lp_y));
  }

  return output;
}

export function extractClipFloat32Mono16k(audioBuffer, startSec = 0, endSec = null, { vocalFilter = false } = {}) {
  let samples = downmixAndResampleMono16k(audioBuffer, startSec, endSec);
  if (!samples?.length) return samples;
  if (vocalFilter) {
    samples = applyVocalEnhancementFilter(samples);
  }
  return normalizeRecognitionPeak(samples);
}

/**
 * 將 ffmpeg 逐聲道快取或多個 runtime buffer 合成 ASR 可讀的 16kHz Mono AudioBuffer-like。
 * 只做來源聲道混音，峰值正規化仍由後續區間擷取統一執行。
 */
export function combineRecognitionAudioBuffers(audioBuffers) {
  const buffers = (Array.isArray(audioBuffers) ? audioBuffers : []).filter(buffer =>
    buffer && Number(buffer.sampleRate) > 0 && Number(buffer.numberOfChannels) > 0 && Number(buffer.length) > 0 &&
    typeof buffer.getChannelData === 'function'
  );
  if (!buffers.length) return null;
  if (buffers.length === 1) return buffers[0];

  const sources = buffers.map(buffer => downmixAndResampleMono16k(buffer)).filter(samples => samples?.length);
  if (!sources.length) return null;
  const length = Math.max(...sources.map(samples => samples.length));
  const mixed = new Float32Array(length);
  for (const samples of sources) {
    for (let i = 0; i < samples.length; i++) mixed[i] += samples[i] / sources.length;
  }
  return {
    sampleRate: 16000,
    numberOfChannels: 1,
    length,
    duration: length / 16000,
    getChannelData: channel => {
      if (channel !== 0) throw new RangeError('ASR 混音只有一個聲道');
      return mixed;
    }
  };
}

/**
 * 將 AudioBuffer 指定區間轉換並重新採樣為 16kHz 16-bit Mono WAV 格式 Blob
 * （供雲端 API 與外部伺服器使用）
 */
export function encodeWav16kMono(audioBuffer, startSec = 0, endSec = null, { vocalFilter = false } = {}) {
  const pcmFloat = extractClipFloat32Mono16k(audioBuffer, startSec, endSec, { vocalFilter });
  if (!pcmFloat || pcmFloat.length === 0) return null;

  const targetSampleRate = 16000;
  const targetLength = pcmFloat.length;
  const pcm16 = new Int16Array(targetLength);
  for (let i = 0; i < targetLength; i++) {
    const clamped = Math.max(-1, Math.min(1, pcmFloat[i]));
    pcm16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }

  const byteLength = pcm16.length * 2;
  const buffer = new ArrayBuffer(44 + byteLength);
  const view = new DataView(buffer);

  function writeStr(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + byteLength, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, targetSampleRate, true);
  view.setUint32(28, targetSampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, byteLength, true);

  for (let i = 0; i < pcm16.length; i++) {
    view.setInt16(44 + i * 2, pcm16[i], true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

async function compressWhisperUploadForDesktop(wavBlob, signal) {
  const bridge = typeof window !== 'undefined' ? window.subtool : null;
  const compressor = bridge?.compressSpeechAudio;
  if (typeof compressor !== 'function') return wavBlob;

  try {
    throwIfRecognitionAborted(signal);
    const wavBytes = new Uint8Array(await wavBlob.arrayBuffer());
    throwIfRecognitionAborted(signal);
    const requestId = `speech-${Date.now()}-${++whisperCompressionRequestSequence}`;
    const compressionPromise = Promise.resolve().then(() => {
      throwIfRecognitionAborted(signal);
      return compressor(wavBytes, requestId);
    });
    let abortListener = null;
    const abortPromise = signal ? new Promise((resolve, reject) => {
      abortListener = () => {
        try {
          Promise.resolve(bridge?.cancelSpeechAudioCompression?.(requestId)).catch(() => {});
        } catch (error) {}
        try {
          throwIfRecognitionAborted(signal);
        } catch (error) {
          reject(error);
        }
      };
      signal.addEventListener('abort', abortListener, { once: true });
      if (signal.aborted) abortListener();
    }) : null;
    let result;
    try {
      result = abortPromise
        ? await Promise.race([compressionPromise, abortPromise])
        : await compressionPromise;
    } finally {
      if (abortListener) signal.removeEventListener('abort', abortListener);
    }
    throwIfRecognitionAborted(signal);
    if (!result?.b64 || result.type !== 'audio/mpeg') return wavBlob;
    const mp3Bytes = b64ToBytes(result.b64);
    if (!mp3Bytes.length || mp3Bytes.length >= wavBlob.size) return wavBlob;
    return new Blob([mp3Bytes], { type: 'audio/mpeg' });
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error;
    console.warn('辨識用 MP3 暫存壓縮失敗，改用安全 WAV 分段：', error);
    return wavBlob;
  }
}

/**
 * 使用 Transformers.js 本機模型推論音訊
 */
export async function transcribeWithBuiltinModel({
  audioFloat32,
  taskMode,
  modelId = 'onnx-community/whisper-base',
  language = taskMode === 'transcribe' || taskMode === 'align' ? 'auto' : 'zh',
  prompt = '',
  temperature = 0,
  onProgress = null,
  signal = null
}) {
  if (!audioFloat32 || audioFloat32.length === 0) {
    throw new Error('音訊長度為 0，無法進行辨識');
  }
  throwIfRecognitionAborted(signal);
  const automatic = isEditorSpeechTask(taskMode);
  if (taskMode === 'transcribe') modelId = 'onnx-community/whisper-large-v3';
  if (taskMode === 'align') modelId = 'onnx-community/whisper-large-v3-turbo';
  const modelMeta = BUILTIN_MODELS[modelId] || BUILTIN_MODELS['onnx-community/whisper-base'];
  return transcribeBuiltinAudioInWorker({
    audioFloat32,
    taskMode,
    modelId: modelMeta.id,
    modelName: modelMeta.name,
    webgpuDtype: modelMeta.webgpuDtype,
    wasmDtype: modelMeta.wasmDtype,
    returnTimestamps: modelMeta.returnTimestamps || 'word',
    language,
    prompt: automatic ? '' : prompt,
    temperature: automatic ? 0 : temperature,
    onProgress,
    signal
  });
}

// Models.list only declares generation methods, not input modalities. These exact
// models have documented audio input + structured text output (checked 2026-10-21):
// https://ai.google.dev/gemini-api/docs/models and /docs/audio.
// Keep the existing 2.5 Flash preference; discovery must also list the candidate.
const GEMINI_AUDIO_MODELS = Object.freeze([
  'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro', 'gemini-3.8-flash'
]);

async function geminiResponseError(response, signal) {
  const json = await response.json().catch(() => ({}));
  throwIfRecognitionAborted(signal);
  return new Error(json?.error?.message || `Google API 回傳錯誤 HTTP ${response.status}`);
}

async function* geminiModelCandidates(apiKey, signal, preferredModels = GEMINI_AUDIO_MODELS) {
  let admitted = false;
  for (const version of ['v1', 'v1beta']) {
    const models = new Set();
    const seenTokens = new Set();
    let pageToken = '';
    do {
      throwIfRecognitionAborted(signal);
      const query = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : '';
      const response = await fetchSpeech(`https://generativelanguage.googleapis.com/${version}/models${query}`, {
        headers: { 'x-goog-api-key': apiKey }, signal
      });
      throwIfRecognitionAborted(signal);
      if (!response.ok) {
        const error = await geminiResponseError(response, signal);
        if (response.status === 404 && !pageToken) break;
        throw error;
      }
      const json = await response.json();
      throwIfRecognitionAborted(signal);
      if (json.models != null && !Array.isArray(json.models)) throw new Error('Google Gemini 模型列表格式無效');
      for (const model of json.models || []) {
        if (!model || typeof model.name !== 'string' || !Array.isArray(model.supportedGenerationMethods) ||
          !model.supportedGenerationMethods.includes('generateContent')) continue;
        models.add(model.name.replace(/^models\//, ''));
      }
      pageToken = typeof json.nextPageToken === 'string' ? json.nextPageToken : '';
      if (pageToken && (seenTokens.has(pageToken) || seenTokens.size >= 100)) throw new Error('Google Gemini 模型列表分頁無效');
      if (pageToken) seenTokens.add(pageToken);
    } while (pageToken);
    for (const model of preferredModels) {
      if (!models.has(model)) continue;
      admitted = true;
      yield { version, model };
    }
  }
  if (!admitted) throw new Error('Google Gemini 沒有可用且支援音訊辨識的模型');
}

/** 探索金鑰可用的音訊模型；保留既有 { version, model } 公開介面。 */
export async function resolveGeminiModel(apiKey, signal = null) {
  for await (const candidate of geminiModelCandidates(apiKey, signal)) return candidate;
}

const GEMINI_TRANSCRIBE_LANGUAGES = { en: 'en-US', zh: 'cmn-Hans-CN', ja: 'ja-JP', ko: 'ko-KR' };

// Interactions returns word offsets in protobuf Duration format. Build each
// subtitle from the corresponding range of the formatted transcript so that
// punctuation and inter-word spacing survive speaker and sentence boundaries.
function geminiWordSegments(content, language) {
  const text = String(content.text || '').trim();
  if (!text) return [];
  const seconds = value => /^\d+(?:\.\d+)?s$/.test(value) ? Number(value.slice(0,-1)) : NaN;
  const words = (content.annotations || []).filter(item => item.type === 'word_info').map(item => ({
    text: String(item.text || '').trim(), start: seconds(item.start_offset), end: seconds(item.end_offset),
    speaker: item.speaker
  }));
  if (!words.length || words.some(word => !word.text || !(word.end > word.start) || !Number.isFinite(word.end))) {
    throw new Error('Google 語音辨識回傳的逐字時間不完整，無法建立字幕。');
  }
  const ranges = locateTimedWordsInText(text, words);
  if (ranges) {
    // Some responses include punctuation only in the formatted text.
    for (let i = 0; i < words.length; i++) {
      const suffix = text.slice(ranges[i].end, ranges[i+1]?.start ?? text.length).trimEnd();
      if (suffix && /^[\p{P}\p{S}\s]+$/u.test(suffix)) words[i].text += suffix;
    }
  }
  const segments = [];
  let first = 0;
  for (let i = 1; i <= words.length; i++) {
    if (i < words.length && words[i].speaker === words[first].speaker) continue;
    const group = words.slice(first, i);
    const phrase = first === 0 && i === words.length ? text : ranges
      ? text.slice(first === 0 ? 0 : ranges[first].start, ranges[i]?.start ?? text.length).trim()
      : joinTimedWordTexts(group, language);
    segments.push(...splitAzurePhraseForSubtitles({
      start: group[0].start, end: group.at(-1).end, text: phrase,
      words: group, locale: language === 'auto' ? '' : language,
      ...(group[0].speaker ? { speaker: group[0].speaker } : {})
    }));
    first = i;
  }
  return segments;
}

async function geminiSpeechToText(base64Audio, key, language, signal) {
  const locale = GEMINI_TRANSCRIBE_LANGUAGES[language];
  const response = await fetchSpeech('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      model: 'models/gemini-3.5-transcribe', store: false,
      input: [{type:'audio', mime_type:'audio/wav', data:base64Audio}],
      generation_config: { transcription_config: {
        ...(locale ? {language_codes:[locale]} : {}),
        mode: {type:'verbatim', timestamp_granularities:['word'], diarization_mode:'speaker'}
      } }
    })
  });
  throwIfRecognitionAborted(signal);
  if (response.status === 404) {
    throw new Error('Google 暫無可用的專用語音辨識模型，請稍後重試或改選其他辨識引擎。');
  }
  if (!response.ok) throw await geminiResponseError(response, signal);
  const data = await response.json();
  throwIfRecognitionAborted(signal);
  if (data.status !== 'completed' || !Array.isArray(data.steps)) throw new Error('Google 語音辨識未完成。');
  const segments = data.steps.filter(step => step.type === 'model_output')
    .flatMap(step => step.content || []).filter(item => item.type === 'text')
    .flatMap(item => geminiWordSegments(item, language));
  return {segments};
}

/**
 * 呼叫 Google Gemini API 進行語音理解與時間戳標註
 */
export async function callGeminiAudioTranscription({
  audioBlob,
  apiKey,
  taskMode,
  language = isEditorSpeechTask(taskMode) ? 'auto' : 'zh',
  prompt = '',
  signal = null
}) {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('請輸入 Google Gemini API Key');
  }

  throwIfRecognitionAborted(signal);
  const base64Audio = await blobToBase64(audioBlob);
  throwIfRecognitionAborted(signal);
  const timedTranscript = isEditorSpeechTask(taskMode);
  if (timedTranscript) {
    return geminiSpeechToText(base64Audio, apiKey.trim(), language, signal);
  }
  const langText = {zh:'繁體中文 (Traditional Chinese)', en:'英文 (English)', ja:'日文', ko:'韓文'}[language] || '原文語言';

  const systemInstruction = `你是一位專業的頂級影視對白字幕聽打專家。請聆聽所附音訊，依據人聲起迄時間精準生成字幕片段。
必須遵循以下規則：
1. 辨識語言為「${langText}」。請按實際發音記錄原話，中文使用繁體字，保留原本用詞。
2. 包含標點符號，句子語意完整，單句長度適中（建議 15~25 字以內）。
3. 嚴格輸出 JSON 格式陣列，不要加入額外的 Markdown 標籤或解釋，格式如下：
[
  { "start": 0.5, "end": 2.8, "text": "第一句對話內容。" },
  { "start": 3.1, "end": 5.4, "text": "第二句對話內容。" }
]
4. start 與 end 均為秒數（可包含小數點，例如 1.25）。
${!timedTranscript && prompt ? `\n提示詞補充導引：${prompt}` : ''}`;

  const payload = {
    contents: [
      {
        parts: [
          { text: systemInstruction },
          {
            inlineData: {
              mimeType: 'audio/wav',
              data: base64Audio
            }
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json'
    }
  };

  let data = null;
  let lastError = null;
  for await (const { version, model } of geminiModelCandidates(apiKey.trim(), signal)) {
    throwIfRecognitionAborted(signal);
    const response = await fetchSpeech(`https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey.trim() },
      body: JSON.stringify(payload), signal
    });
    throwIfRecognitionAborted(signal);
    if (response.ok) {
      data = await response.json();
      throwIfRecognitionAborted(signal);
      break;
    }
    lastError = await geminiResponseError(response, signal);
    const unsupportedAudio = response.status === 400 && /audio (?:input|inputs|mime type).*not supported|(?:does not|doesn't) support audio/i.test(lastError.message);
    if (response.status !== 404 && !unsupportedAudio) throw lastError;
  }

  if (!data) {
    throw lastError || new Error('Google Gemini 辨識失敗');
  }

  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!rawText) {
    throw new Error('Google Gemini 未能辨識出任何對話內容。');
  }

  let segments = [];
  try {
    const parsed = JSON.parse(rawText.trim());
    if (Array.isArray(parsed)) {
      segments = parsed;
    } else if (parsed && Array.isArray(parsed.segments)) {
      segments = parsed.segments;
    } else if (parsed && Array.isArray(parsed.subtitles)) {
      segments = parsed.subtitles;
    }
  } catch (parseErr) {
    const jsonMatch = rawText.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (jsonMatch) {
      try {
        segments = JSON.parse(jsonMatch[0]);
      } catch (_) {}
    }
  }

  const validSegments = [];
  let invalidTimes = false;
  for (const s of segments) {
    if (s && s.text && typeof s.text === 'string' && s.text.trim()) {
      const numericTime = value => typeof value === 'number' || (typeof value === 'string' && value.trim() !== '');
      const start = numericTime(s.start) ? Number(s.start) : NaN;
      const end = numericTime(s.end) ? Number(s.end) : NaN;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
        invalidTimes = true;
        continue;
      }
      validSegments.push({
        start,
        end,
        text: s.text.trim()
      });
    }
  }
  if (!validSegments.length && invalidTimes) throw new Error('Google Gemini 回傳無效字幕時間，未建立字幕軌');

  return { segments: validSegments };
}

export const DEFAULT_AZURE_SPEECH_REGION = 'japaneast';

// Only an official public Speech region may become part of the credential-bearing host.
// https://learn.microsoft.com/azure/ai-services/speech-service/regions#regions
const AZURE_SPEECH_REGIONS = new Set([
  'australiaeast', 'brazilsouth', 'canadacentral', 'canadaeast', 'centralindia', 'centralus',
  'eastasia', 'eastus', 'eastus2', 'francecentral', 'germanywestcentral', 'italynorth',
  'japaneast', 'japanwest', 'koreacentral', 'northcentralus', 'northeurope', 'norwayeast',
  'qatarcentral', 'southafricanorth', 'southcentralus', 'southeastasia', 'swedencentral',
  'switzerlandnorth', 'switzerlandwest', 'uaenorth', 'uksouth', 'ukwest', 'westcentralus',
  'westeurope', 'westus', 'westus2', 'westus3'
]);

export function isAzureSpeechRegion(value) {
  return typeof value === 'string' && AZURE_SPEECH_REGIONS.has(value.trim().toLowerCase());
}

export function parseAzureSpeechCredential(value, region = DEFAULT_AZURE_SPEECH_REGION) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) throw new Error('請輸入 Azure Speech API Key');
  const separator = input.indexOf(':');
  const regionValue = separator < 0 ? region : input.slice(0, separator);
  if (!isAzureSpeechRegion(regionValue)) {
    throw new Error('請使用 Azure Speech 資源的區域代碼，金鑰欄可填「區域:金鑰」，例如 eastus:金鑰。');
  }
  const apiKey = separator < 0 ? input : input.slice(separator + 1).trim();
  if (!/^[!-~]+$/.test(apiKey) || apiKey.includes(':')) {
    throw new Error('請輸入完整的 Azure Speech API Key，或在金鑰前加上「區域:」。');
  }
  return { apiKey, region: regionValue.trim().toLowerCase() };
}

const AZURE_SUBTITLE_MAX_DURATION_SECONDS = 6;
const AZURE_SUBTITLE_MAX_CJK_CHARS = 24;
const AZURE_SUBTITLE_MAX_LATIN_WORDS = 14;
const AZURE_SUBTITLE_MAX_LATIN_CHARS = 72;
const AZURE_SUBTITLE_MERGE_GAP_SECONDS = 0.45;
const AZURE_SUBTITLE_BREAK_GAP_SECONDS = 0.75;
const AZURE_SPEECH_MAX_SPEAKERS = 10;

function endsAzureSentence(text) {
  const normalized = String(text || '').trim().replace(/["'”’」』）】》〉]+$/u, '');
  if (/[。！？!?…]$/u.test(normalized) || /\.{2,}$/u.test(normalized)) return true;
  if (!/\.$/u.test(normalized)) return false;
  if (/^(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr)\.$/iu.test(normalized)) return false;
  if (/^(?:[A-Za-z]\.){2,}$/u.test(normalized) || /^[A-Z]\.$/u.test(normalized)) return false;
  return true;
}

function azureUsesCompactSpacing(locale, text = '') {
  const normalizedLocale = String(locale || '').trim();
  if (normalizedLocale && !/^(?:auto|und)$/i.test(normalizedLocale)) return /^(?:zh|zho|cmn|ja|jpn)(?:-|$)/i.test(normalizedLocale);
  return !/\p{Script=Hangul}/u.test(text) && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
}

function isAzurePunctuationOnly(text) {
  return /^[\p{Punctuation}\p{Symbol}]+$/u.test(String(text || '').trim());
}

function startsAzureClosingPunctuation(text) {
  return /^[,.;:!?，。！？、；：…”’」』）】》〉]/u.test(String(text || '').trim());
}

function startsAzureOpeningQuote(text) {
  return /^[“‘「『（【《〈]/u.test(String(text || '').trim()) ||
    /^["'][^"']/u.test(String(text || '').trim());
}

function isAzureOpeningQuoteOnly(text) {
  return /^["'“‘「『（【《〈]$/u.test(String(text || '').trim());
}

function isAzureTrailingSentenceCloser(text) {
  return /^["'”’」』）】》〉]+$/u.test(String(text || '').trim());
}

function azureSubtitleFits(text, duration, locale) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > AZURE_SUBTITLE_MAX_DURATION_SECONDS) return false;
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  // Korean uses spaces but keeps the same on-screen character budget as Japanese and Chinese.
  if (azureUsesCompactSpacing(locale, normalized) || /^(?:ko|kor)(?:-|$)/i.test(locale)
      || (!locale && /\p{Script=Hangul}/u.test(normalized))) {
    return Array.from(normalized.replace(/\s/gu, '')).length <= AZURE_SUBTITLE_MAX_CJK_CHARS;
  }
  const wordCount = normalized.split(/\s+/u).filter(Boolean).length;
  return wordCount <= AZURE_SUBTITLE_MAX_LATIN_WORDS &&
    Array.from(normalized).length <= AZURE_SUBTITLE_MAX_LATIN_CHARS;
}

function locateTimedWordsInText(text, words) {
  const source = String(text || '');
  const sourceLower = source.toLocaleLowerCase();
  let cursor = 0;
  const ranges = [];
  for (const word of words) {
    const token = String(word?.text || '');
    const lower = token.toLocaleLowerCase();
    const index = sourceLower.length === source.length && lower.length === token.length
      ? sourceLower.indexOf(lower, cursor)
      : source.indexOf(token, cursor);
    if (index < 0) return null;
    ranges.push({ start: index, end: index + token.length });
    cursor = index + token.length;
  }
  return ranges;
}

function joinTimedWordTexts(words, locale) {
  let result = '';
  let openingQuotePending = false;
  const compact = azureUsesCompactSpacing(locale, words.map(word => word.text).join(''));
  for (const word of words) {
    const token = String(word?.text || '').trim();
    if (!token) continue;
    if (!result) {
      result = token;
      openingQuotePending = isAzureOpeningQuoteOnly(token);
      continue;
    }
    if (startsAzureClosingPunctuation(token) || /^(?:n['’]t|'(?:s|t|m|ve|ll|re|d))$/iu.test(token)) {
      result += token;
      continue;
    }
    if (token === '"' || token === "'") {
      const quoteCount = Array.from(result).filter(character => character === token).length;
      if (quoteCount % 2 === 0) {
        result += compact ? token : ` ${token}`;
        openingQuotePending = true;
      } else {
        result += token;
      }
      continue;
    }
    if (openingQuotePending) {
      result += token;
      openingQuotePending = false;
      continue;
    }
    if (startsAzureOpeningQuote(token)) {
      result += compact ? token : ` ${token}`;
      continue;
    }
    if (!compact || /\p{Script=Hangul}$/u.test(result) || /^\p{Script=Hangul}/u.test(token)) {
      result += ` ${token}`;
      continue;
    }
    const previousIsLatin = /[A-Za-z0-9]$/u.test(result);
    const nextIsLatin = /^[A-Za-z0-9]/u.test(token);
    const previousIsCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u.test(result);
    const nextIsCjk = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(token);
    result += (previousIsLatin && nextIsLatin) || (previousIsLatin && nextIsCjk) || (previousIsCjk && nextIsLatin)
      ? ` ${token}`
      : token;
  }
  return result;
}

function azureWordSliceText(segment, wordRanges, firstIndex, lastIndex) {
  if (wordRanges) {
    const sliced = segment.text.slice(wordRanges[firstIndex].start, wordRanges[lastIndex].end).trim();
    if (sliced) return sliced;
  }
  return joinTimedWordTexts(segment.words.slice(firstIndex, lastIndex + 1), segment.locale);
}

// Whisper word timings can omit casing and punctuation present in the segment.
// Keep the provider's display text for each surviving run of adjacent words.
function retainedTimedWordText(segment, keptWords) {
  const { words, text, locale } = segment;
  const ranges = locateTimedWordsInText(text, words);
  if (!ranges || ranges.some((range, i) => i > 0 && /[\p{L}\p{M}\p{N}]/u.test(text.slice(ranges[i - 1].end, range.start)))) {
    return joinTimedWordTexts([...keptWords], locale);
  }
  const runs = [];
  for (let first = 0; first < words.length; first++) {
    if (!keptWords.has(words[first])) continue;
    let last = first;
    while (last + 1 < words.length && keptWords.has(words[last + 1])) last++;
    const start = ranges[first].start, end = ranges[last].end;
    const before = text.slice(ranges[first - 1]?.end ?? 0, start);
    const after = text.slice(end, ranges[last + 1]?.start ?? text.length);
    const opening = before.match(/[\p{Ps}\p{Pi}"']+$/u)?.[0] || '';
    const closing = after.match(/^[\p{Pe}\p{Pf},.!?:;，。！？、；：…"'’]+/u)?.[0] || '';
    runs.push({ text: opening + text.slice(start, end) + closing });
    first = last;
  }
  return joinTimedWordTexts(runs, locale);
}

function createAzureWordSegment(segment, wordRanges, firstIndex, lastIndex) {
  const words = segment.words.slice(firstIndex, lastIndex + 1);
  return {
    ...segment,
    start: words[0].start,
    end: words[words.length - 1].end,
    text: azureWordSliceText(segment, wordRanges, firstIndex, lastIndex),
    words
  };
}

function splitAzurePhraseForSubtitles(segment) {
  if (!Array.isArray(segment?.words) || segment.words.length < 2) return [segment];
  const wordRanges = locateTimedWordsInText(segment.text, segment.words);
  const chunks = [];
  let firstIndex = 0;

  for (let index = 0; index < segment.words.length; index++) {
    const punctuationOnly = isAzurePunctuationOnly(segment.words[index].text);
    if (index > firstIndex) {
      const wordGap = segment.words[index].start - segment.words[index - 1].end;
      if (!punctuationOnly && Number.isFinite(wordGap) && wordGap >= AZURE_SUBTITLE_BREAK_GAP_SECONDS) {
        chunks.push(createAzureWordSegment(segment, wordRanges, firstIndex, index - 1));
        firstIndex = index;
      }
    }
    const candidateText = azureWordSliceText(segment, wordRanges, firstIndex, index);
    const candidateDuration = segment.words[index].end - segment.words[firstIndex].start;
    if (!punctuationOnly && !azureSubtitleFits(candidateText, candidateDuration, segment.locale) && index > firstIndex) {
      chunks.push(createAzureWordSegment(segment, wordRanges, firstIndex, index - 1));
      firstIndex = index;
    }
    const candidateEndsSentence = endsAzureSentence(azureWordSliceText(segment, wordRanges, firstIndex, index));
    const nextIsSentenceCloser = index + 1 < segment.words.length &&
      isAzureTrailingSentenceCloser(segment.words[index + 1].text);
    if (candidateEndsSentence && !nextIsSentenceCloser) {
      chunks.push(createAzureWordSegment(segment, wordRanges, firstIndex, index));
      firstIndex = index + 1;
    }
  }

  if (firstIndex < segment.words.length) {
    chunks.push(createAzureWordSegment(segment, wordRanges, firstIndex, segment.words.length - 1));
  }
  return chunks.length > 1 ? chunks : [segment];
}

function joinAzureSegmentTexts(previous, next) {
  const left = String(previous?.text || '').trim();
  const right = String(next?.text || '').trim();
  if (!left) return right;
  if (!right) return left;
  if (startsAzureClosingPunctuation(right) || (/^["']$/u.test(right) && endsAzureSentence(left))) {
    return `${left}${right}`;
  }
  const locale = previous?.locale || next?.locale || '';
  if (!azureUsesCompactSpacing(locale, `${left}${right}`)) return `${left} ${right}`;
  const leftLatin = /[A-Za-z0-9]$/u.test(left);
  const rightLatin = /^[A-Za-z0-9]/u.test(right);
  const leftCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u.test(left);
  const rightCjk = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(right);
  return (leftLatin && rightLatin) || (leftLatin && rightCjk) || (leftCjk && rightLatin)
    ? `${left} ${right}`
    : `${left}${right}`;
}

function azureSegmentsCanMerge(previous, next, combinedText) {
  if (!previous?.words?.length || !next?.words?.length || endsAzureSentence(previous.text)) return false;
  if ((previous.channel ?? null) !== (next.channel ?? null)) return false;
  if (!Number.isInteger(previous.speaker) || !Number.isInteger(next.speaker) || previous.speaker !== next.speaker) return false;
  if (previous.locale && next.locale && previous.locale !== next.locale) return false;
  const gap = next.start - previous.end;
  if (!Number.isFinite(gap) || gap < -0.05 || gap > AZURE_SUBTITLE_MERGE_GAP_SECONDS) return false;
  return azureSubtitleFits(combinedText, next.end - previous.start, previous.locale || next.locale);
}

/**
 * 將 Azure 的 phrase／word 結果整理成字幕友善的句子：
 * - phrase 內依句末標點切開，時間取該句首末 word。
 * - 短停頓內、尚未出現句末標點的 phrase 碎片合併。
 * - 缺少 word 時不猜測切點，保留 Azure 原始 phrase。
 */
export function refineAzureSubtitleSegments(segments) {
  const splitSegments = (Array.isArray(segments) ? segments : [])
    .flatMap(splitAzurePhraseForSubtitles)
    .filter(segment => segment?.text && Number(segment.end) > Number(segment.start));
  const refined = [];
  for (const segment of splitSegments) {
    const previous = refined[refined.length - 1];
    const combinedText = previous ? joinAzureSegmentTexts(previous, segment) : '';
    if (!previous || !azureSegmentsCanMerge(previous, segment, combinedText)) {
      refined.push(segment);
      continue;
    }
    const merged = {
      ...previous,
      end: segment.end,
      text: combinedText,
      words: [...previous.words, ...segment.words],
      ...(previous.locale || segment.locale ? { locale: previous.locale || segment.locale } : {})
    };
    if (Number.isFinite(previous.confidence) && Number.isFinite(segment.confidence)) {
      merged.confidence = Math.min(previous.confidence, segment.confidence);
    } else {
      delete merged.confidence;
    }
    refined[refined.length - 1] = merged;
  }
  return refined;
}

/**
 * 將 Azure Fast Transcription 的逐句／逐字毫秒時間轉成共用的秒數契約。
 * 這裡只保留來源音檔的相對時間；時間軸 offset 與逐格化由 UI 協調器統一處理。
 */
export function parseAzureTranscriptionResponse(data) {
  const segments = [];
  const responseDurationMs = Number(data?.durationMilliseconds);
  const audioEnd = Number.isFinite(responseDurationMs) && responseDurationMs > 0
    ? responseDurationMs / 1000
    : Infinity;
  for (const phrase of Array.isArray(data?.phrases) ? data.phrases : []) {
    const text = typeof phrase?.text === 'string' ? phrase.text.trim() : '';
    const offsetMs = Number(phrase?.offsetMilliseconds);
    const durationMs = Number(phrase?.durationMilliseconds);
    if (!text || !Number.isFinite(offsetMs) || !Number.isFinite(durationMs) || offsetMs < 0 || durationMs <= 0) continue;
    const start = offsetMs / 1000;
    const end = Math.min(audioEnd, (offsetMs + durationMs) / 1000);
    if (start >= audioEnd || end <= start) continue;

    const words = [];
    for (const word of Array.isArray(phrase.words) ? phrase.words : []) {
      const wordText = typeof word?.text === 'string' ? word.text.trim() : '';
      const wordOffsetMs = Number(word?.offsetMilliseconds);
      const wordDurationMs = Number(word?.durationMilliseconds);
      if (!wordText || !Number.isFinite(wordOffsetMs) || !Number.isFinite(wordDurationMs) || wordOffsetMs < 0 || wordDurationMs <= 0) continue;
      const wordStart = wordOffsetMs / 1000;
      const wordEnd = Math.min(audioEnd, (wordOffsetMs + wordDurationMs) / 1000);
      if (wordStart >= audioEnd || wordEnd <= wordStart) continue;
      words.push({
        text: wordText,
        start: wordStart,
        end: wordEnd
      });
    }

    segments.push({
      start,
      end,
      text,
      words,
      ...(typeof phrase.locale === 'string' && phrase.locale ? { locale: phrase.locale } : {}),
      ...(phrase.channel != null && Number.isInteger(Number(phrase.channel))
        ? { channel: Number(phrase.channel) }
        : {}),
      ...(phrase.speaker != null && Number.isInteger(Number(phrase.speaker))
        ? { speaker: Number(phrase.speaker) }
        : {}),
      ...(phrase.confidence != null && Number.isFinite(Number(phrase.confidence))
        ? { confidence: Number(phrase.confidence) }
        : {})
    });
  }

  const refinedSegments = refineAzureSubtitleSegments(segments);
  const combinedText = (Array.isArray(data?.combinedPhrases) ? data.combinedPhrases : [])
    .map(item => typeof item?.text === 'string' ? item.text.trim() : '')
    .filter(Boolean)
    .join('\n');
  return {
    text: combinedText || refinedSegments.map(segment => segment.text).join(' '),
    segments: refinedSegments
  };
}

const AZURE_SPEECH_LOCALES = Object.freeze({
  zh: 'zh-TW',
  en: 'en-US',
  ja: 'ja-JP',
  ko: 'ko-KR'
});

/**
 * 呼叫 Azure Speech 2025-10-15 GA Fast Transcription。
 * Region 只允許 Azure region identifier，端點由程式建立，避免 API Key 被送往任意主機。
 */
export async function callAzureSpeechTranscription({
  audioBlob,
  apiKey,
  region = DEFAULT_AZURE_SPEECH_REGION,
  language = 'zh',
  phrases = [],
  profanityFilterMode = 'Raw',
  signal = null
}) {
  const { apiKey: key, region: normalizedRegion } = parseAzureSpeechCredential(apiKey, region);
  if (!(audioBlob instanceof Blob) || audioBlob.size === 0) {
    throw new Error('未提供可供 Azure Speech 辨識的音訊');
  }

  const normalizedProfanity = (profanityFilterMode === 'Raw' || profanityFilterMode === 'None')
    ? 'None'
    : (profanityFilterMode === 'Removed' ? 'Removed' : 'Masked');

  const definition = {
    diarization: { enabled: true, maxSpeakers: AZURE_SPEECH_MAX_SPEAKERS },
    profanityFilterMode: normalizedProfanity
  };
  if (language && language !== 'auto') {
    definition.locales = [AZURE_SPEECH_LOCALES[language] || language];
  }
  const cleanPhrases = (Array.isArray(phrases) ? phrases : [])
    .map(phrase => typeof phrase === 'string' ? phrase.trim() : '')
    .filter((phrase, index, list) => phrase && list.indexOf(phrase) === index)
    .slice(0, 500);
  if (cleanPhrases.length) definition.phraseList = { phrases: cleanPhrases };

  const formData = new FormData();
  formData.append('audio', audioBlob, 'audio.wav');
  formData.append('definition', JSON.stringify(definition));

  const endpoint = `https://${normalizedRegion}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15`;
  const response = await fetchSpeech(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Ocp-Apim-Subscription-Key': key },
    body: formData,
    signal
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Azure Speech 拒絕存取（HTTP ${response.status}）。請在 Azure 入口網站確認資源的金鑰與區域，並在金鑰欄輸入「區域:金鑰」，例如 eastus:金鑰。`);
    }
    const body = await response.json().catch(() => null);
    const detail = body?.error?.message || body?.error?.details?.[0]?.message || body?.message || response.statusText || '';
    const safeDetail = detail ? String(detail).split(key).join('[已隱藏]') : (body ? JSON.stringify(body).split(key).join('[已隱藏]') : '');
    throw new Error(`Azure Speech 辨識失敗 (HTTP ${response.status})${safeDetail ? `：${safeDetail}` : ''}`);
  }

  return parseAzureTranscriptionResponse(await response.json());
}

const ELEVENLABS_MAX_CJK_CHARS = 18;
const ELEVENLABS_HARD_MAX_CJK_CHARS = 22;
const ELEVENLABS_MAX_DURATION_SECONDS = 4.8;
const ELEVENLABS_HARD_MAX_DURATION_SECONDS = 6.0;
const ELEVENLABS_NATURAL_PAUSE_GAP_SECONDS = 0.45;
const ELEVENLABS_CLAUSE_PAUSE_GAP_SECONDS = 0.25;

function isSentenceEndPunctuation(text) {
  const normalized = String(text || '').trim().replace(/["'”’」』）】》〉]+$/u, '');
  return /[。！？!?…\n]$/u.test(normalized) || /\.{2,}$/u.test(normalized);
}

function isClauseBreakPunctuation(text) {
  const normalized = String(text || '').trim().replace(/["'”’」』）】》〉]+$/u, '');
  return /[，,、;；—–\-]$/u.test(normalized);
}

/**
 * 將 ElevenLabs Scribe 的逐字時間（word-level timestamps）與說話者標籤轉成自然良好斷句的字幕段落。
 */
export function parseElevenLabsTranscriptionResponse(data, audioDuration = Infinity) {
  const responseDurationSec = Number(data?.audio_duration_secs);
  const audioEnd = Number.isFinite(audioDuration) && audioDuration > 0
    ? audioDuration
    : (Number.isFinite(responseDurationSec) && responseDurationSec > 0 ? responseDurationSec : Infinity);

  const rawWords = Array.isArray(data?.words) ? data.words : [];
  const words = [];
  for (const item of rawWords) {
    if (item?.type === 'spacing' || item?.type === 'audio_event') continue;
    const text = typeof item?.text === 'string' ? item.text.trim() : '';
    const start = item?.start == null ? NaN : Number(item.start);
    const end = item?.end == null ? NaN : Number(item.end);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) continue;
    const wordStart = Math.min(audioEnd, start);
    const wordEnd = Math.min(audioEnd, end);
    if (wordStart >= audioEnd || wordEnd <= wordStart) continue;

    words.push({
      text,
      start: wordStart,
      end: wordEnd,
      ...(typeof item?.speaker_id === 'string' && item.speaker_id ? { speaker: item.speaker_id } : {}),
      ...(item?.logprob != null && Number.isFinite(Number(item.logprob)) ? { logprob: Number(item.logprob) } : {})
    });
  }

  const locale = String(data?.language_code || 'auto');

  if (words.length === 0) {
    const rawFallback = typeof data?.text === 'string' ? data.text.trim() : '';
    const fallbackText = normalizeSubtitleSpacing(rawFallback, locale);
    return {
      text: fallbackText,
      segments: fallbackText && Number.isFinite(audioEnd) && audioEnd < Infinity ? [{
        start: 0,
        end: audioEnd,
        text: fallbackText,
        words: []
      }] : []
    };
  }

  const segments = [];
  let currentGroup = [];

  const flushGroup = () => {
    if (currentGroup.length === 0) return;
    const firstWord = currentGroup[0];
    const lastWord = currentGroup[currentGroup.length - 1];
    let segmentText = joinTimedWordTexts(currentGroup, locale);
    segmentText = normalizeSubtitleSpacing(segmentText, locale);
    segmentText = segmentText.replace(/^[，,、；;:\s]+/u, '').trim();

    if (segmentText) {
      const speaker = currentGroup[0]?.speaker;
      segments.push({
        start: firstWord.start,
        end: lastWord.end,
        text: segmentText,
        words: currentGroup.map(({ text: wText, start: wStart, end: wEnd }) => ({
          text: normalizeSubtitleSpacing(wText, locale),
          start: wStart,
          end: wEnd
        })),
        ...(speaker != null ? { speaker } : {})
      });
    }
    currentGroup = [];
  };

  for (let index = 0; index < words.length; index++) {
    const currentWord = words[index];
    if (currentGroup.length > 0) {
      const prevWord = currentGroup[currentGroup.length - 1];
      const gap = currentWord.start - prevWord.end;
      const speakerChanged = (prevWord.speaker ?? null) !== (currentWord.speaker ?? null);
      const endsPrevSentence = isSentenceEndPunctuation(prevWord.text);
      const endsPrevClause = isClauseBreakPunctuation(prevWord.text);
      const isCloser = isAzureTrailingSentenceCloser(currentWord.text);

      const groupDuration = prevWord.end - currentGroup[0].start;
      const groupCjkCount = Array.from(joinTimedWordTexts(currentGroup, locale).replace(/\s/gu, '')).length;

      let shouldBreak = false;
      if (speakerChanged) {
        shouldBreak = true;
      } else if (endsPrevSentence && !isCloser) {
        shouldBreak = true;
      } else if (!isAzurePunctuationOnly(currentWord.text) && gap >= ELEVENLABS_NATURAL_PAUSE_GAP_SECONDS) {
        shouldBreak = true;
      } else if (endsPrevClause && (gap >= ELEVENLABS_CLAUSE_PAUSE_GAP_SECONDS || groupCjkCount >= 8)) {
        shouldBreak = true;
      } else if (groupCjkCount >= ELEVENLABS_MAX_CJK_CHARS && (gap >= 0.15 || endsPrevClause)) {
        shouldBreak = true;
      } else if (groupCjkCount >= ELEVENLABS_HARD_MAX_CJK_CHARS || groupDuration >= ELEVENLABS_HARD_MAX_DURATION_SECONDS) {
        shouldBreak = true;
      }

      if (shouldBreak) {
        flushGroup();
      }
    }
    currentGroup.push(currentWord);
  }
  flushGroup();

  const rawFullText = typeof data?.text === 'string' && data.text.trim()
    ? data.text.trim()
    : segments.map(s => s.text).join(' ');
  const fullText = normalizeSubtitleSpacing(rawFullText, locale);

  return {
    text: fullText,
    segments
  };
}

/**
 * 呼叫 ElevenLabs Scribe 語音辨識 API
 */
export async function callElevenLabsSpeechTranscription({
  audioBlob,
  apiKey,
  taskMode,
  language = isEditorSpeechTask(taskMode) ? 'auto' : 'zh',
  keyterms = [],
  projectTerms = [],
  numSpeakers = null,
  tagAudioEvents = false,
  audioDuration = Infinity,
  signal = null
}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) throw new Error('請輸入 ElevenLabs API Key');
  if (!(audioBlob instanceof Blob) || audioBlob.size === 0) {
    throw new Error('未提供可供 ElevenLabs 辨識的音訊');
  }

  const formData = new FormData();
  formData.append('file', audioBlob, 'audio.wav');
  const automatic = isEditorSpeechTask(taskMode);
  formData.append('model_id', automatic ? 'scribe_v3' : 'scribe_v2');
  formData.append('timestamps_granularity', 'word');
  formData.append('diarize', 'true');
  formData.append('tag_audio_events', !automatic && tagAudioEvents ? 'true' : 'false');
  const numSpk = Number(numSpeakers);
  if (!automatic && Number.isInteger(numSpk) && numSpk > 0) {
    formData.append('num_speakers', String(numSpk));
  }

  if (language && language !== 'auto') {
    formData.append('language_code', language);
  }

  const cleanKeyterms = (projectTerms.length ? projectTerms : !automatic && Array.isArray(keyterms) ? keyterms : [])
    .map(term => typeof term === 'string' ? term.trim() : '')
    .filter((term, index, list) => term && list.indexOf(term) === index)
    .slice(0, 100);

  for (const term of cleanKeyterms) {
    formData.append('keyterms', term);
  }

  const endpoint = 'https://api.elevenlabs.io/v1/speech-to-text';
  const response = await fetchSpeech(endpoint, {
    method: 'POST',
    headers: { 'xi-api-key': key },
    body: formData,
    signal
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = body?.detail?.message || body?.message || body?.detail || response.statusText || '';
    const safeDetail = detail ? String(detail).split(key).join('[已隱藏]') : '';
    throw new Error(`ElevenLabs 語音辨識失敗 (HTTP ${response.status})${safeDetail ? `：${safeDetail}` : ''}`);
  }

  const data = await response.json();
  const result = parseElevenLabsTranscriptionResponse(data, audioDuration);
  if (automatic && result.text && !result.segments.some(segment => segment.words.length)) {
    throw new Error('ElevenLabs 未回傳有效的逐字時間');
  }
  return typeof data?.language_code === 'string' ? { ...result, language: data.language_code } : result;
}

/**
 * 呼叫 Whisper 語音辨識 API（支援 Groq 雲端、OpenAI 官方以及本地/自建相容端點）。
 * 
 * @param {object} params
 * @param {Blob} params.audioBlob 欲辨識的音訊二進位 Blob (WAV/MP3)
 * @param {'groq'|'openai'|'local'} [params.provider='groq'] 辨識供應商識別
 * @param {string} [params.apiKey] 供應商授權 API Key（若為 local 且伺服器無密碼時可為空）
 * @param {string} [params.localEndpoint='http://127.0.0.1:8080/v1/audio/transcriptions'] 本地或自建 OpenAI 相容伺服器端點
 * @param {string} [params.language='zh'] 辨識語言代碼（如 'zh'、'en'、'ja' 或 'auto'）
 * @param {string} [params.prompt=''] 提示詞與專有名詞引導
 * @param {number} [params.temperature=0] 採樣溫度 (0~1)
 * @param {AbortSignal} [params.signal=null] 取消訊號
 * @returns {Promise<{ words: Array<{start: number, end: number, text: string}>, segments: Array<{start: number, end: number, text: string}>, text?: string }>}
 */
export async function callWhisperApi({
  audioBlob,
  provider = 'groq',
  apiKey,
  localEndpoint = 'http://127.0.0.1:8080/v1/audio/transcriptions',
  taskMode,
  language = isEditorSpeechTask(taskMode) ? 'auto' : 'zh',
  audioDuration = Infinity,
  openaiTiming = 'provider',
  projectTerms = [],
  prompt = '',
  temperature = 0,
  signal = null
}) {
  const isLocal = provider === 'local' || (typeof localEndpoint === 'string' && localEndpoint.trim() && localEndpoint !== 'http://127.0.0.1:8080/v1/audio/transcriptions' && provider !== 'groq' && provider !== 'openai');
  if (!isLocal && (!apiKey || !apiKey.trim())) {
    throw new Error(`請輸入 ${provider === 'groq' ? 'Groq' : 'OpenAI'} API Key`);
  }

  let endpoint = 'https://api.groq.com/openai/v1/audio/transcriptions';
  let model = 'whisper-large-v3';
  const textModel = provider === 'openai' && openaiTiming === 'local';
  const diarized = provider === 'openai' && !textModel && taskMode === 'transcribe';
  const automatic = !isLocal && isEditorSpeechTask(taskMode);

  if (provider === 'openai') {
    endpoint = 'https://api.openai.com/v1/audio/transcriptions';
    model = textModel ? 'gpt-transcribe' : diarized ? 'gpt-4o-transcribe-diarize' : 'whisper-1';
  } else if (isLocal) {
    endpoint = (localEndpoint && localEndpoint.trim()) || 'http://127.0.0.1:8080/v1/audio/transcriptions';
    model = 'whisper-1';
  }

  const formData = new FormData();
  const uploadName = audioBlob?.type === 'audio/mpeg' ? 'audio.mp3' : 'audio.wav';
  formData.append('file', audioBlob, uploadName);
  formData.append('model', model);
  if (textModel) {
    formData.append('response_format', 'json');
    for (const term of projectTerms) formData.append('keywords[]', term);
  } else if (diarized) {
    formData.append('response_format', 'diarized_json');
    formData.append('chunking_strategy', 'auto');
  } else {
    formData.append('response_format', 'verbose_json');
    formData.append('temperature', automatic ? '0' : String(temperature ?? 0));
    formData.append('timestamp_granularities[]', 'word');
    formData.append('timestamp_granularities[]', 'segment');
  }

  if (language && language !== 'auto') {
    formData.append(textModel ? 'languages[]' : 'language', language);
  }
  if (projectTerms.length && !diarized && !textModel) {
    formData.append('prompt', projectTerms.join('、').slice(0, 800));
  } else if (!automatic && prompt && prompt.trim()) {
    formData.append('prompt', prompt.trim());
  }

  const headers = {};
  if (apiKey && apiKey.trim()) {
    headers['Authorization'] = `Bearer ${apiKey.trim()}`;
  }

  const resp = await fetchSpeech(endpoint, {
    method: 'POST',
    headers,
    body: formData,
    signal
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`辨識伺服器回傳錯誤 (HTTP ${resp.status}): ${errText || resp.statusText}`);
  }

  const data = await resp.json();
  if (textModel) {
    if (typeof data?.text !== 'string') throw new Error('OpenAI 未回傳辨識原文');
    return {text:data.text, language:data.languages?.[0]?.code};
  }
  if (diarized) {
    const segments = (Array.isArray(data?.segments) ? data.segments : []).flatMap(segment => {
      const text = typeof segment?.text === 'string' ? segment.text.trim() : '';
      const start = segment?.start, end = Math.min(segment?.end, audioDuration);
      if (!text || !Number.isFinite(start) || !Number.isFinite(segment?.end) || start < 0 || end <= start) return [];
      return [{ start, end, text, ...(typeof segment.speaker === 'string' ? { speaker: segment.speaker } : {}) }];
    });
    if (!segments.length && (data?.text?.trim() || data?.segments?.length)) throw new Error('OpenAI 未回傳有效的字幕起訖時間');
    return { text: data?.text || '', segments, words: [], ...(typeof data?.language === 'string' ? { language: data.language } : {}) };
  }
  const words = Array.isArray(data?.words)
    ? data.words.flatMap(word => {
      const text = typeof word?.word === 'string'
        ? word.word.trim()
        : (typeof word?.text === 'string' ? word.text.trim() : '');
      const start = word?.start == null ? NaN : Number(word.start);
      const end = word?.end == null ? NaN : Math.min(Number(word.end), audioDuration);
      return text && Number.isFinite(start) && start >= 0 && Number.isFinite(end) && end > start
        ? [{ start, end, text }]
        : [];
    })
    : [];
  const segments = [];

  if (data && Array.isArray(data.segments)) {
    const claimedWordIndexes = new Set();
    for (const [segmentIndex, s] of data.segments.entries()) {
      if (s && s.text && s.text.trim()) {
        if (automatic && (!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || Math.min(s.end, audioDuration) <= s.start)) continue;
        const start = Number(s.start) || 0;
        const end = Math.min(Number(s.end) || 0, audioDuration);
        const segmentWords = words.filter((word, wordIndex) => {
          if (claimedWordIndexes.has(wordIndex)) return false;
          const midpoint = (word.start + word.end) / 2;
          const inside = midpoint >= start && (
            segmentIndex === data.segments.length - 1 ? midpoint <= end : midpoint < end
          );
          if (inside) claimedWordIndexes.add(wordIndex);
          return inside;
        });
        segments.push({
          start,
          end,
          text: s.text.trim(),
          ...(segmentWords.length ? { words: segmentWords } : {})
        });
      }
    }
  }
  if (!segments.length && words.length) {
    segments.push({
      start: words[0].start,
      end: words.at(-1).end,
      text: typeof data?.text === 'string' ? data.text.trim() : words.map(word => word.text).join(' '),
      words
    });
  } else if (!segments.length && data?.text?.trim()) {
    if (automatic) throw new Error('語音辨識服務未回傳有效的字幕時間');
    segments.push({
      start: 0,
      end: 0,
      text: data.text.trim()
    });
  }

  return {
    text: data.text || '',
    segments,
    words,
    ...(typeof data?.language === 'string' ? { language: data.language } : {})
  };
}

export function findSilenceSplitPoint(audioBuffer, searchStartSec, searchEndSec) {
  if (!audioBuffer || typeof audioBuffer.getChannelData !== 'function') return null;
  const sampleRate = Number(audioBuffer.sampleRate) || 16000;
  let channelData = null;
  try {
    channelData = audioBuffer.getChannelData(0);
  } catch (error) {
    return null;
  }
  if (!channelData || !channelData.length) return null;

  const startIdx = Math.max(0, Math.floor(searchStartSec * sampleRate));
  const endIdx = Math.min(channelData.length, Math.floor(searchEndSec * sampleRate));
  if (endIdx <= startIdx) return null;

  const windowSamples = Math.floor(0.2 * sampleRate);
  const hopSamples = Math.floor(0.05 * sampleRate);
  if (windowSamples <= 0 || endIdx - startIdx < windowSamples) return null;

  let minEnergy = Infinity;
  let bestSplitSample = Math.floor((startIdx + endIdx) / 2);

  for (let pos = startIdx; pos + windowSamples <= endIdx; pos += hopSamples) {
    let sumSq = 0;
    for (let i = 0; i < windowSamples; i++) {
      const val = channelData[pos + i];
      sumSq += val * val;
    }
    const energy = sumSq / windowSamples;
    if (energy < minEnergy) {
      minEnergy = energy;
      bestSplitSample = pos + Math.floor(windowSamples / 2);
    }
  }

  return bestSplitSample / sampleRate;
}

function transcriptionChunkOverlap(provider, taskMode) {
  // A speaker turn has no word times to reconcile between two uploads.
  // Split once at the quiet boundary so audio belongs to exactly one request.
  return provider === 'openai' && taskMode === 'transcribe' ? 0 : WHISPER_CLOUD_CHUNK_OVERLAP_SECONDS;
}

export function planWhisperCloudChunks(start, end, audioBuffer = null, overlap = WHISPER_CLOUD_CHUNK_OVERLAP_SECONDS) {
  const windows = [];
  for (let chunkStart = start; chunkStart < end;) {
    const rawTargetEnd = chunkStart + WHISPER_CLOUD_CHUNK_SECONDS;
    let chunkEnd = Math.min(end, rawTargetEnd);

    if (chunkEnd < end && audioBuffer) {
      const searchStart = Math.max(chunkStart + 60, rawTargetEnd - 45);
      const searchEnd = Math.min(end, rawTargetEnd);
      const silencePoint = findSilenceSplitPoint(audioBuffer, searchStart, searchEnd);
      if (Number.isFinite(silencePoint) && silencePoint > chunkStart + 30 && silencePoint <= end) {
        chunkEnd = silencePoint;
      }
    }

    windows.push({ start: chunkStart, end: chunkEnd });
    if (chunkEnd >= end) break;
    chunkStart = Math.max(chunkStart + 1, chunkEnd - overlap);
  }
  return windows;
}

function offsetWhisperSegments(
  segments,
  offsetSeconds,
  totalDuration,
  coreStart,
  coreEnd,
  includeCoreEnd = false,
  wordRefs = null,
  preserveProviderMetadata = false
) {
  return (Array.isArray(segments) ? segments : []).flatMap(segment => {
    const text = typeof segment?.text === 'string' ? segment.text.trim() : '';
    if (!text) return [];
    const sourceStart = Number(segment.start);
    const sourceEnd = Number(segment.end);
    const start = Math.max(0, Math.min(totalDuration, (Number.isFinite(sourceStart) ? sourceStart : 0) + offsetSeconds));
    const end = Math.max(0, Math.min(totalDuration, (Number.isFinite(sourceEnd) ? sourceEnd : 0) + offsetSeconds));
    const sourceWords = Array.isArray(segment.words) ? segment.words : [];
    const keptWords = new Set();
    const words = sourceWords.flatMap(word => {
      const wordText = typeof word?.text === 'string' ? word.text.trim() : '';
      const sourceWordStart = Number(word?.start);
      const sourceWordEnd = Number(word?.end);
      if (!wordText || !Number.isFinite(sourceWordStart) || !Number.isFinite(sourceWordEnd)) return [];
      const wordStart = Math.max(0, Math.min(totalDuration, sourceWordStart + offsetSeconds));
      const wordEnd = Math.max(0, Math.min(totalDuration, sourceWordEnd + offsetSeconds));
      const midpoint = (wordStart + wordEnd) / 2;
      const insideCore = midpoint >= coreStart && (includeCoreEnd ? midpoint <= coreEnd : midpoint < coreEnd);
      const overlapRef = wordRefs?.get(word);
      if (wordEnd <= wordStart || !insideCore) return [];
      keptWords.add(word);
      return [{
        start: wordStart,
        end: wordEnd,
        text: wordText,
        ...(overlapRef ? { _whisperOverlapRef: overlapRef } : {})
      }];
    });
    const midpoint = (start + end) / 2;
    const segmentInsideCore = midpoint >= coreStart && (includeCoreEnd ? midpoint <= coreEnd : midpoint < coreEnd);
    // A text-only response carries no timing evidence for overlap ownership.
    // Keep it untimed in the reader path instead of dropping later chunks or
    // inventing a sentence that spans the entire uploaded audio.
    const untimed = preserveProviderMetadata && !sourceWords.length && start === end;
    if ((sourceWords.length && !words.length) || (!sourceWords.length && !segmentInsideCore && !untimed)) return [];
    const retainedText = words.length && words.length < sourceWords.length
      ? retainedTimedWordText(segment, keptWords)
      : text;
    return [{
      ...(preserveProviderMetadata ? segment : {}),
      ...(segment[asrLanguageEvidence] ? { [asrLanguageEvidence]: segment[asrLanguageEvidence] } : {}),
      start: words.length ? words[0].start : start,
      end: words.length ? words.at(-1).end : end,
      text: retainedText,
      ...(words.length ? { words } : {})
    }];
  });
}

function createWhisperChunkWordEvidence(words, chunkIndex, offsetSeconds, totalDuration) {
  const refByWord = new Map();
  const globalWords = [];
  for (const [wordIndex, word] of (Array.isArray(words) ? words : []).entries()) {
    const ref = `${chunkIndex}:${wordIndex}`;
    refByWord.set(word, ref);
    const start = Math.max(0, Math.min(totalDuration, Number(word?.start) + offsetSeconds));
    const end = Math.max(0, Math.min(totalDuration, Number(word?.end) + offsetSeconds));
    const text = typeof word?.text === 'string' ? word.text.trim() : '';
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const normalized = text.normalize('NFKC')
      .toLocaleLowerCase('en-US')
      .replace(/[\p{Punctuation}\p{Symbol}\s]+/gu, '');
    if (!normalized) continue;
    globalWords.push({ ref, start, end, midpoint: (start + end) / 2, normalized });
  }
  return { refByWord, globalWords };
}

function matchWhisperOverlapWords(previousWords, currentWords, overlapStart, overlapEnd) {
  const insideOverlap = word => word.midpoint >= overlapStart && word.midpoint <= overlapEnd;
  const previous = previousWords.filter(insideOverlap);
  const current = currentWords.filter(insideOverlap);
  const candidateIndexes = (word, candidates) => candidates.flatMap((candidate, index) => (
    candidate.normalized === word.normalized &&
    Math.abs(candidate.midpoint - word.midpoint) <= WHISPER_OVERLAP_WORD_MATCH_TOLERANCE_SECONDS
      ? [index]
      : []
  ));

  const matches = [];
  for (let previousIndex = 0; previousIndex < previous.length; previousIndex++) {
    const currentCandidates = candidateIndexes(previous[previousIndex], current);
    if (currentCandidates.length !== 1) continue;
    const currentIndex = currentCandidates[0];
    const previousCandidates = candidateIndexes(current[currentIndex], previous);
    if (previousCandidates.length === 1 && previousCandidates[0] === previousIndex) {
      matches.push([previous[previousIndex].ref, current[currentIndex].ref]);
    }
  }
  return matches;
}

function deduplicateWhisperOverlapSegments(segments, chunkEvidence, chunks, selectionStart) {
  const keptRefs = new Set((Array.isArray(segments) ? segments : [])
    .flatMap(segment => Array.isArray(segment?.words) ? segment.words : [])
    .map(word => word?._whisperOverlapRef)
    .filter(Boolean));
  const removeRefs = new Set();

  for (let index = 1; index < chunks.length; index++) {
    const overlapStart = chunks[index].start - selectionStart;
    const overlapEnd = chunks[index - 1].end - selectionStart;
    const matches = matchWhisperOverlapWords(
      chunkEvidence[index - 1]?.globalWords || [],
      chunkEvidence[index]?.globalWords || [],
      overlapStart,
      overlapEnd
    );
    for (const [previousRef, currentRef] of matches) {
      if (keptRefs.has(previousRef) && keptRefs.has(currentRef)) removeRefs.add(currentRef);
    }
  }

  return (Array.isArray(segments) ? segments : []).flatMap(segment => {
    if (!Array.isArray(segment?.words) || !segment.words.length) return [segment];
    const retainedWords = segment.words.filter(word => !removeRefs.has(word?._whisperOverlapRef));
    if (!retainedWords.length) return [];
    const words = retainedWords.map(word => {
      const { _whisperOverlapRef, ...publicWord } = word;
      return publicWord;
    });
    const removedWord = retainedWords.length !== segment.words.length;
    return [{
      ...segment,
      start: words[0].start,
      end: words.at(-1).end,
      text: removedWord ? retainedTimedWordText(segment, new Set(retainedWords)) : segment.text,
      words
    }];
  });
}

async function readRecognitionRange(source, start, end, signal) {
  throwIfRecognitionAborted(signal);
  if (!(end > start) || end - start > WHISPER_CLOUD_CHUNK_SECONDS) {
    throw new Error('辨識音訊讀取範圍必須介於 0 到 600 秒');
  }
  const buffer = await source.readRange(start, end, { signal });
  throwIfRecognitionAborted(signal);
  const expectedLength = Math.round((end - start) * 16000);
  if (buffer?.sampleRate !== 16000 || buffer?.numberOfChannels !== 1 ||
      typeof buffer.getChannelData !== 'function' || !Number.isInteger(buffer.length) ||
      buffer.length <= 0 || buffer.length > WHISPER_CLOUD_CHUNK_SECONDS * 16000 ||
      Math.abs(buffer.length - expectedLength) > 1 ||
      !Number.isFinite(buffer.duration) || Math.abs(buffer.duration * 16000 - buffer.length) > 1 ||
      buffer.getChannelData(0)?.length !== buffer.length) {
    throw new Error('辨識音訊區間未完整讀取為 16 kHz 單聲道');
  }
  return buffer;
}

function monoPcmBuffer(samples) {
  return {
    sampleRate: 16000,
    numberOfChannels: 1,
    length: samples.length,
    duration: samples.length / 16000,
    getChannelData: () => samples
  };
}

// Decode each source sample once. Only the silence-search tail and overlap
// are carried into the next window, with no preflight over the remaining film.
async function* recognitionReaderWindows(source, start, end, signal, overlap, seconds) {
  let carry = new Float32Array(0),
    readEnd = start;
  for (let chunkStart = start; chunkStart < end; ) {
    const target = Math.min(end, chunkStart + seconds);
    const next = await readRecognitionRange(source, readEnd, target, signal);
    let samples = next.getChannelData(0);
    if (carry.length) {
      const joined = new Float32Array(carry.length + samples.length);
      joined.set(carry);
      joined.set(samples, carry.length);
      samples = joined;
    }
    readEnd = target;
    const last = target === end,
      full = monoPcmBuffer(samples);
    const split = last
      ? full.duration
      : (findSilenceSplitPoint(full, Math.max(60, seconds - 45), full.duration) ?? full.duration);
    const length = Math.min(samples.length, Math.round(split * 16000));
    const chunkEnd = last ? end : chunkStart + length / 16000;
    const nextStart = chunkEnd - overlap;
    carry = last ? null : samples.slice(Math.round((nextStart - chunkStart) * 16000));
    yield {
      start: chunkStart,
      end: chunkEnd,
      buffer: monoPcmBuffer(samples.subarray(0, length)),
      last,
      nextStart
    };
    if (last) return;
    chunkStart = nextStart;
  }
}

async function transcribeRecognitionReader(source, options) {
  const { inT, outT, provider, onProgress, signal } = options;
  if (
    !Number.isFinite(source.duration) ||
    source.duration <= 0 ||
    !Number.isFinite(inT) ||
    inT < 0 ||
    inT >= source.duration ||
    (outT != null && (!Number.isFinite(outT) || outT <= inT))
  ) {
    throw new Error('辨識音訊來源或選取範圍無效');
  }
  if (!['builtin', 'openai', 'groq', 'google', 'azure', 'elevenlabs'].includes(provider)) {
    throw new Error(`不支援的語音辨識供應商：${provider}`);
  }
  const end = Math.min(outT ?? source.duration, source.duration);
  const duration = end - inT;
  const chunkSeconds = provider === 'google' ? GEMINI_INLINE_CHUNK_SECONDS : WHISPER_CLOUD_CHUNK_SECONDS;
  const windows = recognitionReaderWindows(
    source,
    inT,
    end,
    signal,
    transcriptionChunkOverlap(provider, options.taskMode),
    chunkSeconds
  );
  const allSegments = [];
  const chunkEvidence = [];
  const chunks = [];
  for await (const chunk of windows) {
    throwIfRecognitionAborted(signal);
    const index = chunks.length,
      completedWork = chunk.start - inT,
      totalWork = duration;
    chunks.push({ start: chunk.start, end: chunk.end });
    const chunkDuration = chunk.end - chunk.start;
    onProgress?.({
      status: 'transcribing',
      percent: Math.round((completedWork / totalWork) * 100),
      message: `正在辨識第 ${index + 1} 段音訊…`
    });
    const buffer = chunk.buffer;
    const silent = !buffer.getChannelData(0).some((sample) => sample !== 0);
    // Each provider receives the same bounded, source-aligned PCM with local
    // zero as its origin. The session owns close(); this engine owns no files.
    const checkpointKey =
      !silent && options.checkpoints
        ? await recognitionCheckpointKey(buffer.getChannelData(0), chunk, options)
        : null;
    const saved = checkpointKey ? await options.checkpoints.read(checkpointKey) : null;
    throwIfRecognitionAborted(signal);
    const reused =
      Array.isArray(saved) &&
      saved.every(
        (entry) =>
          typeof entry?.segment?.text === 'string' &&
          Number.isFinite(entry.segment.start) &&
          Number.isFinite(entry.segment.end)
      );
    const segments = silent
      ? []
      : reused
        ? saved.map(({ segment, language }) =>
            language ? { ...segment, [asrLanguageEvidence]: language } : segment
          )
        : await transcribeAudioSegments({
            ...options,
            checkpoints: null,
            audioBuffer: buffer,
            inT: 0,
            outT: buffer.duration,
            onProgress: (update) => {
              if (signal?.aborted) return;
              const fraction = Math.max(0, Math.min(1, (Number(update?.percent) || 0) / 100));
              onProgress?.({
                ...update,
                percent: Math.round(((completedWork + chunkDuration * fraction) / totalWork) * 100),
                message: `第 ${index + 1} 段：${update?.message || '正在辨識…'}`
              });
            }
          });
    throwIfRecognitionAborted(signal);
    if (checkpointKey && !reused) {
      await options.checkpoints.write(
        checkpointKey,
        segments.map((entry) => {
          const { [asrLanguageEvidence]: language, ...segment } = entry;
          return { segment, language };
        })
      );
      throwIfRecognitionAborted(signal);
    }
    const offset = chunk.start - inT;
    const evidence = createWhisperChunkWordEvidence(
      segments.flatMap((segment) => (Array.isArray(segment.words) ? segment.words : [])),
      index,
      offset,
      duration
    );
    chunkEvidence.push(evidence);
    const previous = chunks[index - 1];
    allSegments.push(
      ...offsetWhisperSegments(
        segments,
        offset,
        duration,
        previous ? (chunk.start + previous.end) / 2 - inT : 0,
        chunk.last ? duration : (chunk.end + chunk.nextStart) / 2 - inT,
        chunk.last,
        evidence.refByWord,
        true
      )
    );
    onProgress?.({
      status: 'transcribing',
      percent: Math.round(((chunk.end - inT) / duration) * 100),
      message: `${silent ? '已略過全靜音' : reused ? '已還原' : '已完成'}第 ${index + 1} 段音訊`
    });
  }
  throwIfRecognitionAborted(signal);
  return deduplicateWhisperOverlapSegments(allSegments, chunkEvidence, chunks, inT);
}

async function timeCloudTranscript(text, evidenceSegments, signal) {
  // Keep the cloud spelling and punctuation. The local model supplies only the clock.
  const segmenter = new Intl.Segmenter(undefined, { granularity:'sentence' });
  const sentences = text.split(/\r?\n/u).flatMap(line =>
    [...segmenter.segment(line)].map(part => part.segment.trim()).filter(Boolean));
  const { segments } = await matchRecognitionTranscript({
    taskMode:'align', transcript:sentences.join('\n'), evidenceSegments, signal
  });
  const localWords = evidenceSegments.flatMap(segment => segment.words || []);
  return segments.map(segment => {
    if (!segment.timed || !['word', 'segment'].includes(segment.alignment?.timingEvidence)) {
      return { ...segment, start:0, end:0, timed:false };
    }
    const words = localWords.filter(word => word.start >= segment.start && word.end <= segment.end);
    return { ...segment, ...(words.length && {words}) };
  });
}

export async function transcribeAudioStream(options) {
  const { taskMode, provider, language = isEditorSpeechTask(taskMode) ? 'auto' : 'zh' } = options;
  const segments = await transcribeAudioSegments({ ...options, language });
  // Overlap stitching needs the original transcript and word spellings.
  return convertAsrSegmentsToTraditionalChinese(segments, language, { taskMode, provider });
}

async function transcribeAudioSegments({
  audioBuffer,
  inT = 0,
  outT = null,
  provider = 'google',
  taskMode,
  builtinModel = 'onnx-community/whisper-large-v3-turbo',
  apiKey = '',
  azureRegion = DEFAULT_AZURE_SPEECH_REGION,
  azurePhrases = [],
  azureProfanity = 'Raw',
  projectTerms = [],
  openaiTiming = 'provider',
  keyterms = [],
  elevenlabsNumSpeakers = null,
  elevenlabsTagAudioEvents = false,
  language,
  prompt = '',
  temperature = 0,
  vocalFilter = false,
  onProgress = null,
  signal = null,
  checkpoints = null,
  channelSelection = null
}) {
  throwIfRecognitionAborted(signal);
  if (!audioBuffer) {
    throw new Error('未提供有效的音訊來源');
  }

  const endT = Math.min(outT ?? audioBuffer.duration, audioBuffer.duration);
  projectTerms = normalizeRecognitionTerms(projectTerms);
  const automaticSettings = isEditorSpeechTask(taskMode);
  const chunkSeconds = provider === 'google' ? GEMINI_INLINE_CHUNK_SECONDS : WHISPER_CLOUD_CHUNK_SECONDS;
  const needsReader = checkpoints || endT - inT > chunkSeconds && (provider === 'google' ||
    (automaticSettings && provider === 'elevenlabs'));
  if (typeof audioBuffer.readRange === 'function' || needsReader) {
    const source = typeof audioBuffer.readRange === 'function' ? audioBuffer : {
      duration: audioBuffer.duration,
      async readRange(start,end,{signal:rangeSignal}={}) {
        const pcm=new Float32Array(Math.round((end-start)*16000));
        const {numberOfChannels:channels,sampleRate}=audioBuffer;
        if(!pcm.length||!channels)throw new Error('辨識音訊範圍沒有可讀取的樣本');
        for(let ch=0;ch<channels;ch++)await addSpeechChannelInBlocks(pcm,audioBuffer.getChannelData(ch),
          sampleRate,start*sampleRate,{gain:1/channels},()=>throwIfRecognitionAborted(rangeSignal));
        return monoPcmBuffer(pcm);
      }
    };
    return transcribeRecognitionReader(source, { inT, outT: endT, provider, taskMode, builtinModel,
      apiKey, azureRegion, azurePhrases, azureProfanity, keyterms, projectTerms, openaiTiming, elevenlabsNumSpeakers,
      elevenlabsTagAudioEvents, language, prompt, temperature, vocalFilter, onProgress, signal, checkpoints, channelSelection });
  }

  if (provider === 'builtin') {
    const audioFloat32 = extractClipFloat32Mono16k(audioBuffer, inT, endT, { vocalFilter: isEditorSpeechTask(taskMode) ? false : vocalFilter });
    if (!audioFloat32 || audioFloat32.length === 0) {
      throw new Error('音訊長度為 0');
    }
    const res = await transcribeWithBuiltinModel({
      audioFloat32,
      taskMode,
      modelId: builtinModel,
      language,
      prompt: prompt || '',
      temperature,
      onProgress,
      signal
    });
    throwIfRecognitionAborted(signal);
    return recordAsrLanguage(
      Array.isArray(res?.segments) ? res.segments : [],
      language, res?.language
    );
  }

  if (provider === 'openai' || provider === 'groq') {
    const chunks = planWhisperCloudChunks(inT, endT, audioBuffer, transcriptionChunkOverlap(provider, taskMode));
    const duration = endT - inT;
    const providerLabel = provider === 'openai' ? 'OpenAI' : 'Groq';
    const allSegments = [];
    const chunkEvidence = [];
    const totalWorkSeconds = chunks.reduce((sum, chunk) => sum + (chunk.end - chunk.start), 0);
    let completedWorkSeconds = 0;

    for (let index = 0; index < chunks.length; index++) {
      throwIfRecognitionAborted(signal);
      const chunk = chunks[index];
      onProgress?.({
        status: 'transcribing',
        percent: Math.round(completedWorkSeconds / totalWorkSeconds * 100),
        message: `${providerLabel} 正在辨識第 ${index + 1}/${chunks.length} 段音訊…`
      });
      const wavBlob = encodeWav16kMono(audioBuffer, chunk.start, chunk.end, { vocalFilter: !isEditorSpeechTask(taskMode) && vocalFilter });
      if (!wavBlob) throw new Error('音訊長度為 0');
      if (wavBlob.size > WHISPER_CLOUD_MAX_WAV_BYTES) {
        throw new Error(`雲端語音辨識分段仍超過安全上傳大小（${wavBlob.size} bytes）`);
      }
      const chunkBlob = isEditorSpeechTask(taskMode) ? wavBlob : await compressWhisperUploadForDesktop(wavBlob, signal);
      const localTimes = provider === 'openai' && openaiTiming === 'local';
      const timing = localTimes ? await transcribeWithBuiltinModel({ taskMode:'align',
        audioFloat32:extractClipFloat32Mono16k(audioBuffer, chunk.start, chunk.end), language, signal, onProgress }) : null;
      throwIfRecognitionAborted(signal);
      const result = await callWhisperApi({
        audioBlob: chunkBlob,
        provider,
        apiKey,
        taskMode,
        audioDuration: chunk.end - chunk.start,
        projectTerms, openaiTiming,
        language,
        prompt,
        temperature,
        signal
      });
      throwIfRecognitionAborted(signal);
      if (localTimes) {
        result.segments = await timeCloudTranscript(result.text, timing?.segments || [], signal);
        result.words = result.segments.flatMap(segment => segment.words || []);
      }
      const chunkOffset = chunk.start - inT;
      const wordEvidence = createWhisperChunkWordEvidence(
        result?.words,
        index,
        chunkOffset,
        duration
      );
      chunkEvidence.push(wordEvidence);
      const previousChunk = chunks[index - 1];
      const nextChunk = chunks[index + 1];
      const coreStart = previousChunk
        ? ((chunk.start + previousChunk.end) / 2) - inT
        : 0;
      const coreEnd = nextChunk
        ? ((chunk.end + nextChunk.start) / 2) - inT
        : duration;
      const chunkSegments = Array.isArray(result?.segments) && result.segments.length
        ? result.segments
        : (result?.text ? [{ start: 0, end: chunk.end - chunk.start, text: result.text }] : []);
      allSegments.push(...offsetWhisperSegments(
        recordAsrLanguage(chunkSegments, language, result?.language),
        chunkOffset,
        duration,
        coreStart,
        coreEnd,
        index === chunks.length - 1,
        wordEvidence.refByWord,
        localTimes || provider === 'openai' && taskMode === 'transcribe'
      ));
      completedWorkSeconds += chunk.end - chunk.start;
      onProgress?.({
        status: 'transcribing',
        percent: Math.round(completedWorkSeconds / totalWorkSeconds * 100),
        message: `${providerLabel} 已完成第 ${index + 1}/${chunks.length} 段音訊`
      });
    }

    return deduplicateWhisperOverlapSegments(allSegments, chunkEvidence, chunks, inT);
  }

  const wavBlob = encodeWav16kMono(audioBuffer, inT, endT, { vocalFilter: automaticSettings ? false : vocalFilter });
  if (!wavBlob) throw new Error('音訊長度為 0');

  if (provider === 'google') {
    const res = await callGeminiAudioTranscription({
      audioBlob: wavBlob,
      apiKey,
      taskMode,
      language,
      prompt: automaticSettings ? '' : prompt,
      signal
    });
    throwIfRecognitionAborted(signal);
    return recordAsrLanguage(Array.isArray(res?.segments) ? res.segments : [], language);
  }

  if (provider === 'azure') {
    const res = await callAzureSpeechTranscription({
      audioBlob: wavBlob,
      apiKey,
      region: azureRegion,
      language,
      ...(isEditorSpeechTask(taskMode) ? {} : { phrases: azurePhrases, profanityFilterMode: azureProfanity }),
      ...(projectTerms.length && {phrases:projectTerms}),
      signal
    });
    throwIfRecognitionAborted(signal);
    return recordAsrLanguage(Array.isArray(res?.segments) ? res.segments : [], language);
  }

  if (provider === 'elevenlabs') {
    const effectiveKeyterms = Array.isArray(keyterms) && keyterms.length
      ? keyterms
      : (Array.isArray(azurePhrases) ? azurePhrases : []);
    const res = await callElevenLabsSpeechTranscription({
      audioBlob: wavBlob,
      apiKey,
      language,
      taskMode,
      audioDuration: endT - inT,
      keyterms: effectiveKeyterms,
      projectTerms,
      numSpeakers: elevenlabsNumSpeakers,
      tagAudioEvents: elevenlabsTagAudioEvents,
      signal
    });
    throwIfRecognitionAborted(signal);
    return recordAsrLanguage(Array.isArray(res?.segments) ? res.segments : [], language, res?.language);
  }

  throw new Error(`不支援的語音辨識供應商：${provider}`);
}
