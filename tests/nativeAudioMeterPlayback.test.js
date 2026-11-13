// @subtool-ci windows
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { nativeTestTools } from './fixtures/native-tools.cjs';

const require = createRequire(import.meta.url);
const {
  ROOT, ELECTRON, reservePort, getJSON, waitFor, CdpClient,
  isMainWindowTarget, trackElectron, stopElectron, verifiedCleanup,
} = require('../scripts/acceptance/cdp-electron-harness.js');
const { ffmpeg, ffprobe } = nativeTestTools();
const canRun = process.platform === 'win32' && [ELECTRON, ffmpeg, ffprobe,
  path.join(ROOT, 'electron', 'mpv', 'mpv.exe')].every(existsSync);

beforeAll(() => {
  if (!canRun) return;
  // npm test may precede npm run build. Exercise this checkout, not stale dist.
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
    cwd: ROOT, windowsHide: true, timeout: 30000, maxBuffer: 10 * 1024 * 1024,
  });
});

function readMeters() {
  const { Media, State } = SUB;
  return {
    playing: Media.playing,
    mpv: Media.mpvMode,
    sourceTime: Media.vTime(),
    timelineTime: Media.displayTime(),
    pending: Media.presentationPending(),
    tracks: Media.tracks.length,
    blocked: { ...window.nativeMeterAcceptance.blocked },
    routes: Object.values(State.audioProject.sourceMaps).flatMap(source =>
      source.channels.map(channel => ({
        stream: channel.sourceStream, channel: channel.sourceChannel, buses: channel.busIds,
      }))),
    meters: [...document.querySelectorAll('#mixerStrips .mx-strip')].map(strip => {
      const meter = strip.querySelector('.mx-channel-meter').getBoundingClientRect();
      const mask = strip.querySelector('.mx-mask').getBoundingClientRect();
      return {
        bus: strip.dataset.busId,
        value: strip.querySelector('.mx-meter-val').textContent,
        height: meter.height,
        visibleHeight: meter.height - mask.height,
      };
    }),
  };
}

const near = (text, db) => Number.isFinite(Number(text)) && Math.abs(Number(text) - db) < 0.8;

async function waitForLevels(client, { from, to, levels, label }) {
  let last;
  const samples=[];
  try {
    return await waitFor(async () => {
      last = await client.evaluate(`(${readMeters.toString()})()`);
      samples.push({time:last.sourceTime,values:last.meters.map(meter=>meter.value)});
      if (last.tracks !== 0) throw new Error('背景播放快取不應在此測試完成');
      return last.playing && last.mpv && !last.pending
        && last.sourceTime >= from && last.sourceTime <= to
        && last.meters.length === levels.length
        && last.meters.every((meter, index) => near(meter.value, levels[index])) ? last : null;
    }, label, 6000);
  } catch (error) {
    throw new Error(`${error.message}；最後音量表狀態：${JSON.stringify(last)}；電平歷程：${JSON.stringify(samples)}`, { cause: error });
  }
}

