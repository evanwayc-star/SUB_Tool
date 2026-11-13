/* 固定畫面的可重建預覽幀：只讀已授權母素材，不擷取播放器、字幕或合成畫布。 */
'use strict';

const fs = require('fs/promises');
const path = require('path');
const { createHash } = require('crypto');
const { createClipCacheArtifact } = require('./clip-cache-artifact');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { crc32, createInflate } = require('node:zlib');
const { motherSourceFingerprint } = require('./mother-source-evidence');
const { exactDeliveryFrameRate } = require('../shared/delivery-frame-rate.cjs');
const { sourceVideoClockSeek, sourceFrameSelectionFilter } = require('./media-source-clock');

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// 驗證以串流進行；此工作預算仍容納 8192×8192 的 16-bit RGBA。
const PNG_BYTE_LIMIT = 1024 * 1024 * 1024;
const PNG_FORMATS = {
  0: { channels: 1, depths: [1, 2, 4, 8, 16] },
  2: { channels: 3, depths: [8, 16] },
  3: { channels: 1, depths: [1, 2, 4, 8] },
  4: { channels: 2, depths: [8, 16] },
  6: { channels: 4, depths: [8, 16] },
};
const PNG_ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
  [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

function validateClipFrameRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('缺少固定畫面參數');
  const { path: source, time, fps } = request;
  if (typeof source !== 'string' || !source.trim() || source.length > 32767 || source.includes('\0')) {
    throw new TypeError('缺少有效的母素材路徑');
  }
  if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) throw new RangeError('固定畫面來源時間必須是非負有限秒數');
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0 || fps > 240) throw new RangeError('固定畫面 FPS 必須大於 0 且不超過 240');
  return { path: source, time, fps: exactDeliveryFrameRate(fps) };
}

function buildClipFrameArgs(request, output, clock = null) {
  const frame = validateClipFrameRequest(request);
  // 在目標附近 seek，但保留所需 GOP 的原 PTS。accurate seek 會丟掉
  // PTS 早於 seek、卻仍覆蓋目標的長 VFR 格，不能用平均 FPS 補猜。
  const { inputArgs, sourceStart } = sourceVideoClockSeek(Math.max(0, frame.time - 0.5), clock);
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    ...inputArgs, '-i', frame.path, '-map', '0:v:0',
    '-vf', sourceFrameSelectionFilter(frame.time, sourceStart),
    '-frames:v', '1', '-an', '-sn', '-dn', '-c:v', 'png', '-f', output === 'fd:' ? 'image2pipe' : 'image2',
    ...(output === 'fd:' ? [] : ['-update', '1']), output];
}

