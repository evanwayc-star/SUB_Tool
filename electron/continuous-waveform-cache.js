'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { captureOutputDirectory, captureOutputAuthority, assertOutputAuthority } = require('./export-lease');
const { waveformDisplayCache } = require('./waveform-display-peaks');
const { changed, sameOriginalFile, regular, withCacheReader, fileSnapshot } = require('./waveform-file-evidence');

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
const sameFile = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const sameSnapshot = (a, b) => sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const token = () => crypto.randomBytes(12).toString('hex');

function recipe(spec) {
  if (!spec || ![1, 2, 3].includes(spec.version) || typeof spec.sharedSourceKey !== 'string' || !/^[a-f0-9]{64}$/.test(spec.sharedSourceKey)
    || !Number.isSafeInteger(spec.totalSamples) || spec.totalSamples < 1 || spec.totalSamples > MAX_TOTAL_SAMPLES
    || !Array.isArray(spec.audio) || !spec.audio.length || spec.audio.length > 256) throw new TypeError('連續波形規格無效');
  const audio = spec.audio.map(stream => {
    if (!stream || !Number.isInteger(stream.channels) || stream.channels < 1 || stream.channels > 64
      || (stream.timestampOffset !== undefined && !Number.isFinite(stream.timestampOffset))) throw new TypeError('連續波形音訊配置無效');
    return { channels: stream.channels, timestampOffset: stream.timestampOffset || 0 };
  });
  // v1 is bound to the writer. v2 verifies all source bytes, v3 verifies
  // the same NAS file on the same share, regardless of the client mount.
  const result = { version: spec.version, sharedSourceKey: spec.sharedSourceKey, audio, totalSamples: spec.totalSamples };
  if (spec.channel !== undefined) {
    const { sourceStream, sourceChannel } = spec.channel || {};
    if (!Number.isInteger(sourceStream) || !Number.isInteger(sourceChannel) || sourceChannel < 0
      || !audio[sourceStream] || sourceChannel >= audio[sourceStream].channels) throw new RangeError('來源音訊沒有指定聲道');
    result.channel = { sourceStream, sourceChannel };
  }
  return result;
}

