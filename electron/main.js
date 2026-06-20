/* SUB Tool — Electron 主程序
   提供：原生檔案對話框、系統 ffmpeg/ffprobe（MXF 轉檔、多音軌抽取、波形）、
         專案/字幕直接讀寫磁碟。前端沿用同一份 index.html。 */
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const url = require('url');
const { spawn, spawnSync } = require('child_process');

let mainWin = null;
let FFMPEG = null, FFPROBE = null;
const TMP = path.join(os.tmpdir(), 'subtool_cache');
const tempFiles = new Set();
let tmpSeq = 0;

/* ---- 偵測 ffmpeg / ffprobe ---- */
function detect(bin, extra) {
  const cands = [process.env[bin.toUpperCase() + '_PATH'], bin,
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

/* ---- 執行 ffmpeg，並回報進度 ---- */
function runFF(args, { onProgress, duration, sender, jobId, label } = {}) {
  return new Promise((res, rej) => {
    if (!FFMPEG) return rej(new Error('找不到 ffmpeg'));
    const p = spawn(FFMPEG, args);
    let err = '';
    p.stderr.on('data', d => {
      const s = d.toString(); err += s; if (err.length > 8000) err = err.slice(-8000);
      const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
      if (m && duration && sender) {
        const t = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
        sender.send('task-progress', { jobId, label, pct: Math.min(99, Math.round(t / duration * 100)) });
      }
    });
    p.on('error', rej);
    p.on('close', c => {
      if (sender) sender.send('task-progress', { jobId, label, pct: 100, done: true });
      c === 0 ? res(true) : rej(new Error('ffmpeg 結束碼 ' + c + '\n' + err.slice(-600)));
    });
  });
}

/* ---- 視窗 ---- */
function createWindow() {
  mainWin = new BrowserWindow({
    width: 1480, height: 920, minWidth: 1024, minHeight: 640,
    backgroundColor: '#1b1b1d', autoHideMenuBar: true,
    title: 'SUB Tool — 上字幕工具',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      webSecurity: false // 本機信任程式：允許 file:// 影音直接讀取
    }
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

app.whenReady().then(() => {
  FFMPEG = detect('ffmpeg');
  FFPROBE = detect('ffprobe');
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('quit', () => {
  for (const f of tempFiles) { try { fs.unlinkSync(f); } catch (e) {} }
  try { fs.rmdirSync(TMP, { recursive: true }); } catch (e) {}
});

/* ============ IPC ============ */
ipcMain.handle('app:status', () => ({
  isDesktop: true, ffmpeg: !!FFMPEG, ffprobe: !!FFPROBE,
  ffmpegPath: FFMPEG, ffprobePath: FFPROBE
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
  await runFF(['-y', '-i', src, '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-vf', 'scale=-2:720', '-movflags', '+faststart', out],
    { sender: e.sender, duration, jobId: 'proxy', label: '轉檔預覽影片' });
  return out;
});

ipcMain.handle('ffmpeg:extractAudio', async (e, { path: src, idx, duration }) => {
  // 先嘗試無損 copy 成 m4a；失敗則改編 AAC
  const out = tmpPath('m4a');
  try {
    await runFF(['-y', '-i', src, '-map', `0:a:${idx}`, '-vn', '-c:a', 'copy', out], { sender: e.sender, duration, jobId: 'a' + idx, label: '抽取音軌 ' + (idx + 1) });
  } catch (err) {
    await runFF(['-y', '-i', src, '-map', `0:a:${idx}`, '-vn', '-c:a', 'aac', '-b:a', '192k', out], { sender: e.sender, duration, jobId: 'a' + idx, label: '抽取音軌 ' + (idx + 1) });
  }
  return out;
});

ipcMain.handle('ffmpeg:waveAudio', async (e, { path: src, duration }) => {
  const out = tmpPath('wav');
  await runFF(['-y', '-i', src, '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-c:a', 'pcm_s16le', out],
    { sender: e.sender, duration, jobId: 'wave', label: '產生波形' });
  const buf = fs.readFileSync(out);
  try { fs.unlinkSync(out); tempFiles.delete(out); } catch (e2) {}
  return buf.toString('base64');
});
