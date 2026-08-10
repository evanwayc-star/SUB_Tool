'use strict';

const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..', '..');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function comparisonPayload(rowCount = 6) {
  const rows = Array.from({ length: rowCount }, (_, index) => ({
    left: {
      id: `left-${index}`,
      startTimecode: `00:00:${String(index).padStart(2, '0')}:00`,
      endTimecode: `00:00:${String(index + 1).padStart(2, '0')}:00`,
      text: `左側字幕 ${index + 1}`,
    },
    right: {
      id: `right-${index}`,
      startTimecode: `00:00:${String(index).padStart(2, '0')}:00`,
      endTimecode: `00:00:${String(index + 1).padStart(2, '0')}:00`,
      text: `右側字幕 ${index + 1}`,
    },
    leftIndex: index + 1,
    rightIndex: index + 1,
    difference: { missing: false, time: false, text: true, style: false, styleKeys: [], any: true },
    active: { missing: false, time: false, text: true, style: false, any: true },
  }));
  return {
    revision: 1,
    plan: {
      tracks: [{ index: 0, name: 'Left' }, { index: 1, name: 'Right' }],
      selection: { leftTrack: 0, rightTrack: 1 },
      checks: { time: true, text: true, style: true },
      rows,
    },
  };
}

async function run() {
  const win = new BrowserWindow({
    width: 900,
    height: 480,
    show: true,
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'compare-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  await win.loadFile(path.join(ROOT, 'electron', 'compare.html'));
  win.webContents.send('compare:update-data', comparisonPayload());
  await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 3000;
    const check = () => {
      if (document.querySelectorAll('.cell[data-cue-id]').length === 12) resolve();
      else if (Date.now() >= deadline) reject(new Error('compare rows did not render'));
      else requestAnimationFrame(check);
    };
    check();
  })`);

  const before = await win.webContents.executeJavaScript(`(() => {
    const container = document.getElementById('container');
    const rect = container.getBoundingClientRect();
    return {
      bodyHeight: document.body.getBoundingClientRect().height,
      viewportHeight: window.innerHeight,
      clientHeight: container.clientHeight,
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
      overflowY: getComputedStyle(container).overflowY,
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + Math.min(rect.height / 2, 160)),
    };
  })()`);

  win.show();
  win.focus();
  await delay(100);
  process.stdout.write(`COMPARE_SCROLL_READY:${JSON.stringify(before)}\n`);
}

app.whenReady()
  .then(run)
  .catch(error => {
    process.stderr.write(`${error?.stack || error}\n`);
    app.exit(1);
  });
app.on('window-all-closed', () => app.quit());
