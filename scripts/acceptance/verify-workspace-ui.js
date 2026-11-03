/* npm run build && node scripts/acceptance/verify-workspace-ui.js [證據目錄]
   獨立 profile、展示資料與 CDP；不擷取整個桌面、不操作使用者專案。
   檢查真實 Chromium 排版、命中測試、原生鍵盤預設行為及背景像素。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { captureDocumentationWorkspace } = require('./capture-documentation-workspace.js');
const { delay } = require('./cdp-electron-harness.js');

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
  await client.evaluate(`document.querySelector('[data-act="settings"]').focus()`);
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', text: ' ', windowsVirtualKeyCode: 32 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  const keyboard = await client.evaluate(`({ opened: !!document.getElementById('settingsModal'), focusInside: !!document.activeElement.closest('#settingsModal'), role: document.getElementById('settingsModal')?.querySelector('[role="dialog"]')?.getAttribute('aria-modal') })`);
  assert(keyboard.opened && keyboard.focusInside && keyboard.role === 'true', '空白鍵必須啟動已聚焦的設定按鈕，焦點須進入對話框');
  // 初始焦點在錄鍵欄位；Shift+Tab 應導覽到儲存按鈕，不把 Tab 錄成設定。
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', modifiers: 8, windowsVirtualKeyCode: 9 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', modifiers: 8, windowsVirtualKeyCode: 9 });
  keyboard.tabWrapped = await client.evaluate(`document.activeElement === document.getElementById('settingsSaveBtn')`);
  assert(keyboard.tabWrapped, 'Shift+Tab 必須在設定視窗內循環焦點');
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  keyboard.focusRestored = await client.evaluate(`!document.getElementById('settingsModal') && document.activeElement === document.querySelector('[data-act="settings"]')`);
  fs.writeFileSync(path.join(dir, 'workspace-keyboard.json'), JSON.stringify({ menu, ...keyboard }, null, 2));
  assert(keyboard.focusRestored, '取消設定後須把鍵盤焦點還給設定按鈕');
  console.log(JSON.stringify({ widths: results.map(r => r.width), reachable: true, blackSamples: results.reduce((n, r) => n + r.pixels.length, 0), menu, keyboard }));
}

const dir = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-workspace-ui-')));
captureDocumentationWorkspace(path.join(dir, 'workspace-final.png'), inspect)
  .catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
