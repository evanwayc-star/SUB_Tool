import { beforeEach, describe, expect, it, vi } from 'vitest';

const workerMocks = vi.hoisted(() => ({
  transcribeBuiltinAudioInWorker: vi.fn()
}));

vi.mock('../src/speech-recognition-worker-client.js', () => workerMocks);

import { transcribeAudioStream } from '../src/speech-recognition-engine.js';

function createAudioBuffer(duration = 1) {
  const sampleRate = 48000;
  return {
    sampleRate,
    numberOfChannels: 1,
    length: sampleRate * duration,
    duration,
    getChannelData: () => new Float32Array(sampleRate * duration).fill(0.25)
  };
}

describe('語音辨識引擎取消接線', () => {
  beforeEach(() => {
    workerMocks.transcribeBuiltinAudioInWorker.mockReset();
  });

  it('統一本機入口會把同一 AbortSignal 傳到可終止的 Worker client', async () => {
    const controller = new AbortController();
    workerMocks.transcribeBuiltinAudioInWorker.mockResolvedValue({ segments: [] });

    await transcribeAudioStream({
      audioBuffer: createAudioBuffer(),
      provider: 'builtin',
      builtinModel: 'onnx-community/whisper-small',
      prompt: '本機不應收到的舊提示詞',
      signal: controller.signal
    });

    expect(workerMocks.transcribeBuiltinAudioInWorker).toHaveBeenCalledWith(expect.objectContaining({
      signal: controller.signal,
      prompt: '',
      modelId: 'onnx-community/whisper-small_timestamped',
      webgpuDtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
      wasmDtype: 'q8'
    }));
  });

  it('開始前已取消時不會建立本機推論工作', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(transcribeAudioStream({
      audioBuffer: createAudioBuffer(),
      provider: 'builtin',
      signal: controller.signal
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(workerMocks.transcribeBuiltinAudioInWorker).not.toHaveBeenCalled();
  });
});
