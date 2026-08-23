/* ==============================================================================
   SUB Tool — Speech Recognition Engine (src/speech-recognition-engine.js)
   ==============================================================================
   深層語音辨識推論模組（Audio Inference Engine）。
   封裝 16kHz PCM 降採樣、WAV 二進位編碼、雲端 REST 多模態模型通訊
   （Google Gemini / Groq Whisper / OpenAI Whisper）與本機 ONNX WebGPU/WASM 管線。
   ============================================================================== */

/** 內建支援之本機模型清單 */
export const BUILTIN_MODELS = {
  'onnx-community/whisper-tiny': {
    id: 'onnx-community/whisper-tiny',
    name: 'Tiny (超輕量 39MB)',
    size: '39MB',
    dtype: 'fp32',
    desc: '速度極快，佔用記憶體極少，適合快速草稿。'
  },
  'onnx-community/whisper-base': {
    id: 'onnx-community/whisper-base',
    name: 'Base (標準推薦 73MB)',
    size: '73MB',
    dtype: 'fp32',
    desc: '速度與準確度均衡，適合日常對白剪輯。'
  },
  'onnx-community/whisper-small': {
    id: 'onnx-community/whisper-small',
    name: 'Small (高精度 240MB)',
    size: '240MB',
    dtype: 'q8',
    desc: '中文與繁體字辨識度更佳，適合清晰收音內容。'
  },
  'onnx-community/whisper-large-v3-turbo': {
    id: 'onnx-community/whisper-large-v3-turbo',
    name: 'Large v3 Turbo (旗艦極速 800MB)',
    size: '800MB',
    dtype: 'q4',
    desc: 'OpenAI 官方最新旗艦模型，頂級繁體中文精度與極速推論。'
  }
};

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
export function extractClipFloat32Mono16k(audioBuffer, startSec = 0, endSec = null) {
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

  // 音訊波形峰值正規化（強化低音量對白特徵並抑制噪訊）
  let maxPeak = 0;
  for (let i = 0; i < targetLength; i++) {
    const abs = Math.abs(targetSamples[i]);
    if (abs > maxPeak) maxPeak = abs;
  }
  if (maxPeak > 0.005 && maxPeak < 0.95) {
    const gain = Math.min(8.0, 0.95 / maxPeak);
    for (let i = 0; i < targetLength; i++) {
      targetSamples[i] *= gain;
    }
  }

  return targetSamples;
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
let cachedModelId = null;

/**
 * 載入或重用 Transformers.js 本機語音辨識 Pipeline
 */
export async function loadTransformersPipeline(modelId = 'onnx-community/whisper-base', onProgress = null) {
  if (cachedTranscriber && cachedModelId === modelId) {
    return cachedTranscriber;
  }

  const moduleUrl = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3';
  const { pipeline, env } = await import(/* @vite-ignore */ moduleUrl);

  env.allowLocalModels = false;
  env.useBrowserCache = true;

  const modelMeta = BUILTIN_MODELS[modelId] || BUILTIN_MODELS['onnx-community/whisper-base'];
  let device = 'wasm';
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    device = 'webgpu';
  }

  if (onProgress) onProgress({ status: 'loading', message: `正在載入 ${modelMeta.name} 模型檔案…` });

  let pipe = null;
  try {
    pipe = await pipeline('automatic-speech-recognition', modelId, {
      device,
      dtype: modelMeta.dtype || 'fp32',
      progress_callback: (p) => {
        if (onProgress) onProgress(p);
      }
    });
  } catch (err) {
    console.warn(`以 ${device} 載入失敗，嘗試回退至 CPU (WASM) 模式:`, err);
    if (onProgress) onProgress({ status: 'fallback', message: '切換至 CPU 多執行緒模式載入模型…' });
    pipe = await pipeline('automatic-speech-recognition', modelId, {
      device: 'wasm',
      dtype: 'fp32',
      progress_callback: (p) => {
        if (onProgress) onProgress(p);
      }
    });
  }

  cachedTranscriber = pipe;
  cachedModelId = modelId;
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
  onProgress = null
}) {
  if (!audioFloat32 || audioFloat32.length === 0) {
    throw new Error('音訊長度為 0，無法進行辨識');
  }

  const transcriber = await loadTransformersPipeline(modelId, onProgress);

  if (onProgress) onProgress({ status: 'transcribing', percent: 10, message: '本機 AI 正在聆聽與分析語音…' });

  const generateKwargs = {
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5
  };

  if (language && language !== 'auto') {
    generateKwargs.language = language;
    generateKwargs.task = 'transcribe';
  }
  if (prompt && prompt.trim()) {
    generateKwargs.prompt = prompt.trim();
  }

  const output = await transcriber(audioFloat32, generateKwargs);

  if (onProgress) onProgress({ status: 'done', percent: 100, message: '本機辨識完成！' });

  let segments = [];
  if (output && Array.isArray(output.chunks) && output.chunks.length > 0) {
    for (const chunk of output.chunks) {
      if (chunk && chunk.text && chunk.text.trim()) {
        const start = (chunk.timestamp && chunk.timestamp[0] != null) ? chunk.timestamp[0] : 0;
        const end = (chunk.timestamp && chunk.timestamp[1] != null) ? chunk.timestamp[1] : (start + 2);
        segments.push({
          start,
          end,
          text: chunk.text.trim()
        });
      }
    }
  } else if (output && output.text && output.text.trim()) {
    segments.push({
      start: 0,
      end: audioFloat32.length / 16000,
      text: output.text.trim()
    });
  }

  return { segments };
}

/**
 * 自動探索目前 API Key 支援的 Gemini 模型
 */
export async function resolveGeminiModel(apiKey) {
  const versions = ['v1', 'v1beta'];
  for (const v of versions) {
    try {
      const resp = await fetch(`https://generativelanguage.googleapis.com/${v}/models`, {
        headers: { 'x-goog-api-key': apiKey }
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
    } catch (_) {}
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
  prompt = ''
}) {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('請輸入 Google Gemini API Key');
  }

  const base64Audio = await blobToBase64(audioBlob);
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

  const detected = await resolveGeminiModel(apiKey.trim());
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
      const url = `https://generativelanguage.googleapis.com/${ver}/models/${m}:generateContent`;
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey.trim()
          },
          body: JSON.stringify(payload)
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
 * 呼叫 Whisper 雲端 API
 */
export async function callWhisperApi({
  audioBlob,
  provider = 'groq',
  apiKey,
  localEndpoint = 'http://127.0.0.1:8080/v1/audio/transcriptions',
  language = 'zh',
  prompt = ''
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
    body: formData
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
  language = 'zh',
  prompt = '',
  onProgress = null
}) {
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
      prompt,
      onProgress
    });
    return Array.isArray(res?.segments) ? res.segments : [];
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
      prompt
    });
    return Array.isArray(res?.segments) ? res.segments : [];
  }

  const res = await callWhisperApi({
    audioBlob: wavBlob,
    provider,
    apiKey,
    language,
    prompt
  });

  return Array.isArray(res?.segments) ? res.segments : (res?.text ? [{ start: 0, end: endT - inT, text: res.text }] : []);
}
