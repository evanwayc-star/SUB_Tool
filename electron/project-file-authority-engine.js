/* ==============================================================================
   SUB Tool — Project File Authority Engine ("electron/project-file-authority-engine.js")
   ==============================================================================
   深層專案工作區空間與檔案權限防護引擎 (Project File Authority Engine)。
   負責專案檔案生命週期、信任准入、儲存審查、拖放安全與路徑圍堵：
   1. 專案工作區管理器 (createProjectWorkspace)
   2. 專案儲存能力准入檢查與提交 (inspectProjectWrite / commitAdmittedProjectWrite / finalizeProjectWrite)
   3. 受信任專案載入與媒體能力提升 (createTrustedProjectIntake)
   4. 拖放媒體檔案准入授權 (authorizeDroppedMediaPath / isProjectFilePath)
   ============================================================================== */
'use strict';

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { PROJECT_FILE, collectProjectMediaPaths, parseProjectBuffer } = require('./file-authority');
const { encodeUTF16LE } = require('../shared/text-encoding.cjs');

const RECENT_MAX_ENTRIES = 10;

/** 只留下形狀正確的項目——設定檔是使用者可改的，不可信任它的內容。 */
function sanitizeRecentList(list, max = RECENT_MAX_ENTRIES) {
  return (Array.isArray(list) ? list : [])
    .filter(item => item && typeof item.path === 'string' && item.path.trim())
    .slice(0, max);
}

/** 把一個路徑推到清單最前面。 */
function recentPathKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function addRecent(list, filePath, { max = RECENT_MAX_ENTRIES, now = 0 } = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) return sanitizeRecentList(list, max);
  let resolved;
  try { resolved = path.resolve(filePath); } catch (e) { return sanitizeRecentList(list, max); }

  const key = recentPathKey(resolved);
  const next = [{ path: resolved, name: path.basename(resolved), at: now }];
  for (const item of sanitizeRecentList(list, Infinity)) {
    if (recentPathKey(item.path) === key) continue;
    next.push(item);
    if (next.length >= max) break;
  }
  return next;
}

/** 從清單移除一筆（檔案已不存在時用）。 */
function removeRecent(list, filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return sanitizeRecentList(list, Infinity);
  const key = recentPathKey(filePath);
  return sanitizeRecentList(list, Infinity).filter(item => recentPathKey(item.path) !== key);
}

/** 造一支「這個路徑還在不在」的探測器。 */
function createMissingProbe({ stat, timeoutMs = 400 }) {
  return async function missing(p) {
    let timer;
    try {
      const st = await Promise.race([
        stat(p),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('__timeout__')), timeoutMs);
        }),
      ]);
      return !st.isFile();
    } catch (e) {
      return !!e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');
    } finally {
      clearTimeout(timer);
    }
  };
}

const RecentProjects = Object.freeze({
  MAX_ENTRIES: RECENT_MAX_ENTRIES,
  sanitize: sanitizeRecentList,
  addRecent,
  removeRecent,
  createMissingProbe,
});

/**
 * 檢查路徑是否為專案檔 (.subtool 或 .json)。
 */
function isProjectFilePath(filePath) {
  return typeof filePath === 'string' && PROJECT_FILE.test(filePath);
}

/**
 * 授權使用者拖放的非專案媒體檔案。
 */
function authorizeDroppedMediaPath(filePath, {
  grantRead,
  grantScreenshotDirectory,
  pathModule = path,
} = {}) {
  if (typeof filePath !== 'string' || !filePath || isProjectFilePath(filePath)) {
    return null;
  }
  if (typeof grantRead !== 'function' || !grantRead(filePath)) {
    return null;
  }
  if (typeof grantScreenshotDirectory === 'function') {
    grantScreenshotDirectory(pathModule.dirname(filePath));
  }
  return filePath;
}

/**
 * 建立受信任專案載入管理實例。
 */
