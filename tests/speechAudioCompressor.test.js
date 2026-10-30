import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  createSpeechAudioCompressor,
  createSpeechCompressionRuntime
} = require('../electron/speech-audio-compressor.js');

function createMono16kWav(durationSeconds = 1) {
  const dataBytes = durationSeconds * 16_000 * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16_000, 24);
  buffer.writeUInt32LE(32_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

function createHarness({ fail = false } = {}) {
  const files = new Map();
  let sequence = 0;
  const removeFile = vi.fn(async file => { files.delete(file); });
  const execute = vi.fn(async (args, options) => {
    if (fail) throw new Error('ffmpeg failed');
    files.set(args.at(-1), Buffer.from('small-mp3'));
    return options;
  });
  const compressor = createSpeechAudioCompressor({
    createTempPath: ext => `C:/temp/speech-${sequence++}.${ext}`,
    writeFile: async (file, bytes) => { files.set(file, Buffer.from(bytes)); },
    readFile: async file => files.get(file),
    removeFile,
    execute
  });
  return { compressor, execute, removeFile };
}

describe('辨識專用 MP3 暫存壓縮', () => {
  it('只接受 16kHz mono PCM WAV，轉成 64kbps MP3 並在回傳後清除兩個暫存檔', async () => {
    const { compressor, execute, removeFile } = createHarness();

    const result = await compressor.compress(createMono16kWav(1));

    expect(result).toEqual({
      b64: Buffer.from('small-mp3').toString('base64'),
      type: 'audio/mpeg',
      name: 'audio.mp3',
      size: 9
    });
    const [args, options] = execute.mock.calls[0];
    expect(args).toEqual(expect.arrayContaining([
      '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k'
    ]));
    expect(options).toEqual(expect.objectContaining({ duration: 1 }));
    expect(removeFile).toHaveBeenCalledTimes(2);
  });

  it('拒絕把任意 renderer bytes 當成可轉檔素材', async () => {
    const { compressor, execute } = createHarness();

    await expect(compressor.compress(Buffer.from('not-a-wave'))).rejects.toThrow(/WAV/);
    const inconsistentRiff = createMono16kWav(1);
    inconsistentRiff.writeUInt32LE(0, 4);
    await expect(compressor.compress(inconsistentRiff)).rejects.toThrow(/PCM16 WAV/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('ffmpeg 失敗時也會清除輸入與輸出暫存檔', async () => {
    const { compressor, removeFile } = createHarness({ fail: true });

    await expect(compressor.compress(createMono16kWav(1))).rejects.toThrow(/ffmpeg failed/);
    expect(removeFile).toHaveBeenCalledTimes(2);
  });

  it('取消 requestId 會終止正在壓縮的 ffmpeg，並在 Promise 收斂後移除工作', async () => {
    let rejectCompression;
    const child = {
      killed: false,
      kill: vi.fn(() => {
        child.killed = true;
        rejectCompression(new Error('ffmpeg cancelled'));
      })
    };
    const compressor = {
      compress: vi.fn((bytes, { onProcess }) => new Promise((resolve, reject) => {
        rejectCompression = reject;
        onProcess(child);
      }))
    };
    const runtime = createSpeechCompressionRuntime({ compressor });
    const resultPromise = runtime.compress(createMono16kWav(1), 'speech-test-cancel');
    await vi.waitFor(() => expect(compressor.compress).toHaveBeenCalledTimes(1));

    expect(runtime.cancel('speech-test-cancel')).toBe(true);
    await expect(resultPromise).rejects.toThrow(/cancelled/);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(runtime.activeCount()).toBe(0);
  });

  it('關閉程式時會取消所有辨識壓縮並等待它們收斂', async () => {
    let rejectCompression;
    const child = {
      killed: false,
      kill: vi.fn(() => {
        child.killed = true;
        rejectCompression(new Error('shutdown'));
      })
    };
    const runtime = createSpeechCompressionRuntime({
      compressor: {
        compress: (bytes, { onProcess }) => new Promise((resolve, reject) => {
          rejectCompression = reject;
          onProcess(child);
        })
      }
    });
    const resultPromise = runtime.compress(createMono16kWav(1), 'speech-test-shutdown');
    resultPromise.catch(() => {});
    await vi.waitFor(() => expect(runtime.activeCount()).toBe(1));

    await runtime.cancelAllAndWait();

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(runtime.activeCount()).toBe(0);
  });

  it('呼叫後立即取消，不啟動尚未開始的壓縮', async () => {
    const compressor = { compress: vi.fn().mockResolvedValue({ b64: 'late' }) };
    const runtime = createSpeechCompressionRuntime({ compressor });
    const outcome = runtime.compress(createMono16kWav(), 'speech-before-start');

    expect(runtime.cancel('speech-before-start')).toBe(true);

    await expect(outcome).rejects.toMatchObject({ name: 'AbortError' });
    expect(compressor.compress).not.toHaveBeenCalled();
    expect(runtime.activeCount()).toBe(0);
  });

  it('native 完成後讀取 MP3 期間取消，也拒絕晚到結果並等待暫存清理', async () => {
    let releaseRead, beginRead;
    const readGate = new Promise(resolve => { releaseRead = resolve; });
    const reading = new Promise(resolve => { beginRead = resolve; });
    const removeFile = vi.fn().mockResolvedValue(undefined);
    const runtime = createSpeechCompressionRuntime({ compressor: createSpeechAudioCompressor({
      createTempPath: extension => `speech-cancel-output.${extension}`,
      writeFile: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn().mockResolvedValue(undefined),
      readFile: async () => { beginRead(); await readGate; return Buffer.from('encoded mp3'); },
      removeFile,
    }) });
    const outcome = runtime.compress(createMono16kWav(), 'speech-during-read');
    await reading;
    expect(runtime.cancel('speech-during-read')).toBe(true);
    expect(runtime.activeCount()).toBe(1);
    expect(removeFile).not.toHaveBeenCalled();
    releaseRead();

    await expect(outcome).rejects.toMatchObject({ name: 'AbortError' });
    expect(removeFile).toHaveBeenCalledTimes(2);
    expect(runtime.activeCount()).toBe(0);
  });

  it('shutdown 封閉准入，取消退出也等舊工作清理後才恢復', async () => {
    let finishCompression;
    const compressor = { compress: vi.fn(() => new Promise(resolve => { finishCompression = resolve; })) };
    const runtime = createSpeechCompressionRuntime({ compressor });
    const outcome = runtime.compress(createMono16kWav(), 'speech-shutdown-owner').catch(error => error);
    await vi.waitFor(() => expect(compressor.compress).toHaveBeenCalledOnce());
    const closing = runtime.cancelAllAndWait();
    await expect(runtime.compress(createMono16kWav(), 'speech-shutdown-new')).rejects.toMatchObject({ name: 'AbortError' });
    expect(runtime.resume()).toBe(false);
    await expect(runtime.compress(createMono16kWav(), 'speech-shutdown-resume')).rejects.toMatchObject({ name: 'AbortError' });
    expect(compressor.compress).toHaveBeenCalledOnce();

    finishCompression({ b64: 'late' });
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    await closing;
    compressor.compress.mockResolvedValueOnce({ b64: 'current' });
    await expect(runtime.compress(createMono16kWav(), 'speech-after-resume')).resolves.toEqual({ b64: 'current' });
  });
});
