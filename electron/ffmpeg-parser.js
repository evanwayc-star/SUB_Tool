/* ==============================================================================
   SUB Tool — FFmpeg 輸出解析與錯誤分析器 (FFmpeg Output & Error Parser)
   ==============================================================================
   【架構與職責】
   1. `FFmpegOutputParser`：即時解析 FFmpeg stderr 輸出進度（百分比、預估剩餘時間 ETA、編碼速度）。
   2. `FFmpegErrorAnalyzer`：當轉檔失敗時，解析 stderr 記錄並轉譯為清晰的繁體中文錯誤摘要。
   ============================================================================== */
'use strict';

/**
 * FFmpeg 輸出即時進度解析器。
 */
class FFmpegOutputParser {
  /**
   * @param {number} [duration=0] 來源視訊總長度（秒）
   */
  constructor(duration = 0) {
    this.duration = Math.max(0, Number(duration) || 0);
    this.speeds = [];
    this.maps = [];
  }

  /**
   * 解析一段 FFmpeg stderr 輸出文字區塊。
   * 
   * @param {string} chunk stderr 輸出字串片段
   * @returns {{pct: number, etaS: number|null}|null} 進度百分比與剩餘秒數，若未比對出時碼則回傳 null
   */
  parseChunk(chunk) {
    if (typeof chunk !== 'string') return null;

    // 解析轉檔速率 (speed=2.5x)
    const sMatch = /speed=\s*([\d.]+)x/.exec(chunk);
    if (sMatch) {
      const speedVal = parseFloat(sMatch[1]);
      if (Number.isFinite(speedVal) && speedVal > 0) {
        this.speeds.push(speedVal);
        if (this.speeds.length > 5) this.speeds.shift();
      }
    }

    // 擷取 Stream 映射對應關係
    for (const mm of chunk.matchAll(/Stream #\d+:\d+ -> #\d+:\d+ \(([^\n]*)\)/g)) {
      if (this.maps.length < 8) this.maps.push(mm[1]);
    }

    // 解析目前進度時碼 (time=00:01:23.45)
    const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(chunk);
    if (m && this.duration > 0) {
      const t = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
      let etaS = null;
      if (this.speeds.length > 0) {
        const avgSpeed = this.speeds.reduce((a, b) => a + b, 0) / this.speeds.length;
        if (avgSpeed > 0) {
          etaS = Math.max(0, (this.duration - t) / avgSpeed);
        }
      }
      const pct = Math.max(0, Math.min(99, Math.round((t / this.duration) * 100)));
      return { pct, etaS };
    }
    return null;
  }
}

/**
 * FFmpeg 執行錯誤分析器。
 */
class FFmpegErrorAnalyzer {
  /**
   * 分析完整 FFmpeg stderr log 與結束代碼，產出簡明扼要之錯誤摘要。
   * 
   * @param {string} fullLog 完整 stderr 日誌字串
   * @param {number} code 行程 exit code
   * @param {object} [watchdogFailure] Watchdog 監控器發布之錯誤
   * @param {object} [watchdogResult] Watchdog 清理結果
   * @param {string} [outPath] 輸出檔案路徑
   * @returns {{summary: string, errorCode: string}} 繁體中文錯誤摘要與錯誤代碼
   */
  static analyze(fullLog = '', code, watchdogFailure, watchdogResult, outPath) {
    let summary = '';
    const logStr = typeof fullLog === 'string' ? fullLog : '';
    const mNoSuchFile = logStr.match(/(.*): No such file or directory/);

    if (watchdogFailure?.code === 'OUTPUT_BUSY') {
      summary = `同一個輸出檔案正在由另一份工作使用：${outPath || ''}`;
    } else if (watchdogFailure?.message) {
      summary = watchdogFailure.message;
    } else if (watchdogResult?.cleanup?.retainedLease) {
      summary = watchdogResult.cleanup.error?.message || '半成品尚未安全刪除，輸出鎖已保留';
    } else if (mNoSuchFile) {
      summary = `找不到來源檔：${mNoSuchFile[1]}`;
    } else if (logStr.includes('No space left on device')) {
      summary = '磁碟空間不足';
    } else if (logStr.match(/Unknown encoder '([^']+)'/)) {
      summary = `編碼器不可用：${logStr.match(/Unknown encoder '([^']+)'/)[1]}`;
    } else if (logStr.includes('Permission denied')) {
      const mPerm = logStr.match(/(.*): Permission denied/);
      summary = '輸出路徑無寫入權限' + (mPerm ? `：${mPerm[1]}` : '');
    } else if (logStr.includes('Filtergraph') && (logStr.includes('parse error') || logStr.includes('error parsing'))) {
      summary = 'Filtergraph 解析失敗';
    } else {
      const lines = logStr.split('\n');
      if (lines.length <= 40) {
        summary = lines.join('\n');
      } else {
        summary = lines.slice(0, 20).join('\n') + '\n...\n' + lines.slice(-20).join('\n');
      }
    }

    const errorCode = watchdogFailure?.code || (watchdogResult?.cleanup?.retainedLease ? 'PARTIAL_CLEANUP_FAILED' : 'FFMPEG_EXIT');
    return { summary, errorCode };
  }
}

module.exports = {
  FFmpegOutputParser,
  FFmpegErrorAnalyzer,
};
