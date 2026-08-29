/* ============================================================================
   JKL 倒帶平滑度 —— Electron / CDP / 真 mpv 驗收
   ============================================================================
   先執行 npm run build，再執行：
     node scripts/acceptance/verify-reverse-shuttle.js

   產生一支帶聲音的長 GOP H.264 測試片，以獨立 user-data-dir 開啟真正的
   Electron + mpv，先做長距離 seek 後立刻按播放，再分別量測 1x 正播與 1x
   倒播的實際 video PTS。驗收看的是呈現畫格 cadence、跳格幅度與 UI 漂移，
   不以「IPC 有送出」代替畫面。
   ============================================================================ */
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
  dispatchKey,
  verifiedCleanup,
} = require('./cdp-electron-harness.js');

const FPS = 25;
const SAMPLE_MS = 40;
const SAMPLE_DURATION_MS = 2200;

function percentile(values, proportion) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * proportion))];
}

function cadence(samples, direction) {
  const finite = samples.filter(sample => Number.isFinite(sample.presented));
  const progress = [];
  const steps = [];
  for (let index = 1; index < finite.length; index++) {
    const delta = finite[index].presented - finite[index - 1].presented;
    if ((direction > 0 && delta > 0.25 / FPS) || (direction < 0 && delta < -0.25 / FPS)) {
      progress.push(finite[index]);
      steps.push(Math.abs(delta));
    }
  }
  const gaps = progress.slice(1).map((sample, index) => sample.wall - progress[index].wall);
  const first = finite[0]?.presented ?? 0;
  const last = finite.at(-1)?.presented ?? first;
  const span = Math.abs(last - first);
  const elapsed = finite.length > 1 ? (finite.at(-1).wall - finite[0].wall) / 1000 : 0;
  const drifts = finite
    .filter(sample => Number.isFinite(sample.display))
    .map(sample => Math.abs(sample.display - sample.presented));
  return {
    samples: finite.length,
    progressFrames: progress.length,
    spanSeconds: Number(span.toFixed(3)),
    averageRate: Number((elapsed > 0 ? span / elapsed : 0).toFixed(3)),
    p95GapMs: Number(percentile(gaps, 0.95).toFixed(1)),
    maxGapMs: Number(Math.max(0, ...gaps).toFixed(1)),
    p95StepSeconds: Number(percentile(steps, 0.95).toFixed(3)),
    maxDisplayDriftSeconds: Number(Math.max(0, ...drifts).toFixed(3)),
  };
}

function projectBytes(mediaPath, size) {
  const data = {
    app: 'SUB Tool',
    version: 3,
    media: { name: path.basename(mediaPath), size, path: mediaPath },
    duration: 20,
    fps: FPS,
    tracks: [],
    cues: [],
    notes: [],
    clips: [{
      id: 'reverse-acceptance-primary',
      name: path.basename(mediaPath),
      path: mediaPath,
      dur: 20,
      in: 0,
      out: 20,
      offset: 0,
      vtrack: 0,
      primary: true,
    }],
    playhead: 8,
  };
  return Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(JSON.stringify(data), 'utf16le')]);
}

async function samplePresentation(client) {
  return client.evaluate(`(async () => {
    const samples = [];
    const deadline = performance.now() + ${SAMPLE_DURATION_MS};
    while (performance.now() < deadline) {
      const media = window.SUB.Media;
      samples.push({
        wall: performance.now(),
        display: media.displayTime(),
        presented: media.presentedTime(),
        nativeReverse: media._nativeReverse === true,
        reverseProxy: media._reverseProxyActive === true,
        reverseMuted: media._reverseShuttleMuted === true,
      });
      await new Promise(resolve => setTimeout(resolve, ${SAMPLE_MS}));
    }
    return samples;
  })()`);
}

