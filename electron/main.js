/* ==============================================================================
   SUB Tool — Module Architecture Protection ("electron/main.js")
   ==============================================================================
   【維護鐵律】本檔案已納入全專案終極防禦網。
   所有修改必須遵循專案的單向資料流與職責分離原則，嚴禁在此實作越權的 DOM 操作或狀態覆寫。
============================================================================== */
/* SUB Tool — Electron 主程序
   提供：原生檔案對話框、平台原生 ffmpeg/ffprobe（MXF 轉檔、多音軌抽取、波形）、
         專案/字幕直接讀寫磁碟。前端沿用同一份 index.html。 */
const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
/* 非同步 fs。原生檔案對話框（dialog.showOpenDialog）的訊息迴圈就跑在主行程的
   UI 執行緒上，所以這條執行緒上的每一次同步 I/O 都會讓對話框跟著頓——包含
   「在對話框裡切換資料夾」。素材放在 SMB 網路磁碟時一次 statSync 可能要數十毫秒，
   而快取【優先寫在影片旁邊】（見 cacheCandidates），所以那些 stat 也打在網路上。
   會週期性執行的路徑一律改用這個。 */
const fsp = require('fs/promises');
const os = require('os');
const url = require('url');
const net = require('net');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const QueueStore = require('./queue-store');
const QueueHistory = require('./queue-history');
const { ExportQueueState } = require('./export-queue-state');
const ExportLease = require('./export-lease');
const ExportWatchdog = require('./export-watchdog');
const { FileAuthority, collectProjectMediaPathsFromBuffer } = require('./file-authority');
const { isPathContained } = require('./export-name-safety');
const { createIpcGuards, expectedExportExtension } = require('./ipc-guards');
const { buildAudioIngestPlan } = require('./channel-layout');
const { JOB_STATUS, isLiveWork, isRetryable, reservesOutput } = require('./export-job-status');
const { createExportAdmission } = require('./export-admission');
const { createExportQueue } = require('./export-queue');
const RecentProjects = require('./recent-projects');
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
const { FFmpegOutputParser, FFmpegErrorAnalyzer } = require('./ffmpeg-parser');
const { buildIngestArgs } = require('./ffmpeg-pipeline-builder');

let mainWin = null;
let _allowMainWindowClose = false;
let _allowQueueWindowClose = false;
let _isAppQuitting = false;
let _mainHiddenForQueue = false;
let _quitReady = false;
let _quitSequenceStarted = false;
let FFMPEG = null, FFPROBE = null, VENC = null, CACHE = null;
let FFMPEG_DETECTION = null, FFPROBE_DETECTION = null;
const TMP = path.join(os.tmpdir(), 'subtool_cache');
const tempFiles = new Set();
let tmpSeq = 0;
let _currentIngestProc = null; // S1: 追蹤目前執行中的 ingest ffmpeg，換檔時強制 kill
const activeJobs = new Map();

/* S1：唯一的 IPC 檔案能力權威。
   renderer 路徑不會因 fs:fileURL／stat 等查詢被靜默升格；只接受原生對話框、OS 開檔、
   preload 驗證過的拖放 File 與內部快取。專案內已宣告的媒體則只給「那一個檔案」的唯讀能力。 */
const fileAuthority = new FileAuthority({ internalDirectories: [TMP] });

function grantTrustedProjectFile(projectFile, contents) {
  if (typeof projectFile !== 'string' || !projectFile) return;
  fileAuthority.grantProjectFile(projectFile);
  let projectBuffer = contents;
  if (!Buffer.isBuffer(projectBuffer)) {
    try { projectBuffer = fs.readFileSync(projectFile); } catch (error) { projectBuffer = null; }
  }
  for (const mediaPath of collectProjectMediaPathsFromBuffer(projectBuffer)) fileAuthority.grantTrustedFile(mediaPath);
}

/* 三個守衛與 expectedExportExtension 的實作在 ipc-guards.js（可獨立測試，
   不需要整個 Electron 主行程）；這裡只建立跟 fileAuthority 綁定的實例。 */
const { requireReadablePath, requirePermittedShellOpenPath, requirePermittedDeliveryRevealPath, requirePermittedSourceRevealPath } = createIpcGuards(fileAuthority);
/* S5：不可猜測的串流 job id（取代 Date.now() / 可推導的 cacheKey） */
function newJobId(prefix) { return prefix + crypto.randomBytes(12).toString('hex'); }

function ensureTmp() { try { fs.mkdirSync(TMP, { recursive: true }); } catch (e) {} }
function tmpPath(ext) { ensureTmp(); const p = path.join(TMP, `t${Date.now()}_${tmpSeq++}.${ext}`); tempFiles.add(p); return p; }
/* WebContents 可能在視窗關閉後仍被呼叫（例如 mpv pipe close 回呼），必須先確認未銷毀 */
function safeSend(wc, ch, data) {
  try { if (wc && !wc.isDestroyed()) wc.send(ch, data); } catch (e) {}
}
function safeWinSend(win, ch, data) {
  try { if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) win.webContents.send(ch, data); } catch (e) {}
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


/* ---- 媒體快取鍵：檔名 + 大小 + 前 1MB 內容雜湊（不含修改時間，跨電腦可共用快取） ---- */
function cacheKeyFor(src) {
  try {
    const s = fs.statSync(src);
    const readLen = Math.min(1024 * 1024, s.size);
    const h = crypto.createHash('sha1').update(path.basename(src) + '|' + s.size + '|');
    if (readLen > 0) {
      const fd = fs.openSync(src, 'r');
      try { const buf = Buffer.alloc(readLen); fs.readSync(fd, buf, 0, readLen, 0); h.update(buf); }
      finally { fs.closeSync(fd); }
    }
    return h.digest('hex').slice(0, 16);
  } catch (e) { return crypto.createHash('sha1').update(path.basename(String(src))).digest('hex').slice(0, 16); }
}
/* 候選快取目錄：優先放在影片旁的 .subtool_Cache/<金鑰>（可隨檔案被其他電腦讀取），
   其次才用 userData/mediacache。讀取時依序找第一個有效的；寫入時找第一個可寫的。 */
function cacheCandidates(src) {
  const key = cacheKeyFor(src);
  const list = [];
  try { const vdir = path.dirname(src); if (vdir && vdir !== '.') list.push(path.join(vdir, '.subtool_Cache', key)); } catch (e) {}
  list.push(path.join(CACHE || TMP, key));
  return list;
}
/* meta.json 內只存相對檔名（ch0.m4a 等）；讀取時依實際所在目錄解析成絕對路徑，確保跨電腦可用 */
function resolveMeta(raw, dir) {
  const r = (f) => f ? path.join(dir, path.basename(f)) : f;
  return {
    proxy: r(raw.proxy), wave: r(raw.wave),
    channels: (raw.channels || []).map(c => ({
      label: c.label, file: r(c.file),
      // v4.36 前的快取沒有這兩個欄位；保留 null 以便呼叫端安全地要求重建，
      // 不可猜成 stream 0，否則含多個 audio stream 的舊檔會被錯誤路由。
      sourceStream: Number.isInteger(c.sourceStream) && c.sourceStream >= 0 ? c.sourceStream : null,
      sourceChannel: Number.isInteger(c.sourceChannel) && c.sourceChannel >= 0 ? c.sourceChannel : null,
    }))
  };
}
function metaToStore(meta) {
  const b = (f) => f ? path.basename(f) : f;
  return {
    proxy: b(meta.proxy), wave: b(meta.wave),
    channels: (meta.channels || []).map(c => ({
      label: c.label, file: b(c.file),
      sourceStream: Number.isInteger(c.sourceStream) ? c.sourceStream : null,
      sourceChannel: Number.isInteger(c.sourceChannel) ? c.sourceChannel : null,
    }))
  };
}
function hasRoutingMetadata(meta) {
  return (meta.channels || []).every(c => Number.isInteger(c.sourceStream) && c.sourceStream >= 0 && Number.isInteger(c.sourceChannel) && c.sourceChannel >= 0);
}
/* 原子寫入 meta.json（先寫 .tmp 再 rename），避免中途被中斷留下半寫入的損毀清單 */
function writeMeta(metaPath, meta) {
  try { const tmp = metaPath + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(metaToStore(meta))); fs.renameSync(tmp, metaPath); } catch (e) {}
}
/* 匯出端也要自行守住「母素材」界線，不能只相信 renderer。生成的 preview 檔固定是
   cache 目錄內的 proxy.mp4 / chN.m4a；同名的使用者原始檔不在 cache 目錄則仍可正常匯入。 */
function isPreviewCacheMedia(file) {
  if (typeof file !== 'string' || !file) return false;
  let resolved;
  try { resolved = path.resolve(file); } catch (e) { return false; }
  const base = path.basename(resolved).toLowerCase();
  if (base !== 'proxy.mp4' && !/^ch\d+\.m4a$/i.test(base)) return false;
  const lower = resolved.toLowerCase();
  const isCacheRoot = [CACHE, TMP].filter(Boolean).some(root => {
    try {
      const cacheRoot = path.resolve(root).toLowerCase();
      return lower === cacheRoot || lower.startsWith(cacheRoot + path.sep);
    } catch (e) { return false; }
  });
  return isCacheRoot || lower.split(path.sep).includes('.subtool_cache');
}
/* 鐵律 §0.8 的守門員。規則本身在 export-admission.js（可測），這裡只是轉呼叫，
   保留原名讓既有呼叫端不動。_admission 在下方建立；本函式的呼叫點都在那之後。 */
function assertMasterExportMedia(file, kind) {
  return _admission.assertMasterMedia(file, kind);
}
function metaValid(m) {
  return (!m.proxy || fs.existsSync(m.proxy)) && (m.channels || []).every(c => fs.existsSync(c.file)) && (!m.wave || fs.existsSync(m.wave));
}
/* 讀取快取：回傳第一個檔案完整的 {dir, meta}，否則 null */
function readCache(src) {
  for (const dir of cacheCandidates(src)) {
    const metaPath = path.join(dir, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      const m = resolveMeta(JSON.parse(fs.readFileSync(metaPath, 'utf8')), dir);
      if (metaValid(m)) {
        fileAuthority.grantManagedCacheDirectory(dir);
        return { dir, meta: m, routingMetadataComplete: hasRoutingMetadata(m) };
      }
    } catch (e) {}
  }
  return null;
}
function isDirWritable(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); const t = path.join(dir, '.wtest_' + process.pid); fs.writeFileSync(t, 'x'); fs.unlinkSync(t); return true; }
  catch (e) { return false; }
}
/* 取得可寫的快取目錄（優先影片旁的 .subtool_Cache）。 */
function writeCacheDir(src) {
  for (const dir of cacheCandidates(src)) {
    if (isDirWritable(dir)) {
      fileAuthority.grantManagedCacheDirectory(dir);
      return dir;
    }
  }
  const fallback = path.join(CACHE || TMP, cacheKeyFor(src));
  fileAuthority.grantManagedCacheDirectory(fallback);
  return fallback;
}
/* ---- 快取管理：統計 / 清孤兒 / 全清 ---- */
function dirSize(dir) {
  let total = 0;
  try { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) total += dirSize(p); else { try { total += fs.statSync(p).size; } catch (e) {} } } } catch (e) {}
  return total;
}
function cacheInfo() {
  const root = CACHE || TMP; let folders = 0, bytes = 0;
  try { for (const f of fs.readdirSync(root, { withFileTypes: true })) { if (f.isDirectory()) { folders++; bytes += dirSize(path.join(root, f.name)); } } } catch (e) {}
  return { root, folders, bytes };
}
/* 移除無效（缺 meta.json 或所引用檔案已不存在）的快取資料夾 */
function cleanOrphans() {
  const root = CACHE || TMP; let removed = 0, bytes = 0;
  try {
    for (const f of fs.readdirSync(root, { withFileTypes: true })) {
      if (!f.isDirectory()) continue;
      const dir = path.join(root, f.name), metaPath = path.join(dir, 'meta.json');
      // 只刪除「確定無效」的：沒有 meta.json，或 meta 能解析但引用的檔案已不存在。
      // meta.json 存在但解析失敗（可能是中途中斷的半寫入）→ 保留，下次再判斷，避免誤刪整份有效快取。
      let remove = false;
      if (!fs.existsSync(metaPath)) remove = true;
      else { try { if (!metaValid(resolveMeta(JSON.parse(fs.readFileSync(metaPath, 'utf8')), dir))) remove = true; } catch (e) { remove = false; } }
      if (remove) { const sz = dirSize(dir); try { fs.rmSync(dir, { recursive: true, force: true }); removed++; bytes += sz; } catch (e) {} }
    }
  } catch (e) {}
  return { removed, bytes };
}
function clearAllCache(currentSrc) {
  const root = CACHE || TMP; let bytes = dirSize(root);
  try { fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true }); } catch (e) {}
  // 影片旁快取只能依已取得 read capability 的母素材推導；renderer 傳入的任意
  // currentSrc 不得變成刪除同層 .subtool_Cache 的能力。
  if (currentSrc && fileAuthority.canRead(currentSrc)) {
    try { const ndir = path.join(path.dirname(currentSrc), '.subtool_Cache', cacheKeyFor(currentSrc)); if (fs.existsSync(ndir)) { bytes += dirSize(ndir); fs.rmSync(ndir, { recursive: true, force: true }); } } catch (e) {}
  } else if (currentSrc) console.warn('[sec] cache clear source blocked:', currentSrc);
  return { bytes };
}

