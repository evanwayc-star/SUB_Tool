'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { captureOutputDirectory, captureOutputAuthority, assertOutputAuthority } = require('./export-lease');

const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'];
const snapshot = stat => Object.fromEntries(fields.map(field => [field, String(stat[field])]));
const same = (stat, evidence) => stat.isFile() && !stat.isSymbolicLink()
  && fields.every(field => String(stat[field]) === evidence[field]);

// Evidence is constructed only by the main-process reservation, then carried
// to the watchdog. It is not accepted from renderer or persisted job payloads.
function assertOne(evidence) {
  try {
    if (!evidence || typeof evidence.path !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.sha256)
      || fields.some(field => typeof evidence[field] !== 'string' || !/^\d+$/.test(evidence[field]))) throw new Error('invalid evidence');
    assertOutputAuthority(evidence.authority, evidence.path);
    if (!same(fs.lstatSync(evidence.path, { bigint: true }), evidence)) throw new Error('entry changed');
    const fd = fs.openSync(evidence.path, 'r');
    try {
      if (!same(fs.fstatSync(fd, { bigint: true }), evidence)) throw new Error('opened file changed');
      const digest = crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex');
      if (digest !== evidence.sha256 || !same(fs.fstatSync(fd, { bigint: true }), evidence)) throw new Error('content changed');
    } finally { fs.closeSync(fd); }
    assertOutputAuthority(evidence.authority, evidence.path);
    if (!same(fs.lstatSync(evidence.path, { bigint: true }), evidence)) throw new Error('entry changed');
  } catch (cause) {
    throw Object.assign(new Error('交付暫存輸入已變更，已保留檔案', { cause }), { code: 'DELIVERY_TEMP_INPUT_CHANGED' });
  }
}

function assertDeliveryInputEvidence(evidence) {
  if (!Array.isArray(evidence)) throw Object.assign(new Error('交付暫存輸入證據無效'), { code: 'DELIVERY_TEMP_INPUT_CHANGED' });
  for (const item of evidence) assertOne(item);
}

function createDeliveryTemporaryInputs({ tempDir, rootAuthority } = {}) {
  let root = rootAuthority || null;
  const records = [];
  function create(extension, bytes) {
    root ||= captureOutputDirectory(tempDir);
    const file = path.join(tempDir, `burn_${crypto.randomBytes(12).toString('hex')}.${extension}`);
    const authority = captureOutputAuthority(file, root);
    let fd;
    const record = { path: file, authority, evidence: null };
    records.push(record);
    try {
      fd = fs.openSync(file, 'wx');
      const initial = fs.fstatSync(fd, { bigint: true });
      assertOutputAuthority(authority, file);
      const entry = fs.lstatSync(file, { bigint: true });
      if (!entry.isFile() || entry.isSymbolicLink() || entry.dev !== initial.dev || entry.ino !== initial.ino) throw new Error('temporary entry changed');
      fs.writeFileSync(fd, bytes);
      const finished = fs.fstatSync(fd, { bigint: true });
      record.evidence = { path: file, authority, ...snapshot(finished), sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    assertOne(record.evidence);
    return path.basename(file);
  }
  function evidence() { return records.map(record => record.evidence); }
  function cleanup() {
    for (const record of records) {
      try {
        if (!record.evidence) continue;
        assertOne(record.evidence);
        fs.unlinkSync(record.path);
      } catch (_) { /* Preserve unverified entries. */ }
    }
  }
  return { create, evidence, cleanup };
}

module.exports = { createDeliveryTemporaryInputs, assertDeliveryInputEvidence };
