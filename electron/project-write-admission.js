'use strict';

/*
  Renderer project bytes are data, never a capability source.  A write is
  admitted only when the bytes are a valid project and every declared local
  media path is already readable through the main-process FileAuthority.

  This check must guard both Save As and exact-path/autosave writes.  Otherwise
  renderer bytes can be persisted into the recent-project list and later
  re-opened as if those media paths had come from a trusted native intake.
*/
const { collectProjectMediaPaths, parseProjectBuffer } = require('./file-authority');

function inspectProjectWrite(buffer, { canRead } = {}) {
  const project = parseProjectBuffer(buffer);
  if (!project) {
    return Object.freeze({ allowed: false, reason: 'invalid-project', mediaPaths: [], unauthorizedPaths: [] });
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
  if (typeof clearTrustedDeclarations === 'function') clearTrustedDeclarations(projectFile);
  return projectFile;
}

async function commitAdmittedProjectWrite(projectFile, buffer, {
  ensureDirectory,
  writeFile,
  clearTrustedDeclarations,
} = {}) {
  if (typeof projectFile !== 'string' || !projectFile || !Buffer.isBuffer(buffer) || typeof writeFile !== 'function') return null;
  if (typeof ensureDirectory === 'function') await ensureDirectory(projectFile);
  await writeFile(projectFile, buffer);
  return finalizeProjectWrite(projectFile, { clearTrustedDeclarations });
}

module.exports = { commitAdmittedProjectWrite, finalizeProjectWrite, inspectProjectWrite };
