'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { captureOutputDirectory, captureOutputAuthority, assertOutputAuthority } = require('./export-lease');

const NAMESPACE = 'continuous-waveforms';
const BLOCK = 65536;
const MAX_TRANSFER_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_SAMPLES = Math.floor((0xffffffff - 36) / 2);
const MAX_RECORD_BYTES = 128 * 1024;
const CHECKPOINT_RETRY_DELAYS = [25, 50, 100, 200];
const CHECKPOINT_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const checkpointRetryWait = new Int32Array(new SharedArrayBuffer(4));
const GENERATION = /^[a-f0-9]{64}-[a-f0-9]{24}$/;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const changed = () => Object.assign(new Error('連續波形快取的來源、目錄或內容已變更'), { code: 'CONTINUOUS_WAVE_CACHE_CHANGED' });
const sameFile = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const sameSnapshot = (a, b) => sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const token = () => crypto.randomBytes(12).toString('hex');

function recipe(spec) {
  if (!spec || spec.version !== 1 || typeof spec.sharedSourceKey !== 'string' || !/^[a-f0-9]{64}$/.test(spec.sharedSourceKey)
    || !Number.isSafeInteger(spec.totalSamples) || spec.totalSamples < 1 || spec.totalSamples > MAX_TOTAL_SAMPLES
    || !Array.isArray(spec.audio) || !spec.audio.length || spec.audio.length > 256) throw new TypeError('連續波形規格無效');
  const audio = spec.audio.map(stream => {
    if (!stream || !Number.isInteger(stream.channels) || stream.channels < 1 || stream.channels > 64
      || (stream.timestampOffset !== undefined && !Number.isFinite(stream.timestampOffset))) throw new TypeError('連續波形音訊配置無效');
    return { channels: stream.channels, timestampOffset: stream.timestampOffset || 0 };
  });
  return { version: 1, sharedSourceKey: spec.sharedSourceKey, audio, totalSamples: spec.totalSamples };
}