/* S2: 有 GPU 編碼器時啟用來源端硬體解碼（加速讀取 4K/MXF），對 -i 前插入 */
function hwdecArgs() { return VENC && VENC !== 'libx264' ? ['-hwaccel', 'auto'] : []; }

function exportWatchdogScriptPath() {
  const localPath = path.join(__dirname, 'export-watchdog.js');
  if (!app.isPackaged) return localPath;
  const unpackedPath = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'electron',
    'export-watchdog.js',
  );
  return fs.existsSync(unpackedPath) ? unpackedPath : localPath;
}

/* ---- 執行 ffmpeg，並回報進度 ----
   交付匯出改由獨立 watchdog 持有 ffmpeg；主程序被強制結束時 IPC disconnect 仍會觸發
   子程序清理。Proxy／ingest 等短期工作維持原本直接 spawn，縮小變更面。 */
function runFF(args, { onProgress, duration, sender, jobId, label, onProcess, cwd, outPath } = {}) {
  return new Promise((res, rej) => {
    if (!FFMPEG) return rej(new Error('找不到 ffmpeg'));
    let err = '';       // 尾端（錯誤訊息用；會被截斷）
    const maps = [];    // 串流對應行（出現在輸出開頭，需單獨保留，否則被 err 截斷丟失）
    const isQueueExport = typeof jobId === 'string' && jobId.startsWith('export-') && EXPORT_QUEUE_DIR;
    if (isQueueExport) ensureExportQueueDir();
    if (isQueueExport && (typeof outPath !== 'string' || !outPath)) {
      return rej(new Error('匯出 watchdog 缺少輸出路徑'));
    }
    const logPath = isQueueExport
      ? QueueStore.logPath(EXPORT_QUEUE_DIR, jobId)
      : path.join(app.getPath('userData'), `export-${Date.now()}-${jobId || 'task'}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: isQueueExport ? 'w' : 'a' });
    let logError = null;
    logStream.on('error', error => {
      logError = error;
      console.error(`[Queue] 無法寫入 ffmpeg 記錄 ${logPath}：`, error);
    });
    const writeLog = data => {
      if (logError) return;
      try { logStream.write(data); } catch (error) { logError = error; }
    };
    let logFinishPromise = null;
    const finishLog = () => {
      if (logFinishPromise) return logFinishPromise;
      logFinishPromise = new Promise(resolve => {
        if (logError || logStream.writableFinished || logStream.destroyed) {
          resolve();
          return;
        }
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, 1000);
        logStream.once('finish', done);
        logStream.once('error', done);
        try { logStream.end(); } catch (error) { done(); }
      });
      return logFinishPromise;
    };
    writeLog(`> ffmpeg ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}\n\n`);

    const startTime = Date.now();
    const parser = new FFmpegOutputParser(duration);
    
    const consumeStderr = d => {
      const s = d.toString();
      writeLog(s);
      err += s; if (err.length > 8000) err = err.slice(-8000);

      const progData = parser.parseChunk(s);
      if (progData && (sender || onProgress)) {
        const payload = { jobId, label, pct: progData.pct, etaS: progData.etaS, elapsedMs: Date.now() - startTime };
        if (sender) safeSend(sender, 'task-progress', payload);
        if (onProgress) onProgress(payload);
      }
    };

    let watchdogFailure = null;
    let settled = false;
    const finishProcess = async (code, watchdogResult = null) => {
      if (settled) return;
      settled = true;
      await finishLog();
      if (sender) safeSend(sender, 'task-progress', { jobId, label, pct: 100, done: true });
      if (code === 0 && (!watchdogResult || watchdogResult.ok)) {
        fs.unlink(logPath, () => {});
        res({ tail: err, maps: parser.maps });
        return;
      }

      let fullLog = err;
      try { fullLog = fs.readFileSync(logPath, 'utf8'); } catch (readError) {
        if (logError) fullLog += `\n\n[無法寫入完整記錄：${logError.message || logError}]`;
      }
      
      const { summary, errorCode } = FFmpegErrorAnalyzer.analyze(fullLog, code, watchdogFailure, watchdogResult, outPath);
      
      const failure = new Error(`[LOG_PATH]${logPath}[/LOG_PATH]ffmpeg 結束碼 ${code}\n${summary}`);
      failure.code = errorCode;
      failure.watchdogResult = watchdogResult;
      rej(failure);
    };

    if (isQueueExport) {
      const controller = ExportWatchdog.spawnExportWatchdog({
        ffmpegPath: FFMPEG,
        args,
        cwd,
        outPath,
        jobId,
        queueDir: EXPORT_QUEUE_DIR,
      }, {
        scriptPath: exportWatchdogScriptPath(),
        onStderr: consumeStderr,
        onMessage: message => {
          if (message?.type === 'error' && !watchdogFailure) watchdogFailure = message;
        },
      });
      controller.ready.catch(() => {});
      if (onProcess) onProcess(controller);
      controller.completion.then(result => {
        const code = result.ok ? 0 : (Number.isInteger(result.code) ? result.code : 1);
        return finishProcess(code, result);
      }).catch(error => {
        watchdogFailure ||= error;
        return finishProcess(1, { ok: false, startupError: true });
      });
      return;
    }

    const p = spawn(FFMPEG, args, cwd ? { cwd } : {});
    if (onProcess) onProcess(p);
    p.stderr.on('data', consumeStderr);
    p.on('error', async error => {
      if (settled) return;
      settled = true;
      await finishLog();
      rej(error);
    });
    p.on('close', code => finishProcess(code));
  });
}

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
      webSecurity: false // 本機信任程式：允許 file:// 影音直接讀取
    }
  });
  mainWin = win;
  // 移除 Electron 預設的 File / Edit / View 系統選單列。autoHideMenuBar
  // 只會暫時隱藏它，按 Alt 仍會再次出現；這裡直接解除視窗選單並關閉
  // Alt 的選單列顯示行為，避免干擾程式既有的快捷鍵操作。
  win.setMenu(null);
  win.setAutoHideMenuBar(false);
  win.setMenuBarVisibility(false);
  win.maximize();
  // 讓嵌入式 mpv 覆蓋視窗跟著主視窗移動 / 縮放 / 最小化
  const reapplyMpv = () => { if (_mpvWin && !_mpvWin.isDestroyed() && _mpvVisible && _mpvRect) applyMpvBounds(_mpvRect); };
  win.on('move', reapplyMpv);
  win.on('resize', reapplyMpv);
  win.on('restore', () => { if (_mpvWin && !_mpvWin.isDestroyed() && _mpvVisible) { try { _mpvWin.show(); } catch (e) {} reapplyMpv(); showMpvGuide(); } });
  win.on('minimize', () => {
    if (_mpvWin && !_mpvWin.isDestroyed()) { try { _mpvWin.hide(); } catch (e) {} }
    if (_mpvGuideWin && !_mpvGuideWin.isDestroyed()) { try { _mpvGuideWin.hide(); } catch (e) {} }
  });
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
    destroyMpvWin();
  });
  // S2：補齊 Electron 安全基線 — 拒絕開新視窗、限制導航只能停在本機應用頁（與 dev 的 localhost）
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (ev, u) => {
    if (!(u.startsWith('file:') || u.startsWith('http://localhost:8777'))) ev.preventDefault();
  });
  win.webContents.once('did-finish-load', () => {
    try { QueueManager.notifyChanged(); } catch (e) {}
  });
  if (process.argv.includes('--dev')) {
    win.loadURL('http://localhost:8777'); // 需先執行 npm run dev
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    const built = path.join(__dirname, '..', 'dist', 'index.html');
    const legacy = path.join(__dirname, '..', 'index.html');
    win.loadFile(fs.existsSync(built) ? built : legacy);
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
  if (_mpvWin && !_mpvWin.isDestroyed() && _mpvVisible) {
    try { _mpvWin.show(); } catch (e) {}
    if (_mpvRect) applyMpvBounds(_mpvRect);
    showMpvGuide();
  }
  return true;
}

function hideMainWindow() {
  if (!mainWin || mainWin.isDestroyed()) return false;
  if (_mpvWin && !_mpvWin.isDestroyed()) { try { _mpvWin.hide(); } catch (e) {} }
  if (_mpvGuideWin && !_mpvGuideWin.isDestroyed()) { try { _mpvGuideWin.hide(); } catch (e) {} }
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
  if (_queueState.liveWorkCount() > 0) {
    openQueueWindow();
    return hideMainWindow();
  }
  _allowMainWindowClose = true;
  try { mainWin.close(); } finally { _allowMainWindowClose = false; }
  return true;
});

ipcMain.handle('app:showMainWindow', () => showMainWindow());

/* ---- 本機 HTTP 串流伺服器（MXF 等非原生格式邊轉邊播用） ---- */
let _hSrv = null, _hPort = null;
const _hJobs = new Map(); // id -> { filePath, done, error }

async function ensureHttpServer() {
  if (_hSrv) return _hPort;
  return new Promise((resolve, reject) => {
    _hSrv = http.createServer((req, res) => {
      const id = decodeURIComponent(req.url.slice(1).split('?')[0]);
      const job = _hJobs.get(id);
      if (!job || !job.filePath) { res.writeHead(404); res.end(); return; }
      const rf = req.headers.range;
      if (!rf) {
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
        const rd = fs.createReadStream(job.filePath);
        rd.pipe(res, { end: false });
        rd.on('end', () => {
          if (job.done) { res.end(); return; }
          const poll = () => { if (job.done || job.error) { res.end(); } else { setTimeout(poll, 400); } };
          poll();
        });
        req.on('close', () => rd.destroy());
        return;
      }
      const m = /bytes=(\d+)-(\d*)/.exec(rf);
      if (!m) { res.writeHead(400); res.end(); return; }
      const start = +m[1], reqEnd = m[2] ? +m[2] : undefined;
      /* 非同步：邊轉邊播時 <video> 會對還沒寫完的 proxy 發 range 請求，這裡每 500ms
         重試一次、最多 120 次（＝每個請求最長輪詢 60 秒），而且同時可能有多個請求在輪詢。
         同步 stat 打在 SMB 上的 proxy，會讓主行程的 UI 執行緒被反覆鎖住，
         原生檔案對話框（訊息迴圈在同一條執行緒）因此卡頓。 */
      const tryRange = async (n) => {
        let sz = 0; try { sz = (await fsp.stat(job.filePath)).size; } catch (e) {}
        if (sz <= start && !job.done && n < 120) { setTimeout(() => { void tryRange(n + 1); }, 500); return; }
        if (sz <= start) { res.writeHead(416); res.end(); return; }
        const end = reqEnd !== undefined ? Math.min(reqEnd, sz - 1) : sz - 1;
        const len = end - start + 1;
        res.writeHead(206, {
          'Content-Type': 'video/mp4',
          'Content-Range': `bytes ${start}-${end}/${job.done ? sz : '*'}`,
          'Content-Length': len, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' // S5
        });
        fs.createReadStream(job.filePath, { start, end }).pipe(res);
      };
      /* 非同步之後回傳的是 Promise；沒接住的 rejection 在 Electron 會炸掉整個主行程。 */
      void tryRange(0).catch(err => {
        console.error('[HTTP] range 供應失敗：', err);
        try { if (!res.headersSent) { res.writeHead(500); res.end(); } } catch (e) {}
      });
    });
    _hSrv.listen(0, '127.0.0.1', () => { _hPort = _hSrv.address().port; resolve(_hPort); });
    _hSrv.on('error', reject);
  });
}

let startupFile = null;
app.on('open-file', (e, path) => {
  e.preventDefault();
  startupFile = path;
  grantTrustedProjectFile(path);
  if (mainWin && !mainWin.isDestroyed()) {
    /* 主視窗還活著＝app 早就 ready，寫設定檔是安全的。還沒 ready 的情況不寫，
       交給下面的 app:getStartupFile（renderer 起來後才會呼叫）補記。 */
    rememberRecentProject(path);
    safeWinSend(mainWin, 'app:open-file', path);
  }
});

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    const hadLiveMainWindow = !!(mainWin && !mainWin.isDestroyed());
    const fileArg = commandLine.find(a => !a.startsWith('-') && (a.endsWith('.subtool') || a.endsWith('.json')));
    if (fileArg) {
      startupFile = fileArg;
      grantTrustedProjectFile(fileArg);
    }
    if (!app.isReady()) return;
    if (fileArg) rememberRecentProject(fileArg);
    if (showMainWindow() && fileArg && hadLiveMainWindow) {
      safeWinSend(mainWin, 'app:open-file', fileArg);
    }
  });

  app.whenReady().then(async () => {
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
    VENC = detectVideoEncoder();
    CACHE = path.join(app.getPath('userData'), 'mediacache');
    fileAuthority.grantInternalDirectory(CACHE);
    EXPORT_QUEUE_DIR = path.join(app.getPath('userData'), 'export-queue');
    fileAuthority.grantQueueLogDirectory(EXPORT_QUEUE_DIR);
    try { fs.mkdirSync(CACHE, { recursive: true }); } catch (e) {}
    try { cleanOrphans(); } catch (e) {} // 啟動時自動清除無效快取（例如上次轉檔中斷的孤兒資料夾）
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
    .then(() => QueueManager.prepareForShutdown())
    .catch(e => { console.error('[Queue] 無法保存關閉前狀態：', e); })
    .finally(() => {
      _quitReady = true;
      app.quit();
    });
});
app.on('quit', () => {
  if (_mpvProc) { try { _mpvProc.kill(); } catch (e) {} _mpvProc = null; }
  for (const f of tempFiles) { try { fs.unlinkSync(f); } catch (e) {} }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});

/* ============ IPC ============ */
ipcMain.handle('app:getStartupFile', () => {
  let fileToOpen = null;
  if (startupFile) fileToOpen = startupFile;
  else if (process.platform === 'win32' || process.platform === 'linux') {
    const args = process.argv.slice(app.isPackaged ? 1 : 2);
    const fileArg = args.find(a => !a.startsWith('-') && (a.endsWith('.subtool') || a.endsWith('.json')));
    if (fileArg) fileToOpen = fileArg;
  }
  if (fileToOpen) {
    grantTrustedProjectFile(fileToOpen);
    /* 從 Explorer 雙擊 .subtool 開起來的專案也算「開過」。少了這一行，
       只有走「開啟專案」對話框的才會進最近開啟清單——而雙擊才是最常用的那條路。 */
    rememberRecentProject(fileToOpen);
    return fileToOpen;
  }
  return null;
});

ipcMain.handle('app:openPath', async (e, p) => {
  const { shell } = require('electron');
  requirePermittedShellOpenPath(p);
  return shell.openPath(p);
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
    return activeJobs.has(requestedJobId) ? stopQueueJob(requestedJobId) : false;
  }
  const activeJobIds = Array.from(activeJobs.keys());
  const latestJobId = activeJobIds[activeJobIds.length - 1];
  return latestJobId ? stopQueueJob(latestJobId) : false;
});
ipcMain.handle('app:status', () => ({
  isDesktop: true, ffmpeg: !!FFMPEG, ffprobe: !!FFPROBE,
  ffmpegPath: FFMPEG, ffprobePath: FFPROBE, venc: VENC,
  platform: process.platform, arch: process.arch,
  ffmpegDetection: FFMPEG_DETECTION, ffprobeDetection: FFPROBE_DETECTION,
}));

ipcMain.handle('fs:fileURL', (e, p) => {
  if (!fileAuthority.canExposeFileURL(p)) { console.warn('[sec] fileURL blocked:', p); return null; }
  try { return url.pathToFileURL(p).href; } catch (err) { return null; }
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

ipcMain.handle('fs:authorizeProject', (e, { path: p, b64 }) => {
  grantTrustedProjectFile(p, Buffer.from(b64, 'base64'));
  return true;
});
ipcMain.handle('fs:findRelinkTarget', async (e, { projectPath, oldMediaPath }) => {
  if (!projectPath || !oldMediaPath) return null;
  if (!fileAuthority.canRead(projectPath)) return null;
  
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
  if (typeof p !== 'string' || !p) return null;
  fileAuthority.grantTrustedFile(p, { read: true, write: false });
  fileAuthority.grantScreenshotDirectory(path.dirname(p));
  return p;
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




ipcMain.handle('dialog:openMedia', async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: '匯入影片或音訊檔', properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '影音或圖片', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'mxf', 'avi', 'm2ts', 'mts', 'ts', 'wmv', 'webm', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'aif', 'aiff', 'jpg', 'jpeg', 'png'] },
      { name: '全部', extensions: ['*'] }
    ]
  });
  if (r.canceled) return null;
  r.filePaths.forEach(p => {
    fileAuthority.grantTrustedFile(p, { read: true, write: false });
    fileAuthority.grantScreenshotDirectory(path.dirname(p));
  });
  // 保持單選時的舊字串回傳值，讓專案遺失主影片的既有重選流程可無修改地繼續使用。
  return r.filePaths.length===1 ? r.filePaths[0] : r.filePaths;
});
ipcMain.handle('dialog:openAudio', async () => {
  const r = await dialog.showOpenDialog(mainWin, {
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
    return RecentProjects.sanitize(JSON.parse(fs.readFileSync(p, 'utf8'))?.recentProjects);
  } catch (e) { return []; }
}

function saveRecentProjects(list) {
  try {
    const p = getConfigPath();
    const current = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
    fs.writeFileSync(p, JSON.stringify({ ...current, recentProjects: list }, null, 2), 'utf8');
  } catch (e) { console.error('[recent] save err', e); }
}

function rememberRecentProject(filePath) {
  saveRecentProjects(RecentProjects.addRecent(loadRecentProjects(), filePath, { now: Date.now() }));
}

/* 規則與逾時政策在 recent-projects.js（那裡有完整說明並附測試）；
   這裡只負責把真正的 fs 接上去。用 fsp 而不是 fs：清單裡常有 SMB 路徑，
   同步 stat 會連同原生檔案對話框一起凍住主行程的 UI 執行緒。 */
const recentProjectMissing = RecentProjects.createMissingProbe({ stat: fsp.stat });

/* 清單本身不含能力授予——只是給選單顯示用。
   `missing` 讓選單可以把已經不在的檔案標灰，而不是讓使用者點了才失敗。 */
ipcMain.handle('project:recentList', async () => {
  const list = loadRecentProjects();
  /* 一起探測，不要一筆一筆等——10 筆各 400ms 逾時串起來就是 4 秒。 */
  const missing = await Promise.all(list.map(item => recentProjectMissing(item.path)));
  return list.map((item, index) => ({
    index,
    name: item.name || path.basename(item.path),
    path: item.path,
    at: item.at || 0,
    missing: missing[index],
  }));
});

/* renderer 只送【索引】，路徑由主程序自己的清單決定——沒有路徑注入空間。
   讀取前才授予那一個檔案的能力（fileAuthority 是每次工作階段的）。 */
ipcMain.handle('project:openRecent', (e, index) => {
  const list = loadRecentProjects();
  const item = list[Math.trunc(Number(index))];
  if (!item) throw new Error('找不到這筆最近開啟的專案');
  let buf;
  try {
    buf = fs.readFileSync(item.path);
  } catch (error) {
    /* 檔案不見了就從清單移除，免得它一直留在選單裡讓人一再踩空。 */
    saveRecentProjects(RecentProjects.removeRecent(list, item.path));
    throw new Error(`找不到專案檔：${item.path}`);
  }
  grantTrustedProjectFile(item.path, buf);
  rememberRecentProject(item.path); // 移到最前面
  return { path: item.path, b64: buf.toString('base64') };
});

ipcMain.handle('project:clearRecent', () => { saveRecentProjects([]); return true; });

ipcMain.handle('dialog:openProject', async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: '開啟專案', properties: ['openFile'],
    filters: [{ name: 'SUB Tool 專案', extensions: ['subtool', 'json'] }]
  });
  if (r.canceled) return null;
  const buf = fs.readFileSync(r.filePaths[0]);
  grantTrustedProjectFile(r.filePaths[0], buf);
  rememberRecentProject(r.filePaths[0]);
  return { path: r.filePaths[0], b64: buf.toString('base64') };
});
ipcMain.handle('dialog:saveProject', async (e, { name, b64 }) => {
  const r = await dialog.showSaveDialog(mainWin, { title: '儲存專案', defaultPath: name, filters: [{ name: 'SUB Tool 專案', extensions: ['subtool'] }] });
  if (r.canceled) return null;
  fs.writeFileSync(r.filePath, Buffer.from(b64, 'base64'));
  grantTrustedProjectFile(r.filePath, Buffer.from(b64, 'base64'));
  /* 另存新檔也算「開過」——使用者接下來就在編輯它，下次會想從最近開啟找到它。 */
  rememberRecentProject(r.filePath);
  return r.filePath;
});

ipcMain.handle('dialog:importSub', async (e, kind) => {
  const filt = { srt: ['srt'], ass: ['ass', 'ssa'], encore: ['txt'], txt: ['txt'] }[kind] || ['*'];
  const r = await dialog.showOpenDialog(mainWin, { title: '匯入字幕', properties: ['openFile'], filters: [{ name: kind.toUpperCase(), extensions: filt }, { name: '全部', extensions: ['*'] }] });
  if (r.canceled) return null;
  const buf = fs.readFileSync(r.filePaths[0]);
  return { path: r.filePaths[0], b64: buf.toString('base64') };
});
ipcMain.handle('dialog:exportSub', async (e, { name, b64, ext }) => {
  const r = await dialog.showSaveDialog(mainWin, { title: '匯出字幕', defaultPath: name, filters: [{ name: (ext || 'txt').toUpperCase(), extensions: [ext || 'txt'] }] });
  if (r.canceled) return null;
  fs.writeFileSync(r.filePath, Buffer.from(b64, 'base64'));
  return r.filePath;
});
ipcMain.handle('dialog:importFont', async () => {
  const r = await dialog.showOpenDialog(mainWin, { title: '匯入字型', properties: ['openFile'], filters: [{ name: '字型檔', extensions: ['ttf', 'otf', 'woff', 'woff2', 'ttc'] }, { name: '全部', extensions: ['*'] }] });
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
function hasAudioStream(p) {
  try { const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', p], { timeout: 8000 }); return !!(r.stdout && r.stdout.toString().trim()); }
  catch (e) { return true; } // 探測失敗時假設有音訊（較常見）
}
/* 交付檔完成後再用 ffprobe 讀一次，renderer 顯示的是檔案實際寫入的 bitrate，
   不只是在 UI 上宣告的目標值。故使用者可直接確認 MP4 並非沿用 preview AAC cache。 */
function outputAudioBitrates(p) {
  if (!FFPROBE || !p) return [];
  try {
    const r = spawnSync(FFPROBE, [
      '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=bit_rate,channels', '-of', 'json', p
    ], { encoding: 'utf8', timeout: 8000 });
    if (r.status !== 0 || !r.stdout) return [];
    const streams = JSON.parse(r.stdout).streams || [];
    return streams.map(stream => ({
      channels: Math.max(0, Math.floor(_finiteNumber(stream.channels, 0))),
      kbps: Math.max(0, Math.round(_finiteNumber(stream.bit_rate, 0) / 1000))
    }));
  } catch (e) { return []; }
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
const _queueState = new ExportQueueState();
/* 分類的唯一來源在 export-job-status.js */
const OUTPUT_RESERVED_STATUSES = { has: reservesOutput };

function ensureExportQueueDir() {
  if (!EXPORT_QUEUE_DIR) throw new Error('匯出佇列目錄尚未初始化');
  QueueStore.ensureDir(EXPORT_QUEUE_DIR);
}

/* 准入政策（能不能進佇列、需要哪些檔案能力）住在 export-admission.js——
   那四條規則原本散在這裡，與 BrowserWindow／dialog／spawn 糾纏，因此一行測試都沒有，
   而其中一條正是鐵律 §0.8 的守門員（不可拿 proxy.mp4／chNN.m4a 匯出）。
   外部能力全部由這裡注入，本檔只留「接線」。 */
const _admission = createExportAdmission({
  expectedExtensionFor: expectedExportExtension,
  outputKeyFor: outPath => ExportLease.outputKey(outPath),
  mergeSourcePaths: (payload, sourcePaths) => QueueStore.mergeSourcePaths(payload, sourcePaths),
  currentJobs: () => _queueState.jobs(),
  reservesOutput: status => OUTPUT_RESERVED_STATUSES.has(status),
  canReadSource: file => fileAuthority.canRead(file),
  canWriteDelivery: file => fileAuthority.canWriteDelivery(file),
  isPreviewCacheMedia,
});

/* 以下維持原本的名字，呼叫端不動——它們現在只是轉呼叫。 */
const queueOutputKey = job => _admission.outputKey(job);
const assertQueueOutputFormat = job => _admission.assertOutputFormat(job);
const assertQueueOutputAvailable = (job, excludeId) => _admission.assertOutputAvailable(job, excludeId);
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
  queueWin.loadFile(path.join(__dirname, 'queue.html'));
  /* 關掉監控視窗如果會順帶結束整個程式，而且還有工作在轉檔，就先問過使用者。
     這裡不能只看「有沒有在轉檔」——主視窗還開著時，關監控視窗只是收起監控畫面，
     轉檔照跑，這種情況跳確認視窗只會擾民。 */
  queueWin.on('close', (e) => {
    if (_isAppQuitting || _allowQueueWindowClose) return;
    if (!queueWindowCloseEndsApp()) return;
    const liveCount = _queueState.liveWorkCount();
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
const QueueManager = createExportQueue({
  dir: () => EXPORT_QUEUE_DIR,
  state: _queueState,
  store: QueueStore,
  history: QueueHistory,
  JOB_STATUS,
  isLiveWork,
  reservesOutput,
  admission: _admission,
  grantPersistedCapabilities: grantPersistedQueueJobCapabilities,
  canReadSource: file => fileAuthority.canRead(file),
  canWriteDelivery: file => fileAuthority.canWriteDelivery(file),
  isFile: p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } },
  runJob: job => _runJobLogic(job),
  onChanged: () => {
    safeWinSend(mainWin, 'queue:update');
    safeWinSend(mainWin, 'queue-status', queueStatusSnapshot());
    if (queueWin && !queueWin.isDestroyed()) safeWinSend(queueWin, 'queue:update');
  },
  onJobFailed: () => openQueueWindow(), // 失敗時把監控視窗叫出來
  activeJobs,
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

function stopQueueJob(jobId) {
  const job = _queueState.get(jobId);
  if (!job) return false;
  if (job.status === 'running') {
    const active = activeJobs.get(jobId);
    if (active && active.p) {
      active.stopped = true;
      if (typeof active.stop === 'function') {
        try { active.stop('user-stop'); } catch (err) {}
      } else {
        try { active.p.kill(); } catch (err) {}
      }
      _queueState.setStatus(jobId, 'stopping');
    } else {
      return false;
    }
  } else if (job.status === 'queued') {
    _queueState.stop(jobId);
  } else {
    return false;
  }
  try { QueueManager.persistJob(job); } catch (e) {
    console.error(`[Queue] 無法保存工作 ${job.id} 的停止狀態：`, e);
  }
  QueueManager.notifyChanged();
  return true;
}

ipcMain.handle('queue:stopJob', (e, jobId) => {
  return stopQueueJob(jobId);
});

ipcMain.handle('queue:retryJob', (e, jobId) => {
  if (QueueManager.shuttingDown) return false;
  const job = _queueState.get(jobId);
  if (job && isRetryable(job.status)) {
    const previousStatus = job.status;
    const previousError = job.errorMsg;
    if (!QueueManager.validateSources(job)) {
      QueueManager.notifyChanged();
      return;
    }
    try {
      assertQueueOutputAvailable(job);
    } catch (error) {
      job.errorMsg = error.message || String(error);
      QueueManager.notifyChanged();
      return false;
    }
    const retried = _queueState.retry(jobId);
    if (!retried) return false;
    try {
      QueueManager.persistJob(job);
    } catch (e) {
      _queueState.setStatus(jobId, previousStatus, {
        errorMsg: previousError || `無法保存重試工作：${e.message || e}`,
      });
      QueueManager.notifyChanged();
      return false;
    }
    QueueManager.notifyChanged();
    QueueManager.processQueue();
    return true;
  }
  return false;
});

ipcMain.handle('queue:clearJob', (e, jobId) => {
  const job = _queueState.remove(jobId);
  QueueManager.removeArtifacts(job);
  QueueManager.forgetHistory(jobId); // 否則清掉的紀錄下次啟動又會回來
  QueueManager.notifyChanged();
});

ipcMain.handle('queue:clearCompleted', () => {
  const toClear = _queueState.jobs().filter(job => job.status === 'done').map(job => job.id);
  toClear.forEach(id => {
    const job = _queueState.remove(id);
    QueueManager.removeArtifacts(job);
  });
  try { QueueHistory.clear(EXPORT_QUEUE_DIR); } catch (error) {
    console.error('[Queue] 無法清除完成紀錄：', error);
  }
  QueueManager.notifyChanged();
});

ipcMain.handle('queue:reorderJob', (e, jobId, newIndex) => {
  if (!_queueState.reorder(jobId, newIndex)) return;
  QueueManager.persistAll();
  QueueManager.notifyChanged();
});

/* 改變【還沒開始轉檔】的工作的交付格式。

   安全性：renderer 只送 format 字串，**輸出路徑一律由這裡從既有的 outPath 推導**
   （同資料夾、同主檔名、只換副檔名）。renderer 給不了路徑，所以沒有注入空間；
   未知格式由 expectedExportExtension 直接擋掉（fail-closed）。

   為什麼改 payload 就夠：_runJobLogic 是在【執行時】才從 job.payload 重新推導
   format / isWav / isPro / audioPlan / timecodeWatermark 的，不是在入列時凍結的。
   （TC 浮水印在轉成 WAV 時會自動變成 null，因為那條路徑本來就寫 `isWav ? null : …`。） */
ipcMain.handle('queue:updateDelivery', (e, jobId, patch) => {
  const job = _queueState.get(jobId);
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
  _admission.assertOutputAvailable(candidate, jobId); // 排除自己；擋同路徑撞車
  if (newPath !== oldPath) {
    /* 同資料夾、同主檔名，只換副檔名——舊路徑既然已獲授權，新路徑就在同一個
       已授權的範圍內。仍明確授予，避免只授了精確檔名時漏掉。 */
    fileAuthority.grantDeliveryFile(newPath);
  }

  job.payload = nextPayload;
  QueueManager.persistJob(job);
  QueueManager.notifyChanged();
  return { format, outPath: newPath, width: w, height: h, targetH, videoKbps, burnTimecode: !!timecodeWatermark };
});

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
    // [v5.4.4] Update local job state for queue window and broadcast updates
    // 以往進度直接從 runFF 送到前端，導致佇列視窗無法同步。現在必須經由這裡透過 onProgress 攔截，
    // 以確保 QueueManager 能收到進度，並觸發 QueueManager.notifyChanged()。
    if (evt === 'task-progress') {
      if (data.done) {
        job.status = JOB_STATUS.DONE;
        // 終端工作不跨重啟保存；這個時間只代表本次 ffmpeg 真正完成的當下，
        // 不可由監控視窗開啟／重繪時的現在時間推算。
        if (!Number.isFinite(job.completedAt) || job.completedAt <= 0) job.completedAt = Date.now();
      }
      else if (data.error) {
        job.status = JOB_STATUS.FAILED;
        job.errorMsg = data.errorMsg;
        openQueueWindow(); // pop up on error
      }
      else if (data.stopped) job.status = JOB_STATUS.STOPPED;
      else {
        job.pct = data.pct;
        job.elapsedMs = data.elapsedMs;
        job.etaS = data.etaS;
      }
      QueueManager.notifyChanged();
    }
    if (sender) safeSend(sender, evt, data);
    else if (fallbackSender) safeSend(fallbackSender, evt, data);
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
      const plan = buildDeliveryArgv({
        format, clips, videoTracks,
        width: payloadWidth, height: payloadHeight, fps: payloadFps,
        duration: payloadDuration, videoKbps, audioPlan, timecodeWatermark,
        assFileName: assName, outPath,
      }, {
        hwdecArgs, vencArgsBitrate, proresArgs,
        encoderName: VENC,
        hasAudioStream,
        fontsDir: fontsRoot(),
        timecodeFontFile: _findExportTimecodeFont(),
      });
      const { args, label, duration: D, kbps, audioBitrates } = plan;

      if (isWav) {
        const t0 = Date.now();
        await runFF(args, { duration: D, jobId, label, outPath,
          onProgress: data => dispatch('task-progress', data),
          onProcess: controller => {
            activeJobs.set(jobId, {
              controller,
              p: controller.process,
              stop: controller.stop,
              completion: controller.completion,
              outPath,
              stopped: false,
            });
          }
        });
        activeJobs.delete(jobId);
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
            activeJobs.set(jobId, {
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
      activeJobs.delete(jobId);
      const r = {
        outPath, encoder: usedEncoder, gpu: /nvenc|qsv|amf|videotoolbox|vaapi/i.test(usedEncoder),
        elapsedMs: Date.now() - t0, videoKbps: isPro ? null : kbps,
        audioBitrates: isPro ? null : audioBitrates,
        audioActualBitrates: isPro ? null : outputAudioBitrates(outPath)
      };
      dispatch( 'task-progress', { jobId, label, pct: 100, done: true, result: r });
    } catch (err) {
      const active = activeJobs.get(jobId);
      const wasShutdown = !!active?.shutdown;
      const wasStopped = !!active?.stopped;
      activeJobs.delete(jobId);
      if (wasShutdown) {
         // 關閉程式時 QueueManager 已把狀態退回 queued；半成品與 lease 只由 watchdog
         // 在確認 ffmpeg close 後處理，主程序不可搶先 unlink。
      } else if (wasStopped) {
         if (err.code === 'PARTIAL_CLEANUP_FAILED' || err.watchdogResult?.cleanup?.retainedLease)
           dispatch('task-progress', { jobId, error: true, errorMsg: err.message });
         else dispatch('task-progress', { jobId, stopped: true });
      } else {
         dispatch( 'task-progress', { jobId, error: true, errorMsg: err.message });
      }
    }
  
}


ipcMain.handle('dialog:importDirectory', async () => {
  const r = await dialog.showOpenDialog(mainWin, {
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
  const r = await dialog.showOpenDialog(mainWin, {
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
ipcMain.handle('cache:info', () => cacheInfo());
ipcMain.handle('cache:cleanOrphans', () => cleanOrphans());
ipcMain.handle('cache:clearAll', (e, currentSrc) => clearAllCache(currentSrc));

ipcMain.handle('ffprobe', (e, p) => {
  if (!FFPROBE) throw new Error('找不到 ffprobe');
  requireReadablePath('ffprobe', p);
  const r = spawnSync(FFPROBE, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', p], { maxBuffer: 1 << 24 });
  if (r.status !== 0) throw new Error('ffprobe 失敗');
  const j = JSON.parse(r.stdout.toString());
  const video = (j.streams || []).filter(s => s.codec_type === 'video' && !((s.disposition || {}).attached_pic));
  const audio = (j.streams || []).filter(s => s.codec_type === 'audio');
  const v = video[0];
  let fps = null;
  if (v && v.avg_frame_rate && v.avg_frame_rate !== '0/0') { const [a, b] = v.avg_frame_rate.split('/').map(Number); if (b) fps = a / b; }
  return {
    duration: parseFloat((j.format || {}).duration) || (v && parseFloat(v.duration)) || 0,
    video: v ? { codec: v.codec_name, width: v.width, height: v.height, fps } : null,
    audio: audio.map((a, i) => ({ index: i, streamIndex: a.index, codec: a.codec_name, channels: a.channels, lang: (a.tags && (a.tags.language || a.tags.LANGUAGE)) || '', title: (a.tags && (a.tags.title || a.tags.TITLE)) || '' }))
  };
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
  let target; try { target = path.resolve(p); } catch (e2) { return; }
  if (!fileAuthority.canManageInternalFile(target)) {
    console.warn('[sec] ffmpeg:cleanup blocked (outside cache):', p);
    return;
  }
  try { fs.unlinkSync(target); tempFiles.delete(target); } catch (e2) {}
});

/* ---- 單次讀取多輸出：整個來源檔只讀一遍，同時產生 proxy + 每聲道音訊 + 混音波形 ----
   每聲道以 asplit 分流（不直接 -map 同一條 stream，避免 filtergraph 與 -map 雙重消費而 deadlock）。
   結果存入持久快取（依 cacheKeyFor），重開同檔直接命中、秒開。 */
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
    const merged = { ...current, ...data };
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

ipcMain.handle('ffmpeg:ingest', async (e, { path: src, duration, needsProxy, audio, queue }) => {
  requireReadablePath('ffmpeg:ingest', src);
  // queue=false（取代式載入）：強制終止上一個未完成的 ingest，確保新檔案獲得完整系統資源。
  // queue=true（影片序列「加入」）：不可殺前一個——那可能是正在餵播放器的 streamIngest
  // 背景轉檔或主媒體的音軌抽取（殺掉會讓播放直接中斷）；改為排隊、待其完成後執行。
  if (!queue && _currentIngestProc) { try { _currentIngestProc.kill(); } catch (e2) {} _currentIngestProc = null; }
  if (queue) {
    const p = _ingestQueueTail.then(() => _runIngest(e, { src, duration, needsProxy, audio }));
    _ingestQueueTail = p.catch(() => null); // 佇列不因單一失敗而中斷；失敗仍 reject 給 renderer
    return p;
  }
  return _runIngest(e, { src, duration, needsProxy, audio });
});
let _ingestQueueTail = Promise.resolve(); // 序列加入的 ingest 串行排隊（不與播放中的轉檔搶 I/O）
async function _runIngest(e, { src, duration, needsProxy, audio }) {
  const audioArr = Array.isArray(audio) ? audio : [];
  // 快取命中（先找影片旁的 .subtool_Cache，再找 userData）
  // v4.23.x 修：v4.22 前的舊快取沒有 proxy——needsProxy 時視同未命中重轉（否則 WebCodecs
  // 預覽引擎永遠拿不到 proxy、無法接管 mpv 畫面 → 疊加/溶接預覽整組失效）
  const hit = readCache(src);
  if (hit && (!audioArr.length || hit.routingMetadataComplete) && (!needsProxy || (hit.meta && hit.meta.proxy && fs.existsSync(hit.meta.proxy)))) {
    if (e.sender) safeSend(e.sender, 'task-progress', { jobId: 'ingest', label: '使用快取', pct: 100, done: true });
    return Object.assign({ cached: true }, hit.meta);
  }
  const dir = writeCacheDir(src);
  const metaPath = path.join(dir, 'meta.json');
  fs.mkdirSync(dir, { recursive: true });

  const audioPlan = buildAudioIngestPlan(audioArr);
  const fc = audioPlan.filters;
  const channels = audioPlan.channels.map(channel => ({ ...channel, file: path.join(dir, channel.file) }));
  const chMaps = audioPlan.channelMaps;
  const waveLabel = audioPlan.waveLabel;

  let proxy = needsProxy ? path.join(dir, 'proxy.mp4') : null;
  let wave = waveLabel ? path.join(dir, 'wave.wav') : null;
  const args = buildIngestArgs({
    src,
    needsProxy,
    proxyPath: proxy,
    fc,
    channels,
    chMaps,
    waveLabel,
    wavePath: wave,
    encoder: VENC,
    isStream: false
  });

  // 稍微延遲讓 mpv 優先取得檔案讀取權，避免 ffmpeg 瞬間佔滿磁碟 I/O 導致 mpv 播放無聲
  await new Promise(r => setTimeout(r, 1000));

  await runFF(args, { sender: e.sender, duration, jobId: 'ingest', label: '讀取並轉檔（單次讀取）', onProcess: p => { _currentIngestProc = p; } }); // S1: 記錄 proc
  _currentIngestProc = null;
  const meta = { proxy, channels, wave };
  writeMeta(metaPath, meta);
  return Object.assign({ cached: false }, meta);
}

/* 讀取快取檔案內容（base64）給 renderer（例如波形 wav） */
ipcMain.handle('fs:readB64', async (e, p) => {
  if (!fileAuthority.canRead(p)) { console.warn('[sec] readB64 blocked:', p); return null; }
  try { return (await fs.promises.readFile(p)).toString('base64'); } catch (err) { return null; }
});
ipcMain.handle('fs:writeProject', async (e, { path: p, b64 }) => {
  // autosave 落在使用者已選取的專案／媒體資料夾旁；不可讓 renderer 自行擴張寫入根。
  if (!fileAuthority.canWriteProject(p)) { console.warn('[sec] writeProject blocked:', p); return null; }
  try { await fs.promises.mkdir(path.dirname(p), { recursive: true }); await fs.promises.writeFile(p, Buffer.from(b64, 'base64')); return p; } catch (err) { return null; }
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
  // S1: 強制終止上一個未完成的 ingest，確保新檔案獲得完整系統資源
  if (_currentIngestProc) { try { _currentIngestProc.kill(); } catch (e2) {} _currentIngestProc = null; }
  const audioArr = Array.isArray(audio) ? audio : [];
  const port = await ensureHttpServer();

  // 快取命中（先找影片旁的 .subtool_Cache，再找 userData）
  // 注意：串流播放需要影片 proxy；mpv 路徑寫的快取是「純音軌」(proxy=null)，
  // 對串流路徑而言不算命中，須往下重轉以產生 proxy（音軌/波形會一併重建）。
  const hit = readCache(src);
  if (hit && (!audioArr.length || hit.routingMetadataComplete) && hit.meta.proxy && fs.existsSync(hit.meta.proxy)) {
    if (e.sender) safeSend(e.sender, 'task-progress', { jobId: 'ingest', label: '使用快取', pct: 100, done: true });
    const jid = newJobId('c-'); // S5: 不可猜測
    _hJobs.set(jid, { filePath: hit.meta.proxy, done: true });
    return Object.assign({ cached: true, streamUrl: `http://127.0.0.1:${port}/${jid}` }, hit.meta);
  }
  const dir = writeCacheDir(src);
  const metaPath = path.join(dir, 'meta.json');
  fs.mkdirSync(dir, { recursive: true });

  // 與 ffmpeg:ingest 共用同一份跨平台逐聲道規劃，避免兩條路徑或兩個 OS 漂移。
  const audioPlan = buildAudioIngestPlan(audioArr);
  const fc = audioPlan.filters;
  const channels = audioPlan.channels.map(channel => ({ ...channel, file: path.join(dir, channel.file) }));
  const chMaps = audioPlan.channelMaps;
  const waveLabel = audioPlan.waveLabel;

  const proxy = path.join(dir, 'proxy.mp4');
  const wave = waveLabel ? path.join(dir, 'wave.wav') : null;

  const args = buildIngestArgs({
    src,
    needsProxy: true,
    proxyPath: proxy,
    fc,
    channels,
    chMaps,
    waveLabel,
    wavePath: wave,
    encoder: VENC,
    isStream: true
  });

  const jid = newJobId('l-'); // S5: 不可猜測
  const job = { filePath: proxy, done: false, error: null };
  _hJobs.set(jid, job);

  // 背景跑 ffmpeg（不 await）。用唯一 jobId 讓前端能辨識「是本次轉檔完成」而非其他工作。
  runFF(args, { sender: e.sender, duration, jobId: jid, label: '背景轉檔中', onProcess: p => { _currentIngestProc = p; } }) // S1: 記錄 proc
    .then(() => { _currentIngestProc = null; job.done = true; writeMeta(metaPath, { proxy, channels, wave }); })
    .catch(err => { _currentIngestProc = null; job.done = true; job.error = err.message; });

  // S3: 縮小閾值至 128KB（empty_moov 寫完即可播，不需等到 512KB）
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    /* 非同步：這個迴圈最長跑 60 秒、每 300ms 一次。proxy 依 cacheCandidates 的優先序
       多半落在【影片旁邊】的 .subtool_Cache，素材在 SMB 上時這個 stat 也在 SMB 上。
       用同步版本等於每 300ms 就把主行程的 UI 執行緒鎖住數十毫秒——原生檔案對話框的
       訊息迴圈就在那條執行緒上，於是「開啟檔案總管」與「在裡面切換資料夾」都會頓。 */
    try { if ((await fsp.stat(proxy)).size >= 131072) break; } catch (e2) {}
    if (job.error) throw new Error('轉檔失敗：' + job.error);
    await new Promise(r => setTimeout(r, 300));
  }

  return { cached: false, streamUrl: `http://127.0.0.1:${port}/${jid}`, proxy, channels, wave, ingestJobId: jid };
});

