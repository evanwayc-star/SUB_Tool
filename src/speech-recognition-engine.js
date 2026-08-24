/* ==============================================================================
   SUB Tool — Speech Recognition Engine (src/speech-recognition-engine.js)
   ==============================================================================
   深層語音辨識推論模組（Audio Inference Engine）。
   封裝 16kHz PCM 降採樣、WAV 二進位編碼、雲端 REST 多模態模型通訊
   （Google Gemini / Azure Speech / Groq Whisper / OpenAI Whisper）與本機 ONNX WebGPU/WASM 管線。
   ============================================================================== */
import { transcribeBuiltinAudioInWorker } from './speech-recognition-worker-client.js';
import { resolveBuiltinExecutionPlan } from './speech-recognition-worker-runtime.js';
import OpenCC from 'opencc-js/cn2t';

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
    id: 'onnx-community/whisper-tiny',
    name: 'Tiny (CPU 約 39MB／GPU 約 150MB)',
    size: 'CPU 約 39MB／GPU 約 150MB',
    webgpuDtype: 'fp32',
    wasmDtype: 'q8',
    desc: '速度極快，佔用記憶體極少，適合快速草稿。'
  },
  'onnx-community/whisper-base': {
    id: 'onnx-community/whisper-base',
    name: 'Base (CPU 約 73MB／GPU 約 290MB)',
    size: 'CPU 約 73MB／GPU 約 290MB',
    webgpuDtype: 'fp32',
    wasmDtype: 'q8',
    desc: '速度與準確度均衡，適合日常對白剪輯。'
  },
  'onnx-community/whisper-small': {
    id: 'onnx-community/whisper-small',
    name: 'Small (CPU 約 240MB／GPU 約 560MB)',
    size: 'CPU 約 240MB／GPU 約 560MB',
    webgpuDtype: WEBGPU_WHISPER_MIXED_DTYPE,
    wasmDtype: 'q8',
    desc: '中文與繁體字辨識度更佳；GPU 使用高精度 encoder 與高效率 decoder。'
  },
  'onnx-community/whisper-large-v3-turbo': {
    id: 'onnx-community/whisper-large-v3-turbo',
    name: 'Large v3 Turbo q4 (速度優先約 800MB)',
    size: '約 800MB',
    webgpuDtype: 'q4',
    wasmDtype: 'q8',
    desc: '大型模型的相容性量化版，速度優先；精準成品仍建議比較 Small 或雲端 Speech-to-Text。'
  }
};

const simplifiedToTaiwanTraditional = OpenCC.Converter({ from: 'cn', to: 'twp' });

export function convertAsrSegmentsToTraditionalChinese(segments, language = 'zh') {
  if (language !== 'zh' || !Array.isArray(segments)) return segments;
  return segments.map(segment => ({
    ...segment,
    text: typeof segment?.text === 'string'
      ? simplifiedToTaiwanTraditional(segment.text)
      : segment?.text
  }));
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
    pipe = await pipeline('automatic-speech-recognition', modelId, {
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
    pipe = await pipeline('automatic-speech-recognition', modelId, {
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
      ...(phrase.confidence != null && Number.isFinite(Number(phrase.confidence))
        ? { confidence: Number(phrase.confidence) }
        : {})
    });
  }

  const combinedText = (Array.isArray(data?.combinedPhrases) ? data.combinedPhrases : [])
    .map(item => typeof item?.text === 'string' ? item.text.trim() : '')
    .filter(Boolean)
    .join('\n');
  return { text: combinedText || segments.map(segment => segment.text).join(' '), segments };
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
  region = 'southeastasia',
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
    throw new Error('Azure Speech Region 格式不正確，例如 southeastasia');
  }

  const definition = {};
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
  formData.append('file', audioBlob, 'audio.wav');
  formData.append('model', model);
  formData.append('response_format', 'verbose_json');
  formData.append('temperature', '0');

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
  const segments = [];

  if (data && Array.isArray(data.segments)) {
    for (const s of data.segments) {
      if (s && s.text && s.text.trim()) {
        segments.push({
          start: Number(s.start) || 0,
          end: Number(s.end) || 0,
          text: s.text.trim()
        });
      }
    }
  } else if (data && data.text && data.text.trim()) {
    segments.push({
      start: 0,
      end: 0,
      text: data.text.trim()
    });
  }

  return {
    text: data.text || '',
    segments
  };
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
  azureRegion = 'southeastasia',
  azurePhrases = [],
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

  const wavBlob = encodeWav16kMono(audioBuffer, inT, endT);
  if (!wavBlob) {
    throw new Error('音訊長度為 0');
  }

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

  const res = await callWhisperApi({
    audioBlob: wavBlob,
    provider,
    apiKey,
    language,
    prompt,
    signal
  });

  throwIfRecognitionAborted(signal);
  return convertAsrSegmentsToTraditionalChinese(
    Array.isArray(res?.segments)
      ? res.segments
      : (res?.text ? [{ start: 0, end: endT - inT, text: res.text }] : []),
    language
  );
}
