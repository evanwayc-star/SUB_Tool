'use strict';

const { app, BrowserWindow } = require('electron');

const entryArg = process.argv.find(value => value.startsWith('--app-entry='));
const appEntry = entryArg ? entryArg.slice('--app-entry='.length) : '';
const RESULT_MARKER = 'SUBTITLE_LIST_SCROLL_RESULT:';

function setupPageScenario() {
  return `(async () => {
    const waitFor = async (predicate, label, timeoutMs = 5000) => {
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('timeout: ' + label);
    };

    const cues = [];
    for (let index = 0; index < 80; index += 1) {
      cues.push({ text: 'A ' + index, start: index * 2, end: index * 2 + 1, track: 1, timed: true });
      cues.push({ text: 'B ' + index, start: index * 2, end: index * 2 + 1, track: 2, timed: true });
    }
    const project = {
      version: 3,
      fps: 25,
      dropFrame: false,
      duration: 170,
      pxPerSec: 25,
      trackCount: 2,
      tracks: [
        { name: 'T0', visible: true, locked: false },
        { name: 'T1', visible: true, locked: false },
      ],
      cues,
      notes: [],
    };

    document.querySelector('[data-act="open-project"]').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const input = document.getElementById('fileProject');
    const transfer = new DataTransfer();
    transfer.items.add(new File(
      [JSON.stringify(project)],
      'subtitle-list-scroll.subtool',
      { type: 'application/json' },
    ));
    Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
    input.dispatchEvent(new Event('change', { bubbles: true }));

    await waitFor(() => (
      document.querySelectorAll('#sublist .sub-row').length === 80
      && document.querySelectorAll('#tlTracks .tl-track').length >= 2
    ), 'project render');

    const list = document.getElementById('sublist');
    const initialRowCount = list.querySelectorAll('.sub-row').length;
    list.style.flex = 'none';
    list.style.height = '180px';
    list.scrollTop = 0;
    await new Promise(resolve => requestAnimationFrame(resolve));

    const timelineRows = [...document.querySelectorAll('#tlTracks .tl-track')].slice(0, 2);
    const blocks = [...timelineRows[1].querySelectorAll('.cue-block')];
    const block = blocks.reduce((far, item) => (
      !far || Number.parseFloat(item.style.left) > Number.parseFloat(far.style.left) ? item : far
    ), null);
    if (!block) throw new Error('missing far cue block on track 1');
    const targetId = block.dataset.id;

    block.scrollIntoView({ block: 'center', inline: 'center' });
    await new Promise(resolve => requestAnimationFrame(resolve));
    const currentBlock = document.querySelector('.cue-block[data-id="' + targetId + '"]');
    if (!currentBlock) throw new Error('target cue block disappeared after scroll');
    const blockRect = currentBlock.getBoundingClientRect();
    const x = blockRect.left + blockRect.width / 2;
    const y = blockRect.top + blockRect.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (hit !== currentBlock && !currentBlock.contains(hit)) {
      throw new Error('target cue block failed hit-test: ' + JSON.stringify({
        block: { left: blockRect.left, top: blockRect.top, right: blockRect.right, bottom: blockRect.bottom },
        point: { x, y },
        hit: hit ? { tag: hit.tagName, id: hit.id, className: hit.className } : null,
        ancestors: [currentBlock, currentBlock.parentElement, currentBlock.parentElement?.parentElement, currentBlock.parentElement?.parentElement?.parentElement]
          .filter(Boolean).map(node => ({
            tag: node.tagName, id: node.id, className: node.className,
            display: getComputedStyle(node).display, visibility: getComputedStyle(node).visibility,
            rect: (() => { const rect = node.getBoundingClientRect(); return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }; })(),
          })),
      }));
    }

    return {
      targetId,
      x,
      y,
      initialRowCount,
      timelineCueCounts: timelineRows.map(item => item.querySelectorAll('.cue-block').length),
    };
  })()`;
}

function measurePageScenario(setup) {
  return `(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const targetId = ${JSON.stringify(setup.targetId)};
    const list = document.getElementById('sublist');

    const row = list.querySelector('.sub-row[data-id="' + targetId + '"]');
    if (!row) throw new Error('selected row was not rendered');
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    return {
      selected: row.classList.contains('sel'),
      primary: row.classList.contains('primary'),
      targetId,
      primaryId: list.querySelector('.sub-row.primary')?.dataset.id || null,
      listTrack: document.getElementById('listTrackSel').value,
      initialRowCount: ${JSON.stringify(setup.initialRowCount)},
      rowCount: list.querySelectorAll('.sub-row').length,
      timelineCueCounts: ${JSON.stringify(setup.timelineCueCounts)},
      framesWaited: 2,
      list: { top: listRect.top, bottom: listRect.bottom, height: listRect.height },
      row: { top: rowRect.top, bottom: rowRect.bottom, height: rowRect.height },
      visible: rowRect.bottom > listRect.top && rowRect.top < listRect.bottom,
    };
  })()`;
}

async function run() {
  if (!appEntry) throw new Error('missing --app-entry');
  const win = new BrowserWindow({
    x: -10000,
    y: -10000,
    width: 1200,
    height: 900,
    show: true,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  await win.loadURL(appEntry);
  const setup = await win.webContents.executeJavaScript(setupPageScenario(), true);
  const client = win.webContents.debugger;
  client.attach('1.3');
  try {
    await client.sendCommand('Page.bringToFront');
    await client.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: setup.x, y: setup.y, button: 'left', clickCount: 1,
    });
    await client.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: setup.x, y: setup.y, button: 'left', clickCount: 1,
    });
    const result = await win.webContents.executeJavaScript(measurePageScenario(setup), true);
    process.stdout.write(`${RESULT_MARKER}${JSON.stringify(result)}\n`);
  } finally {
    if (client.isAttached()) client.detach();
    win.destroy();
    app.quit();
  }
}

app.whenReady()
  .then(run)
  .catch(error => {
    process.stderr.write(`${error?.stack || error}\n`);
    app.exit(1);
  });
app.on('window-all-closed', () => app.quit());