/* ============ mpv 媒體播放器整合（秒開非原生格式，無需等待 ffmpeg proxy 轉檔） ============
   架構：spawn mpv → 透過 Windows named pipe 發送 JSON IPC 指令 → renderer 同步時碼
   音訊：mpv 先播原生音訊；背景 ffmpeg 只抽音軌（無 proxy），完成後 element tracks 接管，mpv 靜音 */
let _mpvExe = null;
let _mpvProc = null;
let _mpvClient = null;
let _mpvReqId = 0;
const _mpvCbs = new Map();
let _mpvBuf = '';
// 嵌入式覆蓋視窗（無邊框子視窗，貼合影片面板；mpv 以 --wid 渲染進其中）
let _mpvWin = null;
let _mpvGuideWin = null;  // 疊在 mpv 上方的透明輔助層（字幕拖曳虛線框／旋轉點）
let _mpvRect = null;       // 最近一次面板矩形（內容座標 DIP）
let _mpvVisible = true;
let _mpvGuide = null;
let _mpvImagesHtml = '';
// MPV 的畫面不在主 renderer 裡，因此播放器上的時間碼需透過透明 guide 顯示。
// 只保存已驗證的 SMPTE 時碼；主 renderer 明確清除前，換檔／重建 MPV 視窗仍可延續顯示。
let _mpvTimecodeWatermark = '';
let _mpvTimecodeWatermarkRect = null;
let _mpvGuideInteractive = false;
let _mpvGuideAppliedInteractive = null;
let _mpvImageHitRegions = [];
let _mpvGuideDragging = false;
let _mpvGuidePointerTimer = null;
let _mpvSubFile = null;    // 餵給 mpv 的暫存 .ass 字幕檔
let _mpvSubAdded = false;

