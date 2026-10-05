'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// 持有輸出 reservation，讓不同 capture 不會共用檔名，也不會覆寫既有圖片。
// 正式路徑只接受完成的 staging；失敗只清本 owner 的 staging 與仍屬本 reservation 的空檔。
function createScreenshotOutput({ fileAuthority, fsModule = fs } = {}) {
  const reservations = new Map();
  const staging = new Map();
  const incompletePublications = new Map();
  const pending = new Set();
  let closed = false, closing = null;
  const key = file => {
    const resolved = path.resolve(file);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };

  const sameFile = (stat, owner) => stat.dev === owner.dev && stat.ino === owner.ino;
  const track = operation => {
    // 在任何 I/O 開始前就記錄已准入工作，close 同樣等待尚未 open 的 reserve。
    const work = Promise.resolve().then(operation);
    pending.add(work);
    work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  };

  function reserve(directory, suffix = '') {
    if (closed) return Promise.resolve(null);
    return track(() => reserveFile(directory, suffix));
  }

  async function reserveFile(directory, suffix) {
    if (!fileAuthority.canUseScreenshotDirectory(directory)) return null;
    const files = await fsModule.promises.readdir(directory);
    let max = 0;
    for (const file of files) {
      const hit = /^Shot-(\d+)/i.exec(file);
      const value = hit ? Number(hit[1]) : 0;
      if (Number.isSafeInteger(value)) max = Math.max(max, value);
    }
    const safeSuffix = typeof suffix === 'string' ? suffix.replace(/[^0-9A-Za-z_-]/g, '') : '';
    while (Number.isSafeInteger(++max)) {
      const name = `Shot-${String(max).padStart(3, '0')}${safeSuffix}.jpg`;
      const target = path.join(directory, name);
      if (!fileAuthority.canWriteScreenshot(target)) return null;
      let handle;
      try {
        handle = await fsModule.promises.open(target, 'wx');
      } catch (error) {
        if (error.code === 'EEXIST') continue;
        throw error;
      }
      try {
        const identity = await handle.stat();
        reservations.set(key(target), { path: target, dev: identity.dev, ino: identity.ino });
        await handle.close(); handle = null;
        return { path: target, name };
      } catch (error) {
        // 暫時 stat 失敗時仍透過原 handle 確認 ownership，不能據 path 猜測身份。
        if (!reservations.has(key(target))) {
          try {
            const identity = await handle.stat();
            reservations.set(key(target), { path: target, dev: identity.dev, ino: identity.ino });
          } catch (statError) {}
        }
        try { await handle?.close(); } catch (closeError) {}
        try { await release(target); } catch (cleanupError) {}
        throw error;
      }
    }
    throw new Error('截圖編號超出有效範圍');
  }

  async function release(file) {
    if (typeof file !== 'string') return false;
    const id = key(file);
    const reservation = reservations.get(id);
    if (!reservation || reservation.writing) return false;
    try {
      const stat = await fsModule.promises.lstat(reservation.path);
      if (stat.size === 0 && sameFile(stat, reservation)) {
        await fsModule.promises.unlink(reservation.path);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    reservations.delete(id);
    return true;
  }

  function write(file, b64) {
    if (closed) return Promise.resolve(null);
    if (!fileAuthority.canWriteScreenshot(file)) return Promise.resolve(null);
    const reservation = reservations.get(key(file));
    if (!reservation || reservation.writing) return Promise.resolve(null);
    // Consume the write intent before any I/O can yield to a duplicate IPC.
    reservation.writing = true;
    return track(() => writeFile(reservation, file, b64));
  }

  async function removeStaging(file) {
    const owner = staging.get(file);
    if (!owner) return;
    try {
      const stat = await fsModule.promises.lstat(file);
      if (sameFile(stat, owner)) await fsModule.promises.unlink(file);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    staging.delete(file);
  }

  async function removeIncompletePublication(file) {
    const owner = incompletePublications.get(file);
    if (!owner) return;
    try {
      const stat = await fsModule.promises.lstat(file);
      if (sameFile(stat, owner) && stat.size <= owner.bytes.length) {
        const bytes = await fsModule.promises.readFile(file);
        const current = await fsModule.promises.lstat(file);
        // fallback 的正式路徑可能被外部 writer 填入；身份與本 writer prefix 都要吻合。
        if (sameFile(current, owner) && current.size === stat.size && current.mtimeMs === stat.mtimeMs
          && current.ctimeMs === stat.ctimeMs && bytes.equals(owner.bytes.subarray(0, stat.size))) {
          await fsModule.promises.unlink(file);
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    incompletePublications.delete(file);
  }

  async function publishCopy(file, bytes) {
    let handle;
    try { handle = await fsModule.promises.open(file, 'wx'); }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    let error;
    try {
      const identity = await handle.stat();
      incompletePublications.set(file, { dev: identity.dev, ino: identity.ino, bytes });
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close(); handle = null;
      incompletePublications.delete(file);
    } catch (failure) {
      error = failure;
      if (!incompletePublications.has(file)) {
        try {
          const identity = await handle.stat();
          incompletePublications.set(file, { dev: identity.dev, ino: identity.ino, bytes });
        } catch (statError) {}
      }
    }
    finally {
      try { await handle?.close(); } catch (closeError) { error ||= closeError; }
    }
    if (error) throw error;
    return true;
  }

  async function writeFile(reservation, file, b64) {
    let handle, stageHandle, stagePath, error, result = null, published = false;
    try {
      handle = await fsModule.promises.open(reservation.path, 'r+');
      const original = await handle.stat();
      if (original.size === 0 && sameFile(original, reservation)) {
        stagePath = path.join(path.dirname(reservation.path), `.${path.basename(reservation.path)}.screenshot-${randomUUID()}`);
        stageHandle = await fsModule.promises.open(stagePath, 'wx');
        const identity = await stageHandle.stat();
        staging.set(stagePath, { dev: identity.dev, ino: identity.ino });
        const bytes = Buffer.from(b64, 'base64');
        await stageHandle.writeFile(bytes);
        await stageHandle.sync();
        // close 也是 transaction 的一部分；失敗不能先發布再留下成功外觀。
        await stageHandle.close(); stageHandle = null;
        await handle.close(); handle = null;
        const current = await fsModule.promises.lstat(reservation.path);
        if (current.size === 0 && sameFile(current, reservation)) {
          await fsModule.promises.unlink(reservation.path);
          // link 是 exclusive publication；晚到的外部檔案必須贏，不能 rename 覆蓋。
          try {
            await fsModule.promises.link(stagePath, reservation.path);
            published = true;
          } catch (publishError) {
            if (['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'ENOSYS'].includes(publishError.code)) {
              // SMB / exFAT 等目錄不一定支援 hardlink；仍只以 wx 建立本 writer 的新檔。
              published = await publishCopy(reservation.path, bytes);
            } else if (publishError.code !== 'EEXIST') throw publishError;
          }
          if (published) { result = file; reservations.delete(key(file)); }
        }
      }
    } catch (failure) {
      error = failure;
      if (stageHandle && !staging.has(stagePath)) {
        try {
          const identity = await stageHandle.stat();
          staging.set(stagePath, { dev: identity.dev, ino: identity.ino });
        } catch (statError) {}
      }
    } finally {
      for (const openHandle of [stageHandle, handle]) {
        try { await openHandle?.close(); } catch (closeError) { error ||= closeError; }
      }
      reservation.writing = false;
      if (!published) {
        try { await release(file); } catch (cleanupError) { error ||= cleanupError; }
        try { await removeIncompletePublication(reservation.path); } catch (cleanupError) { error ||= cleanupError; }
      }
      // 已完成的圖片仍成功；暫存刪除失敗留在 owner，close 可重試收尾。
      try { await removeStaging(stagePath); } catch (cleanupError) { if (!published) error ||= cleanupError; }
    }
    if (error) throw error;
    return result;
  }

  function close() {
    if (closing) return closing;
    closed = true;
    const attempt = (async () => {
      await Promise.allSettled([...pending]);
      const results = await Promise.allSettled([
        ...[...reservations.values()].map(reservation => release(reservation.path)),
        ...[...staging.keys()].map(removeStaging),
        ...[...incompletePublications.keys()].map(removeIncompletePublication),
      ]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    })();
    closing = attempt;
    attempt.catch(() => { if (closing === attempt) closing = null; });
    return closing;
  }

  return Object.freeze({ reserve, write, release, close });
}

module.exports = { createScreenshotOutput };
