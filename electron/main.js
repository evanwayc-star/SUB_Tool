/* SUB Tool — Electron 主程序
   提供：原生檔案對話框、系統 ffmpeg/ffprobe（MXF 轉檔、多音軌抽取、波形）、
         專案/字幕直接讀寫磁碟。前端沿用同一份 index.html。 */
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const url = require('url');
const net = require('net');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');

let mainWin = null;
let FFMPEG = null, FFPROBE = null, VENC = null, CACHE = null;
const TMP = path.join(os.tmpdir(), 'subtool_cache');
const tempFiles = new Set();
let tmpSeq = 0;
let _currentIngestProc = null; // S1: 追蹤目前執行中的 ingest ffmpeg，換檔時強制 kill

/* S1：IPC 路徑白名單 — 僅允許存取「快取根」與「使用者本 session 透過對話框開過或
   經 ffmpeg/ffprobe 處理過的媒體所在目錄」。防止 renderer 被惡意字幕/專案檔注入後，
   透過 fs:readB64 / fs:writeProject / fs:fileURL 讀寫磁碟任意位置。
   注意：屬桌面(Electron)專屬強化，需在桌面版實機煙霧測試（開 MXF、存專案、重載含媒體的專案）。 */
const _allowedDirs = new Set();
function allowDir(p) { try { if (p) _allowedDirs.add(path.resolve(p)); } catch (e) {} }
function allowFileDir(p) { try { if (typeof p === 'string' && p) allowDir(path.dirname(p)); } catch (e) {} }
function isAllowedPath(p) {
  if (typeof p !== 'string' || !p) return false;
  let rp; try { rp = path.resolve(p); } catch (e) { return false; }
  const roots = [CACHE, TMP, ..._allowedDirs]
    .filter(Boolean)
    .map(r => { try { return path.resolve(r); } catch (e) { return null; } })
    .filter(Boolean);
  return roots.some(root => rp === root || rp.startsWith(root + path.sep));
}
/* S5：不可猜測的串流 job id（取代 Date.now() / 可推導的 cacheKey） */
function newJobId(prefix) { return prefix + crypto.randomBytes(12).toString('hex'); }

/* ---- 偵測 ffmpeg / ffprobe（優先使用內建版本，fallback 系統安裝） ---- */
function detect(bin, extra) {
  const bundled = [
    path.join(__dirname, 'ffmpeg', `${bin}.exe`),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'electron', 'ffmpeg', `${bin}.exe`),
  ];
  const cands = [...bundled, process.env[bin.toUpperCase() + '_PATH'], bin,
    `C:\\Program Files\\FFMPEG\\bin\\${bin}.exe`,
    `C:\\Program Files\\ffmpeg\\bin\\${bin}.exe`,
    `C:\\ffmpeg\\bin\\${bin}.exe`].concat(extra || []);
  for (const c of cands) {
    if (!c) continue;
    try { const r = spawnSync(c, ['-version'], { timeout: 5000 }); if (r.status === 0) return c; } catch (e) {}
  }
  return null;
}
function ensureTmp() { try { fs.mkdirSync(TMP, { recursive: true }); } catch (e) {} }
function tmpPath(ext) { ensureTmp(); const p = path.join(TMP, `t${Date.now()}_${tmpSeq++}.${ext}`); tempFiles.add(p); return p; }
/* WebContents 可能在視窗關閉後仍被呼叫（例如 mpv pipe close 回呼），必須先確認未銷毀 */
function safeSend(wc, ch, data) {
  try { if (wc && !wc.isDestroyed()) wc.send(ch, data); } catch (e) {}
}
function safeWinSend(win, ch, data) {
  try { if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) win.webContents.send(ch, data); } catch (e) {}
}

/* ---- 偵測可用的硬體視訊編碼器（NVENC/QSV/AMF），否則退回 libx264 ---- */
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
  for (const enc of ['h264_nvenc', 'h264_qsv', 'h264_amf']) { if (test(enc)) return enc; }
  return 'libx264';
}
/* 依選定編碼器回傳「轉檔預覽影片」用的視訊參數（品質導向、yuv420p 由呼叫端的 -vf 負責） */
function vencArgs() {
  switch (VENC) {
    case 'h264_nvenc': return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '26', '-forced-idr', '1'];
    case 'h264_qsv':   return ['-c:v', 'h264_qsv', '-global_quality', '26'];
    case 'h264_amf':   return ['-c:v', 'h264_amf', '-rc', 'cqp', '-qp_i', '26', '-qp_p', '26'];
    default:           return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26'];
  }
}

/* proxy 專用短 GOP（每 0.5s 一個 keyframe）：WebCodecs 預覽 seek 需從最近 keyframe 重解，
   短 GOP 讓任意 seek 幾乎即時；檔案略大可接受（僅 720p proxy，不影響匯出）。 */
function proxyGopArgs() { return ['-force_key_frames', 'expr:gte(t,n_forced*0.5)']; }

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
function metaValid(m) {
  return (!m.proxy || fs.existsSync(m.proxy)) && (m.channels || []).every(c => fs.existsSync(c.file)) && (!m.wave || fs.existsSync(m.wave));
}
/* 讀取快取：回傳第一個檔案完整的 {dir, meta}，否則 null */
function readCache(src) {
  for (const dir of cacheCandidates(src)) {
    const metaPath = path.join(dir, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    try { const m = resolveMeta(JSON.parse(fs.readFileSync(metaPath, 'utf8')), dir); if (metaValid(m)) return { dir, meta: m, routingMetadataComplete: hasRoutingMetadata(m) }; } catch (e) {}
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
      return dir;
    }
  }
  return path.join(CACHE || TMP, cacheKeyFor(src));
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
  if (currentSrc) { try { const ndir = path.join(path.dirname(currentSrc), '.subtool_Cache', cacheKeyFor(currentSrc)); if (fs.existsSync(ndir)) { bytes += dirSize(ndir); fs.rmSync(ndir, { recursive: true, force: true }); } } catch (e) {} }
  return { bytes };
}

/* S2: 有 GPU 編碼器時啟用來源端硬體解碼（加速讀取 4K/MXF），對 -i 前插入 */
function hwdecArgs() { return VENC && VENC !== 'libx264' ? ['-hwaccel', 'auto'] : []; }

