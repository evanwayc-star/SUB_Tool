import { afterEach, describe, expect, it, vi } from 'vitest';
import { SampleReader } from '../src/decode/demux.js';

function fixture() {
  const requests = [];
  vi.stubGlobal('fetch', vi.fn((url, options) => {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    requests.push({ options, reject, resolve: () => resolve(new Response(new Uint8Array(48).fill(7))) });
    return promise;
  }));
  const index = Array.from({ length: 240 }, (_, offset) => ({ offset, size: 1 }));
  return { reader: new SampleReader('video.mp4', index, 240), requests };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SampleReader byte-window ownership', () => {
  it.each([null, '8'])('Range 回應長度為 %s 時，超出視窗便取消串流，不讀取後續來源', async contentLength => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let pulls = 0;
    const cancel = vi.fn();
    const body = new ReadableStream({
      pull(controller) {
        if (++pulls <= 3) controller.enqueue(new Uint8Array(32).fill(9));
        else controller.close();
      }, cancel,
    }, { highWaterMark: 0 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      status: 200, headers: contentLength ? { 'content-length': contentLength } : {},
    })));
    const index = Array.from({ length: 240 }, (_, offset) => ({ offset, size: 1 }));
    const reader = new SampleReader('unbounded-source.mp4', index, 240);
    try {
      reader.ensure(0);
      await vi.waitFor(() => expect(reader.failure(0)).toBeInstanceOf(Error));
      expect(reader.data(0)).toBeNull();
      expect(pulls).toBe(2);
      expect(cancel).toHaveBeenCalledOnce();
    } finally { reader.dispose(); }
  });

  it('HTTP 200 且無長度或 Content-Range 的合法視窗仍按實際 bytes 解碼', async () => {
    const bytes = new Uint8Array(48).map((_, index) => index);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(bytes.subarray(0, 7)); controller.enqueue(bytes.subarray(7)); controller.close(); },
    }), { status: 200 })));
    const index = Array.from({ length: 240 }, (_, offset) => ({ offset, size: 1 }));
    const reader = new SampleReader('file-style-range.mp4', index, 240);
    try {
      reader.ensure(20);
      await vi.waitFor(() => expect(reader.data(20)).toEqual(new Uint8Array([20])));
      expect(reader.failure(20)).toBeNull();
    } finally { reader.dispose(); }
  });

  it('重複確保同一視窗只讀一次，完成後取得對應樣本位元組', async () => {
    const { reader, requests } = fixture();
    reader.ensure(0);
    reader.ensure(20);
    expect(requests).toHaveLength(1);
    requests[0].resolve();
    await vi.waitFor(() => expect(reader.data(20)).toEqual(new Uint8Array([7])));
    reader.dispose();
  });

  it('已淘汰的舊讀取失敗不會移除重抓後已就緒的新視窗', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { reader, requests } = fixture();
    for (const i of [0, 48, 96, 144, 192, 0]) reader.ensure(i);
    requests[5].resolve();
    await vi.waitFor(() => expect(reader.data(0)).toEqual(new Uint8Array([7])));
    requests[0].reject(new Error('old network request failed'));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(reader.data(0)).toEqual(new Uint8Array([7]));
    expect(reader.failure(0)).toBeNull();
    expect(warning).not.toHaveBeenCalled();
    reader.dispose();
  });

  it('淘汰與卸載會取消不再需要的 IO，卸載後不再讀取', () => {
    const { reader, requests } = fixture();
    for (const i of [0, 48, 96, 144, 192]) reader.ensure(i);
    expect(requests[0].options.signal?.aborted).toBe(true);
    expect(requests[4].options.signal?.aborted).toBe(false);

    reader.dispose();
    expect(requests.every(request => request.options.signal?.aborted)).toBe(true);
    reader.ensure(0);
    expect(requests).toHaveLength(5);
    expect(reader.data(0)).toBeNull();
  });

  it('目前視窗真正失敗後仍可重試', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { reader, requests } = fixture();
    reader.ensure(0);
    const error=new Error('network failure');
    requests[0].reject(error);
    await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
    expect(reader.failure(20)).toBe(error);
    expect(reader.failure(48)).toBeNull();
    reader.ensure(0);
    expect(requests).toHaveLength(2);
    expect(reader.failure(20)).toBe(error);
    requests[1].resolve();
    await vi.waitFor(() => expect(reader.data(0)).toEqual(new Uint8Array([7])));
    expect(reader.failure(20)).toBeNull();
    reader.dispose();
    expect(reader.failure(20)).toBeNull();
  });
});
