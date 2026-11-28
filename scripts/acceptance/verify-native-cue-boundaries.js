/* Windows 原生 mpv 首尾格驗收。先 npm run build，再執行
   node scripts/acceptance/verify-native-cue-boundaries.js
   SUBTOOL_ACCEPTANCE_EXE 可指定已安裝的版本。使用獨立 profile 與合成素材，
   對同一張暫停畫格各取「原始影片」及「含 ASS 字幕」PNG，在來源像素空間比對。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { PNG } = require('pngjs');
const {
  ROOT, ELECTRON, reservePort, getJSON, waitFor, delay, CdpClient, dispatchKey,
  isMainWindowTarget, trackElectron, stopElectron, verifiedCleanup,
} = require('./cdp-electron-harness');

const projectRates = [
  { fps: 23.976, rate: 24000 / 1001 }, { fps: 24, rate: 24 }, { fps: 25, rate: 25 },
  { fps: 29.97, rate: 30000 / 1001, df: true }, { fps: 29.97, rate: 30000 / 1001 },
  { fps: 30, rate: 30 },
];
const sources = [
  { fps: '60000/1001', rate: 60000 / 1001, projects: projectRates },
  { fps: '30000/1001', rate: 30000 / 1001, projects: projectRates.filter(p => p.fps === 29.97) },
  { fps: '30', rate: 30, projects: projectRates.filter(p => p.fps === 30) },
];
const cueText = 'FRAME TEST';
const steps = [
  { name: 'block-select', action: 'block', offset: -1 },
  { name: 'ruler-in', action: 'ruler', offset: 0 },
  { name: 'previous', action: 'ArrowLeft', offset: -1 },
  { name: 'forward-in', action: 'ArrowRight', offset: 0 },
  { name: 'next', action: 'ArrowRight', offset: 1 },
  { name: 'reverse-in', action: 'ArrowLeft', offset: 0 },
  { name: 'list-in', action: 'row', offset: 0 },
  { name: 'last', action: 'seek', offset: 5 },
  { name: 'exclusive-out', action: 'ArrowRight', offset: 6 },
];

function synthesizeVideo(ffmpeg, filename, fps) {
  // 純色背景下半無文字；上半按實際解碼幀序輪換，另驗截圖確實是那一格。
  const filter = ['lime', 'blue', 'red'].map((color, n) =>
    `drawbox=x=0:y=0:w=iw:h=ih/2:color=${color}:t=fill:enable='eq(mod(n,3),${n})'`).join(',');
  execFileSync(ffmpeg, ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'color=c=0x101820:s=256x144:r=' + fps, '-vf', filter, '-t', '399',
    '-c:v', 'libx264', '-g', '30', '-bf', '0', '-preset', 'ultrafast', '-crf', '16',
    '-pix_fmt', 'yuv420p', filename], { windowsHide: true, timeout: 60000 });
}

function writeProject(file, media, config, start) {
  const name = path.basename(media);
  const project = {
    app: 'SUB Tool', version: 3, projectCanvas: { width: 1280, height: 720 },
    media: { name, path: media, size: fs.statSync(media).size }, duration: 399,
    playhead: start - 1 / config.rate, fps: config.fps, dropFrame: !!config.df,
    tracks: [{ name: '字幕', visible: true }],
    cues: [{ id: 'onset', text: cueText, start, end: start + 6 / config.rate, track: 1, timed: true }],
    videoTracks: [{ name: '影片', visible: true }],
    clips: [{ id: 'video', name, path: media, in: 0, out: 399, dur: 399, offset: 0, vtrack: 0, primary: true }],
  };
  fs.writeFileSync(file, Buffer.from('\ufeff' + JSON.stringify(project), 'utf16le'));
}

function findOwnedPipe(pid) {
  assert(Number.isSafeInteger(pid) && pid > 0);
  const command = `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${pid}" | Where-Object {$_.CommandLine -match '--input-ipc-server'} | Select-Object -ExpandProperty CommandLine`;
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', command],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const matches = [...raw.matchAll(/--input-ipc-server="?([^"\s]+)/g)];
  assert.equal(matches.length, 1, '此測試啟動的 Electron 應恰有一個 mpv 播放器');
  return matches[0][1];
}

function nativeCommand(pipe, command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    let buffer = '', responded = false;
    const timer = setTimeout(() => socket.destroy(new Error('mpv 截圖逾時')), 8000);
    socket.once('error', reject);
    socket.once('close', () => {
      clearTimeout(timer);
      if (!responded) reject(new Error('mpv 在回覆前關閉連線'));
    });
    socket.once('connect', () => socket.write(JSON.stringify({ command, request_id: 1 }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        let reply;
        try { reply = JSON.parse(line); } catch (error) { socket.destroy(error); return; }
        if (reply.request_id !== 1) continue;
        responded = true;
        socket.destroy();
        if (reply.error === 'success') resolve(reply.data);
        else reject(new Error(`${command[0]}: ${reply.error}`));
      }
    });
  });
}

function readRaster(rawPath, renderedPath) {
  const raw = PNG.sync.read(fs.readFileSync(rawPath)), shown = PNG.sync.read(fs.readFileSync(renderedPath));
  assert.deepEqual([raw.width, raw.height], [shown.width, shown.height]);
  const pixel = (Math.floor(raw.height / 4) * raw.width + Math.floor(raw.width / 2)) * 4;
  const rgb = [...raw.data.subarray(pixel, pixel + 3)];
  let changed = 0;
  for (let i = 0; i < raw.data.length; i += 4) {
    const difference = Math.abs(raw.data[i] - shown.data[i]) + Math.abs(raw.data[i + 1] - shown.data[i + 1])
      + Math.abs(raw.data[i + 2] - shown.data[i + 2]);
    if (difference > 72) changed++;
  }
  return { rgb, changed };
}

async function clickTarget(client, action) {
  const selectors = { row: '#sublist .sub-row .idx', block: '.cue-block .edge.l', ruler: '#rulerCanvas' };
  const point = await client.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selectors[action])}), rect = element.getBoundingClientRect();
    const x = ${action === 'ruler' ? "document.querySelector('.cue-block').getBoundingClientRect().left + 1" : 'rect.x + rect.width / 2'};
    const y = rect.y + ${action === 'ruler' ? '6' : 'rect.height / 2'};
    return { x, y, hit: element.contains(document.elementFromPoint(x, y)) };
  })()`);
  assert(point.hit, `點擊必須命中 ${selectors[action]}`);
  for (const [type, buttons] of [['mousePressed', 1], ['mouseReleased', 0]]) {
    await client.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', buttons, clickCount: 1 });
  }
}

async function verifyRate(executable, media, sourceRate, config, directory, artifactDir, failures) {
  const key = config.fps + (config.df ? '-df' : ''), captureDir = path.join(artifactDir, key);
  fs.mkdirSync(captureDir);
  // 00:06:35:15；29.97 DF 至第六分鐘已略去 12 個 TC 編號。
  const firstFrame = 395 * Math.round(config.fps) + 15 - (config.df ? 12 : 0);
  const start = firstFrame / config.rate, project = path.join(directory, key + '.subtool');
  writeProject(project, media, config, start);
  const port = await reservePort(), profile = path.join(directory, key + '-profile');
  const installed = path.resolve(executable).toLowerCase() !== path.resolve(ELECTRON).toLowerCase();
  const args = [...(installed ? [] : ['.']), '--subtool-transport-acceptance', '--disable-features=CalculateNativeWinOcclusion',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile, project];
  const child = trackElectron(spawn(executable, args, { cwd: ROOT, windowsHide: true, stdio: 'ignore' }));
  let client;
  const records = [];
  try {
    const target = await waitFor(async () => (await getJSON(`http://127.0.0.1:${port}/json/list`)).find(isMainWindowTarget), 'Electron', 20000);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.waitForApp();
    const ui = script => client.evaluate(script);
    await waitFor(() => ui(`window.SUB?.State?.cues[0]?.text === ${JSON.stringify(cueText)} && SUB.Media.mpvPresenting()`), '專案與 mpv', 25000);
    const pipe = findOwnedPipe(child.pid);
    await ui(`SUB.setZoom(500, ${start}); true`);
    const seek = time => ui(`Promise.resolve(SUB.Media.seek(${time})).then(() => true)`);
    await seek(start - 1 / config.rate);
    for (const step of steps) {
      if (step.action === 'row') {
        await seek(start - 2 / config.rate);
        await waitFor(() => ui(`!SUB.Media.presentationPending() && Math.abs(SUB.Media.displayTime() - ${start - 2 / config.rate}) < .001`), '列表跳頭前的播放點');
      }
      if (['row', 'block', 'ruler'].includes(step.action)) await clickTarget(client, step.action);
      else if (step.action === 'seek') await seek(start + step.offset / config.rate);
      else await dispatchKey(client, step.action);
      const expectedTime = (firstFrame + step.offset) / config.rate;
      const tc = '00:06:35' + (config.df ? ';' : ':') + (15 + step.offset);
      const state = await waitFor(() => ui(`(() => {
        const m = SUB.Media, tc = document.querySelector('#tcCur').textContent, presented = m.presentedTime();
        if (m.presentationPending() || !m.mpvPresenting() || m.webCodecsTakeover() || tc !== ${JSON.stringify(tc)} || presented == null) return false;
        return { tc, display: m.displayTime(), presented, native: m.mpvPresenting(), webCodecs: m.webCodecsTakeover(),
          text: document.querySelector('#videoSub').textContent,
          selected: SUB.State.cues[0].id === SUB.State.selectedId, fps: SUB.State.fps, df: !!SUB.State.dropFrame };
      })()`), `${key} ${step.name} ${tc}`, 7000);
      await delay(100); // mpv 收到字幕重載通知後可完成暫停畫格的重繪。
      const raw = path.join(captureDir, step.name + '-video.png'), shown = path.join(captureDir, step.name + '.png');
      await nativeCommand(pipe, ['screenshot-to-file', raw, 'video']);
      await nativeCommand(pipe, ['screenshot-to-file', shown, 'subtitles']);
      const pts = await nativeCommand(pipe, ['get_property', 'time-pos']);
      const raster = readRaster(raw, shown);
      const frame = Math.floor(expectedTime * sourceRate + 1e-7), channel = [1, 2, 0][frame % 3];
      const visible = step.offset >= 0 && step.offset < 6;
      const record = { ...state, name: step.name, sourceRate, pts, frame, visible, ...raster };
      records.push(record);
      // renderer 可能先發布位於該畫格內的專案時間，mpv 的 time-pos 與上半圖樣才是原生 PTS／畫格證據。
      const correct = config.fps === state.fps && !!config.df === state.df && Math.abs(state.display - expectedTime) < .001
        && Math.abs(pts - frame / sourceRate) < .001 && state.presented >= pts - .001 && state.presented < pts + 1 / sourceRate + .001
        && raster.rgb[channel] > 200 && (visible ? raster.changed > 25 : raster.changed === 0)
        && state.text === (visible ? cueText : '') && (step.action !== 'block' || state.selected);
      if (!correct) failures.push({ key, ...record });
    }
  } finally {
    fs.writeFileSync(path.join(captureDir, 'results.json'), JSON.stringify(records, null, 2));
    client?.close();
    await stopElectron(child);
  }
}

async function main() {
  assert.equal(process.platform, 'win32', '此驗收使用 Windows 原生 mpv');
  const executable = process.env.SUBTOOL_ACCEPTANCE_EXE || ELECTRON;
  const ffmpeg = path.join(ROOT, 'electron', 'ffmpeg', 'ffmpeg.exe');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-cue-boundary-work-'));
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-cue-boundary-evidence-'));
  const failures = [];
  let states = 0;
  console.log('證據目錄', evidence);
  try {
    for (const source of sources) {
      const name = source.fps.replace('/', '-'), media = path.join(work, 'frame-pattern-' + name + '.mp4');
      const captureDir = path.join(evidence, name), caseDir = path.join(work, name);
      fs.mkdirSync(captureDir);
      fs.mkdirSync(caseDir);
      synthesizeVideo(ffmpeg, media, source.fps);
      for (const config of source.projects) {
        await verifyRate(executable, media, source.rate, config, caseDir, captureDir, failures);
        states += steps.length;
      }
    }
    assert.deepEqual(failures, [], '暫停畫格、選取、時碼及字幕像素須符合專案區間');
    console.log(`${sources.length} 種來源、${projectRates.length} 種專案格率設定，共 ${states} 個狀態通過`);
  } finally {
    fs.writeFileSync(path.join(evidence, 'failures.json'), JSON.stringify(failures, null, 2));
    verifiedCleanup(work, 'subtool-cue-boundary-work-');
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
