/* npm run build && node scripts/acceptance/verify-workspace-ui.js [證據目錄]
   獨立 profile、展示資料與 CDP；不擷取整個桌面、不操作使用者專案。
   檢查真實 Chromium 排版、命中測試、原生鍵盤預設行為及背景像素。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { captureDocumentationWorkspace } = require('./capture-documentation-workspace.js');
const { delay, dispatchClick, waitFor } = require('./cdp-electron-harness.js');

/* The following two functions are serialized into the isolated renderer by CDP. */
/* global document, getComputedStyle, innerWidth, Image */
function measureWorkspace() {
  const rect = e => e.getBoundingClientRect();
  const visible = e => { const s = getComputedStyle(e), r = rect(e); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const controls = [...document.querySelectorAll('.menubar button,.menubar select,.tl-toolbar button,.tl-toolbar input,.tl-toolbar select')].filter(e => visible(e) && !e.disabled && e.getAttribute('aria-disabled') !== 'true');
  const unreachable = controls.flatMap(e => {
    const r = rect(e);
    const points = [[r.left + 2, r.top + r.height / 2], [r.right - 2, r.top + r.height / 2], [r.left + r.width / 2, r.top + r.height / 2]];
    const reached = points.every(([x, y]) => { const target = document.elementFromPoint(x, y); return target === e || e.contains(target); });
    return reached ? [] : [{ label: e.innerText || e.title || e.id, x: r.x, y: r.y, width: r.width }];
  });
  const list = rect(document.querySelector('.sublist'));
  const rows = [...document.querySelectorAll('.sub-row')].filter(e => !e.matches('.sel,.active,.blank,.two-line,.overlap,.search-hit') && rect(e).y < list.bottom - 4 && rect(e).bottom > list.y + 4);
  const pixels = rows.slice(0, 2).map(e => ({ name: 'subtitle-' + e.dataset.id, x: Math.floor(rect(e).x + 8), y: Math.floor(Math.min(rect(e).bottom, list.bottom) - 3) }));
  for (const selector of ['.tl-gutter', '.tl-scroll']) {
    const r = rect(document.querySelector(selector));
    pixels.push({ name: selector, x: Math.floor(r.x + 20), y: Math.floor(r.bottom - 15) });
  }
  return { width: innerWidth, unreachable, pixels };
}

async function readPixels(data, points) {
  const img = new Image(); img.src = 'data:image/png;base64,' + data; await img.decode();
  const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
  const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
  return points.map(p => ({ ...p, rgba: [...ctx.getImageData(p.x, p.y, 1, 1).data] }));
}

async function inspect(client, dir) {
  await client.evaluate(`document.getElementById('rightPanel').style.width='570px'; document.getElementById('timelinePanel').style.height='440px'`);
  await client.evaluate(`if (!window.SUB.State.overwriteMode) document.querySelector('[data-act="toggle-overwrite"]').click()`);
  const results = [];
  for (const width of [1920, 1600, 1366, 1280, 1024]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await delay(200);
    const state = await client.evaluate('(' + measureWorkspace.toString() + ')()');
    const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(dir, 'workspace-' + width + '.png'), Buffer.from(shot.data, 'base64'));
    state.pixels = await client.evaluate('(' + readPixels.toString() + ')(' + JSON.stringify(shot.data) + ',' + JSON.stringify(state.pixels) + ')');
    results.push(state);
  }
  fs.writeFileSync(path.join(dir, 'workspace-layout.json'), JSON.stringify(results, null, 2));
  assert.deepEqual(results.flatMap(r => r.unreachable.map(control => ({ viewport: r.width, ...control }))), [], '工具列控制項必須完整可點擊');
  assert(results.every(r => r.pixels.length === 4 && r.pixels.every(p => p.rgba.join(',') === '0,0,0,255')), '一般字幕列與空白時間軸必須純黑');
  const menu = await client.evaluate(`(() => {
    document.querySelector('#recentMenu > button').click();
    const popup = document.querySelector('#recentMenu .items'), r = popup.getBoundingClientRect();
    const target = document.elementFromPoint(r.left + r.width / 2, r.bottom - 6);
    const result = { height: r.height, bottomReachable: target === popup || popup.contains(target) };
    document.querySelector('#recentMenu > button').click(); return result;
  })()`);
  assert(menu.height > 10 && menu.bottomReachable, '換行後最近開啟選單底端仍須可點擊');
  await client.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const press = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
    const params = { key, code, windowsVirtualKeyCode, modifiers };
    await client.send('Input.dispatchKeyEvent', { ...params, type: 'keyDown', ...(key === ' ' ? { text: ' ' } : {}) });
    await client.send('Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
  };
  const clickToolbar = async action => {
    const rect = await client.evaluate(`(() => {
      const { left, top, width, height } = document.querySelector('.menubar [data-act="${action}"]').getBoundingClientRect();
      return { left, top, width, height };
    })()`);
    assert(rect.width > 0 && rect.height > 0, `工具列 ${action} 必須可見`);
    await dispatchClick(client, rect);
  };
  await client.evaluate(`document.getElementById('fpsSel').focus()`);
  await press('Tab', 'Tab', 9);
  const tabFocus = await client.evaluate(`Boolean(document.activeElement?.closest('.transport'))`);
  assert(tabFocus, 'Tab 必須略過最上方操作按鈕，進入播放控制');
  await clickToolbar('settings');
  const keyboard = await client.evaluate(`({ opened: !!document.getElementById('settingsModal'), focusInside: !!document.activeElement.closest('#settingsModal'), role: document.getElementById('settingsModal')?.querySelector('[role="dialog"]')?.getAttribute('aria-modal') })`);
  assert(keyboard.opened && keyboard.focusInside && keyboard.role === 'true', '滑鼠開啟設定後，焦點須進入對話框');
  // 初始焦點在錄鍵欄位；Shift+Tab 應導覽到儲存按鈕，不把 Tab 錄成設定。
  await press('Tab', 'Tab', 9, 8);
  keyboard.tabWrapped = await client.evaluate(`document.activeElement === document.getElementById('settingsSaveBtn')`);
  assert(keyboard.tabWrapped, 'Shift+Tab 必須在設定視窗內循環焦點');
  await press('Escape', 'Escape', 27);
  keyboard.toolbarFocusReleased = await client.evaluate(`(() => {
    const settings = document.querySelector('.menubar [data-act="settings"]');
    settings.focus();
    return !document.getElementById('settingsModal') && document.activeElement === document.body
      && getComputedStyle(settings).outlineStyle === 'none';
  })()`);
  assert(keyboard.toolbarFocusReleased, '關窗及嘗試回復焦點後，工具列須保持無選中外框');
  await client.evaluate('window.SUB.History.reset()');
  await clickToolbar('project-settings');
  const applyRect = await client.evaluate(`(() => {
    const preset = document.getElementById('projectCanvasPreset');
    preset.value = '1080x1920';
    preset.dispatchEvent(new Event('change', { bubbles: true }));
    const { left, top, width, height } = document.getElementById('projectCanvasApply').getBoundingClientRect();
    return { left, top, width, height };
  })()`);
  await dispatchClick(client, applyRect);
  const canvasState = () => client.evaluate(`(() => {
    const { width, height } = document.getElementById('videoSub').getBoundingClientRect();
    return { projectCanvas: window.SUB.State.projectCanvas, width, height,
      modalOpen: document.getElementById('modalBg').classList.contains('show') };
  })()`);
  await waitFor(async () => (await canvasState()).projectCanvas?.height === 1920, '套用直式專案畫布');
  const portrait = await canvasState();
  assert.deepEqual(portrait.projectCanvas, { width: 1080, height: 1920 });
  assert(!portrait.modalOpen && Math.abs(portrait.width / portrait.height - 9 / 16) < 0.01, '預覽字幕層須貼齊直式畫布');
  await press('z', 'KeyZ', 90, 2);
  const undone = await canvasState();
  assert(undone.projectCanvas === null && Math.abs(undone.width / undone.height - 16 / 9) < 0.01, '復原須同時還原自動畫布與預覽比例');
  await press('Z', 'KeyZ', 90, 10);
  const redone = await canvasState();
  assert.deepEqual(redone, portrait, '重做須同時還原自訂尺寸與預覽比例');
  await press('z', 'KeyZ', 90, 2);
  fs.writeFileSync(path.join(dir, 'workspace-canvas.json'), JSON.stringify({ portrait, undone, redone }, null, 2));
  await client.evaluate(`(() => {
    const { State, Media } = window.SUB;
    State.mediaPath = 'C:/subtool-acceptance-fixture/source.mov';
    State.mediaName = 'source.mov';
    State.clips[0].path = State.mediaPath;
    window.toolbarPlayCount = 0;
    Media.play = async () => { window.toolbarPlayCount++; return true; };
  })()`);
  keyboard.exports = [];
  for (const [action, key, code, vk] of [['exp-dialog', ' ', 'Space', 32], ['exp-video', 'Enter', 'Enter', 13]]) {
    await clickToolbar(action);
    assert(await client.evaluate(`document.getElementById('modalBg').classList.contains('show')`), `滑鼠須能開啟 ${action}`);
    await press('Escape', 'Escape', 27);
    await delay(30);
    await press(key, code, vk);
    const state = await client.evaluate(`({ opened: document.getElementById('modalBg').classList.contains('show'),
      focused: !!document.activeElement.closest('.menubar button'), playCount: window.toolbarPlayCount })`);
    assert.deepEqual(state, { opened: false, focused: false, playCount: keyboard.exports.length + 1 }, `${action} 關窗後的按鍵須播放一次`);
    keyboard.exports.push({ action, ...state });
  }
  fs.writeFileSync(path.join(dir, 'workspace-keyboard.json'), JSON.stringify({ menu, ...keyboard }, null, 2));
  console.log(JSON.stringify({ widths: results.map(r => r.width), reachable: true, blackSamples: results.reduce((n, r) => n + r.pixels.length, 0), menu, keyboard }));
}

const dir = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-workspace-ui-')));
captureDocumentationWorkspace(path.join(dir, 'workspace-final.png'), inspect)
  .catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
