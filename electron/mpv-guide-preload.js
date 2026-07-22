/* 專供 mpv 圖片 guide 使用的最小 preload。
   guide 是另一個透明 BrowserWindow，不能直接存取主視窗資料；只允許回傳已白名單化的
   指標座標與操作類型。 */
const { contextBridge, ipcRenderer } = require('electron');

const POINTER_TYPES = new Set(['start', 'move', 'end', 'cancel']);
const CORNERS = new Set(['nw', 'ne', 'sw', 'se']);

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(-10000, Math.min(10000, number)) : null;
}

contextBridge.exposeInMainWorld('mpvImageGuide', {
  pointer(raw) {
    if (!raw || typeof raw !== 'object' || !POINTER_TYPES.has(raw.type)) return;
    const x = finite(raw.x), y = finite(raw.y);
    if (x == null || y == null) return;
    const payload = { type: raw.type, x, y };
    if (typeof raw.id === 'string' && raw.id.length <= 160) payload.id = raw.id;
    if (CORNERS.has(raw.corner)) payload.corner = raw.corner;
    ipcRenderer.send('mpv-guide:imagePointer', payload);
  },
});
