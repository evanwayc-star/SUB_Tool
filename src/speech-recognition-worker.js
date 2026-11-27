/* ============================================================================
   SUB Tool — Built-in speech recognition Worker
   ============================================================================
   Transformers.js 的 WebGPU／WASM 推論只在這個 Dedicated Worker 執行。
   主執行緒可用 worker.terminate() 真正停止工作；正常完成則保留 Worker 與模型快取。
   ============================================================================ */
import {
  buildBuiltinGenerationOptions,
  countBuiltinInferenceChunks,
  createBuiltinChunkProgressStreamer,
  detectBuiltinSpeechLanguage,
  resolveBuiltinExecutionPlan,
  transcribeBuiltinSegments
} from './speech-recognition-worker-runtime.js';

const TRANSFORMERS_MODULE_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3';

let transformersModule = null;
let cachedTranscriber = null;
let cachedPipelineKey = null;
let cachedExecutionPlan = null;

function postProgress(jobId, progress) {
  self.postMessage({ type: 'progress', jobId, progress });
}

function serializableDownloadProgress(progress = {}) {
  return {
    status: progress.status,
    name: progress.name,
    file: progress.file,
    progress: progress.progress,
    loaded: progress.loaded,
    total: progress.total
  };
}

async function getTransformersModule() {
  if (!transformersModule) {
    transformersModule = await import(/* @vite-ignore */ TRANSFORMERS_MODULE_URL);
    transformersModule.env.allowLocalModels = false;
    transformersModule.env.useBrowserCache = true;
  }
  return transformersModule;
}

async function loadTranscriber({ jobId, modelId, modelName, webgpuDtype, wasmDtype }) {
  const { pipeline } = await getTransformersModule();
  const gpuPlan = resolveBuiltinExecutionPlan({
    hasWebGpu: true,
    webgpuDtype,
    wasmDtype
  });
  const fallbackPlan = resolveBuiltinExecutionPlan({
    hasWebGpu: false,
    webgpuDtype,
    wasmDtype
  });
  const keyFor = plan => JSON.stringify({ modelId, ...plan });
  if (cachedTranscriber && (
    cachedPipelineKey === keyFor(gpuPlan) || cachedPipelineKey === keyFor(fallbackPlan)
  )) {
    return { transcriber: cachedTranscriber, executionPlan: cachedExecutionPlan };
  }

  postProgress(jobId, {
    status: 'loading',
    message: `正在載入 ${modelName} 模型檔案…`
  });

  if (cachedTranscriber?.dispose) await cachedTranscriber.dispose();
  cachedTranscriber = null;
  cachedPipelineKey = null;
  cachedExecutionPlan = null;
  // Chromium can expose navigator.gpu even when this worker has no usable adapter.
  let adapter;
  try { adapter = await self.navigator?.gpu?.requestAdapter(); } catch { /* Use WASM. */ }
  const preferredPlan = adapter ? gpuPlan : fallbackPlan;
  let executionPlan = preferredPlan;
  try {
    cachedTranscriber = await pipeline('automatic-speech-recognition', modelId, {
      device: preferredPlan.device,
      dtype: preferredPlan.dtype,
      progress_callback: progress => postProgress(jobId, serializableDownloadProgress(progress))
    });
  } catch (error) {
    if (preferredPlan.device === 'wasm') throw error;
    postProgress(jobId, {
      status: 'fallback',
      message: 'WebGPU 無法啟動，切換至 CPU (WASM q8) 模式…'
    });
    executionPlan = fallbackPlan;
    cachedTranscriber = await pipeline('automatic-speech-recognition', modelId, {
      device: fallbackPlan.device,
      dtype: fallbackPlan.dtype,
      progress_callback: progress => postProgress(jobId, serializableDownloadProgress(progress))
    });
  }

  cachedPipelineKey = keyFor(executionPlan);
  cachedExecutionPlan = executionPlan;
  postProgress(jobId, {
    status: 'ready',
    device: executionPlan.device,
    message: executionPlan.device === 'webgpu'
      ? 'WebGPU GPU 加速已啟用。'
      : '目前使用 CPU (WASM q8)；辨識速度會較慢。'
  });
  return { transcriber: cachedTranscriber, executionPlan };
}

