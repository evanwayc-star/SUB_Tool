/* 固定畫面與反向音訊共用的快取持有者；格式與母素材驗證留在各自模組。 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const changed = () => Object.assign(new Error('預覽快取目錄或檔案已變更，已保留現場'), { code: 'CLIP_CACHE_CHANGED' });
const same = (a, b) => a?.dev === b?.dev && a?.ino === b?.ino;
function directory(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw changed();
  return stat;
}
function regular(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw changed();
  return stat;
}

function createClipCacheArtifact(directoryPath, key, extension) {
  fs.mkdirSync(directoryPath, { recursive: true });
  const rootOwner = directory(directoryPath);
  const verifyRoot = () => { if (!same(rootOwner, directory(directoryPath))) throw changed(); };
  const bucket = path.join(directoryPath, key);
  let bucketOwner = null;
  const verifyBucket = () => { verifyRoot(); if (!bucketOwner || !same(bucketOwner, directory(bucket))) throw changed(); };
  const makeGuard = (folder, file, root, ready = null) => {
    verifyRoot();
    const folderOwner = folder === directoryPath ? root : directory(folder);
    const fileOwner = regular(file), readyOwner = ready ? regular(ready) : null;
    const verify = observed => {
      try {
        verifyRoot();
        if (folder !== directoryPath) verifyBucket();
        if (!same(folderOwner, directory(folder)) || !same(fileOwner, regular(file))
          || (ready && !same(readyOwner, regular(ready))) || (observed && !same(fileOwner, observed))) throw changed();
      } catch (_) { throw changed(); }
    };
    verify();
    return verify;
  };
  function candidates() {
    verifyRoot();
    const result = [];
    const add = (folder, file, ready) => {
      try { result.push({ path: file, verify: makeGuard(folder, file, rootOwner, ready) }); }
      catch (_) { /* 缺件或不能確認身分時不接納。 */ }
    };
    add(directoryPath, path.join(directoryPath, `${key}.${extension}`), null);
    try { bucketOwner = directory(bucket); } catch (_) { /* 無法確認的 bucket 不影響可讀的舊版快取。 */ }
    if (bucketOwner) {
      verifyBucket();
      for (const name of fs.readdirSync(bucket)) {
        if (!/^entry-[0-9a-f-]{36}$/i.test(name)) continue;
        const folder = path.join(bucket, name);
        add(folder, path.join(folder, `content.${extension}`), path.join(folder, 'ready'));
      }
      verifyBucket();
    }
    verifyRoot();
    return result;
  }
  function reserve() {
    verifyRoot();
    if (!bucketOwner) {
      try { fs.mkdirSync(bucket); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      bucketOwner = directory(bucket);
    }
    verifyBucket();
    const folder = path.join(bucket, `entry-${randomUUID()}`);
    fs.mkdirSync(folder);
    const folderOwner = directory(folder), file = path.join(folder, `content.${extension}`);
    let fd = null, fileOwner = null, committed = false;
    const verify = observed => {
      try {
        verifyBucket();
        if (!same(folderOwner, directory(folder)) || !same(fileOwner, regular(file))
          || (observed && !same(fileOwner, observed))) throw changed();
      } catch (_) { throw changed(); }
    };
    try {
      fd = fs.openSync(file, 'wx+');
      fileOwner = fs.fstatSync(fd, { bigint: true });
      verify(fileOwner);
    } catch (error) {
      if (fd !== null) try { fs.closeSync(fd); } catch (_) {}
      throw error;
    }
    return {
      path: file, fd, verify,
      publish() {
        verify(fs.fstatSync(fd, { bigint: true }));
        const marker = path.join(folder, 'ready');
        const ready = fs.openSync(marker, 'wx');
        fs.closeSync(ready);
        verify();
        committed = true;
        return file;
      },
      async close() {
        // 無法確認 handle 已關閉時不可清理，保留現場並讓上層看見錯誤。
        try { fs.closeSync(fd); } catch (error) {
          throw Object.assign(new Error(`預覽快取 handle 關閉失敗：${error.message}`, { cause: error }), { code: 'CLIP_CACHE_CLOSE_FAILED' });
        }
        if (!committed) {
          // 讓取消／關閉等待 cleanup；跨 await 回來仍要先重新核對身分。
          try {
            await fs.promises.lstat(file, { bigint: true }); verify(); fs.unlinkSync(file); fs.rmdirSync(folder);
            try { verifyBucket(); fs.rmdirSync(bucket); } catch (_) { /* 其他工作或殘留仍持有該 key。 */ }
          }
          catch (_) { /* 無法確認時保留；不能遞迴刪除未知內容。 */ }
        }
      },
    };
  }
  return { candidates, reserve };
}
module.exports = { createClipCacheArtifact };
