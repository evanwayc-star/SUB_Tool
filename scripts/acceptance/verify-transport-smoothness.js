/* ============================================================================
   播放／快轉／倒帶／逐格平滑度 —— Electron / CDP / 真 mpv 驗收
   ============================================================================
   用法：
     node scripts/acceptance/verify-transport-smoothness.js <media...>

   每支素材都以獨立 profile 開啟正式 Electron renderer，量測：
   - 1x 正播與 2x／4x 快轉的實際呈現 cadence
   - 1x／4x 倒帶的實際呈現 cadence
   - 左右方向鍵逐格的 input-to-presented latency

   原始素材只授予唯讀能力；驗收旗標會停用 sidecar cache，中央 cache、設定與 TEMP/TMP
   全部落在隔離 profile。驗收結束時先終止測試 Electron 行程樹，再刪除 profile。
   ============================================================================ */
'use strict';

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

const FFPROBE = path.join(ROOT, 'electron', 'ffmpeg', 'ffprobe.exe');
const SAMPLE_MS = 25;
const SAMPLE_DURATION_MS = 1800;
const STEP_COUNT = 6;
const RAPID_PATTERN_REPEATS = 6;
const RAPID_TOTAL_MAX_MS = 500;
const RAPID_REQUEST_MAX_MS = 500;
const RAPID_LATEST_PRESENTED_MAX_MS = 150;

function percentile(values, proportion) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * proportion))];
}

function summarizeCadence(samples, direction) {
  const finite = samples.filter(sample => Number.isFinite(sample.presented));
  const progress = [];
  const steps = [];
  const fps = finite[0]?.fps || 30;
  for (let index = 1; index < finite.length; index++) {
    const delta = finite[index].presented - finite[index - 1].presented;
    if ((direction > 0 && delta > 0.25 / fps) || (direction < 0 && delta < -0.25 / fps)) {
      progress.push(finite[index]);
      steps.push(Math.abs(delta));
    }
  }
  const gaps = progress.slice(1).map((sample, index) => sample.wall - progress[index].wall);
  if (finite.length > 1) {
    if (progress.length) {
      gaps.unshift(progress[0].wall - finite[0].wall);
      gaps.push(finite.at(-1).wall - progress.at(-1).wall);
    } else {
      gaps.push(finite.at(-1).wall - finite[0].wall);
    }
  }
  const first = finite[0]?.presented ?? 0;
  const last = finite.at(-1)?.presented ?? first;
  const signedSpan = last - first;
  const span = Math.abs(signedSpan);
  const elapsed = finite.length > 1 ? (finite.at(-1).wall - finite[0].wall) / 1000 : 0;
  const seekBarDrifts = finite
    .filter(sample => Number.isFinite(sample.domPlayhead))
    .map(sample => Math.abs(sample.domPlayhead - sample.presented));
  const timelineDrifts = finite
    .filter(sample => Number.isFinite(sample.timelinePlayhead))
    .map(sample => Math.abs(sample.timelinePlayhead - sample.presented));
  const signedAverageRate = elapsed > 0 ? signedSpan / elapsed : 0;
  return {
    samples: finite.length,
    progressFrames: progress.length,
    spanSeconds: Number(span.toFixed(3)),
    averageRate: Number((direction * signedAverageRate).toFixed(3)),
    signedAverageRate: Number(signedAverageRate.toFixed(3)),
    p95GapMs: Number(percentile(gaps, 0.95).toFixed(1)),
    maxGapMs: Number(Math.max(0, ...gaps).toFixed(1)),
    p95StepSeconds: Number(percentile(steps, 0.95).toFixed(3)),
    maxSeekBarDriftSeconds: Number(Math.max(0, ...seekBarDrifts).toFixed(3)),
    maxTimelineDriftSeconds: Number(Math.max(0, ...timelineDrifts).toFixed(3)),
  };
}

function summarizeLatency(samples) {
  const latencies = samples.map(sample => sample.latencyMs).filter(Number.isFinite);
  return {
    samples: latencies.length,
    medianMs: Number(percentile(latencies, 0.5).toFixed(1)),
    p95Ms: Number(percentile(latencies, 0.95).toFixed(1)),
    maxMs: Number(Math.max(0, ...latencies).toFixed(1)),
    trace: samples,
  };
}

