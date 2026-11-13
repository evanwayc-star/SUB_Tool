/* 辨識專用來源 PCM：有界片段、原始聲道、來源時鐘；不建立播放快取或套用 bus。 */
'use strict';

const { spawn: nativeSpawn } = require('child_process');
const { sourceClockSeek, sourceAudioClockFilter } = require('./media-source-clock');

const SAMPLE_RATE = 16000;
const MAX_READ_SECONDS = 600;
const MAX_READ_BYTES = MAX_READ_SECONDS * SAMPLE_RATE * 4;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/;

function requireRequestId(id) {
  if (typeof id !== 'string' || !REQUEST_ID.test(id)) throw new TypeError('辨識音訊 requestId 格式不正確');
  return id;
}

function validateSpeechAudioRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('缺少辨識音訊片段參數');
  const { path, start, duration, sourceStream = 0, sourceChannel = null, processed = false, requestId } = request;
  if (typeof path !== 'string' || !path.trim() || path.length > 32767 || path.includes('\0')) throw new TypeError('缺少有效的音訊來源路徑');
  requireRequestId(requestId);
  if (typeof start !== 'number' || !Number.isFinite(start) || start < 0
    || start > Number.MAX_SAFE_INTEGER / SAMPLE_RATE - MAX_READ_SECONDS) throw new RangeError('辨識音訊開始時間必須是有效的非負秒數');
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > MAX_READ_SECONDS
    || Math.round(duration * SAMPLE_RATE) < 1) throw new RangeError('辨識音訊片段必須至少一個 sample 且不超過 600 秒');
  if (!Number.isInteger(sourceStream) || sourceStream < 0 || sourceStream > 255) throw new TypeError('無效的來源音訊串流');
  if (sourceChannel !== null && (!Number.isInteger(sourceChannel) || sourceChannel < 0 || sourceChannel > 127)) throw new TypeError('無效的來源音訊聲道');
  if (typeof processed !== 'boolean') throw new TypeError('辨識音訊 processed 必須是布林值');
  return Object.freeze({ path, start, duration, sourceStream, sourceChannel, processed, requestId });
}

function buildSpeechAudioArgs(request, media) {
  const chunk = validateSpeechAudioRequest(request);
  const audio = media?.audio?.[chunk.sourceStream];
  if (!audio) throw new RangeError('辨識來源音訊串流不存在');
  const channels = audio.channels;
  if (!Number.isInteger(channels) || channels < 1 || channels > 128
    || (chunk.sourceChannel !== null && chunk.sourceChannel >= channels)) throw new RangeError('辨識來源音訊聲道不存在或超過上限');
  const frames = Math.round(chunk.duration * SAMPLE_RATE);
  const seek = sourceClockSeek(chunk.start, chunk.processed ? null : (media.video || audio));
  // 使用來源 channel 的等權平均，不讓 FFmpeg 的 layout 降混規則或專案 bus 決定辨識內容。
  const mono = chunk.sourceChannel === null
    ? Array.from({ length: channels }, (_, index) => `${1 / channels}*c${index}`).join('+')
    : `c${chunk.sourceChannel}`;
  const filter = [`pan=mono|c0=${mono}`, sourceAudioClockFilter(seek, SAMPLE_RATE),
    `apad=whole_len=${frames}`, `atrim=end_sample=${frames}`].join(',');
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror',
    '-ss', String(seek.seek), '-i', chunk.path, '-t', String(frames / SAMPLE_RATE),
    '-map', `0:a:${chunk.sourceStream}`, '-vn', '-sn', '-dn', '-af', filter,
    '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'];
}

function abortError() { return Object.assign(new Error('辨識音訊讀取已取消'), { name: 'AbortError', code: 'ABORT_ERR' }); }

