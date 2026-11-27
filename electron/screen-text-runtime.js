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
  const limit = input.maxNewRequests;
  if (limit != null && (!Number.isSafeInteger(limit) || limit < 0 || limit > 1000000)) throw new Error('新增請求上限無效');
  return { path: source, start, end, requestId, ...options, samplesPerSecond: sampleFps,
    ...(limit != null && { maxNewRequests:limit }) };
}

function readMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return undefined;
  const result = {};
  for (const key of ['stage', 'model']) if (typeof metrics[key] === 'string') result[key] = metrics[key].slice(0, 128);
  for (const key of ['windows', 'cachedWindows', 'pendingWindows', 'imageAppearances', 'pendingImageAppearances',
    'uniqueFrames', 'reviewMaxWindows', 'reviewWindows', 'pendingReviewWindows', 'newRequests', 'inputTokens',
    'outputTokens', 'cachedInputTokens']) {
    if (Number.isSafeInteger(metrics[key]) && metrics[key] >= 0) result[key] = metrics[key];
  }
  const cost = metrics.estimatedCostUsd;
  if (cost === null || (Number.isFinite(cost) && cost >= 0)) result.estimatedCostUsd = cost;
  return result;
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

  async function recognize(sender, input, planOnly = false) {
    const request = validateScreenTextRequest(input);
    if (sender.isDestroyed()) throw abort();
    if (jobs.has(sender)) throw new Error('畫面文字辨識進行中');
    const needsCredential = !planOnly && request.maxNewRequests !== 0;
    const apiKey = needsCredential ? settings.apiKey(request.provider) : '';
    if (needsCredential && !apiKey) throw new Error('請先在畫面文字辨識設定中儲存 API 金鑰');
    const redact = value => (apiKey ? String(value).split(apiKey).join('[已隱藏金鑰]') : String(value)).slice(-8192);
    const worker = resolve(executable), ffmpeg = resolve(ffmpegPath), ffprobe = resolve(ffprobePath);
    if (!ffmpeg || !ffprobe) throw new Error('找不到 FFmpeg／FFprobe，無法辨識畫面文字');
    let child, failure, saving = false, result, termination = null, terminationFailure = null, errorCloseTimer;
    let checkpoint = { cues: [], processedEnd: request.start }, metrics, providerFailure = false, checkpointTimer;
    const kill = () => {
      if (!child || termination) return;
      try { termination = Promise.resolve(terminateChild(child)).then(() => null, error => error); }
      catch (error) { termination = Promise.resolve(error); }
    };
    const stop = (error = abort()) => {
      providerFailure = false;
      if (failure) return false;
      failure = error;
      kill();
      return true;
    };
    const cancel = keepPartial => {
      if (keepPartial !== true) return stop();
      if (saving || failure) return false;
      saving = true;
      if (child && !planOnly && !child.stdin.destroyed) {
        child.stdin.write('{"type":"checkpoint"}\n', error => { if (error) kill(); });
        checkpointTimer = setTimeout(kill, 2000);
      } else kill();
      return true;
    };
    const cancelled = () => stop();
    const navigation = (event, _url, inPlace, mainFrame) => {
      if ((event.isMainFrame ?? mainFrame) && !(event.isSameDocument ?? inPlace)) stop();
    };
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
        if (failure) return;
        const incomingMetrics = readMetrics(message.metrics);
        if (incomingMetrics) metrics = { ...metrics, ...incomingMetrics };
        if (saving && !(message.type === 'checkpoint' && message.requested === true)) {
          if (message.type === 'result' || message.type === 'error') kill();
          return;
        }
        if (result) throw new Error('畫面文字辨識回傳了重複結果');
        if (message.type === 'error') {
          // The native adapter reports terminal errors after joining its
          // pipeline. Allow that normal exit instead of racing taskkill.
          failure = new Error(recognitionError(redact(message.message || '畫面文字辨識失敗')));
          providerFailure = true;
          errorCloseTimer = setTimeout(kill, 1500);
          return;
        }
        if (message.type === 'progress' && Number.isFinite(message.progress)) {
          onProgress(sender, { requestId: request.requestId,
            ...(metrics && { metrics }),
            progress: Math.min(1, Math.max(0, message.progress)),
            message: typeof message.message === 'string' ? redact(message.message) : '正在辨識畫面文字' });
          return;
        }
        if (planOnly) {
          if (message.type !== 'plan') throw new Error('辨識預覽回應無效');
          const { previewJpeg, previewTime } = message;
          if (!metrics || !Number.isSafeInteger(metrics.windows) || typeof previewJpeg !== 'string' ||
              previewJpeg.length > 2 * 1024 * 1024 || !previewJpeg.startsWith('/9j/') ||
              !Number.isFinite(previewTime) || previewTime < request.start - 0.0001 || previewTime > request.end + 0.0001)
            throw new Error('辨識預覽缺少有效的取樣畫格或用量');
          result = { metrics, previewJpeg, previewTime };
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
        if (saving) { clearTimeout(checkpointTimer); kill(); }
      }, fail);
      // Secrets and application-owned paths go only through the private pipe;
      // renderer input cannot replace tools, cache roots, or credentials.
      child.stdin.write(JSON.stringify({ ...request, ...(planOnly && { operation:'plan' }), apiKey, cacheDir: resolve(cacheDir),
        ffmpegPath: ffmpeg, ffprobePath: ffprobe }) + '\n', 'utf8');
      if (planOnly) child.stdin.end();
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
      const recoverable = providerFailure && !planOnly &&
        (Number.isSafeInteger(metrics?.newRequests) || (checkpoint.processedEnd > request.start && checkpoint.cues.length > 0));
      if (failure && !recoverable) throw failure;
      const currentEvidence = await readSourceEvidence(request.path);
      if (!['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => sourceEvidence[key] === currentEvidence[key])) {
        throw new Error('辨識期間來源影片已變更，未加入字幕，請重新辨識');
      }
      if (failure && providerFailure) return { ...checkpoint, cancelled:true, error:failure.message, ...(metrics && {metrics}) };
      if (saving) return { ...(result || checkpoint), cancelled: true, ...(metrics && {metrics}) };
      if (code !== 0 || !result) throw new Error(redact(stderr.trim() || '畫面文字辨識中斷，未取得完整結果'));
      return metrics ? { ...result, metrics } : result;
    } finally {
      clearTimeout(checkpointTimer);
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
