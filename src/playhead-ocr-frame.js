import { State } from './state.js';
import { Media } from './media.js';
import { getPlayerAdapter } from './media-player-adapter.js';
import { getExactFps, snapTimeToFrame } from './time.js';
import { pauseForPointerSeek } from './transport-controller.js';
import { capturePreviewFrame } from './video-renderer.js';
import { reserveProjectFrame } from './decode/player.js';
import { bytesToB64 } from './util.js';

function aborted() {
  return new DOMException('擷取播放畫格已取消', 'AbortError');
}

function ocrScale(width, height) {
  // Leave room for PNG overhead below the worker's 48 MiB limit.
  return Math.min(1, 16384 / width, 16384 / height, Math.sqrt(12_000_000 / (width * height)));
}

function fillUnselectedPixels(canvas, context) {
  // Match the brightness of the selected page. A white rectangle inserted
  // between white-on-dark captions can itself be segmented as text.
  const sample = document.createElement('canvas');
  sample.width = Math.min(canvas.width, 64);
  sample.height = Math.min(canvas.height, 64);
  const probe = sample.getContext('2d', { willReadFrequently: true });
  probe.imageSmoothingEnabled = false;
  probe.drawImage(canvas, 0, 0, sample.width, sample.height);
  const pixels = probe.getImageData(0, 0, sample.width, sample.height).data;
  const histogram = new Uint32Array(256);
  let weight = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const luma = Math.round(.299 * pixels[i] + .587 * pixels[i + 1] + .114 * pixels[i + 2]);
    histogram[luma] += pixels[i + 3];
    weight += pixels[i + 3];
  }
  let shade = 255;
  for (let level = 0, seen = 0; weight && level < 256; level++) {
    seen += histogram[level];
    if (seen >= weight / 2) { shade = level; break; }
  }
  context.globalCompositeOperation = 'destination-over';
  context.fillStyle = `rgb(${shade}, ${shade}, ${shade})`;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = 'source-over';
}

async function regionCanvas(canvas, selection, whiteSubtitles, signal) {
  const full = { x: 0, y: 0, width: canvas.width, height: canvas.height };
  const input = Array.isArray(selection) ? selection : [selection ?? full];
  if (!input.length) throw new RangeError('請先選取要辨識的範圍');
  const rects = [];
  let left = canvas.width, top = canvas.height, right = 0, bottom = 0;
  for (const rect of input) {
    const { x, y, width, height } = rect || {};
    if (![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0 || width <= 0 || height <= 0
      || width > canvas.width - x || height > canvas.height - y) {
      throw new RangeError('辨識範圍必須位於畫格內，且至少包含一個完整像素');
    }
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x + width); bottom = Math.max(bottom, y + height);
    rects.push({ x, y, width, height });
  }
  const width = right - left, height = bottom - top;
  const scale = ocrScale(width, height);
  const wholeFrame = rects.length === 1 && width === canvas.width && height === canvas.height;
  if (!whiteSubtitles && scale === 1 && wholeFrame) return canvas;
  const resized = document.createElement('canvas');
  resized.width = Math.max(1, Math.floor(width * scale));
  resized.height = Math.max(1, Math.floor(height * scale));
  const context = resized.getContext('2d', { willReadFrequently: whiteSubtitles });
  context.imageSmoothingQuality = 'high';
  const scaledX = x => Math.round((x - left) * resized.width / width);
  const scaledY = y => Math.round((y - top) * resized.height / height);
  for (const rect of rects) {
    const { x, y, width: w, height: h } = rect;
    const dx = scaledX(x), dy = scaledY(y), dw = scaledX(x + w) - dx, dh = scaledY(y + h) - dy;
    if (!dw || !dh) continue;
    if (scale < 1 && !wholeFrame && typeof createImageBitmap === 'function') {
      // Crop before filtering: the scaler must never sample an excluded
      // neighbour just beyond a rectangle edge. Hold only one reduced tile.
      const tile = await createImageBitmap(canvas, x, y, w, h, { resizeWidth: dw, resizeHeight: dh, resizeQuality: 'high' });
      try {
        if (signal?.aborted) throw aborted();
        context.drawImage(tile, dx, dy);
      } finally { tile.close(); }
    } else {
      context.imageSmoothingEnabled = wholeFrame || scale === 1;
      context.drawImage(canvas, x, y, w, h, dx, dy, dw, dh);
    }
  }
  // Transparent gaps already carry zero white ink in subtitle enhancement.
  if (rects.length > 1 && !whiteSubtitles) fillUnselectedPixels(resized, context);
  return resized;
}

