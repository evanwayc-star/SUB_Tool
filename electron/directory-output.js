'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { isPathContained } = require('./file-authority');
const { sameSnapshot, digestFileSync } = require('./file-content-evidence');

// Native picker authority stays in main. This module owns the complete filesystem
// operation for both style bundles and subtitle batches, including publication.
function writeDirectoryFiles(directory, files, { fsModule = fs, randomUUID = crypto.randomUUID, rootEvidence = null } = {}) {
  const root = fsModule.realpathSync(directory);
  const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
  const rootOwner = fsModule.lstatSync(root, { bigint: true });
  if (!rootOwner.isDirectory() || rootOwner.isSymbolicLink()) throw new Error('匯出目錄不是實體資料夾');
  if (rootEvidence && (root !== rootEvidence.path || rootOwner.dev !== rootEvidence.dev || rootOwner.ino !== rootEvidence.ino))
    throw Object.assign(new Error('匯出目錄在等待期間已變更'), { code: 'UNSAFE_DIRECTORY_OUTPUT' });

  const unsafe = () => Object.assign(new Error('匯出路徑超出所選實體目錄或包含連結'), { code: 'UNSAFE_DIRECTORY_OUTPUT' });
  const statIfPresent = file => {
    try { return fsModule.lstatSync(file, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const checkParents = parents => {
    for (const parent of parents) {
      const current = statIfPresent(parent.file);
      if (!current || !current.isDirectory() || current.isSymbolicLink() || !sameFile(current, parent.owner)) throw unsafe();
      if (!isPathContained(root, fsModule.realpathSync(parent.file))) throw unsafe();
    }
  };
  const prepareParents = target => {
    const parents = [{ file: root, owner: rootOwner }];
    let current = root;
    const relative = path.relative(root, path.dirname(target));
    for (const segment of relative ? relative.split(path.sep) : []) {
      checkParents(parents);
      current = path.join(current, segment);
      let owner = statIfPresent(current);
      if (!owner) {
        try { fsModule.mkdirSync(current); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        owner = statIfPresent(current);
      }
      if (!owner || !owner.isDirectory() || owner.isSymbolicLink()) throw unsafe();
      parents.push({ file: current, owner });
    }
    checkParents(parents);
    return parents;
  };
  const conflict = () => Object.assign(new Error('匯出期間目的檔已變更，請重新選擇輸出位置'), { code: 'DIRECTORY_OUTPUT_CONFLICT' });
  const checkTarget = target => {
    const existing = statIfPresent(target);
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw unsafe();
    if (!existing) return null;
    let digest;
    try { digest = digestFileSync(fsModule, target, existing); }
    catch (_) { throw conflict(); }
    if (!sameSnapshot(existing, statIfPresent(target))) throw conflict();
    return { stat: existing, digest };
  };
  const assertTargetUnchanged = (target, before) => {
    const current = statIfPresent(target);
    if ((current === null) !== (before === null)
      || (current && (!current.isFile() || current.isSymbolicLink()
        || !sameSnapshot(current, before.stat)))) throw conflict();
    if (current) {
      try {
        if (digestFileSync(fsModule, target, before.stat) !== before.digest
          || !sameSnapshot(statIfPresent(target), before.stat)) throw conflict();
      } catch (error) {
        if (error.code === 'DIRECTORY_OUTPUT_CONFLICT') throw error;
        throw conflict();
      }
    }
  };
  const evidenceFields = ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'];
  const sameEvidence = (left, right) => left && right && left.isFile() && right.isFile()
    && !left.isSymbolicLink() && !right.isSymbolicLink()
    && evidenceFields.every(field => left[field] === right[field]);
  const sameBytes = (descriptor, bytes) => {
    const chunk = Buffer.allocUnsafe(Math.min(65536, Math.max(bytes.length, 1)));
    for (let offset = 0; offset < bytes.length;) {
      const count = fsModule.readSync(descriptor, chunk, 0, Math.min(chunk.length, bytes.length - offset), offset);
      if (!count || !chunk.subarray(0, count).equals(bytes.subarray(offset, offset + count))) return false;
      offset += count;
    }
    return true;
  };

  let written = 0, blocked = 0, conflicted = 0;
  for (const entry of Array.isArray(files) ? files : []) {
    const data = entry && (entry.content ?? entry.b64);
    if (!entry || typeof entry.name !== 'string' || !entry.name || typeof data !== 'string') continue;
    const target = path.resolve(root, entry.name);
    if (target === root || !isPathContained(root, entry.name)
      || (process.platform === 'win32' && path.relative(root, target).includes(':'))) {
      blocked++;
      continue;
    }
    let temporary = null, descriptor = null, temporaryOwner = null, writtenEvidence = null, completed = null, preserveTemporary = false, bytes;
    try {
      const parents = prepareParents(target);
      const destinationBefore = checkTarget(target);
      // Stage at the picked root, so a replaced nested parent cannot strand the
      // private file or redirect writes. The final rename replaces the selected
      // name rather than truncating the inode behind an existing hardlink.
      temporary = path.join(root, `.directory-output-${randomUUID()}.tmp`);
      descriptor = fsModule.openSync(temporary, 'wx+');
      temporaryOwner = fsModule.fstatSync(descriptor, { bigint: true });
      bytes = Buffer.from(data, 'base64');
      fsModule.writeFileSync(descriptor, bytes);
      writtenEvidence = fsModule.fstatSync(descriptor, { bigint: true });
      fsModule.fsyncSync(descriptor);
      completed = fsModule.fstatSync(descriptor, { bigint: true });
      const changedStage = () => { preserveTemporary = true; throw unsafe(); };
      if (!completed.isFile() || !sameFile(completed, temporaryOwner) || completed.size !== BigInt(bytes.length)) changedStage();
      // Verify the actual bytes, including edits made through another handle
      // before the completed stat was taken. Keep memory bounded for large files.
      if (!sameBytes(descriptor, bytes)) changedStage();
      if (!sameEvidence(completed, fsModule.fstatSync(descriptor, { bigint: true }))) changedStage();
      fsModule.closeSync(descriptor);
      descriptor = null;
      checkParents(parents);
      assertTargetUnchanged(target, destinationBefore);
      const current = statIfPresent(temporary);
      if (!sameEvidence(current, completed)) changedStage();
      try {
        const digest = crypto.createHash('sha256').update(bytes).digest('hex');
        if (digestFileSync(fsModule, temporary, completed) !== digest
          || !sameEvidence(statIfPresent(temporary), completed)) changedStage();
      } catch (_) { changedStage(); }
      fsModule.renameSync(temporary, target);
      temporary = null;
      written++;
    } catch (error) {
      if (error.code !== 'UNSAFE_DIRECTORY_OUTPUT' && error.code !== 'DIRECTORY_OUTPUT_CONFLICT') throw error;
      blocked++;
      if (error.code === 'DIRECTORY_OUTPUT_CONFLICT') conflicted++;
    } finally {
      if (descriptor !== null) {
        if (!temporaryOwner) {
          try { temporaryOwner = fsModule.fstatSync(descriptor, { bigint: true }); } catch (error) {}
        }
        // Retain the first operation error while still closing the owned handle.
        try { fsModule.closeSync(descriptor); } catch (error) {}
      }
      if (temporary && temporaryOwner && !preserveTemporary) {
        try {
          checkParents([{ file: root, owner: rootOwner }]);
          const current = statIfPresent(temporary);
          // A failed write can leave an arbitrary partial file, including bytes
          // written by another handle. Without a completed write snapshot only
          // the unchanged, empty reservation is safe to remove.
          const evidence = completed || writtenEvidence || temporaryOwner;
          if (current && !current.isSymbolicLink() && sameFile(current, temporaryOwner)
            && (writtenEvidence || temporaryOwner.size === 0n) && sameEvidence(current, evidence)) {
            let matches = true, readDescriptor;
            if (writtenEvidence) {
              try {
                readDescriptor = fsModule.openSync(temporary, 'r');
                const opened = fsModule.fstatSync(readDescriptor, { bigint: true });
                // A successful write can be followed by an external append
                // before fstat or by an fsync failure. Matching only the
                // expected prefix must never authorize deleting that suffix.
                matches = current.size === BigInt(bytes.length) && sameEvidence(current, opened) && sameBytes(readDescriptor, bytes)
                  && sameEvidence(opened, fsModule.fstatSync(readDescriptor, { bigint: true }));
              } catch (_) { matches = false; }
              finally { if (readDescriptor !== undefined) { try { fsModule.closeSync(readDescriptor); } catch (_) { matches = false; } } }
            }
            if (matches && sameEvidence(current, statIfPresent(temporary))) fsModule.unlinkSync(temporary);
          }
        } catch (error) { if (error.code !== 'UNSAFE_DIRECTORY_OUTPUT') throw error; }
      }
    }
  }
  return { written, blocked, ...(conflicted ? { conflicted } : {}) };
}

// The whole batch reserves its valid targets before it waits or starts a worker.
// This retains admission order across project saves without blocking unrelated
// targets; the worker keeps the original file-ownership checks.
function createDirectoryOutputRuntime({ coordinator } = {}) {
  if (!coordinator || typeof coordinator.withCommitTargets !== 'function') throw new TypeError('缺少輸出提交協調器');
  const operations = new Set();
  let closing = false, closePromise = null, lifecycle = 0;
  function write(directory, files) {
    if (closing) return Promise.reject(new Error('程式正在關閉，無法匯出檔案'));
    let root, owner;
    try {
      root = fs.realpathSync(directory);
      owner = fs.lstatSync(root, { bigint: true });
      if (!owner.isDirectory() || owner.isSymbolicLink()) throw new Error('匯出目錄不是實體資料夾');
    } catch (error) { return Promise.reject(error); }
    const snapshot = Array.isArray(files) ? files.map(entry => entry && ({
      name: entry.name, content: entry.content, b64: entry.b64,
    })) : [];
    const rootEvidence = { path: root, dev: owner.dev, ino: owner.ino };
    const candidates = [], targets = [];
    let blocked = 0;
    for (const entry of snapshot) {
      const data = entry && (entry.content ?? entry.b64);
      if (!entry || typeof entry.name !== 'string' || !entry.name || typeof data !== 'string') continue;
      const target = path.resolve(root, entry.name);
      if (target === root || !isPathContained(root, entry.name)
        || (process.platform === 'win32' && path.relative(root, target).includes(':'))) { blocked++; continue; }
      candidates.push(entry); targets.push(target);
    }
    const run = (accepted, rejectedCount) => new Promise((resolve, reject) => {
      let message, failure;
      const worker = new Worker(__filename, { workerData: { task:'directory-output', directory, files:accepted, rootEvidence } });
      worker.once('message', value => { message = value; });
      worker.once('error', error => { failure = error; });
      worker.once('exit', code => {
        if (failure) return reject(failure);
        if (code !== 0 || !message) return reject(new Error(`匯出工作程序未正常結束（${code}）`));
        if (!message.ok) {
          const error = new Error(message.message);
          if (message.code) error.code = message.code;
          return reject(error);
        }
        resolve({ ...message.result, blocked:message.result.blocked + blocked + rejectedCount });
      });
    });
    const job = targets.length ? coordinator.withCommitTargets(targets, ({rejectedIndices}) => {
      const rejected = new Set(rejectedIndices);
      return run(candidates.filter((_entry, index) => !rejected.has(index)), rejected.size);
    }, {allowPartial:true}) : Promise.resolve({written:0,blocked});
    operations.add(job);
    job.finally(() => operations.delete(job)).catch(() => {});
    return job;
  }
  function close() {
    closing = true; lifecycle++;
    if (!closePromise) {
      closePromise = (async () => { while (operations.size) await Promise.allSettled([...operations]); })()
        .finally(() => { closePromise = null; });
    }
    return closePromise;
  }
  async function resume() {
    const generation = lifecycle;
    if (closePromise) await closePromise;
    if (generation !== lifecycle) return false;
    closing = false; return true;
  }
  return { write, close, resume };
}

if (!isMainThread && workerData?.task === 'directory-output') {
  try {
    parentPort.postMessage({ ok:true, result:writeDirectoryFiles(workerData.directory, workerData.files, {rootEvidence:workerData.rootEvidence}) });
  } catch (error) {
    parentPort.postMessage({ ok:false, message:error?.message || String(error), code:error?.code });
  }
}

module.exports = { writeDirectoryFiles, createDirectoryOutputRuntime };