async function pngDimensions(file, verify = null) {
  let handle;
  try {
    verify?.();
    handle = await fs.open(file, 'r');
    verify?.(await handle.stat({ bigint: true }));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 57 || stat.size > PNG_BYTE_LIMIT) return null;
    const read = async (position, length) => {
      const bytes = Buffer.alloc(length);
      for (let offset = 0; offset < length;) {
        const result = await handle.read(bytes, offset, length - offset, position + offset);
        if (!result.bytesRead) throw new Error('PNG 內容截斷');
        offset += result.bytesRead;
      }
      return bytes;
    };
    if (!(await read(0, 8)).equals(PNG_SIGNATURE)) return null;
    let position = 8, compressedBytes = 0, haveHeader = false, haveData = false, endedData = false;
    let haveEnd = false, havePalette = false, colorType = null, bitDepth = null, dimensions = null, passes = [], expectedBytes = 0;
    async function* compressedData() {
      while (position < stat.size) {
        if (stat.size - position < 12) throw new Error('PNG 區塊標頭截斷');
        const header = await read(position, 8), length = header.readUInt32BE(0), type = header.toString('ascii', 4, 8);
        if (!/^[A-Za-z]{4}$/.test(type) || length > stat.size - position - 12) throw new Error('PNG 區塊長度不正確');
        if (!haveHeader && (type !== 'IHDR' || length !== 13)) throw new Error('PNG 缺少 IHDR');
        let crc = crc32(header.subarray(4)), offset = position + 8, remaining = length;
        if (type === 'IHDR') {
          if (haveHeader || length !== 13) throw new Error('PNG IHDR 重複');
          const data = await read(offset, 13);crc = crc32(data, crc);offset += 13;remaining = 0;
          const width = data.readUInt32BE(0), height = data.readUInt32BE(4), depth = data[8], color = data[9];
          const format = PNG_FORMATS[color], interlace = data[12];
          if (!width || !height || width > 0x7fffffff || height > 0x7fffffff || !format?.depths.includes(depth)
            || data[10] || data[11] || interlace > 1) throw new Error('PNG 圖像格式不正確');
          const layouts = interlace ? PNG_ADAM7 : [[0, 0, 1, 1]];
          passes = layouts.map(([x, y, dx, dy]) => {
            const w = width > x ? Math.ceil((width - x) / dx) : 0;
            const h = height > y ? Math.ceil((height - y) / dy) : 0;
            return { rowBytes: w ? Math.ceil(w * format.channels * depth / 8) + 1 : 0, rows: w ? h : 0 };
          }).filter(pass => pass.rows);
          expectedBytes = passes.reduce((total, pass) => total + pass.rowBytes * pass.rows, 0);
          if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > PNG_BYTE_LIMIT) throw new Error('PNG 解壓超過預算');
          dimensions = { width, height };colorType = color;bitDepth = depth;haveHeader = true;
        } else if (type === 'IDAT') {
          if (endedData || haveEnd || (colorType === 3 && !havePalette)) throw new Error('PNG IDAT 順序不正確');
          haveData = true;
        } else {
          if (haveData) endedData = true;
          if (type === 'PLTE') {
            if (haveData || havePalette || !length || length % 3 || length > 768 || [0, 4].includes(colorType)
              || (colorType === 3 && length / 3 > 2 ** bitDepth)) throw new Error('PNG 調色盤不正確');
            havePalette = true;
          }
          if (type === 'IEND') {
            if (!haveData || length || position + 12 !== stat.size) throw new Error('PNG IEND 不正確');
            haveEnd = true;
          }
          if ((header[4] & 32) === 0 && !['PLTE', 'IEND'].includes(type)) throw new Error('PNG 不支援的必要區塊');
        }
        while (remaining) {
          const data = await read(offset, Math.min(remaining, 65536));
          crc = crc32(data, crc);offset += data.length;remaining -= data.length;
          if (type === 'IDAT') { compressedBytes += data.length;yield data; }
        }
        if (crc !== (await read(position + 8 + length, 4)).readUInt32BE(0)) throw new Error('PNG CRC 不正確');
        position += length + 12;
        if (haveEnd) break;
      }
      if (!haveEnd || position !== stat.size) throw new Error('PNG 缺少 IEND');
    }
    let passIndex = 0, row = 0, rowOffset = 0, decodedBytes = 0;
    const sink = new Writable({ write(data, _encoding, done) {
      try {
        for (let at = 0; at < data.length;) {
          if (passIndex >= passes.length) throw new Error('PNG 解壓資料過長');
          const pass = passes[passIndex];
          if (!rowOffset && data[at] > 4) throw new Error('PNG 濾鏡類型不正確');
          const count = Math.min(data.length - at, pass.rowBytes - rowOffset);
          at += count;rowOffset += count;decodedBytes += count;
          if (rowOffset === pass.rowBytes) { rowOffset = 0;if (++row === pass.rows) { row = 0;passIndex++; } }
        }
        done();
      } catch (error) { done(error); }
    } });
    const inflater = createInflate();
    await pipeline(Readable.from(compressedData()), inflater, sink);
    if (inflater.bytesWritten !== compressedBytes || decodedBytes !== expectedBytes || passIndex !== passes.length || rowOffset) return null;
    verify?.(await handle.stat({ bigint: true }));
    return dimensions;
  } catch (_) { return null; }
  finally { await handle?.close().catch(() => {}); }
}

