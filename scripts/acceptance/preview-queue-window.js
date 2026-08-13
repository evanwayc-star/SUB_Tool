/* ==============================================================================
   匯出佇列監控的版面預覽產生器
   ==============================================================================
   用法：
     node scripts/acceptance/preview-queue-window.js [輸出路徑]
     預設輸出 dist/__queue-preview.html（dist/ 已被 gitignore，不會污染版控）

   把 `electron/queue.html` 注入一份假的 `queueAPI` 並塞進涵蓋各種極端情況的
   工作資料，產出一個可以直接用瀏覽器開的檔案。

   【為什麼需要它】
   佇列監控是另一個 BrowserWindow，只有在 Electron 裡才會被填入資料。
   而 `tests/queueLayout.test.js` 走的是 jsdom——jsdom **不做版面計算**，
   所以它驗得到「DOM 結構對不對」，驗不到「有沒有被擠爛」。

   真實事故（v6.1.5）：字幕標籤被 flex 壓縮成一個省略號、還被「燒入 TC」疊住；
   jsdom 測試全綠。修的時候第一版又把窄視窗的按鈕疊到檔名上——同樣全綠。
   兩次都是靠這支預覽 + getBoundingClientRect() 量出來的（見 §0.7：
   「有沒有顯示」只能量，不能用看的）。

   量測的方式（在瀏覽器 console 或 CDP 裡跑）：
     [...document.querySelectorAll('.job-specline')].map(line => {
       const k = [...line.children];
       return k.map(c => ({ t: c.textContent.trim(),
                            truncated: c.scrollWidth > c.clientWidth + 1,
                            r: c.getBoundingClientRect() }));
     })
   兩兩比對 rect 是否重疊、scrollWidth 是否超出 clientWidth。

   ⚠ 這支只驗版面。行為（拖曳、編輯、刪除）由 tests/queueLayout.test.js 守。
============================================================================== */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = process.argv[2] || path.join(ROOT, 'dist', '__queue-preview.html');

const at = (h, m, s) => new Date(2026, 7, 5, h, m, s).getTime();

/* 刻意涵蓋會擠壞版面的情況：長檔名、多條字幕軌、4K 的大碼率、
   有／無 TC、執行中（有進度條，內容區較窄）、WAV（沒有解析度與字幕）。 */
const JOBS = [
  { id: 'q1', status: 'queued', createdAt: at(21, 57, 56),
    payload: { outPath: 'C:\\out\\ST_拼桌_29fps_51FM+20FM.mp4', format: 'h264',
      width: 1920, height: 1080, fps: 29.97, videoKbps: 8000, duration: 152.0,
      subtitleTracks: ['取詞', '對白'], timecodeWatermark: null } },
  { id: 'q2', status: 'queued', createdAt: at(21, 58, 29),
    payload: { outPath: 'C:\\out\\ST_拼桌_29fps_51FM+20FM_TC.mp4', format: 'h264',
      width: 1920, height: 1080, fps: 29.97, videoKbps: 8000, duration: 152.0,
      subtitleTracks: ['取詞', '對白'], timecodeWatermark: { start: '01:00:00:00' } } },
  { id: 'q3', status: 'queued', createdAt: at(22, 1, 3),
    payload: { outPath: 'C:\\out\\很長的檔名_用來測試截斷_4K_多軌字幕.mp4', format: 'h264',
      width: 3840, height: 2160, fps: 25, videoKbps: 40000, duration: 3600,
      subtitleTracks: ['中文對白', '英文字幕', '註解', '歌詞', '旁白'],
      timecodeWatermark: { start: '00:00:00:00' } } },
  { id: 'r1', status: 'running', pct: 42.5, elapsedMs: 65000, etaS: 88, createdAt: at(21, 55, 0),
    payload: { outPath: 'C:\\out\\執行中_ProRes.mov', format: 'prores',
      width: 1920, height: 1080, fps: 25, duration: 152.0,
      subtitleTracks: ['對白'], timecodeWatermark: null } },
  { id: 'w1', status: 'queued', createdAt: at(22, 4, 30),
    payload: { outPath: 'C:\\out\\純音訊.wav', format: 'wav', duration: 152.0, fps: 25,
      subtitleTracks: ['對白'], timecodeWatermark: null } },
  { id: 'f1', status: 'failed', createdAt: at(21, 40, 0), errorMsg: 'ffmpeg 結束碼 1',
    payload: { outPath: 'C:\\out\\失敗的工作.mp4', format: 'h264',
      width: 1920, height: 1080, fps: 25, videoKbps: 8000, duration: 152.0,
      subtitleTracks: ['對白'], timecodeWatermark: null } },
  /* 完成的工作是從 queue-history 讀回來的，欄位由 toEntry() 決定。
     它先前只存 outPath/duration/format，於是完成那幾列少了解析度、碼率、
     字幕與 TC——同一個畫面上兩種樣子。這一筆就是照 toEntry 的形狀寫的。 */
  { id: 'd1', status: 'done', createdAt: at(20, 30, 0), completedAt: at(20, 45, 12), elapsedMs: 912000,
    payload: { outPath: 'C:\\out\\已完成_51FM+20FM_TC.mp4', format: 'h264',
      width: 1920, height: 1080, fps: 29.97, videoKbps: 8000, duration: 152.0,
      subtitleTracks: ['字卡', '對白'], timecodeWatermark: { start: null } } },
];

const stub = `<script>
window.queueAPI = {
  getAll: () => Promise.resolve({ jobs: ${JSON.stringify(JOBS)}, isPaused: false, concurrency: 1 }),
  setPause: () => Promise.resolve(), setConcurrency: () => Promise.resolve(),
  stopJob: () => Promise.resolve(), retryJob: () => Promise.resolve(),
  clearJob: () => Promise.resolve(), clearCompleted: () => Promise.resolve(),
  reorderJob: () => Promise.resolve(), updateDelivery: () => Promise.resolve({}),
  showMainWindow: () => Promise.resolve(), openPath: () => Promise.resolve(),
  showItemInFolder: () => Promise.resolve(), onUpdate: () => {}
};
</script>`;

const html = fs.readFileSync(path.join(ROOT, 'electron', 'queue.html'), 'utf8')
  .replace('</head>', stub + '\n</head>');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');
console.log('預覽已產生：' + OUT);
console.log('用瀏覽器開它，並在不同視窗寬度下檢查（斷點在 980px 與 620px）。');
