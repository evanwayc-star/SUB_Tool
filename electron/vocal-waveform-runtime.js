/* 人聲波形分析的母素材 PCM 邊界；只回傳受限片段，不建立播放或匯出檔案。 */
'use strict';

const { spawn: nativeSpawn } = require('child_process');

const SAMPLE_RATE = 44100;
const CHANNELS = 2;
const MAX_CHUNK_SECONDS = 36;
const MAX_CHUNK_BYTES = MAX_CHUNK_SECONDS * SAMPLE_RATE * CHANNELS * 4;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/;

function requireRequestId(requestId) {
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
    throw new TypeError('人聲波形 requestId 格式不正確');
  }
  return requestId;
}

function validateChunkRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('缺少人聲波形片段參數');
  }
  const { path, start, duration, requestId, sourceStream = 0, sourceChannel = null } = request;
  if (typeof path !== 'string' || !path.trim() || path.length > 32767 || path.includes('\0')) {
    throw new TypeError('缺少有效的母素材路徑');
  }
  requireRequestId(requestId);
  if (typeof start !== 'number' || !Number.isFinite(start) || start < 0) {
    throw new RangeError('人聲波形開始時間必須是非負有限秒數');
  }
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > MAX_CHUNK_SECONDS) {
    throw new RangeError('人聲波形片段必須大於 0 且不超過 36 秒');
  }
  if (!Number.isInteger(sourceStream) || sourceStream < 0 || sourceStream > 255) {
    throw new TypeError('無效的來源音訊串流');
  }
  if (sourceChannel !== null && (!Number.isInteger(sourceChannel) || sourceChannel < 0 || sourceChannel > 63)) {
    throw new TypeError('無效的來源音訊聲道');
  }
  return { path, start, duration, requestId, sourceStream, sourceChannel };
}

function buildChunkArgs(request) {
  const chunk = validateChunkRequest(request);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin',
    '-ss', String(chunk.start), '-i', chunk.path, '-t', String(chunk.duration),
    '-map', `0:a:${chunk.sourceStream}`, '-vn', '-sn', '-dn'];
  const filters = [];
  if (chunk.sourceChannel !== null) filters.push(`pan=stereo|c0=c${chunk.sourceChannel}|c1=c${chunk.sourceChannel}`);
  // 裸 PCM 不保存 PTS；以 seek 後的來源時鐘補出延後開聲／時間戳缺口。
  filters.push(`aresample=${SAMPLE_RATE}:async=1:first_pts=0`);
  args.push('-af', filters.join(','));
  args.push('-ac', String(CHANNELS), '-ar', String(SAMPLE_RATE),
    '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1');
  return args;
}

function abortError() {
  const error = new Error('人聲波形讀取已取消');
  error.name = 'AbortError';
  return error;
}