function wavHeader(samples) {
  const bytes = samples * 2, header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(bytes + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(4000, 24); header.writeUInt32LE(8000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(bytes, 40);
  return header;
}

function storeAt(directory, create = false) {
  const root = path.resolve(directory), stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw changed('快取根目錄遭替換');
  const parent = captureOutputDirectory(path.dirname(root));
  const rootCheck = path.join(root, '.continuous-root-check');
  const rootAuthority = captureOutputAuthority(rootCheck, parent);
  const folder = path.join(root, NAMESPACE);
  assertOutputAuthority(rootAuthority, rootCheck);
  if (create) { try { fs.mkdirSync(folder); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  const folderStat = fs.lstatSync(folder);
  if (!folderStat.isDirectory() || folderStat.isSymbolicLink()) throw changed('連續波形目錄遭替換');
  const sentinel = path.join(folder, '.continuous-check'), authority = captureOutputAuthority(sentinel, parent);
  const verify = () => { assertOutputAuthority(rootAuthority, rootCheck); assertOutputAuthority(authority, sentinel); };
  verify();
  return { folder, parent, verify };
}

function generationAt(store, name) {
  if (!GENERATION.test(name)) throw changed('波形工作目錄名稱無效');
  store.verify();
  const folder = path.join(store.folder, name), stat = fs.lstatSync(folder, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw changed('波形工作目錄遭替換');
  const sentinel = path.join(folder, 'checkpoint.json'), authority = captureOutputAuthority(sentinel, store.parent);
  const verify = () => {
    store.verify();
    if (!sameFile(stat, fs.lstatSync(folder, { bigint: true }))) throw changed('波形工作目錄身分不符');
    assertOutputAuthority(authority, sentinel);
  };
  verify();
  return { folder, verify };
}

function readExact(fd, length, position) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = fs.readSync(fd, bytes, offset, length - offset, position + offset);
    if (!count) throw changed('讀取尚未到達預期長度便已結束');
    offset += count;
  }
  return bytes;
}

function readRecord(file) {
  return withCacheReader(file, (fd, stat) => {
    if (stat.size < 2n || stat.size > BigInt(MAX_RECORD_BYTES)) throw changed('進度記錄長度無效');
    const bytes = readExact(fd, Number(stat.size), 0);
    let raw;
    try { raw = JSON.parse(bytes.toString('utf8')); }
    catch (_) { throw changed('進度記錄已非有效 JSON'); }
    return { raw, bytes, stat };
  });
}

function assertRecord(file, proof) {
  const current = readRecord(file);
  // Metadata timestamps may change independently of the checkpoint. The open
  // descriptor has already been rechecked and every byte is compared here.
  if (!sameOriginalFile(current.stat, proof.stat) || !current.bytes.equals(proof.bytes)) throw changed('進度記錄的身分或內容不符');
}

function readPcmEvidence(file, spec, samples, sha256, complete) {
  const bytes = samples * 2;
  return withCacheReader(file, (fd, stat) => {
    if (stat.size < BigInt(44 + bytes) || (complete && stat.size !== BigInt(44 + spec.totalSamples * 2))) throw changed('WAV 的長度與已保存的取樣數不符');
    if (!readExact(fd, 44, 0).equals(wavHeader(spec.totalSamples))) throw changed('WAV 標頭與來源規格不符');
    const hash = crypto.createHash('sha256'), blocks = new Map();
    for (let offset = 0; offset < bytes; offset += BLOCK) {
      const chunk = readExact(fd, Math.min(BLOCK, bytes - offset), 44 + offset);
      hash.update(chunk); blocks.set(offset / BLOCK, digest(chunk));
    }
    if (hash.digest('hex') !== sha256) throw changed('PCM 內容的 SHA-256 與進度記錄不符');
    return { stat, blocks };
  });
}

// A timestamp update is not evidence that PCM changed. When identity and
// size still match, require the previously certified bytes before continuing.
function recheckPcm(file, previous, observed, spec, samples, sha256, complete) {
  if (!sameOriginalFile(previous, observed) || observed.size !== previous.size) throw changed('重新核對的 WAV 身分或長度不符');
  const verified = readPcmEvidence(file, spec, samples, sha256, complete);
  if (!sameOriginalFile(previous, verified.stat) || verified.stat.size !== previous.size) throw changed('核對 PCM 期間 WAV 遭替換');
  return verified.stat;
}

function readCandidate(store, name, expected, verify, metadataOnly = false) {
  const generation = generationAt(store, name), recordFile = path.join(generation.folder, 'checkpoint.json');
  const proof = readRecord(recordFile), raw = proof.raw, spec = recipe(raw.spec);
  if (raw.version !== 1 || !name.startsWith(digest(JSON.stringify(spec)) + '-')
    || (expected && JSON.stringify(spec) !== JSON.stringify(expected))) return null;
  if (!Number.isSafeInteger(raw.completedSamples) || raw.completedSamples < 0 || raw.completedSamples > spec.totalSamples
    || typeof raw.complete !== 'boolean' || (raw.complete && raw.completedSamples !== spec.totalSamples)
    || !/^[a-f0-9]{64}$/.test(raw.sha256) || typeof raw.owner?.ino !== 'string' || typeof raw.owner?.birthtimeNs !== 'string') throw changed('進度記錄的格式或取樣數無效');
  let file = path.join(generation.folder, raw.complete ? 'wave.wav' : 'partial.wav');
  // A crash between final rename and the completion receipt leaves the same
  // verified full prefix available for a new writer, without claiming complete.
  if (!raw.complete && !fs.existsSync(file)) file = path.join(generation.folder, 'wave.wav');
  const validSize = stat => raw.complete ? stat.size === BigInt(44 + spec.totalSamples * 2) : stat.size >= BigInt(44 + raw.completedSamples * 2);
  const recordedTimes = stat => ['mtimeNs','ctimeNs'].every(field => String(stat[field]) === raw.owner[field]);
  const stat = fileSnapshot(file, named => validSize(named) && recordedTimes(named));
  const originalOwner = String(stat.ino) === raw.owner.ino && String(stat.birthtimeNs) === raw.owner.birthtimeNs;
  const portable = raw.complete && spec.version >= 2;
  if (!originalOwner && !portable) throw changed('舊版或未完成的 WAV 身分與進度記錄不符');
  // A drive letter and a UNC mount can report different client-local device
  // IDs for the very same server file. The v3 recipe already binds the share.
  const originalSnapshot = originalOwner && (spec.version === 3 || String(stat.dev) === raw.owner.dev)
    && recordedTimes(stat);
  // Copied, replaced or modified portable WAVs must pass the original PCM digest
  // before their saved peaks or playback path can be handed to another process.
  const evidence = metadataOnly && (metadataOnly === 'describe' || !portable || originalSnapshot) ? { stat }
    : readPcmEvidence(file, spec, raw.completedSamples, raw.sha256, raw.complete);
  if (!validSize(evidence.stat)) throw changed('WAV 長度與進度記錄不符');
  if (!sameSnapshot(stat, evidence.stat)
    && (!sameOriginalFile(stat, evidence.stat) || !sameSnapshot(evidence.stat, fileSnapshot(file))))
    throw changed('核對進度記錄期間 WAV 遭替換或修改');
  const verifyLocation = () => { verify(); generation.verify(); };
  const check = () => {
    verifyLocation(); assertRecord(recordFile, proof);
    const observed = fileSnapshot(file, named => sameSnapshot(evidence.stat, named));
    if (!sameSnapshot(evidence.stat, observed)) {
      evidence.stat = recheckPcm(file, evidence.stat, observed, spec, raw.completedSamples, raw.sha256, raw.complete);
    }
  };
  check();
  return { spec, file, samples: raw.completedSamples, complete: raw.complete, sha256: raw.sha256,
    blocks: evidence.blocks, stat: evidence.stat, verify: check, verifyLocation };
}

// Another worker can append, publish a new checkpoint, or finish the WAV while
// we resume. Only copy the prefix certified by the checkpoint selected by scan.
// The destination has no checkpoint until this digest and its directory pass.
function copyCheckpointPrefix(candidate, append) {
  const final = path.join(path.dirname(candidate.file), 'wave.wav');
  function verifyPath() {
    candidate.verifyLocation();
    let file = candidate.file;
    let observed;
    try { observed = regular(file); }
    catch (error) {
      if (error.code !== 'ENOENT' || file === final) throw error;
      file = final;
      observed = regular(file);
    }
    if (!sameOriginalFile(candidate.stat, observed)) throw changed('準備續算時來源 WAV 遭替換');
    return file;
  }
  const file = verifyPath();
  let fd;
  try {
    try { fd = fs.openSync(file, 'r'); }
    catch (error) {
      if (error.code !== 'ENOENT' || file === final) throw error;
      fd = fs.openSync(verifyPath(), 'r');
    }
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!sameOriginalFile(candidate.stat, opened) || opened.size < BigInt(44 + candidate.samples * 2)
      || !readExact(fd, 44, 0).equals(wavHeader(candidate.spec.totalSamples))) throw changed('續算來源的 WAV 身分、長度或標頭不符');
    const hash = crypto.createHash('sha256'), length = candidate.samples * 2;
    for (let offset = 0; offset < length; offset += MAX_TRANSFER_BYTES) {
      verifyPath();
      const bytes = readExact(fd, Math.min(MAX_TRANSFER_BYTES, length - offset), 44 + offset);
      hash.update(bytes); append(bytes);
    }
    verifyPath();
    if (hash.digest('hex') !== candidate.sha256) throw changed('續算的 PCM 與已保存的 SHA-256 不符');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
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
function describeContinuousWaveformCache(directory, { sourceKey, sourceSHA256, verify = () => {} } = {}) {
  try {
    const result = scan(directory, null, verify, 'describe');
    const matches = result.candidates.filter(candidate => candidate.spec.sharedSourceKey ===
      (candidate.spec.version === 2 ? sourceSHA256 : sourceKey));
    const best = matches.find(candidate => !candidate.spec.channel);
    const summary = best ? { state: best.complete ? 'complete' : 'partial', completedSamples: best.samples,
      totalSamples: best.spec.totalSamples, bytes: Number(best.stat.size), verified: false }
      : { state: result.uncertain ? 'unknown' : 'missing', verified: false };
    if (matches.some(candidate => candidate.spec.channel)) summary.hasSourceChannels = true;
    return summary;
  } catch (_) { return { state: 'unknown', verified: false }; }
}

// The private recovery bucket contains only v1 waves for one exact local source.
// Cleanup supplies a frozen list of relative paths and verifies their bytes separately.
function ownsWaveformRecoveryTree(directory, sourceKey, relativePaths, verify) {
  const { candidates, uncertain } = scan(directory, null, verify, 'describe');
  if (uncertain || !candidates.length) return false;
  const allowed = new Set(['', NAMESPACE]);
  for (const candidate of candidates) {
    if (candidate.spec.version !== 1 || candidate.spec.sharedSourceKey !== sourceKey) return false;
    const file = path.relative(directory, candidate.file).split(path.sep).join('/');
    const folder = path.posix.dirname(file);
    allowed.add(folder);
    allowed.add(folder + '/checkpoint.json');
    allowed.add(file);
    if (candidate.complete) allowed.add(file + '.peaks-v1');
  }
  return relativePaths.every(relative => allowed.has(relative));
}

function inspectContinuousWaveformCache(directory, { spec, verify = () => {}, displayPeaks = false } = {}) {
  try {
    const result = scan(directory, spec ? recipe(spec) : null, verify, displayPeaks), best = result.candidates[0];
    const display = displayPeaks && best?.complete
      ? waveformDisplayCache(directory, best.file, { ...best.spec, pcmSHA256: best.sha256 }, best.verify, best.stat)?.read() : null;
    return { retained: !!best, uncertain: result.uncertain, completedSamples: best?.samples || 0,
      isComplete: !!best?.complete, wavePath: best?.complete ? best.file : null,
      ...(display ? { displayPeaks: display, verify: best.verify, waveSnapshot: best.stat } : {}) };
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
  const start = startSample * 2, end = start + result.length;
  withCacheReader(file, fd => {
    for (let offset = Math.floor(start / BLOCK) * BLOCK; offset < end; offset += BLOCK) {
      const bytes = readExact(fd, Math.min(BLOCK, samples * 2 - offset), 44 + offset);
      if (digest(bytes) !== blocks.get(offset / BLOCK)) throw changed('已保存的 PCM 區塊校驗不符');
      const from = Math.max(start, offset), to = Math.min(end, offset + bytes.length);
      bytes.copy(result, from - start, from - offset, to - offset);
    }
  });
  verify(); return result;
}

function openContinuousWaveformCache(directory, spec, { verify = () => {}, ignoreCached = false } = {}) {
  if (typeof ignoreCached !== 'boolean') throw new TypeError('波形快取選項無效');
  const normalized = recipe(spec), best = ignoreCached ? null : scan(directory, normalized, verify).candidates[0];
  if (best?.complete) return Object.freeze({ completedSamples: best.samples, writtenSamples: best.samples, totalSamples: normalized.totalSamples, isComplete: true,
    wavePath: best.file, pcmSHA256: best.sha256, appendPCM() { throw new Error('完整波形為唯讀'); }, checkpoint: () => { best.verify(); return best.samples; },
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
    const actual = fd === undefined ? fileSnapshot(current, named => sameSnapshot(snapshot, named)) : fs.fstatSync(fd, { bigint: true });
    if (!sameOriginalFile(actual, regular(current))) throw changed('寫入波形的檔案路徑遭替換');
    if (!sameSnapshot(snapshot, actual)) {
      snapshot = recheckPcm(current, snapshot, actual, normalized, written, hash.copy().digest('hex'), complete);
    }
    if (!sameFile(owner, snapshot)) throw changed('波形檔案的持有者身分不符');
  };
  const write = (bytes, position) => {
    let offset = 0;
    while (offset < bytes.length) { const count = fs.writeSync(fd, bytes, offset, bytes.length - offset, position + offset); if (!count) throw changed('WAV 寫入未達預期長度'); offset += count; }
  };
  const refresh = () => { snapshot = fs.fstatSync(fd, { bigint: true }); if (!sameFile(owner, snapshot)) throw changed('寫入 WAV 後檔案身分不符'); check(); };
  const writeCheckpoint = (done, sha256) => {
    check();
    if (recordProof) assertRecord(recordFile, recordProof);
    else { try { fs.lstatSync(recordFile); throw changed('新工作已有其他進度記錄'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    const bytes = Buffer.from(JSON.stringify({ version: 1, spec: normalized, completedSamples: written, complete: done, sha256,
      owner: Object.fromEntries(['ino','birthtimeNs','dev','mtimeNs','ctimeNs'].map(field => [field, String(snapshot[field])])) }));
    const temporary = path.join(generation.folder, '.checkpoint-' + token() + '.tmp');
    let metadataFd, metadataOwner;
    try {
      generation.verify(); metadataFd = fs.openSync(temporary, 'wx'); metadataOwner = fs.fstatSync(metadataFd, { bigint: true });
      fs.writeFileSync(metadataFd, bytes); fs.fsyncSync(metadataFd); fs.closeSync(metadataFd); metadataFd = undefined;
      const proof = readRecord(temporary);
      if (!sameFile(metadataOwner, proof.stat) || !proof.bytes.equals(bytes)) throw changed('暫存進度記錄的身分或內容不符');
      for (let attempt = 0; ; attempt++) {
        if (closed) throw new Error('連續波形 writer 已關閉');
        check();
        if (attempt) assertRecord(temporary, proof);
        if (recordProof) assertRecord(recordFile, recordProof);
        else { try { fs.lstatSync(recordFile); throw changed('發布時發現其他進度記錄'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
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
      if (!sameFile(metadataOwner, published.stat) || !published.bytes.equals(bytes)) throw changed('發布後的進度記錄身分或內容不符');
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
    get pcmSHA256() { return complete ? hash.copy().digest('hex') : null; },
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
      if (completed !== written) api.checkpoint();
      const expected = hash.copy().digest('hex'), beforeClose = snapshot;
      fs.closeSync(fd); fd = undefined;
      generation.verify(); verify();
      const evidence = readPcmEvidence(partial, normalized, written, expected, true);
      if (!sameFile(owner, evidence.stat) || evidence.stat.size !== beforeClose.size) throw changed('完成寫入後 WAV 的身分或長度不符');
      snapshot = evidence.stat; check();
      try { fs.lstatSync(final); throw changed('準備發布 WAV 時發現同名檔案'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      generation.verify(); fs.renameSync(partial, final); current = final;
      const published = readPcmEvidence(final, normalized, written, expected, true);
      if (!sameFile(owner, published.stat)) throw changed('發布完成後 WAV 的身分不符');
      snapshot = published.stat; check(); writeCheckpoint(true, expected);
      complete = true; closed = true; committedBlocks = published.blocks; return current;
    },
    readPCM(start, count) { return checkedRange(current, completed, committedBlocks, start, count, check); },
    close() { if (fd !== undefined) { fs.closeSync(fd); fd = undefined; } closed = true; },
  };
  try {
    check(); write(wavHeader(normalized.totalSamples), 0); refresh();
    if (best) copyCheckpointPrefix(best, api.appendPCM);
    api.checkpoint(); return Object.freeze(api);
  } catch (error) { api.close(); throw error; }
}

function isContinuousWaveformCachePath(file) {
  if (typeof file !== 'string' || !file) return false;
  const inside = value => value.split(/[\\/]/).some(part => part.toLowerCase() === NAMESPACE);
  try { return inside(path.resolve(file)) || inside(fs.realpathSync.native(file)); } catch (_) { return false; }
}

module.exports = { openContinuousWaveformCache, readCompleteContinuousWaveformCache, inspectContinuousWaveformCache, describeContinuousWaveformCache,
  ownsWaveformRecoveryTree, isContinuousWaveformCachePath, MAX_TOTAL_SAMPLES, MAX_TRANSFER_BYTES };
