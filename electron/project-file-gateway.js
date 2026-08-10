'use strict';

const { PROJECT_FILE } = require('./file-authority');
const { commitAdmittedProjectWrite } = require('./project-write-admission');

/* Main supplies filesystem and capability adapters once.  IPC handlers then
   cannot omit parse-before-grant, post-write declaration clearing, or recent
   list updates by reassembling those steps themselves. */
function createProjectFileGateway({
  readFile,
  writeFile,
  ensureDirectory,
  grantTrustedProject,
  clearTrustedDeclarations,
  rememberRecent,
  isProjectPath = value => typeof value === 'string' && PROJECT_FILE.test(value),
} = {}) {
  async function openTrusted(projectFile, { remember = true } = {}) {
    if (!isProjectPath(projectFile) || typeof readFile !== 'function' || typeof grantTrustedProject !== 'function') return null;
    let buffer;
    try { buffer = await readFile(projectFile); } catch (error) { return null; }
    if (!Buffer.isBuffer(buffer) || !grantTrustedProject(projectFile, buffer)) return null;
    if (remember && typeof rememberRecent === 'function') rememberRecent(projectFile);
    return { path: projectFile, b64: buffer.toString('base64') };
  }

  async function writeRendererProject(projectFile, buffer, {
    ensureParent = false,
    remember = false,
  } = {}) {
    if (!isProjectPath(projectFile)) return null;
    const saved = await commitAdmittedProjectWrite(projectFile, buffer, {
      ensureDirectory: ensureParent ? ensureDirectory : null,
      writeFile,
      clearTrustedDeclarations,
    });
    if (saved && remember && typeof rememberRecent === 'function') rememberRecent(saved);
    return saved;
  }

  return Object.freeze({ openTrusted, writeRendererProject });
}

module.exports = { createProjectFileGateway };
