/* SUB Tool — preload：以 contextBridge 安全暴露桌面能力給前端 (window.subtool) */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('subtool', {
  isDesktop: true,
  status:       () => ipcRenderer.invoke('app:status'),
  // 拖放的 File 物件 → 絕對路徑（Electron 32 起 File.path 已移除，官方替代為 webUtils.getPathForFile）。
  // 只接受真正的 File 物件，無法被字串偽造；解析失敗回 null，呼叫端退回瀏覽器路徑。
  getFilePath:  (file) => { try { return webUtils.getPathForFile(file) || null; } catch (e) { return null; } },
  fileURL:      (p) => { if(typeof p!=='string') throw new TypeError('path must be a string'); return ipcRenderer.invoke('fs:fileURL', p); },
  stat:         (p) => { if(typeof p!=='string') throw new TypeError('path must be a string'); return ipcRenderer.invoke('fs:stat', p); },
  listDir:      (p) => { if(typeof p!=='string') throw new TypeError('path must be a string'); return ipcRenderer.invoke('fs:listDir', p); },
  fontsList:    () => ipcRenderer.invoke('fonts:list'), // v4.25.4 字幕字型：掃 <專案根>/font/
  openMedia:    () => ipcRenderer.invoke('dialog:openMedia'),
  openAudio:    () => ipcRenderer.invoke('dialog:openAudio'),
  openProject:  () => ipcRenderer.invoke('dialog:openProject'),
  saveProject:  (name, b64) => ipcRenderer.invoke('dialog:saveProject', { name, b64 }),
  importSub:    (kind) => ipcRenderer.invoke('dialog:importSub', kind),
  exportSub:    (name, b64, ext) => ipcRenderer.invoke('dialog:exportSub', { name, b64, ext }),
  exportDirectory: (files) => ipcRenderer.invoke('dialog:exportDirectory', files),
  importDirectory: () => ipcRenderer.invoke('dialog:importDirectory'),
  importFont:   () => ipcRenderer.invoke('dialog:importFont'),
  exportVideo:  (opts) => ipcRenderer.invoke('ffmpeg:exportVideo', opts),
  probe:        (p) => { if(typeof p!=='string') throw new TypeError('path must be a string'); return ipcRenderer.invoke('ffprobe', p); },
  makeProxy:    (p, duration) => { if(typeof p!=='string') throw new TypeError('path must be a string'); return ipcRenderer.invoke('ffmpeg:proxy', { path: p, duration }); },
  extractAudio: (p, idx, duration, codec) => { if(typeof p!=='string') throw new TypeError('path must be a string'); return ipcRenderer.invoke('ffmpeg:extractAudio', { path: p, idx, duration, codec }); },
  waveAudio:    (p, duration) => { if(typeof p!=='string') throw new TypeError('path must be a string'); return ipcRenderer.invoke('ffmpeg:waveAudio', { path: p, duration }); },
  cleanupAudio: (p) => { if(typeof p!=='string') throw new TypeError('path must be a string'); return ipcRenderer.invoke('ffmpeg:cleanup', { path: p }); },
  ingest:       (opts) => ipcRenderer.invoke('ffmpeg:ingest', opts),
  streamIngest: (opts) => ipcRenderer.invoke('ffmpeg:streamIngest', opts),
  readB64:      (p) => { if(typeof p!=='string') throw new TypeError('path must be a string'); return ipcRenderer.invoke('fs:readB64', p); },
  writeProject: (p, b64) => { if(typeof p!=='string') throw new TypeError('path must be a string'); return ipcRenderer.invoke('fs:writeProject', { path: p, b64 }); },
  writeScreenshot: (p, b64) => { if(typeof p!=='string') throw new TypeError('path must be a string'); return ipcRenderer.invoke('fs:writeScreenshot', { path: p, b64 }); },
  cacheInfo:    () => ipcRenderer.invoke('cache:info'),
  cacheCleanOrphans: () => ipcRenderer.invoke('cache:cleanOrphans'),
  configLoad:   () => ipcRenderer.invoke('config:load'),
  configSave:   (data) => ipcRenderer.invoke('config:save', data),
  keysLoad:     () => ipcRenderer.invoke('keys:load'),
  keysSave:     (data) => ipcRenderer.invoke('keys:save', data),
  cacheClearAll: (src) => ipcRenderer.invoke('cache:clearAll', src),
  getStartupFile: () => ipcRenderer.invoke('app:getStartupFile'),
  onAppRequestClose: (cb) => ipcRenderer.on('app:request-close', () => cb()),
  closeApp: () => ipcRenderer.invoke('app:close'),
  onOpenFile:    (cb) => ipcRenderer.on('app:open-file', (e, path) => cb(path)),
  onProgress:   (cb) => ipcRenderer.on('task-progress', (e, d) => cb(d)),
  mpv: {
    detect:    ()      => ipcRenderer.invoke('mpv:detect'),
    launch:    (opts)  => ipcRenderer.invoke('mpv:launch', opts),
    seek:      (t)     => ipcRenderer.invoke('mpv:seek', t),
    loadfile:  (p)     => { if(typeof p!=='string') throw new TypeError('path must be a string'); return ipcRenderer.invoke('mpv:loadfile', p); },
    screenshot:(p)     => ipcRenderer.invoke('mpv:screenshot', p),
    play:      ()      => ipcRenderer.invoke('mpv:play'),
    pause:     ()      => ipcRenderer.invoke('mpv:pause'),
    mute:      (v)     => ipcRenderer.invoke('mpv:mute', v),
    rate:      (r)     => ipcRenderer.invoke('mpv:rate', r),
    brightness:(v)     => ipcRenderer.invoke('mpv:brightness', v),
    setBounds: (b)     => ipcRenderer.invoke('mpv:setBounds', b),
    show:      (v)     => ipcRenderer.invoke('mpv:show', v),
    setGuide:  (g)     => ipcRenderer.invoke('mpv:setGuide', g),
    setImageGuide: (h) => ipcRenderer.invoke('mpv:setImageGuide', h),
    // 監看用時間碼：標準型態為 { text:'HH:MM:SS:FF', rect:{x,y,w,h} }；null／空字串清除。
    // 由主程序再次白名單驗證，preload 僅作受限 IPC 入口。
    setTimecodeWatermark: (data) => ipcRenderer.invoke('mpv:setTimecodeWatermark', data),
    clearTimecodeWatermark: () => ipcRenderer.invoke('mpv:clearTimecodeWatermark'),
    onImagePointer: (cb) => {
      if (typeof cb !== 'function') return;
      ipcRenderer.removeAllListeners('mpv:imagePointer');
      ipcRenderer.on('mpv:imagePointer', (_, data) => cb(data));
    },
    subSet:    (ass)   => ipcRenderer.invoke('mpv:subSet', ass),
    subVisible:(v)     => ipcRenderer.invoke('mpv:subVisible', v),
    quit:      ()      => ipcRenderer.invoke('mpv:quit'),
    onEvent:   (cb)    => { ipcRenderer.removeAllListeners('mpv:event'); ipcRenderer.on('mpv:event', (_, d) => cb(d)); },
  },
});
