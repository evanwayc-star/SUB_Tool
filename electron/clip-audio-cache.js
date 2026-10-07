/* 可重建的反向片段音訊；只供預覽，交付一律重新讀母素材。 */
'use strict';

const fs = require('fs/promises');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { vocalSourceFingerprint } = require('./vocal-waveform-fingerprint');
const SAMPLE_RATE = 48000;

function validateReverseAudioRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('缺少反向音訊參數');
  const { path: source, in: start, out: end, sourceStream = 0 } = request;
  if (typeof source !== 'string' || !source.trim() || source.length > 32767 || source.includes('\0')) throw new TypeError('缺少有效的來源路徑');
  if (typeof start !== 'number' || !Number.isFinite(start) || start < 0
    || typeof end !== 'number' || !Number.isFinite(end) || end <= start) throw new RangeError('反向音訊來源範圍必須是遞增的有限秒數');
  if (!Number.isInteger(sourceStream) || sourceStream < 0 || sourceStream > 255) throw new TypeError('無效的來源音訊串流');
  return { path: source, in: start, out: end, sourceStream };
}

function buildReverseAudioArgs(request, output) {
  const input = validateReverseAudioRequest(request), duration = input.out - input.in;
  // accurate seek 的時鐘由零開始；缺聲／較早 EOF 先補齊，再反轉完整片段。
  // 保留整個 stream，renderer 再按原來源聲道拆回既有 project bus。
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-ss', String(input.in), '-t', String(duration), '-i', input.path,
    '-map', `0:a:${input.sourceStream}`, '-vn', '-sn', '-dn',
    '-af', `aresample=${SAMPLE_RATE}:async=1:first_pts=0,apad=whole_dur=${duration},atrim=end=${duration},asetpts=PTS-STARTPTS,areverse`,
    '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', '-rf64', 'auto', '-f', 'wav', output];
}

async function completeWave(file, duration) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat(), header = Buffer.alloc(12);
    if (!stat.isFile() || stat.size < 44) return false;
    if ((await handle.read(header, 0, 12, 0)).bytesRead !== 12) return false;
    const type = header.toString('ascii', 0, 4);
    if (!['RIFF', 'RF64'].includes(type) || header.toString('ascii', 8, 12) !== 'WAVE') return false;
    if (type === 'RIFF' && header.readUInt32LE(4) + 8 !== stat.size) return false;
    let position = 12, channels = 0, dataLength = 0, rf64Length = 0;
    while (position + 8 <= stat.size) {
      const chunk = Buffer.alloc(8);
      if ((await handle.read(chunk, 0, 8, position)).bytesRead !== 8) return false;
      const name = chunk.toString('ascii', 0, 4);
      let length = chunk.readUInt32LE(4);
      if (name === 'ds64' && length >= 28) {
        const sizes = Buffer.alloc(28); await handle.read(sizes, 0, 28, position + 8);
        if (Number(sizes.readBigUInt64LE(0)) + 8 !== stat.size) return false;
        rf64Length = Number(sizes.readBigUInt64LE(8));
      }
      if (name === 'data' && length === 0xFFFFFFFF) length = rf64Length;
      if (position + 8 + length > stat.size) return false;
      if (name === 'fmt ' && length >= 16) {
        const format = Buffer.alloc(Math.min(length, 40)); await handle.read(format, 0, format.length, position + 8);
        const code = format.readUInt16LE(0);
        if (code !== 1 && !(code === 0xFFFE && format.length >= 40 && format.readUInt16LE(24) === 1)) return false;
        channels = format.readUInt16LE(2);
        if (!channels || format.readUInt32LE(4) !== SAMPLE_RATE || format.readUInt16LE(14) !== 16
          || format.readUInt16LE(12) !== channels * 2) return false;
      }
      if (name === 'data') dataLength += length;
      position += 8 + length + (length % 2);
    }
    const samples = dataLength / (channels * 2);
    return position === stat.size && channels > 0 && Number.isInteger(samples)
      && Math.abs(samples - Math.round(duration * SAMPLE_RATE)) <= 1;
  } catch (_) { return false; }
  finally { await handle?.close().catch(() => {}); }
}

