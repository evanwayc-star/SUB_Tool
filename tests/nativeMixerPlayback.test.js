// @subtool-ci windows
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { nativeTestTools } from './fixtures/native-tools.cjs';

const require = createRequire(import.meta.url);
const {
  ROOT, ELECTRON, reservePort, getJSON, waitFor, delay, CdpClient,
  isMainWindowTarget, trackElectron, stopElectron, verifiedCleanup,
} = require('../scripts/acceptance/cdp-electron-harness.js');
const { connectMainInspector } = require('../scripts/diagnostics/main-inspector.js');
// Optional installed acceptance uses this exact content matrix, without build.
const installedExe = process.env.SUBTOOL_ACCEPTANCE_EXE ? path.resolve(process.env.SUBTOOL_ACCEPTANCE_EXE) : null;
const executable = installedExe || ELECTRON;
const installedNativeRoot = installedExe && path.join(path.dirname(installedExe), 'resources', 'app.asar.unpacked', 'electron');
const { ffmpeg, ffprobe } = installedNativeRoot
  ? { ffmpeg: path.join(installedNativeRoot, 'ffmpeg', 'ffmpeg.exe'), ffprobe: path.join(installedNativeRoot, 'ffmpeg', 'ffprobe.exe') }
  : nativeTestTools();
const requiredBinaries = [executable, ffmpeg, ffprobe,
  path.join(installedNativeRoot || path.join(ROOT, 'electron'), 'mpv', 'mpv.exe')];
const canRun = process.platform === 'win32' && (installedExe || requiredBinaries.every(existsSync));
const samePath = (a, b) => path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();

beforeAll(() => {
  if (!canRun) return;
  if (installedExe) {
    for (const file of requiredBinaries) expect(existsSync(file), file).toBe(true);
    return;
  }
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
    cwd: ROOT, windowsHide: true, timeout: 30000, maxBuffer: 10 * 1024 * 1024,
  });
});

function amplitudes(samples, rate, frequencies = [440, 880]) {
  return frequencies.map(frequency => {
    let sine = 0, cosine = 0;
    for (let index = 0; index < samples.length; index++) {
      const phase = 2 * Math.PI * frequency * index / rate;
      sine += samples[index] * Math.sin(phase);
      cosine += samples[index] * Math.cos(phase);
    }
    return 2 * Math.hypot(sine, cosine) / samples.length;
  });
}

function nativeOutput(file, frequencies) {
  const bytes = readFileSync(file), frames = Math.floor(bytes.length / 8);
  const start = Math.max(0, frames - 9600), left = [], right = [];
  for (let frame = start; frame < frames; frame++) {
    left.push(bytes.readFloatLE(frame * 8));
    right.push(bytes.readFloatLE(frame * 8 + 4));
  }
  return { frames, left: amplitudes(left, 48000, frequencies), right: amplitudes(right, 48000, frequencies) };
}

// Observe only this isolated application's actual destination inputs. The tee
// keeps the original master -> speakers connection and does not synthesize PCM.
function installOutputProbe() {
  const original = AudioNode.prototype.connect;
  window.mixerOutputProbe = { original, nodes: [] };
  AudioNode.prototype.connect = function (destination, ...rest) {
    if (destination instanceof AudioDestinationNode) {
      const analyser = this.context.createAnalyser();
      analyser.fftSize = 16384;
      original.call(this, analyser);
      mixerOutputProbe.nodes.push({ node: this, analyser });
    }
    return original.call(this, destination, ...rest);
  };
}

