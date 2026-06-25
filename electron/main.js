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
function runFF(args, { onProgress, duration, sender, jobId, label, onProcess } = {}) {
  return new Promise((res, rej) => {
    if (!FFMPEG) return rej(new Error('找不到 ffmpeg'));
    const p = spawn(FFMPEG, args);
    if (onProcess) onProcess(p);
    let err = '';
    p.stderr.on('data', d => {
      const s = d.toString(); err += s; if (err.length > 8000) err = err.slice(-8000);
      const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
      if (m && duration && sender) {
        const t = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
        safeSend(sender, 'task-progress', { jobId, label, pct: Math.min(99, Math.round(t / duration * 100)) });
      }
    });
    p.on('error', rej);
    p.on('close', c => {
      if (sender) safeSend(sender, 'task-progress', { jobId, label, pct: 100, done: true });
      c === 0 ? res(true) : rej(new Error('ffmpeg 結束碼 ' + c + '\n' + err.slice(-600)));
    });
  });
}

/* ---- 視窗 ---- */
function createWindow() {
  mainWin = new BrowserWindow({
    width: 1480, height: 920, minWidth: 1024, minHeight: 640,
    backgroundColor: '#1b1b1d', autoHideMenuBar: true,
    title: 'SUB TOOL',
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
  mainWin.on('closed', () => { destroyMpvWin(); });
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
          'Content-Length': len, 'Accept-Ranges': 'bytes'
        });
        fs.createReadStream(job.filePath, { start, end }).pipe(res);
      };
      tryRange(0);
    });
    _hSrv.listen(0, '127.0.0.1', () => { _hPort = _hSrv.address().port; resolve(_hPort); });
    _hSrv.on('error', reject);
  });
}

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
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('quit', () => {
  if (_mpvProc) { try { _mpvProc.kill(); } catch (e) {} _mpvProc = null; }
  for (const f of tempFiles) { try { fs.unlinkSync(f); } catch (e) {} }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});

/* ============ IPC ============ */
ipcMain.handle('app:status', () => ({
  isDesktop: true, ffmpeg: !!FFMPEG, ffprobe: !!FFPROBE,
  ffmpegPath: FFMPEG, ffprobePath: FFPROBE, venc: VENC
}));

ipcMain.handle('fs:fileURL', (e, p) => url.pathToFileURL(p).href);
ipcMain.handle('fs:stat', (e, p) => { try { const s = fs.statSync(p); return { exists: true, size: s.size }; } catch (err) { return { exists: false }; } });

ipcMain.handle('dialog:openMedia', async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: '匯入影音檔', properties: ['openFile'],
    filters: [
      { name: '影音檔', extensions: ['mp4', 'mov', 'mkv', 'mxf', 'avi', 'm2ts', 'mts', 'ts', 'wmv', 'webm', 'mp3', 'wav', 'm4a', 'aac', 'flac'] },
      { name: '全部', extensions: ['*'] }
    ]
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:openAudio', async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: '加入音軌檔', properties: ['openFile', 'multiSelections'],
    filters: [{ name: '音訊', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg'] }]
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('dialog:openProject', async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: '開啟專案', properties: ['openFile'],
    filters: [{ name: 'SUB Tool 專案', extensions: ['subtool', 'json'] }]
  });
  if (r.canceled) return null;
  const buf = fs.readFileSync(r.filePaths[0]);
  return { path: r.filePaths[0], b64: buf.toString('base64') };
});
ipcMain.handle('dialog:saveProject', async (e, { name, b64 }) => {
  const r = await dialog.showSaveDialog(mainWin, { title: '儲存專案', defaultPath: name, filters: [{ name: 'SUB Tool 專案', extensions: ['subtool'] }] });
  if (r.canceled) return null;
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

/* ---- 快取管理 ---- */
ipcMain.handle('cache:info', () => cacheInfo());
ipcMain.handle('cache:cleanOrphans', () => cleanOrphans());
ipcMain.handle('cache:clearAll', (e, currentSrc) => clearAllCache(currentSrc));

ipcMain.handle('ffprobe', (e, p) => {
  if (!FFPROBE) throw new Error('找不到 ffprobe');
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
ipcMain.handle('ffmpeg:ingest', async (e, { path: src, duration, needsProxy, audio }) => {
  // S1: 強制終止上一個未完成的 ingest，確保新檔案獲得完整系統資源
  if (_currentIngestProc) { try { _currentIngestProc.kill(); } catch (e2) {} _currentIngestProc = null; }
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
});

/* 讀取快取檔案內容（base64）給 renderer（例如波形 wav） */
ipcMain.handle('fs:readB64', (e, p) => { try { return fs.readFileSync(p).toString('base64'); } catch (err) { return null; } });
ipcMain.handle('fs:writeProject', (e, { path: p, b64 }) => { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.from(b64,'base64')); return p; } catch(err){ return null; } });

/* ---- 邊轉邊播 ingest（MXF 等非原生格式秒開）：fragmented MP4 + 本機 HTTP 伺服器 ----
   video 轉成 fragmented MP4（empty_moov），前幾秒輸出後就可播放；音軌/波形同一 pass 在背景繼續。
   快取命中時行為與 ffmpeg:ingest 相同（秒開）。 */
ipcMain.handle('ffmpeg:streamIngest', async (e, { path: src, duration, audio }) => {
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
    const jid = 'c-' + cacheKeyFor(src);
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

  const jid = 'l-' + Date.now();
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
