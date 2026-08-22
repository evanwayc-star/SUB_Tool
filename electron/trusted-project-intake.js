/* ==============================================================================
   SUB Tool — 受信任專案載入與能力授與 (Trusted Project Intake Gateway)
   ==============================================================================
   【架構與職責】
   當專案檔路徑來自作業系統開啟事件、原生檔案選擇器、持久化之最近專案清單或
   主行程受控儲存時，將專案宣告的媒體路徑提升為信任媒體能力。
   ============================================================================== */
'use strict';

const { collectProjectMediaPaths, parseProjectBuffer } = require('./file-authority');
const path = require('path');

/**
 * 建立受信任專案載入管理實例。
 * 
 * @param {object} options
 * @param {Function} [options.readFile] 讀取檔案函式
 * @param {Function} options.grantProjectFile 授予專案檔能力函式
 * @param {Function} options.grantMediaFile 授予媒體檔能力函式
 * @param {object} [options.pathModule=path] 路徑模組
 * @param {boolean} [options.caseInsensitive] 是否忽略大小寫
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

  /**
   * 僅授予專案檔本身權限，並清除舊有宣告的媒體快取。
   */
  function grantProjectOnly(projectFile) {
    if (typeof projectFile !== 'string' || !projectFile) return null;
    grantProject(projectFile);
    const projectKey = key(projectFile);
    if (projectKey) declaredMediaByProject.delete(projectKey);
    return projectFile;
  }

  /**
   * 授權專案檔及其所宣告的媒體檔案。
   * 
   * @param {string} projectFile 專案檔絕對路徑
   * @param {Buffer|null} [contents=null] 專案二進位資料（若未提供則從硬碟讀取）
   * @returns {Buffer|null} 專案二進位 Buffer
   */
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

  /**
   * 檢查媒體是否為該專案先前合法宣告的素材（用於遺失檔案重新連結 Relink 驗證）。
   */
  function canRelink(projectFile, oldMediaPath) {
    const projectKey = key(projectFile);
    const mediaKey = key(oldMediaPath);
    return !!projectKey && !!mediaKey && declaredMediaByProject.get(projectKey)?.has(mediaKey) === true;
  }

  return Object.freeze({ grant, grantProjectOnly, canRelink });
}

module.exports = { createTrustedProjectIntake };
