/* Native 母素材身分：本機指紋使用 stat 與前／中／尾取樣；可攜式指紋讀完整 bytes。
   快取 namespace／digest 長度由各 owner 決定；這裡不授權路徑或管理產物。 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

function fileEvidence(stat) {
  return [stat.size, stat.mtimeMs, stat.ctimeMs, stat.dev, stat.ino];
}

function sampleWindows(size) {
  if (!size) return [];
  const firstLength = Math.min(1024 * 1024, size);
  const windows = [[0, firstLength]];
  if (size > firstLength) {
    const length = Math.min(65536, size - firstLength);
    windows.push([Math.floor((size - length) / 2), length], [size - length, length]);
  }
  return windows;
}

function beginEvidence(resolved, stat, namespace, platform) {
  if (!stat.isFile()) throw new TypeError('母素材來源不是檔案');
  const evidence = fileEvidence(stat);
  const hash = crypto.createHash('sha256').update(JSON.stringify([
    namespace, platform === 'win32' ? resolved.toLowerCase() : resolved, ...evidence,
  ]));
  return { evidence, hash, windows: sampleWindows(stat.size) };
}

function requireSampleRead(bytesRead) {
  if (!bytesRead) throw new Error('母素材在讀取指紋時變更');
}

function appendSample(hash, position, bytes) {
  hash.update(String(position)).update(':').update(bytes);
}

function finishEvidence(before, after, digestLength) {
  // 核對路徑目前指向的檔案，而非只核對仍開著的舊 handle。
  if (JSON.stringify(before.evidence) !== JSON.stringify(fileEvidence(after))) {
    throw new Error('母素材在讀取指紋時變更');
  }
  return before.hash.digest('hex').slice(0, digestLength);
}

// 跨電腦只有完整內容可識別同一份母素材；本機路徑／檔案身分僅用於
// 讀取期間的變更檢查，不參與可攜式 digest。固定 buffer 避免大檔整份載入。
async function portableSourceFingerprint(source, {
  shouldContinue = () => true, fileSystem = fsp,
} = {}) {
  const current = () => {
    if (!shouldContinue()) {
      const error = new Error('母素材內容驗證已被較新的載入取代');
      error.name = 'AbortError'; error.code = 'INGEST_SUPERSEDED';
      throw error;
    }
  };
  current();
  const resolved = path.resolve(source);
  const file = await fileSystem.open(resolved, 'r');
  let digest;
  try {
    current();
    const stat = await file.stat();
    current();
    if (!stat.isFile()) throw new TypeError('母素材來源不是檔案');
    if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw new Error('母素材檔案大小無效');
    const before = fileEvidence(stat), hash = crypto.createHash('sha256');
    const bytes = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (position < stat.size) {
      current();
      const length = Math.min(bytes.length, stat.size - position);
      const { bytesRead } = await file.read(bytes, 0, length, position);
      current();
      if (!Number.isInteger(bytesRead) || bytesRead <= 0 || bytesRead > length) {
        throw new Error('母素材在讀取指紋時變更');
      }
      hash.update(bytes.subarray(0, bytesRead));
      position += bytesRead;
    }
    const handleStat = await file.stat();
    current();
    const pathStat = await fileSystem.stat(resolved);
    current();
    if (!pathStat.isFile() || [handleStat, pathStat].some(after =>
      JSON.stringify(before) !== JSON.stringify(fileEvidence(after)))) {
      throw new Error('母素材在讀取指紋時變更');
    }
    digest = hash.digest('hex');
  } finally { await file.close(); }
  current();
  return digest;
}

function motherSourceFingerprintSync(source, {
  namespace = 'mother-source-v1', digestLength = 64, fileSystem = fs, platform = process.platform,
} = {}) {
  const resolved = path.resolve(source);
  const file = fileSystem.openSync(resolved, 'r');
  try {
    const before = beginEvidence(resolved, fileSystem.fstatSync(file), namespace, platform);
    for (const [position, length] of before.windows) {
      const bytes = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const count = fileSystem.readSync(file, bytes, read, length - read, position + read);
        requireSampleRead(count);
        read += count;
      }
      appendSample(before.hash, position, bytes);
    }
    return finishEvidence(before, fileSystem.statSync(resolved), digestLength);
  } finally { fileSystem.closeSync(file); }
}

async function motherSourceFingerprint(source, {
  namespace = 'mother-source-v1', digestLength = 64, fileSystem = fsp, platform = process.platform,
} = {}) {
  const resolved = path.resolve(source);
  const file = await fileSystem.open(resolved, 'r');
  try {
    const before = beginEvidence(resolved, await file.stat(), namespace, platform);
    for (const [position, length] of before.windows) {
      const bytes = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await file.read(bytes, read, length - read, position + read);
        requireSampleRead(bytesRead);
        read += bytesRead;
      }
      appendSample(before.hash, position, bytes);
    }
    return finishEvidence(before, await fileSystem.stat(resolved), digestLength);
  } finally { await file.close(); }
}

module.exports = { motherSourceFingerprintSync, motherSourceFingerprint, portableSourceFingerprint };
