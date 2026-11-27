/* node scripts/acceptance/verify-timeline-group-drag.js [path/to/built/index.html]
 * Run the same gestures against two builds to compare press, preview and release.
 * Use a hidden renderer and a temporary profile so the editor stays untouched. */
/* global document, window, requestAnimationFrame, MouseEvent */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {ROOT, verifiedCleanup} = require('./cdp-electron-harness');

async function exercise() {
  const {State, History, ensureTrackCount, setZoom, setFps, renderAll, drawTimeline, recordHistory} = window.SUB;
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const block = () => document.querySelector('#tlTracks .cue-block[data-id="line-0"]');
  const pressPoint = () => {
    check(block(), '畫面找不到 line-0，時間軸起點 ' + State.viewStart + '，軌道數 ' + State.trackCount);
    const box = block().getBoundingClientRect();
    return {x:box.x + box.width / 2, y:box.y + box.height / 2};
  };
  const mouse = (target, type, x, y) => {
    const start = performance.now();
    target.dispatchEvent(new MouseEvent(type, {view:window, bubbles:true, cancelable:true,
      clientX:x, clientY:y, button:0, buttons:type === 'mouseup' ? 0 : 1}));
    return Math.round((performance.now() - start) * 10) / 10;
  };
  const checkCues = delta => {
    check(State.cues.length === 10000 && State.selectedIds.length === 2500, '字幕總數或選取改變');
    for (const cue of State.cues) {
      const i = Number(cue.id.slice(5)), start = i * 2 + (i % 4 === 0 ? delta : 0);
      check(Math.abs(cue.start - start) < 1e-6 && Math.abs(cue.end - start - 1) < 1e-6 && cue.track === 0,
        '起訖或軌道不符 ' + cue.id);
    }
  };

  State.cues = Array.from({length:10000}, (_, i) => ({id:'line-' + i, track:0, timed:true,
    start:i * 2, end:i * 2 + 1, text:(i % 4 === 0 ? '群組' : '旁白') + i}));
  ensureTrackCount(1); State.duration = 20000; State.overwriteMode = false;
  setFps(25); setZoom(100, 0); renderAll(); drawTimeline(); await frame();
  const first = pressPoint();
  mouse(block(), 'mousedown', first.x, first.y);
  mouse(window, 'mouseup', first.x, first.y);
  Array.from(document.querySelectorAll('#modalFoot button')).find(b => b.textContent === '稍後再說')?.click();
  document.querySelector('[data-act="search-open"]').click();
  const input = document.getElementById('searchInput');
  input.value = '群組'; input.dispatchEvent(new Event('input', {bubbles:true}));
  document.querySelector('[data-act="search-select-all"]').click();
  document.querySelector('[data-act="search-close"]').click();
  recordHistory('來源'); checkCues(0);

  const samples = [];
  for (let i = 0; i < 5; i++) {
    await frame();
    const {x, y} = pressPoint(), dx = i % 2 ? -20 : 20, before = History.hi;
    const left = block().getBoundingClientRect().left;
    const down = mouse(block(), 'mousedown', x, y);
    const move = mouse(window, 'mousemove', x + dx, y);
    const preview = block().getBoundingClientRect().left;
    const up = mouse(window, 'mouseup', x + dx, y);
    await frame();
    const committed = block().getBoundingClientRect().left;
    check(Math.abs(preview - left - dx) < 0.1 && Math.abs(committed - preview) < 0.1, '預覽與放開的位置不一致');
    check(History.hi === before + 1, '一次拖曳應新增一筆歷程');
    checkCues(i % 2 ? 0 : 0.2);
    samples.push({down, move, up, deltaPx:committed - left});
  }
  History.undo(); await frame(); checkCues(0);
  History.redo(); await frame(); checkCues(0.2);
  setZoom(100, 0); await frame();
  const {x, y} = pressPoint();
  mouse(block(), 'mousedown', x, y); mouse(window, 'mousemove', x + 250, y); mouse(window, 'mouseup', x + 250, y);
  checkCues(1);
  return {cues:State.cues.length, selected:State.selectedIds.length, samples};
}

if (process.versions.electron) {
  const {app, BrowserWindow} = require('electron');
  app.whenReady().then(async () => {
    const win = new BrowserWindow({show:false, width:1400, height:950,
      webPreferences:{offscreen:true, backgroundThrottling:false}});
    await win.loadFile(process.env.SUBTOOL_TIMELINE_TEST_ENTRY);
    const report = await win.webContents.executeJavaScript('(' + exercise.toString() + ')()');
    console.log(JSON.stringify(report));
    app.exit(0);
  }).catch(error => { console.error(error); app.exit(1); });
} else {
  const profile = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-timeline-drag-'));
  try {
    const entry = path.resolve(process.argv[2] || path.join(ROOT, 'dist', 'index.html'));
    const result = spawnSync(require('electron'), [__filename, '--user-data-dir=' + profile], {
      env:{...process.env, SUBTOOL_TIMELINE_TEST_ENTRY:entry}, windowsHide:true, stdio:'inherit', timeout:90000,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, '時間軸拖曳驗收失敗');
  } finally { verifiedCleanup(profile, 'subtool-timeline-drag-'); }
}
