/* ==============================================================================
   SUB Tool — Module Architecture Protection ("electron/main.js")
   ==============================================================================
   【維護鐵律】本檔案已納入全專案終極防禦網。
   所有修改必須遵循專案的單向資料流與職責分離原則，嚴禁在此實作越權的 DOM 操作或狀態覆寫。
============================================================================== */
/* SUB Tool — Electron 主程序
   提供：原生檔案對話框、平台原生 ffmpeg/ffprobe（MXF 轉檔、多音軌抽取、波形）、
         專案/字幕直接讀寫磁碟。前端沿用同一份 index.html。 */
const { app, BrowserWindow, ipcMain, dialog, protocol, session } = require('electron');
const path = require('path');
const fs = require('fs');
/* RecentProjects 的 missing probe 會觸及 SMB 路徑，不可用同步 stat 阻塞
   Electron 主行程；快取與 fragmented-MP4 輪詢的非同步 I/O 在 media-intake-runtime。 */
const fsp = require('fs/promises');

const os = require('os');
const url = require('url');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const QueueStore = require('./queue-store');
const QueueHistory = require('./queue-history');
const { relayQueueRunnerEvent, runnerFailureProgress } = require('./queue-runner-adapter');
const { ExportQueueState } = require('./export-queue-state');
const ExportLease = require('./export-lease');
const ExportWatchdog = require('./export-watchdog');
const { FileAuthority } = require('./file-authority');
const { createLocalResourceServer, registerLocalResourceScheme } = require('./local-resource');
const { createProjectWorkspace } = require('./project-workspace');
const { sanitizeWindowBounds, decideWindowCloseAction } = require('./window-lifecycle-authority');

const { mergeRendererConfig } = require('./config-policy');
const { isPathContained } = require('./export-name-safety');
const { createIpcGuards, expectedExportExtension } = require('./ipc-guards');
const { JOB_STATUS, isLiveWork, isRetryable, reservesOutput } = require('./export-job-status');
const { createExportAdmission } = require('./export-admission');
const { createExportQueue } = require('./export-queue');
const { createMpvHost } = require('./mpv-host');
const { createMediaIngestCoordinator } = require('./media-ingest-coordinator');
const { createFFmpegExecution } = require('./ffmpeg-execution');
const { createMediaIntakeRuntime } = require('./media-intake-runtime');
const { createMediaProbe } = require('./media-probe');
const {
  createSpeechAudioCompressor,
  createSpeechCompressionRuntime
} = require('./speech-audio-compressor');
const { authorizeDroppedMediaPath } = require('./dropped-file-admission');
/* 交付解析度／建議碼率的規則與 renderer 共用同一份（見 shared/README.md）——
   匯出佇列監控可以改已入列工作的解析度，那必須與交付對話框算出同樣的結果。 */
const { deliveryResolution, suggestKbps } = require('../shared/delivery-resolution.cjs');
const {
  deliveryVideoEncoderArgs,
  detectNativeTool,
  mpvEmbeddingSupported,
  previewVideoEncoderArgs,
  videoEncoderCandidates,
} = require('./native-tooling');
const { buildIngestArgs } = require('./ffmpeg-pipeline-builder');

// 自訂 scheme 的 privileges 必須在 app ready 前註冊；實際 handler 於 ready 後安裝。
registerLocalResourceScheme(protocol);

let mainWin = null;
let _allowMainWindowClose = false;
let _allowQueueWindowClose = false;
let _isAppQuitting = false;
let _mainHiddenForQueue = false;
let _quitReady = false;
let _quitSequenceStarted = false;
let FFMPEG = null, FFPROBE = null, VENC = null, CACHE = null;
let FFMPEG_DETECTION = null, FFPROBE_DETECTION = null;
let mediaProbe = null;
let projectOpenReady = false;
const TMP = path.join(os.tmpdir(), 'subtool_cache');
const tempFiles = new Set();
let tmpSeq = 0;
/* proxy、聲道與波形都共用 per-source cache；streamIngest 回傳「可播放」後仍持有
   writer lease，直到 ffmpeg 完整結束才讓下一個 queued ingest 寫入。 */
const mediaIngestCoordinator = createMediaIngestCoordinator();

/* S1：唯一的 IPC 檔案能力權威。
   renderer 路徑不會因 fs:fileURL／stat 等查詢被靜默升格；只接受原生對話框、OS 開檔、
   preload 驗證過的拖放 File 與內部快取。專案內已宣告的媒體則只給「那一個檔案」的唯讀能力。 */
const fileAuthority = new FileAuthority({ internalDirectories: [TMP] });
const localResourceServer = createLocalResourceServer({
  fileAuthority,
  protocolModule: protocol,
  sessionModule: session,
});
const projectWorkspace = createProjectWorkspace({
  readFile: projectFile => fs.promises.readFile(projectFile),
  writeFile: (projectFile, contents) => fs.promises.writeFile(projectFile, contents),
  ensureDirectory: projectFile => fs.promises.mkdir(path.dirname(projectFile), { recursive: true }),
  grantProjectFile: projectFile => fileAuthority.grantProjectFile(projectFile),
  grantMediaFile: mediaPath => fileAuthority.grantTrustedFile(mediaPath, { read: true, write: false }),
  canReadMedia: mediaPath => fileAuthority.canRead(mediaPath),
  readRecent: () => loadRecentProjects(),
  writeRecent: list => saveRecentProjects(list),
  stat: projectFile => fsp.stat(projectFile),
});

/* 三個守衛與 expectedExportExtension 的實作在 ipc-guards.js（可獨立測試，
   不需要整個 Electron 主行程）；這裡只建立跟 fileAuthority 綁定的實例。 */
const { requireReadablePath, requirePermittedShellOpenPath, requirePermittedDeliveryRevealPath, requirePermittedSourceRevealPath } = createIpcGuards(fileAuthority);
/* S5：不可猜測的交付 job id；串流 id 由 media-intake-runtime 自行持有。 */
function newJobId(prefix) { return prefix + crypto.randomBytes(12).toString('hex'); }

function ensureTmp() { try { fs.mkdirSync(TMP, { recursive: true }); } catch (e) {} }
function tmpPath(ext) { ensureTmp(); const p = path.join(TMP, `t${Date.now()}_${tmpSeq++}.${ext}`); tempFiles.add(p); return p; }
/* WebContents 可能在視窗關閉後仍被呼叫（例如 mpv pipe close 回呼），必須先確認未銷毀 */
function safeSend(wc, ch, ...args) {
  try { if (wc && !wc.isDestroyed()) wc.send(ch, ...args); } catch (e) {}
}
function safeWinSend(win, ch, ...args) {
  try { if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) win.webContents.send(ch, ...args); } catch (e) {}
}

/* ---- 偵測平台可用的硬體視訊編碼器（VideoToolbox／NVENC／QSV／AMF），否則退回 libx264 ---- */
function detectVideoEncoder() {
  if (!FFMPEG) return 'libx264';
  const test = (name) => {
    try {
      const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=5:duration=0.2',
        '-c:v', name, '-f', 'null', '-'], { timeout: 8000 });
      return r.status === 0;
    } catch (e) { return false; }
  };
  for (const enc of videoEncoderCandidates(process.platform)) { if (test(enc)) return enc; }
  return 'libx264';
}
/* 依選定編碼器回傳「轉檔預覽影片」用的視訊參數（品質導向、yuv420p 由呼叫端的 -vf 負責） */

/* 鐵律 §0.8 的守門員。規則本身在 export-admission.js（可測），這裡只是轉呼叫，
   保留原名讓既有呼叫端不動。_admission 在下方建立；本函式的呼叫點都在那之後。 */
function assertMasterExportMedia(file, kind) {
  return _admission.assertMasterMedia(file, kind);
}

/* S2: 有 GPU 編碼器時啟用來源端硬體解碼（加速讀取 4K/MXF），對 -i 前插入 */
function hwdecArgs() { return VENC && VENC !== 'libx264' ? ['-hwaccel', 'auto'] : []; }

/* ---- 視窗 ---- */
function createWindow() {
  if (mainWin && !mainWin.isDestroyed()) return mainWin;
  const win = new BrowserWindow({
    width: 1480, height: 920, minWidth: 1024, minHeight: 640,
    backgroundColor: '#1b1b1d',
    title: `SUB TOOL v${app.getVersion()}`,
    icon: path.join(__dirname, 'logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      webSecurity: true
    }
  });
  mainWin = win;
  win.webContents.on('did-start-loading', () => { projectOpenReady = false; });
  win.setMenu(null);
  win.setAutoHideMenuBar(false);
  win.setMenuBarVisibility(false);

  win.maximize();
  // 讓嵌入式 mpv 覆蓋視窗跟著主視窗移動 / 縮放 / 最小化
  const reapplyMpv = () => { mpvHost.reapplyBounds(); };
  win.on('move', reapplyMpv);
  win.on('resize', reapplyMpv);
  win.on('restore', () => { mpvHost.showForParentRestore(); });
  win.on('close', (e) => {
    if (!_allowMainWindowClose && !_isAppQuitting && !win.webContents.isDestroyed()) {
      e.preventDefault();
      safeWinSend(win, 'app:request-close');
    }
  });
  win.on('closed', () => {
    if (mainWin === win) {
      mainWin = null;
      _mainHiddenForQueue = false;
    }
    mpvHost.dispose();
  });
  // S2：補齊 Electron 安全基線 — 開新外部視窗委派給預設瀏覽器、限制導航只能停在本機應用頁（與 dev 的 localhost）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      const { shell } = require('electron');
      shell.openExternal(url).catch(err => console.warn('[app] openExternal failed:', err));
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (ev, u) => {
    if (!(u.startsWith('file:') || u.startsWith('http://localhost:8777'))) ev.preventDefault();
  });
  win.webContents.once('did-finish-load', () => {
    try { QueueManager.refreshViews(); } catch (e) {}
  });
  if (process.argv.includes('--dev')) {
    win.loadURL('http://localhost:8777'); // 需先執行 npm run dev
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    const built = path.join(__dirname, '..', 'dist', 'index.html');
    void localResourceServer.loadApplicationDocument(win, built).catch(error => {
      console.error('[app] 無法載入 application document：', error);
    });
  }
  return win;
}

function showMainWindow() {
  if (_isAppQuitting) return false;
  const win = mainWin && !mainWin.isDestroyed() ? mainWin : createWindow();
  if (!win) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  _mainHiddenForQueue = false;
  mpvHost.showForParentRestore();
  return true;
}

function hideMainWindow() {
  if (!mainWin || mainWin.isDestroyed()) return false;
  mpvHost.hideForParent();
  mainWin.hide();
  _mainHiddenForQueue = true;
  return true;
}

ipcMain.handle('app:close', () => {
  if (!mainWin || mainWin.isDestroyed()) return false;
  // 監控視窗還在時保留 renderer 與未儲存專案，只隱藏主視窗；監控視窗可再叫回來。
  if (queueWin && !queueWin.isDestroyed()) return hideMainWindow();
  /* 還有工作正在轉檔時不結束程式：關閉主視窗會一路走到 app.quit() →
     before-quit → prepareForShutdown()，把執行中的 ffmpeg 全部停掉並清掉半成品。
     使用者按的是「關閉編輯視窗」，不是「放棄這幾個小時的轉檔」。
     改成把監控視窗叫出來、主視窗收起來，轉檔繼續跑，程式也還活著。 */
  if (QueueManager.liveWorkCount() > 0) {
    openQueueWindow();
    return hideMainWindow();
  }
  _allowMainWindowClose = true;
  try { mainWin.close(); } finally { _allowMainWindowClose = false; }
  return true;
});