function createClipFrameCache({ cacheRoot, fileAuthority, probe, execute, isPreviewCacheMedia = () => false,
  isClosing = () => false, timeoutMs = 60000, terminationGraceMs = 1000 } = {}) {
  if (!cacheRoot || !fileAuthority?.canRead || !fileAuthority?.grantTrustedFile
    || typeof probe !== 'function' || typeof execute !== 'function') throw new TypeError('固定畫面快取缺少必要 adapter');
  const inFlight = new Map();
  const activeRequests = new Set();
  const root = source => path.resolve(typeof cacheRoot === 'function' ? cacheRoot(source) : cacheRoot);
  function isDerived(source) {
    const relative = path.relative(root(source), path.resolve(source));
    if (path.resolve(source).split(path.sep).some(part => part.toLowerCase() === '.subtool_cache')) return true;
    return (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) || isPreviewCacheMedia(source);
  }
  function assertSource(source) {
    if (!fileAuthority.canRead(source)) {
      const error = new Error('未授權存取此檔案'); error.code = 'UNAUTHORIZED_PATH'; throw error;
    }
    if (isDerived(source)) {
      throw new Error('固定畫面必須讀取母素材，不能使用預覽快取');
    }
    if (isClosing()) { const error = new Error('固定畫面工作已取消'); error.name = 'AbortError'; throw error; }
  }
  async function fingerprint(source) {
    const resolved = await fs.realpath(source);
    if (isDerived(resolved)) throw new Error('固定畫面必須讀取母素材，不能使用預覽快取');
    return { resolved, fingerprint: await motherSourceFingerprint(source, { namespace: 'clip-frame-source-v1' }) };
  }
  const sameSource = (left, right) => left.resolved === right.resolved && left.fingerprint === right.fingerprint;

  function frame(request) {
    const pending = frameRequest(request);
    activeRequests.add(pending);
    void pending.finally(() => activeRequests.delete(pending)).catch(() => {});
    return pending;
  }

  async function frameRequest(request) {
    const input = validateClipFrameRequest(request);
    assertSource(input.path);
    const identity = await fingerprint(input.path);
    if (isDerived(identity.resolved)) throw new Error('固定畫面必須讀取母素材，不能使用預覽快取');
    assertSource(input.path);
    const media = await probe(input.path);
    assertSource(input.path);
    const duration = Number(media?.duration);
    if (!media?.video || !Number.isFinite(duration) || duration <= 0) throw new Error('來源沒有可擷取的影片畫面或有效時長');
    if (input.time > duration + 1e-6) throw new RangeError('固定畫面來源時間超過素材結尾');
    // 來源秒數保留原精度。EOF 是半開邊界，只往內一微秒，不能依平均
    // FPS 推算末格：VFR 的最後一格與 nominal 格網可能完全不同。
    const normalized = { ...input, time: Math.min(input.time, Math.max(0, duration - 1e-6)) };
    // v5 隔離舊 seek 重基準的 timebase 捨入；同一目標仍共享完整 PNG。
    const key = createHash('sha256').update(JSON.stringify({ version: 5, ...identity, time: normalized.time })).digest('hex');
    let pending = inFlight.get(key);
    if (!pending) {
      pending = generate(normalized, identity, key, media.video);
      inFlight.set(key, pending);
      void pending.finally(() => { if (inFlight.get(key) === pending) inFlight.delete(key); }).catch(() => {});
    }
    const result = await pending;
    assertSource(input.path);
    return result;
  }

  async function generate(request, identity, key, clock) {
    const store = createClipCacheArtifact(root(request.path), key, 'png');
    assertSource(request.path);
    for (const candidate of store.candidates()) {
      const existing = await pngDimensions(candidate.path, candidate.verify);
      if (!existing) continue;
      if (!sameSource(identity, await fingerprint(request.path))) throw new Error('母素材在擷取期間已變更，請重新固定畫面');
      candidate.verify(); assertSource(request.path);
      fileAuthority.grantTrustedFile(candidate.path, { read: true, write: false });
      return { ok: true, path: candidate.path, time: request.time, ...existing };
    }
    const artifact = store.reserve();
    let child = null, timer = null, killTimer = null, timedOut = false, failure = null;
    try {
      assertSource(request.path);
      artifact.verify();
      await execute(buildClipFrameArgs(request, 'fd:', clock), {
        executionKind: 'direct', deferTerminal: true,
        outputDescriptor: artifact.fd,
        jobId: `clip-frame-${key.slice(0, 12)}`, label: '擷取固定畫面',
        onProcess: process => {
          child = process;
          child.once?.('close', () => { clearTimeout(timer); clearTimeout(killTimer); });
          timer = setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGTERM'); } catch (_) {}
            killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, terminationGraceMs);
            killTimer.unref?.();
          }, timeoutMs);
          timer.unref?.();
          if (isClosing()) { try { child.kill('SIGTERM'); } catch (_) {} }
        },
      });
      if (timedOut) throw new Error('固定畫面擷取逾時');
      assertSource(request.path);
      artifact.verify();
      if (!sameSource(identity, await fingerprint(request.path))) throw new Error('母素材在擷取期間已變更，請重新固定畫面');
      artifact.verify();
      const dimensions = await pngDimensions(artifact.path, artifact.verify);
      if (!dimensions) throw new Error('固定畫面未產生完整 PNG');
      if (!sameSource(identity, await fingerprint(request.path))) throw new Error('母素材在擷取期間已變更，請重新固定畫面');
      assertSource(request.path);artifact.verify();
      const output = artifact.publish();
      fileAuthority.grantTrustedFile(output, { read: true, write: false });
      return { ok: true, path: output, time: request.time, ...dimensions };
    } catch (error) {
      failure = timedOut ? Object.assign(new Error('固定畫面擷取逾時'), { code: 'CLIP_FRAME_TIMEOUT', cause: error }) : error;
      throw failure;
    } finally {
      clearTimeout(timer); clearTimeout(killTimer);
      try { await artifact.close(); } catch (error) {
        if (failure) throw Object.assign(new Error(`原始錯誤：${failure.message}；${error.message}`, { cause: failure }), { code: error.code });
        throw error;
      }
    }
  }
  async function waitForIdle() {
    // execution 先確認 native writer close，再等來源 fingerprint、驗證與私有 staging 清理。
    while (activeRequests.size || inFlight.size) {
      await Promise.allSettled([...activeRequests, ...inFlight.values()]);
    }
  }
  return Object.freeze({ frame, waitForIdle, activeCount: () => inFlight.size });
}

module.exports = { createClipFrameCache, validateClipFrameRequest, buildClipFrameArgs };