function createTrustedProjectIntake({
  readFile,
  grantProjectFile,
  grantMediaFile,
  pathModule = path,
  caseInsensitive,
} = {}) {
  const read = typeof readFile === 'function' ? readFile : () => null;
  const grantProject = typeof grantProjectFile === 'function' ? grantProjectFile : () => {};
  const grantMedia = typeof grantMediaFile === 'function' ? grantMediaFile : () => {};
  const insensitive = caseInsensitive ?? (pathModule === path.win32 || process.platform === 'win32');
  const declaredMediaByProject = new Map();

  const key = value => {
    if (typeof value !== 'string' || !value) return null;
    try {
      const resolved = pathModule.resolve(value);
      return insensitive ? resolved.toLowerCase() : resolved;
    } catch (error) {
      return null;
    }
  };

  function grantProjectOnly(projectFile) {
    if (typeof projectFile !== 'string' || !projectFile) return null;
    grantProject(projectFile);
    const projectKey = key(projectFile);
    if (projectKey) declaredMediaByProject.delete(projectKey);
    return projectFile;
  }

  function grant(projectFile, contents = null) {
    if (typeof projectFile !== 'string' || !projectFile) return null;
    let projectBuffer = Buffer.isBuffer(contents) ? contents : null;
    if (!projectBuffer) {
      try {
        projectBuffer = read(projectFile);
      } catch (error) {
        projectBuffer = null;
      }
    }
    if (!Buffer.isBuffer(projectBuffer)) return null;

    const project = parseProjectBuffer(projectBuffer);
    if (!project) return null;
    const mediaPaths = collectProjectMediaPaths(project);
    grantProjectOnly(projectFile);

    for (const mediaPath of mediaPaths) {
      grantMedia(mediaPath);
    }
    const projectKey = key(projectFile);
    if (projectKey) {
      declaredMediaByProject.set(projectKey, new Set(mediaPaths.map(key).filter(Boolean)));
    }
    return projectBuffer;
  }

  function canRelink(projectFile, oldMediaPath) {
    const projectKey = key(projectFile);
    const mediaKey = key(oldMediaPath);
    return !!projectKey && !!mediaKey && declaredMediaByProject.get(projectKey)?.has(mediaKey) === true;
  }

  return Object.freeze({ grant, grantProjectOnly, canRelink });
}

/**
 * 檢查專案二進位 Buffer 是否具備合法的儲存准入資格。
 */
function inspectProjectWrite(buffer, { canRead } = {}) {
  const project = parseProjectBuffer(buffer);
  if (!project) {
    return Object.freeze({
      allowed: false,
      reason: 'invalid-project',
      mediaPaths: [],
      unauthorizedPaths: [],
    });
  }

  const mediaPaths = collectProjectMediaPaths(project);
  const readable = typeof canRead === 'function' ? canRead : () => false;
  const unauthorizedPaths = mediaPaths.filter(mediaPath => !readable(mediaPath));

  return Object.freeze({
    allowed: unauthorizedPaths.length === 0,
    reason: unauthorizedPaths.length ? 'unauthorized-media' : null,
    mediaPaths,
    unauthorizedPaths,
  });
}

function finalizeProjectWrite(projectFile, { clearTrustedDeclarations } = {}) {
  if (typeof projectFile !== 'string' || !projectFile) return null;
  if (typeof clearTrustedDeclarations === 'function') {
    clearTrustedDeclarations(projectFile);
  }
  return projectFile;
}