const MPV_GUIDE_HTML = `<!doctype html><html><head><style>
html,body{width:100%;height:100%;margin:0;padding:0;overflow:hidden;background:transparent}
svg{width:100%;height:100%;margin:0;padding:0;overflow:hidden;background:transparent;pointer-events:none}
#imgContainer{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:auto}
#timecodeWatermark{display:none;position:absolute;top:14px;left:16px;z-index:10;pointer-events:none;user-select:none;white-space:nowrap;padding:6px 9px 5px;border:1px solid rgba(239,178,53,.78);border-left:3px solid #f0a020;border-radius:2px;background:rgba(8,11,14,.72);box-shadow:0 1px 5px rgba(0,0,0,.55);color:#ffe19a;font:600 16px/1 Consolas,"Cascadia Mono","JetBrains Mono",monospace;letter-spacing:.045em;font-variant-numeric:tabular-nums;text-shadow:0 1px 2px #000}
#timecodeWatermark.visible{display:block}
.img-wrap{position:absolute;pointer-events:auto;cursor:grab;touch-action:none;user-select:none}
.img-wrap img{width:100%;height:100%;object-fit:contain;display:block;pointer-events:none}
.img-wrap:hover,.img-wrap.hovering,.img-wrap.selected{outline:1px dashed rgba(255,255,255,.72);outline-offset:3px}
.resize-handle{display:none;position:absolute;width:12px;height:12px;background:#f0a020;border:1px solid #fff;border-radius:50%;z-index:10;pointer-events:auto !important;cursor:pointer !important}
.img-wrap:hover .resize-handle,.img-wrap.hovering .resize-handle,.img-wrap.selected .resize-handle{display:block}
/* 與 src/styles.css 同步：把手內縮貼四角內側（外凸會被視窗邊界裁掉），::after 補透明命中區 */
.resize-handle::after{content:'';position:absolute;inset:-8px;pointer-events:auto !important;cursor:pointer !important}
.rh-nw{top:0;left:0;cursor:nwse-resize !important}.rh-ne{top:0;right:0;cursor:nesw-resize !important}
.rh-sw{bottom:0;left:0;cursor:nesw-resize !important}.rh-se{bottom:0;right:0;cursor:nwse-resize !important}
#guide{display:none} rect{fill:none;stroke:rgba(255,255,255,.88);stroke-width:1;stroke-dasharray:5 4}
line{stroke:rgba(255,255,255,.65);stroke-width:1} circle{fill:#f0a020;stroke:#fff;stroke-width:2}
</style></head><body><div id="imgContainer"></div><svg id="svg"><g id="guide"><rect id="box"/><line id="stem"/><circle id="dot" r="7"/></g></svg><div id="timecodeWatermark" aria-hidden="true"></div><script>
let current=null,stageRect=null,dragging=null;
const svg=document.getElementById('svg'),guide=document.getElementById('guide'),imgContainer=document.getElementById('imgContainer'),timecodeWatermark=document.getElementById('timecodeWatermark');
const draw=()=>{ const g=current; if(!g){guide.style.display='none';return;} const w=innerWidth,h=innerHeight;
  svg.setAttribute('viewBox','0 0 '+w+' '+h); document.getElementById('box').setAttribute('x',g.x); document.getElementById('box').setAttribute('y',g.y);
  document.getElementById('box').setAttribute('width',g.w); document.getElementById('box').setAttribute('height',g.h);
  const cx=g.x+g.w/2, cy=g.y-19, stem=document.getElementById('stem'), dot=document.getElementById('dot');
  stem.setAttribute('x1',cx);stem.setAttribute('y1',cy+7);stem.setAttribute('x2',cx);stem.setAttribute('y2',g.y-2);
  dot.setAttribute('cx',cx);dot.setAttribute('cy',cy);guide.style.display='block'; };
window.setGuide=(g)=>{current=g;draw();}; addEventListener('resize',draw);
window.setTimecodeWatermark=(text,rect)=>{const value=typeof text==='string'?text:'';const x=Number(rect&&rect.x),y=Number(rect&&rect.y);timecodeWatermark.style.left=(Number.isFinite(x)?Math.round(x)+16:16)+'px';timecodeWatermark.style.top=(Number.isFinite(y)?Math.round(y)+14:14)+'px';timecodeWatermark.textContent=value;timecodeWatermark.classList.toggle('visible',!!value);};
const bridge=()=>window.mpvImageGuide||null;
const wrapAt=(x,y)=>{const t=document.elementFromPoint(x,y);return t&&t.closest?t.closest('.img-wrap'):null;};
const setHover=wrap=>{for(const el of imgContainer.querySelectorAll('.img-wrap.hovering'))if(el!==wrap)el.classList.remove('hovering');if(wrap)wrap.classList.add('hovering');};
const point=e=>{const r=stageRect||{x:0,y:0};return{x:e.clientX-(+r.x||0),y:e.clientY-(+r.y||0)};};
const send=(type,extra={})=>{const b=bridge();if(b)b.pointer({type,...extra});};
// 這裡曾送出 'enter'／'leave' 給主程序切換指標抓取，但兩者都沒帶座標，
// 在 mpv-guide-preload.js 的 x/y 檢查就被丟掉，從未生效。已移除，見 §0.9。
document.addEventListener('pointermove',e=>{if(dragging){const p=point(e);send('move',{x:p.x,y:p.y});e.preventDefault();return;}setHover(wrapAt(e.clientX,e.clientY));});
document.addEventListener('pointerdown',e=>{if(e.button!==0)return;const wrap=wrapAt(e.clientX,e.clientY);if(!wrap)return;const p=point(e);const handle=(e.target.closest&&e.target.closest('.resize-handle'))||(document.elementFromPoint(e.clientX,e.clientY)?.closest?.('.resize-handle'))||null;const corner=handle?.dataset?.corner||null;dragging={id:wrap.dataset.id,corner};try{wrap.setPointerCapture(e.pointerId);}catch(_){}send('start',{id:dragging.id,corner,x:p.x,y:p.y});e.preventDefault();});
const finish=(e,type)=>{if(!dragging)return;const p=point(e);send(type,{id:dragging.id,x:p.x,y:p.y});dragging=null;setHover(wrapAt(e.clientX,e.clientY));};
document.addEventListener('pointerup',e=>finish(e,'end'));document.addEventListener('pointercancel',e=>finish(e,'cancel'));
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
  if(!h) { dragging = null; }
};
</script></body></html>`;

