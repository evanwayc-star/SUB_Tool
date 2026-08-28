/* ============================================================================
   時間軸媒體右鍵選單 —— Electron / CDP 驗收
   ============================================================================
   先執行 npm run build，再執行：
     node scripts/acceptance/verify-media-context-menus.js

   以真實影音素材載入桌面版，驗證影片、鎖定影片、影片原音與左側音訊列頭
   的最終選單順序。檔案定位 callback 的精確路徑另由 jsdom 整合測試覆蓋，
   這裡不真的打開檔案管理器，避免驗收時干擾使用者桌面。
   ============================================================================ */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
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

function projectBytes(mediaPath, size) {
  const data = {
    app: 'SUB Tool',
    version: 3,
    media: { name: path.basename(mediaPath), size, path: mediaPath },
    duration: 6,
    fps: 25,
    tracks: [],
    cues: [],
    notes: [],
    videoTracks: [{ name: '視訊軌 1', visible: true, locked: false }],
    clips: [{
      id: 'menu-acceptance-primary',
      name: path.basename(mediaPath),
      path: mediaPath,
      dur: 6,
      in: 0,
      out: 6,
      offset: 0,
      vtrack: 0,
      primary: true,
      locked: false,
    }],
    playhead: 1,
  };
  return Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(JSON.stringify(data), 'utf16le')]);
}

async function elementRect(client, selector) {
  return waitFor(() => client.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  })()`), selector, 15000);
}

async function openMenu(client, selector) {
  await client.evaluate(`(() => {
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    return true;
  })()`);
  await delay(50);
  const rect = await elementRect(client, selector);
  await dispatchClick(client, rect, 'right');
  await waitFor(
    () => client.evaluate(`document.getElementById('ctxmenu')?.classList.contains('show') === true`),
    `${selector} 右鍵選單`,
    5000
  );
  return client.evaluate(`(() => [...document.querySelectorAll('#ctxmenu > *')].map(element => ({
    id: element.dataset.menuId || '',
    text: element.textContent.trim(),
    role: element.getAttribute('role') || '',
  })))()`);
}

function ids(items) {
  return items.map(item => item.id);
}

(async () => {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('找不到 dist/index.html，請先執行 npm run build');
  }
  const profileDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-menu-cdp-'));
  const fixturePath = path.join(profileDir, 'menu-fixture.mp4');
  const projectPath = path.join(profileDir, 'menu-acceptance.subtool');
  const screenshotPath = path.join(os.tmpdir(), 'subtool-media-context-menu-acceptance.png');
  const ffmpeg = path.join(ROOT, 'electron', 'ffmpeg', 'ffmpeg.exe');
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000',
    '-t', '6', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', fixturePath,
  ], { cwd: ROOT, windowsHide: true, stdio: 'pipe' });
  fs.writeFileSync(projectPath, projectBytes(fixturePath, fs.statSync(fixturePath).size));

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
    projectPath,
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
    await waitFor(
      () => client.evaluate(`Boolean(window.SUB?.State?.clips?.length === 1
        && document.querySelector('.clip-block')
        && document.querySelector('.audio-clip-block')
        && document.querySelector('.agtrack'))`),
      '影音片段與音訊列完成',
      30000
    );
    await client.evaluate('window.SUB.Media.seek(1); true');
    await delay(500);

    const videoMenu = await openMenu(client, '.clip-block');
    assert.deepEqual(ids(videoMenu), [
      'heading',
      'reveal_source',
      'seek_clip_start',
      'separator',
      'split_at_playhead',
      'edit_duration',
      'edit_geometry',
      'separator',
      'detach_audio',
      'audio_routing',
      'separator',
      'move_track_up',
      'separator',
      'fade',
      'crossfade_previous',
      'separator',
      'remove_clip',
    ]);

    await client.evaluate(`(() => {
      window.SUB.State.videoTracks[0].locked = true;
      window.SUB.drawTimeline();
      return true;
    })()`);
    await delay(150);
    const lockedVideoMenu = await openMenu(client, '.clip-block');
    assert.deepEqual(ids(lockedVideoMenu), [
      'heading', 'locked_status', 'reveal_source', 'seek_clip_start',
    ]);
    assert.equal(lockedVideoMenu.find(item => item.id === 'locked_status')?.role, 'status');

    await client.evaluate(`(() => {
      window.SUB.State.videoTracks[0].locked = false;
      window.SUB.State.clips[0].locked = true;
      window.SUB.drawTimeline();
      return true;
    })()`);
    await delay(150);
    const lockedAudioMenu = await openMenu(client, '.audio-clip-block');
    assert.ok(ids(lockedAudioMenu).includes('locked_status'));
    assert.ok(ids(lockedAudioMenu).includes('reveal_source'));
    assert.ok(ids(lockedAudioMenu).includes('speech_recognition'));
    assert.ok(ids(lockedAudioMenu).includes('audio_routing'));
    assert.ok(!ids(lockedAudioMenu).includes('remove_audio'));

    const gutterMenu = await openMenu(client, '.agtrack');
    assert.ok(ids(gutterMenu).includes('locked_status'));
    assert.ok(ids(gutterMenu).includes('reveal_source'));
    assert.ok(ids(gutterMenu).includes('audio_routing'));

    await delay(200);
    const screenshot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    const lockStyle = await client.evaluate(`(() => {
      const element = document.querySelector('#ctxmenu [data-menu-id="locked_status"]');
      const style = getComputedStyle(element);
      return { color: style.color, backgroundColor: style.backgroundColor, fontWeight: style.fontWeight };
    })()`);

    console.log(JSON.stringify({
      videoMenu: ids(videoMenu),
      lockedVideoMenu: ids(lockedVideoMenu),
      lockedAudioMenu: ids(lockedAudioMenu),
      gutterMenu: ids(gutterMenu),
      lockStyle,
      screenshotPath,
    }, null, 2));
  } finally {
    client?.close();
    if (!child.killed) child.kill();
    await delay(500);
    try { verifiedCleanup(profileDir, 'subtool-menu-cdp-'); }
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
