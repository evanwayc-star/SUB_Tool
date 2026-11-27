// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { capturePlayheadOcrCanvas, capturePlayheadOcrFrame, encodePlayheadOcrRegion } from '../src/playhead-ocr-frame.js';

const setup = vi.hoisted(() => ({
  media: { captureMediaOwnership: vi.fn(), displayTime: vi.fn(), seek: vi.fn(),
    webCodecsTakeover: vi.fn(), mpvPresenting: vi.fn() },
  adapter: {}, pause: vi.fn(), capture: vi.fn(), release: vi.fn(),
}));
vi.mock('../src/media.js', () => ({ Media: setup.media }));
vi.mock('../src/state.js', () => ({ State: { duration: 12, fps: 25, dropFrame: false } }));
vi.mock('../src/media-player-adapter.js', () => ({ getPlayerAdapter: () => setup.adapter }));
vi.mock('../src/transport-controller.js', () => ({ pauseForPointerSeek: setup.pause }));
vi.mock('../src/video-renderer.js', () => ({ capturePreviewFrame: setup.capture }));
vi.mock('../src/decode/player.js', () => ({ reserveProjectFrame: () => ({ take: vi.fn(), release: setup.release }) }));

let source, encoded, draw;
beforeEach(() => {
  vi.resetAllMocks();
  setup.media.captureMediaOwnership.mockReturnValue(() => true);
  setup.media.displayTime.mockReturnValue(1.057);
  setup.media.mpvPresenting.mockReturnValue(false);
  setup.media.webCodecsTakeover.mockReturnValue(false);
  setup.media.seek.mockImplementation(async (time, { whilePresented }) => ({
    status: 'presented', requestedTime: time, value: await whilePresented({ source: 'html5', isCurrent: () => true }),
  }));
  source = document.createElement('canvas');
  source.width = 3840; source.height = 2160;
  setup.capture.mockResolvedValue({ canvas: source });
  draw = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw });
  encoded = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function(callback, type) {
    expect(type).toBe('image/png');
    callback({ arrayBuffer: async () => Uint8Array.from([137, 80, 78, 71]).buffer });
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('pauses synchronously, returns the frozen project time, and preserves all UHD pixels', async () => {
  const capture = capturePlayheadOcrFrame();
  expect(setup.pause).toHaveBeenCalledOnce();
  expect(setup.media.seek.mock.calls[0][0]).toBe(1.04);
  await expect(capture).resolves.toEqual({ time: 1.04, pngBase64: 'iVBORw==' });
  expect(encoded.mock.instances[0]).toBe(source);
  expect(draw).not.toHaveBeenCalled();
  expect(setup.release).toHaveBeenCalledOnce();
});

it('releases the reserved decoded layers when seeking fails', async () => {
  setup.media.seek.mockRejectedValue(new Error('影片讀取失敗'));
  await expect(capturePlayheadOcrCanvas()).rejects.toThrow('影片讀取失敗');
  expect(setup.release).toHaveBeenCalledOnce();
});

it.each([[7680, 4320], [32768, 240], [1, 32768]])('fits %i by %i into the native dimensions and PNG byte budget', async (width, height) => {
  source.width = width; source.height = height;
  await capturePlayheadOcrFrame();
  const resized = encoded.mock.instances[0];
  expect(resized.width * resized.height).toBeLessThanOrEqual(12_000_000);
  expect(Math.max(resized.width, resized.height)).toBeLessThanOrEqual(16384);
  const scale = Math.min(1, 16384 / width, 16384 / height, Math.sqrt(12_000_000 / (width * height)));
  expect(resized.width).toBe(Math.max(1, Math.floor(width * scale)));
  expect(resized.height).toBe(Math.max(1, Math.floor(height * scale)));
  expect(draw).toHaveBeenCalledWith(source, 0, 0, width, height, 0, 0, resized.width, resized.height);
});

it('hands the full frozen 8K canvas to the selector and encodes only the chosen pixels', async () => {
  source.width = 7680; source.height = 4320;
  const frame = await capturePlayheadOcrCanvas();
  expect(frame).toEqual({ time: 1.04, canvas: source });
  expect(encoded).not.toHaveBeenCalled();
  expect(draw).not.toHaveBeenCalled();

  const rect = { x: 5500, y: 3400, width: 1400, height: 450 };
  await expect(encodePlayheadOcrRegion(frame.canvas, rect)).resolves.toBe('iVBORw==');
  const selection = encoded.mock.instances[0];
  expect([selection.width, selection.height]).toEqual([1400, 450]);
  expect(draw).toHaveBeenCalledWith(source, 5500, 3400, 1400, 450, 0, 0, 1400, 450);
  expect([source.width, source.height]).toEqual([7680, 4320]);
});

it('applies the PNG size limit to a large selection and accepts a final one-pixel corner', async () => {
  source.width = 7680; source.height = 4320;
  await encodePlayheadOcrRegion(source, { x: 600, y: 100, width: 6000, height: 4000 });
  const reduced = encoded.mock.instances[0];
  expect([reduced.width, reduced.height]).toEqual([4242, 2828]);
  expect(draw).toHaveBeenCalledWith(source, 600, 100, 6000, 4000, 0, 0, 4242, 2828);
  await encodePlayheadOcrRegion(source, { x: 7679, y: 4319, width: 1, height: 1 });
  expect(draw).toHaveBeenLastCalledWith(source, 7679, 4319, 1, 1, 0, 0, 1, 1);
});

it('treats an emptied mask as empty, and rejects a malformed piece before reading any pixels', async () => {
  await expect(encodePlayheadOcrRegion(source, [])).rejects.toThrow(RangeError);
  await expect(encodePlayheadOcrRegion(source, [{ x: 1, y: 2, width: 4, height: 8 }, null])).rejects.toThrow(RangeError);
  expect(draw).not.toHaveBeenCalled();
  expect(encoded).not.toHaveBeenCalled();
});

it('copies only the selected spans of a punched rectangle, preserving their half-open edges', async () => {
  const context = { drawImage: draw, fillRect: vi.fn(), getImageData: () => ({
    data: Uint8ClampedArray.of(32,32,32,255, 0,0,0,0, 255,255,255,255, 32,32,32,255),
  }) };
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(context);
  const mask = [[2,4,7,2], [2,6,2,2], [7,6,2,2], [2,8,7,1]].map(([x,y,width,height]) => ({x,y,width,height}));
  await encodePlayheadOcrRegion(source, mask);
  const page = encoded.mock.instances[0];
  expect([page.width, page.height]).toEqual([7,5]);
  expect(draw.mock.calls.filter(args => args[0] === source).map(args => args.slice(1))).toEqual([
    [2,4,7,2,0,0,7,2], [2,6,2,2,0,2,2,2], [7,6,2,2,5,2,2,2], [2,8,7,1,0,4,7,1],
  ]);
  expect(context.fillStyle).toBe('rgb(32, 32, 32)');
});

it('isolates each source rectangle before filtering a large mask and releases the bitmap when cancelled', async () => {
  source.width = 7680; source.height = 4320;
  const owner = new AbortController();
  let finish;
  const bitmap = { close: vi.fn() };
  const crop = vi.fn(() => new Promise(done => { finish = () => done(bitmap); }));
  vi.stubGlobal('createImageBitmap', crop);
  const work = encodePlayheadOcrRegion(source, [
    { x: 0, y: 0, width: 7680, height: 2000 }, { x: 0, y: 4000, width: 7680, height: 320 },
  ], { signal: owner.signal });
  expect(crop).toHaveBeenCalledWith(source, 0, 0, 7680, 2000,
    { resizeWidth: 4618, resizeHeight: 1203, resizeQuality: 'high' });
  owner.abort(); finish();
  await expect(work).rejects.toMatchObject({ name: 'AbortError' });
  expect(crop).toHaveBeenCalledOnce();
  expect(bitmap.close).toHaveBeenCalledOnce();
  expect(encoded).not.toHaveBeenCalled();
});

it.each([[-1,0,5,1], [0,0,0,1], [0,.5,2,1], [3839,2159,2,1], [0,2159,1,2], [0,0,Infinity,1]])
  ('rejects the out-of-bounds or invalid selection %i,%i %i by %i', async (x, y, width, height) => {
    await expect(encodePlayheadOcrRegion(source, { x, y, width, height })).rejects.toThrow(RangeError);
    expect(draw).not.toHaveBeenCalled();
    expect(encoded).not.toHaveBeenCalled();
  });

it.each(['before', 'png', 'bytes'])('cancelling %s encoding discards unfinished output', async stage => {
  const owner = new AbortController();
  if (stage === 'before') owner.abort();
  let finishPng, finishBytes;
  const arrayBuffer = vi.fn(() => new Promise(done => { finishBytes = done; }));
  encoded.mockImplementation(callback => { finishPng = () => callback({ arrayBuffer }); });
  const result = encodePlayheadOcrRegion(source, null, { signal: owner.signal });
  if (stage !== 'before') await Promise.resolve();
  if (stage === 'bytes') {
    finishPng();
    await Promise.resolve();
    expect(arrayBuffer).toHaveBeenCalledOnce();
  }
  owner.abort();
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  if (stage === 'before') expect(encoded).not.toHaveBeenCalled();
  if (stage === 'png') {
    finishPng();
    await Promise.resolve();
    expect(arrayBuffer).not.toHaveBeenCalled();
  }
  if (stage === 'bytes') finishBytes(new ArrayBuffer(4));
});

it('isolates bright neutral subtitle strokes on a separate canvas and leaves ordinary color selections intact', async () => {
  source.width = 5; source.height = 1;
  const original = [255,255,255,255, 255,255,0,255, 0,0,0,255, 184,184,184,255, 255,255,255,0];
  const put = vi.fn();
  const read = vi.fn(() => ({ data: Uint8ClampedArray.from(original) }));
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
    drawImage: draw, getImageData: read, putImageData: put, fillRect: vi.fn(),
  });
  await encodePlayheadOcrRegion(source, null, { whiteSubtitles: true });
  expect(encoded.mock.instances[0]).not.toBe(source);
  expect(put.mock.calls[0][0].data).toEqual(Uint8ClampedArray.from([
    0,0,0,255, 255,255,255,255, 255,255,255,255, 127,127,127,255, 255,255,255,255,
  ]));
  await encodePlayheadOcrRegion(source);
  expect(encoded.mock.instances[1]).toBe(source);
  expect(read).toHaveBeenCalledOnce();
});

