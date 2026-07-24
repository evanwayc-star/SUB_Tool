/* ==============================================================================
   SUB Tool — Module Architecture Protection ("electron/mpv-guide-preload.js")
   ==============================================================================
   【維護鐵律】本檔案已納入全專案終極防禦網。
   所有修改必須遵循專案的單向資料流與職責分離原則，嚴禁在此實作越權的 DOM 操作或狀態覆寫。
============================================================================== */
/* 專供 mpv 圖片 guide 使用的最小 preload。
   guide 是另一個透明 BrowserWindow，不能直接存取主視窗資料；只允許回傳已白名單化的
   指標座標與操作類型。 */
const { contextBridge, ipcRenderer } = require('electron');

// 只轉送帶座標的拖曳事件。下面的 x/y 檢查會擋掉任何沒有座標的訊息——
// 曾經有 'enter'／'leave' 也列在這裡，但送出端沒帶座標，於是【每一則都在這一關被丟掉】，
// 主程序那邊的處理分支從來沒被執行過。已移除整條路徑，理由見
// docs/技術架構說明.md §0.9：guide 視窗刻意永久穿透，互動一律由主視窗 DOM 處理。
// 【不要】為了「修好」它而讓 enter/leave 帶上座標——那會讓 guide 在 hover 時奪取
// 指標抓取權，底層視訊軌拖曳與右鍵選單全部失效，也就是 v4.6.3 當初要解決的死結。
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