ipcMain.handle('app:showMainWindow', () => showMainWindow());

async function deliverExternalProjectOpen(projectPath) {
  if (!projectOpenReady || !mainWin || mainWin.isDestroyed()) {
    projectWorkspace.stageStartup(projectPath);
    return;
  }
  const opened = await projectWorkspace.openLatest(projectPath);
  if (!opened) return;
  if (!projectOpenReady || !mainWin || mainWin.isDestroyed()) {
    projectWorkspace.stageStartup(projectPath);
    return;
  }
  safeWinSend(mainWin, 'app:open-file', opened);
}

app.on('open-file', (e, projectPath) => {
  e.preventDefault();
  void deliverExternalProjectOpen(projectPath);
});

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', async (event, commandLine, workingDirectory) => {
    const fileArg = commandLine.find(a => !a.startsWith('-') && (a.endsWith('.subtool') || a.endsWith('.json')));
    if (fileArg) await deliverExternalProjectOpen(fileArg);
    if (app.isReady()) showMainWindow();
  });

  app.whenReady().then(async () => {
    localResourceServer.install();
    FFMPEG_DETECTION = detectNativeTool('ffmpeg', {
      moduleDir: __dirname,
      resourcesPath: process.resourcesPath,
      homeDir: os.homedir(),
    });
    FFPROBE_DETECTION = detectNativeTool('ffprobe', {
      moduleDir: __dirname,
      resourcesPath: process.resourcesPath,
      homeDir: os.homedir(),
    });
    FFMPEG = FFMPEG_DETECTION.path;
    FFPROBE = FFPROBE_DETECTION.path;
    mediaProbe = createMediaProbe({ executable: FFPROBE });
    VENC = detectVideoEncoder();
    CACHE = path.join(app.getPath('userData'), 'mediacache');
    fileAuthority.grantInternalDirectory(CACHE);
    EXPORT_QUEUE_DIR = path.join(app.getPath('userData'), 'export-queue');
    fileAuthority.grantQueueLogDirectory(EXPORT_QUEUE_DIR);
    try { fs.mkdirSync(CACHE, { recursive: true }); } catch (e) {}
    try { mediaIntakeRuntime.cleanOrphans(); } catch (e) {} // 啟動時自動清除無效快取（例如上次轉檔中斷的孤兒資料夾）
    try {
      const recovery = await ExportWatchdog.recoverExportLeases(EXPORT_QUEUE_DIR);
      for (const warning of recovery.warnings || []) {
        console.error(`[Export watchdog] ${warning.message || JSON.stringify(warning)}`);
      }
    } catch (e) {
      // 無法確認舊工作身份時 export lease 會保留並 fail closed；不可憑 owner 內的舊 PID 直接 taskkill。
      console.error('[Export watchdog] 無法復原上次中斷的匯出：', e);
    }
    try { QueueManager.restoreJobs(); } catch (e) { console.error('[Queue] 無法恢復匯出佇列：', e); }
    createWindow();
    app.on('activate', () => { showMainWindow(); });
  });
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', (event) => {
  if (_quitReady) return;
  event.preventDefault();
  if (_quitSequenceStarted) return;
  _quitSequenceStarted = true;
  _isAppQuitting = true;
  Promise.resolve()
    .then(() => speechCompressionRuntime.cancelAllAndWait())
    .then(() => QueueManager.prepareForShutdown())
    .then(() => {
      _quitReady = true;
      app.quit();
    })
    .catch(e => {
      /* outcome journal 尚未 durable 時不能「照樣退出」：那會遺失唯一知道 ffmpeg
         已結束的 intent，重啟後把舊 running snapshot 當 queued 重新以 -y 執行。 */
      console.error('[Queue] 無法安全保存關閉前狀態，已取消退出：', e);
      _quitSequenceStarted = false;
      _isAppQuitting = false;
      const options = {
        type: 'error',
        title: '尚未能安全關閉',
        message: '匯出終態或中斷工作的恢復快照尚未保存，已取消關閉。',
        detail: '請確認儲存空間或防毒軟體鎖定狀態後，再次嘗試關閉。',
      };
      const owner = mainWin && !mainWin.isDestroyed() ? mainWin : null;
      const show = owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options);
      Promise.resolve(show).catch(() => {});
    });
});
app.on('quit', () => {
  mpvHost.dispose();
  void mediaIntakeRuntime.close();
  for (const f of tempFiles) { try { fs.unlinkSync(f); } catch (e) {} }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});

/* ============ IPC ============ */
ipcMain.handle('app:getStartupFile', async () => {
  const args = (process.platform === 'win32' || process.platform === 'linux')
    ? process.argv.slice(app.isPackaged ? 1 : 2)
    : [];
  const opened = await projectWorkspace.openStartup(args);
  projectOpenReady = true;
  return opened;
});
ipcMain.handle('app:openPath', async (e, p) => {
  const { shell } = require('electron');
  requirePermittedShellOpenPath(p);
  return shell.openPath(p);
});
ipcMain.handle('app:openExternal', async (e, url) => {
  if (typeof url !== 'string' || !(url.startsWith('https://') || url.startsWith('http://'))) {
    throw new TypeError('url must be http or https');
  }
  const { shell } = require('electron');
  return shell.openExternal(url);
});
ipcMain.handle('app:showItemInFolder', async (e, p) => {
  const { shell } = require('electron');
  requirePermittedDeliveryRevealPath(p);
  shell.showItemInFolder(p);
  return true;
});
ipcMain.handle('app:showSourceInFolder', async (e, p) => {
  const { shell } = require('electron');
  requirePermittedSourceRevealPath(p);
  shell.showItemInFolder(p);
  return true;
});
ipcMain.handle('ffmpeg:stopExport', (event, requestedJobId) => {
  if (typeof requestedJobId === 'string') {
    return QueueManager.activeJob(requestedJobId) ? QueueManager.stopJob(requestedJobId) : false;
  }
  const activeJobIds = QueueManager.activeJobIds();
  const latestJobId = activeJobIds[activeJobIds.length - 1];
  return latestJobId ? QueueManager.stopJob(latestJobId) : false;
});
ipcMain.handle('app:status', () => ({
  isDesktop: true, ffmpeg: !!FFMPEG, ffprobe: !!FFPROBE,
  ffmpegPath: FFMPEG, ffprobePath: FFPROBE, venc: VENC,
  platform: process.platform, arch: process.arch,
  ffmpegDetection: FFMPEG_DETECTION, ffprobeDetection: FFPROBE_DETECTION,
}));

ipcMain.handle('fs:fileURL', (e, p) => {
  const resourceURL = localResourceServer.urlFor(p);
  if (!resourceURL) console.warn('[sec] fileURL blocked:', p);
  return resourceURL;
});
ipcMain.handle('fs:stat', (e, p) => {
  if (!fileAuthority.canStat(p)) { console.warn('[sec] stat blocked:', p); return { exists: false }; }
  try { const s = fs.statSync(p); return { exists: true, size: s.size }; } catch (err) { return { exists: false }; }
});
ipcMain.handle('fs:listDir', (e, p) => {
  if (!fileAuthority.canListDirectory(p)) { console.warn('[sec] listDir blocked:', p); return []; }
  try { return fs.readdirSync(p); } catch (err) { return []; }
});

async function findFileRecursively(dir, targetName, maxDepth = 3) {
  if (maxDepth < 0) return null;
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === targetName) {
        return path.join(dir, entry.name);
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const found = await findFileRecursively(path.join(dir, entry.name), targetName, maxDepth - 1);
        if (found) return found;
      }
    }
  } catch(e) {}
  return null;
}

ipcMain.handle('fs:findRelinkTarget', async (e, { projectPath, oldMediaPath }) => {
  if (!projectPath || !oldMediaPath) return null;
  if (!fileAuthority.canRead(projectPath)) return null;
  /* The basename must come from this exact project's main-read bytes.  A
     renderer-supplied arbitrary name is never authority to search/grant a
     sibling file. */
  if (!projectWorkspace.canRelink(projectPath, oldMediaPath)) return null;
  
  const targetName = path.basename(oldMediaPath);
  const startDir = path.dirname(projectPath);
  
  const newPath = await findFileRecursively(startDir, targetName, 3);
  if (newPath) {
    fileAuthority.grantTrustedFile(newPath, { read: true, write: false });
    return newPath;
  }
  return null;
});
// preload 只會從真實的拖放／選檔 File 物件取得 p；不可提供接收任意字串的授權 IPC。
ipcMain.handle('fs:authorizeDroppedFile', (e, p) => {
  return authorizeDroppedMediaPath(p, {
    grantRead: file => fileAuthority.grantTrustedFile(file, { read: true, write: false }),
    grantScreenshotDirectory: directory => fileAuthority.grantScreenshotDirectory(directory),
  });
});
ipcMain.handle('fs:reserveScreenshotPath', (e, { directory, suffix } = {}) => {
  if (!fileAuthority.canUseScreenshotDirectory(directory)) {
    console.warn('[sec] reserve screenshot blocked (unauthorized directory):', directory);
    return null;
  }
  let maxNum = 0;
  try {
    for (const file of fs.readdirSync(directory)) {
      const hit = /^Shot-(\d{3})/i.exec(file);
      if (hit) maxNum = Math.max(maxNum, Number(hit[1]) || 0);
    }
  } catch (error) { return null; }
  const safeSuffix = typeof suffix === 'string' ? suffix.replace(/[^0-9A-Za-z_-]/g, '') : '';
  const name = `Shot-${String(maxNum + 1).padStart(3, '0')}${safeSuffix}.jpg`;
  const target = path.join(directory, name);
  return fileAuthority.canWriteScreenshot(target) ? { path: target, name } : null;
});





/* 上一次在各種對話框裡實際挑到檔案的資料夾。

   ── 為什麼要自己記，而不是交給 Windows ──
   沒有給 defaultPath 時，Windows 會從自己的 MRU（ComDlg32\OpenSavePidlMRU）
   還原上次的位置，而那是【PIDL 解析】——會走 shell namespace，對網路位置要做
   名稱解析。這台機器的 DNS 只有公用伺服器（168.95.1.1／8.8.8.8／1.1.1.1），
   解析不到 \\Storage、\\Avjet-Server 這種內網主機名，只能退回 LLMNR／NetBIOS
   廣播——實測 Avjet-Server 冷解析要 7.3 秒、Storage 2.7 秒，而 MRU 裡有幾十筆
   指向這兩台。

   直接給一個【字串路徑】當 defaultPath 就不必走那條路。
   行為對使用者是一樣的（還是回到上次的資料夾），但由我們自己記。

   實測背景：開啟影音的對話框花了 42.6／43.3 秒，而同一次啟動裡「開啟專案」
   （本機路徑）不到 3 秒；期間主行程事件迴圈只被擋住 32ms，我們這一側到呼叫
   showOpenDialog 為止 <5ms——也就是那 43 秒完全在原生對話框裡面。 */
