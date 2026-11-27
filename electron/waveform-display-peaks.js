'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { sameSnapshot } = require('./file-content-evidence');
const { sameOriginalFile, withCacheReader, fileSnapshot } = require('./waveform-file-evidence');
const { captureOutputDirectory, captureOutputAuthority, assertOutputAuthority } = require('./export-lease');

const MAGIC = Buffer.from('SUBPEAK1');
const HEADER = MAGIC.length + 64; // recipe and payload SHA-256
const MAX_PEAK_BYTES = 64 * 1024 * 1024;
const BUCKET = 40; // 4000 Hz source PCM, 100 min/max pairs per second
const PCM_GUID = Buffer.from('0100000000001000800000aa00389b71', 'hex');
const statOptions = { bigint: true };
const digest = data => crypto.createHash('sha256').update(data).digest();
const changed = () => new Error('來源波形在讀取期間變更');
const peakCount = samples => Math.ceil(samples / BUCKET) * 2;
const fitsDisplayPeaks = samples => Number.isSafeInteger(samples) && samples > 0 && peakCount(samples) * 4 <= MAX_PEAK_BYTES;

function peaksForPCM(bytes) {
  const samples = bytes.length / 2, peaks = new Float32Array(peakCount(samples));
  for (let i = 0; i < samples; i++) {
    const value = bytes.readInt16LE(i * 2) / 32768, bucket = Math.floor(i / BUCKET) * 2;
    if (value < peaks[bucket]) peaks[bucket] = value;
    if (value > peaks[bucket + 1]) peaks[bucket + 1] = value;
  }
  return peaks;
}

function readAt(fd, bytes, position) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.readSync(fd, bytes, offset, bytes.length - offset, position + offset);
    if (!count) throw changed();
    offset += count;
  }
}

// Older ingest WAVs may contain LIST chunks before data. A display cache can
// only be derived from the same mono 4 kHz signed PCM that produced the UI.
function pcmData(fd, size, samples) {
  const head = Buffer.alloc(12);
  readAt(fd, head, 0);
  if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8) !== 'WAVE' || head.readUInt32LE(4) + 8 !== size) return null;
  let formatted = false;
  for (let offset = 12, chunks = 0; offset + 8 <= size && ++chunks <= 1024;) {
    const chunk = Buffer.alloc(8);
    readAt(fd, chunk, offset);
    const tag = chunk.toString('ascii', 0, 4), length = chunk.readUInt32LE(4), start = offset + 8;
    if (start + length > size) return null;
    if (tag === 'fmt ') {
      if (length < 16) return null;
      const format = Buffer.alloc(Math.min(40, length));
      readAt(fd, format, start);
      const type = format.readUInt16LE(0);
      const extensiblePCM = type === 65534 && format.length === 40 && format.readUInt16LE(16) >= 22
        && format.readUInt16LE(18) === 16 && format.subarray(24).equals(PCM_GUID);
      formatted = (type === 1 || extensiblePCM)
        && format.readUInt16LE(2) === 1 && format.readUInt32LE(4) === 4000 && format.readUInt16LE(12) === 2 && format.readUInt16LE(14) === 16;
    }
    if (tag === 'data') {
      if (!formatted || !length || length % 2 || length / 2 + 1 < samples) return null;
      return { start, available: Math.min(samples, length / 2) };
    }
    offset = start + length + length % 2;
  }
  return null;
}

/** The caller owns the managed directory and verified WAV. The peak record can
 * only describe that exact output snapshot and recipe; it is never PCM proof. */
