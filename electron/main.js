/* SUB Tool — Electron 主程序
   提供：原生檔案對話框、系統 ffmpeg/ffprobe（MXF 轉檔、多音軌抽取、波形）、
         專案/字幕直接讀寫磁碟。前端沿用同一份 index.html。 */
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const url = require('url');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');

let mainWin = null;
let FFMPEG = null, FFPROBE = null, VENC = null, CACHE = null;
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

/* ---- 媒體快取鍵：來源路徑 + 修改時間 + 大小（內容變了就重轉） ---- */
function cacheKeyFor(src) {
  try { const s = fs.statSync(src); return crypto.createHash('sha1').update(src + '|' + s.mtimeMs + '|' + s.size).digest('hex').slice(0, 16); }
  catch (e) { return crypto.createHash('sha1').update(String(src)).digest('hex').slice(0, 16); }
}

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
  VENC = detectVideoEncoder();
  CACHE = path.join(app.getPath('userData'), 'mediacache');
  try { fs.mkdirSync(CACHE, { recursive: true }); } catch (e) {}
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
  await runFF(['-y', '-i', src, '-map', `0:a:${idx}`, '-vn', '-c:a', 'aac', '-b:a', '192k', out], { sender: e.sender, duration, jobId: 'a' + idx, label: '抽取音軌 ' + (idx + 1) });
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

/* ---- 單次讀取多輸出：整個來源檔只讀一遍，同時產生 proxy + 每聲道音訊 + 混音波形 ----
   每聲道以 asplit 分流（不直接 -map 同一條 stream，避免 filtergraph 與 -map 雙重消費而 deadlock）。
   結果存入持久快取（依 cacheKeyFor），重開同檔直接命中、秒開。 */
ipcMain.handle('ffmpeg:ingest', async (e, { path: src, duration, needsProxy, audio }) => {
  const audioArr = Array.isArray(audio) ? audio : [];
  const dir = path.join(CACHE || TMP, cacheKeyFor(src));
  const metaPath = path.join(dir, 'meta.json');
  // 快取命中：所有檔案都還在才採用
  if (fs.existsSync(metaPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const ok = (!m.proxy || fs.existsSync(m.proxy)) && (m.channels || []).every(c => fs.existsSync(c.file)) && (!m.wave || fs.existsSync(m.wave));
      if (ok) { if (e.sender) e.sender.send('task-progress', { jobId: 'ingest', label: '使用快取', pct: 100, done: true }); return Object.assign({ cached: true }, m); }
    } catch (er) {}
  }
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
      channels.push({ label: base, file: path.join(dir, `ch${ci}.m4a`) });
      chMaps.push(`[co${ci}]`); waveContribs.push(`[wv${i}]`); ci++;
    } else {
      const pads = [];
      for (let k = 0; k < ch; k++) pads.push(`sp${i}_${k}`);
      fc.push(`[0:a:${i}]asplit=${ch + 1}${pads.map(p => `[${p}]`).join('')}[wv${i}]`);
      for (let k = 0; k < ch; k++) {
        fc.push(`[${pads[k]}]pan=mono|c0=c${k}[co${ci}]`);
        channels.push({ label: `${base} · 聲道${k + 1}`, file: path.join(dir, `ch${ci}.m4a`) });
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

  const args = ['-y', '-i', src];
  if (fc.length) args.push('-filter_complex', fc.join(';'));
  let proxy = null;
  if (needsProxy) { proxy = path.join(dir, 'proxy.mp4'); args.push('-map', '0:v:0', '-an', '-vf', 'scale=-2:720,format=yuv420p', ...vencArgs(), '-movflags', '+faststart', proxy); }
  channels.forEach((c, k) => { args.push('-map', chMaps[k], '-c:a', 'aac', '-b:a', '192k', c.file); });
  let wave = null;
  if (waveLabel) { wave = path.join(dir, 'wave.wav'); args.push('-map', waveLabel, '-ac', '1', '-ar', '8000', '-c:a', 'pcm_s16le', wave); }

  await runFF(args, { sender: e.sender, duration, jobId: 'ingest', label: '讀取並轉檔（單次讀取）' });
  const meta = { proxy, channels, wave };
  try { fs.writeFileSync(metaPath, JSON.stringify(meta)); } catch (er) {}
  return Object.assign({ cached: false }, meta);
});

/* 讀取快取檔案內容（base64）給 renderer（例如波形 wav） */
ipcMain.handle('fs:readB64', (e, p) => { try { return fs.readFileSync(p).toString('base64'); } catch (err) { return null; } });

/* ============ mpv 媒體播放器整合（秒開非原生格式，無需等待 ffmpeg proxy 轉檔） ============
   架構：spawn mpv → 透過 Windows named pipe 發送 JSON IPC 指令 → renderer 同步時碼
   音訊：mpv 先播原生音訊；背景 ffmpeg 只抽音軌（無 proxy），完成後 element tracks 接管，mpv 靜音 */
let _mpvExe = null;
let _mpvProc = null;
let _mpvClient = null;
let _mpvReqId = 0;
const _mpvCbs = new Map();
let _mpvBuf = '';

function detectMpv() {
  if (_mpvExe) return _mpvExe;
  const cands = [
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
                mainWin?.webContents.send('mpv:event', msg);
              }
            } catch (e) {}
          }
        });
        client.on('close', () => { _mpvClient = null; mainWin?.webContents.send('mpv:event', { event: 'disconnected' }); });
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

