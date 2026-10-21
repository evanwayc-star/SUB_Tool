/* ==============================================================================
   SUB Tool — FFprobe 媒體探測器 (Media Probe Engine)
   ==============================================================================
   【架構與職責】
   封裝原生 `ffprobe` 子行程呼叫，解析影音檔案之格式、時長、視訊編碼寬高、FPS
   以及多軌音訊 Stream 之聲道數、語言與標題。
   
   【穩定度與防禦重點】
   1. 行程終止屏障（Termination Barrier）：確保逾時或取消的 ffprobe 完全關閉釋放後，
      才允許發起下一次探測，避免殭屍行程耗盡系統資源。
   2. 有界探測與 AbortSignal 整合：預設 60 秒，容許慢速儲存，但不讓損壞媒體永久掛起。
   3. JSON 安全解析與後援計算：處理無有效 FPS 或時長為 0 的特殊邊界。
   4. 最多兩個原生工作，同一指令的無取消請求共用進行中工作；完成後不保留 metadata。
   ============================================================================== */
'use strict';

const { spawn: nodeSpawn } = require('child_process');

/**
 * 數值安全轉換函式。
 * @param {*} value
 * @param {number} [fallback=0]
 * @returns {number}
 */
function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * 從 Stream 屬性安全計算精確格率 (FPS)。
 * @param {object} [stream] ffprobe stream 描述物件
 * @returns {number|null} 浮點格率值，若無效則回傳 null
 */
function fpsOf(stream) {
  const raw = stream?.avg_frame_rate;
  if (typeof raw !== 'string' || raw === '0/0') return null;
  const [numerator, denominator] = raw.split('/').map(Number);
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
    ? numerator / denominator
    : null;
}

/**
 * 將 ffprobe JSON 輸出結構轉換為標準化之媒體資訊描述物件。
 * 
 * @param {object} [document={}] ffprobe JSON 解析結果
 * @returns {{
 *   duration: number,
 *   video: {codec: string, width: number, height: number, sampleAspectRatio?: string, pixelFormat?: string,
 *     colorSpace?: string, colorPrimaries?: string, colorTransfer?: string, colorRange?: string,
 *     fps: number|null, timestampOffset: number, presentationTimestampOffset: number}|null,
 *   audio: Array<{index: number, streamIndex: number, codec: string, channels: number, lang: string, title: string, timestampOffset: number, presentationTimestampOffset: number}>
 * }} 標準化媒體描述
 */
function descriptorOf(document = {}) {
  const streams = Array.isArray(document.streams) ? document.streams : [];
  const video = streams.find(stream => stream?.codec_type === 'video' && !stream?.disposition?.attached_pic) || null;
  const audio = streams.filter(stream => stream?.codec_type === 'audio');
  const starts = streams.map(stream => Number(stream?.start_time)).filter(Number.isFinite);
  const containerStart = finiteNumber(document.format?.start_time, starts.length ? Math.min(...starts) : 0);
  // FFmpeg 在 input 層減去容器起點；預覽聲道再轉回影片來源第零秒。
  // 保留實際 decoder PTS，不能 STARTPTS 後重加 stream header 的 primer。
  const videoStart = finiteNumber(video?.start_time, containerStart);
  // Matroska / WebM 的 format.duration 是絕對結束 PTS；MOV 等格式則是容器時長。
  // 對外時長以影片第零秒為起點，同時保留比影片更晚結束的音訊尾端。
  const matroska = String(document.format?.format_name || '').split(',').some(name => name === 'matroska' || name === 'webm');
  const formatDuration = Number(document.format?.duration);
  const duration = Number.isFinite(formatDuration)
    ? Math.max(0, formatDuration + (matroska ? 0 : containerStart) - videoStart)
    : finiteNumber(video?.duration, 0);

  return {
    duration,
    video: video ? {
      codec: video.codec_name || '',
      width: Math.max(0, finiteNumber(video.width, 0)),
      height: Math.max(0, finiteNumber(video.height, 0)),
      ...(video.sample_aspect_ratio ? { sampleAspectRatio: video.sample_aspect_ratio } : {}),
      ...(video.pix_fmt ? { pixelFormat: video.pix_fmt } : {}),
      ...(video.color_space ? { colorSpace: video.color_space } : {}),
      ...(video.color_primaries ? { colorPrimaries: video.color_primaries } : {}),
      ...(video.color_transfer ? { colorTransfer: video.color_transfer } : {}),
      ...(video.color_range ? { colorRange: video.color_range } : {}),
      fps: fpsOf(video),
      timestampOffset: containerStart - videoStart,
      // HTML 與 MP4 edit-list／WebCodecs 保留絕對呈現 PTS；FFmpeg／mpv
      // 的 input 時鐘則已扣除容器起點。兩個 adapter 不能共用 raw epoch。
      presentationTimestampOffset: -videoStart || 0,
    } : null,
    audio: audio.map((stream, index) => ({
      index,
      streamIndex: stream.index,
      codec: stream.codec_name || '',
      channels: Math.max(1, Math.floor(finiteNumber(stream.channels, 1))),
      lang: stream.tags?.language || stream.tags?.LANGUAGE || '',
      title: stream.tags?.title || stream.tags?.TITLE || '',
      timestampOffset: containerStart - videoStart,
      presentationTimestampOffset: -videoStart || 0,
    })),
  };
}