/* ---- 執行 ffmpeg，並回報進度 ---- */
function runFF(args, { onProgress, duration, sender, jobId, label, onProcess, cwd } = {}) {
  return new Promise((res, rej) => {
    if (!FFMPEG) return rej(new Error('找不到 ffmpeg'));
    const p = spawn(FFMPEG, args, cwd ? { cwd } : {});
    if (onProcess) onProcess(p);
    let err = '';       // 尾端（錯誤訊息用；會被截斷）
    const maps = [];    // 串流對應行（出現在輸出開頭，需單獨保留，否則被 err 截斷丟失）
    p.stderr.on('data', d => {
      const s = d.toString(); err += s; if (err.length > 8000) err = err.slice(-8000);
      // 例：Stream #0:0 -> #0:0 (mpeg2video (native) -> h264 (h264_nvenc))
      for (const mm of s.matchAll(/Stream #\d+:\d+ -> #\d+:\d+ \(([^\n]*)\)/g)) if (maps.length < 8) maps.push(mm[1]);
      const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
      if (m && duration && sender) {
        const t = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
        safeSend(sender, 'task-progress', { jobId, label, pct: Math.min(99, Math.round(t / duration * 100)) });
      }
    });
    p.on('error', rej);
    p.on('close', c => {
      if (sender) safeSend(sender, 'task-progress', { jobId, label, pct: 100, done: true });
      c === 0 ? res({ tail: err, maps }) : rej(new Error('ffmpeg 結束碼 ' + c + '\n' + err.slice(-600)));
    });
  });
}

/* ---- 視窗 ---- */
function createWindow() {
  mainWin = new BrowserWindow({
    width: 1480, height: 920, minWidth: 1024, minHeight: 640,
    backgroundColor: '#1b1b1d', autoHideMenuBar: true,
    title: `SUB TOOL v${app.getVersion()}`,
    icon: path.join(__dirname, 'logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      webSecurity: false // 本機信任程式：允許 file:// 影音直接讀取
    }
  });
  mainWin.maximize();
  // 讓嵌入式 mpv 覆蓋視窗跟著主視窗移動 / 縮放 / 最小化
  const reapplyMpv = () => { if (_mpvWin && !_mpvWin.isDestroyed() && _mpvVisible && _mpvRect) applyMpvBounds(_mpvRect); };
  mainWin.on('move', reapplyMpv);
  mainWin.on('resize', reapplyMpv);
  mainWin.on('restore', () => { if (_mpvWin && !_mpvWin.isDestroyed() && _mpvVisible) { try { _mpvWin.show(); } catch (e) {} reapplyMpv(); } });
  mainWin.on('minimize', () => { if (_mpvWin && !_mpvWin.isDestroyed()) { try { _mpvWin.hide(); } catch (e) {} } });
  let isClosing = false;
  mainWin.on('close', (e) => {
    if (!isClosing && mainWin.webContents) {
      e.preventDefault();
      mainWin.webContents.send('app:request-close');
    }
  });
  mainWin.on('closed', () => { destroyMpvWin(); });
  ipcMain.handle('app:close', () => {
    isClosing = true;
    if (mainWin && !mainWin.isDestroyed()) mainWin.close();
  });
  // S2：補齊 Electron 安全基線 — 拒絕開新視窗、限制導航只能停在本機應用頁（與 dev 的 localhost）
  mainWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWin.webContents.on('will-navigate', (ev, u) => {
    if (!(u.startsWith('file:') || u.startsWith('http://localhost:8777'))) ev.preventDefault();
  });
  if (process.argv.includes('--dev')) {
    mainWin.loadURL('http://localhost:8777'); // 需先執行 npm run dev
    mainWin.webContents.openDevTools({ mode: 'detach' });
  } else {
    const built = path.join(__dirname, '..', 'dist', 'index.html');
    const legacy = path.join(__dirname, '..', 'index.html');
    mainWin.loadFile(fs.existsSync(built) ? built : legacy);
  }
}

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
      const tryRange = (n) => {
        let sz = 0; try { sz = fs.statSync(job.filePath).size; } catch (e) {}
        if (sz <= start && !job.done && n < 120) { setTimeout(() => tryRange(n + 1), 500); return; }
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
      tryRange(0);
    });
    _hSrv.listen(0, '127.0.0.1', () => { _hPort = _hSrv.address().port; resolve(_hPort); });
    _hSrv.on('error', reject);
  });
}

let startupFile = null;
app.on('open-file', (e, path) => {
  e.preventDefault();
  startupFile = path;
  allowFileDir(path);
  if (mainWin) mainWin.webContents.send('app:open-file', path);
});

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
      const fileArg = commandLine.find(a => !a.startsWith('-') && (a.endsWith('.subtool') || a.endsWith('.json')));
      if (fileArg) {
        allowFileDir(fileArg);
        mainWin.webContents.send('app:open-file', fileArg);
      }
    }
  });

  app.whenReady().then(() => {
    FFMPEG = detect('ffmpeg');
    FFPROBE = detect('ffprobe');
    VENC = detectVideoEncoder();
    CACHE = path.join(app.getPath('userData'), 'mediacache');
    try { fs.mkdirSync(CACHE, { recursive: true }); } catch (e) {}
    try { cleanOrphans(); } catch (e) {} // 啟動時自動清除無效快取（例如上次轉檔中斷的孤兒資料夾）
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
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
    allowFileDir(fileToOpen);
    return fileToOpen;
  }
  return null;
});

ipcMain.handle('app:status', () => ({
  isDesktop: true, ffmpeg: !!FFMPEG, ffprobe: !!FFPROBE,
  ffmpegPath: FFMPEG, ffprobePath: FFPROBE, venc: VENC
}));

ipcMain.handle('fs:fileURL', (e, p) => { if (typeof p !== 'string' || !p) return null; allowFileDir(p); try { return url.pathToFileURL(p).href; } catch (err) { return null; } });
ipcMain.handle('fs:stat', (e, p) => { try { const s = fs.statSync(p); return { exists: true, size: s.size }; } catch (err) { return { exists: false }; } });
ipcMain.handle('fs:listDir', (e, p) => { try { return fs.readdirSync(p); } catch (err) { return []; } });

ipcMain.handle('dialog:openMedia', async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: '匯入影片或音訊檔', properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '影音或圖片', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'mxf', 'avi', 'm2ts', 'mts', 'ts', 'wmv', 'webm', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'aif', 'aiff', 'jpg', 'jpeg', 'png'] },
      { name: '全部', extensions: ['*'] }
    ]
  });
  if (r.canceled) return null;
  r.filePaths.forEach(allowFileDir); // S1：所有選取媒體來源都加入白名單
  // 保持單選時的舊字串回傳值，讓專案遺失主影片的既有重選流程可無修改地繼續使用。
  return r.filePaths.length===1 ? r.filePaths[0] : r.filePaths;
});
ipcMain.handle('dialog:openAudio', async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: '加入音軌檔', properties: ['openFile', 'multiSelections'],
    filters: [{ name: '音訊', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg'] }]
  });
  if (r.canceled) return [];
  r.filePaths.forEach(allowFileDir); // S1
  return r.filePaths;
});