function waveformDisplayCache(directory, wave, spec, verify, verifiedSnapshot) {
  const samples = spec.totalSamples;
  if (!fitsDisplayPeaks(samples)) return null;
  verify();
  const authority = captureOutputAuthority(wave, captureOutputDirectory(directory));
  const snapshot = verifiedSnapshot || fileSnapshot(wave);
  const check = () => {
    verify();
    assertOutputAuthority(authority, wave);
    if (!sameSnapshot(snapshot, fileSnapshot(wave, named => sameSnapshot(snapshot, named)))) throw changed();
  };
  const identity = ['dev', 'ino', 'birthtimeNs', 'size', 'mtimeNs', 'ctimeNs'].map(field => String(snapshot[field]));
  // Portable continuous caches accept a moved WAV only after checking its PCM digest. Its
  // peaks describe that content, so the filesystem identity may change on copy.
  const key = digest(JSON.stringify(spec.version >= 2 && spec.pcmSHA256 ? [spec] : [spec, ...identity]));
  const file = wave + '.peaks-v1', count = peakCount(samples);
  function read() {
    try {
      check();
      const result = withCacheReader(file, (fd, stat) => {
        if (stat.size !== BigInt(HEADER + count * 4)) return null;
        const head = Buffer.alloc(HEADER);
        readAt(fd, head, 0);
        if (!head.subarray(0, MAGIC.length).equals(MAGIC) || !head.subarray(MAGIC.length, MAGIC.length + 32).equals(key)) return null;
        const peaks = new Float32Array(count), bytes = Buffer.from(peaks.buffer);
        readAt(fd, bytes, HEADER);
        if (!digest(bytes).equals(head.subarray(HEADER - 32))) return null;
        for (let i = 0; i < count; i += 2) {
          if (!(peaks[i] >= -1 && peaks[i] <= 0 && peaks[i + 1] >= 0 && peaks[i + 1] <= 1)) return null;
        }
        return peaks;
      });
      check();
      return result;
    } catch (_) { check(); return null; }
  }
  function fromWave() {
    check();
    const fd = fs.openSync(wave, 'r');
    try {
      if (!sameSnapshot(snapshot, fs.fstatSync(fd, statOptions))) throw changed();
      const data = pcmData(fd, Number(snapshot.size), samples);
      if (!data) return null;
      const peaks = new Float32Array(count);
      const chunk = Buffer.alloc(BUCKET * 16384 * 2);
      for (let first = 0; first < data.available;) {
        const samplesToRead = Math.min(chunk.length / 2, data.available - first);
        const bytes = chunk.subarray(0, samplesToRead * 2);
        readAt(fd, bytes, data.start + first * 2);
        peaks.set(peaksForPCM(bytes), first / BUCKET * 2);
        first += samplesToRead;
      }
      if (!sameSnapshot(snapshot, fs.fstatSync(fd, statOptions))) throw changed();
      check();
      return peaks;
    } finally { fs.closeSync(fd); }
  }
  function save(peaks) {
    if (!(peaks instanceof Float32Array) || peaks.length !== count) return;
    const bytes = Buffer.from(peaks.buffer, peaks.byteOffset, peaks.byteLength);
    const tmp = file + '.' + crypto.randomBytes(12).toString('hex') + '.tmp';
    let fd, owner;
    try {
      check();
      fd = fs.openSync(tmp, 'wx');
      owner = fs.fstatSync(fd, statOptions);
      fs.writeFileSync(fd, Buffer.concat([MAGIC, key, digest(bytes)]));
      fs.writeFileSync(fd, bytes);
      fs.closeSync(fd);
      fd = undefined;
      check();
      const expectedSize = BigInt(HEADER + bytes.length);
      const current = fileSnapshot(tmp, named => named.size === expectedSize);
      if (!sameOriginalFile(current, owner) || current.size !== expectedSize) throw changed();
      fs.renameSync(tmp, file);
    } catch (_) { check(); /* The verified WAV also works on a read-only share. */ }
    finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (owner) try {
        check();
        const current = fs.lstatSync(tmp, statOptions);
        if (current.isFile() && current.dev === owner.dev && current.ino === owner.ino) fs.unlinkSync(tmp);
      } catch (_) { /* Preserve files whose ownership changed. */ }
    }
  }
  return { read, fromWave, save };
}

module.exports = { waveformDisplayCache, peaksForPCM, fitsDisplayPeaks, peakCount };