let _lastDirs = null;
function lastDir(kind) {
  if (!_lastDirs) {
    try {
      const p = getConfigPath();
      _lastDirs = (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')).lastDirs : null) || {};
    } catch (e) { _lastDirs = {}; }
  }
  const d = _lastDirs[kind];
  /* 存在才用：資料夾被刪掉或磁碟沒接時給了不存在的 defaultPath，
     對話框的行為會變得難以預期。 */
  try { return d && fs.statSync(d).isDirectory() ? d : undefined; } catch (e) { return undefined; }
}
function rememberDir(kind, filePath) {
  if (typeof filePath !== 'string' || !filePath) return;
  try {
    const dir = path.dirname(filePath);
    if (!_lastDirs) lastDir(kind);
    if (_lastDirs[kind] === dir) return;
    _lastDirs[kind] = dir;
    const p = getConfigPath();
    const current = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
    fs.writeFileSync(p, JSON.stringify({ ...current, lastDirs: _lastDirs }, null, 2), 'utf8');
  } catch (e) {}
}


ipcMain.handle('dialog:openMedia', async () => {
  const r = await dialog.showOpenDialog({
    title: '匯入影片或音訊檔', properties: ['openFile', 'multiSelections'],
    defaultPath: lastDir('media'),   // 見 lastDir 的註解：繞開 shell 的 MRU／PIDL 解析
    filters: [
      { name: '影音或圖片', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'mxf', 'avi', 'm2ts', 'mts', 'ts', 'wmv', 'webm', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'aif', 'aiff', 'jpg', 'jpeg', 'png'] },
      { name: '全部', extensions: ['*'] }
    ]
  });
  if (r.canceled) return null;
  rememberDir('media', r.filePaths[0]);
  r.filePaths.forEach(p => {
    fileAuthority.grantTrustedFile(p, { read: true, write: false });
    fileAuthority.grantScreenshotDirectory(path.dirname(p));
  });
  // 保持單選時的舊字串回傳值，讓專案遺失主影片的既有重選流程可無修改地繼續使用。
  return r.filePaths.length===1 ? r.filePaths[0] : r.filePaths;
});
ipcMain.handle('dialog:openAudio', async () => {
  const r = await dialog.showOpenDialog({
    title: '加入音軌檔', properties: ['openFile', 'multiSelections'],
    filters: [{ name: '音訊', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg'] }]
  });
  if (r.canceled) return [];
  r.filePaths.forEach(p => {
    fileAuthority.grantTrustedFile(p, { read: true, write: false });
    fileAuthority.grantScreenshotDirectory(path.dirname(p));
  });
  return r.filePaths;
});

/* ── 最近開啟的專案 ────────────────────────────────────────────────────────
   清單由【主程序】持有並持久化，renderer 只拿得到「顯示用的字串」與索引。

   為什麼不讓 renderer 存路徑再送回來開：那等於給了它一條
   「叫主程序讀任意檔案」的路。fileAuthority 的授權是【每次工作階段】的，
   重開程式後舊路徑本來就不再被授權——正確的作法是主程序自己記得使用者
   確實開過哪些檔，並且只在從這份清單開啟時才重新授予那一個檔案。 */
function loadRecentProjects() {
  try {
    const p = getConfigPath();
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf8'))?.recentProjects || [];
  } catch (e) { return []; }
}

function saveRecentProjects(list) {
  try {
    const p = getConfigPath();
    const current = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
    fs.writeFileSync(p, JSON.stringify({ ...current, recentProjects: list }, null, 2), 'utf8');
  } catch (e) { console.error('[recent] save err', e); }
}

/* 清單本身不含能力授予——只是給選單顯示用。
   `missing` 讓選單可以把已經不在的檔案標灰，而不是讓使用者點了才失敗。 */
ipcMain.handle('project:recentList', () => projectWorkspace.listRecent());

/* renderer 只送【索引】，路徑由主程序自己的清單決定——沒有路徑注入空間。
   讀取前才授予那一個檔案的能力（fileAuthority 是每次工作階段的）。 */
ipcMain.handle('project:openRecent', (e, index) => projectWorkspace.openRecent(index));

ipcMain.handle('project:clearRecent', () => projectWorkspace.clearRecent());

ipcMain.handle('dialog:openProject', async () => {
  const r = await dialog.showOpenDialog({
    title: '開啟專案', properties: ['openFile'],
    defaultPath: lastDir('project'),
    filters: [{ name: 'SUB Tool 專案', extensions: ['subtool', 'json'] }]
  });
  if (r.canceled) return null;
  rememberDir('project', r.filePaths[0]);
  return projectWorkspace.open(r.filePaths[0]);
});
ipcMain.handle('dialog:saveProject', async (e, { name, b64 }) => {
  if (!projectWorkspace.acceptsRendererProject(b64)) return null;
  const r = await dialog.showSaveDialog(mainWin, { title: '儲存專案', defaultPath: name, filters: [{ name: 'SUB Tool 專案', extensions: ['subtool'] }] });
  if (r.canceled) return null;
  /* 儲存時的 JSON 來自 renderer；只授權使用者剛在原生對話框選定的專案檔，
     不可據此替其中任意宣告的 media path 升權。重新從原生開啟該專案時，才會走
     projectWorkspace 解析已取得的檔案內容。 */
  try { return await projectWorkspace.writeRendererProject(r.filePath, b64, { remember: true }); }
  catch (error) { return null; }
});

ipcMain.handle('dialog:importSub', async (e, kind) => {
  const filt = { srt: ['srt'], ass: ['ass', 'ssa'], encore: ['txt'], txt: ['txt'] }[kind] || ['*'];
  const r = await dialog.showOpenDialog({ title: '匯入字幕', properties: ['openFile'], filters: [{ name: kind.toUpperCase(), extensions: filt }, { name: '全部', extensions: ['*'] }] });
  if (r.canceled) return null;
  const buf = fs.readFileSync(r.filePaths[0]);
  return { path: r.filePaths[0], b64: buf.toString('base64') };
});
ipcMain.handle('dialog:exportSub', async (e, { name, b64, ext }) => {
  const r = await dialog.showSaveDialog({ title: '匯出字幕', defaultPath: name, filters: [{ name: (ext || 'txt').toUpperCase(), extensions: [ext || 'txt'] }] });
  if (r.canceled) return null;
  fs.writeFileSync(r.filePath, Buffer.from(b64, 'base64'));
  return r.filePath;
});
ipcMain.handle('dialog:importFont', async () => {
  const r = await dialog.showOpenDialog({ title: '匯入字型', properties: ['openFile'], filters: [{ name: '字型檔', extensions: ['ttf', 'otf', 'woff', 'woff2', 'ttc'] }, { name: '全部', extensions: ['*'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  const src = r.filePaths[0];
  const root = userFontsDir();
  try {
    const name = path.basename(src);
    const dest = path.join(root, name);
    fs.copyFileSync(src, dest);
    return name.replace(/\.(ttf|otf|ttc|woff2?)$/i, '');
  } catch (e) {
    console.error('[fonts] import error', e);
    return null;
  }
});

/* ---- 匯出影片序列（ProRes 422 HQ / MP4 H.264；燒錄可見軌字幕；各段原音混入其時段） ----
   items：依時間軸順序的陣列，clip={type:'clip',path,in,out} 或 gap={type:'gap',dur}。
   單一 filtergraph：各段 trim→fps→scale/pad 到 WxH，間隙用 color/anullsrc 生成，concat 串接，
   最後以 ass 濾鏡燒字幕（用 cwd 讓字幕檔以 basename 引用，避開 Windows 路徑跳脫地獄）。 */
// ProRes 母帶的音訊也必須保留交付品質。24-bit PCM 不經 AAC cache／有損重編，
// 並與多聲道 WAV 匯出的 pcm_s24le 保持一致。
function proresArgs() { return ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le', '-c:a', 'pcm_s24le']; }
/* 匯出用的 H.264 參數：以「目標位元率」編碼（vencArgs() 是畫質模式 CQ/CRF，供轉檔 proxy 用，不可混用）。
   各編碼器的速率控制旗標不同；maxrate=目標、bufsize=2×目標 → 近似封頂 VBR，位元率穩定可預測。 */
function vencArgsBitrate(kbps) {
  return deliveryVideoEncoderArgs(VENC, kbps);
}
/* 匯出的純決策邏輯已抽到 ./export-plan.js（零 require、可在 vitest 直接測）。
   留在這裡的是需要副作用的部分：找字型要讀檔。 */
const {
  imageBoxForExport,
  buildDeliveryArgv,
  _finiteNumber,
  _filterNumber,
  _exportPlanError,
  _normalizeAudioPlan,
  _planDuration,
  _buildPlannedAudio,
  _buildWavOutput,
  aacBitrateForChannels,
  _normaliseExportTimecodeWatermark,
  _buildExportTimecodeFilter,
} = require('./export-plan');

/* 交付用 TC 必須固定使用專案隨附的更紗黑體等寬版本。
   不能再掃到 font/ 裡第一個字型：目錄順序會讓匯出回退至比例數字，
   導致例如 1 與 8 的寬度不同，時間碼在每格更新時左右跳動。 */
function _findExportTimecodeFont() {
  const root = fontsRoot();
  const font = root && path.join(root, '更紗黑體', 'sarasa-mono-tc-nerd-regular.ttf');
  try { return font && fs.existsSync(font) ? font : null; } catch (e) { return null; }
}

/* ===== 背景匯出佇列與 QueueManager ===== */
let EXPORT_QUEUE_DIR = null;
let queueWin = null;
let compareWin = null;
let QueueManager = null;
/* 分類的唯一來源在 export-job-status.js */
const OUTPUT_RESERVED_STATUSES = { has: reservesOutput };

function ensureExportQueueDir() {
  if (!EXPORT_QUEUE_DIR) throw new Error('匯出佇列目錄尚未初始化');
  QueueStore.ensureDir(EXPORT_QUEUE_DIR);
}

/* 交付與可重建快取共用同一個 execution outcome；module 內部保留兩個真實 adapters：
   交付由獨立 watchdog 持有，可重建的 proxy／ingest 則由 Electron main 直接持有。 */
const ffmpegExecution = createFFmpegExecution({
  getFFmpegPath: () => FFMPEG,
  getUserDataDir: () => app.getPath('userData'),
  getQueueDir: () => EXPORT_QUEUE_DIR,
  ensureQueueDir: ensureExportQueueDir,
  moduleDir: __dirname,
  isPackaged: () => app.isPackaged,
  getResourcesPath: () => process.resourcesPath,
  send: safeSend,
  onLogError: (logPath, error) => {
    console.error(`[Queue] 無法寫入 ffmpeg 記錄 ${logPath}：`, error);
  },
});
const runFF = (args, options) => ffmpegExecution.execute(args, options);

/* cache identity / metadata / fragmented-MP4 HTTP registry / ingest commit 由同一個
   runtime 持有；main 只保留 Electron IPC、FileAuthority 與原生工具的組裝點。 */
const mediaIntakeRuntime = createMediaIntakeRuntime({
  cacheRoot: () => CACHE,
  tempRoot: TMP,
  fileAuthority,
  ffmpegExecution,
  getEncoder: () => VENC,
  sendProgress: (target, payload) => safeSend(target, 'task-progress', payload),
  forgetTemporaryFile: file => tempFiles.delete(file),
  log: (message, ...args) => {
    if (String(message).startsWith('[HTTP]')) console.error(message, ...args);
    else console.warn(message, ...args);
  },
});
const speechAudioCompressor = createSpeechAudioCompressor({
  createTempPath: tmpPath,
  writeFile: (file, bytes) => fs.promises.writeFile(file, bytes),
  readFile: file => fs.promises.readFile(file),
  removeFile: async file => {
    try {
      await fs.promises.unlink(file);
      tempFiles.delete(file);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        tempFiles.delete(file);
        return;
      }
      // 保留在 tempFiles，讓 app 關閉時再嘗試清除，避免刪除失敗後失去追蹤。
      throw error;
    }
  },
  execute: (args, options) => runFF(args, options)
});
const speechCompressionRuntime = createSpeechCompressionRuntime({ compressor: speechAudioCompressor });

/* 准入政策（能不能進佇列、需要哪些檔案能力）住在 export-admission.js——
   那四條規則原本散在這裡，與 BrowserWindow／dialog／spawn 糾纏，因此一行測試都沒有，
   而其中一條正是鐵律 §0.8 的守門員（不可拿 proxy.mp4／chNN.m4a 匯出）。
   外部能力全部由這裡注入，本檔只留「接線」。 */
const _admission = createExportAdmission({
  expectedExtensionFor: expectedExportExtension,
  outputKeyFor: outPath => ExportLease.outputKey(outPath),
  mergeSourcePaths: (payload, sourcePaths) => QueueStore.mergeSourcePaths(payload, sourcePaths),
  currentJobs: () => QueueManager ? QueueManager.jobs() : [],
  reservesOutput: status => OUTPUT_RESERVED_STATUSES.has(status),
  canReadSource: file => fileAuthority.canRead(file),
  canWriteDelivery: file => fileAuthority.canWriteDelivery(file),
  isPreviewCacheMedia: file => mediaIntakeRuntime.isPreviewCacheMedia(file),
});

/* 以下維持原本的名字，呼叫端不動——它們現在只是轉呼叫。 */
const queueOutputKey = job => _admission.outputKey(job);
const assertQueueOutputFormat = job => _admission.assertOutputFormat(job);
/* 匯出 payload 是 renderer 的資料快照，不能因為進了佇列就自動升格成檔案能力。
   sourcePaths 在 enqueue 時凍結，重啟時則只從 app 自己持久化的 job snapshot 重新授予
   精確檔案能力；任何後來摻入 payload 的路徑都仍會被這裡拒絕。 */
const queueSourcePaths = job => _admission.sourcePathsOf(job);

function grantPersistedQueueJobCapabilities(job) {
  const sourcePaths = queueSourcePaths(job);
  for (const sourcePath of sourcePaths) {
    try {
      if (!fs.statSync(sourcePath).isFile()) continue;
      assertMasterExportMedia(sourcePath, '恢復匯出來源');
      fileAuthority.grantTrustedFile(sourcePath, { read: true, write: false });
    } catch (error) {}
  }
  try {
    assertQueueOutputFormat(job);
    fileAuthority.grantDeliveryFile(job.payload.outPath);
  } catch (error) {}
}

function openQueueWindow() {
  if (queueWin && !queueWin.isDestroyed()) {
    if (queueWin.isMinimized()) queueWin.restore();
    queueWin.show();
    queueWin.focus();
    return;
  }
  queueWin = new BrowserWindow({
    width: 1240,
    height: 760,
    minWidth: 960,
    minHeight: 600,
    title: '匯出佇列監控',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'queue-preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  /* 主視窗有 setMenu(null)，這裡先前沒有——於是佇列視窗留著 Electron 的
     預設應用選單（autoHideMenuBar 只是把它藏起來，加速鍵仍然是活的）。
     兩個視窗對鍵盤的行為不一致本身就是意外的來源，補齊。 */
  queueWin.setMenu(null);
  const queueDocument = path.join(__dirname, 'queue.html');
  localResourceServer.allowInternalDocument(queueDocument);
  queueWin.loadFile(queueDocument);
  /* 關掉監控視窗如果會順帶結束整個程式，而且還有工作在轉檔，就先問過使用者。
     這裡不能只看「有沒有在轉檔」——主視窗還開著時，關監控視窗只是收起監控畫面，
     轉檔照跑，這種情況跳確認視窗只會擾民。 */
  queueWin.on('close', (e) => {
    if (_isAppQuitting || _allowQueueWindowClose) return;
    if (!queueWindowCloseEndsApp()) return;
    const liveCount = QueueManager.liveWorkCount();
    if (liveCount === 0) return;
    e.preventDefault();
    const win = queueWin;
    dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['繼續轉檔', '中斷並關閉'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: '仍有匯出工作進行中',
      message: `還有 ${liveCount} 個匯出工作正在轉檔`,
      detail: '這是最後一個視窗，關閉它會結束程式並中斷轉檔，已寫出的半成品會被清除。\n確定要關閉嗎？',
    }).then(({ response }) => {
      if (response !== 1) return; // 預設與 Esc 都落在「繼續轉檔」
      _allowQueueWindowClose = true;
      try { if (win && !win.isDestroyed()) win.close(); } finally { _allowQueueWindowClose = false; }
    }).catch(error => {
      console.error('[Queue] 關閉確認對話框失敗：', error);
    });
  });
  queueWin.on('closed', () => {
    queueWin = null;
    // 主視窗已由使用者關閉（目前是隱藏）後，再關監控視窗就等同整個程式都關閉。
    if (!_isAppQuitting && _mainHiddenForQueue && mainWin && !mainWin.isDestroyed()) app.quit();
  });
}

/* 關閉監控視窗會不會順帶結束程式：主視窗不在了（window-all-closed → quit），
   或主視窗只是為了讓監控視窗獨自存在而被隱藏（closed handler 會 app.quit()）。 */
function queueWindowCloseEndsApp() {
  if (!mainWin || mainWin.isDestroyed()) return true;
  return _mainHiddenForQueue;
}

function queueStatusSnapshot() {
  return QueueManager.statusSnapshot();
}

/* 匯出佇列（排程／持久化／恢復／關機收尾）住在 electron/export-queue.js。

   那一整段原本就長在這裡，而它需要的狀態是【模組層的 let】——
   EXPORT_QUEUE_DIR / _queuePaused / _queueConcurrency / _activeQueueCount。
   於是 main.js 成為唯一持有狀態的地方，同時還持有媒體快取、字型掃描、
   本機 HTTP 伺服器、mpv 整合⋯⋯十種互不相關的狀態。

   現在佇列【自己擁有】那些狀態，這裡只留接線：
   視窗生命週期與 _runJobLogic（spawn／log／進度回報）仍是 main.js 的職責，
   由 onChanged / runJob 注入。 */
QueueManager = createExportQueue({
  dir: () => EXPORT_QUEUE_DIR,
  createState: () => new ExportQueueState(),
  store: QueueStore,
  history: QueueHistory,
  JOB_STATUS,
  isLiveWork,
  isRetryable,
  reservesOutput,
  admission: _admission,
  grantPersistedCapabilities: grantPersistedQueueJobCapabilities,
  canReadSource: file => fileAuthority.canRead(file),
  canWriteDelivery: file => fileAuthority.canWriteDelivery(file),
  isFile: p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } },
  runJob: job => _runJobLogic(job),
  prepareDeliveryUpdate: prepareQueueDeliveryUpdate,
  onChanged: () => {
    safeWinSend(mainWin, 'queue:update');
    safeWinSend(mainWin, 'queue-status', queueStatusSnapshot());
    if (queueWin && !queueWin.isDestroyed()) safeWinSend(queueWin, 'queue:update');
  },
  onJobFailed: () => openQueueWindow(), // 失敗時把監控視窗叫出來
});

ipcMain.handle('project:openDroppedFile', (e, projectFile) => {
  /* Only preload can derive this path from an actual dropped File.  Do not
     pre-authorize it through fs:authorizeDroppedFile: a malformed project must
     leave no read/screenshot capability behind. */
  return projectWorkspace.open(projectFile);
});

ipcMain.handle('queue:getAll', () => ({
  jobs: QueueManager.jobs(),
  isPaused: QueueManager.isPaused,
  concurrency: QueueManager.concurrency
}));
ipcMain.handle('queue:getStatus', () => queueStatusSnapshot());

ipcMain.handle('queue:pause', (e, paused) => {
  QueueManager.setPaused(paused);
});

ipcMain.handle('queue:resume', () => {
  if (QueueManager.shuttingDown) return false;
  QueueManager.setPaused(false);
  return true;
});

ipcMain.handle('queue:setConcurrency', (e, c) => {
  QueueManager.setConcurrency(c);
});

ipcMain.handle('queue:stopJob', (e, jobId) => {
  return QueueManager.stopJob(jobId);
});

ipcMain.handle('queue:retryJob', (e, jobId) => {
  return QueueManager.retryJob(jobId);
});

ipcMain.handle('queue:clearJob', (e, jobId) => {
  return QueueManager.clearJob(jobId);
});

ipcMain.handle('queue:clearCompleted', () => {
  return QueueManager.clearCompleted();
});

ipcMain.handle('queue:reorderJob', (e, jobId, newIndex) => {
  return QueueManager.reorderJob(jobId, newIndex);
});

/* 改變【還沒開始轉檔】的工作的交付格式。

   安全性：renderer 只送 format 字串，**輸出路徑一律由這裡從既有的 outPath 推導**
   （同資料夾、同主檔名、只換副檔名）。renderer 給不了路徑，所以沒有注入空間；
   未知格式由 expectedExportExtension 直接擋掉（fail-closed）。

   為什麼改 payload 就夠：_runJobLogic 是在【執行時】才從 job.payload 重新推導
   format / isWav / isPro / audioPlan / timecodeWatermark 的，不是在入列時凍結的。
   （TC 浮水印在轉成 WAV 時會自動變成 null，因為那條路徑本來就寫 `isWav ? null : …`。） */
ipcMain.handle('queue:updateDelivery', (e, jobId, patch) => {
  return QueueManager.updateDelivery(jobId, patch);
});

function prepareQueueDeliveryUpdate(job, patch) {
  if (!job) throw new Error('找不到這份匯出工作');
  if (job.status !== JOB_STATUS.QUEUED) throw new Error('只有等待中的工作可以修改交付設定');

  const p = job.payload || {};
  const format = patch?.format != null ? String(patch.format) : String(p.format || '');
  const ext = expectedExportExtension(format); // 未知格式在這裡就丟 INVALID_EXPORT_FORMAT
  const isWav = format === 'wav';

  /* 解析度：以【專案畫布】的比例重算，不是拿目前的交付尺寸回推——
     交付尺寸的寬度已經取過偶數，反覆換算會累積誤差。畫布原值在入列時就存進 payload。
     舊工作沒有 canvasW/H 時退回目前的交付尺寸，比例仍然正確。 */
  const canvasW = Number(p.canvasW) > 0 ? Number(p.canvasW) : Number(p.width) || 1920;
  const canvasH = Number(p.canvasH) > 0 ? Number(p.canvasH) : Number(p.height) || 1080;
  const targetH = patch?.targetH != null ? Math.max(0, Math.floor(Number(patch.targetH) || 0)) : (Number(p.targetH) || 0);
  const { w, h } = deliveryResolution({ canvasW, canvasH, targetH, isWav });

  /* 碼率只有 H.264 用得到。給了就用給的，沒給而解析度變了就重新建議——
     1080p 的碼率套在 720p 上是浪費、套在 4K 上會糊掉（v4.32 的「輸出像 proxy」）。 */
  let videoKbps = Number(p.videoKbps) || 0;
  if (format === 'h264') {
    if (patch?.kbps != null) videoKbps = Math.max(1, Math.floor(Number(patch.kbps) || 0));
    else if (w !== Number(p.width) || h !== Number(p.height)) videoKbps = suggestKbps({ w, h });
  }

  /* 燒入 TC。WAV 沒有畫面可燒——這條規則在 delivery-list.js toJobs 是
     `(!isWav && r.burnTimecode) ? {…} : null`，這裡必須一致，否則從 MP4 改成 WAV
     之後 payload 還留著 watermark，_runJobLogic 那邊雖然也會擋（isWav ? null : …），
     但佇列畫面會顯示「燒入 TC」而實際不會燒——顯示說謊比不顯示更糟。 */
  const wantsTc = patch?.burnTimecode != null ? !!patch.burnTimecode : !!p.timecodeWatermark;
  let timecodeWatermark = null;
  if (!isWav && wantsTc) {
    /* 重建 watermark 時必須用【送出當下的時間軸起點】。payload.timelineStartTimecode
       就是為此而存的（見 delivery-list.js toJobs）。取不到就【不要猜】——
       猜 00:00:00:00 在設過 In 點的專案會燒出錯的時間碼，而畫面一切正常。
       舊工作沒有這個欄位，寧可擋下來要使用者重送。 */
    const start = p.timecodeWatermark?.start ?? p.timelineStartTimecode;
    if (!start) throw new Error('這份工作沒有記錄時間軸起點，無法補上燒入 TC；請重新從交付清單送出');
    timecodeWatermark = { start };
  }

  const oldPath = String(p.outPath || '');
  if (!oldPath) throw new Error('這份工作沒有輸出路徑');
  /* 檔名的 _TC 後綴要跟著 TC 開關走（defaultDeliveryName 就是這樣命名的）。
     不同步的話，關掉 TC 之後檔名還叫 …_TC.mp4，交付出去會被誤認。 */
  const stem = oldPath.replace(/\.[^.\\/]*$/, '').replace(/_TC$/, '');
  const newPath = stem + (timecodeWatermark ? '_TC' : '') + '.' + ext;

  /* 先用候選物件跑一次准入檢查，通過才真的改到 job 上——
     失敗時 job 必須維持原狀，不可以留下改到一半的狀態。 */
  const nextPayload = { ...p, format, outPath: newPath, width: w, height: h, targetH, videoKbps, canvasW, canvasH, timecodeWatermark };
  const candidate = { ...job, payload: nextPayload };
  _admission.assertOutputFormat(candidate);
  _admission.assertOutputAvailable(candidate, job.id); // 排除自己；擋同路徑撞車
  return {
    payload: nextPayload,
    result: { format, outPath: newPath, width: w, height: h, targetH, videoKbps, burnTimecode: !!timecodeWatermark },
    /* 同資料夾、同主檔名，只換副檔名。能力只在 job 快照成功落盤後才擴張，
       失敗時不留下 renderer 看不到的半份授權。 */
    onCommitted: newPath !== oldPath ? () => fileAuthority.grantDeliveryFile(newPath) : undefined,
  };
}

ipcMain.handle('queue:openMonitor', () => {
  openQueueWindow();
});

ipcMain.handle('ffmpeg:exportVideo', async (e, payload) => {
  if (!FFMPEG) throw new Error('找不到 ffmpeg');
  const { clips, videoTracks, width, height, fps, assText, format, duration, defaultName, outPath: presetOut, videoKbps, audioPlan: rawAudioPlan, timecodeWatermark: rawTimecodeWatermark } = payload;
  const ext = expectedExportExtension(format);
  const isWav = format === 'wav';
  const audioPlan = _normalizeAudioPlan(rawAudioPlan, { requireStreams: !isWav });
  const timecodeWatermark = isWav ? null : _normaliseExportTimecodeWatermark(rawTimecodeWatermark, fps);
  const isPro = format === 'prores';
  
  let outPath = presetOut || null;
  if (!outPath) {
    const r = await dialog.showSaveDialog(mainWin, {
      title: isWav ? '匯出音訊' : '匯出影片', defaultPath: (defaultName || 'sequence') + '.' + ext,
      filters: [{ name: isWav ? 'WAV 多聲道 PCM' : (isPro ? 'ProRes 422 HQ (MOV)' : 'MP4 (H.264)'), extensions: [ext] }],
    });
    if (r.canceled) return null;
    outPath = r.filePath;
    fileAuthority.grantDeliveryFile(outPath);
  }

  // presetOut 只能來自已選取的交付目錄；不允許 renderer 以略過 save dialog 的
  // payload 取得任意寫檔能力。先驗證再寫 ASS 暫存，失敗不留下半份 queue artifact。
  const authorizationPayload = { ...payload, audioPlan, outPath };
  QueueManager.assertJobCapabilities({ payload: authorizationPayload });
  // 交付目錄能力只代表「可建立候選檔」；工作通過格式、來源與路徑驗證後，
  // 才給這一個成品 shell reveal 的精確能力。
  fileAuthority.grantDeliveryFile(outPath);

  const jobId = newJobId('export-');
  // 分離 assText 存為獨立檔案
  let assRef = null;
  if (assText && assText.trim()) {
    assRef = jobId + '.ass';
    QueueManager.ensureDir();
    QueueStore.writeAssFile(EXPORT_QUEUE_DIR, assRef, assText);
  }
  
  // 佇列顯示與 runFF 必須共用同一個實際交付時長：音訊 plan 的尾端若較長，
  // ffmpeg 會以它延長成品，不能讓等待中的列仍顯示較短的前端宣告值。
  const effectiveDuration = Math.max(0.05, _finiteNumber(duration, 0), _planDuration(audioPlan));
  const savedPayload = { ...payload, audioPlan, assText: null, outPath, duration: effectiveDuration };
  const job = { id: jobId, status: JOB_STATUS.QUEUED, createdAt: Date.now(), payload: savedPayload, assRef, senderId: e.sender.id };
  try {
    QueueManager.addJob(job);
  } catch (error) {
    if (assRef) {
      try { QueueStore.removeAssFile(EXPORT_QUEUE_DIR, assRef); } catch (cleanupError) {}
    }
    throw error;
  }
  openQueueWindow();
  return jobId;
});

async function _runJobLogic(job) {
  // 解構 job.payload 變數
  // [v5.4.4] 將 width, height, fps, duration 重新命名為 payloadWidth, payloadHeight, payloadFps, payloadDuration
  // 避免與後續 ffmpeg 生成參數時使用的短變數 W, H, R, D 產生命名衝突 (ReferenceError)。
  const { clips, videoTracks, width: payloadWidth, height: payloadHeight, fps: payloadFps, format, duration: payloadDuration, outPath, videoKbps, audioPlan: rawAudioPlan, timecodeWatermark: rawTimecodeWatermark } = job.payload;
  const jobId = job.id;
  // Get sender if available
  let sender = null;
  try {
    const wc = require('electron').webContents.fromId(job.senderId);
    if (wc && !wc.isDestroyed()) sender = wc;
  } catch (err) {}
  
  const fallbackSender = mainWin && !mainWin.isDestroyed() ? mainWin.webContents : null;
  const dispatch = (evt, data) => {
    // 進度與 terminal transition 都由 QueueManager 擁有；runJob adapter 只轉送。
    // 這避免 main.js 和 queue 各自改 job.status，造成合法狀態機被繞過。
    relayQueueRunnerEvent({
      reportProgress: (id, progress) => QueueManager.reportProgress(id, progress),
      send: (event, payload) => {
        if (sender) safeSend(sender, event, payload);
        else if (fallbackSender) safeSend(fallbackSender, event, payload);
      },
    }, jobId, evt, data);
  };

  const isWav = format === 'wav';
  const audioPlan = _normalizeAudioPlan(rawAudioPlan, { requireStreams: !isWav });
  const timecodeWatermark = isWav ? null : _normaliseExportTimecodeWatermark(rawTimecodeWatermark, payloadFps);
  const isPro = format === 'prores';
  QueueManager.assertJobCapabilities(job);
  
  // 載入分離的 assText
  let assText = null;
  if (job.assRef) {
    const assPath = QueueStore.safeAssPath(EXPORT_QUEUE_DIR, job.assRef);
    try {
      if (!assPath) throw new Error('字幕暫存路徑無效');
      assText = fs.readFileSync(assPath, 'utf8');
    } catch (cause) {
      const error = new Error(`找不到字幕快照：${assPath || job.assRef}`);
      error.code = 'MISSING_SOURCE';
      error.cause = cause;
      throw error;
    }
  }


    try {
      // 匯出工作只能使用建立時已經過可信入口授權的來源；不能因序列化 payload
      // 在背景執行時再次把 renderer 資料升格成檔案能力。
      // 交付規格 → argv 的整段決策住在 export-plan.js（零 require、可在 vitest 直接測）。
      // 這裡只留真正需要副作用的事：建暫存目錄、把字幕快照寫成 .ass、spawn、回報。
      ensureTmp();
      let assName = null;
      if (assText && assText.trim()) {
        assName = QueueStore.burnAssFileName(jobId);
        fs.writeFileSync(path.join(TMP, assName), assText, 'utf8');
      }
      const audioPresence = new Map(await Promise.all(
        [...new Set((clips || [])
          .filter(clip => clip?.path && clip.type !== 'image')
          .map(clip => clip.path))]
          .map(async sourcePath => [sourcePath, await mediaProbe.hasAudio(sourcePath)]),
      ));
      const plan = buildDeliveryArgv({
        format, clips, videoTracks,
        width: payloadWidth, height: payloadHeight, fps: payloadFps,
        duration: payloadDuration, videoKbps, audioPlan, timecodeWatermark,
        assFileName: assName, outPath,
      }, {
        hwdecArgs, vencArgsBitrate, proresArgs,
        encoderName: VENC,
        hasAudioStream: sourcePath => audioPresence.get(sourcePath) ?? true,
        fontsDir: fontsRoot(),
        timecodeFontFile: _findExportTimecodeFont(),
      });
      const { args, label, duration: D, kbps, audioBitrates } = plan;

      if (isWav) {
        const t0 = Date.now();
        await runFF(args, { duration: D, jobId, label, outPath,
          onProgress: data => dispatch('task-progress', data),
          onProcess: controller => {
            QueueManager.registerActiveJob(jobId, {
              controller,
              p: controller.process,
              stop: controller.stop,
              completion: controller.completion,
              outPath,
              stopped: false,
            });
          }
        });
        QueueManager.clearActiveJob(jobId);
        const r = { outPath, encoder: plan.plannedEncoder, gpu: false, elapsedMs: Date.now() - t0, videoKbps: null, audioChannels: plan.audioChannels };
        dispatch( 'task-progress', { jobId, label, pct: 100, done: true, result: r });
        return;
      }

      let usedEncoder = plan.plannedEncoder;
      const t0 = Date.now();
      try {
        const rr = await runFF(args, { duration: D, jobId, label, cwd: TMP, outPath,
          onProgress: data => dispatch('task-progress', data),
          onProcess: controller => {
            QueueManager.registerActiveJob(jobId, {
              id: jobId,
              controller,
              p: controller.process,
              stop: controller.stop,
              completion: controller.completion,
              outPath,
              stopped: false,
            });
          }
        });
    // ffmpeg 的串流對應行是「實際使用」的地面真相（非我們的猜測）：
    //   例 "mpeg2video (native) -> h264 (h264_nvenc)" → 取箭頭右側括號內的編碼器
    const vmap = (rr.maps || []).find(m => /->/.test(m) && /h264|prores|hevc/i.test(m));
    const em = vmap && /->\s*[^(]*\(([^)]+)\)\s*$/.exec(vmap.trim());
    if (em) usedEncoder = em[1].trim();
  } finally {
    if (assName) { try { fs.unlinkSync(path.join(TMP, assName)); } catch (e2) {} }
  }
  // 回傳 ffmpeg 實際使用的編碼器與耗時，供 renderer 顯示「這次真的用了 GPU 沒有」
      QueueManager.clearActiveJob(jobId);
      const r = {
        outPath, encoder: usedEncoder, gpu: /nvenc|qsv|amf|videotoolbox|vaapi/i.test(usedEncoder),
        elapsedMs: Date.now() - t0, videoKbps: isPro ? null : kbps,
        audioBitrates: isPro ? null : audioBitrates,
        audioActualBitrates: isPro ? null : await mediaProbe.audioBitrates(outPath)
      };
      dispatch( 'task-progress', { jobId, label, pct: 100, done: true, result: r });
    } catch (err) {
      const active = QueueManager.activeJob(jobId);
      const wasShutdown = !!active?.shutdown;
      const wasStopped = !!active?.stopped;
      QueueManager.clearActiveJob(jobId);
      /* 手動停止優先於隨後的 app shutdown；否則 stopping 會被關機當作 queued 恢復，
         使用者明確取消的工作在重啟後反而重新執行。 */
      const progress = runnerFailureProgress({ stopped: wasStopped, shutdown: wasShutdown, error: err });
      if (progress) dispatch('task-progress', { jobId, ...progress });
    }
  
}


ipcMain.handle('dialog:importDirectory', async () => {
  const r = await dialog.showOpenDialog({
    title: '選擇匯入資料夾',
    properties: ['openDirectory']
  });
  if (r.canceled || r.filePaths.length === 0) return null;
  const dir = r.filePaths[0];
  fileAuthority.grantTrustedDirectory(dir, { read: true, write: false });
  const files = [];
  /* name 必須是【相對於所選資料夾】的路徑：呼叫端（app.js 匯入樣式）就是靠 name 的第一段
     還原「樣式資料夾」。之前這裡只回檔名，遞迴進子目錄後資料夾資訊就沒了 → 匯出時建好的
     資料夾結構再匯入回來全部被攤平、group 全部遺失。分隔符一律正規化成 "/"。 */
  function scan(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) scan(p);
      else if (f.endsWith('.json')) {
        files.push({ name: path.relative(dir, p).split(path.sep).join('/'), b64: fs.readFileSync(p).toString('base64') });
      }
    }
  }
  scan(dir);
  return files;
});

ipcMain.handle('dialog:exportDirectory', async (e, files) => {
  const r = await dialog.showOpenDialog({
    title: '選擇匯出資料夾',
    properties: ['openDirectory', 'createDirectory']
  });
  if (r.canceled || r.filePaths.length === 0) return null;
  const dir = r.filePaths[0];
  // 空清單是交付視窗的「選擇輸出目錄」；只有使用者在這個 native picker
  // 明示選取時才授予 ffmpeg 的 delivery capability。樣式包匯出帶實際 files，
  // 由本 handler 直接寫入即可，不能順便升格成後續影片覆寫權。
  const isDeliveryDirectory = !Array.isArray(files) || files.length === 0;
  if (isDeliveryDirectory) fileAuthority.grantDeliveryDirectory(dir);
  /* 檔名可能源自使用者匯入的資料（例如樣式包 .json 裡的 group 欄位），renderer 端已淨化，
     這裡再擋一次：path.join 會把 "../" 正規化掉，光靠呼叫端把關等於沒有把關。
     一律要求最終路徑落在使用者剛剛選定的資料夾底下，否則跳過並記錄。
     圍堵判斷在 export-name-safety.js（跨行程契約的另一側）。 */
  const root = path.resolve(dir);
  let written = 0, blocked = 0;
  for (const f of files || []) {
    const data = f && (f.content || f.b64);
    if (!f || typeof f.name !== 'string' || !f.name || !data) continue;
    const fullPath = path.resolve(root, f.name);
    if (!isPathContained(root, f.name)) {
      blocked++; console.warn('[sec] exportDirectory blocked (escapes target dir):', f.name);
      continue;
    }
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, Buffer.from(data, 'base64'));
    written++;
  }
  if (blocked) console.warn(`[sec] exportDirectory: ${blocked} 個檔案因路徑越界被略過（已寫入 ${written} 個）`);
  return dir;
});

/* ---- 快取管理 ---- */
ipcMain.handle('cache:info', () => mediaIntakeRuntime.cacheInfo());
ipcMain.handle('cache:cleanOrphans', () => mediaIntakeRuntime.cleanOrphans());
ipcMain.handle('cache:clearAll', (e, currentSrc) => mediaIntakeRuntime.clearAll(currentSrc));

ipcMain.handle('ffprobe', (e, p) => {
  if (!mediaProbe) throw new Error('找不到 ffprobe');
  requireReadablePath('ffprobe', p);
  return mediaProbe.describe(p);
});

ipcMain.handle('ffmpeg:proxy', async (e, { path: src, duration }) => {
  requireReadablePath('ffmpeg:proxy', src);
  const out = tmpPath('mp4');
  const args = buildIngestArgs({ src, needsProxy: true, proxyPath: out, encoder: VENC, isStream: false });
  await runFF(args, { sender: e.sender, duration, jobId: 'proxy', label: '轉檔預覽影片' });
  return out;
});

ipcMain.handle('ffmpeg:extractAudio', async (e, { path: src, idx, duration, codec }) => {
  requireReadablePath('ffmpeg:extractAudio', src);
  const out = tmpPath('m4a');
  // PCM 無法 copy 進 m4a（一定失敗），直接編 AAC；其餘編碼先試無損 copy，失敗才編 AAC
  if (!/^pcm/i.test(codec || '')) {
    try {
      await runFF(['-y', '-i', src, '-map', `0:a:${idx}`, '-vn', '-c:a', 'copy', out], { sender: e.sender, duration, jobId: 'a' + idx, label: '抽取音軌 ' + (idx + 1) });
      return out;
    } catch (err) { /* 退回 AAC */ }
  }
  await runFF(['-y', '-i', src, '-map', `0:a:${idx}`, '-vn', '-c:a', 'aac', '-b:a', '128k', out], { sender: e.sender, duration, jobId: 'a' + idx, label: '抽取音軌 ' + (idx + 1) });
  return out;
});

ipcMain.handle('ffmpeg:waveAudio', async (e, { path: src, duration }) => {
  requireReadablePath('ffmpeg:waveAudio', src);
  const out = tmpPath('wav');
  await runFF(['-y', '-i', src, '-map', '0:a:0', '-ar', '4000', '-c:a', 'pcm_s16le', out],
    { sender: e.sender, duration, jobId: 'wave', label: '產生波形' });
  return out;
});

/* Renderer 只能交付程式自己編出的 16 kHz mono PCM WAV bytes，不能指定輸入／輸出路徑。
   64 kbps MP3 只活在這次辨識呼叫期間；成功、失敗都由 compressor 清掉兩個暫存檔。 */
ipcMain.handle('speech:compressAudio', async (e, { bytes, requestId } = {}) => {
  if (!FFMPEG) throw new Error('找不到 ffmpeg，無法建立辨識用 MP3');
  return speechCompressionRuntime.compress(bytes, requestId);
});
ipcMain.handle('speech:cancelCompression', async (e, { requestId } = {}) => {
  return speechCompressionRuntime.cancel(requestId);
});

/* ---- 字幕字型（v4.25.4）：掃描 <專案根>/font/ ----
   每個子資料夾名＝字型名（如「台北黑體」），內含 .ttf/.otf/.ttc/.woff2 任一即採用；
   根目錄下的字型檔也收（檔名去副檔名當字型名）。renderer 用它注入 @font-face（預覽），
   匯出（libass）則以 fontsdir 指向同一資料夾 → 預覽與燒錄同一份字型。 */
function userFontsDir() {
  const d = path.join(app.getPath('userData'), 'font');
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  return d;
}

function fontsRoots() {
  const cands = [
    userFontsDir(),
    path.join(__dirname, '..', 'font'),
    path.join(process.resourcesPath || '', 'font'),
    path.join(path.dirname(app.getPath('exe')), 'font'),
  ];
  const list = [];
  for (const d of cands) {
    try {
      if (d && fs.existsSync(d) && fs.statSync(d).isDirectory()) {
        if (!list.includes(d)) list.push(d);
      }
    } catch (e) {}
  }
  return list;
}

function fontsRoot() {
  return userFontsDir();
}
const FONT_EXT = /\.(ttf|otf|ttc|woff2?)$/i;

/* 讀出字型檔【內部的家族名】（sfnt name table）供 ASS Fontname 使用。
   ── 為什麼非讀不可（v4.29.3 修）：ASS 的 Fontname 是給 libass／fontconfig 比對用的，它們只認
      字型檔內部的家族名；我們 UI 顯示的是【資料夾名】（使用者自己取，例如「台北黑體」，
      而檔案內部其實叫 "Taipei Sans TC Beta"）。直接把資料夾名填進 ASS → libass 找不到 →
      靜默退回系統字型（實測全部退到微軟正黑體）→ 匯出/mpv 與預覽字型不同，且毫無錯誤訊息。
   ── 為什麼是 nameID 1 而非 16：libass 的目錄字型供應者走 FreeType 的 face->family_name，
      那就是 nameID 1。取 16（typographic family）會漏掉權重字尾——例如思源黑體的
      nameID1="Noto Sans CJK TC Regular"、nameID16="Noto Sans CJK TC"，填 16 一樣配不到（實測）。
   ── 取英文（Windows platform 3 / lang 0x0409）：FreeType 亦以英文名為 family_name。 */
function fontNamesOf(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const read = (pos, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); return b; };
    let base = 0;
    if (read(0, 4).toString('latin1') === 'ttcf') base = read(12, 4).readUInt32BE(0); // TTC＝字型集合，取第一個 face
    const numTables = read(base + 4, 2).readUInt16BE(0);
    let nameOff = 0, nameLen = 0, os2Off = 0;
    for (let i = 0; i < numTables; i++) {
      const e = read(base + 12 + i * 16, 16);
      const tag = e.toString('latin1', 0, 4);
      if (tag === 'name') { nameOff = e.readUInt32BE(8); nameLen = e.readUInt32BE(12); }
      else if (tag === 'OS/2') { os2Off = e.readUInt32BE(8); }
    }
    // OS/2：usWeightClass（400=Regular／700=Bold）＋ fsSelection bit0＝斜體。
    // ── 為什麼不能只看 name table 的 subfamily：CJK 字型每個字重各自是一個「家族」，
    //    subfamily 一律寫 Regular（例如 Noto Sans CJK TC Black 的 nameID2 也是 "Regular"），
    //    光看它分不出 Black 與 Regular。
    let weight = 0, italic = false;
    if (os2Off) {
      const o = read(os2Off, 64);
      weight = o.readUInt16BE(4);
      italic = !!(o.readUInt16BE(62) & 1);
    }
    if (!nameOff || !nameLen) return { family: null, subfamily: '', weight, italic };
    const t = read(nameOff, nameLen);
    const count = t.readUInt16BE(2), strOff = t.readUInt16BE(4);
    const cand = {}; // `${nameID}|${英文?1:0}` → 字串
    for (let i = 0; i < count; i++) {
      const r = 6 + i * 12;
      if (r + 12 > t.length) break;
      const pid = t.readUInt16BE(r), lid = t.readUInt16BE(r + 4);
      const nid = t.readUInt16BE(r + 6), len = t.readUInt16BE(r + 8), off = t.readUInt16BE(r + 10);
      if (nid !== 1 && nid !== 2 && nid !== 16) continue; // 1=家族 2=樣式(Regular/Bold/Italic…) 16=排版家族
      const raw = t.subarray(strOff + off, strOff + off + len);
      if (!raw.length) continue;
      // platform 3(Windows)/0(Unicode) 為 UTF-16BE；1(Mac) 為單 byte
      const s = (pid === 3 || pid === 0)
        ? Buffer.from(raw).swap16().toString('utf16le').replace(/\0/g, '')
        : raw.toString('latin1');
      if (!s.trim()) continue;
      const en = (pid === 3 && lid === 0x0409) || (pid === 1 && lid === 0) ? 1 : 0;
      const k = `${nid}|${en}`;
      if (!cand[k]) cand[k] = s.trim();
    }
    return {
      family: cand['1|1'] || cand['16|1'] || cand['1|0'] || cand['16|0'] || null,
      subfamily: cand['2|1'] || cand['2|0'] || '',
      weight, italic,
    };
  } catch (e) { console.error('[fonts] names', file, e.message); return null; }
  finally { if (fd != null) try { fs.closeSync(fd); } catch (e2) {} }
}
const fontFamilyOf = f => (fontNamesOf(f) || {}).family || null;

/* 一個資料夾放了多個字重時，挑【最接近 Regular(400) 且非斜體】那一個當代表。
   ── 舊版是 readdir 的第一個＝按檔名排序的第一個。使用者把整組字重丟進資料夾後：
      思源黑體／宋體挑到 Black（連 ASS 家族名都變成 "Noto Sans CJK TC Black"）、
      更紗黑體挑到 bold.ttf——而更紗各字重的家族名相同，於是【預覽是粗體、匯出卻是 Regular】，
      三路當場不一致，且毫無徵兆（實測）。
   ── 判準用 OS/2 的 usWeightClass 而非 subfamily：見 fontNamesOf 的說明。 */
function pickRegularFace(dir, files) {
  const cands = files.filter(f => FONT_EXT.test(f));
  if (cands.length <= 1) return cands[0] || null;
  let best = null, bestScore = Infinity;
  for (const f of cands) {
    const m = fontNamesOf(path.join(dir, f)) || {};
    const italic = m.italic || /italic|oblique/i.test(f);
    // 距離 400 越近越好；斜體重罰（大於任何字重差距）；讀不到 OS/2 時以檔名含 regular 為輔
    const w = m.weight || (/(^|[-_ ])regular([-_. ]|$)/i.test(f) ? 400 : 1000);
    const score = Math.abs(w - 400) + (italic ? 10000 : 0);
    if (score < bestScore) { bestScore = score; best = f; }
  }
  return best || cands[0];
}

ipcMain.handle('fonts:list', () => {
  const roots = fontsRoots();
  const targetRoot = userFontsDir();
  // 將其他目錄的字型自動同步/補充到 userFontsDir，確保 single-fontsdir 時也能全數讀取
  for (const root of roots) {
    if (root === targetRoot) continue;
    try {
      for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
        const srcPath = path.join(root, ent.name);
        const destPath = path.join(targetRoot, ent.name);
        if (!fs.existsSync(destPath)) {
          if (ent.isDirectory()) fs.cpSync(srcPath, destPath, { recursive: true });
          else fs.copyFileSync(srcPath, destPath);
        }
      }
    } catch (e) {}
  }

  const out = [];
  const pushFile = (name, file) => {
    if (out.some(f => f.name === name)) return;
    out.push({ name, file, family: fontFamilyOf(file) || name });
  };

  const finalRoots = fontsRoots();
  for (const root of finalRoots) {
    fileAuthority.grantTrustedDirectory(root, { read: true, write: false });
    try {
      for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
        const full = path.join(root, ent.name);
        if (ent.isDirectory()) {
          let hit = null;
          try { hit = pickRegularFace(full, fs.readdirSync(full)); } catch (e) {}
          if (hit) pushFile(ent.name, path.join(full, hit));
        } else if (FONT_EXT.test(ent.name)) {
          pushFile(ent.name.replace(FONT_EXT, ''), full);
        }
      }
    } catch (e) { console.error('[fonts] list', e); }
  }
  return { root: targetRoot, fonts: out };
});