/* 上一次真的套用出去的【絕對】座標。用來擋掉沒有變化的重設。 */
let _mpvAppliedBounds = null;

function applyMpvBounds(b) {
  if (!_mpvWin || _mpvWin.isDestroyed() || !b || !mainWin) return;
  _mpvRect = b;
  try {
    const cb = mainWin.getContentBounds(); // DIP，內容區左上角為原點
    const next = {
      x: Math.round(cb.x + b.x),
      y: Math.round(cb.y + b.y),
      width: Math.max(1, Math.round(b.w)),
      height: Math.max(1, Math.round(b.h)),
    };

    /* 沒變就不要動視窗。

       mpv 與 guide 都是 `transparent: true` 的子視窗——在 Windows 上那是 layered
       window，setBounds() 會走 SetWindowPos 並強制 DWM 重新合成整塊區域，成本不低。
       而 renderer 有一個【每 2 秒】的安全網計時器（media.js _startMpvBoundsFeeder）
       會無條件送同一個矩形過來，所以只要 mpv 在跑，這裡本來就是每 2 秒把兩個 layered
       視窗各重設一次位置——即使畫面根本沒動。

       那會卡到原生檔案對話框：dialog.showOpenDialog 的訊息迴圈就在主行程的 UI
       執行緒上，於是「開啟檔案總管」與「在裡面切換資料夾」每 2 秒被打斷一次。

       ── 比對的必須是【絕對座標】，不是傳進來的 b ──
       主視窗移動時 reapplyMpv() 會用【同一個 b】重呼叫（b 是內容區相對座標，
       視窗移動並不會改變它），此時 cb.x/cb.y 變了、next 也就變了，仍會正確套用。
       若改成比對 b，視窗一移動 mpv 就會留在原地。 */
    const same = _mpvAppliedBounds
      && _mpvAppliedBounds.x === next.x && _mpvAppliedBounds.y === next.y
      && _mpvAppliedBounds.width === next.width && _mpvAppliedBounds.height === next.height;
    if (same) return;
    _mpvAppliedBounds = next;

    _mpvWin.setBounds(next);
    if (_mpvGuideWin && !_mpvGuideWin.isDestroyed()) {
      _mpvGuideWin.setBounds(next);
    }
  } catch (e) {}
}

