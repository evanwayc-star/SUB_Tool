'use strict';

const fs = require('node:fs');
const path = require('node:path');

// This is an in-process ordering seam, not an OS lock. All participants must
// still validate their own directory, target and content immediately before
// publishing; a different process is not constrained by this coordinator.
function createFileCommitCoordinator({ io = fs.promises, caseInsensitive = process.platform === 'win32' } = {}) {
  const tails = new Map();
  const operations = new Set();
  let admission = Promise.resolve();
  let closed = false, closing = null, lifecycle = 0;
  const keyOf = value => caseInsensitive ? value.toLowerCase() : value;
  const identity = (left, right) => !!left && !!right && left.dev === right.dev && left.ino === right.ino;
  const unsafe = message => Object.assign(new Error(message), { code:'UNSAFE_COMMIT_TARGET' });
  const statIfPresent = async file => {
    try { return await io.lstat(file, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };

  async function resolveTarget(file, signal) {
    if (typeof file !== 'string' || !file || file.includes('\0')) throw new TypeError('目的檔路徑無效');
    signal?.throwIfAborted();
    const requested = path.resolve(file), requestedParent = path.dirname(requested);
    // Batch exports may create nested folders only after admission. Resolve the
    // nearest existing ancestor and retain the missing suffix in the key, so
    // the same target remains locked once those folders are later created.
    const missing = [];
    let anchor = requestedParent, parent;
    for (;;) {
      try { parent = await io.realpath(anchor); break; }
      catch (error) {
        if (error.code !== 'ENOENT' || path.dirname(anchor) === anchor) throw error;
        missing.unshift(path.basename(anchor)); anchor = path.dirname(anchor);
      }
    }
    const parentBefore = await statIfPresent(parent);
    if (!parentBefore?.isDirectory() || parentBefore.isSymbolicLink()) throw unsafe('目的檔父目錄無法確認');
    const targetParent = path.join(parent, ...missing);
    const target = path.join(targetParent, path.basename(requested));
    const before = missing.length ? null : await statIfPresent(target);
    let actual = target;
    if (before) {
      if (!before.isFile() || before.isSymbolicLink()) throw unsafe('目的檔不是一般檔案');
      // realpath expands Windows 8.3 names but does not conflate distinct hard
      // links: their real directory entries retain their distinct names.
      actual = await io.realpath(target);
      if (keyOf(path.dirname(actual)) !== keyOf(targetParent)) throw unsafe('目的檔超出父目錄');
      const [after, real] = await Promise.all([statIfPresent(target), statIfPresent(actual)]);
      if (!after?.isFile() || after.isSymbolicLink() || !real?.isFile() || real.isSymbolicLink()
        || !identity(before, after) || !identity(before, real)) throw unsafe('目的檔在解析期間已變更');
    } else if (!missing.length && await statIfPresent(target)) throw unsafe('目的檔在解析期間已變更');
    const [parentAfter, parentPath] = await Promise.all([statIfPresent(parent), io.realpath(anchor)]);
    signal?.throwIfAborted();
    if (!parentAfter?.isDirectory() || parentAfter.isSymbolicLink() || !identity(parentBefore, parentAfter)
      || keyOf(parentPath) !== keyOf(parent)) throw unsafe('目的檔父目錄在解析期間已變更');
    // A missing suffix appearing while resolving could have acquired another
    // physical alias. Reject this observation instead of guessing its key.
    if (missing.length && await statIfPresent(path.join(parent, missing[0])))
      throw unsafe('目的檔父目錄在解析期間已變更');
    signal?.throwIfAborted();
    return keyOf(actual);
  }

  function reserveKey(key) {
    const prior = tails.get(key) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    // Even a cancelled waiter must not let its successor pass the current
    // owner; its gate is chained after the prior owner rather than replacing it.
    const tail = prior.then(() => gate);
    tails.set(key, tail);
    tail.finally(() => { if (tails.get(key) === tail) tails.delete(key); });
    return { prior, release };
  }

  async function waitForReservation(reservation, signal) {
    signal?.throwIfAborted();
    let onAbort;
    try {
      if (signal) {
        const cancelled = new Promise((_, reject) => {
          onAbort = () => reject(signal.reason || new Error('等待目的檔已取消'));
          signal.addEventListener('abort', onAbort, { once: true });
        });
        await Promise.race([reservation.prior, cancelled]);
      } else await reservation.prior;
      signal?.throwIfAborted();
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  function withCommitTargets(paths, work, { signal, allowPartial = false } = {}) {
    if (!Array.isArray(paths) || (!paths.length && !allowPartial) || typeof work !== 'function') throw new TypeError('缺少目的檔或提交工作');
    if (closed) return Promise.reject(Object.assign(new Error('程式正在關閉，無法提交檔案'), { code:'FILE_COMMIT_CLOSED' }));
    const requested = [...paths];
    // Resolution and reservation are admitted in call order. Slow alias
    // discovery must not let a later job reserve the same target first. Locks
    // are registered before waiting, so unrelated targets can still run.
    const reserved = admission.then(async () => {
      signal?.throwIfAborted();
      const outcomes = await Promise.allSettled(requested.map(file => resolveTarget(file, signal)));
      signal?.throwIfAborted();
      if (!allowPartial) {
        const failed = outcomes.find(outcome => outcome.status === 'rejected');
        if (failed) throw failed.reason;
      }
      const rejectedIndices = [], keys = [];
      outcomes.forEach((outcome, index) => {
        if (outcome.status === 'rejected') {
          if (outcome.reason?.code !== 'UNSAFE_COMMIT_TARGET') throw outcome.reason;
          rejectedIndices.push(index);
        }
        else keys.push(outcome.value);
      });
      return { reservations:[...new Set(keys)].sort().map(reserveKey), rejectedIndices };
    });
    admission = reserved.then(() => {}, () => {});
    const operation = (async () => {
      let reservations = [];
      try {
        const result = await reserved;
        reservations = result.reservations;
        for (const reservation of reservations) await waitForReservation(reservation, signal);
        signal?.throwIfAborted();
        return await work({ rejectedIndices:result.rejectedIndices });
      } finally {
        for (const reservation of reservations.reverse()) reservation.release();
      }
    })();
    operations.add(operation);
    operation.finally(() => operations.delete(operation)).catch(() => {});
    return operation;
  }

  async function drain() {
    while (operations.size) await Promise.allSettled([...operations]);
  }
  function close() {
    closed = true;
    lifecycle++;
    if (!closing) closing = drain();
    return closing;
  }
  async function resume() {
    const generation = lifecycle;
    if (closing) await closing;
    if (generation !== lifecycle) return false;
    closing = null;
    closed = false;
    return true;
  }
  return Object.freeze({ withCommitTargets, drain, close, resume });
}

const fileCommitCoordinator = createFileCommitCoordinator();
module.exports = { createFileCommitCoordinator, fileCommitCoordinator };