/* 只清自己產生的暫存／快取檔。呼叫端傳的一律是 ffmpeg 寫進 CACHE/TMP 的中繼檔
   （見 media.js 的 cleanupAudio(wavPath)），所以限制在這兩個根目錄底下不影響任何既有流程；
   少了這道檢查，這支 handler 就是一個「刪除磁碟上任意檔案」的原語，而 unlinkSync 不進資源回收筒。 */
ipcMain.handle('ffmpeg:cleanup', async (e, { path: p }) => {
  mediaIntakeRuntime.cleanupGeneratedFile(p);
});

/* ---- 單次讀取多輸出：整個來源檔只讀一遍，同時產生 proxy + 每聲道音訊 + 混音波形 ----
   每聲道以 asplit 分流（不直接 -map 同一條 stream，避免 filtergraph 與 -map 雙重消費而 deadlock）。
   結果由 media-intake-runtime 存入持久快取，重開同檔直接命中、秒開。 */
function getConfigPath() {
  const configDir = app.isPackaged ? path.join(app.getPath('userData'), 'config') : path.join(app.getAppPath(), '.config');
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  return path.join(configDir, 'settings.json');
}

ipcMain.handle('config:load', () => {
  try {
    const p = getConfigPath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch(e) { console.error('[config] load err', e); }
  return {};
});

ipcMain.handle('config:save', (e, data) => {
  try {
    const p = getConfigPath();
    const current = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
    const merged = mergeRendererConfig(current, data);
    fs.writeFileSync(p, JSON.stringify(merged, null, 2), 'utf8');
    return true;
  } catch(e) { console.error('[config] save err', e); return false; }
});

function getKeysPath() {
  const configDir = app.isPackaged ? path.join(app.getPath('userData'), 'config') : path.join(app.getAppPath(), '.config');
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  return path.join(configDir, 'key.json');
}

ipcMain.handle('keys:load', () => {
  try {
    const p = getKeysPath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch(e) { console.error('[keys] load err', e); }
  return {};
});

ipcMain.handle('keys:save', (e, data) => {
  try {
    const p = getKeysPath();
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch(e) { console.error('[keys] save err', e); return false; }
});

function mediaIntakeSession(event, lease) {
  return {
    progressTarget: event.sender,
    isCancelled: () => !!lease?.isCancelled?.(),
    ownProcess: process => lease?.setProcess?.(process),
  };
}

ipcMain.handle('ffmpeg:ingest', async (e, { path: src, duration, needsProxy, audio, queue }) => {
  requireReadablePath('ffmpeg:ingest', src);
  const run = lease => mediaIntakeRuntime.ingest(
    { src, duration, needsProxy, audio },
    mediaIntakeSession(e, lease),
  );
  /* queue=false 是新的主素材，會淘汰舊主素材及尚未開始的背景工作；queue=true
     則排在連 streamIngest 的完整 completion 後面，絕不與它同時寫 cache。 */
  return queue ? mediaIngestCoordinator.enqueue(run) : mediaIngestCoordinator.replace(run);
});

/* 讀取快取檔案內容（base64）給 renderer（例如波形 wav） */
ipcMain.handle('fs:readB64', async (e, p) => {
  if (!fileAuthority.canRead(p)) { console.warn('[sec] readB64 blocked:', p); return null; }
  try { return (await fs.promises.readFile(p)).toString('base64'); } catch (err) { return null; }
});
ipcMain.handle('fs:writeProject', async (e, { path: p, b64 }) => {
  // autosave 落在使用者已選取的專案／媒體資料夾旁；不可讓 renderer 自行擴張寫入根。
  if (!fileAuthority.canWriteProject(p)) { console.warn('[sec] writeProject blocked:', p); return null; }
  try { return await projectWorkspace.writeRendererProject(p, b64, { ensureParent: true }); }
  catch (err) { return null; }
});
ipcMain.handle('fs:writeScreenshot', async (e, { path: p, b64 }) => {
  if (!fileAuthority.canWriteScreenshot(p)) { console.warn('[sec] writeScreenshot blocked:', p); return null; }
  try { await fs.promises.mkdir(path.dirname(p), { recursive: true }); await fs.promises.writeFile(p, Buffer.from(b64, 'base64')); return p; } catch (err) { console.error('[writeScreenshot] error:', err.message); return null; }
});

/* ---- 邊轉邊播 ingest（MXF 等非原生格式秒開）：fragmented MP4 + 本機 HTTP 伺服器 ----
   video 轉成 fragmented MP4（empty_moov），前幾秒輸出後就可播放；音軌/波形同一 pass 在背景繼續。
   快取命中時行為與 ffmpeg:ingest 相同（秒開）。 */
ipcMain.handle('ffmpeg:streamIngest', async (e, { path: src, duration, audio }) => {
  requireReadablePath('ffmpeg:streamIngest', src);
  return mediaIngestCoordinator.replace(lease => mediaIntakeRuntime.stream(
    { src, duration, audio },
    mediaIntakeSession(e, lease),
  ));
});
ipcMain.handle('ffmpeg:releaseStream', (e, streamLeaseId) =>
  mediaIntakeRuntime.releaseStream(streamLeaseId));

/* ============ mpv 媒體播放器整合（秒開非原生格式，無需等待 ffmpeg proxy 轉檔） ============
   原生 child process、named pipe 與兩個透明宿主視窗均由 mpv-host 擁有；本檔只保留
   主視窗／檔案能力／IPC adapter。MPV_GUIDE_HTML 是 guide 的靜態 view template。 */

const MPV_GUIDE_HTML = `<!doctype html><html><head><style>
html,body{width:100%;height:100%;margin:0;padding:0;overflow:hidden;background:transparent;pointer-events:none}
svg{width:100%;height:100%;margin:0;padding:0;overflow:hidden;background:transparent;pointer-events:none}
#imgContainer{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none}
#timecodeWatermark{display:none;position:absolute;top:14px;left:16px;z-index:10;pointer-events:none;user-select:none;white-space:nowrap;padding:6px 9px 5px;border:1px solid rgba(239,178,53,.78);border-left:3px solid #f0a020;border-radius:2px;background:rgba(8,11,14,.72);box-shadow:0 1px 5px rgba(0,0,0,.55);color:#ffe19a;font:600 16px/1 Consolas,"Cascadia Mono","JetBrains Mono",monospace;letter-spacing:.045em;font-variant-numeric:tabular-nums;text-shadow:0 1px 2px #000}
#timecodeWatermark.visible{display:block}
.img-wrap{position:absolute;pointer-events:none;user-select:none}
.img-wrap img{width:100%;height:100%;object-fit:contain;display:block;pointer-events:none}
.img-wrap.selected{outline:1px dashed rgba(255,255,255,.72);outline-offset:3px}
.resize-handle{display:none;position:absolute;width:12px;height:12px;background:#f0a020;border:1px solid #fff;border-radius:50%;z-index:10;pointer-events:none}
.img-wrap.selected .resize-handle{display:block}
/* guide 的把手只有視覺提示；真正的可點 hit area 留在 src/styles.css 的 #imageLayer。 */
.resize-handle::after{content:'';position:absolute;inset:-8px;pointer-events:none}
.rh-nw{top:0;left:0}.rh-ne{top:0;right:0}
.rh-sw{bottom:0;left:0}.rh-se{bottom:0;right:0}
#guide{display:none} rect{fill:none;stroke:rgba(255,255,255,.88);stroke-width:1;stroke-dasharray:5 4}
line{stroke:rgba(255,255,255,.65);stroke-width:1} circle{fill:#f0a020;stroke:#fff;stroke-width:2}
</style></head><body><div id="imgContainer"></div><svg id="svg"><g id="guide"><rect id="box"/><line id="stem"/><circle id="dot" r="7"/></g></svg><div id="timecodeWatermark" aria-hidden="true"></div><script>
let current=null,stageRect=null;
const svg=document.getElementById('svg'),guide=document.getElementById('guide'),imgContainer=document.getElementById('imgContainer'),timecodeWatermark=document.getElementById('timecodeWatermark');
const draw=()=>{ const g=current; if(!g){guide.style.display='none';return;} const w=innerWidth,h=innerHeight;
  svg.setAttribute('viewBox','0 0 '+w+' '+h); document.getElementById('box').setAttribute('x',g.x); document.getElementById('box').setAttribute('y',g.y);
  document.getElementById('box').setAttribute('width',g.w); document.getElementById('box').setAttribute('height',g.h);
  const cx=g.x+g.w/2, cy=g.y-19, stem=document.getElementById('stem'), dot=document.getElementById('dot');
  stem.setAttribute('x1',cx);stem.setAttribute('y1',cy+7);stem.setAttribute('x2',cx);stem.setAttribute('y2',g.y-2);
  dot.setAttribute('cx',cx);dot.setAttribute('cy',cy);guide.style.display='block'; };
window.setGuide=(g)=>{current=g;draw();}; addEventListener('resize',draw);
window.setTimecodeWatermark=(text,rect)=>{const value=typeof text==='string'?text:'';const x=Number(rect&&rect.x),y=Number(rect&&rect.y);timecodeWatermark.style.left=(Number.isFinite(x)?Math.round(x)+16:16)+'px';timecodeWatermark.style.top=(Number.isFinite(y)?Math.round(y)+14:14)+'px';timecodeWatermark.textContent=value;timecodeWatermark.classList.toggle('visible',!!value);};
window.setImages = (h, r) => {
  stageRect = r && Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.w) && Number.isFinite(r.h) ? r : null;
  if(stageRect){
    imgContainer.style.left = stageRect.x + 'px';
    imgContainer.style.top = stageRect.y + 'px';
    imgContainer.style.width = stageRect.w + 'px';
    imgContainer.style.height = stageRect.h + 'px';
  }
  const tpl = document.createElement('template');
  tpl.innerHTML = h || '';
  const incoming = [...tpl.content.querySelectorAll('.img-wrap')];
  const existing = new Map([...imgContainer.querySelectorAll('.img-wrap')].map(el => [el.dataset.id, el]));
  
  for(const next of incoming) {
    const id = next.dataset.id;
    const old = existing.get(id);
    if(old) {
      // 保留正在 Hover 的狀態，避免重繪閃爍
      const hovering = old.classList.contains('hovering');
      old.className = next.className + (hovering ? ' hovering' : '');
      old.setAttribute('style', next.getAttribute('style') || '');
      
      // 【v4.6.3 重要改動 - 縮放把手同步重繪】
      // 若只更新外層 (.img-wrap) 的 style，內部 4 個拖曳角 (.resize-handle) 的 style
      // 會殘留在舊座標，導致圖片縮放時，黃色控制點沒有隨之移動。
      // 這裡強制遍歷並同步所有 resize-handle 的行內樣式，確保把手能精準附著在圖片的最新邊界上。
      const oh = old.querySelectorAll('.resize-handle');
      const nh = next.querySelectorAll('.resize-handle');
      for (let i = 0; i < oh.length; i++) {
        if (nh[i]) oh[i].setAttribute('style', nh[i].getAttribute('style') || '');
      }
      
      const ni = next.querySelector('img'), oi = old.querySelector('img');
      if (ni && oi && oi.getAttribute('src') !== ni.getAttribute('src')) {
        oi.setAttribute('src', ni.getAttribute('src'));
      }
      existing.delete(id);
    } else {
      imgContainer.appendChild(next);
    }
  }
  for(const old of existing.values()) old.remove();
};
</script></body></html>`;

/* Windows 原生 mpv 的 aggregate 在 mpv-host；此處只有 Electron／安全 IPC adapter。 */
const mpvHost = createMpvHost({
  BrowserWindow,
  spawn,
  createConnection: net.createConnection,
  fs,
  path,
  url,
  allowInternalDocument: file => localResourceServer.allowInternalDocument(file),
  getMainWindow: () => mainWin,
  supported: () => mpvEmbeddingSupported(process.platform),
  findExecutable: () => detectNativeTool('mpv', {
    moduleDir: __dirname,
    resourcesPath: process.resourcesPath,
    homeDir: os.homedir(),
  }).path,
  ensureTmp,
  tmpDir: TMP,
  tempFiles,
  guideHtml: MPV_GUIDE_HTML,
  fontsDir: fontsRoot,
  onEvent: message => safeWinSend(mainWin, 'mpv:event', message),
  log: (...args) => console.error(...args),
});

ipcMain.handle('mpv:detect', () => {
  const supported = mpvEmbeddingSupported(process.platform);
  const exe = mpvHost.detect();
  console.error('[mpv] detect ->', exe || (supported ? '(not found)' : `(disabled on ${process.platform})`));
  return { available: !!exe, supported, exe };
});

ipcMain.handle('mpv:launch', async (event, request = {}) => {
  const src = request?.src;
  if (typeof src !== 'string' || !src) throw new Error('mpv：來源路徑無效');
  requireReadablePath('mpv:launch', src);
  /* 專案載入的來源也要更新「最近使用資料夾」，但檔案能力仍只由可信入口授予。 */
  rememberDir('media', src);
  return mpvHost.launch(request);
});
ipcMain.handle('mpv:setBounds', (event, bounds) => mpvHost.setBounds(bounds));
ipcMain.handle('mpv:show', (event, value) => mpvHost.setVisible(value));
ipcMain.handle('mpv:setGuide', (event, guide) => mpvHost.setGuide(guide));
ipcMain.handle('mpv:setImageGuide', (event, data) => mpvHost.setImageGuide(data));

/* 只有主 renderer 可以改監看水印；透明 guide 自己永遠沒有這個能力。 */
ipcMain.handle('mpv:setTimecodeWatermark', (event, payload) => {
  if (!mainWin || mainWin.isDestroyed() || event.sender !== mainWin.webContents) return false;
  return mpvHost.setTimecodeWatermark(payload);
});
ipcMain.handle('mpv:clearTimecodeWatermark', event => {
  if (!mainWin || mainWin.isDestroyed() || event.sender !== mainWin.webContents) return false;
  return mpvHost.clearTimecodeWatermark();
});

ipcMain.handle('mpv:subSet', (event, assText) => mpvHost.setSubtitles(assText));
ipcMain.handle('mpv:subVisible', (event, value) => mpvHost.setSubVisible(value));
ipcMain.handle('mpv:loadfile', async (event, filePath) => {
  if (!fileAuthority.canRead(filePath)) { console.warn('[sec] mpv loadfile blocked:', filePath); return null; }
  return mpvHost.loadFile(filePath);
});
ipcMain.handle('mpv:seek', (event, time, options) => mpvHost.seek(time, { exact: options?.exact === true }));
ipcMain.handle('mpv:screenshot', (event, filePath) => {
  if (!fileAuthority.canWriteScreenshot(filePath)) { console.warn('[sec] mpv:screenshot blocked (bad ext):', filePath); return null; }
  fileAuthority.grantTemporaryScreenshotRead(filePath);
  return mpvHost.screenshot(filePath);
});
ipcMain.handle('mpv:play', () => mpvHost.play());
ipcMain.handle('mpv:pause', () => mpvHost.pause());
ipcMain.handle('mpv:direction', (event, value) => mpvHost.direction(value));
ipcMain.handle('mpv:mute', (event, value) => mpvHost.mute(value));
ipcMain.handle('mpv:rate', (event, value) => mpvHost.rate(value));
ipcMain.handle('mpv:brightness', (event, value) => mpvHost.brightness(value));
ipcMain.handle('mpv:quit', () => mpvHost.quit());
/* ===== 字幕比對視窗 =====
   比對規則與 revision 住在 renderer 的 SubtitleCompareSession；本檔只做受限 IPC adapter。 */
function openCompareWindow(payload) {
  if (compareWin && !compareWin.isDestroyed()) {
    if (compareWin.isMinimized()) compareWin.restore();
    compareWin.show();
    compareWin.focus();
    compareWin.webContents.send('compare:update-data', payload);
    return;
  }
  compareWin = new BrowserWindow({
    width: 1200,
    height: 700,
    minWidth: 800,
    minHeight: 500,
    title: '字幕比對',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'compare-preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  compareWin.setMenu(null);
  const compareDocument = path.join(__dirname, 'compare.html');
  localResourceServer.allowInternalDocument(compareDocument);
  compareWin.loadFile(compareDocument);
  compareWin.webContents.once('did-finish-load', () => {
    compareWin.webContents.send('compare:update-data', payload);
  });
  compareWin.on('closed', () => {
    compareWin = null;
    safeWinSend(mainWin, 'compare:closed');
  });
}

function isMainCompareSender(event) {
  return !!(mainWin && !mainWin.isDestroyed() && event?.sender === mainWin.webContents);
}

function isCompareWindowSender(event) {
  return !!(compareWin && !compareWin.isDestroyed() && event?.sender === compareWin.webContents);
}

ipcMain.on('open-compare-window', (event, payload) => {
  if (!isMainCompareSender(event)) return;
  openCompareWindow(payload);
});

ipcMain.on('compare:command', (event, command) => {
  if (!isCompareWindowSender(event) || !command || typeof command !== 'object') return;
  safeWinSend(mainWin, 'compare:command', command);
});

ipcMain.on('sync-compare-window', (event, payload) => {
  if (!isMainCompareSender(event)) return;
  if (compareWin && !compareWin.isDestroyed()) {
    compareWin.webContents.send('compare:update-data', payload);
  }
});
