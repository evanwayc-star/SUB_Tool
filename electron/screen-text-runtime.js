'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { validateScreenTextOptions } = require('./screen-text-settings');
const { SCREEN_TEXT_DEFAULTS } = require('../shared/screen-text-options.cjs');

const MAX_LINE_LENGTH = 32 * 1024 * 1024;

function validateScreenTextRequest(input) {
  const { path: source, start, end, samplesPerSecond = SCREEN_TEXT_DEFAULTS.sampleFps, requestId } = input || {};
  if (typeof source !== 'string' || !path.isAbsolute(source) || source.includes('\0')) throw new Error('缺少影片來源路徑');
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end <= start) throw new Error('辨識範圍無效');
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(requestId)) throw new Error('無效的辨識工作編號');
  const { sampleFps, ...options } = validateScreenTextOptions({ ...input, sampleFps: samplesPerSecond });
  return { path: source, start, end, requestId, ...options, samplesPerSecond: sampleFps };
}

function readMessages(output, receive, fail) {
  const parts = [];
  let size = 0;
  function append(value) {
    size += value.length;
    if (size > MAX_LINE_LENGTH) throw new Error('辨識結果超出單次傳輸上限');
    parts.push(value);
  }
  function flush() {
    const line = parts.join('').trim();
    size = 0;
    parts.length = 0;
    if (line) receive(JSON.parse(line));
  }
  output.setEncoding('utf8');
  output.on('data', chunk => {
    try {
      const lines = chunk.split('\n');
      for (const line of lines.slice(0, -1)) { append(line); flush(); }
      append(lines.at(-1));
    } catch (error) { fail(error); }
  });
  output.on('end', () => { try { flush(); } catch (error) { fail(error); } });
}

// The Rust process owns decoder children. Stop the live tree, never a PID
// recovered from an old cache file, before allowing the next recognition job.
function terminateWorker(child) {
  if (!child.pid) { child.kill('SIGKILL'); return Promise.resolve(); }
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    const failed = () => {
      child.kill('SIGKILL');
      reject(new Error('無法確認畫面辨識的影音子程序已停止，請重新啟動 SUB Tool 後再試'));
    };
    const timer = setTimeout(() => { killer.kill(); failed(); }, 5000);
    killer.once('error', () => { clearTimeout(timer); failed(); });
    killer.once('close', code => { clearTimeout(timer); if (code) failed(); else resolve(); });
  });
}

function readCues(message, start, end) {
  if (!Array.isArray(message.cues)) throw new Error('畫面文字辨識回傳了無效結果');
  const cues = message.cues.map(cue => cue && ({ ...cue,
    start: cue.start < start ? normalizeTimeBoundary(cue.start, start) : cue.start,
    end: cue.end > end ? normalizeTimeBoundary(cue.end, end) : cue.end,
  }));
  if (!cues.every(cue => cue
    && Number.isFinite(cue.start) && Number.isFinite(cue.end)
    && cue.start >= start && cue.end <= end && cue.end > cue.start
    && typeof cue.text === 'string' && cue.text.trim()
    && ['card', 'dialogue'].includes(cue.kind)
    && (cue.slot === undefined || ['bottom', 'center', 'top_left', 'top_right', 'floating'].includes(cue.slot)))) {
    throw new Error('畫面文字辨識回傳了無效結果');
  }
  return cues.map(({ start, end, text, kind, slot }) => ({ start, end, text, kind,
    ...(slot === undefined ? {} : { slot }) }));
}

function normalizeTimeBoundary(value, boundary) {
  if (!Number.isFinite(value) || !Number.isFinite(boundary)) return value;
  const magnitude = Math.max(Math.abs(value), Math.abs(boundary));
  const ulp = Math.max(Number.MIN_VALUE, 2 ** (Math.floor(Math.log2(magnitude)) - 52));
  // JSON parsers and start + duration can differ by a few binary rounding
  // steps. Absorb only that arithmetic noise, never a frame/sample tolerance.
  return Math.abs(value - boundary) <= 4 * ulp ? boundary : value;
}

function recognitionError(message) {
  if (/project_spend_limit_exceeded|insufficient_quota|credit_balance_exhausted/.test(message)) {
    return '雲端 API 額度或專案支出上限已達。請至供應商平台調整額度，或改用其他可用金鑰後重試；已完成的視窗快取會保留。';
  }
  if (/HTTP 401|invalid_api_key|API_KEY_INVALID/.test(message)) return '雲端 API 金鑰無效或已失效，請更新金鑰後重試。';
  return message;
}