function createClipAudioCache({ cacheRoot, fileAuthority, execute, isClosing = () => false,
  timeoutMs = 600000, terminationGraceMs = 1000 } = {}) {
  if (!cacheRoot || !fileAuthority?.canRead || !fileAuthority?.grantTrustedFile || typeof execute !== 'function') throw new TypeError('反向音訊快取缺少必要 adapter');
  const inFlight = new Map();
  const activeRequests = new Set();
  const root = () => path.resolve(typeof cacheRoot === 'function' ? cacheRoot() : cacheRoot);
  const assertSource = source => {
    if (!fileAuthority.canRead(source)) throw Object.assign(new Error('未授權存取此檔案'), { code: 'UNAUTHORIZED_PATH' });
    if (isClosing()) throw Object.assign(new Error('反向音訊工作已取消'), { name: 'AbortError' });
  };
  function reverse(request) {
    const pending = reverseRequest(request);
    activeRequests.add(pending);
    void pending.finally(() => activeRequests.delete(pending)).catch(() => {});
    return pending;
  }
  async function reverseRequest(request) {
    const input = validateReverseAudioRequest(request);
    assertSource(input.path);
    const identity = await vocalSourceFingerprint(input.path);
    assertSource(input.path);
    const key = createHash('sha256').update(JSON.stringify({ version: 1, identity, in: input.in,
      out: input.out, stream: input.sourceStream, sampleRate: SAMPLE_RATE })).digest('hex');
    let pending = inFlight.get(key);
    if (!pending) {
      pending = generate(input, identity, key);
      inFlight.set(key, pending);
      void pending.finally(() => { if (inFlight.get(key) === pending) inFlight.delete(key); }).catch(() => {});
    }
    const result = await pending;
    assertSource(input.path);
    return result;
  }
  async function generate(request, identity, key) {
    const directory = root(), output = path.join(directory, `${key}.wav`), duration = request.out - request.in;
    await fs.mkdir(directory, { recursive: true });
    assertSource(request.path);
    if (await completeWave(output, duration)) {
      if (await vocalSourceFingerprint(request.path) !== identity) throw new Error('音訊來源在建立快取期間已變更');
      fileAuthority.grantTrustedFile(output, { read: true, write: false });
      return { path: output, duration };
    }
    const staging = path.join(directory, `.${key}-${randomUUID()}.wav`);
    let timer = null, killTimer = null, timedOut = false;
    try {
      assertSource(request.path);
      await execute(buildReverseAudioArgs(request, staging), {
        executionKind: 'direct', deferTerminal: true, jobId: `clip-audio-${key.slice(0, 12)}`, label: '準備反向音訊',
        onProcess: child => {
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
      if (timedOut) throw new Error('反向音訊準備逾時');
      assertSource(request.path);
      if (await vocalSourceFingerprint(request.path) !== identity) throw new Error('音訊來源在建立快取期間已變更');
      if (!await completeWave(staging, duration)) throw new Error('反向音訊未產生完整 PCM WAV');
      await fs.rename(staging, output);
      fileAuthority.grantTrustedFile(output, { read: true, write: false });
      return { path: output, duration };
    } catch (error) {
      if (timedOut) throw Object.assign(new Error('反向音訊準備逾時'), { code: 'CLIP_AUDIO_TIMEOUT', cause: error });
      throw error;
    } finally {
      clearTimeout(timer); clearTimeout(killTimer);
      await fs.unlink(staging).catch(() => {});
    }
  }
  async function waitForIdle() {
    // 全域 execution 先停止 writer，這裡再等 fingerprint、驗證與 finally 清理。
    while (activeRequests.size || inFlight.size) {
      await Promise.allSettled([...activeRequests, ...inFlight.values()]);
    }
  }
  return Object.freeze({ reverse, waitForIdle, activeCount: () => inFlight.size });
}
module.exports = { createClipAudioCache, validateReverseAudioRequest, buildReverseAudioArgs };
