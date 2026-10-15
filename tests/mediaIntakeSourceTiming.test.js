// @subtool-ci windows
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { parse } from 'acorn';
import { nativeTestTools } from './fixtures/native-tools.cjs';

const require = createRequire(import.meta.url);
const { createMediaProbe } = require('../electron/media-probe.js');
const { createMediaIntakeRuntime, cacheKeyFor, sourceAudioClockFilter } = require('../electron/media-intake-runtime.js');
const { createFFmpegExecution } = require('../electron/ffmpeg-execution-engine.js');
const { FileAuthority } = require('../electron/file-authority.js');
const { ffmpeg: FFMPEG, ffprobe: FFPROBE } = nativeTestTools();
const roots = [];

function run(args) {
  const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], {
    windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024,
  });
  expect(result.error || result.status, result.stderr?.toString()).toBe(0);
  return result.stdout;
}

function pcm(file) {
  return run(['-i', file, '-map', '0:a:0', '-ar', '4000', '-ac', '1', '-f', 'f32le', 'pipe:1']);
}

function energy(bytes, start, end, frequency = null) {
  let sum = 0, sine = 0, cosine = 0;
  const first = Math.round(start * 4000), last = Math.round(end * 4000);
  expect(bytes.length / 4).toBeGreaterThanOrEqual(last);
  for (let index = first; index < last; index++) {
    const value = bytes.readFloatLE(index * 4);
    sum += value * value;
    const phase = 2 * Math.PI * (frequency || 0) * index / 4000;
    sine += value * Math.sin(phase); cosine += value * Math.cos(phase);
  }
  return frequency == null ? Math.sqrt(sum / (last - first)) : 2 * Math.hypot(sine, cosine) / (last - first);
}