/**
 * 建立具備終止屏障與逾時控制的 FFprobe 探測器實例。
 * 
 * @param {object} options
 * @param {string} options.executable ffprobe 執行檔路徑
 * @param {Function} [options.spawnProcess=nodeSpawn] 行程啟動注入（測試用）
 * @param {number} [options.timeoutMs=60000] 行程啟動後的探測逾時上限（毫秒）
 * @param {number} [options.maxConcurrent=2] 原生工作並行上限
 * @param {number} [options.terminationGraceMs=1000] 行程終止緩衝等待時間（毫秒）
 */
function createMediaProbe({
  executable,
  spawnProcess = nodeSpawn,
  timeoutMs = 60000,
  maxConcurrent = 2,
  terminationGraceMs = 1000,
} = {}) {
  let terminationBarrier = Promise.resolve();
  const uncertainProcesses = new Set();
  const inFlight = new Map();
  const queue = [];
  const jobs = new Set();
  const pending = new Set();
  const processes = new Map();
  const concurrency = Number.isFinite(maxConcurrent) ? Math.max(1, Math.floor(maxConcurrent)) : 2;
  let active = 0;
  let shuttingDown = false, shutdownPromise = null, resumeWhenIdle = false;

  function resumeIfIdle() {
    if (!resumeWhenIdle || pending.size || processes.size) return false;
    shuttingDown = false;
    shutdownPromise = null;
    resumeWhenIdle = false;
    return true;
  }

  function abortError() {
    const error = new Error('ffprobe 已取消');
    error.code = 'PROBE_ABORTED';
    return error;
  }

  function drain() {
    while (!shuttingDown && active < concurrency && queue.length) {
      const job = queue.shift();
      job.signal?.removeEventListener('abort', job.onAbort);
      if (job.signal?.aborted) {
        job.reject(abortError());
        continue;
      }
      active++;
      execute(job.args, { signal: job.signal }).then(value => {
        active--;
        job.resolve(value);
        drain();
      }, error => {
        active--;
        job.reject(error);
        drain();
      });
    }
  }

  function schedule(args, signal) {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    if (signal?.aborted) controller.abort();
    let job;
    const result = new Promise((resolve, reject) => {
      if (shuttingDown || controller.signal.aborted) {
        reject(abortError());
        return;
      }
      job = { args, signal: controller.signal, controller, resolve, reject, onAbort: null };
      job.onAbort = () => {
        const index = queue.indexOf(job);
        if (index < 0) return;
        queue.splice(index, 1);
        job.signal.removeEventListener('abort', job.onAbort);
        reject(abortError());
      };
      job.signal.addEventListener('abort', job.onAbort, { once: true });
      jobs.add(job);
      queue.push(job);
      drain();
    });
    pending.add(result);
    const forget = () => {
      signal?.removeEventListener('abort', forwardAbort);
      jobs.delete(job);
      pending.delete(result);
      resumeIfIdle();
    };
    result.then(forget, forget);
    return result;
  }

  function run(args, { signal } = {}) {
    if (shuttingDown) return Promise.reject(abortError());
    // 有取消所有者的工作各自保留 native lifecycle，避免一個 caller 中止其他 caller。
    if (signal) return schedule(args, signal);
    const key = JSON.stringify(args);
    const existing = inFlight.get(key);
    if (existing) return existing;
    const result = schedule(args);
    inFlight.set(key, result);
    const forget = () => { if (inFlight.get(key) === result) inFlight.delete(key); };
    result.then(forget, forget);
    return result;
  }

  /**
   * 執行 ffprobe 指令並取得標準輸出字串。
   * @private
   */
  async function execute(args, { signal } = {}) {
    if (!executable) throw new Error('找不到 ffprobe');
    let observedBarrier;
    do {
      observedBarrier = terminationBarrier;
      await observedBarrier;
    } while (observedBarrier !== terminationBarrier);
    if (uncertainProcesses.size) {
      const error = new Error('前一個 ffprobe 尚未確認結束');
      error.code = 'PROBE_TERMINATION_PENDING';
      throw error;
    }
    if (shuttingDown || signal?.aborted) {
      throw abortError();
    }

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnProcess(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        reject(error);
        return;
      }

      const stdout = [];
      const stderr = [];
      let settled = false;
      let timer = null;
      let terminationTimer = null;
      let onAbort = null;
      let terminationError = null;
      let releaseTermination = null;
      let resolveClosed;
      const closed = new Promise(resolve => { resolveClosed = resolve; });

      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (terminationTimer) clearTimeout(terminationTimer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        releaseTermination?.();
        callback(value);
      };

      const terminate = error => {
        if (settled || terminationError) return;
        terminationError = error;
        if (timer) clearTimeout(timer);
        timer = null;
        uncertainProcesses.add(child);
        const processClosed = new Promise(res => { releaseTermination = res; });
        const previousBarrier = terminationBarrier;
        terminationBarrier = Promise.all([previousBarrier, processClosed]).then(() => undefined);

        terminationTimer = setTimeout(() => {
          const timeoutError = new Error(`ffprobe 終止後超過 ${terminationGraceMs}ms 未關閉`);
          timeoutError.code = 'PROBE_TERMINATION_TIMEOUT';
          timeoutError.cause = terminationError;
          finish(reject, timeoutError);
        }, terminationGraceMs);

        try { child.kill('SIGTERM'); } catch (killError) {}
      };

      processes.set(child, { closed, terminate });

      child.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)));
      child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
      // Repeated kill failures still belong to this native lifecycle. The
      // termination intent is set before kill(), so another error cannot reenter it.
      child.on('error', error => {
        if (!terminationError) terminate(error);
      });
      child.once('close', status => {
        processes.delete(child);
        resolveClosed();
        uncertainProcesses.delete(child);
        resumeIfIdle();
        if (terminationError) {
          finish(reject, terminationError);
          return;
        }
        if (status !== 0) {
          const error = new Error(Buffer.concat(stderr).toString('utf8').trim() || 'ffprobe 失敗');
          error.code = 'PROBE_FAILED';
          finish(reject, error);
          return;
        }
        finish(resolve, Buffer.concat(stdout).toString('utf8'));
      });

      timer = setTimeout(() => {
        const error = new Error(`ffprobe 超過 ${timeoutMs}ms 未完成`);
        error.code = 'PROBE_TIMEOUT';
        terminate(error);
      }, timeoutMs);

      if (signal) {
        onAbort = () => {
          terminate(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
    });
  }

  /**
   * 探測媒體檔案之完整音視訊描述。
   * @param {string} filePath 媒體檔案路徑
   * @param {object} [options]
   * @returns {Promise<ReturnType<typeof descriptorOf>>}
   */
  async function describe(filePath, options) {
    const stdout = await run(['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath], options);
    let document;
    try {
      document = JSON.parse(stdout);
    } catch (cause) {
      const error = new Error('ffprobe 回傳無法解析的 JSON');
      error.code = 'PROBE_PARSE';
      error.cause = cause;
      throw error;
    }
    return descriptorOf(document);
  }

  /**
   * 快速檢查媒體檔案是否包含音訊軌。
   * @param {string} filePath 媒體檔案路徑
   * @returns {Promise<boolean>}
   */
  async function hasAudio(filePath, options) {
    try {
      const stdout = await run([
        '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', filePath,
      ], options);
      return !!stdout.trim();
    } catch (error) {
      if (shuttingDown || options?.signal?.aborted || error.code === 'PROBE_ABORTED'
        || error.cause?.code === 'PROBE_ABORTED') throw error;
      // 舊專案若無完整聲道規劃，不輕易丟棄音訊，交由 FFmpeg 實際 map 報錯
      return true;
    }
  }

  // Stream start times are part of the source A/V synchronization contract.
  // A compressed audio stream can start before video to carry encoder priming;
  // resetting the two streams independently would turn that primer into delay.
  async function audioVideoStartOffsets(filePath, options) {
    const stdout = await run([
      '-v', 'error', '-show_entries', 'stream=codec_type,start_time:stream_disposition=attached_pic',
      '-of', 'json', filePath,
    ], options);
    const streams = JSON.parse(stdout).streams || [];
    const video = streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
    const audio = streams.filter(stream => stream.codec_type === 'audio');
    const videoStart = Number(video?.start_time);
    return audio.map(stream => {
      const audioStart = Number(stream.start_time);
      return Number.isFinite(videoStart) && Number.isFinite(audioStart)
        ? audioStart - videoStart : 0;
    });
  }

  /**
   * 查詢媒體檔案各音訊 Stream 之聲道數與碼率。
   * @param {string} filePath 媒體檔案路徑
   * @returns {Promise<Array<{channels: number, kbps: number}>>}
   */
  async function audioBitrates(filePath, options) {
    try {
      const stdout = await run([
        '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=bit_rate,channels', '-of', 'json', filePath,
      ], options);
      const streams = JSON.parse(stdout).streams;
      if (!Array.isArray(streams)) return [];
      return streams.map(stream => ({
        channels: Math.max(0, Math.floor(finiteNumber(stream.channels, 0))),
        kbps: Math.max(0, Math.round(finiteNumber(stream.bit_rate, 0) / 1000)),
      }));
    } catch (error) {
      if (shuttingDown || options?.signal?.aborted || error.code === 'PROBE_ABORTED'
        || error.cause?.code === 'PROBE_ABORTED') throw error;
      return [];
    }
  }

  function cancelAllAndWait({ timeoutMs: closeTimeoutMs = 5000 } = {}) {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    resumeWhenIdle = false;
    for (const job of jobs) job.controller.abort();
    // timeout/error 已讓 caller 收斂的 child 仍由此 owner 持有，直到實際 close。
    for (const entry of processes.values()) entry.terminate(abortError());
    let timer;
    const drained = Promise.all([
      Promise.allSettled([...pending]),
      Promise.all([...processes.values()].map(entry => entry.closed)),
    ]);
    const attempt = Promise.race([drained, new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        for (const child of processes.keys()) { try { child.kill('SIGKILL'); } catch (_) {} }
        const error = new Error('ffprobe 尚未確認全部關閉');
        error.code = 'PROBE_TERMINATION_PENDING';
        reject(error);
      }, closeTimeoutMs);
    })]).finally(() => clearTimeout(timer));
    shutdownPromise = attempt;
    attempt.catch(() => { if (shutdownPromise === attempt) shutdownPromise = null; });
    return attempt;
  }

  return Object.freeze({ describe, hasAudio, audioVideoStartOffsets, audioBitrates, cancelAllAndWait,
    resume() { resumeWhenIdle = true; return resumeIfIdle(); } });
}

module.exports = { createMediaProbe, descriptorOf };
