'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

/** Same mother-file evidence as ingest caches, with asynchronous I/O for remote media. */
async function vocalSourceFingerprint(source, { fileSystem = fsp, platform = process.platform } = {}) {
  const resolved = path.resolve(source);
  const file = await fileSystem.open(resolved, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error('人聲快取來源不是檔案');
    const evidence = stat => [stat.size, stat.mtimeMs, stat.ctimeMs, stat.dev, stat.ino];
    const hash = crypto.createHash('sha256').update(JSON.stringify([
      'vocal-source-v1', platform === 'win32' ? resolved.toLowerCase() : resolved, ...evidence(before),
    ]));
    const firstLength = Math.min(1024 * 1024, before.size);
    const windows = before.size ? [[0, firstLength]] : [];
    if (before.size > firstLength) {
      const length = Math.min(65536, before.size - firstLength);
      windows.push([Math.floor((before.size - length) / 2), length], [before.size - length, length]);
    }
    for (const [position, length] of windows) {
      const bytes = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const result = await file.read(bytes, read, length - read, position + read);
        if (!result.bytesRead) throw new Error('母素材在讀取指紋時變更');
        read += result.bytesRead;
      }
      hash.update(String(position)).update(':').update(bytes);
    }
    // Compare the path as well as the opened handle: replacement cannot preserve an old inode.
    const after = await fileSystem.stat(resolved);
    if (JSON.stringify(evidence(before)) !== JSON.stringify(evidence(after))) throw new Error('母素材在讀取指紋時變更');
    return hash.digest('hex');
  } finally { await file.close(); }
}

module.exports = { vocalSourceFingerprint };
