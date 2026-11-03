'use strict';

// A runtime may be rebuilt while callers still hold a previously returned
// path. Share its tombstones for the lifetime of the process and temp root.
const fs = require('fs');
const path = require('path');
const { captureOutputDirectory, captureOutputAuthority, assertOutputAuthority } = require('./export-lease');
const scopes = new Map();
const keyOf = value => {
  const absolute = path.resolve(value);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
};

function createTemporaryOutputOwnership({ tempRoot, rootAuthority = null } = {}) {
  const root = path.resolve(tempRoot);
  const rootKey = keyOf(root);
  let scope = scopes.get(rootKey);
  if (!scope) {
    scope = { authority: rootAuthority, records: new Map(), entries: new Map() };
    scopes.set(rootKey, scope);
  }
  if (!scope.authority && rootAuthority) scope.authority = rootAuthority;

  function reserve(target) {
    const absolute = path.resolve(target), key = keyOf(absolute);
    if (scope.records.has(key)) throw Object.assign(new Error('媒體暫存路徑不可重用'), { code: 'TEMP_PATH_REUSED' });
    scope.authority ||= captureOutputDirectory(root);
    const authority = captureOutputAuthority(absolute, scope.authority);
    const record = { target: absolute, authority, owner: null, writing: true, retired: false };
    scope.records.set(key, record);
    scope.entries.set(keyOf(authority.outPath), record);
    return record;
  }

  function assertOwner(record) {
    assertOutputAuthority(record.authority, record.target);
    const current = fs.lstatSync(record.target, { bigint: true });
    if (!record.owner || !current.isFile() || current.isSymbolicLink()
      || current.dev !== record.owner.dev || current.ino !== record.owner.ino) {
      throw new Error('媒體暫存檔案身分已變更');
    }
    return current;
  }

  function lookup(target) {
    const absolute = path.resolve(target), direct = scope.records.get(keyOf(absolute));
    if (direct) return { record: direct, alias: false };
    try {
      const alias = scope.entries.get(keyOf(fs.realpathSync.native(absolute)));
      if (alias) return { record: alias, alias: true };
    } catch (_) {}
    return null;
  }

  function hasUnsafe() {
    for (const record of scope.records.values()) {
      if (record.writing) return true;
      try {
        assertOutputAuthority(record.authority, record.target);
        const current = fs.lstatSync(record.target, { bigint: true });
        if (record.retired || !record.owner || !current.isFile() || current.isSymbolicLink()
          || current.dev !== record.owner.dev || current.ino !== record.owner.ino) return true;
      } catch (error) { if (error.code !== 'ENOENT') return true; }
    }
    return false;
  }

  async function withDescriptor(target, owner, work, { truncate = false, assertParent = () => {} } = {}) {
    let descriptor;
    let active = false;
    const verify = () => {
      if (!active) throw new Error('媒體暫存輸出 handle 已關閉');
      assertParent();
      const current = fs.lstatSync(target, { bigint: true });
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!owner || !current.isFile() || current.isSymbolicLink() || !opened.isFile()
        || current.dev !== owner.dev || current.ino !== owner.ino
        || opened.dev !== owner.dev || opened.ino !== owner.ino) throw new Error('媒體暫存檔案身分已變更');
      return opened;
    };
    try {
      assertParent();
      const before = fs.lstatSync(target, { bigint: true });
      if (!owner || !before.isFile() || before.isSymbolicLink() || before.dev !== owner.dev || before.ino !== owner.ino)
        throw new Error('媒體暫存檔案身分已變更');
      descriptor = fs.openSync(target, 'r+');
      active = true;
      verify();
      if (truncate) fs.ftruncateSync(descriptor, 0);
      // Multi-pass writers can recheck this same handle between awaits. The
      // owner keeps path/fd/parent evidence and closes only after work settles.
      const result = await work(descriptor, verify);
      verify();
      return result;
    } finally {
      active = false;
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  return { reserve, assertOwner, lookup, hasUnsafe, withDescriptor,
    get rootAuthority() { return scope.authority; },
    setRootAuthority(value) { if (!scope.authority) scope.authority = value; } };
}

module.exports = { createTemporaryOutputOwnership };
