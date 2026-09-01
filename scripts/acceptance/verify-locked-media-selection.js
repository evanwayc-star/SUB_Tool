/* ============================================================================
   鎖定影音區塊不得改變既有選取 —— Electron / CDP 驗收
   ============================================================================
   先執行 npm run build，再執行：
     node scripts/acceptance/verify-locked-media-selection.js

   使用 CDP 真實滑鼠輸入依序點擊、按住拖曳鎖定的影像軌片段、影片來源音訊與外部音訊；
   三者都必須保留既有選取、不可編輯鎖定區塊，並讓播放點跟著滑鼠移動。
   ============================================================================ */
const assert = require('assert/strict');
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
  dispatchClick,
  verifiedCleanup,
} = require('./cdp-electron-harness.js');

async function elementRect(client, selector) {
  return waitFor(() => client.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    const x = rect.left + Math.min(20, rect.width / 2);
    const y = rect.top + Math.min(10, rect.height / 2);
    const hit = document.elementFromPoint(x, y);
    if (!hit || !element.contains(hit)) return null;
    const timelineRect = document.getElementById('tlLayer').getBoundingClientRect();
    const timelineTime = window.SUB.State.viewStart + (x - timelineRect.left) / window.SUB.State.pxPerSec;
    const inwardDragDeltaX = x > timelineRect.left + timelineRect.width / 2 ? -40 : 40;
    return { left: x - 1, top: y - 1, width: 2, height: 2, timelineTime, inwardDragDeltaX };
  })()`), selector, 15000);
}

function selectionSnapshot(client) {
  return client.evaluate(`(() => ({
    selectedId: window.SUB.State.selectedId,
    selectedIds: [...window.SUB.State.selectedIds],
    selectedClipId: window.SUB.State.selectedClipId,
    selectedAudioClipId: window.SUB.State.selectedAudioClipId,
  }))()`);
}

function playheadSnapshot(client) {
  return client.evaluate(`(() => {
    const time = window.SUB.Media.displayTime();
    const left = Number.parseFloat(document.getElementById('tlPlayhead').style.left);
    const expectedLeft = (time - window.SUB.State.viewStart) * window.SUB.State.pxPerSec;
    return { time, left, expectedLeft };
  })()`);
}

function mediaGeometrySnapshot(client) {
  return client.evaluate(`(() => ({
    clips: window.SUB.State.clips.map(({ id, offset, in: inPoint, out, vtrack }) => ({ id, offset, in: inPoint, out, vtrack })),
    externalAudio: window.SUB.Media.externalAudio.list().map(({ id, offset, in: inPoint, out }) => ({ id, offset, in: inPoint, out })),
  }))()`);
}

async function dispatchDrag(client, rect, deltaX) {
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + deltaX / 2, y, button: 'left', buttons: 1 });
  await delay(60);
  const middle = await playheadSnapshot(client);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + deltaX, y, button: 'left', buttons: 1 });
  await delay(60);
  const end = await playheadSnapshot(client);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + deltaX, y, button: 'left', clickCount: 1 });
  return { middle, end };
}

(async () => {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('找不到 dist/index.html，請先執行 npm run build');
  }
  const profileDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-locked-selection-cdp-'));
  const port = await reservePort();
  const errors = [];
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
  child.stderr.on('data', chunk => errors.push(chunk.toString()));

  let client;
  try {
    const target = await waitFor(async () => {
      const targets = await getJSON(`http://127.0.0.1:${port}/json/list`);
      return targets.find(item => item.type === 'page' && item.title === 'SUB TOOL');
    }, 'SUB Tool 主視窗啟動', 20000);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Page.bringToFront');
    await waitFor(() => client.evaluate('Boolean(window.SUB?.State)'), 'window.SUB', 15000);

    const audioIds = await client.evaluate(`(() => {
      const S = window.SUB;
      S.Media.externalAudio.clear();
      Object.assign(S.State, {
        tracks: [{ name: '字幕', visible: true, locked: false }],
        trackCount: 1,
        cues: [{ id: 'keep-subtitle', text: '保持選取', start: 1, end: 2, track: 0, timed: true }],
        listTrack: 0,
        videoTracks: [
          { name: 'V1', visible: true, locked: false },
          { name: 'V2', visible: true, locked: true },
        ],
        clips: [
          { id: 'locked-video', name: '鎖定影像', type: 'video', offset: 0.5, in: 0, out: 1.5, dur: 1.5, vtrack: 1, audioDetached: true },
          { id: 'locked-linked-audio', name: '鎖定影片音訊', type: 'video', audioSourceId: 'locked-linked-source', offset: 3, in: 0, out: 1.5, dur: 1.5, vtrack: 0, locked: true, audioDetached: false },
        ],
        duration: 8,
        fps: 24,
        dropFrame: false,
        viewStart: 0,
        pxPerSec: 80,
      });
      const external = S.Media.externalAudio.add({
        name: '鎖定外部音訊', audioSourceId: 'locked-external-source',
        offset: 5.5, in: 0, out: 1.5, duration: 1.5, locked: true,
      });
      const selectableExternal = S.Media.externalAudio.add({
        name: '可選外部音訊', audioSourceId: 'selectable-external-source',
        offset: 7, in: 0, out: 0.75, duration: 0.75, locked: false,
      });
      S.renderAll();
      S.drawTimeline();
      return { locked: external.id, selectable: selectableExternal.id };
    })()`);

    const cases = [
      ['鎖定影像軌片段', '.clip-block[data-clip-id="locked-video"]'],
      ['鎖定影片來源音訊', '.audio-clip-block[data-clip-id="locked-linked-audio"]'],
      ['鎖定外部音訊', `.external-audio-block[data-audio-asset-id="${audioIds.locked}"]`],
    ];
    const selectionCases = [
      {
        name: '字幕選取',
        prepare: async () => { await client.evaluate(`window.SUB.selectCue('keep-subtitle'); true`); },
        expected: {
          selectedId: 'keep-subtitle', selectedIds: ['keep-subtitle'],
          selectedClipId: null, selectedAudioClipId: null,
        },
      },
      {
        name: '影片選取',
        prepare: async () => {
          const rect = await elementRect(client, '.clip-block[data-clip-id="locked-linked-audio"]');
          await dispatchClick(client, rect);
        },
        expected: {
          selectedId: null, selectedIds: [],
          selectedClipId: 'locked-linked-audio', selectedAudioClipId: null,
        },
      },
      {
        name: '音訊選取',
        prepare: async () => {
          const rect = await elementRect(client, `.external-audio-block[data-audio-asset-id="${audioIds.selectable}"]`);
          await dispatchClick(client, rect);
        },
        expected: {
          selectedId: null, selectedIds: [],
          selectedClipId: null, selectedAudioClipId: audioIds.selectable,
        },
      },
    ];

    const results = [];
    const originalGeometry = await mediaGeometrySnapshot(client);
    for (const selectionCase of selectionCases) {
      await selectionCase.prepare();
      await delay(50);
      assert.deepEqual(await selectionSnapshot(client), selectionCase.expected, `${selectionCase.name}準備失敗`);
      for (const [name, selector] of cases) {
        const rect = await elementRect(client, selector);
        await dispatchClick(client, rect);
        await delay(100);
        const selection = await selectionSnapshot(client);
        const playhead = await playheadSnapshot(client);
        const expectedPlayheadTime = Math.round(rect.timelineTime * 24) / 24;
        assert.deepEqual(selection, selectionCase.expected, `${name}改變了既有${selectionCase.name}`);
        assert.equal(playhead.time, expectedPlayheadTime, `${name}沒有精準吸附到點擊位置的影格`);
        assert.ok(Math.abs(playhead.left - playhead.expectedLeft) < 0.01, `${name}的播放點 DOM 沒有同步`);
        results.push({
          selection: selectionCase.name, target: name,
          playheadTime: playhead.time, clickedTimelineTime: rect.timelineTime,
          playheadLeft: playhead.left,
        });
      }
      for (const [name, selector] of cases) {
        const rect = await elementRect(client, selector);
        const dragResult = await dispatchDrag(client, rect, rect.inwardDragDeltaX);
        const expectedStartTime = Math.round(rect.timelineTime * 24) / 24;
        const expectedEndTime = Math.round((rect.timelineTime + rect.inwardDragDeltaX / 80) * 24) / 24;
        assert.deepEqual(await selectionSnapshot(client), selectionCase.expected, `${name}拖曳時改變了既有${selectionCase.name}`);
        assert.deepEqual(await mediaGeometrySnapshot(client), originalGeometry, `${name}拖曳時修改了鎖定素材`);
        assert.ok(
          rect.inwardDragDeltaX > 0 ? dragResult.middle.time > expectedStartTime : dragResult.middle.time < expectedStartTime,
          `${name}按住拖曳時播放點沒有跟著移動`
        );
        assert.equal(dragResult.end.time, expectedEndTime, `${name}拖曳結束位置未精準吸附影格`);
        assert.ok(Math.abs(dragResult.end.left - dragResult.end.expectedLeft) < 0.01, `${name}拖曳後播放點 DOM 沒有同步`);
        results.push({
          selection: selectionCase.name, target: `${name}拖曳`,
          middlePlayheadTime: dragResult.middle.time,
          endPlayheadTime: dragResult.end.time,
          expectedEndTime,
        });
      }
    }

    console.log(JSON.stringify({ passed: true, results }, null, 2));
  } finally {
    client?.close();
    if (!child.killed) child.kill();
    await delay(500);
    try { verifiedCleanup(profileDir, 'subtool-locked-selection-cdp-'); }
    catch (error) { console.warn(error.message); }
    if (errors.length) {
      const important = errors.join('').split(/\r?\n/).filter(line => /error|failed|exception/i.test(line));
      if (important.length) console.warn(important.join('\n'));
    }
  }
})().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