function normaliseMpvImageHitRegions(raw) {
  if (!Array.isArray(raw)) return [];
  const clampCoord = value => Math.max(-10000, Math.min(10000, Number(value)));
  return raw.slice(0, 100).map(region => {
    if (!region || typeof region !== 'object') return null;
    const x = Number(region.x), y = Number(region.y);
    const w = Number(region.w), h = Number(region.h);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
    return { x: clampCoord(x), y: clampCoord(y), w: Math.max(1, Math.min(20000, w)), h: Math.max(1, Math.min(20000, h)) };
  }).filter(Boolean);
}

/*
 * BrowserWindow 的 ignoreMouseEvents({ forward:true }) 只保證把「move」送給該
 * Chromium 視窗，不能可靠地把 pointerdown / pointerup 交給透明 guide。因此先前
 * guide 雖顯示虛線與控制點，卻永遠收不到開始拖曳的事件。
 *
 * 改為由主程序讀取游標位置，僅在圖片（含角落控制點）的命中區切換 guide 的輸入。
 * 圖片外一律真正穿透到主 renderer，字幕等既有操作不會被透明視窗攔住；拖曳開始後
 * 則維持 guide 接收輸入，讓 pointer capture 可以收到放開事件。
 */
function stopMpvGuidePointerWatch() {
  if (_mpvGuidePointerTimer) clearInterval(_mpvGuidePointerTimer);
  _mpvGuidePointerTimer = null;
}

// 已經廢棄 25ms 輪詢，改由 Guide 視窗的原生 DOM pointerenter / pointerleave 事件觸發。
// (在 mpv-guide:imagePointer IPC 的 'enter' / 'leave' 處理)

function setMpvGuideInteractive(active) {
  active = !!active;
  _mpvGuideInteractive = active;
  if (!_mpvGuideWin || _mpvGuideWin.isDestroyed()) { _mpvGuideAppliedInteractive = null; return; }
  if (_mpvGuideAppliedInteractive === active) return;
  try {
    _mpvGuideWin.setIgnoreMouseEvents(!active, { forward: true });
    _mpvGuideAppliedInteractive = active;
  } catch (e) {}
}

const MPV_TIMECODE_RE = /^\d{1,6}:[0-5]\d:[0-5]\d[:;]\d{2,3}$/;

/*
 * 時間碼浮水印由主 renderer 每次播放頭更新時送入。guide 是另一個 BrowserWindow，
 * 因此不接受任意 HTML／樣式字串，只允許固定的 SMPTE HH:MM:SS:FF（或 DF 的 ;）格式。
 * null、undefined、空白字串都是「清除」；其他不符合格式的資料直接拒絕、不改動目前顯示。
 */
function normaliseMpvTimecodeRect(raw) {
  if (raw == null) return { ok: true, rect: null };
  if (!raw || typeof raw !== 'object') return { ok: false, rect: null };
  const x = Number(raw.x), y = Number(raw.y), w = Number(raw.w), h = Number(raw.h);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return { ok: false, rect: null };
  return {
    ok: true,
    rect: {
      x: Math.round(Math.max(-10000, Math.min(10000, x))),
      y: Math.round(Math.max(-10000, Math.min(10000, y))),
      w: Math.round(Math.max(1, Math.min(20000, w))),
      h: Math.round(Math.max(1, Math.min(20000, h))),
    },
  };
}

