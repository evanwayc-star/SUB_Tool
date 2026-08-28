/* ============================================================================
   字幕列表換行標記 —— Electron / Chromium 真機驗收
   ============================================================================
   先執行 npm run build，再執行：
     node scripts/acceptance/verify-subtitle-line-break-marker.js
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

(async () => {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('找不到 dist/index.html，請先執行 npm run build');
  }
  const profileDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-line-marker-cdp-'));
  const screenshotPath = path.join(os.tmpdir(), 'subtool-subtitle-line-break-marker.png');
  const port = await reservePort();
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

    await client.evaluate(`(() => {
      const api = window.SUB;
      api.State.trackCount = 1;
      api.State.listTrack = 0;
      api.State.tracks = [{
        ...(api.State.tracks[0] || {}), name: 'SRT 字幕', visible: true, locked: false
      }];
      api.State.cues = [
        { id: 'multi', track: 0, start: 1, end: 4.16, timed: true, text: 'Next on the show,\\none-hit-wonder Daniel Novak.' },
        { id: 'single', track: 0, start: 5, end: 6.5, timed: true, text: 'Ouch!' }
      ];
      api.renderSubList();
      return true;
    })()`);

    const observation = await waitFor(
      () => client.evaluate(`(() => {
        const multi = document.querySelector('.sub-row[data-id="multi"] .txt');
        const markers = [...multi?.querySelectorAll('.line-break-mark') || []];
        if (markers.length !== 1) return null;
        const marker = markers[0];
        const style = getComputedStyle(marker);
        const pseudo = getComputedStyle(marker, '::before');
        const rect = marker.getBoundingClientRect();
        return {
          markerCount: markers.length,
          markerColor: style.color,
          markerContent: pseudo.content,
          markerRect: { width: rect.width, height: rect.height },
          markerLabel: marker.getAttribute('aria-label'),
          textContent: multi.textContent,
          sourceText: window.SUB.State.cues.find(cue => cue.id === 'multi').text,
          singleHasMarker: Boolean(document.querySelector('.sub-row[data-id="single"] .line-break-mark'))
        };
      })()`),
      '淺綠色換行標記'
    );

    const screenshot = await client.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false
    });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));

    if (observation.markerColor !== 'rgb(134, 239, 172)' ||
        !observation.markerContent.includes('↵') ||
        observation.markerRect.width <= 0 || observation.markerRect.height <= 0 ||
        observation.markerLabel !== '換行' || observation.textContent.includes('↵') ||
        observation.sourceText !== 'Next on the show,\none-hit-wonder Daniel Novak.' ||
        observation.singleHasMarker) {
      throw new Error(`字幕換行標記真機驗收失敗：${JSON.stringify({ observation, screenshotPath }, null, 2)}`);
    }
    console.log(JSON.stringify({ observation, screenshotPath }, null, 2));
  } finally {
    client?.close();
    if (child.exitCode === null) child.kill('SIGKILL');
    await Promise.race([new Promise(resolve => child.once('close', resolve)), delay(5000)]);
    let cleanupError;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        verifiedCleanup(profileDir, 'subtool-line-marker-cdp-');
        cleanupError = null;
        break;
      } catch (error) {
        cleanupError = error;
        await delay(250);
      }
    }
    if (cleanupError) throw cleanupError;
  }
})().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