function probeMedia(mediaPath) {
  const raw = execFileSync(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'format=duration,size,format_name:stream=codec_type,codec_name,width,height,avg_frame_rate,channels',
    '-of', 'json',
    mediaPath,
  ], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
  const parsed = JSON.parse(raw);
  const video = parsed.streams?.find(stream => stream.codec_type === 'video') || {};
  const audio = (parsed.streams || []).filter(stream => stream.codec_type === 'audio');
  const [numerator, denominator] = String(video.avg_frame_rate || '30/1').split('/').map(Number);
  return {
    duration: Number(parsed.format?.duration) || 0,
    size: Number(parsed.format?.size) || fs.statSync(mediaPath).size,
    format: parsed.format?.format_name || path.extname(mediaPath).slice(1),
    codec: video.codec_name || 'unknown',
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    fps: denominator ? numerator / denominator : 30,
    audioStreams: audio.length,
    audioChannels: audio.reduce((sum, stream) => sum + (Number(stream.channels) || 0), 0),
  };
}

function projectBytes(mediaPath, info, playhead) {
  const data = {
    app: 'SUB Tool',
    version: 3,
    media: { name: path.basename(mediaPath), size: info.size, path: mediaPath },
    duration: info.duration,
    fps: info.fps,
    tracks: [],
    cues: [],
    notes: [],
    clips: [{
      id: 'transport-acceptance-primary',
      name: path.basename(mediaPath),
      path: mediaPath,
      dur: info.duration,
      in: 0,
      out: info.duration,
      offset: 0,
      vtrack: 0,
      primary: true,
    }],
    playhead,
  };
  return Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(JSON.stringify(data), 'utf16le')]);
}

async function samplePresentation(client) {
  return client.evaluate(`(async () => {
    const samples = [];
    const deadline = performance.now() + ${SAMPLE_DURATION_MS};
    while (performance.now() < deadline) {
      const media = window.SUB.Media;
      const seekBarValue = document.getElementById('seekBar')?.value;
      const playheadLeft = Number.parseFloat(document.getElementById('tlPlayhead')?.style.left || '');
      const pixelsPerSecond = Number(window.SUB.State.pxPerSec);
      samples.push({
        wall: performance.now(),
        fps: Number(window.SUB.State.fps) || 30,
        display: media.displayTime(),
        domPlayhead: seekBarValue !== '' && Number.isFinite(Number(seekBarValue))
          ? Number(seekBarValue) / 1000
          : null,
        timelinePlayhead: Number.isFinite(playheadLeft) && pixelsPerSecond > 0
          ? Number(window.SUB.State.viewStart) + playheadLeft / pixelsPerSecond
          : null,
        presented: media.presentedTime(),
        playing: media.playing,
        presentationPending: media.presentationPending(),
      });
      await new Promise(resolve => setTimeout(resolve, ${SAMPLE_MS}));
    }
    return samples;
  })()`);
}

async function settleSeek(client, target) {
  const settled = await client.evaluate(`(async () => {
    const media = window.SUB.Media;
    const fps = Number(window.SUB.State.fps) || 30;
    const started = performance.now();
    const result = await media.seek(${JSON.stringify(target)}, {
      presentationTolerance: 0.45 / fps,
    });
    const playheadLeft = Number.parseFloat(document.getElementById('tlPlayhead')?.style.left || '');
    const pixelsPerSecond = Number(window.SUB.State.pxPerSec);
    return {
      latencyMs: performance.now() - started,
      result,
      fps,
      display: media.displayTime(),
      domPlayhead: Number(document.getElementById('seekBar')?.value) / 1000,
      timelinePlayhead: Number.isFinite(playheadLeft) && pixelsPerSecond > 0
        ? Number(window.SUB.State.viewStart) + playheadLeft / pixelsPerSecond
        : null,
      presented: media.presentedTime(),
    };
  })()`);
  const requested = Number(settled.result?.requestedTime);
  const tolerance = 0.45 / Math.max(1, settled.fps);
  const snapTolerance = 0.51 / Math.max(1, settled.fps);
  const missesTarget = !Number.isFinite(requested)
    || Math.abs(requested - target) > snapTolerance
    || [settled.result?.presentedTime, settled.display, settled.domPlayhead,
      settled.timelinePlayhead, settled.presented]
      .some(value => !Number.isFinite(value) || Math.abs(value - requested) > tolerance);
  if (settled.result?.status !== 'presented' || missesTarget) {
    throw new Error(`基準 seek 未實際呈現目標畫格：${JSON.stringify({ target, ...settled })}`);
  }
  return settled;
}

