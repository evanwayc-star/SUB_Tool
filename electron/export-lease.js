'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function requirePath(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    const error = new TypeError(`${name} must be a non-empty path`);
    error.code = 'INVALID_LEASE_ARGUMENT';
    throw error;
  }
  return value;
}

function normalizeOutputPath(outPath) {
  const absolute = path.resolve(requirePath(outPath, 'outPath'));
  const parent = path.dirname(absolute);
  let normalized = absolute;
  try {
    normalized = path.join(fs.realpathSync.native(parent), path.basename(absolute));
  } catch {
    // The output directory may not have been created yet. path.resolve still
    // removes relative aliases, and acquisition remains fail-closed by key.
  }
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function outputKey(outPath) {
  return crypto
    .createHash('sha256')
    .update(normalizeOutputPath(outPath), 'utf8')
    .digest('hex');
}

function leaseRoot(queueDir) {
  return path.join(path.resolve(requirePath(queueDir, 'queueDir')), 'output-leases');
}

function leaseError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function optionalPid(value, name) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value <= 0) {
    throw leaseError(
      'INVALID_LEASE_ARGUMENT',
      `${name} must be a positive integer or null`,
    );
  }
  return value;
}

function optionalPipeName(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw leaseError(
      'INVALID_LEASE_ARGUMENT',
      'pipeName must be a non-empty string or null',
    );
  }
  return value;
}

function requireToken(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw leaseError(
      'INVALID_LEASE_ARGUMENT',
      'token must be a non-empty string',
    );
  }
  return value;
}

function requireJobId(value) {
  if (
    (typeof value !== 'string' && typeof value !== 'number')
    || String(value).trim() === ''
  ) {
    throw leaseError(
      'INVALID_LEASE_ARGUMENT',
      'jobId must be a non-empty string or number',
    );
  }
  return value;
}

function busyError(lockPath, outPath) {
  return leaseError(
    'OUTPUT_BUSY',
    `Output path is already leased: ${outPath}`,
    { lockPath, outPath },
  );
}

function leaseLocation(queueDir, outPath) {
  const normalizedOutPath = normalizeOutputPath(outPath);
  const key = outputKey(normalizedOutPath);
  const lockPath = path.join(leaseRoot(queueDir), `${key}.lock`);
  return { key, lockPath, outPath: normalizedOutPath };
}

function corruptError(lockPath, reason) {
  return leaseError(
    'LEASE_CORRUPT',
    `Output lease is corrupt: ${reason}`,
    { lockPath, reason },
  );
}

function validateOwner(owner, lockPath, expectedOutPath = null) {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) {
    throw corruptError(lockPath, 'owner.json must contain an object');
  }
  if (typeof owner.token !== 'string' || owner.token.trim() === '') {
    throw corruptError(lockPath, 'owner token is missing');
  }
  if (
    (typeof owner.jobId !== 'string' && typeof owner.jobId !== 'number')
    || String(owner.jobId).trim() === ''
  ) {
    throw corruptError(lockPath, 'owner jobId is missing');
  }
  if (typeof owner.outPath !== 'string' || owner.outPath.trim() === '') {
    throw corruptError(lockPath, 'owner outPath is missing');
  }
  if (
    expectedOutPath != null
    && normalizeOutputPath(owner.outPath) !== expectedOutPath
  ) {
    throw corruptError(lockPath, 'owner outPath does not match the lock key');
  }
  for (const field of ['watchdogPid', 'ffmpegPid']) {
    const value = owner[field];
    if (value != null && (!Number.isInteger(value) || value <= 0)) {
      throw corruptError(lockPath, `${field} is invalid`);
    }
  }
  if (
    owner.pipeName != null
    && (typeof owner.pipeName !== 'string' || owner.pipeName.trim() === '')
  ) {
    throw corruptError(lockPath, 'pipeName is invalid');
  }
  if (
    typeof owner.createdAt !== 'string'
    || Number.isNaN(Date.parse(owner.createdAt))
  ) {
    throw corruptError(lockPath, 'createdAt is invalid');
  }
  return owner;
}

function readOwner(lockPath, expectedOutPath = null) {
  if (!fs.existsSync(lockPath)) {
    throw leaseError(
      'LEASE_NOT_FOUND',
      `Output lease does not exist: ${lockPath}`,
      { lockPath },
    );
  }
  const ownerPath = path.join(lockPath, 'owner.json');
  let owner;
  try {
    owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  } catch (error) {
    throw corruptError(lockPath, `owner.json cannot be read: ${error.message}`);
  }
  return validateOwner(owner, lockPath, expectedOutPath);
}

function assertOwnerToken(owner, token, lockPath) {
  const requested = requireToken(token);
  if (owner.token !== requested) {
    throw leaseError(
      'LEASE_TOKEN_MISMATCH',
      'Output lease token does not match its owner',
      { lockPath },
    );
  }
}