async function transcribe({
  jobId,
  audioFloat32,
  taskMode,
  modelId,
  modelName,
  webgpuDtype,
  wasmDtype,
  returnTimestamps = 'word',
  language,
  prompt,
  temperature = 0
}) {
  if (!(audioFloat32 instanceof Float32Array) || audioFloat32.length === 0) {
    throw new Error('音訊長度為 0，無法進行辨識');
  }

  const { transcriber, executionPlan } = await loadTranscriber({
    jobId,
    modelId,
    modelName,
    webgpuDtype,
    wasmDtype
  });
  const totalChunks = countBuiltinInferenceChunks(audioFloat32.length);
  const backendLabel = executionPlan.device === 'webgpu' ? 'GPU' : 'CPU';
  postProgress(jobId, {
    status: 'transcribing',
    indeterminate: true,
    completedChunks: 0,
    totalChunks,
    device: executionPlan.device,
    message: `本機 AI（${backendLabel}）正在準備第 1/${totalChunks} 段音訊…`
  });

  const newStreamer = () => createBuiltinChunkProgressStreamer({
    totalChunks,
    onProgress: progress => {
      let message;
      if (progress.phase === 'decoding') {
        const elapsedSeconds = Math.max(0, Math.round(progress.chunkElapsedMs / 1000));
        message = `本機 AI（${backendLabel}）正在辨識第 ${progress.activeChunk}/${progress.totalChunks} 段`;
        message += `（已解碼 ${progress.decodedTokens} token，${elapsedSeconds} 秒）…`;
      } else if (progress.completedChunks < progress.totalChunks) {
        message = `本機 AI（${backendLabel}）已完成 ${progress.completedChunks}/${progress.totalChunks} 段`;
        message += `，準備第 ${progress.completedChunks + 1}/${progress.totalChunks} 段…`;
      } else {
        message = `本機 AI（${backendLabel}）已完成 ${progress.completedChunks}/${progress.totalChunks} 段，正在整理時間碼…`;
      }
      postProgress(jobId, {
        status: 'transcribing',
        ...progress,
        device: executionPlan.device,
        indeterminate: progress.completedChunks === 0,
        message
      });
    }
  });
  const editorTask = taskMode === 'transcribe' || taskMode === 'align';
  if (editorTask && (!language || language === 'auto')) {
    postProgress(jobId, { status: 'transcribing', indeterminate: true, message: '正在從音訊偵測語言…' });
    language = await detectBuiltinSpeechLanguage(transcriber, audioFloat32, (await getTransformersModule()).Tensor);
    if (!language) {
      postProgress(jobId, { status: 'done', percent: 100, message: '所選音訊為靜音。' });
      return { segments: [] };
    }
  }
  const generateKwargs = buildBuiltinGenerationOptions({
    language,
    prompt,
    temperature,
    streamer: newStreamer(),
    returnTimestamps
  });

  const segments = await transcribeBuiltinSegments(transcriber, audioFloat32, generateKwargs, () => {
    postProgress(jobId, {
      status: 'transcribing',
      device: executionPlan.device,
      message: '模型未提供完整的逐詞時間，正在取得原生句級時間碼…'
    });
    return newStreamer();
  });
  postProgress(jobId, { status: 'done', percent: 100, message: '本機辨識完成！' });
  return { segments, language };
}

self.addEventListener('message', async event => {
  const request = event?.data || {};
  if (request.type !== 'transcribe') return;
  try {
    const result = await transcribe(request);
    self.postMessage({ type: 'result', jobId: request.jobId, ...result });
  } catch (error) {
    self.postMessage({
      type: 'error',
      jobId: request.jobId,
      error: {
        name: error?.name || 'Error',
        message: error?.message || String(error),
        stack: error?.stack || ''
      }
    });
  }
});
