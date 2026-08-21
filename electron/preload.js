/* ==============================================================================
   SUB Tool — Module Architecture Protection ("electron/preload.js")
   ==============================================================================
   【維護鐵律】本檔案已納入全專案終極防禦網。
   所有修改必須遵循專案的單向資料流與職責分離原則，嚴禁在此實作越權的 DOM 操作或狀態覆寫。
============================================================================== */
/* SUB Tool — preload：以 contextBridge 安全暴露桌面能力給前端 (window.subtool) */
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const isProjectFilePath = filePath => typeof filePath === 'string' && /\.(subtool|json)$/i.test(filePath);

contextBridge.exposeInMainWorld('subtool', {
  isDesktop: true,
  status:       () => ipcRenderer.invoke('app:status'),
  // 拖放的 File 物件 → 絕對路徑（Electron 32 起 File.path 已移除，官方替代為 webUtils.getPathForFile）。
  // 只接受真正的 File 物件，無法被字串偽造；解析失敗回 null，呼叫端退回瀏覽器路徑。
  getFilePath:  (file) => { try { return webUtils.getPathForFile(file) || null; } catch (e) { return null; } },
  // 由 preload 自真實 File 取路徑後才送主程序授權，renderer 無法傳入任意字串擴張能力範圍。
  authorizeDroppedFile: (file) => {
    try {
      const p = webUtils.getPathForFile(file);
      return p && !isProjectFilePath(p) ? ipcRenderer.invoke('fs:authorizeDroppedFile', p) : Promise.resolve(null);
    } catch (e) { return Promise.resolve(null); }
  },
  openDroppedProject: (file) => {
    try {
      const projectPath = webUtils.getPathForFile(file);
      return projectPath && isProjectFilePath(projectPath)
        ? ipcRenderer.invoke('project:openDroppedFile', projectPath)
        : Promise.resolve(null);
    } catch (error) { return Promise.resolve(null); }
  },
  fileURL:      (p) => { if(typeof p!=='string') throw new TypeError('path must be a string'); return ipcRenderer.invoke('fs:fileURL', p); },
  stat:         (p) => { if(typeof p!=='string') throw new TypeError('path must be a string'); return ipcRenderer.invoke('fs:stat', p); },
  listDir:      (p) => { if(typeof p!=='string') throw new TypeError('path must be a string'); return ipcRenderer.invoke('fs:listDir', p); },
  findRelinkTarget: (projectPath, oldMediaPath) => ipcRenderer.invoke("fs:findRelinkTarget", { projectPath, oldMediaPath }),
  showSourceInFolder: (p) => { if(typeof p!=="string") throw new TypeError("path must be a string"); return ipcRenderer.invoke("app:showSourceInFolder", p); },
  fontsList:    () => ipcRenderer.invoke('fonts:list'), // v4.25.4 字幕字型：掃 <專案根>/font/
  openMedia:    () => ipcRenderer.invoke('dialog:openMedia'),
  openAudio:    () => ipcRenderer.invoke('dialog:openAudio'),
  openProject:  () => ipcRenderer.invoke('dialog:openProject'),
  /* 最近開啟：清單由主程序持有並持久化。開啟時只送【索引】——
     renderer 給不了路徑，所以沒有「叫主程序讀任意檔案」的路。 */
  recentProjects:   () => ipcRenderer.invoke('project:recentList'),
  openRecentProject: (index) => ipcRenderer.invoke('project:openRecent', index),
  clearRecentProjects: () => ipcRenderer.invoke('project:clearRecent'),
  saveProject:  (name, b64) => ipcRenderer.invoke('dialog:saveProject', { name, b64 }),
  importSub:    (kind) => ipcRenderer.invoke('dialog:importSub', kind),
  exportSub:    (name, b64, ext) => ipcRenderer.invoke('dialog:exportSub', { name, b64, ext }),
  exportDirectory: (files) => ipcRenderer.invoke('dialog:exportDirectory', files),
  importDirectory: () => ipcRenderer.invoke('dialog:importDirectory'),
  importFont:   () => ipcRenderer.invoke('dialog:importFont'),
  exportVideo:  (opts) => ipcRenderer.invoke('ffmpeg:exportVideo', opts),
  stopExport:   (jobId) => ipcRenderer.invoke('ffmpeg:stopExport', jobId),
  openQueueMonitor: () => ipcRenderer.invoke('queue:openMonitor'),
  probe:        (p) => { if(typeof p!=='string') throw new TypeError('path must be a string'); return ipcRenderer.invoke('ffprobe', p); },
  makeProxy:    (p, duration) => { if(typeof p!=='string') throw new TypeError('path must be a string'); return ipcRenderer.invoke('ffmpeg:proxy', { path: p, duration }); },
  extractAudio: (p, idx, duration, codec) => { if(typeof p!=='string') throw new TypeError('path must be a string'); return ipcRenderer.invoke('ffmpeg:extractAudio', { path: p, idx, duration, codec }); },
  waveAudio:    (p, duration) => { if(typeof p!=='string') throw new TypeError('path must be a string'); return ipcRenderer.invoke('ffmpeg:waveAudio', { path: p, duration }); },
  cleanupAudio: (p) => { if(typeof p!=='string') throw new TypeError('path must be a string'); return ipcRenderer.invoke('ffmpeg:cleanup', { path: p }); },
  ingest:       (opts) => ipcRenderer.invoke('ffmpeg:ingest', opts),
  streamIngest: (opts) => ipcRenderer.invoke('ffmpeg:streamIngest', opts),
  releaseStream: (streamLeaseId) => ipcRenderer.invoke('ffmpeg:releaseStream', streamLeaseId),
  readB64:      (p) => { if(typeof p!=='string') throw new TypeError('path must be a string'); return ipcRenderer.invoke('fs:readB64', p); },
  reserveScreenshotPath: (directory, suffix = '') => {
    if(typeof directory!=='string') throw new TypeError('directory must be a string');
    return ipcRenderer.invoke('fs:reserveScreenshotPath', { directory, suffix });
  },
  writeProject: (p, b64) => { if(typeof p!=='string') throw new TypeError('path must be a string'); return ipcRenderer.invoke('fs:writeProject', { path: p, b64 }); },
  writeScreenshot: (p, b64) => { if(typeof p!=='string') throw new TypeError('path must be a string'); return ipcRenderer.invoke('fs:writeScreenshot', { path: p, b64 }); },
  openPath:     (p) => { if(typeof p!=='string') throw new TypeError('path must be a string'); return ipcRenderer.invoke('app:openPath', p); },
  cacheInfo:    () => ipcRenderer.invoke('cache:info'),
  cacheCleanOrphans: () => ipcRenderer.invoke('cache:cleanOrphans'),
  configLoad:   () => ipcRenderer.invoke('config:load'),
  configSave:   (data) => ipcRenderer.invoke('config:save', data),
  keysLoad:     () => ipcRenderer.invoke('keys:load'),
  keysSave:     (data) => ipcRenderer.invoke('keys:save', data),
  cacheClearAll: (src) => ipcRenderer.invoke('cache:clearAll', src),
  getStartupFile: () => ipcRenderer.invoke('app:getStartupFile'),
  openCompareWindow: (payload) => ipcRenderer.send('open-compare-window', payload),
  syncCompareWindow: (payload) => ipcRenderer.send('sync-compare-window', payload),
  onCompareCommand: (cb) => ipcRenderer.on('compare:command', (e, command) => cb(command)),
  onCompareClosed: (cb) => ipcRenderer.on('compare:closed', () => cb()),
  onAppRequestClose: (cb) => ipcRenderer.on('app:request-close', () => cb()),
  closeApp: () => ipcRenderer.invoke('app:close'),
  onOpenFile:    (cb) => ipcRenderer.on('app:open-file', (e, path) => cb(path)),
  queueResume:  () => ipcRenderer.invoke('queue:resume'),
  onQueueStatus:(cb) => {
    ipcRenderer.removeAllListeners('queue-status');
    ipcRenderer.on('queue-status', (e, d) => cb(d));
    ipcRenderer.invoke('queue:getStatus').then(d => cb(d)).catch(() => {});
  },
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
    subSet:    (ass)   => ipcRenderer.invoke('mpv:subSet', ass),
    subVisible:(v)     => ipcRenderer.invoke('mpv:subVisible', v),
    quit:      ()      => ipcRenderer.invoke('mpv:quit'),
    onEvent:   (cb)    => { ipcRenderer.removeAllListeners('mpv:event'); ipcRenderer.on('mpv:event', (_, d) => cb(d)); },
  },
});

