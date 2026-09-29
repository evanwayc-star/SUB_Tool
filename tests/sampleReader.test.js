import { afterEach, describe, expect, it, vi } from 'vitest';
import { SampleReader } from '../src/decode/demux.js';

function fixture() {
  const requests = [];
  vi.stubGlobal('fetch', vi.fn((url, options) => {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    requests.push({ options, reject, resolve: () => resolve({
      ok: true,
      arrayBuffer: async () => new Uint8Array(48).fill(7).buffer,
    }) });
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
    requests[0].reject(new Error('network failure'));
    await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
    reader.ensure(0);
    expect(requests).toHaveLength(2);
    requests[1].resolve();
    await vi.waitFor(() => expect(reader.data(0)).toEqual(new Uint8Array([7])));
    reader.dispose();
  });
});
