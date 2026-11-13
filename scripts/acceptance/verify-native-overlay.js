/* Windows OS-compositor acceptance; run with an unobstructed interactive desktop.
   npm run build
   node scripts/acceptance/verify-native-overlay.js
   node scripts/acceptance/verify-native-overlay.js "C:/Program Files/SUB Tool/SUB Tool.exe"

   Own profile, synthetic ProRes only. Main inspector reads identity/screenshots
   and controls the owned parent window; it never changes native visibility,
   viewport, shape or the production overlay implementation. CDP screenshots
   cannot establish whether the native mpv surface is visible, so every pixel
   assertion below uses the OS desktop compositor, cropped to this app only. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const {
  ROOT, ELECTRON, reservePort, getJSON, waitFor, delay, CdpClient,
  isMainWindowTarget, trackElectron, stopElectron, verifiedCleanup,
} = require('./cdp-electron-harness.js');
const { connectMainInspector } = require('../diagnostics/main-inspector.js');

const mainWindow = `E.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/dist/index.html'))`;
const samePath = (a, b) => path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();

function samplePixels(bytes, width, height, roi) {
  assert(roi.x >= 0 && roi.y >= 0 && roi.x + roi.width <= width && roi.y + roi.height <= height,
    `Pixel sample outside own window: ${JSON.stringify({ width, height, roi })}`);
  let green = 0, black = 0, yellow = 0, count = 0;
  const sum = [0, 0, 0];
  for (let y = roi.y; y < roi.y + roi.height; y++) {
    for (let x = roi.x; x < roi.x + roi.width; x++) {
      const offset = (y * width + x) * 3;
      const r = bytes[offset], g = bytes[offset + 1], b = bytes[offset + 2];
      sum[0] += r; sum[1] += g; sum[2] += b; count++;
      if (g > 100 && g > r * 1.5 && g > b * 1.5) green++;
      if (Math.max(r, g, b) < 20) black++;
      if (r > 150 && g > 150 && b < 80) yellow++;
    }
  }
  return { roi, mean: sum.map(value => value / count), green: green / count, black: black / count, yellow: yellow / count };
}

function greenOverlaySample(wrap, overlay) {
  // The fixture is 640x360, contained in the player. Its only changing pixels
  // are at source x=100..180,y=50..130. Both right and lower halves stay green.
  const scale = Math.min(wrap.width / 640, wrap.height / 360);
  const content = { x: wrap.x + (wrap.width - 640 * scale) / 2,
    y: wrap.y + (wrap.height - 360 * scale) / 2, width: 640 * scale, height: 360 * scale };
  for (const safe of [{ x: content.x + content.width * .5, y: content.y + 8 },
    { x: content.x + 8, y: content.y + content.height * .5 }]) {
    const left = Math.max(overlay.x + 8, safe.x), top = Math.max(overlay.y + 8, safe.y);
    const right = Math.min(overlay.x + overlay.width - 8, content.x + content.width - 8);
    const bottom = Math.min(overlay.y + overlay.height - 8, content.y + content.height - 8);
    if (right - left >= 8 && bottom - top >= 8) return {
      x: left, y: Math.min(Math.max(overlay.y + 60, top), bottom - 8), width: 8, height: 8, content };
  }
  throw new Error('Overlay must cover an interior green part of the actual video');
}

async function verifyNativeOverlay({ executable = process.env.SUBTOOL_ACCEPTANCE_EXE || ELECTRON,
  version = process.env.SUBTOOL_ACCEPTANCE_VERSION || require('../../package.json').version } = {}) {
  assert.equal(process.platform, 'win32', 'This acceptance requires Windows and an interactive desktop');
  executable = path.resolve(executable);
  const installed = !samePath(executable, ELECTRON);
  const ffmpeg = path.join(installed ? path.join(path.dirname(executable), 'resources', 'app.asar.unpacked', 'electron')
    : path.join(ROOT, 'electron'), 'ffmpeg', 'ffmpeg.exe');
  const temporary = fs.realpathSync(os.tmpdir());
  const work = fs.mkdtempSync(path.join(temporary, 'subtool-native-overlay-owned-'));
  const artifacts = fs.mkdtempSync(path.join(temporary, 'subtool-native-overlay-evidence-'));
  const profile = path.join(work, 'profile'), isolatedTemp = path.join(work, 'system-temp');
  const fixture = path.join(work, 'native-overlay-prores.mov');
  fs.mkdirSync(isolatedTemp);
  const report = { executable, version, artifacts, stages: [], failures: [] };
  let child, client, main, interrupted, stopping, nativeColor;
  const check = (condition, message, evidence) => {
    if (!condition) report.failures.push({ message, evidence });
  };
  const save = () => fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  const assertRunning = () => { if (interrupted) throw interrupted; };
  const stopOwned = () => stopping ||= stopElectron(child, { timeoutMs: 5000 });
  const handleSignal = signal => {
    if (interrupted) return;
    interrupted = new Error(`Acceptance interrupted by ${signal}`);
    report.signal = signal; report.ok = false;
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    // Closing CDP rejects in-flight evaluations immediately. Existing startup
    // and ready polls have <=15s deadlines; owned teardown has a 5s deadline.
    client?.close(); main?.close();
    void stopOwned().catch(error => { report.stopError = error.message; });
  };
  const onSigint = () => handleSignal('SIGINT'), onSigterm = () => handleSignal('SIGTERM');
  process.on('SIGINT', onSigint); process.on('SIGTERM', onSigterm);
  const evaluateMain = body => {
    assertRunning();
    return main.evaluate(`(async()=>{const E=require('electron'),captureFs=require('node:fs'),w=${mainWindow};if(!w)throw new Error('Owned main window missing');${body}})()`);
  };

  async function capture(label, overlaySelector) {
    const captureStarted = Date.now();
    assertRunning();
    await delay(200);
    const renderer = await client.evaluate(`(()=>{
      const box=selector=>{const e=document.querySelector(selector);if(!e)return null;
        const r=e.getBoundingClientRect(),s=getComputedStyle(e);
        return {x:r.x,y:r.y,width:r.width,height:r.height,display:s.display,visibility:s.visibility,opacity:s.opacity};};
      return {time:SUB.Media.displayTime(),sourceTime:SUB.Media.vTime(),playing:SUB.Media.playing,
        mpv:SUB.Media.mpvMode,wc:SUB.Media.webCodecsTakeover(),pending:SUB.Media.presentationPending(),
        ratio:devicePixelRatio,wrap:box('#videoWrap'),video:box('#video'),canvas:box('#wcCanvas'),
        overlay:${overlaySelector ? `box(${JSON.stringify(overlaySelector)})` : 'null'}};
    })()`);
    const file = path.join(artifacts, label + '.png');
    const desktop = await evaluateMain(`
      if(!w.isAlwaysOnTop())throw new Error('Owned acceptance window must remain on top for OS capture');
      const b=w.getContentBounds(),display=E.screen.getDisplayMatching(b),physical=E.screen.dipToScreenRect(w,b);
      const origin=E.screen.dipToScreenPoint({x:display.bounds.x,y:display.bounds.y});
      const sources=await E.desktopCapturer.getSources({types:['screen'],thumbnailSize:{
        width:Math.round(display.size.width*display.scaleFactor),height:Math.round(display.size.height*display.scaleFactor)}});
      const source=sources.find(s=>String(s.display_id)===String(display.id));
      if(!source)throw new Error('Own display source missing');
      const rect={x:physical.x-origin.x,y:physical.y-origin.y,width:physical.width,height:physical.height};
      const image=source.thumbnail.crop(rect);captureFs.writeFileSync(${JSON.stringify(file)},image.toPNG());
      return {bounds:b,physical,display:display.bounds,scale:display.scaleFactor,zoom:w.webContents.getZoomFactor(),focused:w.isFocused(),alwaysOnTop:w.isAlwaysOnTop(),
        thumbnail:source.thumbnail.getSize(),size:image.getSize(),windows:E.BrowserWindow.getAllWindows().map(v=>({
          id:v.id,url:v.webContents.getURL(),visible:v.isVisible(),bounds:v.getBounds()}))};`);
    const bytes = execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], {
      windowsHide: true, maxBuffer: desktop.size.width * desktop.size.height * 4, timeout: 10000,
    });
    const scale = desktop.zoom * desktop.size.width / desktop.bounds.width, wrap = renderer.wrap;
    const roi = (x, y, width, height) => ({ x: Math.round(x * scale), y: Math.round(y * scale),
      width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) });
    const pixels = samplePixels(bytes, desktop.size.width, desktop.size.height,
      roi(wrap.x + wrap.width * .2, wrap.y + wrap.height * .45, 25, 20));
    const motion = samplePixels(bytes, desktop.size.width, desktop.size.height,
      roi(wrap.x + wrap.width * .21, wrap.y + wrap.height * .21, 8, 8));
    const stage = { label, renderer, desktop, pixels, motion, file };
    if (renderer.overlay?.width) {
      const overlay = renderer.overlay;
      const sample = greenOverlaySample(wrap, overlay);
      const overlayRoi = roi(sample.x, sample.y, sample.width, sample.height);
      stage.overlayPixels = samplePixels(bytes, desktop.size.width, desktop.size.height,
        overlayRoi);
      stage.overlaySample = sample;
      // HTML capture is only a reference for the panel's expected color. The
      // assertion still reads OS pixels, which would be green if mpv covered it.
      const reference = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const htmlPixels = execFileSync(ffmpeg, ['-v', 'error', '-i', 'pipe:0', '-vf',
        `scale=${desktop.size.width}:${desktop.size.height}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], {
        input: Buffer.from(reference.data, 'base64'), windowsHide: true,
        maxBuffer: desktop.size.width * desktop.size.height * 4, timeout: 10000,
      });
      stage.expectedOverlayPixels = samplePixels(htmlPixels, desktop.size.width, desktop.size.height, overlayRoi);
      const expected = stage.expectedOverlayPixels.mean, actual = stage.overlayPixels.mean;
      check(stage.expectedOverlayPixels.green < .1 && Math.max(...expected) > 8
        && Math.max(...expected.map((value, index) => Math.abs(value - nativeColor[index]))) > 50,
      label + ': panel reference must be distinguishable from both black and the native green baseline', { expected, nativeColor });
      check(stage.overlayPixels.green < .1 && actual.every((value, index) => Math.abs(value - expected[index]) <= 8),
        label + ': OS pixels must show the actual panel color over the green video', { actual, expected, sample });
    }
    report.stages.push(stage);
    stage.captureMs = Date.now() - captureStarted;
    check(renderer.mpv && !renderer.wc, label + ': fixture must retain native presentation', renderer);
    check(pixels.green > .95, label + ': uncovered video became black or was obscured', pixels);
    console.log(JSON.stringify({ label, time: renderer.time, green: pixels.green, black: pixels.black,
      motion: motion.yellow, zoom: desktop.zoom, scale: desktop.scale }));
    save();
    return stage;
  }

  async function click(selector, button = 'left') {
    assertRunning();
    const point = await client.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button, clickCount: 1 });
  }

  async function drag(selector, left, top) {
    assertRunning();
    const from = await client.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+30,y:r.y+15};})()`);
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from });
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: left + 30, y: top + 15, button: 'left', buttons: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: left + 30, y: top + 15, button: 'left', clickCount: 1 });
    await delay(200);
  }

  async function mixer(overlap = true) {
    assertRunning();
    if (!await client.evaluate(`document.getElementById('mixerPanel').classList.contains('show')`)) {
      await click('[data-act="mixer"]');
      await delay(100); // Initial placement finishes before the user's drag.
    }
    const rect = await client.evaluate(`(()=>{const r=document.getElementById('videoWrap').getBoundingClientRect();return{right:r.right,top:r.top};})()`);
    await drag('#mixerPanel .fp-head', rect.right + (overlap ? -120 : 15), rect.top + 25);
  }

  async function moveTimelineDivider(bottomGap) {
    const geometry = await client.evaluate(`(()=>{const r=document.getElementById('splitH').getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2,toY:innerHeight-${bottomGap},bottomGap:innerHeight-r.y-r.height/2};})()`);
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geometry.x, y: geometry.y, button: 'left', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geometry.x, y: geometry.toY, button: 'left', buttons: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geometry.x, y: geometry.toY, button: 'left', clickCount: 1 });
    await delay(250);
    return geometry.bottomGap;
  }

  async function osClick(selector) {
    assertRunning();
    const point = await client.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    const physical = await evaluateMain(`const b=w.getContentBounds(),z=w.webContents.getZoomFactor();w.focus();
      return E.screen.dipToScreenPoint({x:Math.round(b.x+${point.x}*z),y:Math.round(b.y+${point.y}*z)});`);
    assert(Number.isSafeInteger(physical.x) && Number.isSafeInteger(physical.y));
    // Only this owned app's measured control is clicked. Restore the original
    // pointer after the input; no system audio or other app is observed.
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
      Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class OwnedOverlayInput{
        [StructLayout(LayoutKind.Sequential)]public struct Point{public int X;public int Y;}
        [DllImport("user32.dll")]public static extern bool GetCursorPos(out Point p);
        [DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);
        [DllImport("user32.dll")]public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);}';
      $before=[OwnedOverlayInput+Point]::new();[void][OwnedOverlayInput]::GetCursorPos([ref]$before);
      try{[void][OwnedOverlayInput]::SetCursorPos(${physical.x},${physical.y});
        [OwnedOverlayInput]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[OwnedOverlayInput]::mouse_event(4,0,0,0,[UIntPtr]::Zero)}
      finally{[void][OwnedOverlayInput]::SetCursorPos($before.X,$before.Y)}`], { windowsHide: true, timeout: 10000 });
    await delay(150);
    return { selector, point, physical };
  }

  try {
    execFileSync(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
      "color=c=0x20c060:s=640x360:r=25:d=90,drawbox=x=100:y=50:w=80:h=80:color=yellow:t=fill:enable='lt(mod(t,1),0.5)'",
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=90', '-c:v', 'prores_ks', '-profile:v', '0',
      '-pix_fmt', 'yuv422p10le', '-c:a', 'pcm_s16le', fixture], { windowsHide: true, timeout: 30000, stdio: 'pipe' });
    const port = await reservePort(), inspectPort = await reservePort();
    assertRunning();
    child = trackElectron(spawn(executable, [
      '.', '--subtool-transport-acceptance', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
      `--inspect=${inspectPort}`, '--no-sandbox', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    ], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, TEMP: isolatedTemp, TMP: isolatedTemp } }));
    child.stderr.on('data', chunk => { report.stderr = ((report.stderr || '') + chunk.toString()).slice(-16000); });
    main = await connectMainInspector(child.pid, { endpoint: `http://127.0.0.1:${inspectPort}/json/list`, enable: () => {} });
    const target = await waitFor(async () => (await getJSON(`http://127.0.0.1:${port}/json/list`)).find(isMainWindowTarget), 'native overlay main', 15000);
    client = new CdpClient(target.webSocketDebuggerUrl, { timeoutMs: 30000 });
    await client.connect(); await client.waitForApp();
    await waitFor(() => client.evaluate('Boolean(document.querySelector("#sublist .empty, #sublist .sub-row"))'), 'workspace initialized');
    report.identity = await evaluateMain(`const d=E.screen.getPrimaryDisplay();w.unmaximize();
      w.setContentBounds({x:d.workArea.x+30,y:d.workArea.y+40,width:Math.min(1400,d.workArea.width-60),height:Math.min(900,d.workArea.height-80)});
      w.setAlwaysOnTop(true,'floating');w.show();w.focus();const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
      return {pid:process.pid,execPath:process.execPath,packaged:E.app.isPackaged,version:E.app.getVersion(),
        appPath:E.app.getAppPath(),userData:E.app.getPath('userData'),sourceHashes:Object.fromEntries(
          ['dist/index.html','electron/mpv-host.js','electron/mpv-window-region.js','electron/main.js','electron/preload.js'].map(file=>[file,
          crypto.createHash('sha256').update(fs.readFileSync(path.join(E.app.getAppPath(),file))).digest('hex')]))};`);
    assert.equal(report.identity.pid, child.pid);
    assert(samePath(report.identity.execPath, executable));
    assert(samePath(report.identity.userData, profile));
    assert.equal(report.identity.packaged, installed);
    assert.equal(report.identity.version, version);
    assert.equal(await client.evaluate('document.getElementById("appVersion").textContent.trim()'), 'v' + version);
    // Retain the real file loader/mpv/IPC, holding only background proxy/audio
    // cache so ProRes cannot silently switch to an HTML/WebCodecs replacement.
    await client.evaluate(`(()=>{const m=SUB.Media;
      window.overlayCacheHold={wave:m._prepareSourceWaveform,ingest:m._bgAudioIngest};
      m._prepareSourceWaveform=async()=>null;m._bgAudioIngest=async()=>null;
      const input=document.createElement('input');input.type='file';input.id='nativeOverlayFixture';input.hidden=true;document.body.append(input);
    })()`);
    const { root } = await client.send('DOM.getDocument');
    const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#nativeOverlayFixture' });
    await client.send('DOM.setFileInputFiles', { nodeId, files: [fixture] });
    await client.evaluate(`(async()=>{const source=await subtool.authorizeDroppedFile(document.getElementById('nativeOverlayFixture').files[0]);
      await SUB.Media.loadDesktopMedia(source);await SUB.Media.seek(1);return true;})()`);
    await waitFor(() => client.evaluate('SUB.Media.mpvMode&&!SUB.Media.presentationPending()'), 'native first frame', 10000);
    await delay(500);
    const baseline = await capture('paused-baseline');
    assert(baseline.pixels.green > .95, 'Baseline must visibly contain the synthetic native frame');
    nativeColor = baseline.pixels.mean;
    await mixer(); await capture('paused-mixer-overlap', '#mixerPanel');
    const beforeMute = await client.evaluate('SUB.State.audioProject.buses[0].muted');
    report.osInput = await osClick('#mixerStrips .mx-mute');
    const afterMute = await client.evaluate('SUB.State.audioProject.buses[0].muted');
    check(afterMute !== beforeMute, 'OS click must reach mixer inside the native overlap', { beforeMute, afterMute, input: report.osInput });
    await click('#mixerPanel .fp-close'); await capture('paused-mixer-closed');
    await client.evaluate('SUB.Media.play();true');
    await waitFor(() => client.evaluate('SUB.Media.vTime()>1.5'), 'native playback advances');
    await mixer();
    const motion = [];
    for (let index = 0; index < 8; index++) {
      motion.push(await capture('playing-mixer-' + index, '#mixerPanel'));
      const seen = motion.map(stage => stage.motion.yellow);
      if (Math.max(...seen) - Math.min(...seen) > .8
        && motion.at(-1).renderer.sourceTime > motion[0].renderer.sourceTime + .5) break;
      // Capturing OS and HTML references takes nearly one second on this PC.
      // Vary the sampling phase so the 1s animation cannot alias as a still.
      await delay([110, 390, 70, 570, 230, 470, 310, 0][index]);
    }
    check(motion.at(-1).renderer.sourceTime > motion[0].renderer.sourceTime + .5, 'Playback clock stalls under mixer');
    const colors = motion.map(stage => stage.motion.yellow);
    check(Math.max(...colors) - Math.min(...colors) > .8, 'Actual native video pixels must animate under mixer', colors);
    await mixer(false); await capture('playing-mixer-away');
    await click('#mixerPanel .fp-close'); await capture('playing-mixer-closed');
    await client.evaluate('SUB.Media.pause();true');
    await click('[data-act="audio-project-settings"]'); await delay(200);
    await drag('#modalTitle', 650, 95); await capture('paused-modal-overlap', '#modalBg .modal');
    await osClick('#modalBg .mclose');
    check(!await client.evaluate('document.getElementById("modalBg").classList.contains("show")'), 'OS close must dismiss the modal');
    await capture('paused-modal-closed');
    const previousBounds = await evaluateMain('const b=w.getContentBounds();w.setContentBounds({...b,height:750});return b;');
    await delay(350);
    const previousTimelineGap = await moveTimelineDivider(165);
    // The speed indicator is the actual player-menu entry. The shorter parent
    // makes its normal viewport clamping overlap the lower part of the video.
    await click('#speedIndicator', 'right');
    await waitFor(() => client.evaluate('document.getElementById("ctxmenu").classList.contains("show")'), 'player context menu');
    await capture('paused-context-menu', '#ctxmenu');
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
    await evaluateMain(`w.setContentBounds(${JSON.stringify(previousBounds)});return true;`); await delay(350);
    await moveTimelineDivider(previousTimelineGap);
    await mixer();
    await evaluateMain('w.minimize();return true;'); await delay(250);
    // A renderer layout update while minimized must not expose either native
    // child again. Inspect OS-window visibility without capturing other apps.
    await client.evaluate('window.dispatchEvent(new Event("resize"));true'); await delay(250);
    report.minimized = await evaluateMain(`return {mainId:w.id,mainMinimized:w.isMinimized(),
      nativeWindows:E.BrowserWindow.getAllWindows().filter(v=>v.id!==w.id).map(v=>({
        id:v.id,url:v.webContents.getURL(),visible:v.isVisible()}))};`);
    check(report.minimized.mainMinimized && report.minimized.nativeWindows.length === 2
      && report.minimized.nativeWindows.every(window => !window.visible),
    'Minimizing the parent must keep both native host and guide hidden during layout updates', report.minimized);
    await evaluateMain('w.restore();w.focus();return true;'); await delay(400);
    await capture('paused-restored-mixer', '#mixerPanel');
    await evaluateMain('const b=w.getContentBounds();w.setContentBounds({...b,width:b.width-100,height:b.height-50});return true;');
    await delay(350); await mixer(); await capture('paused-resized-mixer', '#mixerPanel');
    await evaluateMain('w.webContents.setZoomFactor(1.25);return true;');
    await delay(450); await mixer(); await capture('paused-zoom125-mixer', '#mixerPanel');
    await click('#mixerPanel .fp-close'); await capture('paused-zoom125-closed');
    assertRunning();
    report.ok = report.failures.length === 0;
  } catch (error) {
    report.error = error.stack;
    report.ok = false;
  } finally {
    if (client && !interrupted) try {
      await client.send('Runtime.evaluate', { expression: `(()=>{const m=SUB.Media;if(window.overlayCacheHold){
        m._prepareSourceWaveform=overlayCacheHold.wave;m._bgAudioIngest=overlayCacheHold.ingest;}m.pause();return true;})()`, awaitPromise: true }, 2000);
    } catch (error) { report.restoreError = error.message; }
    client?.close(); main?.close();
    try {
      await stopOwned();
      verifiedCleanup(work, 'subtool-native-overlay-owned-', { maxRetries: 20, retryDelay: 100 });
      report.cleaned = !fs.existsSync(work);
    } catch (error) { report.cleanupError = error.message; report.cleaned = false; report.ok = false; }
    finally {
      save();
      process.off('SIGINT', onSigint); process.off('SIGTERM', onSigterm);
    }
  }
  console.log(JSON.stringify({ ok: report.ok, artifacts, failures: report.failures, error: report.error, cleaned: report.cleaned }, null, 2));
  if (!report.ok) throw new Error(`Native overlay acceptance failed: ${path.join(artifacts, 'report.json')}`);
  return report;
}

module.exports = { verifyNativeOverlay };
if (require.main === module) {
  verifyNativeOverlay({ executable: process.argv[2] || process.env.SUBTOOL_ACCEPTANCE_EXE || ELECTRON,
    version: process.argv[3] || process.env.SUBTOOL_ACCEPTANCE_VERSION || require('../../package.json').version })
    .catch(error => { console.error(error.message); if (!process.exitCode) process.exitCode = 1; });
}
