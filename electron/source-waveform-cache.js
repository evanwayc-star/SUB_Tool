/* Completed source-time waveform chunks. Their shared preview evidence never certifies a portable Proxy. */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { captureOutputDirectory, captureOutputAuthority, assertOutputAuthority } = require('./export-lease');

const NAMESPACE = 'source-waveforms';
const MAGIC = Buffer.from('SUBWAV1\n');
const MAX_SOURCE_WAVEFORM_BYTES = 64 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_ENTRIES = 20000;
const ENTRY = /^([a-f0-9]{64})-[a-f0-9]{24}\.swc$/;
const changed = () => Object.assign(new Error('來源波形快取目錄或檔案身分已變更'), { code: 'SOURCE_WAVE_CACHE_CHANGED' });
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const same = (left, right) => left.dev === right.dev && left.ino === right.ino;
const unchanged = (left, right) => same(left, right) && left.size === right.size
  && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;

function recipe(spec) {
  if (!spec || spec.version !== 1 || typeof spec.sharedSourceKey !== 'string' || !/^[a-f0-9]{64}$/.test(spec.sharedSourceKey)
    || !Number.isFinite(spec.start) || spec.start < 0 || !Number.isFinite(spec.length) || spec.length <= 0
    || !Number.isSafeInteger(spec.samples) || spec.samples < 1 || spec.samples * 2 > MAX_SOURCE_WAVEFORM_BYTES
    || spec.samples !== Math.max(1, Math.round(spec.length * 4000))
    || !Array.isArray(spec.audio) || !spec.audio.length || spec.audio.length > 256) return null;
  const audio = [];
  for (const stream of spec.audio) {
    if (!stream || !Number.isInteger(stream.channels) || stream.channels < 1 || stream.channels > 64
      || (stream.timestampOffset !== undefined && !Number.isFinite(stream.timestampOffset))) return null;
    audio.push({ channels: stream.channels, timestampOffset: stream.timestampOffset || 0 });
  }
  return { version: 1, sharedSourceKey: spec.sharedSourceKey, start: spec.start, length: spec.length, samples: spec.samples, audio };
}

function validSourceWaveformPcm(bytes, samples) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.length > MAX_SOURCE_WAVEFORM_BYTES
    || !Number.isSafeInteger(samples) || samples < 1
    || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE'
    || bytes.readUInt32LE(4) + 8 !== bytes.length) return false;
  let position = 12, format = false, data = false, chunks = 0;
  while (position + 8 <= bytes.length && ++chunks <= 1024) {
    const name = bytes.toString('ascii', position, position + 4), size = bytes.readUInt32LE(position + 4);
    const start = position + 8, end = start + size;
    if (end > bytes.length) return false;
    if (name === 'fmt ') {
      if (format || size < 16) return false;
      const code = bytes.readUInt16LE(start);
      if (code !== 1 && !(code === 0xFFFE && size >= 40 && bytes.readUInt16LE(start + 16) >= 22
        && bytes.readUInt16LE(start + 18) === 16
        && bytes.subarray(start + 24, start + 40).equals(Buffer.from('0100000000001000800000aa00389b71', 'hex')))) return false;
      if (bytes.readUInt16LE(start + 2) !== 1 || bytes.readUInt32LE(start + 4) !== 4000
        || bytes.readUInt32LE(start + 8) !== 8000 || bytes.readUInt16LE(start + 12) !== 2
        || bytes.readUInt16LE(start + 14) !== 16) return false;
      format = true;
    } else if (name === 'data') {
      if (!format || data || size !== samples * 2) return false;
      data = true;
    }
    position = end + (size % 2);
  }
  return format && data && position === bytes.length;
}