function createSpeechAudioReader({ getFFmpegPath, probe, spawn = nativeSpawn, timeoutMs = 120000 } = {}) {
  if (typeof getFFmpegPath !== 'function' || typeof probe !== 'function' || typeof spawn !== 'function') {
    throw new TypeError('辨識音訊 reader 缺少必要 adapter');
  }
  const active = new Map();
  let closing = false, resumeWhenIdle = false;
  const resume = () => {
    resumeWhenIdle = true;
    if (active.size) return false;
    closing = false; resumeWhenIdle = false; return true;
  };
  const stop = (entry, error) => {
    if (entry.settled || entry.failure) return false;
    entry.failure = error;
    entry.abort.abort();
    if (entry.child) {
      try { entry.child.kill('SIGTERM'); } catch (_) {}
      entry.killTimer = setTimeout(() => {
        if (!entry.settled) { try { entry.child.kill('SIGKILL'); } catch (_) {} }
      }, 1000);
      entry.killTimer.unref?.();
    }
    return true;
  };
  const cancel = (sender, requestId) => {
    const id = requireRequestId(requestId), entry = active.get(sender);
    return entry?.requestId === id ? stop(entry, abortError()) : false;
  };

  const read = async (sender, request) => {
    const chunk = validateSpeechAudioRequest(request);
    if (closing || !sender || sender.isDestroyed?.()) throw abortError();
    if (active.has(sender)) throw Object.assign(new Error('辨識音訊仍在讀取，請等待本片段完成'), { code: 'SPEECH_AUDIO_BUSY' });
    const binary = getFFmpegPath();
    if (!binary) throw new Error('找不到 ffmpeg，無法讀取辨識音訊');
    const entry = { requestId: chunk.requestId, child: null, failure: null, settled: false,
      abort: new AbortController(), timer: null, killTimer: null, finished: null };
    active.set(sender, entry);
    const destroyed = () => stop(entry, abortError());
    sender.once?.('destroyed', destroyed);
    entry.timer = setTimeout(() => stop(entry, new Error('辨識音訊讀取逾時')), timeoutMs);
    entry.timer.unref?.();
    entry.finished = Promise.resolve().then(async () => {
      if (entry.failure) throw entry.failure;
      const media = await probe(chunk.path, { signal: entry.abort.signal });
      if (entry.failure || closing || sender.isDestroyed?.()) throw entry.failure || abortError();
      const args = buildSpeechAudioArgs(chunk, media);
      const frames = Math.round(chunk.duration * SAMPLE_RATE), maxBytes = frames * 4;
      return new Promise((resolve, reject) => {
        // 一次配置已驗證的片段上限（最長 38.4 MB），stdout 不累積額外 chunk 副本。
        let pcm = new ArrayBuffer(maxBytes), bytes = Buffer.from(pcm), size = 0, stderr = Buffer.alloc(0);
        const finish = error => {
          if (entry.settled) return;
          entry.settled = true;
          if (!error && size !== 0 && size !== maxBytes) error = new Error('辨識音訊 PCM 截斷，未產生完整片段');
          bytes = null; stderr = null;
          if (error) { pcm = null; reject(error); return; }
          // FFmpeg 在整段超過音訊 EOF 時不建立 filter graph。正常零輸出代表此範圍靜音；
          // 有任何輸出則必須由 apad/atrim 交出完整片段，不能掩蓋截斷 bytes。
          resolve({ sampleRate: SAMPLE_RATE, numberOfChannels: 1, frames, pcm });
        };
        try {
          entry.child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
          entry.child.on('error', error => {
            if (entry.settled) return;
            if (Number.isInteger(entry.child.pid) && entry.child.pid > 0
              && entry.child.exitCode == null && entry.child.signalCode == null) { stop(entry, error); return; }
            finish(entry.failure || error);
          });
          entry.child.stdout.on('data', data => {
            if (entry.settled || entry.failure) return;
            if (size + data.length > maxBytes) { stop(entry, new RangeError('辨識音訊 PCM 超過片段大小上限')); return; }
            data.copy(bytes, size); size += data.length;
          });
          entry.child.stderr.on('data', data => {
            if (!entry.settled) stderr = Buffer.concat([stderr, data]).subarray(-65536);
          });
          entry.child.once('close', code => {
            finish(entry.failure || (code !== 0 ? new Error(`辨識音訊讀取失敗 (${code})：${stderr?.toString('utf8').trim() || ''}`) : null));
          });
          if (sender.isDestroyed?.()) stop(entry, abortError());
        } catch (error) { finish(entry.failure || error); }
      });
    });
    try { return await entry.finished; }
    catch (error) { throw entry.failure || error; }
    finally {
      entry.settled = true;
      clearTimeout(entry.timer); clearTimeout(entry.killTimer);
      sender.removeListener?.('destroyed', destroyed);
      if (active.get(sender) === entry) active.delete(sender);
      if (resumeWhenIdle && !active.size) resume();
    }
  };

  const cancelAllAndWait = async ({ timeoutMs: shutdownTimeoutMs = 10000 } = {}) => {
    closing = true; resumeWhenIdle = false;
    const entries = [...active.values()];
    for (const entry of entries) stop(entry, abortError());
    let timer;
    try {
      await Promise.race([Promise.allSettled(entries.map(entry => entry.finished)), new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('辨識音訊 FFmpeg 尚未確認關閉'),
          { code: 'SPEECH_AUDIO_TERMINATION_PENDING' })), shutdownTimeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  };
  return Object.freeze({ read, cancel, cancelAllAndWait, resume, activeCount: () => active.size });
}

module.exports = { createSpeechAudioReader, validateSpeechAudioRequest, buildSpeechAudioArgs,
  SAMPLE_RATE, MAX_READ_SECONDS, MAX_READ_BYTES };
