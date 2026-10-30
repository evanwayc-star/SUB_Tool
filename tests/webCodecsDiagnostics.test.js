import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrackDecoder, pocTest } from '../src/decode/diagnostics.js';

vi.mock('../src/decode/demux.js', () => ({
  demuxFile: vi.fn(async () => ({
    config: { codec: 'test-codec', codedWidth: 8, codedHeight: 4 },
    chunks: Array.from({ length: 4 }, (_, index) => ({ type: 'key', timestamp: index * 1e6, data: new Uint8Array([index]) })),
    info: { durationUs: 4e6 },
  })),
  demuxIndex: vi.fn(), SampleReader: class {},
}));

afterEach(() => vi.unstubAllGlobals());

function decoderAdapter({ configureError = null, decodeError = null, flushError = null } = {}) {
  const decoders = [], frames = [];
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('EncodedVideoChunk', class { constructor(data) { Object.assign(this, data); } });
  vi.stubGlobal('VideoDecoder', class {
    static async isConfigSupported() { return { supported: true }; }
    constructor({ output }) { this.output = output; this.close = vi.fn(); decoders.push(this); }
    configure() { if (configureError) throw configureError; }
    decode(chunk) {
      const frame = { timestamp: chunk.timestamp, close: vi.fn() };
      frames.push(frame); this.output(frame);
      if (decodeError) throw decodeError;
    }
    async flush() { if (flushError) throw flushError; }
  });
  return { decoders, frames };
}

const source = {
  config: { codec: 'test-codec' },
  chunks: [0, 1].map(index => ({ type: 'key', timestamp: index * 1e6, data: new Uint8Array([index]) })),
};

describe('WebCodecs 診斷失敗的資源所有權', () => {
  it('目前影片超過整檔 demux 預算時取消回應，不先讀入或啟動 decoder', async () => {
    const { decoders } = decoderAdapter();
    const cancel = vi.fn(); let pulls = 0;
    vi.stubGlobal('document', { getElementById: () => ({ currentSrc: 'large-current.mp4' }) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array([1])); controller.close(); }, cancel,
    }, { highWaterMark: 0 }), { headers: { 'content-length': String(1500 * 1024 * 1024 + 1) } })));
    await expect(pocTest(undefined, { noPreview: true })).rejects.toBeInstanceOf(RangeError);
    expect(fetch).toHaveBeenCalledWith('large-current.mp4');
    expect(pulls).toBe(0); expect(cancel).toHaveBeenCalledOnce();
    expect(decoders).toHaveLength(0);
  });

  it.each(['frameAt', 'decodeSeq'])('%s flush 失敗仍釋放已輸出畫格，晚到輸出也立即釋放', async method => {
    const error = new Error('decoder flush failed');
    const { decoders, frames } = decoderAdapter({ flushError: error });
    const decoder = new TrackDecoder();
    await decoder.init(source);
    try {
      await expect(decoder[method](0, 2)).rejects.toBe(error);
      for (const frame of frames) expect(frame.close).toHaveBeenCalledOnce();
      const late = { close: vi.fn() }; decoders[0].output(late);
      expect(late.close).toHaveBeenCalledOnce();
    } finally { decoder.close(); }
  });

  it('decode 同步失敗也釋放在錯誤前交出的畫格', async () => {
    const error = new Error('decode failed');
    const { frames } = decoderAdapter({ decodeError: error });
    const decoder = new TrackDecoder();
    await decoder.init(source);
    try {
      await expect(decoder.decodeSeq(0, 2)).rejects.toBe(error);
      expect(frames[0].close).toHaveBeenCalledOnce();
    } finally { decoder.close(); }
  });

  it('configure 失敗立即關閉已建立的 decoder', async () => {
    const error = new Error('configure failed');
    const { decoders } = decoderAdapter({ configureError: error });
    await expect(new TrackDecoder().init(source)).rejects.toBe(error);
    expect(decoders[0].close).toHaveBeenCalledOnce();
  });

  it('成功定位只交出最接近畫格，其餘關閉；順序測量不保留畫格', async () => {
    const { frames } = decoderAdapter();
    const decoder = new TrackDecoder();
    await decoder.init(source);
    try {
      const frame = await decoder.frameAt(0.8e6);
      expect(frame.timestamp).toBe(1e6);
      expect(frames[0].close).toHaveBeenCalledOnce();
      expect(frame.close).not.toHaveBeenCalled();
      frame.close();
      await expect(decoder.decodeSeq(0, 2)).resolves.toMatchObject({ frames: 2 });
      for (const item of frames) expect(item.close).toHaveBeenCalledOnce();
    } finally { decoder.close(); }
  });

  it('診斷畫布繪製失敗仍關閉選中的畫格與 decoder', async () => {
    const error = new Error('canvas unavailable');
    const { decoders, frames } = decoderAdapter();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))));
    vi.stubGlobal('document', { getElementById: () => null });
    const canvas = { getContext: () => ({ drawImage() { throw error; } }) };
    await expect(pocTest('source.mp4', { canvas })).rejects.toBe(error);
    expect(decoders[0].close).toHaveBeenCalledOnce();
    for (const frame of frames) expect(frame.close).toHaveBeenCalledOnce();
  });
});
