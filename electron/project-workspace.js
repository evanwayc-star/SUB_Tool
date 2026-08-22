/* ==============================================================================
   SUB Tool — Electron 專案工作區管理器 (Project Workspace Manager)
   ==============================================================================
   【架構與職責】
   主行程專案檔案生命週期的唯一管理者：
   - 負責信任專案的准入（Trusted Intake）、開啟、儲存准入（Write Admission）。
   - 作業系統層開檔（OS Open File / Startup CLI）之非同步競態解決（Latest-Wins 世代記號）。
   - 最近開啟專案清單（Recent Projects）的持久化、排序與遺失探測。
   ============================================================================== */
'use strict';

const path = require('path');
const { PROJECT_FILE } = require('./file-authority');
const { createTrustedProjectIntake } = require('./trusted-project-intake');
const { commitAdmittedProjectWrite, inspectProjectWrite } = require('./project-write-admission');
const RecentProjects = require('./recent-projects');

/**
 * 建立專案工作區管理器實例。
 * 
 * @param {object} options
 * @param {Function} options.readFile 非同步讀取檔案函式
 * @param {Function} options.writeFile 非同步寫入檔案函式
 * @param {Function} options.ensureDirectory 確保目錄存在函式
 * @param {Function} options.grantProjectFile 授予專案檔能力函式
 * @param {Function} options.grantMediaFile 授予媒體讀取能力函式
 * @param {Function} options.canReadMedia 檢查媒體是否可讀函式
 * @param {Function} [options.readRecent] 讀取最近專案清單函式
 * @param {Function} [options.writeRecent] 寫入最近專案清單函式
 * @param {Function} [options.stat] 檔案狀態探測函式
 * @param {Function} [options.now] 取得時間戳函式
 * @param {Function} [options.isProjectPath] 專案路徑驗證函式
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

  /**
   * 安全讀取專案二進位資料。
   * @private
   */
  async function readProject(projectFile) {
    if (!isProjectPath(projectFile) || typeof readFile !== 'function') return null;
    try {
      const buffer = await readFile(projectFile);
      return Buffer.isBuffer(buffer) ? buffer : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * 提交開啟專案（授與能力並記錄至最近清單）。
   * @private
   */
  function commitOpen(projectFile, buffer, { rememberRecent = true } = {}) {
    if (!buffer || !intake.grant(projectFile, buffer)) return null;
    if (rememberRecent) remember(projectFile);
    return { path: projectFile, b64: buffer.toString('base64') };
  }

  /**
   * 開啟指定專案檔。
   * @param {string} projectFile 專案檔絕對路徑
   * @param {object} [options]
   * @returns {Promise<{path: string, b64: string}|null>}
   */
  async function open(projectFile, options) {
    const buffer = await readProject(projectFile);
    return commitOpen(projectFile, buffer, options);
  }

  /**
   * 以世代記號防範非同步競態的專案開啟（僅保留最後一次請求）。
   * @param {string} projectFile 專案檔路徑
   * @param {object} [options]
   * @returns {Promise<{path: string, b64: string}|null>}
   */
  async function openLatest(projectFile, options) {
    const generation = ++latestOpenGeneration;
    const buffer = await readProject(projectFile);
    if (generation !== latestOpenGeneration) return null;
    return commitOpen(projectFile, buffer, options);
  }

  /**
   * 暫存作業系統啟動或關聯開啟之專案路徑。
   */
  function stageStartup(projectFile) {
    if (!isProjectPath(projectFile)) return false;
    pendingStartupPath = projectFile;
    latestOpenGeneration += 1;
    return true;
  }

  /**
   * 執行啟動時待處理之專案開啟。
   */
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

  /**
   * 驗證並將渲染端傳來的專案 Base64 資料寫入檔案。
   * 
   * @param {string} projectFile 儲存目標路徑
   * @param {string} b64 專案 Base64 字串
   * @param {object} [options]
   * @returns {Promise<string|null>} 成功回傳檔案路徑，失敗回傳 null
   */
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

  /** 檢查專案內容是否符合儲存准入標準 */
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

  /** 列出最近專案並探測是否在磁碟上遺失 */
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

  /** 開啟最近專案清單中指定索引之項目（若已遺失則自動自清單移除） */
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

  /** 清空最近開啟專案紀錄 */
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