it.skipIf(!canRun)('mpv 原音在播放快取未完成時仍顯示各 stream 電平，隨音量、暫停與 seek 更新', async () => {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'subtool-native-meter-playback-'));
  const profile = path.join(directory, 'profile');
  const isolatedTemp = path.join(directory, 'system-temp');
  mkdirSync(isolatedTemp);
  const fixture = path.join(directory, 'two-stream-levels.mov');
  let child, client;
  try {
    // Two independent mono streams both use channel 0. This catches flattening
    // stream/channel identity, and the 4s boundary proves readings follow time.
    execFileSync(ffmpeg, [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=blue:size=320x180:rate=25',
      '-f', 'lavfi', '-i', "aevalsrc='if(lt(t,4),0.5011872336272722,0.12589254117941673)*sin(2*PI*440*t)':s=48000",
      '-f', 'lavfi', '-i', "aevalsrc='if(lt(t,4),0.251188643150958,0.06309573444801933)*sin(2*PI*880*t)':s=48000",
      '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0', '-t', '8',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'pcm_s24le', fixture,
    ], { cwd: ROOT, windowsHide: true, timeout: 20000, stdio: 'pipe' });

    const port = await reservePort();
    child = trackElectron(spawn(ELECTRON, [
      '.', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      '--subtool-transport-acceptance', '--no-sandbox',
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ], {
      cwd: ROOT, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, TEMP: isolatedTemp, TMP: isolatedTemp },
    }));
    const target = await waitFor(async () =>
      (await getJSON(`http://127.0.0.1:${port}/json/list`)).find(isMainWindowTarget), '主視窗', 15000);
    client = new CdpClient(target.webSocketDebuggerUrl, { timeoutMs: 15000 });
    await client.connect();
    await client.waitForApp();
    await waitFor(() => client.evaluate('Boolean(document.querySelector("#sublist .empty, #sublist .sub-row"))'),
      '設定與工作區初始化');

    // Block only background cache work in this disposable renderer. Keep the
    // real loader, file capabilities, native mpv clock, IPC and meter sampling.
    await client.evaluate(`(() => {
      const { Media } = SUB;
      window.nativeMeterAcceptance = { blocked: { waveform: 0, ingest: 0 },
        waveform: Media._prepareSourceWaveform, ingest: Media._bgAudioIngest };
      Media._prepareSourceWaveform = async () => { nativeMeterAcceptance.blocked.waveform++; return null; };
      Media._bgAudioIngest = async () => { nativeMeterAcceptance.blocked.ingest++; return null; };
      const input = document.createElement('input');
      input.type = 'file'; input.id = 'nativeMeterFixture'; input.hidden = true;
      document.body.append(input);
    })()`);
    const { root } = await client.send('DOM.getDocument');
    const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#nativeMeterFixture' });
    await client.send('DOM.setFileInputFiles', { nodeId, files: [fixture] });
    const authorized = await client.evaluate(`(async () => {
      const source = await window.subtool.authorizeDroppedFile(document.getElementById('nativeMeterFixture').files[0]);
      if (!source) throw new Error('測試素材未獲准讀取');
      await SUB.Media.loadDesktopMedia(source);
      document.querySelector('[data-act="mixer"]').click();
      await SUB.Media.seek(0.4);
      return source;
    })()`);
    expect(path.normalize(authorized)).toBe(path.normalize(fixture));
    const initial = await client.evaluate(`(${readMeters.toString()})()`);
    expect(initial.mpv).toBe(true);
    expect(initial.tracks).toBe(0);
    expect(initial.blocked.waveform).toBeGreaterThan(0);
    expect(initial.blocked.ingest).toBeGreaterThan(0);
    expect(initial.routes.map(route => [route.stream, route.channel])).toEqual([[0, 0], [1, 0]]);
    expect(initial.meters).toHaveLength(2);
    expect(initial.routes.map(route => route.buses)).toEqual(initial.meters.map(meter => [meter.bus]));

    await client.evaluate('SUB.Media.play(); true');
    const loud = await waitForLevels(client, { from: 0.7, to: 3.5, levels: [-6, -12], label: '快取前兩個原音 stream 的電平' });
    expect(loud.sourceTime).toBeGreaterThan(initial.sourceTime + 0.2);
    expect(loud.timelineTime).toBeGreaterThan(initial.timelineTime + 0.2);
    expect(loud.meters[0].visibleHeight).toBeGreaterThan(loud.meters[1].visibleHeight);
    for (const meter of loud.meters) expect(meter.visibleHeight).toBeGreaterThan(10);

    const quiet = await waitForLevels(client, { from: 4.5, to: 7, levels: [-18, -24], label: '自然播放跨過音量變化後的電平' });
    expect(quiet.sourceTime).toBeGreaterThan(loud.sourceTime);
    for (let index = 0; index < 2; index++) {
      expect(quiet.meters[index].visibleHeight).toBeLessThan(loud.meters[index].visibleHeight - 10);
    }

    await client.evaluate('SUB.Media.pause(); true');
    const paused = await waitFor(async () => {
      const reading = await client.evaluate(`(${readMeters.toString()})()`);
      return !reading.playing && reading.meters.every(meter => meter.value === '-∞' && meter.visibleHeight < 1)
        ? reading : null;
    }, '暫停後音量表歸底', 5000);
    expect(paused.tracks).toBe(0);
    await client.evaluate('(async () => { await SUB.Media.seek(0.4); SUB.Media.play(); })()');
    const restarted = await waitForLevels(client, { from: 0.7, to: 3.5, levels: [-6, -12], label: 'seek 回大聲段後重新取得原音電平' });
    expect(restarted.sourceTime).toBeLessThan(paused.sourceTime);
    expect(restarted.tracks).toBe(0);
  } finally {
    try {
      if (client) await client.evaluate(`(() => {
        const probe = window.nativeMeterAcceptance;
        if (!probe) return;
        SUB.Media.pause();
        SUB.Media._prepareSourceWaveform = probe.waveform;
        SUB.Media._bgAudioIngest = probe.ingest;
        SUB.Media.reset();
        document.getElementById('nativeMeterFixture')?.remove();
        delete window.nativeMeterAcceptance;
      })()`);
    } finally {
      client?.close();
      await stopElectron(child);
      verifiedCleanup(directory, 'subtool-native-meter-playback-', { maxRetries: 20, retryDelay: 100 });
    }
  }
}, 30000);