function normaliseMpvTimecodeWatermark(raw) {
  if (raw == null || raw === '') return { ok: true, text: '', rect: null };
  // 支援純字串，讓舊版／簡單呼叫端仍可使用；標準 API 則傳 { text, rect }。
  const data = typeof raw === 'string' ? { text: raw } : raw;
  if (!data || typeof data !== 'object' || typeof data.text !== 'string') return { ok: false, text: '', rect: null };
  const text = data.text.trim();
  if (!text) return { ok: true, text: '', rect: null };
  const rect = normaliseMpvTimecodeRect(data.rect);
  if (!MPV_TIMECODE_RE.test(text) || !rect.ok) return { ok: false, text: '', rect: null };
  return { ok: true, text, rect: rect.rect };
}

function mpvGuideHasVisibleContent() {
  return !!(_mpvGuide || _mpvImagesHtml || _mpvTimecodeWatermark);
}

function sameMpvTimecodeRect(a, b) {
  return a === b || !!(a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
}

function applyMpvTimecodeWatermark() {
  if (!_mpvGuideWin || _mpvGuideWin.isDestroyed()) return false;
  try {
    _mpvGuideWin.webContents.executeJavaScript(`window.setTimecodeWatermark(${JSON.stringify(_mpvTimecodeWatermark)}, ${JSON.stringify(_mpvTimecodeWatermarkRect)})`, true).catch(() => {});
    return true;
  } catch (e) { return false; }
}

function setMpvTimecodeWatermark(raw) {
  const next = normaliseMpvTimecodeWatermark(raw);
  if (!next.ok) return false;
  const changed = _mpvTimecodeWatermark !== next.text || !sameMpvTimecodeRect(_mpvTimecodeWatermarkRect, next.rect);
  _mpvTimecodeWatermark = next.text;
  _mpvTimecodeWatermarkRect = next.rect;
  if (!_mpvGuideWin || _mpvGuideWin.isDestroyed()) return true;
  try {
    if (changed) applyMpvTimecodeWatermark();
    if (_mpvTimecodeWatermark) showMpvGuide();
    else if (!mpvGuideHasVisibleContent()) _mpvGuideWin.hide();
  } catch (e) {}
  return true;
}

function destroyMpvWin() {
  if (_mpvWin) { try { if (!_mpvWin.isDestroyed()) _mpvWin.destroy(); } catch (e) {} _mpvWin = null; }
  if (_mpvGuideWin) { try { if (!_mpvGuideWin.isDestroyed()) _mpvGuideWin.destroy(); } catch (e) {} _mpvGuideWin = null; }
  /* _mpvAppliedBounds 必須一起清掉：它是「上次真的送出去的絕對座標」的快取，
     mpv 重啟後視窗是全新的，留著舊值會讓第一次定位被誤判成「沒變」而跳過。 */
  _mpvRect = null; _mpvAppliedBounds = null; _mpvVisible = true; _mpvGuide = null; _mpvImagesHtml = ''; _mpvImageHitRegions = []; _mpvGuideDragging = false; _mpvGuideInteractive = false; _mpvGuideAppliedInteractive = null; _mpvSubAdded = false; _mpvSubFile = null;
}

function showMpvGuide() {
  if (!_mpvVisible || !mpvGuideHasVisibleContent() || !_mpvGuideWin || _mpvGuideWin.isDestroyed()) return;
  try { _mpvGuideWin.showInactive(); _mpvGuideWin.moveTop(); } catch (e) {}
}

function setMpvGuide(raw) {
  const vals = raw && [raw.x, raw.y, raw.w, raw.h];
  if (!vals || vals.some(v => !Number.isFinite(v)) || raw.w <= 0 || raw.h <= 0) {
    _mpvGuide = null;
    if (_mpvGuideWin && !_mpvGuideWin.isDestroyed()) {
      // 時間碼浮水印會讓 guide 視窗持續顯示；不能只在視窗隱藏時才清除 SVG，
      // 否則上一句字幕的虛線框與旋轉點會殘留在仍可見的透明 guide 上。
      try { _mpvGuideWin.webContents.executeJavaScript('window.setGuide(null)', true).catch(() => {}); } catch (e) {}
      if (!mpvGuideHasVisibleContent()) { try { _mpvGuideWin.hide(); } catch (e) {} }
    }
    return;
  }
  _mpvGuide = { x: +raw.x, y: +raw.y, w: +raw.w, h: +raw.h };
  if (!_mpvGuideWin || _mpvGuideWin.isDestroyed()) return;
  try {
    _mpvGuideWin.webContents.executeJavaScript(`window.setGuide(${JSON.stringify(_mpvGuide)})`, true).catch(() => {});
    showMpvGuide();
  } catch (e) {}
}

function setMpvImageGuide(data) {
  _mpvImagesHtml = (data && data.html) || (typeof data === 'string' ? data : '');
  _mpvImageHitRegions = normaliseMpvImageHitRegions(data && data.hitRegions);
  const rect = data && data.rect;
  if (!_mpvGuideWin || _mpvGuideWin.isDestroyed()) return;
  try {
    _mpvGuideWin.webContents.executeJavaScript(`window.setImages(${JSON.stringify(_mpvImagesHtml)}, ${JSON.stringify(rect)})`, true).catch(() => {});
    if (mpvGuideHasVisibleContent()) {
      showMpvGuide();
      if (!_mpvImagesHtml) {
        _mpvGuideDragging = false;
        setMpvGuideInteractive(false);
      }
    } else {
      _mpvGuideDragging = false;
      setMpvGuideInteractive(false);
      _mpvGuideWin.hide();
    }
  } catch (e) {}
}

function detectMpv() {
  if (!mpvEmbeddingSupported(process.platform)) return null;
  if (_mpvExe) return _mpvExe;
  const cands = [
    // 內建（隨程式打包）— 優先，讓秒開成為預設行為
    path.join(__dirname, 'mpv', 'mpv.exe'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'electron', 'mpv', 'mpv.exe'),
    path.join(process.resourcesPath || '', 'mpv', 'mpv.exe'),
    path.join(process.resourcesPath || '', 'app', 'electron', 'mpv', 'mpv.exe'),
    // 系統安裝
    process.env.MPV_PATH,
    'mpv',
    'C:\\Program Files\\mpv\\mpv.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'mpv', 'mpv.exe'),
    path.join(os.homedir(), 'scoop', 'shims', 'mpv.exe'),
    path.join(os.homedir(), 'scoop', 'apps', 'mpv', 'current', 'mpv.exe'),
  ].filter(Boolean);
  for (const c of cands) {
    try { const r = spawnSync(c, ['--version'], { timeout: 3000, stdio: 'pipe' }); if (r.status === 0) { _mpvExe = c; return c; } } catch (e) {}
  }
  return null;
}

function mpvSend(cmd, wantReply = false) {
  if (!_mpvClient) return Promise.resolve(null);
  return new Promise(resolve => {
    const id = ++_mpvReqId;
    if (wantReply) {
      _mpvCbs.set(id, resolve);
      setTimeout(() => { if (_mpvCbs.delete(id)) resolve(null); }, 5000);
    } else { resolve(null); }
    try { _mpvClient.write(JSON.stringify(wantReply ? { command: cmd, request_id: id } : { command: cmd }) + '\n'); }
    catch (e) { if (wantReply) { _mpvCbs.delete(id); resolve(null); } }
  });
}

function mpvConnectPipe(pipeName) {
  return new Promise((resolve, reject) => {
    let retries = 0;
    const pipePath = '\\\\.\\pipe\\' + pipeName;
    const tryConnect = () => {
      const client = net.createConnection(pipePath);
      client.once('connect', () => {
        _mpvClient = client; _mpvBuf = '';
        client.on('data', chunk => {
          _mpvBuf += chunk.toString();
          const lines = _mpvBuf.split('\n'); _mpvBuf = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              if (typeof msg.request_id === 'number' && _mpvCbs.has(msg.request_id)) {
                _mpvCbs.get(msg.request_id)(msg.data ?? null); _mpvCbs.delete(msg.request_id);
              } else if (msg.event === 'property-change' || msg.event === 'end-file') {
                safeWinSend(mainWin, 'mpv:event', msg);
              }
            } catch (e) {}
          }
        });
        client.on('close', () => { _mpvClient = null; safeWinSend(mainWin, 'mpv:event', { event: 'disconnected' }); });
        resolve(client);
      });
      client.once('error', () => {
        if (retries < 20) { retries++; setTimeout(tryConnect, 300); }
        else reject(new Error('mpv pipe connect timeout'));
      });
    };
    tryConnect();
  });
}