function namespace(directory, create = false) {
  const root = path.resolve(directory), rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw changed();
  const parent = captureOutputDirectory(path.dirname(root));
  const rootCheck = path.join(root, '.source-waveform-root-check');
  const rootAuthority = captureOutputAuthority(rootCheck, parent);
  const folder = path.join(root, NAMESPACE);
  assertOutputAuthority(rootAuthority, rootCheck);
  if (create) {
    try { fs.mkdirSync(folder); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const folderStat = fs.lstatSync(folder);
  if (!folderStat.isDirectory() || folderStat.isSymbolicLink()) throw changed();
  assertOutputAuthority(rootAuthority, rootCheck);
  const sentinel = path.join(folder, '.source-waveform-check');
  const authority = captureOutputAuthority(sentinel, parent);
  const verify = () => {
    assertOutputAuthority(rootAuthority, rootCheck);
    assertOutputAuthority(authority, sentinel);
  };
  verify();
  return { folder, parent, verify };
}

function entries(store) {
  store.verify();
  const directory = fs.opendirSync(store.folder), names = [];
  try {
    let entry;
    while ((entry = directory.readSync())) {
      if (names.length >= MAX_ENTRIES) throw Object.assign(new Error('來源波形快取項目過多'), { code: 'SOURCE_WAVE_CACHE_LIMIT' });
      names.push(entry.name);
    }
  } finally { directory.closeSync(); }
  store.verify();
  return names;
}

function readExact(fd, length, position) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = fs.readSync(fd, bytes, offset, length - offset, position + offset);
    if (!count) return null;
    offset += count;
  }
  return bytes;
}

