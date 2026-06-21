/* SUB Tool — preload：以 contextBridge 安全暴露桌面能力給前端 (window.subtool) */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('subtool', {
  isDesktop: true,
  status:       () => ipcRenderer.invoke('app:status'),
  fileURL:      (p) => ipcRenderer.invoke('fs:fileURL', p),
  stat:         (p) => ipcRenderer.invoke('fs:stat', p),
  openMedia:    () => ipcRenderer.invoke('dialog:openMedia'),
  openAudio:    () => ipcRenderer.invoke('dialog:openAudio'),
  openProject:  () => ipcRenderer.invoke('dialog:openProject'),
  saveProject:  (name, b64) => ipcRenderer.invoke('dialog:saveProject', { name, b64 }),
  importSub:    (kind) => ipcRenderer.invoke('dialog:importSub', kind),
  exportSub:    (name, b64, ext) => ipcRenderer.invoke('dialog:exportSub', { name, b64, ext }),
  probe:        (p) => ipcRenderer.invoke('ffprobe', p),
  makeProxy:    (p, duration) => ipcRenderer.invoke('ffmpeg:proxy', { path: p, duration }),
  extractAudio: (p, idx, duration, codec) => ipcRenderer.invoke('ffmpeg:extractAudio', { path: p, idx, duration, codec }),
  waveAudio:    (p, duration) => ipcRenderer.invoke('ffmpeg:waveAudio', { path: p, duration }),
  ingest:       (opts) => ipcRenderer.invoke('ffmpeg:ingest', opts),
  readB64:      (p) => ipcRenderer.invoke('fs:readB64', p),
  onProgress:   (cb) => ipcRenderer.on('task-progress', (e, d) => cb(d)),
});
