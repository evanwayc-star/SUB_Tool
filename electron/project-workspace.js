'use strict';

/* Electron project workspace is the single owner of trusted project intake,
   renderer-save admission, latest-wins OS opens and the persisted recent list.
   Electron events/dialogs stay thin adapters and cannot reorder these rules. */
const { PROJECT_FILE } = require('./file-authority');
const path = require('path');
const { createTrustedProjectIntake } = require('./trusted-project-intake');
const { commitAdmittedProjectWrite, inspectProjectWrite } = require('./project-write-admission');
const RecentProjects = require('./recent-projects');

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
    try { return RecentProjects.sanitize(readRecent()); } catch (error) { return []; }
  };

  const saveRecent = list => {
    try {
      writeRecent(RecentProjects.sanitize(list));
      return true;
    } catch (error) { return false; }
  };

  const remember = projectFile => saveRecent(
    RecentProjects.addRecent(recentList(), projectFile, { now: now() }),
  );

  async function readProject(projectFile) {
    if (!isProjectPath(projectFile) || typeof readFile !== 'function') return null;
    try {
      const buffer = await readFile(projectFile);
      return Buffer.isBuffer(buffer) ? buffer : null;
    } catch (error) { return null; }
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
    try { buffer = Buffer.from(b64, 'base64'); } catch (error) { return null; }
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
    try { buffer = Buffer.from(b64, 'base64'); } catch (error) { return false; }
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

module.exports = { createProjectWorkspace };