it.skipIf(!canRun)('真實 mpv 與快取播放輸出遵守混音器 solo、mute、推子、全靜音與重設', async () => {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'subtool-native-mixer-playback-'));
  const profile = path.join(directory, 'profile'), isolatedTemp = path.join(directory, 'system-temp');
  const pcmFile = path.join(directory, 'mpv-output.f32'), spawnLog = path.join(directory, 'mpv-spawn.json');
  const preload = path.join(directory, 'capture-mpv.cjs'), fixture = path.join(directory, 'two-stream-tones.mov');
  mkdirSync(isolatedTemp);
  // Inject only the output device into our own child before main.js captures
  // spawn. The real Media loader, mpv source graph, IPC and UI handlers remain.
  // This never records the system mix or another application's audio.
  writeFileSync(preload, `const cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
    const original=cp.spawn;let launches=0;cp.spawn=function(exe,args,options){
      if(path.basename(exe).toLowerCase()==='mpv.exe'){
        args=[...args,'--ao=pcm','--ao-pcm-waveheader=no','--ao-pcm-append=yes',
          '--audio-format=float','--audio-samplerate=48000','--audio-channels=stereo',
          '--ao-pcm-file='+${JSON.stringify(pcmFile)}];
        fs.writeFileSync(${JSON.stringify(spawnLog)},JSON.stringify({exe,args,launches:++launches}));
      }return original.call(this,exe,args,options);
    };`);
  let child, client, main;
  const evidence = { installedExe, samples: [] };
  try {
    execFileSync(ffmpeg, [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=blue:s=320x180:r=25:d=30',
      '-f', 'lavfi', '-i', 'aevalsrc=0.2*sin(2*PI*440*t):s=48000:d=30',
      '-f', 'lavfi', '-i', 'aevalsrc=0.2*sin(2*PI*880*t):s=48000:d=30',
      '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'pcm_s24le', fixture,
    ], { windowsHide: true, timeout: 20000, stdio: 'pipe' });
    const port = await reservePort(), inspectorPort = installedExe ? await reservePort() : null;
    child = trackElectron(spawn(executable, [
      '.', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      ...(installedExe ? [`--inspect=${inspectorPort}`] : []),
      '--subtool-transport-acceptance', '--no-sandbox',
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: installedExe ? undefined : `--require=${JSON.stringify(preload)}`, TEMP: isolatedTemp, TMP: isolatedTemp } }));
    child.stderr.on('data', chunk => { evidence.appStderr = ((evidence.appStderr || '') + chunk.toString()).slice(-16000); });
    if (installedExe) {
      main = await connectMainInspector(child.pid, { endpoint: `http://127.0.0.1:${inspectorPort}/json/list`, enable: () => {}, timeoutMs: 15000 });
      evidence.identity = await main.evaluate(`(()=>{const app=require('electron').app;return {
        pid:process.pid,execPath:process.execPath,packaged:app.isPackaged,version:app.getVersion(),
        appPath:app.getAppPath(),userData:app.getPath('userData')};})()`);
      expect(evidence.identity.pid).toBe(child.pid);
      expect(evidence.identity.packaged).toBe(true);
      expect(samePath(evidence.identity.execPath, installedExe)).toBe(true);
      expect(samePath(evidence.identity.userData, profile)).toBe(true);
      expect(evidence.identity.appPath.endsWith('app.asar')).toBe(true);
      expect(evidence.identity.version).toBe(process.env.SUBTOOL_ACCEPTANCE_VERSION || require('../package.json').version);
      const files = ['dist/index.html', 'electron/mpv-host.js', 'electron/mpv-audio-mix.js',
        'electron/native-audio-meter.js', 'electron/main.js', 'electron/preload.js'];
      evidence.sourceHashes = await main.evaluate(`(()=>{const f=require('node:fs'),p=require('node:path'),c=require('node:crypto');
        return Object.fromEntries(${JSON.stringify(files)}.map(file=>[file,c.createHash('sha256').update(
          f.readFileSync(p.join(require('electron').app.getAppPath(),file))).digest('hex')]));})()`);
      for (const file of files) expect(evidence.sourceHashes[file], file)
        .toBe(createHash('sha256').update(readFileSync(path.join(ROOT, file))).digest('hex'));
      // Packaged Electron restricts NODE_OPTIONS. Intercept the same real
      // spawn's final method after identity checks, before loading any media.
      await main.evaluate(`(()=>{const p=require('node:child_process').ChildProcess.prototype,
        pathApi=require('node:path'),fsApi=require('node:fs');
        if(global.__mixerOutputSpawn)throw new Error('Duplicate output probe');
        const original=p.spawn;global.__mixerOutputSpawn=original;let launches=0;
        global.__mixerSpawnDiagnostics={calls:[],stderr:'',events:[]};
        p.spawn=function(options){const diagnostics=global.__mixerSpawnDiagnostics;
          if(diagnostics.calls.length<40)diagnostics.calls.push({file:options.file,args:options.args});
          const isMpv=pathApi.basename(options.file).toLowerCase()==='mpv.exe';if(isMpv){
          options={...options,args:[...options.args,'--ao=pcm','--ao-pcm-waveheader=no','--ao-pcm-append=yes',
            '--audio-format=float','--audio-samplerate=48000','--audio-channels=stereo','--ao-pcm-file='+${JSON.stringify(pcmFile)}]};
          fsApi.writeFileSync(${JSON.stringify(spawnLog)},JSON.stringify({exe:options.file,args:options.args,launches:++launches}));
        }const result=original.call(this,options);
          if(isMpv){this.stderr?.on('data',chunk=>{diagnostics.stderr=(diagnostics.stderr+chunk.toString()).slice(-16000);});
            this.once('error',e=>diagnostics.events.push({error:e.message,code:e.code}));
            this.once('exit',(code,signal)=>diagnostics.events.push({code,signal}));}
          return result;};return true;
      })()`);
    }
    const target = await waitFor(async () =>
      (await getJSON(`http://127.0.0.1:${port}/json/list`)).find(isMainWindowTarget), '混音器主視窗', 15000);
    client = new CdpClient(target.webSocketDebuggerUrl, { timeoutMs: 30000 });
    await client.connect();
    await client.send('Page.enable');
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${installOutputProbe.toString()})()` });
    await client.send('Page.reload');
    await waitFor(() => client.evaluate('Boolean(window.mixerOutputProbe)'), '輸出探針的新文件');
    await client.waitForApp();
    await waitFor(() => client.evaluate('Boolean(document.querySelector("#sublist .empty, #sublist .sub-row"))'), '工作區初始化');
    if (installedExe) expect(await client.evaluate('document.getElementById("appVersion").textContent.trim()'))
      .toBe('v' + evidence.identity.version);
    await client.evaluate(`(() => {
      const m=SUB.Media;
      // Keep the mother audio carrier available for the PCM silence checks
      // after cached handoff; smooth preview can switch to a video-only proxy.
      SUB.State.previewMode='original';
      window.mixerCacheHold={wave:m._prepareSourceWaveform,ingest:m._bgAudioIngest,args:null};
      m._prepareSourceWaveform=async()=>null;
      m._bgAudioIngest=async(...args)=>{mixerCacheHold.args=args;return null;};
      const input=document.createElement('input');input.type='file';input.id='mixerFixture';input.hidden=true;document.body.append(input);
    })()`);
    const { root } = await client.send('DOM.getDocument');
    const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#mixerFixture' });
    await client.send('DOM.setFileInputFiles', { nodeId, files: [fixture] });
    evidence.intake = await client.evaluate(`(async()=>{
      const source=await subtool.authorizeDroppedFile(document.querySelector('#mixerFixture').files[0]);
      const info=await subtool.probe(source),detected=await subtool.mpv.detect();
      await SUB.Media.loadDesktopMedia(source);
      document.querySelector('[data-act="mixer"]').click();
      await SUB.Media.seek(.4);SUB.Media.play();return {detected,mpv:SUB.Media.mpvMode,
        audio:info.audio.map(s=>({channels:s.channels,index:s.index,streamIndex:s.streamIndex})),video:info.video.codec};
    })()`);
    await waitFor(() => existsSync(pcmFile) && readFileSync(pcmFile).length > 100000, 'mpv 實際 PCM', 5000);
    const spawnedMpv = JSON.parse(readFileSync(spawnLog, 'utf8'));
    expect(spawnedMpv.args).toContain('--ao=pcm');
    if (installedExe) expect(samePath(spawnedMpv.exe, path.join(installedNativeRoot, 'mpv', 'mpv.exe'))).toBe(true);

    const click = (selector, index = 0) => client.evaluate(`document.querySelectorAll(${JSON.stringify(selector)})[${index}].click();true`);
    const solo = index => click('#mixerStrips .mx-solo', index);
    const mute = index => click('#mixerStrips .mx-mute', index);
    const reset = () => click('[data-act="mixer-reset"]');
    const setFader = (index, percent) => client.evaluate(`(()=>{
      const input=document.querySelectorAll('#mixerStrips .mx-fader')[${index}];
      input.value=${JSON.stringify(String(percent))};input.dispatchEvent(new Event('input',{bubbles:true}));
      input.dispatchEvent(new Event('change',{bubbles:true}));return true;
    })()`);
    async function observe(mode, label, expected) {
      // Allow the real AO queue and the 341ms WebAudio FFT window to settle.
      const before = await client.evaluate('SUB.Media.vTime()');
      const previousFrames = nativeOutput(pcmFile).frames;
      await delay(750);
      // The PCM AO can prefill more than 750ms while paused at initial load.
      // Wait for fresh output instead of mistaking that valid queue for a stall.
      await waitFor(() => nativeOutput(pcmFile).frames > previousFrames, 'mpv PCM 輸出繼續前進', 1500);
      const state = await client.evaluate(`(()=>({
        time:SUB.Media.vTime(),playing:SUB.Media.playing,mpv:SUB.Media.mpvMode,
        tracks:SUB.Media.tracks.map(t=>({kind:t.kind,gain:t.gain?.gain.value})),
        buses:SUB.State.audioProject.buses.map(b=>({solo:b.solo,muted:b.muted,volume:b.volume})),
        masters:mixerOutputProbe.nodes.map(n=>{const samples=new Float32Array(n.analyser.fftSize);
          n.analyser.getFloatTimeDomainData(samples);return (${amplitudes.toString()})(samples,n.analyser.context.sampleRate);})
      }))()`);
      const native = nativeOutput(pcmFile), result = { mode, label, expected, state, native };
      evidence.samples.push(result);
      const detail = JSON.stringify(result);
      expect.soft(state.playing, detail).toBe(true);
      expect.soft(state.mpv, detail).toBe(true);
      expect.soft(state.time, detail).toBeGreaterThan(before + .2);
      expect.soft(native.frames, detail).toBeGreaterThan(previousFrames);
      expect.soft(state.tracks.length, detail).toBe(mode === 'native' ? 0 : 2);
      expect.soft(state.masters.length, detail).toBe(1);
      const actual = mode === 'native' ? native.left : state.masters[0];
      for (let channel = 0; channel < 2; channel++) {
        expect.soft(Math.abs(actual[channel] - expected[channel]), detail).toBeLessThan(expected[channel] ? .015 : .003);
        if (mode === 'native') {
          expect.soft(Math.abs(native.right[channel] - expected[channel]), detail).toBeLessThan(expected[channel] ? .015 : .003);
          expect.soft(state.masters[0][channel], detail).toBeLessThan(.003);
        } else expect.soft(native.left[channel], detail).toBeLessThan(.003);
      }
    }
    async function exercise(mode) {
      await observe(mode, 'both', [.2, .2]);
      await solo(0);await observe(mode, 'solo A1', [.2, 0]);
      await solo(0);await solo(1);await observe(mode, 'solo A2', [0, .2]);
      await solo(0);await observe(mode, 'both solo', [.2, .2]);
      await mute(0);await observe(mode, 'mute takes precedence over solo', [0, .2]);
      await reset();await setFader(0, 50);await observe(mode, 'A1 fader -6 dB', [.1, .2]);
      await click('[data-act="mixer-muteall"]');await observe(mode, 'mute all', [0, 0]);
      await reset();await observe(mode, 'reset', [.2, .2]);
    }
    await exercise('native');
    await solo(0);
    await observe('native', 'solo before cache handoff', [.2, 0]);
    // Release exactly the work blocked at the real loader; cache creation and
    // the playing handoff use production code, retaining the active UI solo.
    await client.evaluate(`(async()=>{
      SUB.Media._prepareSourceWaveform=mixerCacheHold.wave;SUB.Media._bgAudioIngest=mixerCacheHold.ingest;
      await mixerCacheHold.ingest.apply(SUB.Media,mixerCacheHold.args);return true;
    })()`);
    await waitFor(() => client.evaluate('SUB.Media.tracks.length===2'), '真實快取播放音軌', 15000);
    await observe('cached', 'solo retained through cache handoff', [.2, 0]);
    await reset();await exercise('cached');
    await solo(1);await client.evaluate('SUB.Media.pause();true');
    await client.evaluate('(async()=>{await SUB.Media.seek(.4);SUB.Media.play();return true;})()');
    await observe('cached', 'solo retained through pause and seek', [0, .2]);

    // A real source switch must rebuild both the stream and channel coordinates.
    // Keep the native host alive and leave only the new source's cache pending.
    await client.evaluate('SUB.Media.pause();SUB.Media._prepareSourceWaveform=async()=>null;true');
    const stereo = path.join(directory, 'one-stereo-stream.mov');
    const labelled = path.join(directory, 'eight-speaker-streams.mov');
    const layouts = ['DL', 'DR', 'FL', 'FR', 'FC', 'LFE', 'BL', 'BR'];
    const labelledHz = layouts.map((_, index) => 200 * (index + 1));
    const encode = args => execFileSync(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args],
      { windowsHide: true, timeout: 20000, stdio: 'pipe' });
    encode(['-f', 'lavfi', '-i', 'color=red:s=64x48:r=25:d=10',
      '-f', 'lavfi', '-i', 'aevalsrc=0.2*sin(2*PI*440*t)|0.2*sin(2*PI*880*t):s=48000:d=10',
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-c:a', 'pcm_s24le', stereo]);
    const args = ['-f', 'lavfi', '-i', 'color=green:s=64x48:r=25:d=10'];
    for (const frequency of labelledHz) args.push('-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=10`);
    args.push('-map', '0:v:0');
    layouts.forEach((layout, index) => args.push('-map', `${index + 1}:a:0`, `-filter:a:${index}`, `channelmap=map=0:channel_layout=${layout}`));
    encode([...args, '-c:v', 'libx264', '-c:a', 'pcm_s24le', labelled]);
    const audioMetadata = file => JSON.parse(execFileSync(ffprobe, [
      '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=channels,channel_layout', '-of', 'json', file,
    ], { windowsHide: true, encoding: 'utf8', timeout: 10000 })).streams;
    expect(audioMetadata(stereo)).toEqual([{ channels: 2, channel_layout: 'stereo' }]);
    expect(audioMetadata(labelled)).toEqual(layouts.map(layout =>
      ({ channels: 1, channel_layout: layout === 'FC' ? 'mono' : `1 channels (${layout})` })));
    const hostLaunches = JSON.parse(readFileSync(spawnLog, 'utf8')).launches;
    async function appendAndSwitch(file, offset, coordinates) {
      await reset();
      await client.send('DOM.setFileInputFiles', { nodeId, files: [file] });
      const source = await client.evaluate(`(async()=>{
        const source=await subtool.authorizeDroppedFile(document.querySelector('#mixerFixture').files[0]);
        const clip=await SUB.Media.addClipDesktop(source,{offset:${offset},vtrack:0});
        if(!clip)throw new Error('新增驗收素材失敗');
        await SUB.Media.seek(${offset + .4});SUB.Media.play();
        return {id:clip.id,routes:SUB.State.audioProject.sourceMaps[clip.audioSourceId].channels.map(c=>({
          stream:c.sourceStream,channel:c.sourceChannel,buses:c.busIds}))};
      })()`);
      expect(source.routes.map(route => [route.stream, route.channel])).toEqual(coordinates);
      expect(source.routes.every(route => route.buses.length === 1)).toBe(true);
      return source;
    }
    async function observeSourceSolo(source, channel, frequencies, amplitude) {
      await reset();
      const bus = source.routes[channel].buses[0];
      await click(`#mixerStrips .mx-strip[data-bus-id="${bus}"] .mx-solo`);
      await delay(850);
      const state = await client.evaluate(`(()=>({active:SUB.Media.activeClip()?.id,mpv:SUB.Media.mpvMode,
        playing:SUB.Media.playing,masters:mixerOutputProbe.nodes.map(n=>{const data=new Float32Array(n.analyser.fftSize);
          n.analyser.getFloatTimeDomainData(data);return (${amplitudes.toString()})(data,n.analyser.context.sampleRate,${JSON.stringify(frequencies)});})}))()`);
      const output = nativeOutput(pcmFile, frequencies), detail = JSON.stringify({ source, channel, state, output });
      evidence.samples.push({ mode: 'loadFile', source, channel, frequencies, state, output });
      expect.soft(state.active, detail).toBe(source.id);
      expect.soft(state.mpv && state.playing, detail).toBe(true);
      expect.soft(JSON.parse(readFileSync(spawnLog, 'utf8')).launches, detail).toBe(hostLaunches);
      for (let index = 0; index < frequencies.length; index++) {
        const expected = index === channel ? amplitude : 0;
        expect.soft(Math.abs(output.left[index] - expected), detail).toBeLessThan(expected ? .015 : .003);
        expect.soft(Math.abs(output.right[index] - expected), detail).toBeLessThan(expected ? .015 : .003);
        expect.soft(state.masters[0][index], detail).toBeLessThan(.003);
      }
    }
    const stereoSource = await appendAndSwitch(stereo, 30, [[0, 0], [0, 1]]);
    await observeSourceSolo(stereoSource, 0, [440, 880], .2);
    await observeSourceSolo(stereoSource, 1, [440, 880], .2);
    await client.evaluate('SUB.Media.pause();true');
    const labelledSource = await appendAndSwitch(labelled, 40, layouts.map((_, index) => [index, 0]));
    await observeSourceSolo(labelledSource, 1, labelledHz, .125);
    await observeSourceSolo(labelledSource, 7, labelledHz, .125);
  } catch (error) {
    evidence.error = error.stack || String(error);
    throw error;
  } finally {
    if (installedExe) {
      evidence.spawn = existsSync(spawnLog) ? JSON.parse(readFileSync(spawnLog, 'utf8')) : null;
      evidence.pcmBytes = existsSync(pcmFile) ? readFileSync(pcmFile).length : null;
      try { if (main) evidence.spawnDiagnostics = await main.evaluate('JSON.parse(JSON.stringify(global.__mixerSpawnDiagnostics||null))'); }
      catch (error) { evidence.diagnosticError = String(error); }
      try { if (client) evidence.finalPlayback = await client.evaluate(`(()=>({mpv:SUB.Media.mpvMode,
        playing:SUB.Media.playing,time:SUB.Media.vTime(),pending:SUB.Media.presentationPending(),
        tracks:SUB.Media.tracks.map(t=>({kind:t.kind})),status:document.getElementById('status')?.textContent}))()`); }
      catch (error) { evidence.rendererDiagnosticError = String(error); }
    }
    try {
      if (client) await client.evaluate(`(()=>{
        const media=window.SUB?.Media;media?.pause();const held=window.mixerCacheHold;
        if(held&&media){media._prepareSourceWaveform=held.wave;media._bgAudioIngest=held.ingest;}
        const probe=window.mixerOutputProbe;
        if(probe){AudioNode.prototype.connect=probe.original;for(const n of probe.nodes)n.node.disconnect(n.analyser);}
        media?.reset();delete window.mixerCacheHold;delete window.mixerOutputProbe;return true;
      })()`);
    } finally {
      try {
        if (main) await main.evaluate(`(()=>{if(global.__mixerOutputSpawn){require('node:child_process').ChildProcess.prototype.spawn=global.__mixerOutputSpawn;delete global.__mixerOutputSpawn;}return true;})()`);
      } finally {
        client?.close();main?.close();await stopElectron(child);
        verifiedCleanup(directory, 'subtool-native-mixer-playback-', { maxRetries: 20, retryDelay: 100 });
        if (installedExe) {
          evidence.profileCleaned = true;
          const output = path.join(tmpdir(), `subtool-installed-mixer-${Date.now()}.json`);
          writeFileSync(output, JSON.stringify(evidence, null, 2));
          console.info('Installed mixer content evidence: ' + output);
        }
      }
    }
  }
}, 45000);
