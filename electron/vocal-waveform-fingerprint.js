'use strict';

const { motherSourceFingerprint } = require('./mother-source-evidence');

/** Same mother-file evidence as ingest caches, with asynchronous I/O for remote media. */
function vocalSourceFingerprint(source, options = {}) {
  // 原生 PCM 已採影片第零秒；隔離以容器秒數讀取的舊持久峰值。
  return motherSourceFingerprint(source, { ...options, namespace: 'vocal-source-v2', digestLength: 64 });
}

module.exports = { vocalSourceFingerprint };
