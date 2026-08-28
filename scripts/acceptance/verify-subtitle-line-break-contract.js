/* ============================================================================
   字幕手動換行契約 —— Electron / Chromium 真機驗收
   ============================================================================
   先執行 npm run build，再執行：
     node scripts/acceptance/verify-subtitle-line-break-contract.js

   沒有換行字元的字幕只能形成一個視覺行；只有使用者輸入換行時才允許多行。
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
  verifiedCleanup
} = require('./cdp-electron-harness.js');

const LONG_SINGLE_LINE = '（ALMA鳥類學家認為牠「體型頗大、但稱不上巨大」） （ALMA銀行）。 （肥後通知） （ALMA假期：探索自由） （ALMA愛你） （全新升級、幸福加量）';

function visualLineCount(rects) {
  const lines = [];
  for (const rect of rects) {
    const centerY = rect.top + rect.height / 2;
    if (!lines.some(y => Math.abs(y - centerY) <= 2)) lines.push(centerY);
  }
  return lines.length;
}

async function cleanupProfile(profileDir) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      verifiedCleanup(profileDir, 'subtool-subtitle-lines-cdp-');
      return;
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw lastError;
}

(async () => {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('找不到 dist/index.html，請先執行 npm run build');
  }
  const profileDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-subtitle-lines-cdp-'));
  const screenshotPath = path.join(os.tmpdir(), 'subtool-subtitle-line-break-contract.png');
  const port = await reservePort();
  const errors = [];
  const child = spawn(ELECTRON, [
    '.',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-sandbox',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows'
  ], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe']
  });
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
      width: 1366,
      height: 768,
      deviceScaleFactor: 1,
      mobile: false
    });

    const observations = [];
    for (const sample of [
      { label: '短句', text: '沒有手動換行' },
      { label: '長句但沒有手動換行', text: LONG_SINGLE_LINE },
      { label: '手動換行', text: '第一行字幕\n第二行字幕' }
    ]) {
      const observation = await client.evaluate(`(async () => {
        const sample = ${JSON.stringify(sample)};
        const api = window.SUB;
        if (!api?.State || typeof api.renderVideoSub !== 'function') {
          throw new Error('找不到字幕預覽測試入口：' + Object.keys(api || {}).join(','));
        }
        const originalDisplayTime = api.Media.displayTime;
        api.Media.displayTime = () => 0;
        api.State.videoWidth = 1920;
        api.State.videoHeight = 1080;
        api.State.trackCount = 1;
        api.State.cues = [{
          id: 'line-break-contract', track: 0, start: -1, end: 86400,
          timed: true, text: sample.text
        }];
        api.State.tracks = [{
          ...(api.State.tracks[0] || {}),
          id: 0, name: '字幕軌 1', visible: true, show: true, display: true, hidden: false, locked: false,
          fontSize: 70, posX: 50, posY: 72, align: 'center', valign: 'middle'
        }];
        api.renderVideoSub();
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const root = document.getElementById('videoSub');
        const textNodes = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (walker.currentNode.nodeValue) textNodes.push(walker.currentNode);
        }
        const rects = [];
        for (const node of textNodes) {
          const range = document.createRange();
          range.selectNodeContents(node);
          rects.push(...[...range.getClientRects()].map(rect => ({
            left: rect.left, top: rect.top, width: rect.width, height: rect.height
          })));
        }
        const styled = textNodes[0]?.parentElement || root;
        const css = getComputedStyle(styled);
        api.Media.displayTime = originalDisplayTime;
        return {
          label: sample.label,
          sourceHasNewline: /[\\r\\n]/.test(sample.text),
          sourceLength: sample.text.length,
          html: root.innerHTML,
          rootRect: (() => { const r = root.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })(),
          rects,
          whiteSpace: css.whiteSpace,
          overflowWrap: css.overflowWrap,
          wordBreak: css.wordBreak,
          maxWidth: css.maxWidth
        };
      })()`);
      observation.visualLineCount = visualLineCount(observation.rects);
      observations.push(observation);
    }

    const screenshot = await client.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false
    });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));

    const short = observations.find(item => item.label === '短句');
    const long = observations.find(item => item.label === '長句但沒有手動換行');
    const manual = observations.find(item => item.label === '手動換行');
    if (short.visualLineCount !== 1 || long.visualLineCount !== 1 || manual.visualLineCount !== 2) {
      throw new Error(`字幕換行契約失敗：${JSON.stringify({ observations, screenshotPath }, null, 2)}`);
    }
    console.log(JSON.stringify({ observations, screenshotPath }, null, 2));
  } finally {
    client?.close();
    if (child.exitCode === null) child.kill('SIGKILL');
    await Promise.race([new Promise(resolve => child.once('close', resolve)), delay(5000)]);
    await cleanupProfile(profileDir);
  }
})().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
