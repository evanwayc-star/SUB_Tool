/* ==============================================================================
   SUB Tool — 專案儲存能力准入檢查 (Project Write Admission Guard)
   ==============================================================================
   【架構與職責】
   防禦來自渲染端的未授權媒體路徑注入：
   - 渲染端送來的專案二進位資料純為「未信任資料」，不可直接作為檔案能力的來源。
   - 只有當專案內所有宣告的本機媒體路徑均已是主行程 `FileAuthority` 許可的讀取路徑時，
     才允許儲存寫入。
   - 此檢查同時保護「另存新檔 (Save As)」與「自動存檔 (AutoSave)」，避免惡意路徑進入
     最近專案清單而被誤認為信任路徑。
   ============================================================================== */
'use strict';

const { collectProjectMediaPaths, parseProjectBuffer } = require('./file-authority');

/**
 * 檢查專案二進位 Buffer 是否具備合法的儲存准入資格。
 * 
 * @param {Buffer} buffer 專案二進位資料
 * @param {object} [options]
 * @param {Function} [options.canRead] 檢查路徑是否已具讀取權限之函式
 * @returns {{
 *   allowed: boolean,
 *   reason: string|null,
 *   mediaPaths: string[],
 *   unauthorizedPaths: string[]
 * }} 准入審查結果
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

/**
 * 完成專案寫入後的清理與狀態標記。
 */
function finalizeProjectWrite(projectFile, { clearTrustedDeclarations } = {}) {
  if (typeof projectFile !== 'string' || !projectFile) return null;
  if (typeof clearTrustedDeclarations === 'function') {
    clearTrustedDeclarations(projectFile);
  }
  return projectFile;
}

/**
 * 提交已通過准入審核的專案檔案寫入。
 * 
 * @param {string} projectFile 目標專案路徑
 * @param {Buffer} buffer 專案二進位 Buffer
 * @param {object} options
 * @param {Function} [options.ensureDirectory]
 * @param {Function} options.writeFile
 * @param {Function} [options.clearTrustedDeclarations]
 * @returns {Promise<string|null>}
 */
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

module.exports = {
  commitAdmittedProjectWrite,
  finalizeProjectWrite,
  inspectProjectWrite,
};
