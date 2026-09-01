/* ============================================================================
   產出文件用的「目前工作區」實機截圖

   使用方式：
     npm run build
     node scripts/acceptance/capture-documentation-workspace.js [輸出 PNG]

   這支腳本用獨立 Electron profile 啟動目前的 dist，灌入不含私人素材的展示資料，
   再以 CDP 擷取真實 renderer。它不依賴使用者專案，也不會改動正式設定。
   ============================================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  ROOT,
  ELECTRON,
  delay,
  reservePort,
  getJSON,
  waitFor,
  CdpClient,
  verifiedCleanup,
} = require('./cdp-electron-harness.js');

const outputPath = path.resolve(process.argv[2] || path.join(ROOT, 'docs', 'images', 'workspace-overview.png'));

(async () => {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('找不到 dist/index.html，請先執行 npm run build');
  }
  const profileDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-docs-cdp-'));
  const port = await reservePort();
  const child = spawn(ELECTRON, [
    '.',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-sandbox',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  const errors = [];
  child.stderr.on('data', chunk => errors.push(chunk.toString()));
  let client;
  try {
    const target = await waitFor(async () => {
      const targets = await getJSON(`http://127.0.0.1:${port}/json/list`);
      return targets.find(item => item.type === 'page' && item.title === 'SUB TOOL');
    }, 'SUB Tool 主視窗啟動', 15000);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Page.bringToFront');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1600,
      height: 960,
      deviceScaleFactor: 1,
      mobile: false,
    });

    await waitFor(() => client.evaluate('Boolean(window.SUB?.State && document.getElementById("timelinePanel"))'), 'renderer 初始化');
    await client.evaluate(`(async () => {
      const { State } = window.SUB;
      const rightPanel = document.getElementById('rightPanel');
      if (rightPanel) rightPanel.style.width = '700px';
      State.fps = 24;
      State.dropFrame = false;
      State.duration = 24;
      State.viewStart = 0;
      State.pxPerSec = 34;
      State.listTrack = 0;
      State.videoTracks = [
        { name: 'V1 主畫面', visible: true, locked: false, height: 62 },
        { name: 'V2 圖文疊層', visible: true, locked: true, height: 54 },
      ];
      State.clips = [
        { id: 'docs-main', name: '訪談主畫面_24fps.mov', type: 'video', offset: 0, in: 0, out: 24, dur: 24, duration: 24, vtrack: 0, primary: true },
        { id: 'docs-overlay', name: '片名圖卡.png', type: 'image', offset: 3, in: 0, out: 7, dur: 4, duration: 4, vtrack: 1, posX: 76, posY: 22, scale: 36 },
      ];
      State.tracks = [
        { name: '中文字幕', visible: true, locked: false, height: 54, posY: 88, valign: 'bottom', fontSize: 58 },
        { name: '英文字幕', visible: true, locked: true, height: 54, posY: 14, valign: 'top', fontSize: 40, color: '#93c5fd' },
      ];
      State.trackCount = 2;
      State.cues = [
        { id: 'docs-c1', start: 1, end: 4.5, text: '從匯入、逐格到交付，都在同一條時間軸完成。', track: 0 },
        { id: 'docs-c2', start: 5.2, end: 8.7, text: '左右鍵逐格，J K L 控制倒帶、暫停與正播。', track: 0 },
        { id: 'docs-c3', start: 9.3, end: 13.2, text: '鎖定軌道仍可點擊與拖曳播放點。', track: 0 },
        { id: 'docs-c4', start: 14, end: 18.8, text: '字幕樣式在 HTML、mpv 與燒錄輸出保持一致。', track: 0 },
        { id: 'docs-e1', start: 1, end: 4.5, text: 'Edit, frame-step and deliver on one timeline.', track: 1 },
        { id: 'docs-e2', start: 9.3, end: 13.2, text: 'Locked tracks still allow playhead seeking.', track: 1 },
      ];
      State.audioProject = {
        mode: 'auto',
        buses: [
          { id: 'ab1', name: 'A1 對白', visible: true, locked: false, muted: false, solo: false, volume: 1, height: 42 },
          { id: 'ab2', name: 'A2 音樂', visible: true, locked: true, muted: false, solo: false, volume: 0.8, height: 42 },
        ],
        sourceMaps: {},
        exportLayout: { streams: [] },
      };
      window.SUB.renderAll();
      window.SUB.drawTimeline();
      window.SUB.selectCueSingle('docs-c3', false);
      window.SUB.Media.seek(10).catch(() => {});
      window.SUB.drawTimeline();
      window.SUB.renderVideoSub();
      const noVideo = document.getElementById('noVideo');
      if (noVideo) noVideo.style.display = 'none';
      const canvas = document.getElementById('previewCanvas');
      const wrap = document.getElementById('videoWrap');
      if (canvas && wrap) {
        wrap.style.background = 'linear-gradient(135deg, #101c31 0%, #26314b 58%, #10151f 100%)';
        canvas.style.opacity = '0';
        const video = document.getElementById('video');
        if (video) video.style.opacity = '0';
        const rect = wrap.getBoundingClientRect();
        canvas.width = Math.max(1, Math.round(rect.width));
        canvas.height = Math.max(1, Math.round(rect.height));
        canvas.style.display = 'block';
        const ctx = canvas.getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
        gradient.addColorStop(0, '#101c31');
        gradient.addColorStop(0.55, '#26314b');
        gradient.addColorStop(1, '#10151f');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(0, 163, 255, .12)';
        ctx.fillRect(canvas.width * .58, 0, canvas.width * .42, canvas.height);
        ctx.fillStyle = '#f8fafc';
        ctx.font = '600 27px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('SUB Tool 目前工作區', canvas.width / 2, canvas.height * .43);
        ctx.fillStyle = '#93c5fd';
        ctx.font = '17px sans-serif';
        ctx.fillText('多軌剪輯・字幕・音訊・逐格播放', canvas.width / 2, canvas.height * .52);
      }
      return { cues: State.cues.length, tracks: State.tracks.length, clips: State.clips.length };
    })()`);
    await delay(300);

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const screenshot = await client.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    fs.writeFileSync(outputPath, Buffer.from(screenshot.data, 'base64'));
    console.log(JSON.stringify({ outputPath }, null, 2));
  } finally {
    client?.close();
    if (child.exitCode === null) child.kill('SIGKILL');
    await Promise.race([new Promise(resolve => child.once('close', resolve)), delay(5000)]);
    await delay(500);
    verifiedCleanup(profileDir, 'subtool-docs-cdp-');
  }
})().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