function createVocalWaveformRuntime({ getFFmpegPath, spawn = nativeSpawn, timeoutMs = 120000 } = {}) {
  if (typeof getFFmpegPath !== 'function' || typeof spawn !== 'function') {
    throw new TypeError('人聲波形 runtime 缺少必要 adapter');
  }
  const active = new Map();
  let closing = false;

  const stop = (entry, error) => {
    if (entry.settled || entry.failure) return false;
    entry.failure = error;
    try { entry.child?.kill('SIGTERM'); } catch (_) {}
    entry.killTimer = setTimeout(() => {
      if (!entry.settled) { try { entry.child?.kill('SIGKILL'); } catch (_) {} }
    }, 1000);
    entry.killTimer.unref?.();
    return true;
  };

  const cancel = (sender, requestId) => {
    const id = requireRequestId(requestId);
    const entry = active.get(sender)?.get(id);
    return entry ? stop(entry, abortError()) : false;
  };

  const readChunk = async (sender, request) => {
    const chunk = validateChunkRequest(request);
    if (closing || !sender || sender.isDestroyed?.()) throw abortError();
    const binary = getFFmpegPath();
    if (!binary) throw new Error('找不到 ffmpeg，無法讀取人聲波形素材');
    let jobs = active.get(sender);
    if (!jobs) { jobs = new Map(); active.set(sender, jobs); }
    if (jobs.has(chunk.requestId)) throw new Error('人聲波形 requestId 重複');
    const entry = { child: null, settled: false, failure: null, killTimer: null, timer: null, finished: null };
    jobs.set(chunk.requestId, entry);
    const destroyed = () => stop(entry, abortError());
    sender.once?.('destroyed', destroyed);
    const buffers = [];
    let size = 0;
    let stderr = Buffer.alloc(0);
    // 每次只可交付本片段長度；最長片段的絕對上限約 12.7 MB。
    const maxBytes = Math.min(MAX_CHUNK_BYTES, Math.ceil(chunk.duration * SAMPLE_RATE) * CHANNELS * 4);
    entry.finished = new Promise((resolve, reject) => {
      const finish = (error = null) => {
        if (entry.settled) return;
        entry.settled = true;
        clearTimeout(entry.timer);
        clearTimeout(entry.killTimer);
        sender.removeListener?.('destroyed', destroyed);
        if (error) { buffers.length = 0; reject(error); return; }
        // 成功解碼可在音訊 EOF 回傳短片段／零 sample，renderer 按來源時間補靜音。
        if (size % (CHANNELS * 4) !== 0) {
          buffers.length = 0;
          reject(new Error('母素材未產生完整的立體聲 PCM 片段'));
          return;
        }
        const bytes = Buffer.concat(buffers, size);
        buffers.length = 0;
        resolve({ samples: Uint8Array.from(bytes).buffer, sampleRate: SAMPLE_RATE, channels: CHANNELS });
      };
      try {
        entry.child = spawn(binary, buildChunkArgs(chunk), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        entry.child.on('error', error => {
          if (entry.settled) return;
          // ChildProcess 的 error 也可能表示 kill 失敗；有存活 PID 時不能當作已關閉。
          if (Number.isInteger(entry.child.pid) && entry.child.pid > 0
            && entry.child.exitCode == null && entry.child.signalCode == null) {
            stop(entry, error);
            return;
          }
          finish(entry.failure || error);
        });
        entry.child.stdout.on('data', bytes => {
          if (entry.settled || entry.failure) return;
          if (size + bytes.length > maxBytes) {
            buffers.length = 0;
            stop(entry, new RangeError('人聲波形 PCM 超過片段大小上限'));
            return;
          }
          size += bytes.length;
          buffers.push(Buffer.from(bytes));
        });
        entry.child.stderr.on('data', bytes => {
          if (entry.settled) return;
          stderr = Buffer.concat([stderr, bytes]).subarray(-65536);
        });
        entry.child.once('close', code => {
          if (entry.failure) { finish(entry.failure); return; }
          if (code !== 0) { finish(new Error(`母素材音訊讀取失敗 (${code})：${stderr.toString('utf8').trim()}`)); return; }
          finish();
        });
        entry.timer = setTimeout(() => stop(entry, new Error('母素材音訊讀取逾時')), timeoutMs);
        entry.timer.unref?.();
        if (sender.isDestroyed?.() || entry.failure) {
          entry.failure ||= abortError();
          try { entry.child.kill('SIGTERM'); } catch (_) {}
        }
      } catch (error) { finish(entry.failure || error); }
    });
    try { return await entry.finished; }
    finally {
      if (jobs.get(chunk.requestId) === entry) jobs.delete(chunk.requestId);
      if (!jobs.size && active.get(sender) === jobs) active.delete(sender);
    }
  };

  const cancelAllAndWait = async ({ timeoutMs: shutdownTimeoutMs = 10000 } = {}) => {
    closing = true;
    const entries = [...active.values()].flatMap(jobs => [...jobs.values()]);
    for (const entry of entries) stop(entry, abortError());
    let timer;
    try {
      await Promise.race([
        Promise.allSettled(entries.map(entry => entry.finished)),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error('人聲波形 FFmpeg 尚未確認關閉');
            error.code = 'VOCAL_WAVE_TERMINATION_PENDING';
            reject(error);
          }, shutdownTimeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); }
  };

  return Object.freeze({
    readChunk, cancel, cancelAllAndWait,
    resume: () => { closing = false; },
    activeCount: () => [...active.values()].reduce((sum, jobs) => sum + jobs.size, 0),
  });
}

module.exports = { createVocalWaveformRuntime, validateChunkRequest, buildChunkArgs,
  SAMPLE_RATE, CHANNELS, MAX_CHUNK_SECONDS, MAX_CHUNK_BYTES };
