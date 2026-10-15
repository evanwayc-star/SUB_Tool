/* Native 母素材身分：stat 與前／中／尾內容取樣，不是整檔 checksum。
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

module.exports = { motherSourceFingerprintSync, motherSourceFingerprint };
