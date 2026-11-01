'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { assertDiscWorkspace } = require('./disc-authoring');

const pathKey = value => {
  const absolute = path.resolve(requirePath(value, 'path'));
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
};
const unsafeOutput = cause => leaseError('UNSAFE_DELIVERY_OUTPUT',
  '交付輸出目錄已變更或包含未授權連結；請重新選擇輸出資料夾後重試', { cause });
const directoryIdentity = (file, io = fs) => {
  const stat = io.lstatSync(file, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafeOutput();
  return { path: file, dev: String(stat.dev), ino: String(stat.ino) };
};
function checkDirectoryIdentity(owner, io = fs) {
  if (!owner || typeof owner.path !== 'string' || !/^\d+$/.test(owner.dev) || !/^\d+$/.test(owner.ino)) throw unsafeOutput();
  const current = directoryIdentity(owner.path, io);
  if (current.dev !== owner.dev || current.ino !== owner.ino
    || pathKey(io.realpathSync.native(owner.path)) !== pathKey(owner.path)) throw unsafeOutput();
}

// A native picker may itself select a junction. Bind that selection to its
// physical directory; descendants never acquire authority through a junction.
function captureOutputDirectory(directory, io = fs) {
  try {
    const requestedPath = path.resolve(requirePath(directory, 'directory'));
    const root = directoryIdentity(io.realpathSync.native(requestedPath), io);
    return { requestedPath, ...root };
  } catch (error) { throw unsafeOutput(error); }
}

function captureOutputAuthority(outPath, root, io = fs) {
  try {
    checkDirectoryIdentity(root, io);
    if (pathKey(io.realpathSync.native(root.requestedPath)) !== pathKey(root.path)) throw unsafeOutput();
    const requestedPath = path.resolve(requirePath(outPath, 'outPath'));
    const relative = path.relative(root.requestedPath, path.dirname(requestedPath));
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw unsafeOutput();
    const name = path.basename(requestedPath);
    if (process.platform === 'win32' && name.includes(':')) throw unsafeOutput();
    const parents = [{ path: root.path, dev: root.dev, ino: root.ino }];
    let current = root.path;
    for (const segment of relative ? relative.split(path.sep) : []) {
      current = path.join(current, segment);
      parents.push(directoryIdentity(current, io));
    }
    const authority = { version: 1, rootPath: root.requestedPath, requestedPath,
      outPath: path.join(current, name), parents };
    assertOutputAuthority(authority, requestedPath, io);
    return authority;
  } catch (error) { throw unsafeOutput(error); }
}

function assertOutputAuthority(authority, outPath, io = fs) {
  try {
    if (authority?.version !== 1 || !Array.isArray(authority.parents) || !authority.parents.length
      || (pathKey(outPath) !== pathKey(authority.requestedPath) && pathKey(outPath) !== pathKey(authority.outPath))) throw unsafeOutput();
    const { parents } = authority;
    if (pathKey(io.realpathSync.native(authority.rootPath)) !== pathKey(parents[0].path)) throw unsafeOutput();
    for (let index = 0; index < parents.length; index++) {
      checkDirectoryIdentity(parents[index], io);
      if (index && pathKey(path.dirname(parents[index].path)) !== pathKey(parents[index - 1].path)) throw unsafeOutput();
    }
    const parent = parents.at(-1).path;
    if (pathKey(path.dirname(authority.outPath)) !== pathKey(parent)
      || pathKey(io.realpathSync.native(path.dirname(authority.requestedPath))) !== pathKey(parent)
      || path.basename(authority.outPath) !== path.basename(authority.requestedPath)) throw unsafeOutput();
    return authority;
  } catch (error) { throw unsafeOutput(error); }
}

function retargetOutputAuthority(authority, outPath) {
  assertOutputAuthority(authority, authority?.requestedPath);
  if (pathKey(path.dirname(outPath)) !== pathKey(path.dirname(authority.requestedPath))) throw unsafeOutput();
  const next = { ...authority, requestedPath: path.resolve(outPath),
    outPath: path.join(path.dirname(authority.outPath), path.basename(outPath)) };
  return assertOutputAuthority(next, outPath);
}

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

// A delivery is encoded beside its final file so the validated result can
// replace an existing deliverable with one same-volume rename. The token is
// hashed into a fixed filename; neither the caller nor recovery may choose an
// arbitrary deletion target.
function stageOutputPath(outPath, token) {
  return stagePathForCanonical(normalizeOutputPath(outPath), token);
}

function stagePathForCanonical(outPath, token) {
  const normalized = pathKey(outPath);
  const digest = crypto.createHash('sha256').update(requireToken(token), 'utf8').digest('hex');
  const extension = path.extname(normalized);
  const key = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
  return path.join(path.dirname(normalized), `.subtool-${key.slice(0, 16)}-${digest.slice(0, 32)}.stage${extension}`);
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

function leaseLocation(queueDir, outPath, leaseKey = null) {
  const normalizedOutPath = leaseKey ? pathKey(outPath) : normalizeOutputPath(outPath);
  const fixedKey = crypto.createHash('sha256').update(normalizedOutPath, 'utf8').digest('hex');
  if (leaseKey && leaseKey !== fixedKey) throw leaseError('INVALID_LEASE_ARGUMENT', 'leaseKey does not match the acquired output');
  const key = leaseKey || outputKey(normalizedOutPath);
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
    && pathKey(owner.outPath) !== expectedOutPath
  ) {
    throw corruptError(lockPath, 'owner outPath does not match the lock key');
  }
  for (const field of ['watchdogPid', 'ffmpegPid']) {
    const value = owner[field];
    if (value != null && (!Number.isInteger(value) || value <= 0)) {
      throw corruptError(lockPath, `${field} is invalid`);
    }
  }
  if (owner.outputStarted != null && typeof owner.outputStarted !== 'boolean') {
    throw corruptError(lockPath, 'outputStarted is invalid');
  }
  if (Object.hasOwn(owner, 'stagePath')
    && (typeof owner.stagePath !== 'string' || owner.stagePath !== stagePathForCanonical(owner.outPath, owner.token))) {
    throw corruptError(lockPath, 'stagePath does not match outPath and owner token');
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
  outputStarted,
  stagePath,
  outputAuthority,
} = {}) {
  if (outputStarted != null && typeof outputStarted !== 'boolean') {
    throw leaseError('INVALID_LEASE_ARGUMENT', 'outputStarted must be a boolean');
  }
  const normalizedOutPath = normalizeOutputPath(outPath);
  if (outputAuthority) assertOutputAuthority(outputAuthority, normalizedOutPath);
  if (stagePath != null && stagePath !== stageOutputPath(normalizedOutPath, token)) {
    throw leaseError('INVALID_LEASE_ARGUMENT', 'stagePath must be derived from outPath and token');
  }
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
    ...(outputStarted == null ? {} : { outputStarted }),
    ...(stagePath == null ? {} : { stagePath }),
    ...(outputAuthority == null ? {} : { outputAuthority }),
  };

  fs.mkdirSync(root, { recursive: true });
  if (fs.existsSync(lockPath)) throw busyError(lockPath, normalizedOutPath);

  const temporary = fs.mkdtempSync(path.toNamespacedPath(path.join(root, `.${key}.${process.pid}.`)));
  const tempPath = path.join(root, path.basename(temporary));
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
  const location = leaseLocation(queueDir, outPath, options.leaseKey);
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
  if (Object.hasOwn(options, 'outputStarted')) {
    if (typeof options.outputStarted !== 'boolean') {
      throw leaseError('INVALID_LEASE_ARGUMENT', 'outputStarted must be a boolean');
    }
    owner.outputStarted = options.outputStarted;
  }
  if (Object.hasOwn(options, 'stageIdentity')) owner.stageIdentity = options.stageIdentity;
  if (Object.hasOwn(options, 'workspaceAlias')) owner.workspaceAlias = options.workspaceAlias;
  if (Object.hasOwn(options, 'discWorkspace')) owner.discWorkspace = options.discWorkspace;
  if (Object.hasOwn(options, 'discWorkspacePending')) owner.discWorkspacePending = options.discWorkspacePending;

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

function releaseLease({ queueDir, outPath, token, leaseKey } = {}) {
  const location = leaseLocation(queueDir, outPath, leaseKey);
  if (!fs.existsSync(location.lockPath)) return false;
  const owner = readOwner(location.lockPath, location.outPath);
  assertOwnerToken(owner, token, location.lockPath);
  const entries = fs.readdirSync(location.lockPath);
  const workEntries = entries.filter(name => name.startsWith('subtool-disc-'));
  if (owner.discWorkspacePending && workEntries.length) throw leaseError('DISC_WORKSPACE_UNVERIFIED', '光碟工作資料夾身分尚未完整記錄，輸出鎖已保留');
  if (owner.discWorkspace) assertDiscWorkspace(owner.discWorkspace, { tempDir: location.lockPath, allowMissing: true });
  const knownWork = owner.discWorkspace && path.basename(owner.discWorkspace.workDir);
  if (workEntries.some(name => name !== knownWork)) {
    throw leaseError('DISC_WORKSPACE_UNVERIFIED', '光碟工作資料夾缺少原始身分，輸出鎖已保留');
  }
  // A lease directory is private, but a filename alone is not proof that its
  // current occupant belongs to this owner. Preserve unregistered entries
  // before removing even a verified workspace or its short alias.
  if (entries.some(name => name !== 'owner.json' && name !== knownWork)) {
    throw leaseError('LEASE_UNVERIFIED_ENTRY', '輸出鎖內有未登記的檔案，已保留內容；請檢查後改用新的交付檔名');
  }
  removeNativeWorkspace(owner, location.lockPath);
  // Disc encodes and transport replacements can be large and temporarily busy.
  // Keep owner.json readable until all private work has actually been removed,
  // otherwise a failed recursive delete would strand an unrecoverable lock.
  if (knownWork && entries.includes(knownWork)) fs.rmSync(path.join(location.lockPath, knownWork), { recursive: true, force: false });
  const latest = readOwner(location.lockPath, location.outPath);
  assertOwnerToken(latest, token, location.lockPath);
  const ownerPath = path.join(location.lockPath, 'owner.json');
  fs.unlinkSync(ownerPath);
  try {
    fs.rmdirSync(location.lockPath);
  } catch (error) {
    // Preserve recovery information if the directory cannot be removed (for
    // example another handle or a late-created private file). Never replace a
    // new owner if an unrelated process already recreated owner.json.
    try {
      fs.writeFileSync(ownerPath, `${JSON.stringify(latest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    } catch {}
    throw error;
  }
  return true;
}

function aliasName(token) {
  return `sd-${crypto.createHash('sha256').update(requireToken(token)).digest('hex').slice(0, 20)}`;
}

function nativeWorkspaceCandidates() {
  const candidates = [{ kind: 'temp', path: os.tmpdir() }];
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) candidates.push({ kind: 'local', path: path.join(process.env.LOCALAPPDATA, 'Temp') });
    if (process.env.USERPROFILE) candidates.push({ kind: 'profile', path: path.join(process.env.USERPROFILE, 'AppData', 'Local', 'Temp') });
  }
  return candidates.filter(candidate => path.isAbsolute(candidate.path));
}

function createNativeWorkspaceRoot(token) {
  let tooLong = false, denied = false;
  for (const candidate of nativeWorkspaceCandidates()) {
    let parent;
    try { parent = directoryIdentity(fs.realpathSync.native(candidate.path)); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) { denied = true; continue; }
      throw error;
    }
    const rootPath = path.join(parent.path, aliasName(token));
    // The DVD author creates these descendants relative to cwd. Limiting cwd
    // alone would still leave its longest file beyond the native MAX_PATH.
    const dvdFile = path.join(rootPath, 'work', 'subtool-disc-XXXXXX', 'dvd', 'VIDEO_TS', 'VTS_01_1.VOB');
    const bdStage = path.join(rootPath, 'work', 'subtool-disc-XXXXXX', 'out',
      `.subtool-${'0'.repeat(16)}-${'0'.repeat(32)}.stage.iso`);
    if (process.platform === 'win32' && Math.max(dvdFile.length, bdStage.length) >= 260) { tooLong = true; continue; }
    try { fs.mkdirSync(rootPath); }
    catch (error) {
      if (['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ENOTDIR'].includes(error.code)) { denied = true; continue; }
      throw error; // In particular, EEXIST never grants ownership.
    }
    return { parent, rootPath, parentKind: candidate.kind };
  }
  throw leaseError(tooLong ? 'DISC_TEMP_PATH_TOO_LONG' : 'DISC_TEMP_UNAVAILABLE',
    tooLong ? '沒有可寫且足夠短的個人暫存目錄；請將 TEMP 或本機暫存目錄設為較短且可寫的路徑'
      : '無法在個人暫存目錄建立光碟工作短路徑，請確認目錄可寫', { denied });
}

function inspectNativeWorkspace(owner, lockPath, { allowMissing = false } = {}) {
  const alias = owner.workspaceAlias;
  const selected = nativeWorkspaceCandidates().find(candidate => candidate.kind === (alias?.parentKind || 'temp'));
  if (!alias || pathKey(alias.target?.path) !== pathKey(lockPath)
    || path.basename(alias.root?.path || '') !== aliasName(owner.token)
    || pathKey(path.dirname(alias.root.path)) !== pathKey(alias.parent?.path)
    || !selected || pathKey(alias.parent.path) !== pathKey(fs.realpathSync.native(selected.path))) throw unsafeOutput();
  checkDirectoryIdentity(alias.parent);
  // Missing aliases do not grant authority over a replacement lease directory.
  checkDirectoryIdentity(alias.target);
  try { checkDirectoryIdentity(alias.root); }
  catch (error) { if (allowMissing && error.code === 'ENOENT') return { missing: true }; throw error; }
  const link = path.join(alias.root.path, 'work');
  let stat;
  try { stat = fs.lstatSync(link, { bigint: true }); }
  catch (error) { if (allowMissing && error.code === 'ENOENT') return { link, missingLink: true }; throw error; }
  if (!alias.link || !stat.isSymbolicLink() || String(stat.dev) !== alias.link.dev || String(stat.ino) !== alias.link.ino
    || pathKey(fs.realpathSync.native(link)) !== pathKey(alias.target.path)) throw unsafeOutput();
  return { link };
}

function removeNativeWorkspace(owner, lockPath) {
  if (!owner.workspaceAlias) return;
  const state = inspectNativeWorkspace(owner, lockPath, { allowMissing: true });
  if (state.missing) return;
  // Never recursively remove an alias: its target is the still-owned lease.
  if (!state.missingLink) fs.unlinkSync(state.link);
  fs.rmdirSync(owner.workspaceAlias.root.path);
}

function prepareNativeWorkspace(options) {
  const location = leaseLocation(options.queueDir, options.outPath, options.leaseKey);
  let owner = readOwner(location.lockPath, location.outPath);
  assertOwnerToken(owner, options.token, location.lockPath);
  if (!owner.workspaceAlias) {
    const { parent, rootPath, parentKind } = createNativeWorkspaceRoot(owner.token);
    const alias = { parent, parentKind, root: directoryIdentity(rootPath), target: directoryIdentity(location.lockPath), link: null };
    try { owner = updateLease({ ...options, workspaceAlias: alias }).owner; }
    catch (error) {
      // No junction exists yet; only remove the exact empty directory just made.
      try { checkDirectoryIdentity(alias.root); fs.rmdirSync(rootPath); } catch {}
      throw error;
    }
    const link = path.join(rootPath, 'work');
    fs.symlinkSync(location.lockPath, link, process.platform === 'win32' ? 'junction' : 'dir');
    const stat = fs.lstatSync(link, { bigint: true });
    alias.link = { dev: String(stat.dev), ino: String(stat.ino) };
    owner = updateLease({ ...options, workspaceAlias: alias }).owner;
  }
  const assertCurrent = () => inspectNativeWorkspace(owner, location.lockPath);
  return { path: assertCurrent().link, assertCurrent };
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
      const normalized = pathKey(owner.outPath);
      if (owner.outPath !== normalized || crypto.createHash('sha256').update(normalized, 'utf8').digest('hex') !== key) {
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
  assertOutputAuthority,
  captureOutputAuthority,
  captureOutputDirectory,
  retargetOutputAuthority,
  acquireLease,
  leaseRoot,
  listLeases,
  normalizeOutputPath,
  outputKey,
  releaseLease,
  stageOutputPath,
  stagePathForCanonical,
  prepareNativeWorkspace,
  updateLease,
};