ipcMain.handle('dialog:openProject', async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: '開啟專案', properties: ['openFile'],
    filters: [{ name: 'SUB Tool 專案', extensions: ['subtool', 'json'] }]
  });
  if (r.canceled) return null;
  allowFileDir(r.filePaths[0]); // S1：專案目錄（含旁邊的媒體/autosave）加入白名單
  const buf = fs.readFileSync(r.filePaths[0]);
  return { path: r.filePaths[0], b64: buf.toString('base64') };
});
ipcMain.handle('dialog:saveProject', async (e, { name, b64 }) => {
  const r = await dialog.showSaveDialog(mainWin, { title: '儲存專案', defaultPath: name, filters: [{ name: 'SUB Tool 專案', extensions: ['subtool'] }] });
  if (r.canceled) return null;
  allowFileDir(r.filePath); // S1
  fs.writeFileSync(r.filePath, Buffer.from(b64, 'base64'));
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
  const root = fontsRoot() || path.join(process.resourcesPath || path.join(__dirname, '..'), 'font');
  try {
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
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
function proresArgs() { return ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le', '-c:a', 'pcm_s16le']; }
/* 匯出用的 H.264 參數：以「目標位元率」編碼（vencArgs() 是畫質模式 CQ/CRF，供轉檔 proxy 用，不可混用）。
   各編碼器的速率控制旗標不同；maxrate=目標、bufsize=2×目標 → 近似封頂 VBR，位元率穩定可預測。 */
function vencArgsBitrate(kbps) {
  const b = kbps + 'k', buf = (kbps * 2) + 'k';
  switch (VENC) {
    case 'h264_nvenc': return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-b:v', b, '-maxrate', b, '-bufsize', buf];
    case 'h264_qsv':   return ['-c:v', 'h264_qsv', '-b:v', b, '-maxrate', b, '-bufsize', buf];
    case 'h264_amf':   return ['-c:v', 'h264_amf', '-rc', 'vbr_peak', '-b:v', b, '-maxrate', b, '-bufsize', buf];
    default:           return ['-c:v', 'libx264', '-preset', 'veryfast', '-b:v', b, '-maxrate', b, '-bufsize', buf];
  }
}
function hasAudioStream(p) {
  try { const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', p], { timeout: 8000 }); return !!(r.stdout && r.stdout.toString().trim()); }
  catch (e) { return true; } // 探測失敗時假設有音訊（較常見）
}

/* ===== 專案音訊輸出（v4.36） =====
   audioPlan 將「來源檔案」與「專案匯流排」分開：
   - buses：每一條都是單聲道專案輸出，inputs 可在同一 bus 內混音；
   - streams：影片容器內的音訊 stream，將 bus 依 Mono / Stereo / LtRt / 5.1 編組。
   不把使用者提供的 id / 路徑塞進 filtergraph：id 只用於 Map 查找，filter label 一律由索引產生；
   路徑則是獨立的 spawn argv。這同時避免 Windows 路徑跳脫問題與 filter injection。 */
const _EXPORT_LAYOUTS = Object.freeze({
  mono:       { channels: 1, channelLayout: 'mono',       channelNames: ['FC'],                             title: 'Mono' },
  stereo:     { channels: 2, channelLayout: 'stereo',     channelNames: ['FL', 'FR'],                       title: 'Stereo' },
  stereoLtRt: { channels: 2, channelLayout: 'stereo',     channelNames: ['FL', 'FR'],                       title: 'Stereo Lt/Rt' },
  // 注意：5.1 聲道在 FFmpeg 必須使用標準的 '5.1' 配置 (搭配 BL, BR) 而非 '5.1(side)' (搭配 SL, SR)。
  // 若使用 '5.1(side)'，AAC 編碼器會被迫啟用 PCE (Program Config Element) 標記非標準聲道位置，
  // 導致極多主流播放器與剪輯軟體（如 Premiere Pro）無法解碼而變成靜音。
  '5.1':      { channels: 6, channelLayout: '5.1',        channelNames: ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'], title: '5.1 (L, R, C, LFE, Ls, Rs)' },
});
/* WAV 的多聲道檔本質上仍是一條 interleaved stream；保留 bus 順序並以 WAVEFORMATEXTENSIBLE
   可辨識的 channel mask 寫出。18 軌是使用者明確需要的情境，這份清單涵蓋到 32 軌。 */
const _WAV_CHANNEL_ORDER = Object.freeze([
  'FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'FLC', 'FRC', 'BC', 'SL', 'SR', 'TC',
  'TFL', 'TFC', 'TFR', 'TBL', 'TBC', 'TBR', 'WL', 'WR', 'SDL', 'SDR', 'LFE2',
  'TSL', 'TSR', 'BFC', 'BFL', 'BFR', 'SSL', 'SSR', 'TTL', 'TTR',
]);
function _finiteNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function _filterNumber(v, fallback = 0) { return _finiteNumber(v, fallback).toFixed(6); }
/* stream.name 是可持久化的交付預設名稱（例如「M&E」、「5.1 主混音」）；它只作為
   container metadata 傳給 ffmpeg argv，仍移除控制字元並限制長度，絕不進入 filtergraph。 */
function _streamMetadataName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 255);
}
function _exportPlanError(message) { throw new Error('音訊輸出設定錯誤：' + message); }
function _normalizeAudioPlan(raw, { requireStreams = true } = {}) {
  if (raw == null) return null;
  if (!raw || !Array.isArray(raw.buses) || (requireStreams && !Array.isArray(raw.streams)))
    _exportPlanError(requireStreams ? '缺少 buses 或 streams。' : '缺少 buses。');
  if (!raw.buses.length) _exportPlanError('至少需要一條專案音軌。');

  const ids = new Set();
  const buses = raw.buses.map((bus, bi) => {
    const id = typeof bus?.id === 'string' ? bus.id : '';
    if (!id) _exportPlanError(`第 ${bi + 1} 條專案音軌沒有 id。`);
    if (ids.has(id)) _exportPlanError(`專案音軌 id 重複：${id}`);
    ids.add(id);
    const inputs = (Array.isArray(bus.inputs) ? bus.inputs : []).map((input, ii) => {
      if (!input || typeof input.file !== 'string' || !input.file) _exportPlanError(`音軌 ${bi + 1} 的輸入 ${ii + 1} 缺少檔案。`);
      const trimStart = Math.max(0, _finiteNumber(input.trimStart, 0));
      const hasTrimEnd = input.trimEnd != null && input.trimEnd !== '';
      const trimEnd = hasTrimEnd ? Math.max(0, _finiteNumber(input.trimEnd, 0)) : null;
      if (trimEnd != null && trimEnd <= trimStart) _exportPlanError(`音軌 ${bi + 1} 的輸入 ${ii + 1} 範圍無效。`);
      return {
        file: input.file,
        offset: Math.max(0, _finiteNumber(input.offset, 0)),
        trimStart,
        trimEnd,
        volume: Math.max(0, Math.min(64, _finiteNumber(input.volume, 1))),
        fadeIn: Math.max(0, _finiteNumber(input.fadeIn, 0)),
        fadeOut: Math.max(0, _finiteNumber(input.fadeOut, 0)),
      };
    });
    return { id, inputs };
  });

  const rawStreams = Array.isArray(raw.streams) ? raw.streams : [];
  if (requireStreams && !rawStreams.length) _exportPlanError('至少需要一條輸出音訊 stream。');
  const streamIds = new Set();
  const assignedBusIds = new Set();
  /* 純 WAV 交付只取 buses 的順序，不應因影片輸出編組尚在編輯（例如 5.1 還少一條 bus）
     而失敗；影片匯出才驗證 streams 的 layout / bus 數。 */
  const streams = (requireStreams ? rawStreams : []).map((stream, si) => {
    const id = typeof stream?.id === 'string' && stream.id ? stream.id : `stream-${si + 1}`;
    if (streamIds.has(id)) _exportPlanError(`輸出 stream id 重複：${id}`);
    streamIds.add(id);
    const layout = String(stream?.layout || '');
    const spec = _EXPORT_LAYOUTS[layout];
    if (!spec) _exportPlanError(`不支援的輸出格式：${layout || '（空白）'}。`);
    const busIds = Array.isArray(stream?.busIds) ? stream.busIds : [];
    if (busIds.length !== spec.channels) _exportPlanError(`${spec.title} 需要 ${spec.channels} 條專案音軌。`);
    if (new Set(busIds).size !== busIds.length) _exportPlanError(`${spec.title} 不能重複使用同一條專案音軌。`);
    for (const busId of busIds) {
      if (!ids.has(busId)) _exportPlanError(`輸出 stream 引用了不存在的專案音軌：${String(busId)}`);
      if (assignedBusIds.has(busId)) _exportPlanError(`專案音軌不能同時指派到多條輸出 stream：${String(busId)}`);
      assignedBusIds.add(busId);
    }
    return { id, name: _streamMetadataName(stream?.name), layout, busIds, spec };
  });
  return { buses, streams };
}
function _planDuration(plan) {
  let end = 0;
  for (const bus of plan?.buses || []) for (const input of bus.inputs || []) {
    if (input.trimEnd != null) end = Math.max(end, input.offset + Math.max(0, input.trimEnd - input.trimStart));
  }
  return end;
}
function _joinFilter(inputLabels, channelLayout, channelNames, outputLabel) {
  const mapping = channelNames.map((name, i) => `${i}.0-${name}`).join('|');
  return `${inputLabels.join('')}join=inputs=${inputLabels.length}:channel_layout=${channelLayout}:map=${mapping}${outputLabel}`;
}
/* 將 plan buses 編譯成 ffmpeg filtergraph。每個輸入都以自己的一份 -i 載入：同一來源可合法
   路由到多條 bus 且各自有不同的 trim / fade，無需依賴脆弱的 asplit 標籤管理。 */
function _buildPlannedAudio(plan, inputs, fc, inputIndex, duration) {
  const busLabels = new Map();
  let ii = inputIndex;
  const audioInputMap = new Map();
  plan.buses.forEach((bus, bi) => {
    const parts = [];
    bus.inputs.forEach((input, pi) => {
      let mappedIdx = audioInputMap.get(input.file);
      if (mappedIdx === undefined) {
        mappedIdx = ii++;
        inputs.push('-i', input.file);
        audioInputMap.set(input.file, mappedIdx);
      }
      const label = `[apB${bi}I${pi}]`;
      let chain = `[${mappedIdx}:a]atrim=start=${_filterNumber(input.trimStart)}`;
      if (input.trimEnd != null) chain += `:end=${_filterNumber(input.trimEnd)}`;
      // 移除 pan=mono|c0=c0 避免立體聲來源只取左聲道導致音量減半或無聲，改由 aformat 自動 downmix
      chain += ',asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono';
      if (Math.abs(input.volume - 1) > 0.000001) chain += `,volume=${_filterNumber(input.volume, 1)}`;
      const inputDuration = input.trimEnd == null ? null : input.trimEnd - input.trimStart;
      const fadeIn = inputDuration == null ? input.fadeIn : Math.min(input.fadeIn, inputDuration);
      const fadeOut = inputDuration == null ? 0 : Math.min(input.fadeOut, inputDuration);
      if (fadeIn > 0) chain += `,afade=t=in:st=0:d=${_filterNumber(fadeIn)}`;
      if (fadeOut > 0) chain += `,afade=t=out:st=${_filterNumber(Math.max(0, inputDuration - fadeOut))}:d=${_filterNumber(fadeOut)}`;
      const offMs = Math.max(0, Math.round(input.offset * 1000));
      chain += `,adelay=${offMs}:all=1,atrim=0:${_filterNumber(duration)},asetpts=PTS-STARTPTS${label}`;
      fc.push(chain);
      parts.push(label);
    });
    const busLabel = `[apB${bi}]`;
    if (parts.length) {
      fc.push(`${parts.join('')}amix=inputs=${parts.length}:normalize=0:dropout_transition=0,atrim=0:${_filterNumber(duration)},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono${busLabel}`);
    } else {
      fc.push(`anullsrc=r=48000:cl=mono,atrim=0:${_filterNumber(duration)},asetpts=PTS-STARTPTS${busLabel}`);
    }
    busLabels.set(bus.id, busLabel);
  });
  const streamLabels = [];
  plan.streams.forEach((stream, si) => {
    const inputLabels = stream.busIds.map(id => busLabels.get(id));
    let label;
    if (stream.spec.channels === 1) label = inputLabels[0];
    else {
      label = `[apS${si}]`;
      fc.push(_joinFilter(inputLabels, stream.spec.channelLayout, stream.spec.channelNames, label));
    }
    streamLabels.push({ label, stream });
  });
  return { inputIndex: ii, busLabels, streamLabels };
}
function _buildWavOutput(busLabels, plan, fc) {
  const labels = plan.buses.map(bus => busLabels.get(bus.id));
  if (labels.length === 1) return { label: labels[0], channels: 1 };
  if (labels.length > _WAV_CHANNEL_ORDER.length)
    _exportPlanError(`WAV 單檔目前最多可輸出 ${_WAV_CHANNEL_ORDER.length} 條獨立 mono 音軌。`);
  const names = _WAV_CHANNEL_ORDER.slice(0, labels.length);
  const label = '[wavOut]';
  fc.push(_joinFilter(labels, names.join('+'), names, label));
  return { label, channels: labels.length };
}
ipcMain.handle('ffmpeg:exportVideo', async (e, { clips, videoTracks, width, height, fps, assText, format, duration, defaultName, outPath: presetOut, videoKbps, audioPlan: rawAudioPlan }) => {
  if (!FFMPEG) throw new Error('找不到 ffmpeg');
  const isWav = format === 'wav';
  const audioPlan = _normalizeAudioPlan(rawAudioPlan, { requireStreams: !isWav });
  const isPro = format === 'prores';
  const ext = isWav ? 'wav' : (isPro ? 'mov' : 'mp4');
  let outPath = presetOut || null; // 有指定輸出路徑則跳過對話框（測試/批次用）
  if (!outPath) {
    const r = await dialog.showSaveDialog(mainWin, {
      title: isWav ? '匯出音訊' : '匯出影片', defaultPath: (defaultName || 'sequence') + '.' + ext,
      filters: [{ name: isWav ? 'WAV 多聲道 PCM' : (isPro ? 'ProRes 422 HQ (MOV)' : 'MP4 (H.264)'), extensions: [ext] }],
    });
    if (r.canceled) return null;
    outPath = r.filePath;
  }
  allowFileDir(outPath);
  (clips || []).forEach(c => { if (c.path) allowFileDir(c.path); (c.audio || []).forEach(a => a.file && allowFileDir(a.file)); });
  for (const bus of audioPlan?.buses || []) for (const input of bus.inputs || []) allowFileDir(input.file);

  const planDuration = _planDuration(audioPlan);
  const D = Math.max(0.05, _finiteNumber(duration, 0), planDuration);
  ensureTmp();
  /* WAV 是純音訊交付：所有 project buses 依 bus 順序合成一條 multichannel PCM stream；
     exportLayout.streams 僅作用於影片容器的多 stream 輸出，故這裡刻意不採用它。 */
  if (isWav) {
    if (!audioPlan) _exportPlanError('WAV 匯出需要專案音軌路由資料。');
    const inputs = [], fc = [];
    const planned = _buildPlannedAudio(audioPlan, inputs, fc, 0, D);
    const wav = _buildWavOutput(planned.busLabels, audioPlan, fc);
    /* 不要加 -ac：它會把 16/18 軌等自訂 WAVEFORMATEXTENSIBLE layout 強制改成通用
       "N channels"，部分 ffmpeg/libswresample 版本會因此拒絕輸出。join 的輸出 layout
       已精確帶有 bus 順序與 channel mask。 */
    const args = ['-y', ...inputs, '-filter_complex', fc.join(';'), '-map', wav.label,
      '-ar', '48000', '-c:a', 'pcm_s24le', outPath];
    const t0 = Date.now();
    await runFF(args, { sender: e.sender, duration: D, jobId: 'export', label: `匯出 WAV PCM（${wav.channels} 軌）` });
    return { outPath, encoder: 'pcm_s24le', gpu: false, elapsedMs: Date.now() - t0, videoKbps: null, audioChannels: wav.channels };
  }

  const W = Math.max(2, Math.round(width || 1920)), H = Math.max(2, Math.round(height || 1080));
  const R = fps || 25;
  // ===== 多軌合成 filtergraph（v4.11.0）=====
  //  影像：每視訊軌各自 concat 成整條時間軸（片段放 offset、間隙【透明】），再由下而上 overlay 疊到黑底；
  //        上層片段覆蓋下層（比照預覽 top-occludes），透明間隙讓下層透出。
  //  音訊：所有片段各自套混音器音量後 adelay 到自身 offset，再全部 amix（全軌混音）。
  //  單軌、無重疊的序列＝此法之特例，結果與舊版 concat 相同。
  const list = clips || [];
  if (!list.length) throw new Error('沒有可匯出的影片段');
  const inputs = [], fc = [];
  const EPS = 0.01;
  // 1) 去重複輸入：同一個實體檔案只開啟一次，避免建立過多 hwaccel 實例耗盡 VRAM
  // 並且計算每個實體檔案最早被用到的時間（minIn），用 -ss 加在 -i 前，避免 ffmpeg 從 0 開始慢速解碼 44GB 大檔！
  const uniqueVideoPaths = [...new Set(list.map(c => c.path))];
  const pathMinIn = new Map();
  uniqueVideoPaths.forEach(p => {
    const clipsForPath = list.filter(c => c.path === p);
    const isImg = clipsForPath[0].type === 'image';
    if (isImg) {
      pathMinIn.set(p, 0);
      inputs.push('-loop', '1', '-i', p);
    } else {
      const minIn = Math.max(0, Math.min(...clipsForPath.map(c => c.in)) - 0.5);
      pathMinIn.set(p, minIn);
      inputs.push(...hwdecArgs(), '-ss', minIn.toFixed(3), '-i', p);
    }
  });
  const videoInputIndices = list.map(c => uniqueVideoPaths.indexOf(c.path));
  let ii = uniqueVideoPaths.length; // 之後的逐聲道音訊檔輸入從此接續編號
  // 2) 黑底 + 逐視訊軌整條時間軸 → 由下而上 overlay（各軌可有 縮放/位置/透明度＝子母畫面 PiP）
  fc.push(`color=c=black:s=${W}x${H}:r=${R}:d=${D.toFixed(3)},format=yuv420p,setsar=1[base]`);
  const vtracks = (videoTracks && videoTracks.length) ? videoTracks : [{ vt: 0 }];
  let baseLabel = '[base]';
  vtracks.forEach((T, ti) => {
    const vt = T.vt || 0;
    const scale = Math.max(0.02, Math.min(1, +T.scale || 1));
    const opacity = Math.max(0, Math.min(1, T.opacity == null ? 1 : +T.opacity));
    const px = Math.max(0, Math.min(1, T.posX == null ? 0.5 : +T.posX));
    const py = Math.max(0, Math.min(1, T.posY == null ? 0.5 : +T.posY));
    const SW = Math.max(2, Math.round(scale * W)), SH = Math.max(2, Math.round(scale * H)); // 此軌影格尺寸（PiP 時縮小）
    const trk = list.map((c, i) => ({ c, i, vIdx: videoInputIndices[i] })).filter(x => (x.c.vtrack || 0) === vt).sort((a, b) => a.c.offset - b.c.offset);
    if (!trk.length) return;
    const segs = []; let cursor = 0, si = 0;
    const gap = (gd) => { const L = `t${ti}s${si++}`; fc.push(`color=c=black@0.0:s=${SW}x${SH}:r=${R}:d=${(+gd).toFixed(3)},format=yuva420p,setsar=1[${L}]`); segs.push(`[${L}]`); };
    for (const { c, i, vIdx } of trk) {
      if (c.offset > cursor + EPS) gap(c.offset - cursor);
      const L = `t${ti}s${si++}`;
      const fi = Math.max(0, +c.fadeIn || 0), fo = Math.max(0, +c.fadeOut || 0), clen = Math.max(0.001, c.out - c.in);
      const minIn = pathMinIn.get(c.path);
      const adjIn = c.in - minIn;
      const adjOut = c.out - minIn;
      
      let vchain = '';
      if (c.type === 'image') {
        const clipScale = c.scale ?? 1;
        const cw = Math.max(2, Math.round(clipScale * SW));
        const ch = Math.max(2, Math.round(clipScale * SH));
        const pxClip = c.posX ?? 0.5;
        const pyClip = c.posY ?? 0.5;
        const padX = Math.round(pxClip * SW - cw / 2);
        const padY = Math.round(pyClip * SH - ch / 2);
        vchain = `[${vIdx}:v]trim=start=${adjIn}:end=${adjOut},setpts=PTS-STARTPTS,fps=${R},scale=${cw}:${ch}:force_original_aspect_ratio=decrease,format=yuva420p,pad=${SW}:${SH}:${padX}:${padY}:color=black@0.0,setsar=1`;
      } else {
        vchain = `[${vIdx}:v]trim=start=${adjIn}:end=${adjOut},setpts=PTS-STARTPTS,fps=${R},scale=${SW}:${SH}:force_original_aspect_ratio=decrease,format=yuva420p,pad=${SW}:${SH}:(ow-iw)/2:(oh-ih)/2:color=black@0.0,setsar=1`;
      }
      
      // 轉場：淡入/淡出（fade alpha＝淡到透明，讓下層/黑底露出→軌間溶接）
      if (fi > 0) vchain += `,fade=t=in:st=0:d=${Math.min(fi, clen).toFixed(3)}:alpha=1`;
      if (fo > 0) vchain += `,fade=t=out:st=${Math.max(0, clen - Math.min(fo, clen)).toFixed(3)}:d=${Math.min(fo, clen).toFixed(3)}:alpha=1`;
      fc.push(`${vchain}[${L}]`);
      segs.push(`[${L}]`);
      cursor = c.offset + Math.max(0.001, c.out - c.in);
    }
    if (cursor < D - EPS) gap(D - cursor);
    let trkLabel;
    if (segs.length > 1) { trkLabel = `[trkV${ti}]`; fc.push(`${segs.join('')}concat=n=${segs.length}:v=1:a=0${trkLabel}`); }
    else { trkLabel = segs[0]; }
    if (opacity < 0.999) { const ol = `[trkO${ti}]`; fc.push(`${trkLabel}format=yuva420p,colorchannelmixer=aa=${opacity.toFixed(3)}${ol}`); trkLabel = ol; } // 透明度
    const out = `[ov${ti}]`;
    // 位置：px/py 0..1 → 以 overlay 表達式對映（scale=1 時 W-w=0＝滿版；PiP 時定位縮小影格）
    fc.push(`${baseLabel}${trkLabel}overlay=x=(W-w)*${px.toFixed(4)}:y=(H-h)*${py.toFixed(4)}:eof_action=pass:format=auto${out}`);
    baseLabel = out;
  });
  const vc = baseLabel; // 疊層後的最終影像標籤
  // 3) 音訊：有 project audioPlan 時，依 bus / stream 路由輸出；沒有時完整保留舊版
  // 「所有來源混成一條 stereo」的行為，讓既有專案與自動化呼叫不受影響。
  let plannedAudio = null;
  const audioInputMap = new Map();
  if (audioPlan) {
    plannedAudio = _buildPlannedAudio(audioPlan, inputs, fc, ii, D);
  } else {
    const aLabels = [];
    list.forEach((c, i) => {
      let al = null;
      if (Array.isArray(c.audio)) {
        if (!c.audio.length) return; // 全靜音 → 此片段不發聲
        const mono = [];
        c.audio.forEach((ch, j) => {
          let mappedIdx = audioInputMap.get(ch.file);
          if (mappedIdx === undefined) { mappedIdx = ii++; inputs.push('-i', ch.file); audioInputMap.set(ch.file, mappedIdx); }
          fc.push(`[${mappedIdx}:a]atrim=start=${c.in}:end=${c.out},asetpts=PTS-STARTPTS,aresample=48000,volume=${ch.volume}[am${i}_${j}]`);
          mono.push(`[am${i}_${j}]`);
        });
        al = `[aa${i}]`;
        fc.push(mono.length > 1
          ? `${mono.join('')}amix=inputs=${mono.length}:normalize=0,aformat=sample_fmts=fltp:channel_layouts=stereo${al}`
          : `${mono[0]}aformat=sample_fmts=fltp:channel_layouts=stereo${al}`);
      } else if (hasAudioStream(c.path)) {
        al = `[aa${i}]`;
        fc.push(`[${videoInputIndices[i]}:a]atrim=start=${c.in}:end=${c.out},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${al}`);
      } else return;
      const offMs = Math.max(0, Math.round((c.offset || 0) * 1000));
      // 轉場：音訊淡入/淡出（與影像同步）
      const afi = Math.max(0, +c.fadeIn || 0), afo = Math.max(0, +c.fadeOut || 0), aclen = Math.max(0.001, c.out - c.in);
      const afParts = [];
      if (afi > 0) afParts.push(`afade=t=in:st=0:d=${Math.min(afi, aclen).toFixed(3)}`);
      if (afo > 0) afParts.push(`afade=t=out:st=${Math.max(0, aclen - Math.min(afo, aclen)).toFixed(3)}:d=${Math.min(afo, aclen).toFixed(3)}`);
      let asrc = al;
      if (afParts.length) { const afl = `[af${i}]`; fc.push(`${al}${afParts.join(',')}${afl}`); asrc = afl; }
      fc.push(`${asrc}adelay=${offMs}:all=1[ad${i}]`);
      aLabels.push(`[ad${i}]`);
    });
    if (aLabels.length) fc.push(`${aLabels.join('')}amix=inputs=${aLabels.length}:normalize=0:dropout_transition=0,atrim=0:${D.toFixed(3)},aresample=48000[ac]`);
    else fc.push(`anullsrc=r=48000:cl=stereo,atrim=0:${D.toFixed(3)},asetpts=PTS-STARTPTS[ac]`);
  }

  // 燒錄字幕（可見軌）：ass 濾鏡讀取暫存 .ass；以 cwd=TMP + basename 引用避開路徑跳脫
  let vfinal = vc, assName = null;
  if (assText && assText.trim()) {
    assName = 'export_' + Date.now() + '.ass';
    fs.writeFileSync(path.join(TMP, assName), assText, 'utf8');
    // v4.25.4：fontsdir 指向 <專案根>/font → 燒錄用的字型與預覽（FontFace 同一批檔）一致，
    // 不必先安裝到系統。
    // ── 磁碟機冒號要跳【兩層】(v4.31.2 修)：filtergraph 先拆選項、選項值再拆一次，
    //    所以字面上得是 `C\\:/...`。只寫一個反斜線（舊版）→ ffmpeg 把 `:` 當成選項分隔符、
    //    整條 filterchain 解析失敗 → 匯出直接掛掉。此路徑僅在 font/ 存在時才加。
    const fdir = fontsRoot();
    const fdirArg = fdir ? ':fontsdir=' + fdir.replace(/\\/g, '/').replace(/:/g, '\\\\:') : '';
    fc.push(`${vc}ass=${assName}${fdirArg}[vout]`);
    vfinal = '[vout]';
  }

  // MP4：以使用者指定的目標位元率編碼（音訊固定 192k AAC）；ProRes 為固定品質，無位元率設定
  const kbps = Math.max(100, Math.min(200000, Math.round(videoKbps || 5000)));
  const encode = isPro ? proresArgs() : [...vencArgsBitrate(kbps), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'];
  const audioMaps = plannedAudio
    ? plannedAudio.streamLabels.flatMap(({ label }) => ['-map', label])
    : ['-map', '[ac]'];
  /* Lt/Rt 與普通 stereo 的 codec channel layout 都是 FL/FR；以 stream metadata 明確標示，
     方便剪輯軟體／檢視工具辨識交付意圖，不會把 Lt/Rt 誤標為離散 L/R。 */
  const audioMetadata = plannedAudio
    ? plannedAudio.streamLabels.flatMap(({ stream }, i) => ['-metadata:s:a:' + i, 'title=' + (stream.name || stream.spec.title)])
    : [];
  const args = ['-y', ...inputs, '-filter_complex', fc.join(';'), '-map', vfinal, ...audioMaps, '-r', String(R), ...encode, ...audioMetadata, outPath];

  // 進度標籤即顯示本次實際送出的編碼器（GPU 或 CPU）與位元率，使用者在狀態列就看得到
  const planned = isPro ? 'prores_ks' : (VENC || 'libx264');
  const isGpu = !isPro && planned !== 'libx264';
  const accel = isGpu ? 'GPU ' + planned.replace('h264_', '').toUpperCase() : 'CPU ' + planned;
  const label = `匯出 ${isPro ? 'ProRes 422 HQ' : 'MP4 ' + (kbps / 1000).toFixed(1) + 'Mbps'}（${accel}）`;
  let usedEncoder = planned;
  const t0 = Date.now();
  try {
    const rr = await runFF(args, { sender: e.sender, duration: duration || 0, jobId: 'export', label, cwd: TMP });
    // ffmpeg 的串流對應行是「實際使用」的地面真相（非我們的猜測）：
    //   例 "mpeg2video (native) -> h264 (h264_nvenc)" → 取箭頭右側括號內的編碼器
    const vmap = (rr.maps || []).find(m => /->/.test(m) && /h264|prores|hevc/i.test(m));
    const em = vmap && /->\s*[^(]*\(([^)]+)\)\s*$/.exec(vmap.trim());
    if (em) usedEncoder = em[1].trim();
  } finally {
    if (assName) { try { fs.unlinkSync(path.join(TMP, assName)); } catch (e2) {} }
  }
  // 回傳 ffmpeg 實際使用的編碼器與耗時，供 renderer 顯示「這次真的用了 GPU 沒有」
  return { outPath, encoder: usedEncoder, gpu: /nvenc|qsv|amf|videotoolbox|vaapi/i.test(usedEncoder), elapsedMs: Date.now() - t0, videoKbps: isPro ? null : kbps };
});

ipcMain.handle('dialog:importDirectory', async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: '選擇匯入資料夾',
    properties: ['openDirectory']
  });
  if (r.canceled || r.filePaths.length === 0) return null;
  const dir = r.filePaths[0];
  allowDir(dir);
  const files = [];
  function scan(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) scan(p);
      else if (f.endsWith('.json')) {
        files.push({ name: f, b64: fs.readFileSync(p).toString('base64') });
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
  allowDir(dir);
  for (const f of files) {
    const data = f.content || f.b64;
    if (f.name && data) {
      const fullPath = path.join(dir, f.name);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, Buffer.from(data, 'base64'));
    }
  }
  return dir;
});

/* ---- 快取管理 ---- */
ipcMain.handle('cache:info', () => cacheInfo());
ipcMain.handle('cache:cleanOrphans', () => cleanOrphans());
ipcMain.handle('cache:clearAll', (e, currentSrc) => clearAllCache(currentSrc));

ipcMain.handle('ffprobe', (e, p) => {
  if (!FFPROBE) throw new Error('找不到 ffprobe');
  allowFileDir(p); // S1：探測過的媒體目錄加入白名單（涵蓋從專案重載、未經對話框的媒體路徑）
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
  const out = tmpPath('mp4');
  // 關鍵：必須 format=yuv420p，否則 4:2:2 / 10-bit 來源轉出的 proxy 仍是 Chromium 無法解碼的格式
  await runFF(['-y', '-i', src, '-map', '0:v:0', '-an', '-vf', 'scale=-2:720,format=yuv420p', ...vencArgs(), ...proxyGopArgs(), '-movflags', '+faststart', out],
    { sender: e.sender, duration, jobId: 'proxy', label: '轉檔預覽影片' });
  return out;
});

ipcMain.handle('ffmpeg:extractAudio', async (e, { path: src, idx, duration, codec }) => {
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
  const out = tmpPath('wav');
  await runFF(['-y', '-i', src, '-map', '0:a:0', '-ar', '4000', '-c:a', 'pcm_s16le', out],
    { sender: e.sender, duration, jobId: 'wave', label: '產生波形' });
  return out;
});

/* ---- 字幕字型（v4.25.4）：掃描 <專案根>/font/ ----
   每個子資料夾名＝字型名（如「台北黑體」），內含 .ttf/.otf/.ttc/.woff2 任一即採用；
   根目錄下的字型檔也收（檔名去副檔名當字型名）。renderer 用它注入 @font-face（預覽），
   匯出（libass）則以 fontsdir 指向同一資料夾 → 預覽與燒錄同一份字型。 */
function fontsRoot() {
  const cands = [
    path.join(__dirname, '..', 'font'),                                   // dev：專案根/font
    path.join(process.resourcesPath || '', 'font'),                       // 打包：resources/font
    path.join(path.dirname(app.getPath('exe')), 'font'),                  // 打包：安裝目錄/font
  ];
  for (const d of cands) { try { if (fs.existsSync(d) && fs.statSync(d).isDirectory()) return d; } catch (e) {} }
  return null;
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
  const root = fontsRoot();
  if (!root) return { root: null, fonts: [] };
  allowDir(root); // 納入路徑白名單，renderer 才能取 fileURL 讀字型位元組（FontFace 註冊）
  const out = [];
  // name＝資料夾名（UI／CSS FontFace 用）；family＝檔案內部家族名（ASS Fontname 用，見 fontFamilyOf）
  const pushFile = (name, file) => {
    if (out.some(f => f.name === name)) return;
    out.push({ name, file, family: fontFamilyOf(file) || name });
  };
  try {
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      const full = path.join(root, ent.name);
      if (ent.isDirectory()) {
        let hit = null;
        try { hit = pickRegularFace(full, fs.readdirSync(full)); } catch (e) {}
        if (hit) { allowDir(full); pushFile(ent.name, path.join(full, hit)); } // 資料夾名＝字型名
      } else if (FONT_EXT.test(ent.name)) {
        pushFile(ent.name.replace(FONT_EXT, ''), full);
      }
    }
  } catch (e) { console.error('[fonts] list', e); }
  return { root, fonts: out };
});

