import { afterEach, describe, expect, it, vi } from 'vitest';
import { webmPresentationMetadata } from '../src/decode/webm-metadata.js';

afterEach(() => vi.unstubAllGlobals());

function element(id, contents) {
  return [...id, 0x80 | contents.length, ...contents];
}

function movie() {
  const duration = new Uint8Array(8);
  new DataView(duration.buffer).setFloat64(0, 2000);
  return new Uint8Array([
    ...element([0x1a, 0x45, 0xdf, 0xa3], []),
    ...element([0x18, 0x53, 0x80, 0x67], [
      ...element([0x15, 0x49, 0xa9, 0x66], [
        ...element([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]),
        ...element([0x44, 0x89], [...duration]),
      ]),
      ...element([0x16, 0x54, 0xae, 0x6b], element([0xae], [
        ...element([0xd7], [1]), ...element([0x83], [1]),
      ])),
      ...element([0x1f, 0x43, 0xb6, 0x75], [
        ...element([0xe7], [0x03, 0xe8]),
        ...element([0xa3], [0x81, 0x01, 0xf4, 0x80, 0]),
      ]),
    ]),
  ]);
}

describe('WebM metadata 的有界回應讀取', () => {
  it.each([null, '1'])('長度標頭 %s 不能讓忽略 Range 的回應整檔載入', async length => {
    let pulls = 0;
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      pull(controller) {
        if (++pulls <= 8) controller.enqueue(new Uint8Array(8));
        else controller.close();
      }, cancel,
    }, { highWaterMark: 0 }), { headers: length ? { 'content-length': length } : {} })));

    await expect(webmPresentationMetadata('source.webm')).rejects.toThrow();
    expect(pulls).toBe(3);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('合法分段回應仍回報實際首格原點與來源片長', async () => {
    const bytes = movie();
    vi.stubGlobal('fetch', vi.fn(async (url, { headers }) => {
      const end = Number(/bytes=0-(\d+)/.exec(headers.Range)[1]) + 1;
      return new Response(new ReadableStream({
        start(controller) {
          const selected = bytes.subarray(0, end);
          controller.enqueue(selected.subarray(0, 7));
          controller.enqueue(selected.subarray(7));
          controller.close();
        },
      }));
    }));

    await expect(webmPresentationMetadata('source.webm')).resolves.toEqual({
      presentationTimestampOffset: -1.5, duration: 0.5,
    });
    expect(fetch.mock.calls.map(([, { headers }]) => headers.Range)).toEqual(['bytes=0-15', 'bytes=0-1048575']);
  });
});