function createScreenTextRuntime({ executable, settings, cacheDir, ffmpegPath, ffprobePath,
  onProgress, spawnChild = spawn, terminateChild = terminateWorker,
  readSourceEvidence = source => fs.stat(source, { bigint: true }) }) {
  const jobs = new Map();
  const abort = () => new Error('已取消畫面文字辨識');
  const resolve = value => typeof value === 'function' ? value() : value;

  async function recognize(sender, input) {
    const request = validateScreenTextRequest(input);
    if (sender.isDestroyed()) throw abort();
    if (jobs.has(sender)) throw new Error('畫面文字辨識進行中');
    const apiKey = settings.apiKey(request.provider);
    if (!apiKey) throw new Error('請先在畫面文字辨識設定中儲存 API 金鑰');
    const redact = value => String(value).split(apiKey).join('[已隱藏金鑰]').slice(-8192);
    const worker = resolve(executable), ffmpeg = resolve(ffmpegPath), ffprobe = resolve(ffprobePath);
    if (!ffmpeg || !ffprobe) throw new Error('找不到 FFmpeg／FFprobe，無法辨識畫面文字');
    let child, failure, saving = false, result, termination = null, terminationFailure = null, errorCloseTimer;
    let checkpoint = { cues: [], processedEnd: request.start };
    const kill = () => {
      if (!child || termination) return;
      try { termination = Promise.resolve(terminateChild(child)).then(() => null, error => error); }
      catch (error) { termination = Promise.resolve(error); }
    };
    const stop = (error = abort()) => {
      if (failure) return false;
      failure = error;
      kill();
      return true;
    };
    const cancel = keepPartial => {
      if (keepPartial !== true) return stop();
      if (saving || failure) return false;
      saving = true;
      kill();
      return true;
    };
    const cancelled = () => stop();
    const navigation = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) stop(); };
    let finishJob;
    const closed = new Promise(done => { finishJob = done; });
    jobs.set(sender, { requestId: request.requestId, stop, cancel, closed });
    sender.once('destroyed', cancelled);
    sender.once('render-process-gone', cancelled);
    sender.on('did-start-navigation', navigation);
    try {
      const sourceEvidence = await readSourceEvidence(request.path);
      if (failure) throw failure;
      if (saving) return { ...checkpoint, cancelled: true };
      child = spawnChild(worker, [], {
        cwd: path.dirname(worker), windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const exited = new Promise(done => child.once('close', done));
      const fail = error => { if (!failure && !saving) stop(new Error(redact(error.message))); };
      let stderr = '';
      child.once('error', error => {
        failure ||= error.code === 'ENOENT'
          ? new Error('找不到畫面文字辨識引擎，請執行 npm run native:prepare:card-vision 或重新安裝 SUB Tool')
          : new Error(redact(error.message));
      });
      child.stdin.on('error', fail);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
      readMessages(child.stdout, message => {
        if (failure || saving) return;
        if (result) throw new Error('畫面文字辨識回傳了重複結果');
        if (message.type === 'error') {
          // The native adapter reports terminal errors after joining its
          // pipeline. Allow that normal exit instead of racing taskkill.
          failure = new Error(recognitionError(redact(message.message || '畫面文字辨識失敗')));
          errorCloseTimer = setTimeout(kill, 1500);
          return;
        }
        if (message.type === 'progress' && Number.isFinite(message.progress)) {
          onProgress(sender, { requestId: request.requestId,
            progress: Math.min(1, Math.max(0, message.progress)),
            message: typeof message.message === 'string' ? redact(message.message) : '正在辨識畫面文字' });
          return;
        }
        const through = normalizeTimeBoundary(
          normalizeTimeBoundary(message.processedEnd, checkpoint.processedEnd), request.end);
        if (!['checkpoint', 'result'].includes(message.type) || !Number.isFinite(through)
          || through < checkpoint.processedEnd || through > request.end
          || (message.type === 'result' && through !== request.end)) throw new Error('畫面文字辨識回傳了無效的已處理範圍');
        const snapshot = { cues: readCues(message, request.start, through), processedEnd: through };
        if (message.type === 'checkpoint') checkpoint = snapshot;
        else result = snapshot;
      }, fail);
      // Secrets and application-owned paths go only through the private pipe;
      // renderer input cannot replace tools, cache roots, or credentials.
      child.stdin.end(JSON.stringify({ ...request, apiKey, cacheDir: resolve(cacheDir),
        ffmpegPath: ffmpeg, ffprobePath: ffprobe }) + '\n', 'utf8');
      const code = await exited;
      clearTimeout(errorCloseTimer);
      child = null;
      if (termination) {
        const error = await termination;
        // Normal worker completion joins decoder/network threads. Otherwise
        // an unconfirmed process tree keeps admission and app shutdown closed.
        if (error && code !== 0) {
          const cleanupError = redact(error.message);
          terminationFailure = new Error(failure ? `${failure.message}；${cleanupError}` : cleanupError);
          throw terminationFailure;
        }
      }
      if (failure) throw failure;
      const currentEvidence = await readSourceEvidence(request.path);
      if (!['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => sourceEvidence[key] === currentEvidence[key])) {
        throw new Error('辨識期間來源影片已變更，未加入字幕，請重新辨識');
      }
      if (saving) return { ...(result || checkpoint), cancelled: true };
      if (code !== 0 || !result) throw new Error(redact(stderr.trim() || '畫面文字辨識中斷，未取得完整結果'));
      return result;
    } finally {
      clearTimeout(errorCloseTimer);
      if (!terminationFailure) jobs.delete(sender);
      sender.removeListener('destroyed', cancelled);
      sender.removeListener('render-process-gone', cancelled);
      sender.removeListener('did-start-navigation', navigation);
      finishJob(terminationFailure);
    }
  }

  function cancel(sender, requestId, keepPartial = false) {
    const job = jobs.get(sender);
    return job && job.requestId === requestId ? job.cancel(keepPartial) : false;
  }
  async function cancelAllAndWait() {
    const pending = [...jobs.values()];
    if (!pending.length) return;
    for (const job of pending) job.stop();
    let timer;
    try {
      await Promise.race([
        Promise.all(pending.map(job => job.closed.then(error => { if (error) throw error; }))),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('畫面文字辨識程序尚未關閉')), 10000); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  return { recognize, cancel, cancelAllAndWait };
}

module.exports = { createScreenTextRuntime, validateScreenTextRequest };
