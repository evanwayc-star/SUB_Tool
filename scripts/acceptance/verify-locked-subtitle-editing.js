/* ============================================================================
   鎖定字幕軌唯讀 —— Electron / CDP 真機驗收
   ============================================================================
   先執行 npm run build，再執行：
     node scripts/acceptance/verify-locked-subtitle-editing.js

   驗證鎖定軌字幕的內容、In/Out、樣式與刪除命令皆不改資料或 History。
   ============================================================================ */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  isMainWindowTarget,
  ROOT,
  ELECTRON,
  delay,
  reservePort,
  getJSON,
  waitFor,
  CdpClient, trackElectron, stopElectron,
  dispatchKey,
  verifiedCleanup,
} = require('./cdp-electron-harness.js');

async function lockedSubtitleViewSnapshot(page) {
  const { document } = page;
  const selector = '.sub-row[data-id="locked-subtitle"] .txt';
  document.querySelector(selector)?.scrollIntoView({ block: 'nearest' });
  // content-visibility:auto and a list rebuild can invalidate the previous editor.
  await new Promise(resolve => page.requestAnimationFrame(resolve));
  await new Promise(resolve => page.requestAnimationFrame(resolve));
  const txt = document.querySelector(selector);
  const style = txt && page.getComputedStyle(txt);
  const rect = txt?.getBoundingClientRect();
  return {
    displayedText: txt?.textContent ?? null,
    textConnected: txt?.isConnected === true,
    textReadonly: txt?.contentEditable === 'false',
    textVisible: !!rect && rect.width > 0 && rect.height > 0
      && style.display !== 'none' && style.visibility === 'visible',
    styleDisabled: document.getElementById('tsSize')?.disabled === true,
  };
}

(async () => {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('找不到 dist/index.html，請先執行 npm run build');
  }
  const profileDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-locked-subtitle-cdp-'));
  const port = await reservePort();
  const errors = [];
  const child = trackElectron(spawn(ELECTRON, [
    '.',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--subtool-transport-acceptance',
    '--no-sandbox',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  }));
  child.stderr.on('data', chunk => errors.push(chunk.toString()));

  let client;
  try {
    const target = await waitFor(async () => {
      const targets = await getJSON(`http://127.0.0.1:${port}/json/list`);
      return targets.find(isMainWindowTarget);
    }, 'SUB Tool 主視窗啟動', 20000);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Page.bringToFront');
    await waitFor(() => client.evaluate('Boolean(window.SUB?.State)'), 'window.SUB', 15000);

    const before = await client.evaluate(`(() => {
      const S = window.SUB;
      Object.assign(S.State, {
        tracks: [{ name: '鎖定字幕', visible: true, locked: true }],
        trackCount: 1,
        cues: [{
          id: 'locked-subtitle', text: '原始內容', start: 1, end: 2,
          track: 0, timed: true, style: { fontSize: 60 },
        }],
        listTrack: 0,
        selectedId: 'locked-subtitle',
        selectedIds: ['locked-subtitle'],
        activeTrackKind: 'sub',
        keymap: { shift_timecode: [{ key: 'p' }] },
        duration: 10,
      });
      S.renderAll();
      S.drawTimeline();
      S.selectCue('locked-subtitle');
      S.renderTrackStyle();
      const cue = S.State.cues[0];
      return {
        cue: structuredClone(cue),
        trackCount: S.State.tracks.length,
        historyLength: S.History.stack.length,
        styleDisabled: document.getElementById('tsSize').disabled,
        styleTitle: document.getElementById('tsTitle').textContent,
      };
    })()`);
    assert.equal(before.styleDisabled, true, '鎖定字幕的樣式欄位仍可操作');
    assert.equal(before.styleTitle, '字幕樣式｜軌道已鎖定');

    await client.evaluate(`(() => { window.__lockedSetIn = window.SUB.setIn(); return true; })()`);
    await waitFor(() => client.evaluate(`(() => {
      const button = document.querySelector('#modalFoot button:last-child');
      if (!button) return false;
      button.click();
      return true;
    })()`), '略過第一次編輯儲存提示', 5000);
    await client.evaluate('window.__lockedSetIn');
    await client.evaluate('window.SUB.setOut()');
    await dispatchKey(client, 'p', 'KeyP');
    await delay(100);

    const after = await client.evaluate(`(() => {
      const S = window.SUB;
      const txt = document.querySelector('.sub-row[data-id="locked-subtitle"] .txt');
      txt.dataset.orig = '原始內容';
      txt.contentEditable = 'true';
      txt.innerText = '不應寫入';
      txt.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '不應寫入' }));
      txt.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

      const size = document.getElementById('tsSize');
      size.value = '120';
      size.dispatchEvent(new Event('input', { bubbles: true }));
      S.deleteSelected();
      S.removeTrack(0);

      return {
        cue: structuredClone(S.State.cues[0]),
        trackCount: S.State.tracks.length,
        historyLength: S.History.stack.length,
        toast: document.getElementById('toast')?.textContent || '',
      };
    })()`);

    Object.assign(after, await client.evaluate('(' + lockedSubtitleViewSnapshot.toString() + ')(window)'));
    assert.deepEqual(after.cue, before.cue, '鎖定字幕的內容、In/Out 或樣式被修改');
    assert.equal(after.trackCount, before.trackCount, '鎖定字幕軌被刪除');
    assert.equal(after.historyLength, before.historyLength, '被擋下的操作仍寫入 History');
    assert.equal(after.displayedText, '原始內容', '鎖定字幕列沒有恢復原內容');
    assert.equal(after.textConnected, true, '鎖定字幕列不是目前 DOM 上的元素');
    assert.equal(after.textReadonly, true, '鎖定字幕列沒有恢復唯讀');
    assert.equal(after.textVisible, true, '鎖定字幕列沒有實際顯示');
    assert.equal(after.styleDisabled, true, '鎖定字幕樣式面板沒有保持唯讀');
    assert.match(after.toast, /已鎖定/u, '被擋下時沒有鎖定提示');

    console.log(JSON.stringify({ passed: true, before, after }, null, 2));
  } finally {
    client?.close();
    await stopElectron(child);
    verifiedCleanup(profileDir, 'subtool-locked-subtitle-cdp-');
    if (errors.length) {
      const important = errors.join('').split(/\r?\n/).filter(line => /error|failed|exception/i.test(line));
      if (important.length) console.warn(important.join('\n'));
    }
  }
})().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