it('normalizes the blank margin around every line and preserves separated faint punctuation at the image edge', async () => {
  const context = { drawImage: draw, putImageData: vi.fn(), fillRect: vi.fn() };
  const sizes = [];
  for (const margin of [0, 3, 11]) {
    source.width = 11 + 2 * margin; source.height = 8 + 2 * margin;
    const pixels = new Uint8ClampedArray(source.width * source.height * 4);
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
    for (const [x, y, level] of [[0,0,255], [7,1,200], [5,5,255], [10,7,129]]) {
      const i = ((y + margin) * source.width + x + margin) * 4;
      pixels.set([level, level, level, 255], i);
    }
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
      ...context, getImageData: () => ({ data: pixels }),
    });
    await encodePlayheadOcrRegion(source, null, { whiteSubtitles: true });
    expect(draw.mock.calls.at(-1).slice(1)).toEqual([margin, margin, 11, 8, 10, 10, 11, 8]);
    const page = encoded.mock.instances.at(-1);
    sizes.push([page.width, page.height]);
  }
  expect(sizes).toEqual([[31,28], [31,28], [31,28]]);
});

it.each([['blank', 0], ['solid backing', 255]])('does not add a visible rectangle to a %s page', async (_, level) => {
  source.width = 24; source.height = 11;
  const pixels = new Uint8ClampedArray(source.width * source.height * 4).fill(level);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  const fillRect = vi.fn();
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
    drawImage: draw, putImageData: vi.fn(), fillRect, getImageData: () => ({ data: pixels }),
  });
  await encodePlayheadOcrRegion(source, null, { whiteSubtitles: true });
  expect(fillRect).not.toHaveBeenCalled();
  expect(draw).toHaveBeenCalledTimes(1);
  const page = encoded.mock.instances[0];
  expect([page.width, page.height]).toEqual([24,11]);
});

it('cancels a full-page white-subtitle pass between pixel bands before encoding', async () => {
  const owner = new AbortController();
  const read = vi.fn(() => ({ data: Uint8ClampedArray.of(255,255,255,255) }));
  const put = vi.fn(() => queueMicrotask(() => owner.abort()));
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({ drawImage: draw, getImageData: read, putImageData: put });
  const result = encodePlayheadOcrRegion(source, null, { whiteSubtitles: true, signal: owner.signal });
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  expect(read).toHaveBeenCalledOnce();
  expect(encoded).not.toHaveBeenCalled();
});

it('a cancelled caller never pauses its successor, and cannot publish pixels after changing workspace', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(capturePlayheadOcrFrame(2, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(setup.pause).not.toHaveBeenCalled();
  let current = true;
  setup.media.captureMediaOwnership.mockReturnValue(() => current);
  setup.capture.mockImplementation(async () => { current = false; return { canvas: source }; });
  await expect(capturePlayheadOcrFrame(2)).rejects.toMatchObject({ name: 'AbortError' });
  expect(encoded).not.toHaveBeenCalled();
});
