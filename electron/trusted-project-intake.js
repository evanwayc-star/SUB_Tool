'use strict';

/*
  A project path becomes trusted only when the main process obtained it from an
  OS open event, the native picker, the persisted recent-project list, or a
  save operation.  The renderer receives the resulting bytes, but never gets
  an IPC that can turn arbitrary path/content pairs into file capabilities.
*/
const { collectProjectMediaPaths, parseProjectBuffer } = require('./file-authority');
const path = require('path');

function createTrustedProjectIntake({ readFile, grantProjectFile, grantMediaFile, pathModule = path, caseInsensitive } = {}) {
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
    } catch (error) { return null; }
  };

  function grantProjectOnly(projectFile) {
    if (typeof projectFile !== 'string' || !projectFile) return null;
    grantProject(projectFile);
    /* Save bytes came from the renderer.  Even if this path previously held a
       trusted project, its old declared-media set must not survive overwrite. */
    const projectKey = key(projectFile);
    if (projectKey) declaredMediaByProject.delete(projectKey);
    return projectFile;
  }

  function grant(projectFile, contents = null) {
    if (typeof projectFile !== 'string' || !projectFile) return null;
    let projectBuffer = Buffer.isBuffer(contents) ? contents : null;
    if (!projectBuffer) {
      try { projectBuffer = read(projectFile); } catch (error) { projectBuffer = null; }
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
    if (projectKey) declaredMediaByProject.set(projectKey, new Set(mediaPaths.map(key).filter(Boolean)));
    return projectBuffer;
  }

  function canRelink(projectFile, oldMediaPath) {
    const projectKey = key(projectFile);
    const mediaKey = key(oldMediaPath);
    return !!projectKey && !!mediaKey && declaredMediaByProject.get(projectKey)?.has(mediaKey) === true;
  }

  return Object.freeze({ grant, grantProjectOnly, canRelink });
}

module.exports = { createTrustedProjectIntake };
