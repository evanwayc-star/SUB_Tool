/* 固定畫面的可重建預覽幀：只讀已授權母素材，不擷取播放器、字幕或合成畫布。 */
'use strict';

const fs = require('fs/promises');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { motherSourceFingerprint } = require('./mother-source-evidence');
const { exactDeliveryFrameRate } = require('../shared/delivery-frame-rate.cjs');
const { sourceVideoClockSeek, sourceFrameSelectionFilter } = require('./media-source-clock');

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

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
    '-frames:v', '1', '-an', '-sn', '-dn', '-c:v', 'png', '-f', 'image2', '-update', '1', output];
}

async function pngDimensions(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 45) return null;
    const header = Buffer.alloc(24), tail = Buffer.alloc(12);
    await handle.read(header, 0, header.length, 0);
    await handle.read(tail, 0, tail.length, stat.size - tail.length);
    if (!header.subarray(0, 8).equals(PNG_SIGNATURE) || header.toString('ascii', 12, 16) !== 'IHDR'
      || tail.toString('ascii', 4, 8) !== 'IEND') return null;
    const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  } catch (_) { return null; }
  finally { await handle?.close().catch(() => {}); }
}

function createClipFrameCache({ cacheRoot, fileAuthority, probe, execute, isPreviewCacheMedia = () => false,
  isClosing = () => false, timeoutMs = 60000, terminationGraceMs = 1000 } = {}) {
  if (!cacheRoot || !fileAuthority?.canRead || !fileAuthority?.grantTrustedFile
    || typeof probe !== 'function' || typeof execute !== 'function') throw new TypeError('固定畫面快取缺少必要 adapter');
  const inFlight = new Map();
  const activeRequests = new Set();
  const root = () => path.resolve(typeof cacheRoot === 'function' ? cacheRoot() : cacheRoot);
  function isDerived(source) {
    const relative = path.relative(root(), path.resolve(source));
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
    const directory = root(), output = path.join(directory, `${key}.png`);
    await fs.mkdir(directory, { recursive: true });
    assertSource(request.path);
    const existing = await pngDimensions(output);
    if (existing) {
      if (!sameSource(identity, await fingerprint(request.path))) throw new Error('母素材在擷取期間已變更，請重新固定畫面');
      fileAuthority.grantTrustedFile(output, { read: true, write: false });
      return { ok: true, path: output, time: request.time, ...existing };
    }
    const staging = path.join(directory, `.${key}-${randomUUID()}.png`);
    let child = null, timer = null, killTimer = null, timedOut = false;
    try {
      assertSource(request.path);
      await execute(buildClipFrameArgs(request, staging, clock), {
        executionKind: 'direct', deferTerminal: true,
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
      if (!sameSource(identity, await fingerprint(request.path))) throw new Error('母素材在擷取期間已變更，請重新固定畫面');
      const dimensions = await pngDimensions(staging);
      if (!dimensions) throw new Error('固定畫面未產生完整 PNG');
      // 私有 staging 只有 FFmpeg 確認 close 後才發布；讀取者不會看見半張圖。
      await fs.rename(staging, output);
      fileAuthority.grantTrustedFile(output, { read: true, write: false });
      return { ok: true, path: output, time: request.time, ...dimensions };
    } catch (error) {
      if (timedOut) throw Object.assign(new Error('固定畫面擷取逾時'), { code: 'CLIP_FRAME_TIMEOUT', cause: error });
      throw error;
    } finally {
      clearTimeout(timer); clearTimeout(killTimer);
      await fs.unlink(staging).catch(() => {});
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