async function installStepProbe(client) {
  await client.evaluate(`(() => {
    const media = window.SUB.Media;
    if (window.__subtoolTransportStepProbe?.installed) {
      window.__subtoolTransportStepProbe.records = [];
      window.__subtoolTransportStepProbe.issued = [];
      window.__subtoolTransportStepProbe.nextInput = null;
      window.__subtoolTransportStepProbe.nextInputId = 1;
      return true;
    }
    const probe = {
      installed: true,
      records: [],
      issued: [],
      nextInput: null,
      nextInputId: 1,
      originalSeek: media.seek.bind(media),
    };
    window.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      probe.nextInput = {
        inputId: probe.nextInputId++,
        started: performance.now(),
        direction: event.key === 'ArrowRight' ? 1 : -1,
        beforeDisplay: media.displayTime(),
        beforePresented: media.presentedTime(),
      };
    }, true);
    media.seek = function instrumentedSeek(target, options) {
      const input = probe.nextInput;
      probe.nextInput = null;
      if (input) {
        probe.issued.push({
          inputId: input.inputId,
          started: input.started,
          direction: input.direction,
          beforeDisplay: input.beforeDisplay,
          beforePresented: input.beforePresented,
          target,
          options,
        });
      }
      const pending = probe.originalSeek(target, options);
      if (input) {
        Promise.resolve(pending).then(result => {
          probe.records.push({
            inputId: input.inputId,
            latencyMs: performance.now() - input.started,
            direction: input.direction,
            beforeDisplay: input.beforeDisplay,
            beforePresented: input.beforePresented,
            target,
            options,
            result,
            display: media.displayTime(),
            domPlayhead: Number(document.getElementById('seekBar')?.value) / 1000,
            timelinePlayhead: Number(window.SUB.State.viewStart)
              + Number.parseFloat(document.getElementById('tlPlayhead')?.style.left || '')
                / Number(window.SUB.State.pxPerSec),
            presented: media.presentedTime(),
            fps: Number(window.SUB.State.fps) || 30,
          });
        }, error => {
          probe.records.push({
            inputId: input.inputId,
            latencyMs: performance.now() - input.started,
            direction: input.direction,
            target,
            error: error?.message || String(error),
          });
        });
      }
      return pending;
    };
    window.__subtoolTransportStepProbe = probe;
    return true;
  })()`);
}

async function measureStep(client, direction) {
  const beforeCount = await client.evaluate('window.__subtoolTransportStepProbe.records.length');
  await dispatchKey(client, direction > 0 ? 'ArrowRight' : 'ArrowLeft', direction > 0 ? 'ArrowRight' : 'ArrowLeft');
  try {
    await waitFor(
      () => client.evaluate(`window.__subtoolTransportStepProbe.records.length > ${beforeCount}`),
      direction > 0 ? '逐格前進呈現' : '逐格後退呈現',
      1000
    );
  } catch (error) {
    return client.evaluate(`(() => ({
      latencyMs: 1000,
      timeout: true,
      direction: ${direction},
      display: window.SUB.Media.displayTime(),
      domPlayhead: Number(document.getElementById('seekBar')?.value) / 1000,
      timelinePlayhead: Number(window.SUB.State.viewStart)
        + Number.parseFloat(document.getElementById('tlPlayhead')?.style.left || '')
          / Number(window.SUB.State.pxPerSec),
      presented: window.SUB.Media.presentedTime(),
      pending: window.SUB.Media.presentationPending(),
      records: window.__subtoolTransportStepProbe.records.length
    }))()`);
  }
  return client.evaluate(`window.__subtoolTransportStepProbe.records[${beforeCount}]`);
}

