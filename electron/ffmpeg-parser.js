'use strict';

class FFmpegOutputParser {
  constructor(duration) {
    this.duration = duration;
    this.speeds = [];
    this.maps = [];
  }

  /**
   * Parse a chunk of stderr from FFmpeg.
   * @param {string} chunk - The stderr output chunk
   * @returns {Object|null} Progress data if a time match is found, else null.
   */
  parseChunk(chunk) {
    const sMatch = /speed=\s*([\d.]+)x/.exec(chunk);
    if (sMatch) {
      this.speeds.push(parseFloat(sMatch[1]));
      if (this.speeds.length > 5) this.speeds.shift();
    }

    for (const mm of chunk.matchAll(/Stream #\d+:\d+ -> #\d+:\d+ \(([^\n]*)\)/g)) {
      if (this.maps.length < 8) this.maps.push(mm[1]);
    }

    const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(chunk);
    if (m && this.duration) {
      const t = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
      let etaS = null;
      if (this.speeds.length > 0) {
        const avgSpeed = this.speeds.reduce((a, b) => a + b, 0) / this.speeds.length;
        if (avgSpeed > 0) etaS = (this.duration - t) / avgSpeed;
      }
      const pct = Math.min(99, Math.round((t / this.duration) * 100));
      return { pct, etaS };
    }
    return null;
  }
}

class FFmpegErrorAnalyzer {
  /**
   * Analyze the full FFmpeg log and exit code to produce a concise summary.
   * @param {string} fullLog - The complete stderr output
   * @param {number} code - Exit code
   * @param {Object} [watchdogFailure] - Error emitted by export watchdog
   * @param {Object} [watchdogResult] - Final completion result of watchdog
   * @param {string} [outPath] - The output file path (for context)
   * @returns {Object} { summary, errorCode }
   */
  static analyze(fullLog, code, watchdogFailure, watchdogResult, outPath) {
    let summary = '';
    const mNoSuchFile = fullLog.match(/(.*): No such file or directory/);

    if (watchdogFailure?.code === 'OUTPUT_BUSY') {
      summary = `同一個輸出檔案正在由另一份工作使用：${outPath}`;
    } else if (watchdogFailure?.message) {
      summary = watchdogFailure.message;
    } else if (watchdogResult?.cleanup?.retainedLease) {
      summary = watchdogResult.cleanup.error?.message || '半成品尚未安全刪除，輸出鎖已保留';
    } else if (mNoSuchFile) {
      summary = `找不到來源檔：${mNoSuchFile[1]}`;
    } else if (fullLog.includes('No space left on device')) {
      summary = '磁碟空間不足';
    } else if (fullLog.match(/Unknown encoder '([^']+)'/)) {
      summary = `編碼器不可用：${fullLog.match(/Unknown encoder '([^']+)'/)[1]}`;
    } else if (fullLog.includes('Permission denied')) {
      const mPerm = fullLog.match(/(.*): Permission denied/);
      summary = `輸出路徑無寫入權限` + (mPerm ? `：${mPerm[1]}` : '');
    } else if (fullLog.includes('Filtergraph') && (fullLog.includes('parse error') || fullLog.includes('error parsing'))) {
      summary = 'Filtergraph 解析失敗';
    } else {
      const lines = fullLog.split('\n');
      if (lines.length <= 40) summary = lines.join('\n');
      else summary = lines.slice(0, 20).join('\n') + '\n...\n' + lines.slice(-20).join('\n');
    }

    const errorCode = watchdogFailure?.code || (watchdogResult?.cleanup?.retainedLease ? 'PARTIAL_CLEANUP_FAILED' : 'FFMPEG_EXIT');
    return { summary, errorCode };
  }
}

module.exports = {
  FFmpegOutputParser,
  FFmpegErrorAnalyzer,
};
