/* ==============================================================================
   SUB Tool — FFprobe 媒體探測器 (Media Probe Engine)
   ==============================================================================
   【架構與職責】
   封裝原生 `ffprobe` 子行程呼叫，解析影音檔案之格式、時長、視訊編碼寬高、FPS
   以及多軌音訊 Stream 之聲道數、語言與標題。
   
   【穩定度與防禦重點】
   1. 行程終止屏障（Termination Barrier）：確保逾時或取消的 ffprobe 完全關閉釋放後，
      才允許發起下一次探測，避免殭屍行程耗盡系統資源。
   2. 嚴格逾時與 AbortSignal 整合：預設 15 秒逾時，防範損壞媒體導致 ffprobe 永久掛起。
   3. JSON 安全解析與後援計算：處理無有效 FPS 或時長為 0 的特殊邊界。
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
 *   video: {codec: string, width: number, height: number, fps: number|null}|null,
 *   audio: Array<{index: number, streamIndex: number, codec: string, channels: number, lang: string, title: string}>
 * }} 標準化媒體描述
 */
function descriptorOf(document = {}) {
  const streams = Array.isArray(document.streams) ? document.streams : [];
  const video = streams.find(stream => stream?.codec_type === 'video' && !stream?.disposition?.attached_pic) || null;
  const audio = streams.filter(stream => stream?.codec_type === 'audio');

  return {
    duration: finiteNumber(document.format?.duration, finiteNumber(video?.duration, 0)),
    video: video ? {
      codec: video.codec_name || '',
      width: Math.max(0, finiteNumber(video.width, 0)),
      height: Math.max(0, finiteNumber(video.height, 0)),
      fps: fpsOf(video),
    } : null,
    audio: audio.map((stream, index) => ({
      index,
      streamIndex: stream.index,
      codec: stream.codec_name || '',
      channels: Math.max(1, Math.floor(finiteNumber(stream.channels, 1))),
      lang: stream.tags?.language || stream.tags?.LANGUAGE || '',
      title: stream.tags?.title || stream.tags?.TITLE || '',
    })),
  };
}

/**
 * 建立具備終止屏障與逾時控制的 FFprobe 探測器實例。
 * 
 * @param {object} options
 * @param {string} options.executable ffprobe 執行檔路徑
 * @param {Function} [options.spawnProcess=nodeSpawn] 行程啟動注入（測試用）
 * @param {number} [options.timeoutMs=15000] 探測逾時上限（毫秒）
 * @param {number} [options.terminationGraceMs=1000] 行程終止緩衝等待時間（毫秒）
 */
function createMediaProbe({
  executable,
  spawnProcess = nodeSpawn,
  timeoutMs = 15000,
  terminationGraceMs = 1000,
} = {}) {
  let terminationBarrier = Promise.resolve();
  const uncertainProcesses = new Set();

  /**
   * 執行 ffprobe 指令並取得標準輸出字串。
   * @private
   */
  async function run(args, { signal } = {}) {
    if (!executable) throw new Error('找不到 ffprobe');
    await terminationBarrier;
    if (uncertainProcesses.size) {
      const error = new Error('前一個 ffprobe 尚未確認結束');
      error.code = 'PROBE_TERMINATION_PENDING';
      throw error;
    }
    if (signal?.aborted) {
      const error = new Error('ffprobe 已取消');
      error.code = 'PROBE_ABORTED';
      throw error;
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

        try { child.kill(); } catch (killError) {}
      };

      child.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)));
      child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
      child.once('error', error => {
        if (!terminationError) finish(reject, error);
      });
      child.once('close', status => {
        uncertainProcesses.delete(child);
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
          const error = new Error('ffprobe 已取消');
          error.code = 'PROBE_ABORTED';
          terminate(error);
        };
        signal.addEventListener('abort', onAbort, { once: true });
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
  async function hasAudio(filePath) {
    try {
      const stdout = await run([
        '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', filePath,
      ]);
      return !!stdout.trim();
    } catch (error) {
      // 舊專案若無完整聲道規劃，不輕易丟棄音訊，交由 FFmpeg 實際 map 報錯
      return true;
    }
  }

  /**
   * 查詢媒體檔案各音訊 Stream 之聲道數與碼率。
   * @param {string} filePath 媒體檔案路徑
   * @returns {Promise<Array<{channels: number, kbps: number}>>}
   */
  async function audioBitrates(filePath) {
    try {
      const stdout = await run([
        '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=bit_rate,channels', '-of', 'json', filePath,
      ]);
      const streams = JSON.parse(stdout).streams;
      if (!Array.isArray(streams)) return [];
      return streams.map(stream => ({
        channels: Math.max(0, Math.floor(finiteNumber(stream.channels, 0))),
        kbps: Math.max(0, Math.round(finiteNumber(stream.bit_rate, 0) / 1000)),
      }));
    } catch (error) {
      return [];
    }
  }

  return Object.freeze({ describe, hasAudio, audioBitrates });
}

module.exports = { createMediaProbe, descriptorOf };