function readEntry(store, name) {
  const match = ENTRY.exec(name);
  if (!match) return null;
  store.verify();
  const file = path.join(store.folder, name), authority = captureOutputAuthority(file, store.parent);
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw changed();
  const verify = () => {
    store.verify(); assertOutputAuthority(authority, file);
    const current = fs.lstatSync(file, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || !unchanged(before, current)) throw changed();
  };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const check = () => {
      verify();
      if (!unchanged(before, fs.fstatSync(fd, { bigint: true }))) throw changed();
    };
    check();
    if (before.size < 12n || before.size > BigInt(MAX_SOURCE_WAVEFORM_BYTES + MAX_METADATA_BYTES + 12)) return null;
    const header = readExact(fd, 12, 0);
    if (!header || !header.subarray(0, 8).equals(MAGIC)) return null;
    const length = header.readUInt32LE(8);
    if (!length || length > MAX_METADATA_BYTES || BigInt(length + 12) > before.size) return null;
    const metadata = readExact(fd, length, 12);
    if (!metadata) return null;
    let record;
    try { record = JSON.parse(metadata.toString('utf8')); } catch (_) { return null; }
    const spec = recipe(record?.spec);
    if (!spec || digest(JSON.stringify(spec)) !== match[1] || !Number.isSafeInteger(record.bytes)
      || record.bytes < 44 || record.bytes > MAX_SOURCE_WAVEFORM_BYTES || !/^[a-f0-9]{64}$/.test(record.sha256)
      || BigInt(12 + length + record.bytes) !== before.size) return null;
    const bytes = readExact(fd, record.bytes, 12 + length);
    check();
    if (!bytes || digest(bytes) !== record.sha256 || !validSourceWaveformPcm(bytes, spec.samples)) return null;
    return { bytes, spec, verify };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function readSourceWaveformChunk(directory, spec, { verify = () => {} } = {}) {
  const normalized = recipe(spec);
  if (!normalized) return null;
  verify();
  let store;
  try { store = namespace(directory); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const identity = JSON.stringify(normalized), prefix = digest(identity) + '-';
  for (const name of entries(store)) {
    if (!name.startsWith(prefix)) continue;
    const result = readEntry(store, name);
    if (!result || JSON.stringify(result.spec) !== identity) continue;
    verify(); result.verify();
    return result.bytes;
  }
  verify(); store.verify();
  return null;
}

function saveSourceWaveformChunk(directory, spec, bytes, { verify = () => {} } = {}) {
  const normalized = recipe(spec);
  if (!normalized || !validSourceWaveformPcm(bytes, normalized.samples)) return false;
  verify();
  const store = namespace(directory, true), token = crypto.randomBytes(12).toString('hex');
  const prefix = digest(JSON.stringify(normalized));
  const partial = path.join(store.folder, '.partial-' + token), final = path.join(store.folder, `${prefix}-${token}.swc`);
  const partialAuthority = captureOutputAuthority(partial, store.parent), finalAuthority = captureOutputAuthority(final, store.parent);
  let fd, owner, completedOwner, current = partial, committed = false, preserve = false;
  const check = () => {
    store.verify(); assertOutputAuthority(current === partial ? partialAuthority : finalAuthority, current);
    const observed = fs.lstatSync(current, { bigint: true });
    const opened = fd === undefined ? null : fs.fstatSync(fd, { bigint: true });
    if (!observed.isFile() || observed.isSymbolicLink() || !same(owner, observed)
      || (completedOwner && (observed.size !== completedOwner.size || observed.mtimeNs !== completedOwner.mtimeNs
        || (current === partial && observed.ctimeNs !== completedOwner.ctimeNs)))
      || (opened && (!same(owner, opened) || (completedOwner && !unchanged(completedOwner, opened))))) throw changed();
    return observed;
  };
  try {
    store.verify(); assertOutputAuthority(partialAuthority, partial);
    fd = fs.openSync(partial, 'wx'); owner = fs.fstatSync(fd, { bigint: true });
    check();
    const metadata = Buffer.from(JSON.stringify({ spec: normalized, bytes: bytes.length, sha256: digest(bytes) }));
    if (metadata.length > MAX_METADATA_BYTES) throw new Error('來源波形快取紀錄過大');
    const header = Buffer.alloc(12); MAGIC.copy(header); header.writeUInt32LE(metadata.length, 8);
    const expectedSize = header.length + metadata.length + bytes.length;
    const expectedDigest = crypto.createHash('sha256').update(header).update(metadata).update(bytes).digest('hex');
    fs.writeFileSync(fd, header); fs.writeFileSync(fd, metadata); fs.writeFileSync(fd, bytes);
    if (check().size !== BigInt(expectedSize)) throw new Error('來源波形快取寫入不完整');
    // SMB can finalize mtime/ctime only when the writable handle closes. Accept
    // that transition only after rereading the exact expected envelope from the
    // same file and parents; a self-consistent replacement hash is not enough.
    preserve = true;
    fs.closeSync(fd); fd = undefined;
    completedOwner = check();
    if (completedOwner.size !== BigInt(expectedSize)) throw changed();
    fd = fs.openSync(partial, 'r');
    check();
    const actual = readExact(fd, expectedSize, 0);
    check();
    if (!actual || digest(actual) !== expectedDigest) throw changed();
    fs.closeSync(fd); fd = undefined;
    check(); preserve = false;
    // The caller checks cancellation and source evidence at the publication boundary.
    verify(); check(); assertOutputAuthority(finalAuthority, final);
    try { fs.lstatSync(final); throw Object.assign(new Error('來源波形快取名稱已被使用'), { code: 'EEXIST' }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.renameSync(partial, final); current = final;
    check(); committed = true;
    return true;
  } finally {
    if (fd !== undefined) { fs.closeSync(fd); fd = undefined; }
    if (!committed && owner && !preserve) { try { check(); fs.unlinkSync(current); } catch (_) { /* Preserve foreign or unverifiable entries. */ } }
  }
}

function inspectSourceWaveformCache(directory) {
  let store, uncertain = false;
  try { store = namespace(directory); }
  catch (error) { return { retained: false, uncertain: error.code !== 'ENOENT' }; }
  try {
    for (const name of entries(store)) {
      if (!ENTRY.test(name)) continue;
      try { if (readEntry(store, name)) return { retained: true, uncertain }; }
      catch (error) { if (error.code !== 'ENOENT') uncertain = true; }
    }
    store.verify();
  } catch (_) { uncertain = true; }
  return { retained: false, uncertain };
}

function isSourceWaveformCachePath(file) {
  if (typeof file !== 'string' || !file) return false;
  const inside = value => value.split(/[\\/]/).some(part => part.toLowerCase() === NAMESPACE);
  try {
    if (inside(path.resolve(file))) return true;
    return inside(fs.realpathSync.native(file));
  } catch (_) { return false; }
}

module.exports = { readSourceWaveformChunk, saveSourceWaveformChunk, inspectSourceWaveformCache,
  isSourceWaveformCachePath, validSourceWaveformPcm, MAX_SOURCE_WAVEFORM_BYTES };
