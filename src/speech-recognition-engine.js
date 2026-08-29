/* ==============================================================================
   SUB Tool — Speech Recognition Engine (src/speech-recognition-engine.js)
   ==============================================================================
   深層語音辨識推論模組（Audio Inference Engine）。
   封裝 16kHz PCM 降採樣、WAV 二進位編碼、雲端 REST 多模態模型通訊
   （Google Gemini / Azure Speech / Groq Whisper / OpenAI Whisper）與本機 ONNX WebGPU/WASM 管線。
   ============================================================================== */
import { transcribeBuiltinAudioInWorker } from './speech-recognition-worker-client.js';
import { resolveBuiltinExecutionPlan } from './speech-recognition-worker-runtime.js';
import { b64ToBytes } from './util.js';
import OpenCC from 'opencc-js/cn2t';

// 16 kHz / 16-bit / mono PCM 每秒 32,000 bytes。雲端 Whisper 單段固定控制在
// 10 分鐘（約 19.2 MB WAV），為 OpenAI/Groq 的 multipart 封裝與供應商差異保留餘裕。
const WHISPER_CLOUD_CHUNK_SECONDS = 600;
const WHISPER_CLOUD_CHUNK_OVERLAP_SECONDS = 10;
const WHISPER_CLOUD_MAX_WAV_BYTES = 20_000_000;
const WHISPER_OVERLAP_WORD_MATCH_TOLERANCE_SECONDS = 1.25;
let whisperCompressionRequestSequence = 0;

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
    size: '約 800MB',
    webgpuDtype: 'q4',
    wasmDtype: 'q8',
    desc: '大型模型的相容性量化版，速度優先；精準成品仍建議比較 Small 或雲端 Speech-to-Text。'
  }
};

const simplifiedToTaiwanTraditional = OpenCC.Converter({ from: 'cn', to: 'twp' });

/**
 * 正規化字幕空白間距：
 * 消除 CJK（中/日/韓）字元之間的不必要空白與標點前贅空，同時保持中英/數字混排自然空格。
 */
export function normalizeSubtitleSpacing(text, locale = 'zh') {
  if (typeof text !== 'string' || !text) return '';
  let result = text.trim();
  const compact = azureUsesCompactSpacing(locale, result);
  if (compact) {
    // 1. 去除中/日/韓 CJK 字符之間的任何空白（包括全形空格、不斷行空格）
    result = result.replace(/(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\s\u3000\u00A0]+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/gu, '');
    // 2. 去除 CJK 與中文/通用標點符號之間的空白
    result = result.replace(/(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\s\u3000\u00A0]+(?=[，。！？、；：”’」』）】》〉!?,.:;])/gu, '');
    result = result.replace(/(?<=[“‘「『（【《〈!?,.:;])[\s\u3000\u00A0]+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/gu, '');
  }
  // 3. 多重空白收斂為單一空格
  result = result.replace(/[\s\u3000\u00A0]+/gu, ' ').trim();
  return result;
}