// White ink has all three channels bright. Saturated scenery such as a yellow
// sign has at least one weak channel. Preserve antialiased strokes between
// midgray and near-white, then print the extracted ink black on an opaque page.
const whiteInk = Uint8ClampedArray.from({ length: 256 }, (_, level) => (level - 128) * 255 / (240 - 128));
async function isolateWhiteSubtitles(canvas, signal) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const rows = Math.max(1, Math.floor(1_048_576 / canvas.width));
  let left = canvas.width, right = -1, firstRow = canvas.height, lastRow = -1, inkCount = 0;
  for (let top = 0; top < canvas.height; top += rows) {
    if (signal?.aborted) throw aborted();
    const band = context.getImageData(0, top, canvas.width, Math.min(rows, canvas.height - top));
    const pixels = band.data;
    for (let i = 0; i < pixels.length; i += 4) {
      const ink = whiteInk[Math.min(pixels[i], pixels[i + 1], pixels[i + 2])];
      const shade = 255 - ink * pixels[i + 3] / 255;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = shade;
      pixels[i + 3] = 255;
      // Keep every surviving stroke, including faint punctuation, ascenders
      // and marks on their own lines. Only the outer blank page is removed.
      if (pixels[i] < 255) {
        const index = i / 4, x = index % canvas.width, y = top + Math.floor(index / canvas.width);
        left = Math.min(left, x); right = Math.max(right, x);
        firstRow = Math.min(firstRow, y); lastRow = Math.max(lastRow, y);
        inkCount++;
      }
    }
    context.putImageData(band, 0, top);
    // Small subtitle selections finish in one pass. Larger selections allow
    // the dialog to repaint and process a cancel between readbacks.
    if (top + rows < canvas.height) await new Promise(resolve => setTimeout(resolve, 0));
  }
  const width = right - left + 1, height = lastRow - firstRow + 1;
  // Adding a white border to a solid dark page creates a false rectangular
  // glyph. Preserve dense light-backed signs when the ink fills the frame.
  if (!inkCount || (width === canvas.width && height === canvas.height && inkCount > width * height / 2))
    return canvas;
  // A pointer selection may gain a row when projected from CSS pixels.
  // Give equivalent ink the same ten-pixel blank OCR border on all sides.
  const border = 10, pageWidth = width + 2 * border, pageHeight = height + 2 * border;
  const scale = ocrScale(pageWidth, pageHeight);
  const page = document.createElement('canvas');
  page.width = Math.max(1, Math.floor(pageWidth * scale));
  page.height = Math.max(1, Math.floor(pageHeight * scale));
  const output = page.getContext('2d');
  output.fillStyle = 'white';
  output.fillRect(0, 0, page.width, page.height);
  output.imageSmoothingQuality = 'high';
  output.drawImage(canvas, left, firstRow, width, height, border * scale, border * scale, width * scale, height * scale);
  return page;
}

export async function capturePlayheadOcrCanvas(time = Media.displayTime(), { signal } = {}) {
  if (signal?.aborted) throw aborted();
  if (!Number.isFinite(time) || !(State.duration > 0)) throw new Error('請先載入可辨識的影像');
  const target = snapTimeToFrame(Math.min(State.duration, Math.max(0, time)), State.fps, State.dropFrame);
  const ownsMedia = Media.captureMediaOwnership();
  pauseForPointerSeek({ seekOnPause: false });
  if (signal?.aborted || !ownsMedia()) throw aborted();
  const projectFrame = reserveProjectFrame(target);
  let result;
  try {
    result = await Media.seek(target, {
      signal,
      presentationTolerance: .45 / getExactFps(State.fps),
      async whilePresented({ source, isCurrent }) {
        const adapter = getPlayerAdapter();
        const owns = () => !signal?.aborted && ownsMedia() && isCurrent() && getPlayerAdapter() === adapter
          && (source === 'synthetic' || (source === 'webcodecs' ? Media.webCodecsTakeover()
            : !Media.webCodecsTakeover() && Media.mpvPresenting() === (source === 'mpv')));
        if (!owns()) throw aborted();
        const { canvas } = await capturePreviewFrame({
          ocrFrame: { time: target, source, adapter, isCurrent: owns, takeComposite: projectFrame.take }
        });
        if (!owns()) throw aborted();
        return canvas;
      }
    });
  } finally {
    projectFrame.release();
  }
  if (signal?.aborted || !ownsMedia() || ['cancelled', 'superseded'].includes(result?.status)) throw aborted();
  if (result?.captureError) throw result.captureError;
  if (result?.status !== 'presented' || !result.value) throw new Error('未能確認播放點畫格，請重新定位後再試');
  return { time: target, canvas: result.value };
}

async function encodePng(output, signal) {
  const blob = await new Promise((resolve, reject) => output.toBlob(
    image => image ? resolve(image) : reject(new Error('無法編碼播放畫格')), 'image/png'
  ));
  if (signal?.aborted) throw aborted();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (signal?.aborted) throw aborted();
  return bytesToB64(bytes);
}

export async function encodePlayheadOcrRegion(canvas, selection = null, { signal, whiteSubtitles = false } = {}) {
  if (signal?.aborted) throw aborted();
  const region = await regionCanvas(canvas, selection, whiteSubtitles, signal);
  if (signal?.aborted) throw aborted();
  const output = whiteSubtitles ? await isolateWhiteSubtitles(region, signal) : region;
  if (signal?.aborted) throw aborted();
  if (!signal) return encodePng(output);
  let rejectOnAbort;
  const cancelled = new Promise((_, reject) => {
    rejectOnAbort = () => reject(aborted());
    signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
  try {
    return await Promise.race([encodePng(output, signal), cancelled]);
  } finally {
    signal.removeEventListener('abort', rejectOnAbort);
  }
}

export async function capturePlayheadOcrFrame(time = Media.displayTime(), options = {}) {
  const ownsMedia = Media.captureMediaOwnership();
  const { time: frameTime, canvas } = await capturePlayheadOcrCanvas(time, options);
  const pngBase64 = await encodePlayheadOcrRegion(canvas, null, options);
  if (!ownsMedia()) throw aborted();
  return { time: frameTime, pngBase64 };
}