ipcMain.handle('ffmpeg:cleanup', async (e, { path: p }) => {
  try { fs.unlinkSync(p); tempFiles.delete(p); } catch (e2) {}
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
  allowFileDir(src); // S1
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

  const fc = [];            // filter_complex 片段
  const channels = [];      // {label, file}
  const chMaps = [];        // 對應 channels 的 -map 值
  const waveContribs = [];  // 各聲源對波形的貢獻（單聲道）
  let ci = 0;
  audioArr.forEach((a, i) => {
    const ch = Math.max(1, a.channels || 1);
    const base = a.title || a.lang || ('音軌 ' + (i + 1));
    if (ch === 1) {
      fc.push(`[0:a:${i}]asplit=2[co${ci}][wv${i}]`);
      channels.push({ label: base, file: path.join(dir, `ch_${String(ci + 1).padStart(2, '0')}.m4a`), sourceStream: i, sourceChannel: 0 });
      chMaps.push(`[co${ci}]`); waveContribs.push(`[wv${i}]`); ci++;
    } else {
      const pads = [];
      for (let k = 0; k < ch; k++) pads.push(`sp${i}_${k}`);
      fc.push(`[0:a:${i}]asplit=${ch + 1}${pads.map(p => `[${p}]`).join('')}[wv${i}]`);
      for (let k = 0; k < ch; k++) {
        fc.push(`[${pads[k]}]pan=mono|c0=c${k}[co${ci}]`);
        channels.push({ label: `${base} · 聲道${k + 1}`, file: path.join(dir, `ch_${String(ci + 1).padStart(2, '0')}.m4a`), sourceStream: i, sourceChannel: k });
        chMaps.push(`[co${ci}]`); ci++;
      }
      const avg = (1 / ch).toFixed(4);
      const sum = Array.from({ length: ch }, (_, k) => `${avg}*c${k}`).join('+');
      fc.push(`[wv${i}]pan=mono|c0=${sum}[wm${i}]`);
      waveContribs.push(`[wm${i}]`);
    }
  });

  let waveLabel = null;
  if (waveContribs.length === 1) waveLabel = waveContribs[0];
  else if (waveContribs.length > 1) { fc.push(`${waveContribs.join('')}amix=inputs=${waveContribs.length}:normalize=0[wavemix]`); waveLabel = '[wavemix]'; }

  const args = ['-y', ...hwdecArgs(), '-i', src]; // S2: hwaccel 加速來源解碼
  if (fc.length) args.push('-filter_complex', fc.join(';'));
  let proxy = null;
  if (needsProxy) { proxy = path.join(dir, 'proxy.mp4'); args.push('-map', '0:v:0', '-an', '-vf', 'scale=-2:720,format=yuv420p', ...vencArgs(), ...proxyGopArgs(), '-movflags', '+faststart', proxy); }
  channels.forEach((c, k) => { args.push('-map', chMaps[k], '-c:a', 'aac', '-b:a', '128k', c.file); });
  let wave = null;
  if (waveLabel) { wave = path.join(dir, 'wave.wav'); args.push('-map', waveLabel, '-ac', '1', '-ar', '4000', '-c:a', 'pcm_s16le', wave); }

  // 稍微延遲讓 mpv 優先取得檔案讀取權，避免 ffmpeg 瞬間佔滿磁碟 I/O 導致 mpv 播放無聲
  await new Promise(r => setTimeout(r, 1000));

  await runFF(args, { sender: e.sender, duration, jobId: 'ingest', label: '讀取並轉檔（單次讀取）', onProcess: p => { _currentIngestProc = p; } }); // S1: 記錄 proc
  _currentIngestProc = null;
  const meta = { proxy, channels, wave };
  writeMeta(metaPath, meta);
  return Object.assign({ cached: false }, meta);
}

/* 讀取快取檔案內容（base64）給 renderer（例如波形 wav） */
ipcMain.handle('fs:readB64', (e, p) => { if (!isAllowedPath(p)) { console.warn('[sec] readB64 blocked:', p); return null; } try { return fs.readFileSync(p).toString('base64'); } catch (err) { return null; } });
ipcMain.handle('fs:writeProject', (e, { path: p, b64 }) => {
  // S1：限副檔名 + 路徑白名單（autosave 落在媒體目錄旁，已於開檔時加入白名單）
  if (!/\.(subtool|json)$/i.test(p || '') || !isAllowedPath(p)) { console.warn('[sec] writeProject blocked:', p); return null; }
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.from(b64, 'base64')); return p; } catch (err) { return null; }
});
ipcMain.handle('fs:writeScreenshot', (e, { path: p, b64 }) => {
  if (!/\.(jpg|jpeg|png)$/i.test(p || '')) { console.warn('[sec] writeScreenshot blocked (bad ext):', p); return null; }
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.from(b64, 'base64')); return p; } catch (err) { console.error('[writeScreenshot] error:', err.message); return null; }
});