afterEach(() => {
  for (const directory of roots.splice(0)) {
    const resolved = fs.realpathSync(directory);
    if (path.dirname(resolved) !== fs.realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-intake-source-clock-')) throw new Error('拒絕清除未核對的來源時間測試目錄');
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe.skipIf(!fs.existsSync(FFMPEG) || !fs.existsSync(FFPROBE))('母素材來源時間的音訊快取', () => {
  it.each([0, 5])('實際 waveAudio IPC 的容器起點 %s 保留來源第一秒靜音與完整波形', async origin => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-intake-source-clock-')); roots.push(directory);
    const source = path.join(directory, 'direct.mkv'), wave = path.join(directory, 'wave.wav');
    run(['-y', '-itsoffset', String(origin), '-f', 'lavfi', '-i', 'color=red:s=64x48:r=30:d=3',
      '-itsoffset', String(origin + 1), '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-c:a', 'pcm_s16le', source]);
    const probe = createMediaProbe({ executable: FFPROBE });
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => directory });
    const main = fs.readFileSync(path.resolve('electron/main.js'), 'utf8');
    const call = parse(main, { ecmaVersion: 'latest' }).body.map(node => node.expression).find(node =>
      node?.callee?.object?.name === 'ipcMain' && node.callee.property?.name === 'handle' && node.arguments?.[0]?.value === 'ffmpeg:waveAudio');
    let waveAudio;
    vm.runInNewContext(main.slice(call.start, call.end), {
      ipcMain: { handle: (name, handler) => { waveAudio = handler; } },
      requireReadablePath(channel, file) { expect(channel).toBe('ffmpeg:waveAudio'); expect(file).toBe(source); },
      mediaProbe: probe, sourceAudioClockFilter, tmpPath: () => wave,
      runFF: (args, options) => execution.execute(args, { ...options, executionKind: 'direct' }),
    });
    try {
      const descriptor = await probe.describe(source);
      expect(await waveAudio({ sender: {} }, { path: source, duration: descriptor.duration })).toBe(wave);
      const samples = pcm(wave);
      expect(samples.length / 4 / 4000).toBeCloseTo(3, 2);
      expect(energy(samples, 0.1, 0.8)).toBeLessThan(0.0001);
      expect(energy(samples, 1.1, 1.8, 440)).toBeGreaterThan(0.08);
    } finally { await execution.cancelAllAndWait(); await probe.cancelAllAndWait(); }
  }, 30000);

  it.each([
    ...['ingest', 'stream'].flatMap(mode => [0, 5].map(origin => ({ mode, origin, audioDelay: 1, codec: 'pcm_s16le' }))),
    { mode: 'ingest', origin: 0, audioDelay: 1, codec: 'aac' },
    { mode: 'stream', origin: 0, audioDelay: 0, codec: 'aac' },
  ])('$mode 容器起點 $origin、$codec：波形、聲道與 Proxy 共用來源時鐘，重開不回舊 cache', async ({ mode, origin, audioDelay, codec }) => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-intake-source-clock-')); roots.push(directory);
    const source = path.join(directory, 'mother.mkv'), cache = path.join(directory, 'cache');
    run(['-y', '-itsoffset', String(origin), '-f', 'lavfi', '-i', 'color=red:s=64x48:r=30:d=3',
      '-itsoffset', String(origin + audioDelay), '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${3 - audioDelay}`,
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-c:a', codec, source]);
    const authority = new FileAuthority({ internalDirectories: [cache] }); authority.grantTrustedFile(source, { read: true });
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => directory });
    const options = { fileAuthority: authority, ffmpegExecution: execution, tempRoot: directory,
      cacheRoot: cache, allowSidecarCache: false, delay: async () => {} };
    const runtime = createMediaIntakeRuntime(options), probe = createMediaProbe({ executable: FFPROBE });
    try {
      const descriptor = await probe.describe(source);
      expect(descriptor.duration).toBeCloseTo(3, codec === 'aac' ? 1 : 2);
      const request = { src: source, duration: descriptor.duration, needsProxy: true, audio: descriptor.audio };
      const work = await runtime[mode](request); await work.completion;
      const result = work.response || work;
      const waveform = pcm(result.wave), channel = pcm(result.channels[0].file);
      if (audioDelay) {
        expect(energy(waveform, 0.1, 0.8)).toBeLessThan(0.0001);
        expect(energy(channel, 0.1, 0.8)).toBeLessThan(0.0002);
      } else {
        expect(energy(waveform, 0.001, 0.012, 440)).toBeGreaterThan(0.075);
        expect(energy(channel, 0.001, 0.012, 440)).toBeGreaterThan(0.075);
      }
      expect(energy(waveform, 1.1, 1.8, 440)).toBeGreaterThan(0.08);
      expect(energy(channel, 1.1, 1.8, 440)).toBeGreaterThan(0.08);
      expect(waveform.length / 4 / 4000).toBeCloseTo(3, codec === 'aac' ? 1 : 2);
      const proxy = await probe.describe(result.proxy);
      expect(proxy.duration).toBeCloseTo(3, 2);
      const reopened = createMediaIntakeRuntime(options);
      try { expect(await reopened.ingest(request)).toEqual({ cached: true,
        proxy: result.proxy, wave: result.wave, channels: result.channels }); }
      finally { await reopened.close(); }
      const oldKey = require('../electron/mother-source-evidence.js').motherSourceFingerprintSync(source, { namespace: 'source-v2', digestLength: 16 });
      expect(cacheKeyFor(source)).not.toBe(oldKey);
    } finally { await runtime.close(); await execution.cancelAllAndWait(); await probe.cancelAllAndWait(); }
  }, 30000);

  it('不同 stream 的開聲時間各自保留，負 lead 裁去來源第零秒以前的聲音', async () => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-intake-source-clock-')); roots.push(directory);
    const source = path.join(directory, 'staggered.mkv'), cache = path.join(directory, 'cache');
    run(['-y', '-itsoffset', '0.5', '-f', 'lavfi', '-i', 'color=red:s=64x48:r=30:d=2',
      '-f', 'lavfi', '-i', "aevalsrc=if(lt(t\\,1)\\,0.12*sin(2*PI*440*t)\\,0.12*sin(2*PI*880*t)):s=48000:d=2.5",
      '-itsoffset', '1.5', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=1',
      '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0', '-c:v', 'libx264', '-c:a', 'pcm_s16le', source]);
    const authority = new FileAuthority({ internalDirectories: [cache] }); authority.grantTrustedFile(source, { read: true });
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => directory });
    const runtime = createMediaIntakeRuntime({ fileAuthority: authority, ffmpegExecution: execution,
      tempRoot: directory, cacheRoot: cache, allowSidecarCache: false, delay: async () => {} });
    const probe = createMediaProbe({ executable: FFPROBE });
    try {
      const descriptor = await probe.describe(source);
      expect(descriptor.duration).toBeCloseTo(2, 2);
      const result = await runtime.ingest({ src: source, duration: descriptor.duration, needsProxy: true, audio: descriptor.audio });
      const first = pcm(result.channels[0].file), second = pcm(result.channels[1].file), wave = pcm(result.wave);
      expect(energy(first, 0.6, 0.9, 880)).toBeGreaterThan(0.08);
      expect(energy(first, 0.6, 0.9, 440)).toBeLessThan(0.002);
      expect(energy(second, 0.1, 0.8)).toBeLessThan(0.0002);
      expect(energy(second, 1.1, 1.8, 660)).toBeGreaterThan(0.08);
      expect(energy(wave, 0.6, 0.9, 880)).toBeGreaterThan(0.08);
      expect((await probe.describe(result.proxy)).duration).toBeCloseTo(2, 2);
    } finally { await runtime.close(); await execution.cancelAllAndWait(); await probe.cancelAllAndWait(); }
  }, 30000);
});