ipcMain.handle('mpv:detect', () => { const exe = detectMpv(); return { available: !!exe, exe }; });
ipcMain.handle('mpv:launch', async (e, { src }) => {
  if (_mpvProc) { try { _mpvProc.kill(); } catch (ee) {} _mpvProc = null; }
  if (_mpvClient) { try { _mpvClient.destroy(); } catch (ee) {} _mpvClient = null; }
  const exe = detectMpv();
  if (!exe) throw new Error('找不到 mpv，請安裝 mpv 或設定 MPV_PATH 環境變數（https://mpv.io）');
  const pipeName = 'subtool-mpv-' + Date.now();
  _mpvProc = spawn(exe, [
    '--input-ipc-server=\\\\.\\pipe\\' + pipeName,
    '--no-terminal', '--keep-open=yes', '--pause', '--hr-seek=yes', src
  ], { detached: false, stdio: 'ignore' });
  _mpvProc.on('close', () => { _mpvProc = null; });
  await mpvConnectPipe(pipeName);
  _mpvClient.write(JSON.stringify({ command: ['observe_property', 1, 'time-pos'] }) + '\n');
  _mpvClient.write(JSON.stringify({ command: ['observe_property', 2, 'pause'] }) + '\n');
  _mpvClient.write(JSON.stringify({ command: ['observe_property', 3, 'duration'] }) + '\n');
  await new Promise(r => setTimeout(r, 400));
  const duration = await mpvSend(['get_property', 'duration'], true);
  return { ok: true, duration: typeof duration === 'number' ? duration : 0 };
});
ipcMain.handle('mpv:seek',  (e, t) => mpvSend(['seek', t, 'absolute']));
ipcMain.handle('mpv:play',  ()     => mpvSend(['set_property', 'pause', false]));
ipcMain.handle('mpv:pause', ()     => mpvSend(['set_property', 'pause', true]));
ipcMain.handle('mpv:mute',  (e, v) => mpvSend(['set_property', 'mute', v]));
ipcMain.handle('mpv:rate',  (e, r) => mpvSend(['set_property', 'speed', r]));
ipcMain.handle('mpv:quit',  () => {
  if (_mpvProc) { try { _mpvProc.kill(); } catch (ee) {} _mpvProc = null; }
  if (_mpvClient) { try { _mpvClient.destroy(); } catch (ee) {} _mpvClient = null; }
});