function wavHeader(samples) {
  const bytes = samples * 2, header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(bytes + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(4000, 24); header.writeUInt32LE(8000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(bytes, 40);
  return header;
}

function regular(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw changed();
  return stat;
}

function storeAt(directory, create = false) {
  const root = path.resolve(directory), stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw changed();
  const parent = captureOutputDirectory(path.dirname(root));
  const rootCheck = path.join(root, '.continuous-root-check');
  const rootAuthority = captureOutputAuthority(rootCheck, parent);
  const folder = path.join(root, NAMESPACE);
  assertOutputAuthority(rootAuthority, rootCheck);
  if (create) { try { fs.mkdirSync(folder); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  const folderStat = fs.lstatSync(folder);
  if (!folderStat.isDirectory() || folderStat.isSymbolicLink()) throw changed();
  const sentinel = path.join(folder, '.continuous-check'), authority = captureOutputAuthority(sentinel, parent);
  const verify = () => { assertOutputAuthority(rootAuthority, rootCheck); assertOutputAuthority(authority, sentinel); };
  verify();
  return { folder, parent, verify };
}

function generationAt(store, name) {
  if (!GENERATION.test(name)) throw changed();
  store.verify();
  const folder = path.join(store.folder, name), stat = fs.lstatSync(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw changed();
  const sentinel = path.join(folder, 'checkpoint.json'), authority = captureOutputAuthority(sentinel, store.parent);
  const verify = () => { store.verify(); assertOutputAuthority(authority, sentinel); };
  verify();
  return { folder, verify };
}

function readExact(fd, length, position) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = fs.readSync(fd, bytes, offset, length - offset, position + offset);
    if (!count) throw changed();
    offset += count;
  }
  return bytes;
}

function readRecord(file) {
  const before = regular(file);
  if (before.size < 2n || before.size > BigInt(MAX_RECORD_BYTES)) throw changed();
  const fd = fs.openSync(file, 'r');
  try {
    if (!sameSnapshot(before, fs.fstatSync(fd, { bigint: true }))) throw changed();
    const bytes = readExact(fd, Number(before.size), 0);
    if (!sameSnapshot(before, fs.fstatSync(fd, { bigint: true })) || !sameSnapshot(before, regular(file))) throw changed();
    return { raw: JSON.parse(bytes.toString('utf8')), bytes, stat: before };
  } finally { fs.closeSync(fd); }
}

function assertRecord(file, proof) {
  const current = readRecord(file);
  if (!sameSnapshot(current.stat, proof.stat) || !current.bytes.equals(proof.bytes)) throw changed();
}

function readPcmEvidence(file, spec, samples, sha256, complete) {
  const before = regular(file), bytes = samples * 2;
  if (before.size < BigInt(44 + bytes) || (complete && before.size !== BigInt(44 + spec.totalSamples * 2))) throw changed();
  const fd = fs.openSync(file, 'r'), hash = crypto.createHash('sha256'), blocks = new Map();
  try {
    if (!sameSnapshot(before, fs.fstatSync(fd, { bigint: true })) || !readExact(fd, 44, 0).equals(wavHeader(spec.totalSamples))) throw changed();
    for (let offset = 0; offset < bytes; offset += BLOCK) {
      const chunk = readExact(fd, Math.min(BLOCK, bytes - offset), 44 + offset);
      hash.update(chunk); blocks.set(offset / BLOCK, digest(chunk));
    }
    if (hash.digest('hex') !== sha256 || !sameSnapshot(before, fs.fstatSync(fd, { bigint: true }))
      || !sameSnapshot(before, regular(file))) throw changed();
    return { stat: before, blocks };
  } finally { fs.closeSync(fd); }
}

function readCandidate(store, name, expected, verify, metadataOnly = false) {
  const generation = generationAt(store, name), recordFile = path.join(generation.folder, 'checkpoint.json');
  const proof = readRecord(recordFile), raw = proof.raw, spec = recipe(raw.spec);
  if (raw.version !== 1 || !name.startsWith(digest(JSON.stringify(spec)) + '-')
    || (expected && JSON.stringify(spec) !== JSON.stringify(expected))) return null;
  if (!Number.isSafeInteger(raw.completedSamples) || raw.completedSamples < 0 || raw.completedSamples > spec.totalSamples
    || typeof raw.complete !== 'boolean' || (raw.complete && raw.completedSamples !== spec.totalSamples)
    || !/^[a-f0-9]{64}$/.test(raw.sha256) || typeof raw.owner?.ino !== 'string' || typeof raw.owner?.birthtimeNs !== 'string') throw changed();
  let file = path.join(generation.folder, raw.complete ? 'wave.wav' : 'partial.wav');
  // A crash between final rename and the completion receipt leaves the same
  // verified full prefix available for a new writer, without claiming complete.
  if (!raw.complete && !fs.existsSync(file)) file = path.join(generation.folder, 'wave.wav');
  const evidence = metadataOnly ? { stat: regular(file) } : readPcmEvidence(file, spec, raw.completedSamples, raw.sha256, raw.complete);
  if (evidence.stat.size < BigInt(44 + raw.completedSamples * 2)
    || (raw.complete && evidence.stat.size !== BigInt(44 + spec.totalSamples * 2))) throw changed();
  if (String(evidence.stat.ino) !== raw.owner.ino || String(evidence.stat.birthtimeNs) !== raw.owner.birthtimeNs) throw changed();
  const check = () => {
    verify(); generation.verify(); assertRecord(recordFile, proof);
    if (!sameSnapshot(evidence.stat, regular(file))) throw changed();
  };
  check();
  return { spec, file, samples: raw.completedSamples, complete: raw.complete, sha256: raw.sha256,
    blocks: evidence.blocks, stat: evidence.stat, verify: check };
}

function scan(directory, expected, verify = () => {}, metadataOnly = false) {
  verify();
  let store;
  try { store = storeAt(directory); }
  catch (error) { if (error.code === 'ENOENT') return { candidates: [], uncertain: false }; throw error; }
  const candidates = [];
  let uncertain = false, count = 0;
  const handle = fs.opendirSync(store.folder);
  try {
    let entry;
    while ((entry = handle.readSync())) {
      if (++count > 4096) { uncertain = true; break; }
      if (!GENERATION.test(entry.name) || (expected && !entry.name.startsWith(digest(JSON.stringify(expected)) + '-'))) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) { uncertain = true; continue; }
      try { const candidate = readCandidate(store, entry.name, expected, verify, metadataOnly); if (candidate) candidates.push(candidate); }
      catch (_) { uncertain = true; }
    }
  } finally { handle.closeSync(); }
  verify(); store.verify();
  candidates.sort((a, b) => Number(b.complete) - Number(a.complete) || b.samples - a.samples);
  return { candidates, uncertain };
}

// Display-only records: never authorize resume / playback or claim PCM integrity.
// The ordinary cache reader above still hashes every confirmed prefix.
function describeContinuousWaveformCache(directory, { sourceKey, verify = () => {} } = {}) {
  try {
    const result = scan(directory, null, verify, true);
    const best = result.candidates.find(candidate => candidate.spec.sharedSourceKey === sourceKey);
    return best ? { state: best.complete ? 'complete' : 'partial', completedSamples: best.samples,
      totalSamples: best.spec.totalSamples, bytes: Number(best.stat.size), verified: false }
      : { state: result.uncertain ? 'unknown' : 'missing', verified: false };
  } catch (_) { return { state: 'unknown', verified: false }; }
}

function inspectContinuousWaveformCache(directory, { spec, verify = () => {} } = {}) {
  try {
    const result = scan(directory, spec ? recipe(spec) : null, verify), best = result.candidates[0];
    return { retained: !!best, uncertain: result.uncertain, completedSamples: best?.samples || 0,
      isComplete: !!best?.complete, wavePath: best?.complete ? best.file : null };
  } catch (_) { return { retained: false, uncertain: true, completedSamples: 0, isComplete: false, wavePath: null }; }
}

function readCompleteContinuousWaveformCache(directory, spec, { verify = () => {} } = {}) {
  const normalized = recipe(spec), best = scan(directory, normalized, verify).candidates.find(candidate => candidate.complete);
  if (!best) return null;
  return { wavePath: best.file, completedSamples: best.samples, totalSamples: normalized.totalSamples,
    verify: () => { best.verify(); readPcmEvidence(best.file, normalized, best.samples, best.sha256, true); best.verify(); } };
}

function checkedRange(file, samples, blocks, startSample, count, verify) {
  if (!Number.isSafeInteger(startSample) || startSample < 0 || !Number.isSafeInteger(count) || count < 0
    || startSample + count > samples || count * 2 > MAX_TRANSFER_BYTES) throw new RangeError('波形讀取超出已確認範圍');
  verify();
  const result = Buffer.alloc(count * 2);
  if (!count) return result;
  const start = startSample * 2, end = start + result.length, before = regular(file), fd = fs.openSync(file, 'r');
  try {
    if (!sameSnapshot(before, fs.fstatSync(fd, { bigint: true }))) throw changed();
    for (let offset = Math.floor(start / BLOCK) * BLOCK; offset < end; offset += BLOCK) {
      const bytes = readExact(fd, Math.min(BLOCK, samples * 2 - offset), 44 + offset);
      if (digest(bytes) !== blocks.get(offset / BLOCK)) throw changed();
      const from = Math.max(start, offset), to = Math.min(end, offset + bytes.length);
      bytes.copy(result, from - start, from - offset, to - offset);
    }
    if (!sameSnapshot(before, fs.fstatSync(fd, { bigint: true })) || !sameSnapshot(before, regular(file))) throw changed();
    verify(); return result;
  } finally { fs.closeSync(fd); }
}

function openContinuousWaveformCache(directory, spec, { verify = () => {}, ignoreCached = false } = {}) {
  if (typeof ignoreCached !== 'boolean') throw new TypeError('波形快取選項無效');
  const normalized = recipe(spec), best = ignoreCached ? null : scan(directory, normalized, verify).candidates[0];
  if (best?.complete) return Object.freeze({ completedSamples: best.samples, writtenSamples: best.samples, totalSamples: normalized.totalSamples, isComplete: true,
    wavePath: best.file, appendPCM() { throw new Error('完整波形為唯讀'); }, checkpoint: () => { best.verify(); return best.samples; },
    complete: () => { best.verify(); readPcmEvidence(best.file, normalized, best.samples, best.sha256, true); best.verify(); return best.file; },
    readPCM: (start, count) => checkedRange(best.file, best.samples, best.blocks, start, count, best.verify), close() {} });
  verify();
  const store = storeAt(directory, true), name = digest(JSON.stringify(normalized)) + '-' + token();
  store.verify(); fs.mkdirSync(path.join(store.folder, name));
  const generation = generationAt(store, name), partial = path.join(generation.folder, 'partial.wav');
  const final = path.join(generation.folder, 'wave.wav'), recordFile = path.join(generation.folder, 'checkpoint.json');
  let fd = fs.openSync(partial, 'wx+'), owner = fs.fstatSync(fd, { bigint: true }), snapshot = owner;
  let written = 0, completed = 0, complete = false, closed = false, current = partial, recordProof = null;
  let committedBlocks = new Map(), blocks = new Map(), block = Buffer.alloc(BLOCK), blockLength = 0;
  const hash = crypto.createHash('sha256');
  const check = () => {
    verify(); generation.verify();
    const actual = regular(current);
    if (!sameFile(owner, actual) || !sameSnapshot(snapshot, actual)
      || (fd !== undefined && !sameSnapshot(actual, fs.fstatSync(fd, { bigint: true })))) throw changed();
  };
  const write = (bytes, position) => {
    let offset = 0;
    while (offset < bytes.length) { const count = fs.writeSync(fd, bytes, offset, bytes.length - offset, position + offset); if (!count) throw changed(); offset += count; }
  };
  const refresh = () => { snapshot = fs.fstatSync(fd, { bigint: true }); if (!sameFile(owner, snapshot)) throw changed(); check(); };
  const writeCheckpoint = (done, sha256) => {
    check();
    if (recordProof) assertRecord(recordFile, recordProof);
    else { try { fs.lstatSync(recordFile); throw changed(); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    const bytes = Buffer.from(JSON.stringify({ version: 1, spec: normalized, completedSamples: written, complete: done, sha256,
      owner: { ino: String(snapshot.ino), birthtimeNs: String(snapshot.birthtimeNs) } }));
    const temporary = path.join(generation.folder, '.checkpoint-' + token() + '.tmp');
    let metadataFd, metadataOwner;
    try {
      generation.verify(); metadataFd = fs.openSync(temporary, 'wx'); metadataOwner = fs.fstatSync(metadataFd, { bigint: true });
      fs.writeFileSync(metadataFd, bytes); fs.fsyncSync(metadataFd); fs.closeSync(metadataFd); metadataFd = undefined;
      const proof = readRecord(temporary);
      if (!sameFile(metadataOwner, proof.stat) || !proof.bytes.equals(bytes)) throw changed();
      for (let attempt = 0; ; attempt++) {
        if (closed) throw new Error('連續波形 writer 已關閉');
        check();
        if (attempt) assertRecord(temporary, proof);
        if (recordProof) assertRecord(recordFile, recordProof);
        else { try { fs.lstatSync(recordFile); throw changed(); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
        generation.verify();
        try { fs.renameSync(temporary, recordFile); break; }
        catch (error) {
          if (!CHECKPOINT_RETRY_CODES.has(error.code) || attempt >= CHECKPOINT_RETRY_DELAYS.length) throw error;
          // The synchronous store runs in the waveform worker. Let a transient
          // sharing denial clear without deleting the last durable checkpoint.
          // Recheck the shared cancellation flag and all ownership after waiting.
          Atomics.wait(checkpointRetryWait, 0, 0, CHECKPOINT_RETRY_DELAYS[attempt]);
        }
      }
      const published = readRecord(recordFile);
      if (!sameFile(metadataOwner, published.stat) || !published.bytes.equals(bytes)) throw changed();
      generation.verify(); recordProof = published;
    } finally {
      if (metadataFd !== undefined) fs.closeSync(metadataFd);
      if (metadataOwner) {
        try {
          generation.verify();
          const retained = readRecord(temporary);
          if (sameFile(metadataOwner, retained.stat) && retained.bytes.equals(bytes)) fs.unlinkSync(temporary);
        } catch (_) { /* Preserve a replaced or unverifiable metadata temporary. */ }
      }
    }
  };
  const api = {
    totalSamples: normalized.totalSamples,
    get completedSamples() { return completed; }, get writtenSamples() { return written; },
    get isComplete() { return complete; }, get wavePath() { return complete ? current : null; },
    appendPCM(bytes) {
      if (closed || complete) throw new Error('連續波形 writer 已關閉');
      if (!Buffer.isBuffer(bytes) || bytes.length % 2 || bytes.length > MAX_TRANSFER_BYTES
        || written + bytes.length / 2 > normalized.totalSamples) throw new RangeError('連續波形 PCM 長度無效');
      check(); write(bytes, 44 + written * 2); hash.update(bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const count = Math.min(BLOCK - blockLength, bytes.length - offset);
        bytes.copy(block, blockLength, offset, offset + count); blockLength += count; offset += count;
        if (blockLength === BLOCK) { blocks.set(Math.floor((written * 2 + offset - 1) / BLOCK), digest(block)); blockLength = 0; }
      }
      written += bytes.length / 2;
      if (blockLength) blocks.set(Math.floor(written * 2 / BLOCK), digest(block.subarray(0, blockLength)));
      refresh(); return written;
    },
    checkpoint() {
      if (closed || complete) throw new Error('連續波形 writer 已關閉');
      check(); fs.fsyncSync(fd); refresh();
      writeCheckpoint(false, hash.copy().digest('hex'));
      completed = written; committedBlocks = new Map(blocks); return completed;
    },
    complete() {
      if (complete) { check(); return current; }
      if (closed || written !== normalized.totalSamples) throw new Error('連續波形 sample 數尚未完整');
      api.checkpoint(); const expected = hash.copy().digest('hex'), beforeClose = snapshot;
      fs.closeSync(fd); fd = undefined;
      generation.verify(); verify();
      const evidence = readPcmEvidence(partial, normalized, written, expected, true);
      if (!sameFile(owner, evidence.stat) || evidence.stat.size !== beforeClose.size) throw changed();
      snapshot = evidence.stat; check();
      try { fs.lstatSync(final); throw changed(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      generation.verify(); fs.renameSync(partial, final); current = final;
      const published = readPcmEvidence(final, normalized, written, expected, true);
      if (!sameFile(owner, published.stat)) throw changed();
      snapshot = published.stat; check(); writeCheckpoint(true, expected);
      complete = true; closed = true; committedBlocks = published.blocks; return current;
    },
    readPCM(start, count) { return checkedRange(current, completed, committedBlocks, start, count, check); },
    close() { if (fd !== undefined) { fs.closeSync(fd); fd = undefined; } closed = true; },
  };
  try {
    check(); write(wavHeader(normalized.totalSamples), 0); refresh();
    if (best) {
      for (let start = 0; start < best.samples; start += MAX_TRANSFER_BYTES / 2)
        api.appendPCM(checkedRange(best.file, best.samples, best.blocks, start, Math.min(MAX_TRANSFER_BYTES / 2, best.samples - start), best.verify));
    }
    api.checkpoint(); return Object.freeze(api);
  } catch (error) { api.close(); throw error; }
}

function isContinuousWaveformCachePath(file) {
  if (typeof file !== 'string' || !file) return false;
  const inside = value => value.split(/[\\/]/).some(part => part.toLowerCase() === NAMESPACE);
  try { return inside(path.resolve(file)) || inside(fs.realpathSync.native(file)); } catch (_) { return false; }
}

module.exports = { openContinuousWaveformCache, readCompleteContinuousWaveformCache, inspectContinuousWaveformCache, describeContinuousWaveformCache,
  isContinuousWaveformCachePath, MAX_TOTAL_SAMPLES, MAX_TRANSFER_BYTES };
