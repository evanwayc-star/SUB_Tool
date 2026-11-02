'use strict';

// A receipt binds a particular log inode and its parent directory to one job.
// Old fixed-name logs have no receipt and are deliberately left untouched.
const nodeFs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');

const keyForJob = id => createHash('sha256').update(String(id)).digest('hex').slice(0, 24);
const receiptPath = file => `${file}.owner`;
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino), birth: String(stat.birthtimeNs) });
const same = (stat, saved) => !!saved && stat.isFile() && !stat.isSymbolicLink()
  && String(stat.dev) === saved.dev && String(stat.ino) === saved.ino && String(stat.birthtimeNs) === saved.birth;
const sameDirectory = (stat, saved) => !!saved && stat.isDirectory()
  && String(stat.dev) === saved.dev && String(stat.ino) === saved.ino && String(stat.birthtimeNs) === saved.birth;
const matchesOwner = (a, b) => !!a && !!b && a.file === b.file && a.job === b.job
  && a.log?.dev === b.log?.dev && a.log?.ino === b.log?.ino && a.log?.birth === b.log?.birth
  && a.parent?.dev === b.parent?.dev && a.parent?.ino === b.parent?.ino && a.parent?.birth === b.parent?.birth;

function queueLogPath(directory, jobId) {
  return path.join(directory, `diagnostic-${keyForJob(jobId)}-${randomUUID()}.log`);
}

function record(file, descriptor, jobId, fs = nodeFs) {
  const stat = fs.fstatSync(descriptor, { bigint: true });
  if (!same(fs.lstatSync(file, { bigint: true }), identity(stat))) throw new Error('記錄檔身分已變更');
  const owner = { version: 1, file: path.basename(file), job: jobId == null ? null : keyForJob(jobId),
    parent: identity(fs.statSync(path.dirname(file), { bigint: true })), log: identity(stat) };
  fs.writeFileSync(receiptPath(file), JSON.stringify(owner), { encoding: 'utf8', flag: 'wx' });
  return owner;
}

function readReceipt(file, fs = nodeFs, strictIO = false) {
  let fd;
  try {
    const ownerPath = receiptPath(file);
    const before = fs.lstatSync(ownerPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) return null;
    fd = fs.openSync(ownerPath, 'r');
    const receiptIdentity = identity(fs.fstatSync(fd, { bigint: true }));
    if (!same(before, receiptIdentity)) return null;
    const receipt = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (receipt.version !== 1 || receipt.file !== path.basename(file)
      || !sameDirectory(fs.statSync(path.dirname(file), { bigint: true }), receipt.parent)
      || !same(fs.lstatSync(ownerPath, { bigint: true }), receiptIdentity)) return null;
    Object.defineProperty(receipt, 'receiptIdentity', { value: receiptIdentity });
    return receipt;
  } catch (error) {
    if (strictIO && error.code && error.code !== 'ENOENT') throw error;
    return null;
  }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (error) {} } }
}

function load(file, fs = nodeFs, strictIO = false) {
  const receipt = readReceipt(file, fs, strictIO);
  if (!receipt) return null;
  try { return same(fs.lstatSync(file, { bigint: true }), receipt.log) ? receipt : null; }
  catch (error) {
    if (strictIO && error.code !== 'ENOENT') throw error;
    return null;
  }
}

function read(file, owner, fallback, fs = nodeFs) {
  if (!matchesOwner(load(file, fs), owner)) return fallback;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    if (!same(fs.fstatSync(fd, { bigint: true }), owner.log) || !matchesOwner(load(file, fs), owner)) return fallback;
    return fs.readFileSync(fd, 'utf8');
  } catch (error) { return fallback; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (error) {} } }
}

function claim(file, owner, fs = nodeFs, strictIO = false) {
  if (!matchesOwner(load(file, fs, strictIO), owner)) return null;
  const discard = path.join(path.dirname(file), `.subtool-log-${randomUUID()}.discard`);
  let moved = false;
  try {
    fs.renameSync(file, discard);
    moved = true;
    if (same(fs.lstatSync(discard, { bigint: true }), owner.log)) {
      moved = false;
      return discard;
    }
  } catch (error) {
    if (strictIO && error.code !== 'ENOENT') throw error;
  } finally {
    if (moved) { try { if (!fs.existsSync(file)) fs.renameSync(discard, file); } catch (error) { if (strictIO) throw error; } }
  }
  return null;
}

function removeReceipt(file, owner, fs = nodeFs) {
  const source = receiptPath(file);
  const discard = path.join(path.dirname(file), `.subtool-receipt-${randomUUID()}.discard`);
  let moved = false;
  try {
    if (!same(fs.lstatSync(source, { bigint: true }), owner.receiptIdentity)) return;
    fs.renameSync(source, discard);
    moved = true;
    if (same(fs.lstatSync(discard, { bigint: true }), owner.receiptIdentity)) {
      fs.unlinkSync(discard);
      moved = false;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally {
    if (moved) { try { if (!fs.existsSync(source)) fs.renameSync(discard, source); } catch (error) {} }
  }
}

async function remove(file, owner, fs = nodeFs) {
  const current = load(file, fs);
  if (!matchesOwner(current, owner)) return false;
  const discard = claim(file, current, fs);
  if (!discard) return false;
  try { fs.unlinkSync(discard); }
  catch (error) {
    try { if (!fs.existsSync(file)) fs.renameSync(discard, file); } catch (error) {}
    return false;
  }
  removeReceipt(file, current, fs);
  return true;
}

function removeJobLogs(directory, jobId, fs = nodeFs) {
  const job = keyForJob(jobId);
  const prefix = `diagnostic-${job}-`;
  let names;
  try { names = fs.readdirSync(directory); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.log.owner')) continue;
    const file = path.join(directory, name.slice(0, -'.owner'.length));
    const owner = readReceipt(file, fs, true);
    if (!owner || owner.job !== job) continue;
    try { fs.lstatSync(file, { bigint: true }); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      removeReceipt(file, owner, fs);
      continue;
    }
    if (!matchesOwner(load(file, fs, true), owner)) continue;
    const discard = claim(file, owner, fs, true);
    if (!discard) continue;
    try { fs.unlinkSync(discard); removeReceipt(file, owner, fs); }
    catch (error) {
      try { if (!fs.existsSync(file) && fs.existsSync(discard)) fs.renameSync(discard, file); } catch (ignored) {}
      throw error;
    }
  }
}

module.exports = { queueLogPath, record, load, matchesOwner, read, remove, removeJobLogs };
