import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadPreloadSpeechBridge() {
  const source = fs.readFileSync(path.resolve('electron/preload.js'), 'utf8');
  const invoke = vi.fn().mockResolvedValue({});
  let api = null;
  const electron = {
    contextBridge: {
      exposeInMainWorld: (name, exposed) => {
        if (name === 'subtool') api = exposed;
      }
    },
    ipcRenderer: { invoke, on: vi.fn(), send: vi.fn() },
    webUtils: { getPathForFile: vi.fn() }
  };
  vm.runInNewContext(source, {
    require: name => {
      if (name === 'electron') return electron;
      throw new Error(`unexpected preload require: ${name}`);
    },
    ArrayBuffer,
    Uint8Array,
    Promise,
    TypeError,
    RangeError
  });
  return { api, invoke };
}

describe('辨識壓縮 preload 邊界', () => {
  it('超過 20 MB 時在 structured clone 前拒絕，不呼叫 main IPC', () => {
    const { api, invoke } = loadPreloadSpeechBridge();

    expect(() => api.compressSpeechAudio(
      new Uint8Array(20_000_001),
      'speech-test-oversize'
    )).toThrow(/20,000,000/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('受限 bytes 與 requestId 才能送出，取消使用獨立 IPC', async () => {
    const { api, invoke } = loadPreloadSpeechBridge();
    const bytes = new Uint8Array(44);

    await api.compressSpeechAudio(bytes, 'speech-test-valid');
    await api.cancelSpeechAudioCompression('speech-test-valid');

    expect(invoke).toHaveBeenNthCalledWith(1, 'speech:compressAudio', {
      bytes,
      requestId: 'speech-test-valid'
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'speech:cancelCompression', {
      requestId: 'speech-test-valid'
    });
  });
});