async function measureRapidStepPattern(client, directions, label) {
  await installStepProbe(client);
  const before = await client.evaluate(`(() => ({
    display: window.SUB.Media.displayTime(),
    presented: window.SUB.Media.presentedTime(),
    fps: Number(window.SUB.State.fps) || 30
  }))()`);
  for (const direction of directions) {
    await dispatchKey(
      client,
      direction > 0 ? 'ArrowRight' : 'ArrowLeft',
      direction > 0 ? 'ArrowRight' : 'ArrowLeft'
    );
  }
  await waitFor(
    () => client.evaluate(`window.__subtoolTransportStepProbe.issued.length >= ${directions.length}`),
    `${label}按鍵全部登記`,
    1000
  );
  const requested = await client.evaluate(
    'window.__subtoolTransportStepProbe.issued.at(-1).target'
  );
  try {
    await waitFor(
      () => client.evaluate(`(() => {
        const media = window.SUB.Media;
        const fps = Number(window.SUB.State.fps) || 30;
        const tolerance = 0.45 / fps;
        const seekBar = Number(document.getElementById('seekBar')?.value) / 1000;
        const timeline = Number(window.SUB.State.viewStart)
          + Number.parseFloat(document.getElementById('tlPlayhead')?.style.left || '')
            / Number(window.SUB.State.pxPerSec);
        return media.presentationPending() === false
          && Math.abs(media.presentedTime() - ${JSON.stringify(requested)}) <= tolerance
          && Math.abs(media.displayTime() - ${JSON.stringify(requested)}) <= tolerance
          && Math.abs(seekBar - ${JSON.stringify(requested)}) <= tolerance
          && Math.abs(timeline - ${JSON.stringify(requested)}) <= tolerance;
      })()`),
      `${label}最後畫格呈現`,
      1500
    );
  } catch (error) {
    const diagnostic = await client.evaluate(`(() => ({
      requested: ${JSON.stringify(requested)},
      display: window.SUB.Media.displayTime(),
      presented: window.SUB.Media.presentedTime(),
      pending: window.SUB.Media.presentationPending(),
      domPlayhead: Number(document.getElementById('seekBar')?.value) / 1000,
      timelinePlayhead: Number(window.SUB.State.viewStart)
        + Number.parseFloat(document.getElementById('tlPlayhead')?.style.left || '')
          / Number(window.SUB.State.pxPerSec),
      records: window.__subtoolTransportStepProbe.records,
      issued: window.__subtoolTransportStepProbe.issued
    }))()`);
    error.message += `；狀態=${JSON.stringify(diagnostic)}`;
    throw error;
  }
  await waitFor(
    () => client.evaluate(`window.__subtoolTransportStepProbe.records.length >= ${directions.length}`),
    `${label}請求全部結束`,
    1500
  );
  const final = await client.evaluate(`(() => ({
    completedAt: performance.now(),
    display: window.SUB.Media.displayTime(),
    presented: window.SUB.Media.presentedTime(),
    domPlayhead: Number(document.getElementById('seekBar')?.value) / 1000,
    timelinePlayhead: Number(window.SUB.State.viewStart)
      + Number.parseFloat(document.getElementById('tlPlayhead')?.style.left || '')
        / Number(window.SUB.State.pxPerSec),
    records: window.__subtoolTransportStepProbe.records,
    issued: window.__subtoolTransportStepProbe.issued
  }))()`);
  const firstStarted = Number(final.issued[0]?.started);
  const latestInputId = final.issued.at(-1)?.inputId;
  const latestRecord = final.records.find(record => record.inputId === latestInputId);
  return {
    label,
    directions,
    netFrames: directions.reduce((sum, direction) => sum + direction, 0),
    before,
    requested,
    totalLatencyMs: Number.isFinite(firstStarted)
      ? Number((final.completedAt - firstStarted).toFixed(1))
      : null,
    latestLatencyMs: Number.isFinite(latestRecord?.latencyMs)
      ? Number(latestRecord.latencyMs.toFixed(1))
      : null,
    ...final,
  };
}

