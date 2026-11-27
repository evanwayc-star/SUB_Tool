'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sameSnapshot } = require('./file-content-evidence');

const statOptions = { bigint: true };
const changed = detail => Object.assign(new Error(`連續波形快取的來源、目錄或內容已變更（${detail}）`), { code: 'CONTINUOUS_WAVE_CACHE_CHANGED' });
const sameOriginalFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.birthtimeNs === b.birthtimeNs;

function regular(file) {
  const stat = fs.lstatSync(file, statOptions);
  if (!stat.isFile() || stat.isSymbolicLink()) throw changed(`${path.basename(file)} 已非一般檔案`);
  return stat;
}

// SMB directory attributes may lag behind the object after flush. Read bytes,
// size and write times from one descriptor, and check the name for replacement.
function withCacheReader(file, read) {
  const before = regular(file);
  const fd = fs.openSync(file, 'r');
  try {
    const opened = fs.fstatSync(fd, statOptions);
    if (!sameOriginalFile(before, opened)) throw changed(`開啟 ${path.basename(file)} 時檔案身分不符`);
    const result = read(fd, opened);
    if (!sameSnapshot(opened, fs.fstatSync(fd, statOptions))) throw changed(`讀取 ${path.basename(file)} 期間內容有變動`);
    if (!sameOriginalFile(opened, regular(file))) throw changed(`讀取 ${path.basename(file)} 期間路徑遭替換`);
    return result;
  } finally { fs.closeSync(fd); }
}

function fileSnapshot(file, accepts) {
  if (accepts) {
    const named = regular(file);
    if (accepts(named)) return named;
  }
  return withCacheReader(file, (_fd, stat) => stat);
}

module.exports = { changed, sameOriginalFile, regular, withCacheReader, fileSnapshot };
