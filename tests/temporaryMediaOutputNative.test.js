// @subtool-ci windows
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { parse } from 'acorn';
import { afterEach, expect, it } from 'vitest';
import { nativeTestTools } from './fixtures/native-tools.cjs';

const require = createRequire(import.meta.url);
const { createMediaIntakeRuntime, sourceAudioClockFilter } = require('../electron/media-intake-runtime.js');
const { createFFmpegExecution, buildIngestArgs } = require('../electron/ffmpeg-execution-engine.js');
const { createMediaProbe } = require('../electron/media-probe.js');
const { FileAuthority } = require('../electron/file-authority.js');
const { createIpcGuards } = require('../electron/ipc-guards.js');
const { ffmpeg, ffprobe } = nativeTestTools();
const roots = [];
function run(executable, args) {
  const result = spawnSync(executable, args, { windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  expect(result.error || result.status, result.stderr?.toString()).toBe(0);
  return result.stdout;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    const resolved = fs.realpathSync(root);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('subtool-legacy-native-'))
      throw new Error('拒絕清除測試目錄以外資料');
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

it.skipIf(!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe))('舊式真 IPC 的受控 fd 輸出保留 proxy 畫格、AAC 複製與波形 PCM', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-legacy-native-')); roots.push(root);
  const tempRoot = path.join(root, 'temp'); fs.mkdirSync(tempRoot);
  const source = path.join(root, 'source.mp4');
  run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=10:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
    '-c:v', 'libx264', '-c:a', 'aac', '-y', source]);
  const authority = new FileAuthority({ internalDirectories: [tempRoot] }); authority.grantTrustedFile(source);
  const probe = createMediaProbe({ executable: ffprobe });
  const execution = createFFmpegExecution({ getFFmpegPath: () => ffmpeg, getUserDataDir: () => root });
  const runtime = createMediaIntakeRuntime({ tempRoot, cacheRoot: path.join(root, 'cache'), fileAuthority: authority });
  const main = fs.readFileSync(path.join(process.cwd(), 'electron/main.js'), 'utf8');
  const tree = parse(main, { ecmaVersion: 'latest', sourceType: 'script' });
  let counter = 0;
  const invoke = async (channel, payload) => {
    const call = tree.body.map(node => node.expression).find(node => node?.callee?.object?.name === 'ipcMain'
      && node.callee.property?.name === 'handle' && node.arguments?.[0]?.value === channel);
    let handler;
    vm.runInNewContext(main.slice(call.start, call.end), {
      ipcMain: { handle: (_name, callback) => { handler = callback; } },
      requireReadablePath: createIpcGuards(authority).requireReadablePath,
      tmpPath: ext => path.join(tempRoot, `owned-${++counter}.${ext}`),
      runFF: (args, options) => execution.execute(args, { ...options, executionKind: 'direct' }),
      mediaProbe: probe, mediaIntakeRuntime: runtime, buildIngestArgs, sourceAudioClockFilter, VENC: 'libx264',
    });
    return handler({ sender: null }, payload);
  };
  try {
    const info = await probe.describe(source);
    const proxy = await invoke('ffmpeg:proxy', { path: source, duration: 2 });
    const baseline = path.join(root, 'baseline.mp4');
    run(ffmpeg, ['-v', 'error', ...buildIngestArgs({ src: source, needsProxy: true, proxyPath: baseline, encoder: 'libx264', video: info.video })]);
    const hashes = file => String(run(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', 'pipe:1']))
      .split('\n').filter(line => /^0,/.test(line)).map(line => line.trim());
    const actual = hashes(proxy), expected = hashes(baseline);
    expect(actual).toHaveLength(20); expect(actual).toEqual(expected);
    const copied = await invoke('ffmpeg:extractAudio', { path: source, idx: 0, duration: 2, codec: 'aac' });
    const pcm = file => run(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 's16le', '-ac', '1', '-ar', '48000', 'pipe:1']);
    const originalPcm = pcm(source), copiedPcm = pcm(copied);
    expect(copiedPcm.length).toBeGreaterThan(190000); expect(copiedPcm.equals(originalPcm)).toBe(true);
    const wave = await invoke('ffmpeg:waveAudio', { path: source, duration: 2 });
    const wavePcm = run(ffmpeg, ['-v', 'error', '-i', wave, '-map', '0:a:0', '-f', 's16le', '-ac', '1', '-ar', '4000', 'pipe:1']);
    const expectedPcm = run(ffmpeg, ['-v', 'error', '-i', source, '-map', '0:a:0', '-af', sourceAudioClockFilter(info.audio[0]),
      '-f', 's16le', '-ac', '1', '-ar', '4000', 'pipe:1']);
    expect(wavePcm.length).toBeGreaterThan(15000); expect(wavePcm.equals(expectedPcm)).toBe(true);
    const rawSource = path.join(root, 'raw.wav');
    run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:a', 'pcm_s16le', '-y', rawSource]);
    authority.grantTrustedFile(rawSource);
    // PCM copy into M4A fails, so the same owner must survive AAC fallback.
    const fallback = await invoke('ffmpeg:extractAudio', { path: rawSource, idx: 0, duration: 2, codec: 'flac' });
    expect((await probe.describe(fallback)).audio[0].codec).toBe('aac');
    const rawPcm = pcm(rawSource), encodedPcm = pcm(fallback);
    expect(encodedPcm.length).toBeGreaterThan(190000);
    let cross = 0, rawEnergy = 0, encodedEnergy = 0;
    for (let offset = 8192; offset < Math.min(rawPcm.length, encodedPcm.length) - 8192; offset += 2) {
      const left = rawPcm.readInt16LE(offset), right = encodedPcm.readInt16LE(offset);
      cross += left * right; rawEnergy += left * left; encodedEnergy += right * right;
    }
    expect(cross / Math.sqrt(rawEnergy * encodedEnergy)).toBeGreaterThan(.98);
    for (const file of [proxy, copied, wave, fallback]) expect(runtime.cleanupGeneratedFile(file)).toBe(true);
  } finally { await runtime.close(); await execution.cancelAllAndWait(); await probe.cancelAllAndWait(); }
}, 30000);