(async () => {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('找不到 dist/index.html，請先執行 npm run build');
  }
  const profileDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-reverse-cdp-'));
  const fixturePath = path.join(profileDir, 'long-gop-with-audio.mp4');
  const projectPath = path.join(profileDir, 'reverse-acceptance.subtool');
  const ffmpeg = path.join(ROOT, 'electron', 'ffmpeg', 'ffmpeg.exe');
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=${FPS}`,
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
    '-t', '20', '-c:v', 'libx264', '-preset', 'veryfast',
    '-g', '250', '-keyint_min', '250', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
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
    await client.send('Page.bringToFront');
    await waitFor(
      () => client.evaluate(`Boolean(window.SUB?.Media?.mpvMode
        && window.SUB.State.clips.length === 1
        && window.SUB.Media.activeClipId)`),
      'mpv 長 GOP 素材載入',
      30000
    );
    await waitFor(
      () => client.evaluate('window.SUB.Media.reverseShuttleProxyReady() === true'),
      '0.5 秒 keyframe 倒帶 Proxy 就緒',
      30000
    );
    await client.evaluate(`(() => {
      document.activeElement?.blur?.();
      document.body.tabIndex = -1;
      document.body.focus();
      window.SUB.Media.seek(15);
      return true;
    })()`);

    await dispatchKey(client, 'l', 'KeyL');
    const immediatePlayState = await client.evaluate(`(() => ({
      playing: window.SUB.Media.playing,
      presentationPending: window.SUB.Media.presentationPending(),
      playbackTransitionPending: window.SUB.Media.playbackTransitionPending(),
      presenterClockMoving: window.SUB.Media.presenterClockMoving(),
      displayTime: window.SUB.Media.displayTime()
    }))()`);
    try {
      await waitFor(
        () => client.evaluate(`window.SUB.Media.playing === true
          && window.SUB.Media.playbackTransitionPending() === false
          && window.SUB.Media.presenterClockMoving() === true`),
        '長距離 seek 的實際畫格與 1x 播放時鐘啟動',
        10000
      );
    } catch (error) {
      const readiness = await client.evaluate(`(() => ({
        playing: window.SUB.Media.playing,
        presentationPending: window.SUB.Media.presentationPending(),
        playbackTransitionPending: window.SUB.Media.playbackTransitionPending(),
        playbackIntent: window.SUB.Media._presentationSession?.playbackIntent?.(),
        presenterClockMoving: window.SUB.Media.presenterClockMoving(),
        displayTime: window.SUB.Media.displayTime(),
        presentedTime: window.SUB.Media.presentedTime(),
        mpvTime: window.SUB.Media._mpvTime,
        activeClipId: window.SUB.Media.activeClipId,
        inGap: window.SUB.Media.inGap(),
        sequenceSwitching: window.SUB.Media._seqSwitching,
        status: document.getElementById('status')?.textContent || ''
      }))()`);
      error.message += `；readiness=${JSON.stringify(readiness)}`;
      throw error;
    }
    const forwardSamples = await samplePresentation(client);
    await dispatchKey(client, 'k', 'KeyK');
    await waitFor(() => client.evaluate('window.SUB.Media.playing === false'), '正播停止');

    await client.evaluate('window.SUB.Media.seek(16); true');
    await delay(600);
    await dispatchKey(client, 'j', 'KeyJ');
    await waitFor(
      () => client.evaluate('window.SUB.Media._nativeReverse === true'),
      'mpv 軟解原生倒播啟動',
      10000
    );
    const reverseSamples = await samplePresentation(client);
    await dispatchKey(client, 'k', 'KeyK');
    await waitFor(
      () => client.evaluate(`window.SUB.Media.playing === false
        && window.SUB.Media._nativeReverse === false
        && window.SUB.Media._reverseProxyActive === false
        && window.SUB.Media._reverseShuttleMuted === false`),
      '倒播停止並還原 forward／mute',
      10000
    );

    const forward = cadence(forwardSamples, 1);
    const reverse = cadence(reverseSamples, -1);
    const reverseStayedMuted = reverseSamples.every(sample => sample.reverseMuted === true);
    const nativeRatio = reverseSamples.filter(sample => sample.nativeReverse).length / reverseSamples.length;
    const proxyRatio = reverseSamples.filter(sample => sample.reverseProxy).length / reverseSamples.length;
    const allowedGap = Math.max(160, forward.p95GapMs * 2.5);
    const allowedStep = Math.max(4 / FPS, forward.p95StepSeconds * 2.5);
    const result = {
      fixture: {
        codec: 'H.264', fps: FPS, gopFrames: 250, seconds: 20, audio: 'AAC',
        reverseProxyKeyframeSeconds: 0.5,
      },
      immediatePlayState,
      forward,
      reverse,
      reverseStayedMuted,
      nativeRatio: Number(nativeRatio.toFixed(3)),
      proxyRatio: Number(proxyRatio.toFixed(3)),
      reverseTrace: reverseSamples.filter((sample, index) => index % 5 === 0).map(sample => ({
        wall: Number((sample.wall - reverseSamples[0].wall).toFixed(0)),
        presented: Number.isFinite(sample.presented) ? Number(sample.presented.toFixed(3)) : null,
        display: Number.isFinite(sample.display) ? Number(sample.display.toFixed(3)) : null,
        native: sample.nativeReverse,
        proxy: sample.reverseProxy,
      })),
      limits: {
        reverseP95GapMs: Number(allowedGap.toFixed(1)),
        reverseP95StepSeconds: Number(allowedStep.toFixed(3)),
        maxDisplayDriftSeconds: Number((2 / FPS).toFixed(3)),
      },
    };

    if (forward.spanSeconds < 1 || reverse.spanSeconds < 1
      || reverse.progressFrames < 12
      || reverse.p95GapMs > allowedGap
      || reverse.maxGapMs >= 400
      || reverse.p95StepSeconds > allowedStep
      || reverse.maxDisplayDriftSeconds > 2 / FPS
      || !reverseStayedMuted
      || nativeRatio < 0.9
      || proxyRatio < 0.9) {
      throw new Error(`倒帶平滑度真機驗收失敗：${JSON.stringify(result, null, 2)}`);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (errors.length) error.message += `\nElectron stderr:\n${errors.join('').slice(-6000)}`;
    throw error;
  } finally {
    client?.close();
    if (child.exitCode === null) child.kill('SIGKILL');
    await Promise.race([new Promise(resolve => child.once('close', resolve)), delay(5000)]);
    verifiedCleanup(profileDir, 'subtool-reverse-cdp-');
  }
})().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
