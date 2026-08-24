import BuiltinAsrWorker from './speech-recognition-worker.js?worker&inline';

function createAbortError() {
  if (typeof DOMException === 'function') {
    return new DOMException('語音辨識已取消', 'AbortError');
  }
  const error = new Error('語音辨識已取消');
  error.name = 'AbortError';
  return error;
}

function createWorkerError(payload = {}) {
  const error = new Error(payload.message || '本機語音辨識 Worker 發生錯誤');
  error.name = payload.name || 'Error';
  if (payload.stack) error.stack = payload.stack;
  return error;
}

/**
 * 管理可重用的本機 ASR Worker。正常完成後保留已載入模型；取消或錯誤時終止整個
 * Worker，確保 WebGPU／WASM 推論真的停止，而不是只把結果丟棄。
 */
export class BuiltinAsrWorkerClient {
  constructor({ createWorker = () => new BuiltinAsrWorker({ name: 'subtool-builtin-asr' }) } = {}) {
    this.createWorker = createWorker;
    this.worker = null;
    this.pendingJob = null;
    this.nextJobId = 1;
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.addEventListener('message', event => this.handleMessage(worker, event));
    worker.addEventListener('error', event => this.handleWorkerError(worker, event));
    this.worker = worker;
    return worker;
  }

  transcribe({
    audioFloat32,
    modelId = 'onnx-community/whisper-base',
    modelName = 'Whisper Base',
    webgpuDtype = 'fp32',
    wasmDtype = 'q8',
    language = 'zh',
    prompt = '',
    onProgress = null,
    signal = null
  }) {
    if (!(audioFloat32 instanceof Float32Array) || audioFloat32.length === 0) {
      return Promise.reject(new Error('音訊長度為 0，無法進行辨識'));
    }
    if (signal?.aborted) return Promise.reject(createAbortError());
    if (this.pendingJob) {
      return Promise.reject(new Error('已有本機語音辨識工作正在執行'));
    }

    const worker = this.ensureWorker();
    const jobId = this.nextJobId++;

    return new Promise((resolve, reject) => {
      const job = {
        id: jobId,
        worker,
        resolve,
        reject,
        onProgress,
        signal,
        onAbort: null
      };
      job.onAbort = () => {
        if (this.pendingJob !== job) return;
        this.pendingJob = null;
        this.terminateWorker(worker);
        reject(createAbortError());
      };
      this.pendingJob = job;
      signal?.addEventListener('abort', job.onAbort, { once: true });

      try {
        worker.postMessage({
          type: 'transcribe',
          jobId,
          audioFloat32,
          modelId,
          modelName,
          webgpuDtype,
          wasmDtype,
          language,
          prompt
        }, [audioFloat32.buffer]);
      } catch (error) {
        this.finishJob(job, { error });
      }
    });
  }

  handleMessage(worker, event) {
    if (worker !== this.worker) return;
    const message = event?.data || {};
    const job = this.pendingJob;
    if (!job || job.worker !== worker || message.jobId !== job.id) return;

    if (message.type === 'progress') {
      if (!job.signal?.aborted) job.onProgress?.(message.progress || {});
      return;
    }
    if (message.type === 'result') {
      this.finishJob(job, { value: { segments: Array.isArray(message.segments) ? message.segments : [] } });
      return;
    }
    if (message.type === 'error') {
      const error = createWorkerError(message.error);
      this.terminateWorker(worker);
      this.finishJob(job, { error });
    }
  }

  handleWorkerError(worker, event) {
    if (worker !== this.worker) return;
    const job = this.pendingJob;
    this.terminateWorker(worker);
    if (!job) return;
    this.finishJob(job, {
      error: new Error(event?.message || '本機語音辨識 Worker 發生錯誤')
    });
  }

  finishJob(job, { value, error }) {
    if (this.pendingJob !== job) return;
    this.pendingJob = null;
    job.signal?.removeEventListener('abort', job.onAbort);
    if (error) job.reject(error);
    else job.resolve(value);
  }

  terminateWorker(worker = this.worker) {
    if (!worker) return;
    if (this.worker === worker) this.worker = null;
    worker.terminate();
  }
}

const builtinAsrWorkerClient = new BuiltinAsrWorkerClient();

export function transcribeBuiltinAudioInWorker(options) {
  return builtinAsrWorkerClient.transcribe(options);
}
