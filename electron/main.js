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
  return { proxy: r(raw.proxy), wave: r(raw.wave), channels: (raw.channels || []).map(c => ({ label: c.label, file: r(c.file) })) };
}
function metaToStore(meta) {
  const b = (f) => f ? path.basename(f) : f;
  return { proxy: b(meta.proxy), wave: b(meta.wave), channels: (meta.channels || []).map(c => ({ label: c.label, file: b(c.file) })) };
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
    try { const m = resolveMeta(JSON.parse(fs.readFileSync(metaPath, 'utf8')), dir); if (metaValid(m)) return { dir, meta: m }; } catch (e) {}
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

ipcMain.handle('fs:fileURL', (e, p) => { if (!isAllowedPath(p)) { console.warn('[sec] fileURL blocked:', p); return null; } return url.pathToFileURL(p).href; });
ipcMain.handle('fs:stat', (e, p) => { try { const s = fs.statSync(p); return { exists: true, size: s.size }; } catch (err) { return { exists: false }; } });

ipcMain.handle('dialog:openMedia', async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: '匯入影音檔', properties: ['openFile'],
    filters: [
      { name: '影音檔', extensions: ['mp4', 'mov', 'mkv', 'mxf', 'avi', 'm2ts', 'mts', 'ts', 'wmv', 'webm', 'mp3', 'wav', 'm4a', 'aac', 'flac'] },
      { name: '全部', extensions: ['*'] }
    ]
  });
  if (r.canceled) return null;
  allowFileDir(r.filePaths[0]); // S1：把開啟媒體的目錄加入白名單
  return r.filePaths[0];
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
ipcMain.handle('ffmpeg:exportVideo', async (e, { clips, videoTracks, width, height, fps, assText, format, duration, defaultName, outPath: presetOut, videoKbps }) => {
  if (!FFMPEG) throw new Error('找不到 ffmpeg');
  const isPro = format === 'prores';
  const ext = isPro ? 'mov' : 'mp4';
  let outPath = presetOut || null; // 有指定輸出路徑則跳過對話框（測試/批次用）
  if (!outPath) {
    const r = await dialog.showSaveDialog(mainWin, {
      title: '匯出影片', defaultPath: (defaultName || 'sequence') + '.' + ext,
      filters: [{ name: isPro ? 'ProRes 422 HQ (MOV)' : 'MP4 (H.264)', extensions: [ext] }],
    });
    if (r.canceled) return null;
    outPath = r.filePath;
  }
  allowFileDir(outPath);
  (clips || []).forEach(c => { if (c.path) allowFileDir(c.path); (c.audio || []).forEach(a => a.file && allowFileDir(a.file)); });

  const W = Math.max(2, Math.round(width || 1920)), H = Math.max(2, Math.round(height || 1080));
  const R = fps || 25;
  ensureTmp();
  // ===== 多軌合成 filtergraph（v4.11.0）=====
  //  影像：每視訊軌各自 concat 成整條時間軸（片段放 offset、間隙【透明】），再由下而上 overlay 疊到黑底；
  //        上層片段覆蓋下層（比照預覽 top-occludes），透明間隙讓下層透出。
  //  音訊：所有片段各自套混音器音量後 adelay 到自身 offset，再全部 amix（全軌混音）。
  //  單軌、無重疊的序列＝此法之特例，結果與舊版 concat 相同。
  const list = clips || [];
  if (!list.length) throw new Error('沒有可匯出的影片段');
  const inputs = [], fc = [];
  const D = Math.max(0.05, +duration || 0);
  const EPS = 0.01;
  // 1) 每片段一個影像輸入（音訊回退共用同一輸入）；索引 === 片段序號 i
  list.forEach((c) => { inputs.push('-hwaccel', 'auto', '-i', c.path); });
  let ii = list.length; // 之後的逐聲道音訊檔輸入從此接續編號
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
    const trk = list.map((c, i) => ({ c, i })).filter(x => (x.c.vtrack || 0) === vt).sort((a, b) => a.c.offset - b.c.offset);
    if (!trk.length) return;
    const segs = []; let cursor = 0, si = 0;
    const gap = (gd) => { const L = `t${ti}s${si++}`; fc.push(`color=c=black@0.0:s=${SW}x${SH}:r=${R}:d=${(+gd).toFixed(3)},format=yuva420p,setsar=1[${L}]`); segs.push(`[${L}]`); };
    for (const { c, i } of trk) {
      if (c.offset > cursor + EPS) gap(c.offset - cursor);
      const L = `t${ti}s${si++}`;
      // 縮放到此軌尺寸（等比、透明補邊，讓非填滿處露出下層），統一 fps/SAR、加 alpha
      fc.push(`[${i}:v]trim=start=${c.in}:end=${c.out},setpts=PTS-STARTPTS,fps=${R},scale=${SW}:${SH}:force_original_aspect_ratio=decrease,format=yuva420p,pad=${SW}:${SH}:(ow-iw)/2:(oh-ih)/2:color=black@0.0,setsar=1[${L}]`);
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
  // 3) 音訊：每片段套混音器音量 → adelay 到 offset → 全部 amix
  const aLabels = [];
  list.forEach((c, i) => {
    let al = null;
    if (Array.isArray(c.audio)) {
      if (!c.audio.length) return; // 全靜音 → 此片段不發聲
      const mono = [];
      c.audio.forEach((ch, j) => {
        inputs.push('-i', ch.file); const aidx = ii++;
        fc.push(`[${aidx}:a]atrim=start=${c.in}:end=${c.out},asetpts=PTS-STARTPTS,aresample=48000,volume=${ch.volume}[am${i}_${j}]`);
        mono.push(`[am${i}_${j}]`);
      });
      al = `[aa${i}]`;
      fc.push(mono.length > 1
        ? `${mono.join('')}amix=inputs=${mono.length}:normalize=0,pan=stereo|FL=c0|FR=c0${al}`
        : `${mono[0]}pan=stereo|FL=c0|FR=c0${al}`);
    } else if (hasAudioStream(c.path)) {
      al = `[aa${i}]`;
      fc.push(`[${i}:a]atrim=start=${c.in}:end=${c.out},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${al}`);
    } else return;
    const offMs = Math.max(0, Math.round((c.offset || 0) * 1000));
    fc.push(`${al}adelay=${offMs}:all=1[ad${i}]`);
    aLabels.push(`[ad${i}]`);
  });
  if (aLabels.length) fc.push(`${aLabels.join('')}amix=inputs=${aLabels.length}:normalize=0:dropout_transition=0,atrim=0:${D.toFixed(3)},aresample=48000[ac]`);
  else fc.push(`anullsrc=r=48000:cl=stereo,atrim=0:${D.toFixed(3)},asetpts=PTS-STARTPTS[ac]`);

  // 燒錄字幕（可見軌）：ass 濾鏡讀取暫存 .ass；以 cwd=TMP + basename 引用避開路徑跳脫
  let vfinal = vc, assName = null;
  if (assText && assText.trim()) {
    assName = 'export_' + Date.now() + '.ass';
    fs.writeFileSync(path.join(TMP, assName), assText, 'utf8');
    fc.push(`${vc}ass=${assName}[vout]`);
    vfinal = '[vout]';
  }

  // MP4：以使用者指定的目標位元率編碼（音訊固定 192k AAC）；ProRes 為固定品質，無位元率設定
  const kbps = Math.max(100, Math.min(200000, Math.round(videoKbps || 5000)));
  const encode = isPro ? proresArgs() : [...vencArgsBitrate(kbps), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'];
  const args = ['-y', ...inputs, '-filter_complex', fc.join(';'), '-map', vfinal, '-map', '[ac]', '-r', String(R), ...encode, outPath];

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
      fs.writeFileSync(path.join(dir, f.name), Buffer.from(data, 'base64'));
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
  await runFF(['-y', '-i', src, '-map', '0:v:0', '-an', '-vf', 'scale=-2:720,format=yuv420p', ...vencArgs(), '-movflags', '+faststart', out],
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
  const hit = readCache(src);
  if (hit) { if (e.sender) safeSend(e.sender, 'task-progress', { jobId: 'ingest', label: '使用快取', pct: 100, done: true }); return Object.assign({ cached: true }, hit.meta); }
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
      channels.push({ label: base, file: path.join(dir, `ch_${String(ci + 1).padStart(2, '0')}.m4a`) });
      chMaps.push(`[co${ci}]`); waveContribs.push(`[wv${i}]`); ci++;
    } else {
      const pads = [];
      for (let k = 0; k < ch; k++) pads.push(`sp${i}_${k}`);
      fc.push(`[0:a:${i}]asplit=${ch + 1}${pads.map(p => `[${p}]`).join('')}[wv${i}]`);
      for (let k = 0; k < ch; k++) {
        fc.push(`[${pads[k]}]pan=mono|c0=c${k}[co${ci}]`);
        channels.push({ label: `${base} · 聲道${k + 1}`, file: path.join(dir, `ch_${String(ci + 1).padStart(2, '0')}.m4a`) });
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
  if (needsProxy) { proxy = path.join(dir, 'proxy.mp4'); args.push('-map', '0:v:0', '-an', '-vf', 'scale=-2:720,format=yuv420p', ...vencArgs(), '-movflags', '+faststart', proxy); }
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
  if (hit && hit.meta.proxy && fs.existsSync(hit.meta.proxy)) {
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
      channels.push({ label: base, file: path.join(dir, `ch_${String(ci + 1).padStart(2, '0')}.m4a`) });
      chMaps.push(`[co${ci}]`); waveContribs.push(`[wv${i}]`); ci++;
    } else {
      const pads = [];
      for (let k = 0; k < ch; k++) pads.push(`sp${i}_${k}`);
      fc.push(`[0:a:${i}]asplit=${ch + 1}${pads.map(p => `[${p}]`).join('')}[wv${i}]`);
      for (let k = 0; k < ch; k++) {
        fc.push(`[${pads[k]}]pan=mono|c0=c${k}[co${ci}]`);
        channels.push({ label: `${base} · 聲道${k + 1}`, file: path.join(dir, `ch_${String(ci + 1).padStart(2, '0')}.m4a`) });
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
let _mpvRect = null;       // 最近一次面板矩形（內容座標 DIP）
let _mpvVisible = true;
let _mpvSubFile = null;    // 餵給 mpv 的暫存 .ass 字幕檔
let _mpvSubAdded = false;

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
  } catch (e) {}
}

function destroyMpvWin() {
  if (_mpvWin) { try { if (!_mpvWin.isDestroyed()) _mpvWin.destroy(); } catch (e) {} _mpvWin = null; }
  _mpvRect = null; _mpvVisible = true; _mpvSubAdded = false; _mpvSubFile = null;
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
  try { _mpvWin.setMenu(null); } catch (e2) {}
  _mpvWin.loadURL('data:text/html,<body style="margin:0;background:transparent"></body>');
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
  if (v) { try { _mpvWin.show(); _mpvWin.moveTop(); } catch (e2) {} if (_mpvRect) applyMpvBounds(_mpvRect); }
  else { try { _mpvWin.hide(); } catch (e2) {} }
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
ipcMain.handle('mpv:play',  ()     => mpvSend(['set_property', 'pause', false]));
ipcMain.handle('mpv:pause', ()     => mpvSend(['set_property', 'pause', true]));
ipcMain.handle('mpv:mute',  (e, v) => mpvSend(['set_property', 'mute', v]));
ipcMain.handle('mpv:rate',  (e, r) => mpvSend(['set_property', 'speed', r]));
ipcMain.handle('mpv:quit',  () => {
  if (_mpvProc) { try { _mpvProc.kill(); } catch (ee) {} _mpvProc = null; }
  if (_mpvClient) { try { _mpvClient.destroy(); } catch (ee) {} _mpvClient = null; }
  destroyMpvWin();
});