export function convertAsrSegmentsToTraditionalChinese(segments, language = 'zh') {
  if (language !== 'zh' || !Array.isArray(segments)) return segments;
  return segments.map(segment => {
    let text = segment?.text;
    if (typeof text === 'string') {
      text = simplifiedToTaiwanTraditional(text);
      text = normalizeSubtitleSpacing(text, language);
    }
    return {
      ...segment,
      text
    };
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
  const endSample = Math.min(
    audioBuffer.length,
    Math.floor((endSec != null ? endSec : audioBuffer.duration) * srcSampleRate)
  );
  const srcLength = Math.max(0, endSample - startSample);
  if (srcLength <= 0) return null;

  const targetSampleRate = 16000;
  const targetLength = Math.floor(srcLength * (targetSampleRate / srcSampleRate));
  if (targetLength <= 0) return null;

  const monoSamples = new Float32Array(srcLength);
  for (let ch = 0; ch < numChannels; ch++) {
    const chData = audioBuffer.getChannelData(ch);
    for (let i = 0; i < srcLength; i++) {
      monoSamples[i] += chData[startSample + i] / numChannels;
    }
  }

  const ratio = srcSampleRate / targetSampleRate;
  const targetSamples = new Float32Array(targetLength);
  for (let i = 0; i < targetLength; i++) {
    const srcIdx = i * ratio;
    const i0 = Math.floor(srcIdx);
    const i1 = Math.min(monoSamples.length - 1, i0 + 1);
    const frac = srcIdx - i0;
    targetSamples[i] = (1 - frac) * monoSamples[i0] + frac * monoSamples[i1];
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

export function extractClipFloat32Mono16k(audioBuffer, startSec = 0, endSec = null) {
  return normalizeRecognitionPeak(downmixAndResampleMono16k(audioBuffer, startSec, endSec));
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
export function encodeWav16kMono(audioBuffer, startSec = 0, endSec = null) {
  const pcmFloat = extractClipFloat32Mono16k(audioBuffer, startSec, endSec);
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

/** 本機 pipeline 單例快取 */
let cachedTranscriber = null;
let cachedPipelineKey = null;

/**
 * 載入或重用 Transformers.js 本機語音辨識 Pipeline
 */
export async function loadTransformersPipeline(modelId = 'onnx-community/whisper-base', onProgress = null) {
  const moduleUrl = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3';
  const { pipeline, env } = await import(/* @vite-ignore */ moduleUrl);

  env.allowLocalModels = false;
  env.useBrowserCache = true;

  const modelMeta = BUILTIN_MODELS[modelId] || BUILTIN_MODELS['onnx-community/whisper-base'];
  const preferredPlan = resolveBuiltinExecutionPlan({
    hasWebGpu: typeof navigator !== 'undefined' && Boolean(navigator.gpu),
    webgpuDtype: modelMeta.webgpuDtype,
    wasmDtype: modelMeta.wasmDtype
  });
  const fallbackPlan = resolveBuiltinExecutionPlan({
    hasWebGpu: false,
    webgpuDtype: modelMeta.webgpuDtype,
    wasmDtype: modelMeta.wasmDtype
  });
  const keyFor = plan => JSON.stringify({ modelId: modelMeta.id, ...plan });
  if (cachedTranscriber && (
    cachedPipelineKey === keyFor(preferredPlan) || cachedPipelineKey === keyFor(fallbackPlan)
  )) return cachedTranscriber;

  if (onProgress) onProgress({ status: 'loading', message: `正在載入 ${modelMeta.name} 模型檔案…` });

  if (cachedTranscriber?.dispose) await cachedTranscriber.dispose();
  cachedTranscriber = null;
  cachedPipelineKey = null;
  let pipe = null;
  let actualPlan = preferredPlan;
  try {
    pipe = await pipeline('automatic-speech-recognition', modelMeta.id, {
      device: preferredPlan.device,
      dtype: preferredPlan.dtype,
      progress_callback: (p) => {
        if (onProgress) onProgress(p);
      }
    });
  } catch (err) {
    if (preferredPlan.device === 'wasm') throw err;
    console.warn('以 WebGPU 載入失敗，嘗試回退至 CPU (WASM) 模式:', err);
    if (onProgress) onProgress({ status: 'fallback', message: 'WebGPU 無法啟動，切換至 CPU (WASM q8) 模式…' });
    actualPlan = fallbackPlan;
    pipe = await pipeline('automatic-speech-recognition', modelMeta.id, {
      device: fallbackPlan.device,
      dtype: fallbackPlan.dtype,
      progress_callback: (p) => {
        if (onProgress) onProgress(p);
      }
    });
  }

  cachedTranscriber = pipe;
  cachedPipelineKey = keyFor(actualPlan);
  return pipe;
}

/**
 * 使用 Transformers.js 本機模型推論音訊
 */
export async function transcribeWithBuiltinModel({
  audioFloat32,
  modelId = 'onnx-community/whisper-base',
  language = 'zh',
  prompt = '',
  onProgress = null,
  signal = null
}) {
  if (!audioFloat32 || audioFloat32.length === 0) {
    throw new Error('音訊長度為 0，無法進行辨識');
  }
  throwIfRecognitionAborted(signal);
  const modelMeta = BUILTIN_MODELS[modelId] || BUILTIN_MODELS['onnx-community/whisper-base'];
  return transcribeBuiltinAudioInWorker({
    audioFloat32,
    modelId: modelMeta.id,
    modelName: modelMeta.name,
    webgpuDtype: modelMeta.webgpuDtype,
    wasmDtype: modelMeta.wasmDtype,
    language,
    prompt,
    onProgress,
    signal
  });
}

/**
 * 自動探索目前 API Key 支援的 Gemini 模型
 */
export async function resolveGeminiModel(apiKey, signal = null) {
  const versions = ['v1', 'v1beta'];
  for (const v of versions) {
    throwIfRecognitionAborted(signal);
    try {
      const resp = await fetch(`https://generativelanguage.googleapis.com/${v}/models`, {
        headers: { 'x-goog-api-key': apiKey },
        signal
      });
      if (resp.ok) {
        const json = await resp.json();
        const models = (json.models || []).map(m => m.name.replace(/^models\//, ''));
        const preferred = [
          'gemini-1.5-flash-latest',
          'gemini-1.5-flash',
          'gemini-1.5-pro-latest',
          'gemini-1.5-pro',
          'gemini-2.0-flash',
          'gemini-2.0-flash-exp'
        ];
        for (const p of preferred) {
          if (models.includes(p)) return { version: v, model: p };
        }
        const anyFlash = models.find(m => m.includes('flash'));
        if (anyFlash) return { version: v, model: anyFlash };
        if (models.length > 0) return { version: v, model: models[0] };
      }
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
    }
  }
  return { version: 'v1beta', model: 'gemini-1.5-flash' };
}

/**
 * 呼叫 Google Gemini API 進行語音理解與時間戳標註
 */
export async function callGeminiAudioTranscription({
  audioBlob,
  apiKey,
  language = 'zh',
  prompt = '',
  signal = null
}) {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('請輸入 Google Gemini API Key');
  }

  throwIfRecognitionAborted(signal);
  const base64Audio = await blobToBase64(audioBlob);
  throwIfRecognitionAborted(signal);
  const langText = language === 'zh' ? '繁體中文 (Traditional Chinese)' : (language === 'en' ? '英文 (English)' : (language === 'ja' ? '日文' : '原文語言'));

  const systemInstruction = `你是一位專業的頂級影視對白字幕聽打專家。請聆聽所附音訊，依據人聲起迄時間精準生成字幕片段。
必須遵循以下規則：
1. 語言請務必使用「${langText}」輸出，若為中文一律使用台灣繁體中文標準用字。
2. 包含標點符號，句子語意完整，單句長度適中（建議 15~25 字以內）。
3. 嚴格輸出 JSON 格式陣列，不要加入額外的 Markdown 標籤或解釋，格式如下：
[
  { "start": 0.5, "end": 2.8, "text": "第一句對話內容。" },
  { "start": 3.1, "end": 5.4, "text": "第二句對話內容。" }
]
4. start 與 end 均為秒數（可包含小數點，例如 1.25）。
${prompt ? `\n提示詞補充導引：${prompt}` : ''}`;

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

  const detected = await resolveGeminiModel(apiKey.trim(), signal);
  const candidateModels = [
    detected.model,
    'gemini-1.5-flash-latest',
    'gemini-1.5-flash',
    'gemini-1.5-pro-latest',
    'gemini-2.0-flash',
    'gemini-2.0-flash-exp'
  ].filter((v, idx, arr) => arr.indexOf(v) === idx);

  const versions = [detected.version, 'v1', 'v1beta'].filter((v, idx, arr) => arr.indexOf(v) === idx);

  let data = null;
  let lastError = null;

  for (const ver of versions) {
    if (data) break;
    for (const m of candidateModels) {
      throwIfRecognitionAborted(signal);
      const url = `https://generativelanguage.googleapis.com/${ver}/models/${m}:generateContent`;
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey.trim()
          },
          body: JSON.stringify(payload),
          signal
        });

        if (resp.ok) {
          data = await resp.json();
          break;
        } else {
          const errJson = await resp.json().catch(() => ({}));
          lastError = new Error(errJson?.error?.message || `Google API 回傳錯誤 HTTP ${resp.status}`);
          if (resp.status !== 404) {
            throw lastError;
          }
        }
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') throw err;
        lastError = err;
        if (!err.message.includes('HTTP 404') && !err.message.includes('not found')) {
          throw err;
        }
      }
    }
  }

  if (!data) {
    if (lastError && (lastError.message.includes('not found') || lastError.message.includes('not supported'))) {
      throw new Error('Google 伺服器回報找不到模型。這通常是因為 Google Cloud 專案權限同步中（約需數分鐘），或請切換至「💻 程式內建本機 AI 引擎」或「⚡ Groq」模式。');
    }
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
  for (const s of segments) {
    if (s && s.text && typeof s.text === 'string' && s.text.trim()) {
      const start = Number(s.start) || 0;
      const end = Number(s.end) || (start + 2);
      validSegments.push({
        start,
        end,
        text: s.text.trim()
      });
    }
  }

  return { segments: validSegments };
}

export const DEFAULT_AZURE_SPEECH_REGION = 'japaneast';

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
  if (normalizedLocale) return /^(?:zh|ja|ko)(?:-|$)/i.test(normalizedLocale);
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(String(text || ''));
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
  if (azureUsesCompactSpacing(locale, normalized)) {
    return Array.from(normalized.replace(/\s/gu, '')).length <= AZURE_SUBTITLE_MAX_CJK_CHARS;
  }
  const wordCount = normalized.split(/\s+/u).filter(Boolean).length;
  return wordCount <= AZURE_SUBTITLE_MAX_LATIN_WORDS &&
    Array.from(normalized).length <= AZURE_SUBTITLE_MAX_LATIN_CHARS;
}

function locateAzureWordsInPhrase(text, words) {
  const source = String(text || '');
  const sourceLower = source.toLocaleLowerCase();
  let cursor = 0;
  const ranges = [];
  for (const word of words) {
    const token = String(word?.text || '');
    let index = source.indexOf(token, cursor);
    if (index < 0) index = sourceLower.indexOf(token.toLocaleLowerCase(), cursor);
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
    if (startsAzureClosingPunctuation(token)) {
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
    if (!compact) {
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
  const wordRanges = locateAzureWordsInPhrase(segment.text, segment.words);
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
  signal = null
}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) throw new Error('請輸入 Azure Speech API Key');
  if (!(audioBlob instanceof Blob) || audioBlob.size === 0) {
    throw new Error('未提供可供 Azure Speech 辨識的音訊');
  }

  const normalizedRegion = typeof region === 'string' ? region.trim().toLowerCase() : '';
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(normalizedRegion)) {
    throw new Error(`Azure Speech Region 格式不正確，例如 ${DEFAULT_AZURE_SPEECH_REGION}`);
  }

  const definition = {
    diarization: { enabled: true, maxSpeakers: AZURE_SPEECH_MAX_SPEAKERS }
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
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': key },
    body: formData,
    signal
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = body?.error?.message || body?.message || response.statusText || '';
    const safeDetail = detail ? String(detail).split(key).join('[已隱藏]') : '';
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
    const start = Number(item?.start);
    const end = Number(item?.end);
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

  const locale = typeof data?.language_code === 'string' ? data.language_code : 'zh';

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
 * 呼叫 ElevenLabs Scribe v2 語音辨識 API
 */
export async function callElevenLabsSpeechTranscription({
  audioBlob,
  apiKey,
  language = 'zh',
  keyterms = [],
  signal = null
}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) throw new Error('請輸入 ElevenLabs API Key');
  if (!(audioBlob instanceof Blob) || audioBlob.size === 0) {
    throw new Error('未提供可供 ElevenLabs 辨識的音訊');
  }

  const formData = new FormData();
  formData.append('file', audioBlob, 'audio.wav');
  formData.append('model_id', 'scribe_v2');
  formData.append('diarize', 'true');
  formData.append('tag_audio_events', 'false');

  if (language && language !== 'auto') {
    formData.append('language_code', language);
  }

  const cleanKeyterms = (Array.isArray(keyterms) ? keyterms : [])
    .map(term => typeof term === 'string' ? term.trim() : '')
    .filter((term, index, list) => term && list.indexOf(term) === index)
    .slice(0, 100);

  for (const term of cleanKeyterms) {
    formData.append('keyterms', term);
  }

  const endpoint = 'https://api.elevenlabs.io/v1/speech-to-text';
  const response = await fetch(endpoint, {
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

  return parseElevenLabsTranscriptionResponse(await response.json());
}

/**
 * 呼叫 Whisper 雲端 API
 */
export async function callWhisperApi({
  audioBlob,
  provider = 'groq',
  apiKey,
  localEndpoint = 'http://127.0.0.1:8080/v1/audio/transcriptions',
  language = 'zh',
  prompt = '',
  signal = null
}) {
  if (!apiKey || !apiKey.trim()) {
    throw new Error(`請輸入 ${provider === 'groq' ? 'Groq' : 'OpenAI'} API Key`);
  }

  let endpoint = 'https://api.groq.com/openai/v1/audio/transcriptions';
  let model = 'whisper-large-v3';

  if (provider === 'openai') {
    endpoint = 'https://api.openai.com/v1/audio/transcriptions';
    model = 'whisper-1';
  }

  const formData = new FormData();
  const uploadName = audioBlob?.type === 'audio/mpeg' ? 'audio.mp3' : 'audio.wav';
  formData.append('file', audioBlob, uploadName);
  formData.append('model', model);
  formData.append('response_format', 'verbose_json');
  formData.append('temperature', '0');
  formData.append('timestamp_granularities[]', 'word');
  formData.append('timestamp_granularities[]', 'segment');

  if (language && language !== 'auto') {
    formData.append('language', language);
  }
  if (prompt && prompt.trim()) {
    formData.append('prompt', prompt.trim());
  }

  const headers = {};
  headers['Authorization'] = `Bearer ${apiKey.trim()}`;

  const resp = await fetch(endpoint, {
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
  const words = Array.isArray(data?.words)
    ? data.words.flatMap(word => {
      const text = typeof word?.word === 'string'
        ? word.word.trim()
        : (typeof word?.text === 'string' ? word.text.trim() : '');
      const start = Number(word?.start);
      const end = Number(word?.end);
      return text && Number.isFinite(start) && Number.isFinite(end) && end > start
        ? [{ start, end, text }]
        : [];
    })
    : [];
  const segments = [];

  if (data && Array.isArray(data.segments)) {
    const claimedWordIndexes = new Set();
    for (const [segmentIndex, s] of data.segments.entries()) {
      if (s && s.text && s.text.trim()) {
        const start = Number(s.start) || 0;
        const end = Number(s.end) || 0;
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
  } else if (words.length) {
    segments.push({
      start: words[0].start,
      end: words.at(-1).end,
      text: typeof data?.text === 'string' ? data.text.trim() : words.map(word => word.text).join(' '),
      words
    });
  } else if (data && data.text && data.text.trim()) {
    segments.push({
      start: 0,
      end: 0,
      text: data.text.trim()
    });
  }

  return {
    text: data.text || '',
    segments,
    words
  };
}

function planWhisperCloudChunks(start, end) {
  const windows = [];
  for (let chunkStart = start; chunkStart < end;) {
    const chunkEnd = Math.min(end, chunkStart + WHISPER_CLOUD_CHUNK_SECONDS);
    windows.push({ start: chunkStart, end: chunkEnd });
    if (chunkEnd >= end) break;
    chunkStart = chunkEnd - WHISPER_CLOUD_CHUNK_OVERLAP_SECONDS;
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
  wordRefs = null
) {
  return (Array.isArray(segments) ? segments : []).flatMap(segment => {
    const text = typeof segment?.text === 'string' ? segment.text.trim() : '';
    if (!text) return [];
    const sourceStart = Number(segment.start);
    const sourceEnd = Number(segment.end);
    const start = Math.max(0, Math.min(totalDuration, (Number.isFinite(sourceStart) ? sourceStart : 0) + offsetSeconds));
    const end = Math.max(0, Math.min(totalDuration, (Number.isFinite(sourceEnd) ? sourceEnd : 0) + offsetSeconds));
    const sourceWords = Array.isArray(segment.words) ? segment.words : [];
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
      return wordEnd > wordStart && insideCore ? [{
        start: wordStart,
        end: wordEnd,
        text: wordText,
        ...(overlapRef ? { _whisperOverlapRef: overlapRef } : {})
      }] : [];
    });
    const midpoint = (start + end) / 2;
    const segmentInsideCore = midpoint >= coreStart && (includeCoreEnd ? midpoint <= coreEnd : midpoint < coreEnd);
    if ((sourceWords.length && !words.length) || (!sourceWords.length && !segmentInsideCore)) return [];
    const retainedText = words.length && words.length < sourceWords.length
      ? joinTimedWordTexts(words, '')
      : text;
    return [{
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
      text: removedWord ? joinTimedWordTexts(words, '') : segment.text,
      words
    }];
  });
}

/**
 * 統一音訊串流辨識總入口（深層模組核心接縫）
 */
export async function transcribeAudioStream({
  audioBuffer,
  inT = 0,
  outT = null,
  provider = 'google',
  builtinModel = 'onnx-community/whisper-large-v3-turbo',
  apiKey = '',
  azureRegion = DEFAULT_AZURE_SPEECH_REGION,
  azurePhrases = [],
  keyterms = [],
  language = 'zh',
  prompt = '',
  onProgress = null,
  signal = null
}) {
  throwIfRecognitionAborted(signal);
  if (!audioBuffer) {
    throw new Error('未提供有效的音訊來源');
  }

  const endT = (outT && outT > inT) ? outT : (inT + (audioBuffer.duration || 0));

  if (provider === 'builtin') {
    const audioFloat32 = extractClipFloat32Mono16k(audioBuffer, inT, endT);
    if (!audioFloat32 || audioFloat32.length === 0) {
      throw new Error('音訊長度為 0');
    }
    const res = await transcribeWithBuiltinModel({
      audioFloat32,
      modelId: builtinModel,
      language,
      prompt: '',
      onProgress,
      signal
    });
    throwIfRecognitionAborted(signal);
    return convertAsrSegmentsToTraditionalChinese(
      Array.isArray(res?.segments) ? res.segments : [],
      language
    );
  }

  if (provider === 'openai' || provider === 'groq') {
    const chunks = planWhisperCloudChunks(inT, endT);
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
      const wavBlob = encodeWav16kMono(audioBuffer, chunk.start, chunk.end);
      if (!wavBlob) throw new Error('音訊長度為 0');
      if (wavBlob.size > WHISPER_CLOUD_MAX_WAV_BYTES) {
        throw new Error(`雲端語音辨識分段仍超過安全上傳大小（${wavBlob.size} bytes）`);
      }
      const chunkBlob = await compressWhisperUploadForDesktop(wavBlob, signal);
      const result = await callWhisperApi({
        audioBlob: chunkBlob,
        provider,
        apiKey,
        language,
        prompt,
        signal
      });
      throwIfRecognitionAborted(signal);
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
        chunkSegments,
        chunkOffset,
        duration,
        coreStart,
        coreEnd,
        index === chunks.length - 1,
        wordEvidence.refByWord
      ));
      completedWorkSeconds += chunk.end - chunk.start;
      onProgress?.({
        status: 'transcribing',
        percent: Math.round(completedWorkSeconds / totalWorkSeconds * 100),
        message: `${providerLabel} 已完成第 ${index + 1}/${chunks.length} 段音訊`
      });
    }

    return convertAsrSegmentsToTraditionalChinese(
      deduplicateWhisperOverlapSegments(allSegments, chunkEvidence, chunks, inT),
      language
    );
  }

  const wavBlob = encodeWav16kMono(audioBuffer, inT, endT);
  if (!wavBlob) throw new Error('音訊長度為 0');

  if (provider === 'google') {
    const res = await callGeminiAudioTranscription({
      audioBlob: wavBlob,
      apiKey,
      language,
      prompt,
      signal
    });
    throwIfRecognitionAborted(signal);
    return convertAsrSegmentsToTraditionalChinese(
      Array.isArray(res?.segments) ? res.segments : [],
      language
    );
  }

  if (provider === 'azure') {
    const res = await callAzureSpeechTranscription({
      audioBlob: wavBlob,
      apiKey,
      region: azureRegion,
      language,
      phrases: azurePhrases,
      signal
    });
    throwIfRecognitionAborted(signal);
    return convertAsrSegmentsToTraditionalChinese(
      Array.isArray(res?.segments) ? res.segments : [],
      language
    );
  }

  if (provider === 'elevenlabs') {
    const effectiveKeyterms = Array.isArray(keyterms) && keyterms.length
      ? keyterms
      : (Array.isArray(azurePhrases) ? azurePhrases : []);
    const res = await callElevenLabsSpeechTranscription({
      audioBlob: wavBlob,
      apiKey,
      language,
      keyterms: effectiveKeyterms,
      signal
    });
    throwIfRecognitionAborted(signal);
    return convertAsrSegmentsToTraditionalChinese(
      Array.isArray(res?.segments) ? res.segments : [],
      language
    );
  }

  throw new Error(`不支援的語音辨識供應商：${provider}`);
}