/* ---- 邊轉邊播 ingest（MXF 等非原生格式秒開）：fragmented MP4 + 本機 HTTP 伺服器 ----
   video 轉成 fragmented MP4（empty_moov），前幾秒輸出後就可播放；音軌/波形同一 pass 在背景繼續。
   快取命中時行為與 ffmpeg:ingest 相同（秒開）。 */
ipcMain.handle('ffmpeg:streamIngest', async (e, { path: src, duration, audio }) => {
  allowFileDir(src); // S1
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

  // 與 ffmpeg:ingest 相同的音訊 filter_complex 建構
  const fc = [], channels = [], chMaps = [], waveContribs = [];
  let ci = 0;
  audioArr.forEach((a, i) => {
    const ch = Math.max(1, a.channels || 1);
    const base = a.title || a.lang || ('音軌 ' + (i + 1));
    if (ch === 1) {
      fc.push(`[0:a:${i}]asplit=2[co${ci}][wv${i}]`);
      channels.push({ label: base, file: path.join(dir, `ch_${String(ci + 1).padStart(2, '0')}.m4a`), sourceStream: i, sourceChannel: 0 });
      chMaps.push(`[co${ci}]`); waveContribs.push(`[wv${i}]`); ci++;
    } else {
      const pads = [];
      for (let k = 0; k < ch; k++) pads.push(`sp${i}_${k}`);
      fc.push(`[0:a:${i}]asplit=${ch + 1}${pads.map(p => `[${p}]`).join('')}[wv${i}]`);
      for (let k = 0; k < ch; k++) {
        fc.push(`[${pads[k]}]pan=mono|c0=c${k}[co${ci}]`);
        channels.push({ label: `${base} · 聲道${k + 1}`, file: path.join(dir, `ch_${String(ci + 1).padStart(2, '0')}.m4a`), sourceStream: i, sourceChannel: k });
        chMaps.push(`[co${ci}]`); ci++;
      }
      const avg = (1 / ch).toFixed(4);
      fc.push(`[wv${i}]pan=mono|c0=${Array.from({ length: ch }, (_, k) => `${avg}*c${k}`).join('+')}[wm${i}]`);
      waveContribs.push(`[wm${i}]`);
    }
  });

  let waveLabel = null;
  if (waveContribs.length === 1) waveLabel = waveContribs[0];
  else if (waveContribs.length > 1) { fc.push(`${waveContribs.join('')}amix=inputs=${waveContribs.length}:normalize=0[wavemix]`); waveLabel = '[wavemix]'; }

  const proxy = path.join(dir, 'proxy.mp4');
  const wave = waveLabel ? path.join(dir, 'wave.wav') : null;

  const args = ['-y', ...hwdecArgs(), '-i', src]; // S2: hwaccel 加速來源解碼
  if (fc.length) args.push('-filter_complex', fc.join(';'));
  // 關鍵：fragmented MP4 讓 browser 在 ffmpeg 還未結束時就能開始播放
  args.push('-map', '0:v:0', '-an', '-vf', 'scale=-2:720,format=yuv420p',
    ...vencArgs(), '-movflags', 'frag_keyframe+empty_moov+default_base_moof', proxy);
  channels.forEach((c, k) => { args.push('-map', chMaps[k], '-c:a', 'aac', '-b:a', '128k', c.file); });
  if (waveLabel) args.push('-map', waveLabel, '-ac', '1', '-ar', '4000', '-c:a', 'pcm_s16le', wave);

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
    try { if (fs.statSync(proxy).size >= 131072) break; } catch (e2) {}
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
let _mpvSubFile = null;    // 餵給 mpv 的暫存 .ass 字幕檔
let _mpvSubAdded = false;

const MPV_GUIDE_HTML = `<!doctype html><html><head><style>
html,body,svg{width:100%;height:100%;margin:0;padding:0;overflow:hidden;background:transparent;pointer-events:none}
#imgContainer{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none}
.img-wrap{position:absolute;pointer-events:none}
.img-wrap img{width:100%;height:100%;object-fit:contain;display:block}
#guide{display:none} rect{fill:none;stroke:rgba(255,255,255,.88);stroke-width:1;stroke-dasharray:5 4}
line{stroke:rgba(255,255,255,.65);stroke-width:1} circle{fill:#f0a020;stroke:#fff;stroke-width:2}
</style></head><body><div id="imgContainer"></div><svg id="svg"><g id="guide"><rect id="box"/><line id="stem"/><circle id="dot" r="7"/></g></svg><script>
let current=null; const svg=document.getElementById('svg'), guide=document.getElementById('guide');
const draw=()=>{ const g=current; if(!g){guide.style.display='none';return;} const w=innerWidth,h=innerHeight;
  svg.setAttribute('viewBox','0 0 '+w+' '+h); document.getElementById('box').setAttribute('x',g.x); document.getElementById('box').setAttribute('y',g.y);
  document.getElementById('box').setAttribute('width',g.w); document.getElementById('box').setAttribute('height',g.h);
  const cx=g.x+g.w/2, cy=g.y-19, stem=document.getElementById('stem'), dot=document.getElementById('dot');
  stem.setAttribute('x1',cx);stem.setAttribute('y1',cy+7);stem.setAttribute('x2',cx);stem.setAttribute('y2',g.y-2);
  dot.setAttribute('cx',cx);dot.setAttribute('cy',cy);guide.style.display='block'; };
window.setGuide=(g)=>{current=g;draw();}; addEventListener('resize',draw);
window.setImages=(h, r)=>{
  const el = document.getElementById('imgContainer');
  if(r){ el.style.left=r.x+'px'; el.style.top=r.y+'px'; el.style.width=r.w+'px'; el.style.height=r.h+'px'; }
  el.innerHTML=h||'';
};
</script></body></html>`;

function applyMpvBounds(b) {
  if (!_mpvWin || _mpvWin.isDestroyed() || !b || !mainWin) return;
  _mpvRect = b;
  try {
    const cb = mainWin.getContentBounds(); // DIP，內容區左上角為原點
    _mpvWin.setBounds({
      x: Math.round(cb.x + b.x),
      y: Math.round(cb.y + b.y),
      width: Math.max(1, Math.round(b.w)),
      height: Math.max(1, Math.round(b.h)),
    });
    if (_mpvGuideWin && !_mpvGuideWin.isDestroyed()) {
      _mpvGuideWin.setBounds({
        x: Math.round(cb.x + b.x),
        y: Math.round(cb.y + b.y),
        width: Math.max(1, Math.round(b.w)),
        height: Math.max(1, Math.round(b.h)),
      });
    }
  } catch (e) {}
}

function destroyMpvWin() {
  if (_mpvWin) { try { if (!_mpvWin.isDestroyed()) _mpvWin.destroy(); } catch (e) {} _mpvWin = null; }
  if (_mpvGuideWin) { try { if (!_mpvGuideWin.isDestroyed()) _mpvGuideWin.destroy(); } catch (e) {} _mpvGuideWin = null; }
  _mpvRect = null; _mpvVisible = true; _mpvGuide = null; _mpvImagesHtml = ''; _mpvSubAdded = false; _mpvSubFile = null;
}

function showMpvGuide() {
  if (!_mpvVisible || (!_mpvGuide && !_mpvImagesHtml) || !_mpvGuideWin || _mpvGuideWin.isDestroyed()) return;
  try { _mpvGuideWin.showInactive(); _mpvGuideWin.moveTop(); } catch (e) {}
}

function setMpvGuide(raw) {
  const vals = raw && [raw.x, raw.y, raw.w, raw.h];
  if (!vals || vals.some(v => !Number.isFinite(v)) || raw.w <= 0 || raw.h <= 0) {
    _mpvGuide = null;
    if (!_mpvImagesHtml && _mpvGuideWin && !_mpvGuideWin.isDestroyed()) { try { _mpvGuideWin.hide(); } catch (e) {} }
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
  const rect = data && data.rect;
  if (!_mpvGuideWin || _mpvGuideWin.isDestroyed()) return;
  try {
    _mpvGuideWin.webContents.executeJavaScript(`window.setImages(${JSON.stringify(_mpvImagesHtml)}, ${JSON.stringify(rect)})`, true).catch(() => {});
    if (_mpvImagesHtml || _mpvGuide) showMpvGuide();
    else if (!_mpvGuide) _mpvGuideWin.hide();
  } catch (e) {}
}

function detectMpv() {
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

ipcMain.handle('mpv:detect', () => { const exe = detectMpv(); console.error('[mpv] detect ->', exe || '(not found)'); return { available: !!exe, exe }; });
ipcMain.handle('mpv:launch', async (e, { src, bounds, audio }) => {
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
    webPreferences: { offscreen: false, backgroundThrottling: false },
  });
  // 提示層絕不可接收或轉送滑鼠事件：forward:true 會讓最上層 Chromium 視窗吃掉
  // pointer move，導致底下的字幕拖曳層必須靠隱藏影片才恢復。單純忽略才會一路穿透。
  try { _mpvGuideWin.setIgnoreMouseEvents(true); } catch (e2) {}
  try { _mpvGuideWin.setMenu(null); } catch (e2) {}
  await _mpvGuideWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(MPV_GUIDE_HTML));
  _mpvVisible = true;
  applyMpvBounds(bounds);

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

  mpvArgs.push(src);

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
  } else {
    try { _mpvWin.hide(); } catch (e2) {}
    if (_mpvGuideWin && !_mpvGuideWin.isDestroyed()) { try { _mpvGuideWin.hide(); } catch (e2) {} }
  }
});
ipcMain.handle('mpv:setGuide', (e, guide) => setMpvGuide(guide));
ipcMain.handle('mpv:setImageGuide', (e, html) => setMpvImageGuide(html));
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
  if (!isAllowedPath(p)) { console.warn('[sec] mpv loadfile blocked:', p); return null; }
  if (!_mpvClient) { console.error('[mpv] loadfile: no client'); return null; }
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
ipcMain.handle('mpv:screenshot', (e, p) => mpvSend(['screenshot-to-file', p, 'subtitles']));
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