ipcMain.handle('mpv:detect', () => {
  const supported = mpvEmbeddingSupported(process.platform);
  const exe = supported ? detectMpv() : null;
  console.error('[mpv] detect ->', exe || (supported ? '(not found)' : `(disabled on ${process.platform})`));
  return { available: !!exe, supported, exe };
});
ipcMain.handle('mpv:launch', async (e, { src, bounds, audio }) => {
  if (typeof src !== 'string' || !src) throw new Error('mpv：來源路徑無效');
  requireReadablePath('mpv:launch', src);
  if (!mpvEmbeddingSupported(process.platform)) throw new Error('目前 macOS 版不啟用 Windows 專用的 mpv 嵌入');
  if (_mpvProc) { try { _mpvProc.kill(); } catch (ee) {} _mpvProc = null; }
  if (_mpvClient) { try { _mpvClient.destroy(); } catch (ee) {} _mpvClient = null; }
  destroyMpvWin();
  const exe = detectMpv();
  if (!exe) throw new Error('找不到 mpv，請安裝 mpv 或設定 MPV_PATH 環境變數（https://mpv.io）');

  // 建立無邊框「透明」子視窗作為 mpv 的渲染宿主（--wid 嵌入），由 Electron 精準控制位置/大小。
  // 透明很關鍵：否則 Chromium 會以不透明背景蓋住 mpv 的畫面 → 全黑。
  _mpvWin = new BrowserWindow({
    parent: mainWin, frame: false, show: true, transparent: true,
    hasShadow: false, skipTaskbar: true, thickFrame: false,
    resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, focusable: false, acceptFirstMouse: false,
    webPreferences: { offscreen: false, backgroundThrottling: false },
  });
  // mpv 是獨立原生子視窗，若攔截滑鼠事件，底下 renderer 的字幕拖曳層永遠收不到
  // pointerdown。mpv 已停用預設滑鼠控制，因此所有滑鼠事件都應穿透到主視窗。
  try { _mpvWin.setIgnoreMouseEvents(true, { forward: true }); } catch (e2) {}
  try { _mpvWin.setMenu(null); } catch (e2) {}
  _mpvWin.loadURL('data:text/html,<body style="margin:0;background:transparent"></body>');
  // DOM 位於 mpv 子視窗下方，CSS 的 hover 外框無法顯示；另建無輸入的透明原生層顯示它。
  _mpvGuideWin = new BrowserWindow({
    parent: mainWin, frame: false, show: false, transparent: true,
    hasShadow: false, skipTaskbar: true, thickFrame: false,
    resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, focusable: false,
    webPreferences: {
      offscreen: false, backgroundThrottling: false, webSecurity: false,
      preload: path.join(__dirname, 'mpv-guide-preload.js'),
    },
  });
  // 非圖片範圍一律穿透；主程序依圖片命中區切換成互動模式，避免 forward:true 導致
  // Chromium 只收到 move 而遺失 pointerdown／pointerup。
  setMpvGuideInteractive(false);
  try { _mpvGuideWin.setMenu(null); } catch (e2) {}
  ensureTmp();
  const guideHtmlPath = path.join(TMP, 'mpv-guide.html');
  fs.writeFileSync(guideHtmlPath, MPV_GUIDE_HTML, 'utf8');
  await _mpvGuideWin.loadURL(url.pathToFileURL(guideHtmlPath).href);
  _mpvVisible = true;
  applyMpvBounds(bounds);
  // MPV 視窗可能因換媒體重建；將 renderer 已開啟的監看時間碼重新送進新 guide。
  if (_mpvTimecodeWatermark) {
    applyMpvTimecodeWatermark();
    showMpvGuide();
  }

  // 取得宿主視窗的原生 HWND（Win64 為 8-byte 指標）
  const hb = _mpvWin.getNativeWindowHandle();
  const hwnd = hb.length >= 8 ? hb.readBigUInt64LE(0).toString() : hb.readUInt32LE(0).toString();

  // mpv stderr → 暫存記錄檔，方便診斷（嵌入失敗時可讀取）
  const mpvLog = path.join(TMP, 'mpv-last.log'); ensureTmp();
  let logStream = null; try { logStream = fs.createWriteStream(mpvLog); } catch (e2) {}

  const pipeName = 'subtool-mpv-' + Date.now();
  const mpvArgs = [
    '--wid=' + hwnd,
    '--input-ipc-server=\\\\.\\pipe\\' + pipeName,
    '--no-config', '--no-terminal', '--no-osc',
    '--no-input-default-bindings', '--input-vo-keyboard=no', '--cursor-autohide=no',
    '--vo=gpu', '--gpu-context=d3d11', '--hwdec=auto',
    '--keep-open=always', '--pause', '--hr-seek=yes', '--sid=no'
  ];
  // v4.25.4：libass 也用 <專案根>/font 的字型（與預覽 @font-face／匯出 fontsdir 同一批檔，不必裝進系統）
  { const fdir = fontsRoot(); if (fdir) mpvArgs.push('--sub-fonts-dir=' + fdir, '--embeddedfonts=no'); }

  if (Array.isArray(audio) && audio.length > 1) {
    const aids = [];
    for (let i = 0; i < audio.length; i++) aids.push(`[aid${i + 1}]`);
    mpvArgs.push(`--lavfi-complex=${aids.join('')}amix=inputs=${audio.length}:normalize=0[ao]`);
  }

  /* "--" 終止選項解析：少了它，一個以 "-" 開頭的來源字串會被 mpv 當成【選項】吃掉
     （--script=、--include=、--o= 之類足以造成程式碼執行），而不是當成檔名。 */
  mpvArgs.push('--', src);

  _mpvProc = spawn(exe, mpvArgs, { detached: false, stdio: ['ignore', 'ignore', logStream ? 'pipe' : 'ignore'] });
  if (logStream && _mpvProc.stderr) _mpvProc.stderr.pipe(logStream);
  console.error('[mpv] launch wid=' + hwnd + ' bounds=' + JSON.stringify(_mpvRect) + ' src=' + src);
  _mpvProc.on('error', (err) => console.error('[mpv] spawn error:', err && err.message));
  _mpvProc.on('close', (c) => { console.error('[mpv] proc closed, code=' + c); _mpvProc = null; });
  await mpvConnectPipe(pipeName);
  _mpvClient.write(JSON.stringify({ command: ['observe_property', 1, 'time-pos'] }) + '\n');
  _mpvClient.write(JSON.stringify({ command: ['observe_property', 2, 'pause'] }) + '\n');
  _mpvClient.write(JSON.stringify({ command: ['observe_property', 3, 'duration'] }) + '\n');
  await new Promise(r => setTimeout(r, 400));
  const duration = await mpvSend(['get_property', 'duration'], true);
  return { ok: true, duration: typeof duration === 'number' ? duration : 0 };
});
ipcMain.handle('mpv:setBounds', (e, b) => { applyMpvBounds(b); });
ipcMain.handle('mpv:show', (e, v) => {
  _mpvVisible = !!v;
  if (!_mpvWin || _mpvWin.isDestroyed()) return;
  if (v) {
    try { _mpvWin.show(); _mpvWin.moveTop(); } catch (e2) {}
    if (_mpvRect) applyMpvBounds(_mpvRect);
    showMpvGuide();
    if (!_mpvImagesHtml) setMpvGuideInteractive(false);
  } else {
    try { _mpvWin.hide(); } catch (e2) {}
    if (_mpvGuideWin && !_mpvGuideWin.isDestroyed()) { try { _mpvGuideWin.hide(); } catch (e2) {} }
    _mpvGuideDragging = false;
    setMpvGuideInteractive(false);
  }
});
ipcMain.handle('mpv:setGuide', (e, guide) => setMpvGuide(guide));
ipcMain.handle('mpv:setImageGuide', (e, html) => setMpvImageGuide(html));
// 僅主 renderer 可以更新監看浮水印；guide 自己沒有這個 API，避免外部內容藉由透明層覆蓋 UI。
ipcMain.handle('mpv:setTimecodeWatermark', (e, payload) => {
  if (!mainWin || mainWin.isDestroyed() || e.sender !== mainWin.webContents) return false;
  return setMpvTimecodeWatermark(payload);
});
ipcMain.handle('mpv:clearTimecodeWatermark', (e) => {
  if (!mainWin || mainWin.isDestroyed() || e.sender !== mainWin.webContents) return false;
  return setMpvTimecodeWatermark(null);
});
// 圖片 guide 是內部透明視窗；僅接受該視窗傳來的有限座標／事件，再轉送到主 renderer。
// 不把任意 IPC 或 DOM 字串回送，避免 guide 即使載入使用者圖片也取得主程序權限。
//
// 【v4.6.3 重要改動 - DOM 事件取代 25ms 主程序輪詢】
// 在 Windows 高 DPI 多螢幕環境下，screen.getCursorScreenPoint() 與 getBounds()
// 經常發生非預期的座標偏移，導致 25ms 的座標 hit test 極不穩定，進而使滑鼠點擊
// 在 setIgnoreMouseEvents(true) 的狀態下被直接穿透給底層主視窗，無法拖曳圖片。
//
// 解決方案：guide 視窗【永久保持穿透】（setIgnoreMouseEvents(true, { forward: true })），
// 互動一律由主視窗的 DOM 疊層處理——那一層是無條件建立的，兩個原生視窗都不攔截點擊，
// 所以指標本來就會落到主視窗上。
//
// 這裡曾有 'enter'／'leave' 兩個分支，用來在 hover 時切換 setMpvGuideInteractive()。
// 它們【從未執行過】：送出端沒帶座標，訊息在 preload 的 x/y 檢查就被丟掉。
// 移除的是死碼，不是行為。【不要】把它們加回來——一旦 guide 在 hover 時奪取指標抓取權，
// 底層視訊軌拖曳與右鍵選單就會失效，即 v4.6.3 當初要解決的那個死結。
ipcMain.on('mpv-guide:imagePointer', (e, raw) => {
  if (!_mpvGuideWin || _mpvGuideWin.isDestroyed() || e.sender !== _mpvGuideWin.webContents) return;
  if (!raw || typeof raw !== 'object') return;
  const type = String(raw.type || '');
  if (!['start', 'move', 'end', 'cancel'].includes(type)) return;

  const x = Number(raw.x), y = Number(raw.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const payload = {
    type,
    x: Math.max(-10000, Math.min(10000, x)),
    y: Math.max(-10000, Math.min(10000, y)),
  };
  if (typeof raw.id === 'string' && raw.id.length <= 160) payload.id = raw.id;
  if (['nw', 'ne', 'sw', 'se'].includes(raw.corner)) payload.corner = raw.corner;
  if (type === 'start') {
    _mpvGuideDragging = true;
    setMpvGuideInteractive(true);
  } else if (type === 'end' || type === 'cancel') {
    _mpvGuideDragging = false;
    // pointerup 之後延遲恢復成原本的穿透模式，讓 Chromium capture 能完整釋放
    setTimeout(() => { if (!_mpvGuideDragging) setMpvGuideInteractive(false); }, 0);
  }
  safeWinSend(mainWin, 'mpv:imagePointer', payload);
});
// 餵字幕給 mpv（libass 渲染）：寫入暫存 .ass，首次 sub-add，之後 sub-reload
ipcMain.handle('mpv:subSet', (e, assText) => {
  if (!_mpvClient) return;
  try {
    if (!_mpvSubFile) { ensureTmp(); _mpvSubFile = path.join(TMP, 'subtool-mpv-' + Date.now() + '.ass'); tempFiles.add(_mpvSubFile); }
    fs.writeFileSync(_mpvSubFile, assText || '', 'utf8');
  } catch (e2) { return; }
  if (!_mpvSubAdded) { mpvSend(['sub-add', _mpvSubFile, 'select']); _mpvSubAdded = true; }
  else { mpvSend(['sub-reload']); }
});
// 字幕拖曳時由 renderer 暫時以 DOM 預覽新位置；隱藏 libass 可避免兩份字幕重疊，
// 放開後再重新顯示已同步的 mpv 字幕。影片本身持續可見。
ipcMain.handle('mpv:subVisible', (e, v) => mpvSend(['set_property', 'sub-visibility', !!v]));
/* 影片序列：切換至另一支影片（同一 mpv 實例換檔，沿用 --wid 嵌入視窗與各屬性）。
   loadfile 為非同步：輪詢 duration 直到新檔就緒（最多 8 秒），回傳實測時長。
   pause/mute 等屬性跨 loadfile 保留；播放狀態由 renderer 於 loadfile 後統一設定。 */
ipcMain.handle('mpv:loadfile', async (e, p) => {
  if (!fileAuthority.canRead(p)) { console.warn('[sec] mpv loadfile blocked:', p); return null; }
  if (!_mpvClient) { console.error('[mpv] loadfile: no client'); return null; }
  _mpvSubAdded = false; // 換檔會清空所有軌道（含先前 sub-add 的字幕），重置狀態以確保下次更新時重新 sub-add
  await mpvSend(['set_property', 'pause', true]);
  // 關鍵：啟動時可能帶 --lavfi-complex=[aid1][aid2]...amix（主影片多音軌混音）。
  // 換到音軌數不同的檔案時，該全域濾鏡引用不存在的音軌 → 濾鏡圖失敗、整段無法播放。
  // 換檔前一律清空（新段音訊先走 mpv 預設音軌；元素音軌就緒後會接管並靜音 mpv）。
  await mpvSend(['set_property', 'lavfi-complex', '']);
  console.error('[mpv] loadfile:', p);
  await mpvSend(['loadfile', p, 'replace'], true);
  for (let i = 0; i < 80; i++) {
    const d = await mpvSend(['get_property', 'duration'], true);
    if (typeof d === 'number' && d > 0) return { ok: true, duration: d };
    await new Promise(r => setTimeout(r, 100));
  }
  console.error('[mpv] loadfile: duration not ready after 8s:', p);
  return { ok: false, duration: 0 };
});
ipcMain.handle('mpv:seek',  (e, t) => mpvSend(['seek', t, 'absolute']));
// 與 fs:writeScreenshot 共用同一個能力判斷：副檔名正確仍不能寫進未授權資料夾。
ipcMain.handle('mpv:screenshot', (e, p) => {
  if (!fileAuthority.canWriteScreenshot(p)) { console.warn('[sec] mpv:screenshot blocked (bad ext):', p); return null; }
  if (!_mpvClient) return null;
  fileAuthority.grantTemporaryScreenshotRead(p);
  return mpvSend(['screenshot-to-file', p, 'subtitles']);
});
ipcMain.handle('mpv:play',  ()     => mpvSend(['set_property', 'pause', false]));
ipcMain.handle('mpv:pause', ()     => mpvSend(['set_property', 'pause', true]));
ipcMain.handle('mpv:mute',  (e, v) => mpvSend(['set_property', 'mute', v]));
ipcMain.handle('mpv:rate',  (e, r) => mpvSend(['set_property', 'speed', r]));
ipcMain.handle('mpv:brightness', (e, v) => mpvSend(['set_property', 'brightness', Math.max(-100, Math.min(0, Math.round(v)))])); // 淡出入黑預覽：-100＝最暗、0＝正常
ipcMain.handle('mpv:quit',  () => {
  if (_mpvProc) { try { _mpvProc.kill(); } catch (ee) {} _mpvProc = null; }
  if (_mpvClient) { try { _mpvClient.destroy(); } catch (ee) {} _mpvClient = null; }
  destroyMpvWin();
});