function acquireLease({
  queueDir,
  outPath,
  jobId,
  token = crypto.randomUUID(),
  watchdogPid = null,
  pipeName = null,
} = {}) {
  const normalizedOutPath = normalizeOutputPath(outPath);
  const key = outputKey(normalizedOutPath);
  const root = leaseRoot(queueDir);
  const lockPath = path.join(root, `${key}.lock`);
  const owner = {
    token: requireToken(token),
    jobId: requireJobId(jobId),
    outPath: normalizedOutPath,
    watchdogPid: optionalPid(watchdogPid, 'watchdogPid'),
    ffmpegPid: null,
    pipeName: optionalPipeName(pipeName),
    createdAt: new Date().toISOString(),
  };

  fs.mkdirSync(root, { recursive: true });
  if (fs.existsSync(lockPath)) throw busyError(lockPath, normalizedOutPath);

  const tempPath = fs.mkdtempSync(
    path.join(root, `.${key}.${process.pid}.`),
  );
  let moved = false;
  try {
    fs.writeFileSync(
      path.join(tempPath, 'owner.json'),
      `${JSON.stringify(owner, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );

    // A non-empty directory cannot be replaced by rename on supported
    // platforms. The pre-check also preserves an older empty/corrupt lock.
    if (fs.existsSync(lockPath)) throw busyError(lockPath, normalizedOutPath);
    try {
      fs.renameSync(tempPath, lockPath);
      moved = true;
    } catch (error) {
      if (fs.existsSync(lockPath)) throw busyError(lockPath, normalizedOutPath);
      throw error;
    }
  } finally {
    if (!moved) fs.rmSync(tempPath, { recursive: true, force: true });
  }

  return { key, lockPath, owner };
}

function updateLease(options = {}) {
  const {
    queueDir,
    outPath,
    token,
  } = options;
  const location = leaseLocation(queueDir, outPath);
  const current = readOwner(location.lockPath, location.outPath);
  assertOwnerToken(current, token, location.lockPath);

  const owner = { ...current };
  if (Object.hasOwn(options, 'watchdogPid')) {
    owner.watchdogPid = optionalPid(options.watchdogPid, 'watchdogPid');
  }
  if (Object.hasOwn(options, 'ffmpegPid')) {
    owner.ffmpegPid = optionalPid(options.ffmpegPid, 'ffmpegPid');
  }
  if (Object.hasOwn(options, 'pipeName')) {
    owner.pipeName = optionalPipeName(options.pipeName);
  }

  const ownerPath = path.join(location.lockPath, 'owner.json');
  const tempPath = path.join(
    location.lockPath,
    `.owner.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(
      tempPath,
      `${JSON.stringify(owner, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    // Re-check immediately before replacement so an unrelated owner can never
    // be overwritten by a stale updater.
    const latest = readOwner(location.lockPath, location.outPath);
    assertOwnerToken(latest, token, location.lockPath);
    fs.renameSync(tempPath, ownerPath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }

  return {
    key: location.key,
    lockPath: location.lockPath,
    owner,
  };
}

function releaseLease({ queueDir, outPath, token } = {}) {
  const location = leaseLocation(queueDir, outPath);
  if (!fs.existsSync(location.lockPath)) return false;
  const owner = readOwner(location.lockPath, location.outPath);
  assertOwnerToken(owner, token, location.lockPath);
  fs.rmSync(location.lockPath, { recursive: true, force: false });
  return true;
}

function listLeases(queueDirOrOptions) {
  const queueDir = (
    queueDirOrOptions
    && typeof queueDirOrOptions === 'object'
    && !Array.isArray(queueDirOrOptions)
  )
    ? queueDirOrOptions.queueDir
    : queueDirOrOptions;
  const root = leaseRoot(queueDir);
  if (!fs.existsSync(root)) return [];

  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.name.endsWith('.lock'))
    .sort((a, b) => a.name.localeCompare(b.name));

  return entries.map(entry => {
    const key = entry.name.slice(0, -'.lock'.length);
    const lockPath = path.join(root, entry.name);
    try {
      if (!entry.isDirectory()) {
        throw corruptError(lockPath, 'lock is not a directory');
      }
      if (!/^[a-f0-9]{64}$/.test(key)) {
        throw corruptError(lockPath, 'lock key is not a SHA-256 digest');
      }
      const owner = readOwner(lockPath);
      const normalized = normalizeOutputPath(owner.outPath);
      if (owner.outPath !== normalized || outputKey(normalized) !== key) {
        throw corruptError(lockPath, 'owner outPath does not match the lock key');
      }
      return { valid: true, key, lockPath, owner };
    } catch (error) {
      const failure = error?.code === 'LEASE_CORRUPT'
        ? error
        : corruptError(lockPath, error?.message || 'unknown lease error');
      return {
        valid: false,
        key,
        lockPath,
        error: {
          code: failure.code,
          message: failure.message,
          reason: failure.reason,
        },
      };
    }
  });
}

module.exports = {
  acquireLease,
  leaseRoot,
  listLeases,
  normalizeOutputPath,
  outputKey,
  releaseLease,
  updateLease,
};
