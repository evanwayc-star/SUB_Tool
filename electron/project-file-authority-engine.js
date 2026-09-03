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
const { PROJECT_FILE, collectProjectMediaPaths, parseProjectBuffer } = require('./file-authority');

const RECENT_MAX_ENTRIES = 10;

/** 只留下形狀正確的項目——設定檔是使用者可改的，不可信任它的內容。 */
function sanitizeRecentList(list, max = RECENT_MAX_ENTRIES) {
  return (Array.isArray(list) ? list : [])
    .filter(item => item && typeof item.path === 'string' && item.path.trim())
    .slice(0, max);
}

/** 把一個路徑推到清單最前面。 */
function addRecent(list, filePath, { max = RECENT_MAX_ENTRIES, now = 0 } = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) return sanitizeRecentList(list, max);
  let resolved;
  try { resolved = path.resolve(filePath); } catch (e) { return sanitizeRecentList(list, max); }

  const key = resolved.toLowerCase();
  const next = [{ path: resolved, name: path.basename(resolved), at: now }];
  for (const item of sanitizeRecentList(list, Infinity)) {
    if (String(item.path).toLowerCase() === key) continue;
    next.push(item);
    if (next.length >= max) break;
  }
  return next;
}

/** 從清單移除一筆（檔案已不存在時用）。 */
function removeRecent(list, filePath) {
  const key = String(filePath || '').toLowerCase();
  return sanitizeRecentList(list, Infinity).filter(item => String(item.path).toLowerCase() !== key);
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

async function commitAdmittedProjectWrite(projectFile, buffer, {
  ensureDirectory,
  writeFile,
  clearTrustedDeclarations,
} = {}) {
  if (typeof projectFile !== 'string' || !projectFile || !Buffer.isBuffer(buffer) || typeof writeFile !== 'function') {
    return null;
  }
  if (typeof ensureDirectory === 'function') {
    await ensureDirectory(projectFile);
  }
  await writeFile(projectFile, buffer);
  return finalizeProjectWrite(projectFile, { clearTrustedDeclarations });
}

/**
 * 建立專案工作區管理器實例。
 */
function createProjectWorkspace({
  readFile,
  writeFile,
  ensureDirectory,
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
      return [];
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

  const remember = projectFile => saveRecent(
    RecentProjects.addRecent(recentList(), projectFile, { now: now() }),
  );

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
    const buffer = await readProject(projectFile);
    return commitOpen(projectFile, buffer, options);
  }

  async function openLatest(projectFile, options) {
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
      result = await openLatest(projectFile);
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

    const saved = await commitAdmittedProjectWrite(projectFile, buffer, {
      ensureDirectory: ensureParent ? ensureDirectory : null,
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
    const list = recentList();
    const missing = await Promise.all(list.map(item => missingProbe(item.path)));
    return list.map((item, index) => ({
      index,
      path: item.path,
      name: item.name || path.basename(item.path),
      at: item.at || 0,
      missing: missing[index],
    }));
  }

  async function openRecent(index) {
    const list = recentList();
    const item = list[Math.trunc(Number(index))];
    if (!item) return null;
    const result = await open(item.path);
    if (!result && await missingProbe(item.path)) {
      saveRecent(RecentProjects.removeRecent(list, item.path));
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
    openLatest,
    openRecent,
    openStartup,
    stageStartup,
    writeRendererProject,
  });
}

module.exports = {
  authorizeDroppedMediaPath,
  commitAdmittedProjectWrite,
  createProjectWorkspace,
  createTrustedProjectIntake,
  finalizeProjectWrite,
  inspectProjectWrite,
  isProjectFilePath,
  RecentProjects,
};
