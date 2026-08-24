import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BuiltinAsrWorkerClient } from '../src/speech-recognition-worker-client.js';

class FakeWorker {
  constructor() {
    this.listeners = new Map();
    this.postMessage = vi.fn();
    this.terminate = vi.fn();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emitMessage(data) {
    for (const listener of this.listeners.get('message') || []) listener({ data });
  }

  emitError(message) {
    for (const listener of this.listeners.get('error') || []) listener({ message });
  }
}

describe('本機 ASR Worker client', () => {
  let workers;
  let createWorker;

  beforeEach(() => {
    workers = [];
    createWorker = vi.fn(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
  });

  it('把音訊交給獨立 Worker，轉送真實進度並保留 Worker 供下次重用', async () => {
    const client = new BuiltinAsrWorkerClient({ createWorker });
    const onProgress = vi.fn();
    const audioFloat32 = new Float32Array([0.1, 0.2, 0.3, 0.4]);

    const pending = client.transcribe({
      audioFloat32,
      modelId: 'onnx-community/whisper-small',
      webgpuDtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
      wasmDtype: 'q8',
      language: 'zh',
      onProgress
    });

    expect(createWorker).toHaveBeenCalledTimes(1);
    const worker = workers[0];
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    const [request, transfer] = worker.postMessage.mock.calls[0];
    expect(request).toMatchObject({
      type: 'transcribe',
      modelId: 'onnx-community/whisper-small',
      webgpuDtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
      wasmDtype: 'q8',
      language: 'zh'
    });
    expect(request.audioFloat32).toBe(audioFloat32);
    expect(transfer).toEqual([audioFloat32.buffer]);

    worker.emitMessage({
      type: 'progress',
      jobId: request.jobId,
      progress: { status: 'transcribing', percent: 50, completedChunks: 1, totalChunks: 2 }
    });
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ percent: 50 }));

    const segments = [{ start: 0, end: 1, text: '測試字幕' }];
    worker.emitMessage({ type: 'result', jobId: request.jobId, segments });
    await expect(pending).resolves.toEqual({ segments });
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('AbortSignal 會立即 terminate 推論 Worker，並讓下次工作使用全新 Worker', async () => {
    const client = new BuiltinAsrWorkerClient({ createWorker });
    const controller = new AbortController();
    const pending = client.transcribe({
      audioFloat32: new Float32Array([0.1, 0.2]),
      signal: controller.signal
    });
    const firstWorker = workers[0];

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(firstWorker.terminate).toHaveBeenCalledTimes(1);

    const secondPending = client.transcribe({ audioFloat32: new Float32Array([0.3, 0.4]) });
    expect(createWorker).toHaveBeenCalledTimes(2);
    const secondWorker = workers[1];
    const secondRequest = secondWorker.postMessage.mock.calls[0][0];

    firstWorker.emitMessage({
      type: 'result',
      jobId: firstWorker.postMessage.mock.calls[0][0].jobId,
      segments: [{ start: 0, end: 1, text: '晚到的舊結果' }]
    });
    secondWorker.emitMessage({ type: 'result', jobId: secondRequest.jobId, segments: [] });
    await expect(secondPending).resolves.toEqual({ segments: [] });
  });

  it('Worker runtime 錯誤會拒絕工作，但不會被誤報成取消', async () => {
    const client = new BuiltinAsrWorkerClient({ createWorker });
    const pending = client.transcribe({ audioFloat32: new Float32Array([0.1]) });
    const worker = workers[0];

    worker.emitError('WebGPU device lost');

    await expect(pending).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringContaining('WebGPU device lost')
    });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
