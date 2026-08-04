/* ==============================================================================
   SUB Tool — 匯出工作的准入政策（"electron/export-admission.js"）
   ==============================================================================

   「這份匯出工作可不可以進佇列，以及它需要哪些檔案能力？」

   這是一組**決策**，不是排程。它回答四件事，全部在工作真的開始轉檔【之前】：

     1. 輸出副檔名與 format 一致嗎？          （renderer 與主程序各有一份格式表）
     2. 同一個輸出檔是不是已經被佔用？        （OUTPUT_BUSY）
     3. 來源檔案都經過授權，而且都是母素材嗎？（鐵律 §0.8：不可拿播放快取匯出）
     4. 輸出位置經過授權嗎？

   【為什麼要有這個接縫】
   這四條規則原本散在 electron/main.js 裡，與 BrowserWindow、dialog、
   ffmpeg spawn、佇列廣播糾纏在一起。main.js 起不了 vitest，所以它們
   **一行測試都沒有**——而第 3 條正是鐵律 §0.8 的守門員：
   拿 proxy.mp4 或 chN.m4a 去匯出，成品會是 720p 的預覽畫質或錯的聲道，
   而畫面、進度、完成通知全部正常。

   main.js 先前的抽取都是沿著「這段是不是純的」在切，於是所有【有狀態】的
   東西都留下了。本檔沿著「這是不是一項職責」切：准入是一項職責，
   它需要的外部能力全部由建構時注入，因此可以在 vitest 裡完整測試。

   排程（並行度、暫停、processQueue）、視窗生命週期與 IPC 接線仍留在 main.js，
   那些是另一項職責，尚未抽出。
============================================================================== */
const path = require('path');

/**
 * @param {object} deps 全部由呼叫端注入——本模組不 require electron、不碰檔案系統
 * @param {(format:string)=>string} deps.expectedExtensionFor  format → 預期副檔名（不含點）
 * @param {(outPath:string)=>string} deps.outputKeyFor         輸出路徑 → 佔用鍵（大小寫／路徑正規化）
 * @param {(payload:object, sourcePaths:string[])=>string[]} deps.mergeSourcePaths
 * @param {()=>Array} deps.currentJobs                         目前佇列裡的工作
 * @param {(status:string)=>boolean} deps.reservesOutput       這個狀態算不算佔用輸出
 * @param {(file:string)=>boolean} deps.canReadSource
 * @param {(file:string)=>boolean} deps.canWriteDelivery
 * @param {(file:string)=>boolean} deps.isPreviewCacheMedia    §0.8：是不是播放快取
 */
function createExportAdmission(deps) {
  const {
    expectedExtensionFor, outputKeyFor, mergeSourcePaths, currentJobs,
    reservesOutput, canReadSource, canWriteDelivery, isPreviewCacheMedia,
  } = deps;

  const fail = (message, code) => {
    const error = new Error(message);
    error.code = code;
    return error;
  };

  /** 輸出路徑 → 佔用鍵。缺路徑就是資料有問題，不可以靜靜放過。 */
  function outputKey(job) {
    const outPath = job?.payload?.outPath;
    if (typeof outPath !== 'string' || !outPath.trim()) {
      throw fail('匯出工作缺少有效的輸出路徑', 'INVALID_OUTPUT_PATH');
    }
    return outputKeyFor(outPath);
  }

  /* renderer 用一份 format→副檔名的表組出 outPath，主程序用另一份驗它。
     兩份目前只靠人工維持一致；這裡是它們真正相遇的地方。 */
  function assertOutputFormat(job) {
    const outPath = job?.payload?.outPath;
    const expected = expectedExtensionFor(job?.payload?.format);
    const actual = typeof outPath === 'string' ? path.extname(outPath).slice(1).toLowerCase() : '';
    if (actual === expected) return expected;
    throw fail(
      `匯出格式 ${job?.payload?.format || '(empty)'} 必須使用 .${expected} 副檔名`,
      'INVALID_OUTPUT_EXTENSION',
    );
  }

  /* 同一個輸出檔同時被兩份交付寫入＝後者覆蓋前者，而兩邊都會回報成功。
     注意這是【入列時】的檢查；export-watchdog 那邊另有一道磁碟上的 lease，
     在真正 spawn 前再擋一次。兩道時機不同，都需要。 */
  function assertOutputAvailable(job, excludeId = job?.id) {
    const key = outputKey(job);
    for (const existing of currentJobs()) {
      if (!existing || existing.id === excludeId || !reservesOutput(existing.status)) continue;
      let existingKey;
      try { existingKey = outputKey(existing); } catch (error) { continue; }
      if (existingKey !== key) continue;
      const error = fail(`同一個輸出檔案已在匯出佇列中：${job.payload.outPath}`, 'OUTPUT_BUSY');
      error.conflictingJobId = existing.id;
      throw error;
    }
    return key;
  }

  /* 匯出 payload 是 renderer 的資料快照，不能因為進了佇列就自動升格成檔案能力。 */
  function sourcePathsOf(job) {
    return mergeSourcePaths(job?.payload, job?.sourcePaths);
  }

  /** 鐵律 §0.8：交付只准讀母素材，絕不可回退播放快取（proxy.mp4／chNN.m4a）。 */
  function assertMasterMedia(file, kind) {
    if (isPreviewCacheMedia(file)) {
      throw fail(`${kind} 匯出不能使用 Proxy 或播放快取。請重新連結母素材後再匯出。`, 'PREVIEW_CACHE_MEDIA');
    }
  }

  /**
   * 入列前的完整檢查。通過才可以進佇列。
   * @returns {string[]} 這份工作實際需要讀取的來源路徑
   */
  function assertJobAdmissible(job) {
    assertOutputFormat(job);
    const sourcePaths = sourcePathsOf(job);
    for (const sourcePath of sourcePaths) {
      if (!canReadSource(sourcePath)) {
        throw fail(`匯出來源未經授權：${sourcePath}`, 'UNAUTHORIZED_PATH');
      }
      assertMasterMedia(sourcePath, '匯出來源');
    }
    if (!canWriteDelivery(job?.payload?.outPath)) {
      throw fail(`匯出輸出位置未經授權：${job?.payload?.outPath}`, 'UNAUTHORIZED_OUTPUT_PATH');
    }
    return sourcePaths;
  }

  return {
    outputKey, assertOutputFormat, assertOutputAvailable,
    sourcePathsOf, assertMasterMedia, assertJobAdmissible,
  };
}

module.exports = { createExportAdmission };
