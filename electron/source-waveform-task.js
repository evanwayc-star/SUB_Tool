'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const { createMediaIntakeRuntime, cacheKeyFor } = require('./media-intake-runtime');
const { FileAuthority } = require('./file-authority');
const { sharedSourceFingerprintSync } = require('./mother-source-evidence');
const { sameSnapshot } = require('./file-content-evidence');
const { captureOutputDirectory, captureOutputAuthority } = require('./export-lease');

const pending = new Map(); let serial = 0, nativeProgress, nativePcm;
const cancellation = new Int32Array(workerData.cancellation);
const cancelled = () => !!Atomics.load(cancellation, 0);
const send = value => parentPort.postMessage(value);
function call(type, data, transfer = []) {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject }); parentPort.postMessage({ type, id, ...data }, transfer);
  });
}
parentPort.on('message', message => {
  if (message.type === 'nativeProgress') { nativeProgress?.(message.payload); return; }
  if (message.type === 'nativePcm') {
    try { nativePcm?.(Buffer.from(message.bytes)); send({ type: 'pcmAck', id: message.id }); }
    catch (error) { send({ type: 'pcmAck', id: message.id, error: { message: error.message, code: error.code, name: error.name } }); }
    return;
  }
  const entry = pending.get(message.id); if (!entry) return;
  pending.delete(message.id);
  if (message.error) entry.reject(Object.assign(new Error(message.error.message), message.error));
  else entry.resolve(message.value);
});
async function run() {
  const { request, cacheRoot, allowSidecarCache, cacheAuthority } = workerData;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-wave-task-'));
  const tempAuthority = captureOutputDirectory(tempRoot);
  const fileAuthority = new FileAuthority({ internalDirectories: [tempRoot, cacheRoot] });
  if (request.src) fileAuthority.grantTrustedFile(request.src);
  if (cacheAuthority) captureOutputAuthority(path.join(cacheRoot, '.wave-worker-check'), cacheAuthority);
  const runtime = createMediaIntakeRuntime({ tempRoot, tempRootAuthority: tempAuthority, cacheRoot, allowSidecarCache, fileAuthority,
    describeAudio: () => call('describe'),
    sendProgress: (_target, payload) => send({ type: 'progress', payload: payload.done ? { ...payload, done: false } : payload }),
    ffmpegExecution: { execute: async (args, options) => {
      const { onProgress, onPcm, onProcess: _onProcess, ...plain } = options;
      nativeProgress = onProgress; nativePcm = onPcm;
      try { return await call('execute', { args, options: plain }); } finally { nativeProgress = null; nativePcm = null; }
    } },
  });
  let prepared;
  try {
    if (workerData.operation === 'cache-info') {
      const result = runtime.cacheInfo(request.src, { isCancelled: cancelled });
      await call('publish', { result });send({ type: 'complete' });return;
    }
    const shared = allowSidecarCache ? sharedSourceFingerprintSync(request.src) : null;
    prepared = await runtime.waveform(request, { isCancelled: cancelled });
    const check = () => {
      if (cancelled()) throw Object.assign(new Error('波形工作已取消'), { code: 'INGEST_SUPERSEDED' });
      if (cacheKeyFor(request.src) !== prepared.sourceKey || (shared && sharedSourceFingerprintSync(request.src) !== shared))
        throw new Error('母素材在波形交接期間變更，請重新載入');
    };
    check();
    let bytes;
    if (prepared.temporary) {
      captureOutputAuthority(prepared.wave, tempAuthority);
      const before = fs.lstatSync(prepared.wave, { bigint: true }), fd = fs.openSync(prepared.wave, 'r');
      try {
        if (!sameSnapshot(before, fs.fstatSync(fd, { bigint: true }))) throw new Error('波形暫存身分已變更');
        bytes = Uint8Array.from(fs.readFileSync(fd));
        if (!sameSnapshot(before, fs.fstatSync(fd, { bigint: true })) || !sameSnapshot(before, fs.lstatSync(prepared.wave, { bigint: true })))
          throw new Error('波形暫存內容已變更');
      } finally { fs.closeSync(fd); }
    }
    check();
    await call('publish', { result: { ...prepared, ...(bytes ? { wave: null, bytes } : {}) } }, bytes ? [bytes.buffer] : []);
    check();
    send({ type: 'complete' });
  } finally {
    if (prepared?.temporary) runtime.cleanupGeneratedFile(prepared.wave);
    await runtime.close();
    // Only remove our still-owned, empty directory. Unknown replacements stay.
    try { captureOutputAuthority(path.join(tempRoot, '.cleanup'), tempAuthority); fs.rmdirSync(tempRoot); } catch (_) {}
  }
}
run().catch(error => send({ type: 'error', error: { message: error.message, code: error.code, name: error.name } }))
  .finally(() => parentPort.close());
