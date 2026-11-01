'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { captureOutputDirectory, captureOutputAuthority, assertOutputAuthority } = require('./export-lease');

// 持有輸出 reservation，讓不同 capture 不會共用檔名，也不會覆寫既有圖片。
// 正式路徑只接受完成的 staging；失敗只清本 owner 的 staging 與仍屬本 reservation 的空檔。
function createScreenshotOutput({ fileAuthority, tempDir, fsModule = fs } = {}) {
  const nativeRoot = tempDir ? captureOutputDirectory(tempDir) : null;
  const reservations = new Map();
  const staging = new Map();
  const incompletePublications = new Map();
  const pending = new Set();
  const nativeCaptures = new Map();
  let closed = false, closing = null;
  const key = file => {
    const resolved = path.resolve(file);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };

  const sameFile = (stat, owner) => String(stat.dev) === String(owner.dev) && String(stat.ino) === String(owner.ino);
  const sameSnapshot = (current, observed) => current.isFile() && !current.isSymbolicLink()
    && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(field => current[field] === observed[field]);
  const unlinkSnapshot = (file, observed, authority) => {
    // 非同步 metadata 是過去的觀察，不能授權刪掉等待期間填入或替換的新檔。
    // 最後少量 metadata 核對與 unlink 不讓出 JS 執行權；圖片內容仍非同步寫入。
    // 這是多次檔案系統呼叫的身分核對，不是 OS 級 compare-and-delete。
    if (authority) assertOutputAuthority(authority, authority.requestedPath);
    const current = (fsModule.lstatSync || fs.lstatSync)(file, { bigint: true });
    if (!sameSnapshot(current, observed)) return false;
    (fsModule.unlinkSync || fs.unlinkSync)(file);
    return true;
  };
  const track = operation => {
    // 在任何 I/O 開始前就記錄已准入工作，close 同樣等待尚未 open 的 reserve。
    const work = Promise.resolve().then(operation);
    pending.add(work);
    work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  };

  function removeNativeCapture(owner) {
    if (!owner.authority || !owner.directoryIdentity) throw new Error('原生截圖暫存目錄尚無可信身分，已保留檔案');
    assertOutputAuthority(owner.authority, owner.file);
    const stat = (fsModule.lstatSync || fs.lstatSync)(owner.directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameFile(stat, owner.directoryIdentity)) {
      throw new Error('原生截圖暫存目錄身分已變更，已保留檔案');
    }
    try {
      const current = (fsModule.lstatSync || fs.lstatSync)(owner.file, { bigint: true });
      if (!owner.fileIdentity || !current.isFile() || current.isSymbolicLink() || !sameFile(current, owner.fileIdentity)) {
        throw new Error('原生截圖暫存檔身分已變更，已保留檔案');
      }
      (fsModule.unlinkSync || fs.unlinkSync)(owner.file);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    (fsModule.rmdirSync || fs.rmdirSync)(owner.directory);
    nativeCaptures.delete(owner.directory);
  }

  function captureNative(host) {
    if (closed) return Promise.resolve(null);
    return track(async () => {
      if (typeof tempDir !== 'string' || !path.isAbsolute(tempDir) || typeof host?.screenshot !== 'function') {
        throw new Error('原生截圖暫存目錄或播放器無效');
      }
      captureOutputAuthority(path.join(tempDir, '.native-shot-check'), nativeRoot);
      const directory = (fsModule.mkdtempSync || fs.mkdtempSync)(path.join(tempDir, 'native-shot-'));
      const file = path.join(directory, 'frame.jpg');
      const owner = { directory, directoryIdentity: null, file, authority: null, fileIdentity: null };
      nativeCaptures.set(directory, owner);
      let handle, result, failure;
      try {
        const authority = captureOutputAuthority(file, nativeRoot);
        owner.authority = authority;
        const evidence = authority.parents.at(-1);
        owner.directoryIdentity = { dev: evidence.dev, ino: evidence.ino };
        const observedDirectory = (fsModule.lstatSync || fs.lstatSync)(directory, { bigint: true });
        if (!observedDirectory.isDirectory() || observedDirectory.isSymbolicLink() || !sameFile(observedDirectory, owner.directoryIdentity)) {
          throw new Error('原生截圖暫存目錄身分已變更，已保留檔案');
        }
        assertOutputAuthority(authority, file);
        handle = await fsModule.promises.open(file, 'wx');
        owner.fileIdentity = await handle.stat({ bigint: true });
        await handle.close(); handle = null;
        assertOutputAuthority(authority, file);
        const screenshot = await host.screenshot(file);
        if (!screenshot || screenshot.ok === false) throw new Error('原生播放器截圖失敗');
        assertOutputAuthority(authority, file);
        handle = await fsModule.promises.open(file, 'r');
        const observed = await handle.stat({ bigint: true });
        if (!observed.isFile() || !sameFile(observed, owner.fileIdentity)) throw new Error('原生截圖暫存檔身分已變更');
        const bytes = await handle.readFile();
        const finished = await handle.stat({ bigint: true });
        await handle.close(); handle = null;
        assertOutputAuthority(authority, file);
        if (!bytes.length || !sameSnapshot(finished, observed)
          || !sameSnapshot((fsModule.lstatSync || fs.lstatSync)(file, { bigint: true }), finished)) {
          throw new Error('原生截圖暫存檔內容已變更');
        }
        result = { ok: true, b64: bytes.toString('base64') };
      } catch (error) { failure = error; }
      finally {
        try { await handle?.close(); } catch (error) { failure ||= error; }
        try { removeNativeCapture(owner); } catch (error) { failure ||= error; }
      }
      if (failure) throw failure;
      return result;
    });
  }

  function reserve(directory, suffix = '') {
    if (closed) return Promise.resolve(null);
    return track(() => reserveFile(directory, suffix));
  }

  async function reserveFile(directory, suffix) {
    if (!fileAuthority.canUseScreenshotDirectory(directory)) return null;
    const directoryAuthority = fileAuthority.captureScreenshotOutput(path.join(directory, '.subtool-screenshot-query'));
    const files = await fsModule.promises.readdir(directory);
    assertOutputAuthority(directoryAuthority, directoryAuthority.requestedPath);
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
      const authority = fileAuthority.captureScreenshotOutput(target);
      let handle;
      try {
        assertOutputAuthority(authority, target);
        handle = await fsModule.promises.open(target, 'wx');
      } catch (error) {
        if (error.code === 'EEXIST') continue;
        throw error;
      }
      try {
        const identity = await handle.stat({ bigint: true });
        reservations.set(key(target), { path: target, dev: identity.dev, ino: identity.ino, authority });
        assertOutputAuthority(authority, target);
        await handle.close(); handle = null;
        return { path: target, name };
      } catch (error) {
        // 暫時 stat 失敗時仍透過原 handle 確認 ownership，不能據 path 猜測身份。
        if (!reservations.has(key(target))) {
          try {
            const identity = await handle.stat({ bigint: true });
            reservations.set(key(target), { path: target, dev: identity.dev, ino: identity.ino, authority });
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
      assertOutputAuthority(reservation.authority, reservation.path);
      const stat = await fsModule.promises.lstat(reservation.path, { bigint: true });
      if (stat.size === 0n && sameFile(stat, reservation)) {
        unlinkSnapshot(reservation.path, stat, reservation.authority);
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
      assertOutputAuthority(owner.authority, owner.authority.requestedPath);
      const stat = await fsModule.promises.lstat(file, { bigint: true });
      if (sameFile(stat, owner)) unlinkSnapshot(file, stat, owner.authority);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    staging.delete(file);
  }

  async function removeIncompletePublication(file) {
    const owner = incompletePublications.get(file);
    if (!owner) return;
    try {
      assertOutputAuthority(owner.authority, owner.authority.requestedPath);
      const stat = await fsModule.promises.lstat(file, { bigint: true });
      if (sameFile(stat, owner) && stat.size <= owner.bytes.length) {
        const bytes = await fsModule.promises.readFile(file);
        const current = await fsModule.promises.lstat(file, { bigint: true });
        // fallback 的正式路徑可能被外部 writer 填入；身份與本 writer prefix 都要吻合。
        if (sameFile(current, owner) && current.size === stat.size && current.mtimeNs === stat.mtimeNs
          && current.ctimeNs === stat.ctimeNs && bytes.equals(owner.bytes.subarray(0, Number(stat.size)))) {
          unlinkSnapshot(file, current, owner.authority);
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    incompletePublications.delete(file);
  }

  async function publishCopy(file, bytes, authority) {
    let handle;
    try { assertOutputAuthority(authority, file); handle = await fsModule.promises.open(file, 'wx'); }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    let error;
    try {
      const identity = await handle.stat({ bigint: true });
      incompletePublications.set(file, { dev: identity.dev, ino: identity.ino, bytes, authority });
      assertOutputAuthority(authority, file);
      await handle.writeFile(bytes);
      await handle.sync();
      const completed = await handle.stat({ bigint: true });
      await handle.close(); handle = null;
      assertOutputAuthority(authority, file);
      if (!sameSnapshot((fsModule.lstatSync || fs.lstatSync)(file, { bigint: true }), completed)) return false;
      incompletePublications.delete(file);
    } catch (failure) {
      error = failure;
      if (!incompletePublications.has(file)) {
        try {
          const identity = await handle.stat({ bigint: true });
          incompletePublications.set(file, { dev: identity.dev, ino: identity.ino, bytes, authority });
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
      assertOutputAuthority(reservation.authority, reservation.path);
      handle = await fsModule.promises.open(reservation.path, 'r+');
      const original = await handle.stat({ bigint: true });
      assertOutputAuthority(reservation.authority, reservation.path);
      if (original.size === 0n && sameFile(original, reservation)) {
        stagePath = path.join(path.dirname(reservation.path), `.${path.basename(reservation.path)}.screenshot-${randomUUID()}`);
        stageHandle = await fsModule.promises.open(stagePath, 'wx');
        const identity = await stageHandle.stat({ bigint: true });
        staging.set(stagePath, { dev: identity.dev, ino: identity.ino, authority: reservation.authority });
        assertOutputAuthority(reservation.authority, reservation.path);
        const bytes = Buffer.from(b64, 'base64');
        await stageHandle.writeFile(bytes);
        await stageHandle.sync();
        const completedStage = await stageHandle.stat({ bigint: true });
        // close 也是 transaction 的一部分；失敗不能先發布再留下成功外觀。
        await stageHandle.close(); stageHandle = null;
        await handle.close(); handle = null;
        assertOutputAuthority(reservation.authority, reservation.path);
        const current = await fsModule.promises.lstat(reservation.path, { bigint: true });
        if (!sameSnapshot((fsModule.lstatSync || fs.lstatSync)(stagePath, { bigint: true }), completedStage)) {
          throw new Error('截圖暫存檔在發布前已變更');
        }
        if (current.size === 0n && sameFile(current, reservation) && unlinkSnapshot(reservation.path, current, reservation.authority)) {
          // link 是 exclusive publication；晚到的外部檔案必須贏，不能 rename 覆蓋。
          try {
            assertOutputAuthority(reservation.authority, reservation.path);
            (fsModule.linkSync || fs.linkSync)(stagePath, reservation.path);
            published = true;
          } catch (publishError) {
            if (['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'ENOSYS'].includes(publishError.code)) {
              // SMB / exFAT 等目錄不一定支援 hardlink；仍只以 wx 建立本 writer 的新檔。
              published = await publishCopy(reservation.path, bytes, reservation.authority);
            } else if (publishError.code !== 'EEXIST') throw publishError;
          }
          if (published) { result = file; reservations.delete(key(file)); }
        }
      }
    } catch (failure) {
      error = failure;
      if (stageHandle && !staging.has(stagePath)) {
        try {
          const identity = await stageHandle.stat({ bigint: true });
          staging.set(stagePath, { dev: identity.dev, ino: identity.ino, authority: reservation.authority });
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
        ...[...nativeCaptures.values()].map(owner => Promise.resolve().then(() => removeNativeCapture(owner))),
      ]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    })();
    closing = attempt;
    attempt.catch(() => { if (closing === attempt) closing = null; });
    return closing;
  }

  async function resume() {
    const attempt = closing;
    if (attempt) await attempt.catch(() => {});
    // A newer close owns admission if one started while this drain was pending.
    if (closing && closing !== attempt) return false;
    closing = null;
    closed = false;
    return true;
  }

  return Object.freeze({ reserve, write, release, captureNative, close, resume });
}

module.exports = { createScreenshotOutput };
