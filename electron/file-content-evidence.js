'use strict';

const crypto = require('node:crypto');

const sameSnapshot = (left, right) => !!left && !!right && left.isFile() && right.isFile()
  && ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].every(field => left[field] === right[field]);

// A pathname check alone cannot identify the object opened between syscalls.
// Read in bounded blocks and bracket the read with the opened file's evidence.
function digestFileSync(fsModule, file, expected) {
  let descriptor;
  try {
    descriptor = fsModule.openSync(file, 'r');
    const before = fsModule.fstatSync(descriptor, { bigint: true });
    if (!sameSnapshot(before, expected)) throw new Error('檔案內容證據已變更');
    const digest = crypto.createHash('sha256'), chunk = Buffer.allocUnsafe(65536);
    let offset = 0, count;
    while ((count = fsModule.readSync(descriptor, chunk, 0, chunk.length, offset)) > 0) {
      digest.update(chunk.subarray(0, count)); offset += count;
    }
    const after = fsModule.fstatSync(descriptor, { bigint: true });
    if (!sameSnapshot(before, after) || BigInt(offset) !== before.size) throw new Error('檔案讀取期間已變更');
    return digest.digest('hex');
  } finally { if (descriptor !== undefined) fsModule.closeSync(descriptor); }
}

// The initial snapshot can be streamed asynchronously; final publication uses
// digestFileSync so no JavaScript continuation interleaves check and rename.
async function digestFile(fsModule, file, expected) {
  let handle;
  try {
    handle = await fsModule.open(file, 'r');
    const before = await handle.stat({ bigint: true });
    if (!sameSnapshot(before, expected)) throw new Error('檔案內容證據已變更');
    const digest = crypto.createHash('sha256'), chunk = Buffer.allocUnsafe(65536);
    let bytes = 0, bytesRead;
    do {
      ({ bytesRead } = await handle.read(chunk, 0, chunk.length, bytes));
      if (bytesRead) { digest.update(chunk.subarray(0, bytesRead)); bytes += bytesRead; }
    } while (bytesRead);
    const after = await handle.stat({ bigint: true });
    if (!sameSnapshot(before, after) || BigInt(bytes) !== before.size) throw new Error('檔案讀取期間已變更');
    return { digest: digest.digest('hex'), size: BigInt(bytes) };
  } finally { if (handle) await handle.close(); }
}

module.exports = { sameSnapshot, digestFile, digestFileSync };