// 保存只在所選實體根的私有檔案完整關閉後才發布，失敗不截斷上一份專案。
// 同一實體目標依呼叫順序保存，避免 autosave／手動保存以較慢的舊寫入覆蓋新資料。
function createAtomicProjectWriter({ fsModule = { ...fs, ...fsp }, createToken = crypto.randomUUID } = {}) {
  const pending = new Map();
  let admission = Promise.resolve();
  const unsafe = () => Object.assign(new Error('專案寫入目錄已變更、包含連結或超出備份範圍'), { code: 'UNSAFE_PROJECT_OUTPUT' });
  const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
  const canonical = file => process.platform === 'win32' ? file.toLowerCase() : file;
  const statIfPresent = async file => {
    try { return await fsModule.lstat(file, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const statIfPresentSync = file => {
    try { return fsModule.lstatSync(file, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  async function prepareParents(target, ensureParent) {
    // The selected project directory may itself be a mounted/linked location.
    // Its private backup descendants must remain real directories inside it.
    let anchor = path.dirname(target);
    for (let current = anchor; path.dirname(current) !== current; current = path.dirname(current)) {
      const name = path.basename(current);
      if (name === '.subtool_AutoSave'
        || (process.platform === 'win32' && name.toLowerCase() === '.subtool_autosave')) anchor = path.dirname(current);
    }
    const root = await fsModule.realpath(anchor);
    const owner = await fsModule.lstat(root, { bigint: true });
    if (!owner.isDirectory() || owner.isSymbolicLink()) throw unsafe();
    const parents = [{ file: root, owner }];
    const checkRootSync = () => {
      const current = statIfPresentSync(root);
      if (!current?.isDirectory() || current.isSymbolicLink() || !sameFile(current, owner)) throw unsafe();
    };
    const check = async () => {
      if (canonical(await fsModule.realpath(anchor)) !== canonical(root)) throw unsafe();
      for (const parent of parents) {
        const current = await statIfPresent(parent.file);
        if (!current?.isDirectory() || current.isSymbolicLink() || !sameFile(current, parent.owner)) throw unsafe();
      }
    };
    const checkSync = () => {
      // promises.realpath 使用 native 解析；同步核對也須展開 Windows 8.3 短名，
      // 不能把同一實體目錄的短／長拼法誤判成替換。下方身分與連結檢查仍保留。
      const resolve = fsModule.realpathSync.native || fsModule.realpathSync;
      if (canonical(resolve(anchor)) !== canonical(root)) throw unsafe();
      for (const parent of parents) {
        const current = statIfPresentSync(parent.file);
        if (!current?.isDirectory() || current.isSymbolicLink() || !sameFile(current, parent.owner)) throw unsafe();
      }
    };
    let current = root;
    const relative = path.relative(anchor, path.dirname(target));
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw unsafe();
    for (const segment of relative ? relative.split(path.sep) : []) {
      await check();
      current = path.join(current, segment);
      let directory = await statIfPresent(current);
      if (!directory && ensureParent) {
        try { await fsModule.mkdir(current); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        directory = await statIfPresent(current);
      }
      if (!directory?.isDirectory() || directory.isSymbolicLink()) throw unsafe();
      parents.push({ file: current, owner: directory });
    }
    await check();
    const name = path.basename(target);
    if (process.platform === 'win32' && name.includes(':')) throw unsafe();
    return { root, target: path.join(current, name), check, checkSync, checkRootSync };
  }
  const checkTarget = async target => {
    const existing = await statIfPresent(target);
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw unsafe();
  };
  const checkTargetSync = target => {
    const existing = statIfPresentSync(target);
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw unsafe();
  };
  return function writeProject(projectFile, contents, { ensureParent = false } = {}) {
    const target = path.resolve(projectFile);
    // Resolve aliases in call order without blocking main on synchronous path
    // discovery. Different admitted files can still write concurrently.
    const preparedResult = admission.then(() => prepareParents(target, ensureParent));
    admission = preparedResult.catch(() => {});
    return preparedResult.then(prepared => {
      const key = canonical(prepared.target);
      const operation = (pending.get(key) || Promise.resolve()).then(async () => {
        await prepared.check();
        await checkTarget(prepared.target);
        // Stage at the selected root, so replacing a nested backup parent cannot
        // redirect the temporary file or make its cleanup touch another owner.
        const temporary = path.join(prepared.root, `${path.basename(target)}.${createToken()}.tmp`);
        let handle;
        let temporaryOwner;
        try {
          handle = await fsModule.open(temporary, 'wx');
          temporaryOwner = await handle.stat({ bigint: true });
          await prepared.check();
          await handle.writeFile(contents);
          await handle.sync();
          await handle.close();
          handle = null;
          await prepared.check();
          // No await between the final ownership checks and publication: an
          // earlier async stat result cannot certify a later directory object.
          prepared.checkSync();
          checkTargetSync(prepared.target);
          const current = statIfPresentSync(temporary);
          if (!current?.isFile() || current.isSymbolicLink() || !sameFile(current, temporaryOwner)) throw unsafe();
          fsModule.renameSync(temporary, prepared.target);
        } finally {
          if (handle) { try { await handle.close(); } catch (error) {} }
          if (temporaryOwner) {
            try {
              prepared.checkRootSync();
              const current = statIfPresentSync(temporary);
              if (current?.isFile() && !current.isSymbolicLink() && sameFile(current, temporaryOwner)) fsModule.unlinkSync(temporary);
            } catch (error) {}
          }
        }
      });
      const tail = operation.catch(() => {}).finally(() => {
        if (pending.get(key) === tail) pending.delete(key);
      });
      pending.set(key, tail);
      return operation;
    });
  };
}

async function commitAdmittedProjectWrite(projectFile, buffer, {
  ensureParent = false,
  writeFile,
  clearTrustedDeclarations,
} = {}) {
  if (typeof projectFile !== 'string' || !projectFile || !Buffer.isBuffer(buffer) || typeof writeFile !== 'function') {
    return null;
  }
  await writeFile(projectFile, buffer, { ensureParent });
  return finalizeProjectWrite(projectFile, { clearTrustedDeclarations });
}

/**
 * 建立專案工作區管理器實例。
 */
function createProjectWorkspace({
  readFile,
  writeFile,
  saveMetadata,
  grantProjectFile,
  grantMediaFile,
  canReadMedia,
  readRecent = () => [],
  writeRecent = () => {},
  stat,
  now = () => Date.now(),
  isProjectPath = value => typeof value === 'string' && PROJECT_FILE.test(value),
} = {}) {
  const intake = createTrustedProjectIntake({ grantProjectFile, grantMediaFile });
  const missingProbe = typeof stat === 'function'
    ? RecentProjects.createMissingProbe({ stat })
    : async () => false;

  let pendingStartupPath = null;
  let startupClaimed = false;
  let latestOpenGeneration = 0;

  const recentList = () => {
    try {
      return RecentProjects.sanitize(readRecent());
    } catch (error) {
      return null;
    }
  };

  const saveRecent = list => {
    try {
      writeRecent(RecentProjects.sanitize(list));
      return true;
    } catch (error) {
      return false;
    }
  };

  const remember = projectFile => {
    const list = recentList();
    // 顯示可暫時沒有項目，但不能以讀取失敗時的空值覆寫既有清單。
    return list !== null && saveRecent(RecentProjects.addRecent(list, projectFile, { now: now() }));
  };
  // 身分只用來在目前受信清單內定位，不能以 renderer 的路徑擴張授權。
  const recentToken = item => crypto.createHash('sha256').update(recentPathKey(item.path)).digest('hex');

  async function readProject(projectFile) {
    if (!isProjectPath(projectFile) || typeof readFile !== 'function') return null;
    try {
      const buffer = await readFile(projectFile);
      return Buffer.isBuffer(buffer) ? buffer : null;
    } catch (error) {
      return null;
    }
  }

  function commitOpen(projectFile, buffer, { rememberRecent = true } = {}) {
    if (!buffer || !intake.grant(projectFile, buffer)) return null;
    if (rememberRecent) remember(projectFile);
    return { path: projectFile, b64: buffer.toString('base64') };
  }

  async function open(projectFile, options) {
    const generation = ++latestOpenGeneration;
    const buffer = await readProject(projectFile);
    if (generation !== latestOpenGeneration) return null;
    return commitOpen(projectFile, buffer, options);
  }

  function stageStartup(projectFile) {
    if (!isProjectPath(projectFile)) return false;
    pendingStartupPath = projectFile;
    latestOpenGeneration += 1;
    return true;
  }

  async function openStartup(fallbackPaths = []) {
    const allowFallback = !startupClaimed;
    startupClaimed = true;
    let fallback = allowFallback && Array.isArray(fallbackPaths)
      ? fallbackPaths.find(isProjectPath) || null
      : null;
    let result = null;
    do {
      const projectFile = pendingStartupPath || fallback;
      pendingStartupPath = null;
      fallback = null;
      if (!projectFile) return result;
      result = await open(projectFile);
    } while (pendingStartupPath);
    return result;
  }

  async function writeRendererProject(projectFile, b64, {
    ensureParent = false,
    remember: shouldRemember = false,
  } = {}) {
    if (!isProjectPath(projectFile) || typeof b64 !== 'string') return null;
    let buffer;
    try {
      buffer = Buffer.from(b64, 'base64');
    } catch (error) {
      return null;
    }

    const admission = inspectProjectWrite(buffer, { canRead: canReadMedia });
    if (!admission.allowed) return null;

    // 檔案識別資訊由實際寫檔的電腦提供，不沿用開啟專案時的舊值。
    // 只在持久化時加入，renderer 的 committed snapshot／dirty 基準不受影響。
    let contents = parseProjectBuffer(buffer);
    if (typeof saveMetadata === 'function') {
      const metadata = saveMetadata();
      delete contents['SUB Tool'];
      delete contents['User Name'];
      contents = {
        'SUB Tool': metadata.appVersion,
        'User Name': metadata.computerName,
        ...contents,
      };
    }
    // 新寫入統一 UTF-16LE BOM；舊檔讀取仍相容 UTF-8 與兩種 UTF-16 位元序。
    buffer = Buffer.from(encodeUTF16LE(JSON.stringify(contents, null, 1)));

    const saved = await commitAdmittedProjectWrite(projectFile, buffer, {
      ensureParent,
      writeFile,
      clearTrustedDeclarations: file => intake.grantProjectOnly(file),
    });

    if (saved && shouldRemember) remember(saved);
    return saved;
  }

  function acceptsRendererProject(b64) {
    if (typeof b64 !== 'string') return false;
    let buffer;
    try {
      buffer = Buffer.from(b64, 'base64');
    } catch (error) {
      return false;
    }
    return inspectProjectWrite(buffer, { canRead: canReadMedia }).allowed;
  }

  async function listRecent() {
    const list = recentList() || [];
    const missing = await Promise.all(list.map(item => missingProbe(item.path)));
    return list.map((item, index) => ({
      index,
      token: recentToken(item),
      path: item.path,
      name: item.name || path.basename(item.path),
      at: item.at || 0,
      missing: missing[index],
    }));
  }

  async function openRecent(token) {
    const list = recentList() || [];
    const item = typeof token === 'string' ? list.find(entry => recentToken(entry) === token) : null;
    if (!item) return null;
    const result = await open(item.path);
    if (!result && await missingProbe(item.path)) {
      const latest = recentList();
      if (latest !== null) saveRecent(RecentProjects.removeRecent(latest, item.path));
    }
    return result;
  }

  function clearRecent() {
    return saveRecent([]);
  }

  return Object.freeze({
    acceptsRendererProject,
    canRelink: (projectFile, mediaPath) => intake.canRelink(projectFile, mediaPath),
    clearRecent,
    listRecent,
    open,
    openRecent,
    openStartup,
    stageStartup,
    writeRendererProject,
  });
}

module.exports = {
  authorizeDroppedMediaPath,
  commitAdmittedProjectWrite,
  createAtomicProjectWriter,
  createProjectWorkspace,
  createTrustedProjectIntake,
  finalizeProjectWrite,
  inspectProjectWrite,
  isProjectFilePath,
  RecentProjects,
};