function killOrphanDescendants(rootPid) {
  const pid = Number(rootPid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  const script = [
    `$rootId = ${pid}`,
    '$all = @(Get-CimInstance Win32_Process)',
    '$known = [System.Collections.Generic.HashSet[int]]::new()',
    '[void]$known.Add($rootId)',
    'do {',
    '  $added = $false',
    '  foreach ($process in $all) {',
    '    if ($known.Contains([int]$process.ParentProcessId) -and $known.Add([int]$process.ProcessId)) { $added = $true }',
    '  }',
    '} while ($added)',
    '$targets = @($all | Where-Object { $_.ProcessId -ne $rootId -and $known.Contains([int]$_.ProcessId) })',
    'foreach ($process in ($targets | Sort-Object CreationDate -Descending)) {',
    '  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue',
    '}',
  ].join('\n');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch {}
}

function killTree(child) {
  if (!child?.pid) return;
  if (child.exitCode === null) {
    try {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      killOrphanDescendants(child.pid);
      try { child.kill('SIGKILL'); } catch {}
    }
    return;
  }
  // Electron 本體若先崩潰，taskkill root 已無法沿樹清理；改由原 PID 反查仍存活的後代。
  killOrphanDescendants(child.pid);
}

async function measureCadenceMode(client, target, {
  label,
  key,
  code,
  presses,
  expectedSpeed,
  direction,
}) {
  const seek = await settleSeek(client, target);
  for (let index = 0; index < presses; index++) {
    await dispatchKey(client, key, code);
    if (index + 1 < presses) await delay(15);
  }

  let startingPresented = null;
  await waitFor(async () => {
    const state = await client.evaluate(`(() => ({
      presented: window.SUB.Media.presentedTime(),
      fps: Number(window.SUB.State.fps) || 30,
      speed: Number((document.getElementById('speedIndicator')?.textContent || '').replace('x', ''))
    }))()`);
    if (!Number.isFinite(state.presented) || Math.abs(state.speed - expectedSpeed) >= 0.01) return false;
    if (!Number.isFinite(startingPresented)) {
      startingPresented = state.presented;
      return false;
    }
    return direction * (state.presented - startingPresented) > 0.25 / state.fps;
  }, `${label}實際呈現啟動`, 15000);

  const samples = await samplePresentation(client);
  await dispatchKey(client, 'k', 'KeyK');
  await waitFor(
    () => client.evaluate(`window.SUB.Media.playing === false
      && window.SUB.Media.presentationPending() === false
      && window.SUB.Media.playbackTransitionPending() === false
      && Math.abs(Number((document.getElementById('speedIndicator')?.textContent || '').replace('x', '')) - 1) < 0.01`),
    `${label}停止`,
    15000
  );
  await waitFor(async () => {
    const stopped = await client.evaluate(`({
      presented: window.SUB.Media.presentedTime(),
      fps: Number(window.SUB.State.fps) || 30
    })`);
    await delay(120);
    const stoppedAgain = await client.evaluate('window.SUB.Media.presentedTime()');
    return Number.isFinite(stopped.presented) && Number.isFinite(stoppedAgain)
      && Math.abs(stoppedAgain - stopped.presented) <= 0.25 / stopped.fps;
  }, `${label}按 K 後完全停止`, 3000);
  return { seek, samples };
}

async function runMedia(mediaPath) {
  const info = probeMedia(mediaPath);
  const endMargin = Math.min(30, Math.max(5, info.duration / 10));
  const playhead = Math.max(2, Math.min(info.duration / 2, info.duration - endMargin));
  let profileDir = null;
  let child = null;
  let client = null;
  const errors = [];
  try {
    profileDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-transport-cdp-'));
    const isolatedTempDir = path.join(profileDir, 'temp');
    fs.mkdirSync(isolatedTempDir);
    const projectPath = path.join(profileDir, 'transport-acceptance.subtool');
    fs.writeFileSync(projectPath, projectBytes(mediaPath, info, playhead));
    const port = await reservePort();
    child = spawn(ELECTRON, [
      '.',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--subtool-transport-acceptance',
      '--no-sandbox',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      projectPath,
    ], {
      cwd: ROOT,
      env: {
        ...process.env,
        TEMP: isolatedTempDir,
        TMP: isolatedTempDir,
        TMPDIR: isolatedTempDir,
      },
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', chunk => errors.push(chunk.toString()));
    const spawnError = new Promise((resolve, reject) => {
      child.once('error', reject);
    });
    const target = await Promise.race([
      waitFor(async () => {
        const targets = await getJSON(`http://127.0.0.1:${port}/json/list`);
        return targets.find(item => item.type === 'page' && item.title === 'SUB TOOL');
      }, `${path.basename(mediaPath)} 主視窗啟動`, 30000),
      spawnError,
    ]);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Runtime.enable');
    await client.send('Page.bringToFront');
    await waitFor(
      () => client.evaluate(`Boolean(window.SUB?.Media?.mpvMode
        && window.SUB.State.clips.length === 1
        && window.SUB.Media.activeClip?.())`),
      `${path.basename(mediaPath)} 真 mpv 素材載入`,
      30000
    );
    await client.evaluate(`(() => {
      document.activeElement?.blur?.();
      document.body.tabIndex = -1;
      document.body.focus();
      return true;
    })()`);

    const reverseProxyReady = await client.evaluate('window.SUB.Media.reverseShuttleProxyReady() === true');
    const forward1x = await measureCadenceMode(client, playhead, {
      label: '1x 正播', key: 'l', code: 'KeyL', presses: 1, expectedSpeed: 1, direction: 1,
    });
    const fastForward2x = await measureCadenceMode(client, playhead, {
      label: '2x 快轉', key: 'l', code: 'KeyL', presses: 3, expectedSpeed: 2, direction: 1,
    });
    const fastForward4x = await measureCadenceMode(client, playhead, {
      label: '4x 快轉', key: 'l', code: 'KeyL', presses: 7, expectedSpeed: 4, direction: 1,
    });
    const reverse1x = await measureCadenceMode(client, playhead, {
      label: '1x 倒帶', key: 'j', code: 'KeyJ', presses: 1, expectedSpeed: -1, direction: -1,
    });
    const reverse4x = await measureCadenceMode(client, playhead, {
      label: '4x 倒帶', key: 'j', code: 'KeyJ', presses: 7, expectedSpeed: -4, direction: -1,
    });

    await settleSeek(client, playhead);
    await installStepProbe(client);
    const stepForwardSamples = [];
    const stepBackwardSamples = [];
    for (let index = 0; index < STEP_COUNT; index++) stepForwardSamples.push(await measureStep(client, 1));
    for (let index = 0; index < STEP_COUNT; index++) stepBackwardSamples.push(await measureStep(client, -1));
    const rapidStepPatterns = [];
    for (let round = 1; round <= RAPID_PATTERN_REPEATS; round++) {
      await settleSeek(client, playhead);
      rapidStepPatterns.push(await measureRapidStepPattern(
        client, [1, 1, -1], `快速右右左 #${round}`
      ));
      await settleSeek(client, playhead);
      rapidStepPatterns.push(await measureRapidStepPattern(
        client, [-1, -1, 1], `快速左左右 #${round}`
      ));
    }

    const result = {
      file: mediaPath,
      info: {
        ...info,
        sizeGiB: Number((info.size / (1024 ** 3)).toFixed(2)),
      },
      playhead: Number(playhead.toFixed(3)),
      initialSeek: forward1x.seek,
      reverseProxyReady,
      forward1x: summarizeCadence(forward1x.samples, 1),
      fastForward2x: summarizeCadence(fastForward2x.samples, 1),
      fastForward4x: summarizeCadence(fastForward4x.samples, 1),
      reverse1x: summarizeCadence(reverse1x.samples, -1),
      reverse4x: summarizeCadence(reverse4x.samples, -1),
      stepForward: summarizeLatency(stepForwardSamples),
      stepBackward: summarizeLatency(stepBackwardSamples),
      rapidStepPatterns,
    };
    return result;
  } catch (error) {
    if (errors.length) error.message += `\nElectron stderr:\n${errors.join('').slice(-6000)}`;
    throw error;
  } finally {
    client?.close();
    if (child) {
      killTree(child);
      if (child.exitCode === null) {
        await Promise.race([new Promise(resolve => child.once('close', resolve)), delay(5000)]);
      }
    }
    if (profileDir) verifiedCleanup(profileDir, 'subtool-transport-cdp-');
  }
}

function assertSmooth(result) {
  const frameSeconds = 1 / Math.max(1, result.info.fps);
  const problems = [];
  const cadenceChecks = [
    ['1x 正播', result.forward1x, 1, 0.7, 1.35, 0.18],
    ['2x 快轉', result.fastForward2x, 1, 1.35, 2.7, 0.3],
    ['4x 快轉', result.fastForward4x, 1, 2.8, 5.4, 0.45],
    ['1x 倒帶', result.reverse1x, -1, 0.65, 1.35, 0.18],
    ['4x 倒帶', result.reverse4x, -1, 2.8, 5.4, 0.45],
  ];
  for (const [label, value, direction, minimumRate, maximumRate, maximumStep] of cadenceChecks) {
    if (value.progressFrames < 8) problems.push(`${label} 有效更新不足：${value.progressFrames}`);
    if (Math.sign(value.signedAverageRate) !== direction) {
      problems.push(`${label} 呈現方向錯誤：${value.signedAverageRate}x`);
    }
    if (value.averageRate < minimumRate) problems.push(`${label} 平均速率過低：${value.averageRate}x`);
    if (value.averageRate > maximumRate) problems.push(`${label} 平均速率異常過高：${value.averageRate}x`);
    if (value.p95GapMs > 180) problems.push(`${label} P95 畫格間隔過高：${value.p95GapMs}ms`);
    if (value.maxGapMs >= 350) problems.push(`${label} 最長停頓過高：${value.maxGapMs}ms`);
    if (value.p95StepSeconds > maximumStep) {
      problems.push(`${label} P95 跳格幅度過高：${value.p95StepSeconds}s`);
    }
    const uiDriftLimit = Math.max(2, Math.abs(value.averageRate)) * frameSeconds;
    if (value.maxSeekBarDriftSeconds > uiDriftLimit) {
      problems.push(`${label} seekBar/畫面漂移：${value.maxSeekBarDriftSeconds}s`);
    }
    if (value.maxTimelineDriftSeconds > uiDriftLimit) {
      problems.push(`${label} 時間軸播放點/畫面漂移：${value.maxTimelineDriftSeconds}s`);
    }
  }
  for (const [label, value] of [['逐格前進', result.stepForward], ['逐格後退', result.stepBackward]]) {
    if (value.samples !== STEP_COUNT) problems.push(`${label} 樣本不足：${value.samples}`);
    if (value.p95Ms > 150) problems.push(`${label} P95 延遲過高：${value.p95Ms}ms`);
    if (value.maxMs >= 500) problems.push(`${label} 最長延遲過高：${value.maxMs}ms`);
    if (value.trace.some(sample => sample.timeout)) problems.push(`${label} 有逾時`);
    if (value.trace.some(sample => !Number.isFinite(sample.target)
      || !Number.isFinite(sample.result?.presentedTime)
      || Math.abs(sample.result.presentedTime - sample.target) > 0.45 * frameSeconds
      || Math.abs(sample.display - sample.target) > 0.45 * frameSeconds
      || Math.abs(sample.domPlayhead - sample.target) > 0.45 * frameSeconds
      || Math.abs(sample.timelinePlayhead - sample.target) > 0.45 * frameSeconds
      || Math.abs(sample.presented - sample.target) > 0.45 * frameSeconds)) {
      problems.push(`${label} 有按鍵被舊畫格誤判完成`);
    }
  }
  for (const pattern of result.rapidStepPatterns || []) {
    if (pattern.issued.length !== pattern.directions.length) {
      problems.push(`${pattern.label} 登記按鍵數錯誤：${pattern.issued.length}`);
    }
    let cumulativeFrames = 0;
    for (let index = 0; index < pattern.directions.length; index++) {
      const direction = pattern.directions[index];
      cumulativeFrames += direction;
      const issued = pattern.issued[index];
      const expectedTarget = pattern.before.display + cumulativeFrames * frameSeconds;
      if (!issued || issued.direction !== direction
        || !Number.isFinite(issued.target)
        || Math.abs(issued.target - expectedTarget) > 0.1 * frameSeconds) {
        problems.push(`${pattern.label} 第 ${index + 1} 鍵累積目標錯誤`);
      }
    }
    const expectedDelta = pattern.netFrames * frameSeconds;
    if (Math.abs((pattern.requested - pattern.before.display) - expectedDelta) > 0.1 * frameSeconds) {
      problems.push(`${pattern.label} 最新按鍵目標錯誤`);
    }
    if (Math.abs(pattern.requested - pattern.before.display) <= 0.5 * frameSeconds) {
      problems.push(`${pattern.label} 按鍵後時間點沒有跨格`);
    }
    if (Math.abs(pattern.display - pattern.requested) > 0.45 * frameSeconds
      || Math.abs(pattern.presented - pattern.requested) > 0.45 * frameSeconds
      || Math.abs(pattern.domPlayhead - pattern.requested) > 0.45 * frameSeconds
      || Math.abs(pattern.timelinePlayhead - pattern.requested) > 0.45 * frameSeconds) {
      problems.push(`${pattern.label} 最後畫格未停在最新按鍵目標`);
    }
    if (pattern.records.length !== pattern.directions.length
      || pattern.records.some(record => record.timeout || record.error)) {
      problems.push(`${pattern.label} 有逐格請求未完成`);
    }
    if (!Number.isFinite(pattern.totalLatencyMs) || pattern.totalLatencyMs >= RAPID_TOTAL_MAX_MS) {
      problems.push(`${pattern.label} 總延遲過高：${pattern.totalLatencyMs}ms`);
    }
    if (pattern.records.some(record => !Number.isFinite(record.latencyMs)
      || record.latencyMs >= RAPID_REQUEST_MAX_MS)) {
      problems.push(`${pattern.label} 有單鍵延遲達 ${RAPID_REQUEST_MAX_MS}ms`);
    }
    const latestInputId = pattern.issued.at(-1)?.inputId;
    const latestRecords = pattern.records.filter(record => record.inputId === latestInputId);
    const latestRecord = latestRecords[0];
    const latestPresentedValues = latestRecord
      ? [latestRecord.result?.presentedTime, latestRecord.display, latestRecord.domPlayhead,
        latestRecord.timelinePlayhead, latestRecord.presented]
      : [];
    if (latestRecords.length !== 1
      || latestRecord.result?.status !== 'presented'
      || !Number.isFinite(latestRecord.latencyMs)
      || latestRecord.latencyMs > RAPID_LATEST_PRESENTED_MAX_MS
      || !Number.isFinite(latestRecord.target)
      || Math.abs(latestRecord.target - pattern.requested) > 0.1 * frameSeconds
      || latestPresentedValues.some(value => !Number.isFinite(value)
        || Math.abs(value - pattern.requested) > 0.45 * frameSeconds)) {
      problems.push(`${pattern.label} 最新目標沒有實際呈現證據`);
    }
  }
  return problems;
}

function compactResult(result) {
  const { trace: unusedForwardTrace, ...stepForward } = result.stepForward;
  const { trace: unusedBackwardTrace, ...stepBackward } = result.stepBackward;
  void unusedForwardTrace;
  void unusedBackwardTrace;
  return {
    ...result,
    stepForward,
    stepBackward,
    rapidStepPatterns: result.rapidStepPatterns.map(pattern => ({
      label: pattern.label,
      netFrames: pattern.netFrames,
      requested: pattern.requested,
      display: pattern.display,
      presented: pattern.presented,
      totalLatencyMs: pattern.totalLatencyMs,
      maxRequestLatencyMs: Number(Math.max(0, ...pattern.records.map(record => record.latencyMs || 0)).toFixed(1)),
      latestLatencyMs: pattern.latestLatencyMs,
      requestStatuses: pattern.records.map(record => record.result?.status || 'error'),
    })),
  };
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('找不到 dist/index.html，請先執行 npm run build');
  }
  const mediaPaths = process.argv.slice(2).map(value => path.resolve(value));
  if (!mediaPaths.length) throw new Error('請提供至少一支 MOV／MXF／MP4 素材路徑');
  for (const mediaPath of mediaPaths) {
    if (!fs.existsSync(mediaPath) || !fs.statSync(mediaPath).isFile()) {
      throw new Error(`找不到素材：${mediaPath}`);
    }
  }

  const results = [];
  const failures = [];
  for (const mediaPath of mediaPaths) {
    const result = await runMedia(mediaPath);
    results.push(result);
    const problems = assertSmooth(result);
    if (problems.length) failures.push({ file: mediaPath, problems });
    console.log(JSON.stringify(compactResult(result), null, 2));
  }
  if (failures.length) {
    throw new Error(`播放平滑度真機驗收失敗：${JSON.stringify(failures, null, 2)}`);
  }
  console.log(JSON.stringify({ ok: true, files: results.map(result => result.file) }, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = { assertSmooth, killTree };
