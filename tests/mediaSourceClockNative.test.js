// @subtool-ci windows
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { buildExportSnapshot } from '../src/delivery-job.js';
import { nativeTestTools } from './fixtures/native-tools.cjs';

const require = createRequire(import.meta.url);
const { createMediaProbe } = require('../electron/media-probe.js');
const { createFFmpegExecution } = require('../electron/ffmpeg-execution-engine.js');
const { createClipFrameCache } = require('../electron/clip-frame-cache.js');
const { createClipAudioCache } = require('../electron/clip-audio-cache.js');
const { createVocalWaveformRuntime } = require('../electron/vocal-waveform-runtime.js');
const { createDeliveryRunner } = require('../electron/delivery-runner.js');
const { FileAuthority } = require('../electron/file-authority.js');
const P = require('../electron/export-plan.js');
const { ffmpeg: FFMPEG, ffprobe: FFPROBE } = nativeTestTools();

function amplitude(bytes, sampleRate, channels, frequency) {
  const first = Math.round(.02 * sampleRate), last = Math.round(.18 * sampleRate);
  expect(bytes.length / 4 / channels).toBeGreaterThanOrEqual(last);
  let sine = 0, cosine = 0;
  for (let index = first; index < last; index++) {
    const sample = bytes.readFloatLE(index * channels * 4), phase = 2 * Math.PI * frequency * index / sampleRate;
    sine += sample * Math.sin(phase); cosine += sample * Math.cos(phase);
  }
  return 2 * Math.hypot(sine, cosine) / (last - first);
}
function expect880(bytes, sampleRate = 4000, channels = 1) {
  expect(amplitude(bytes, sampleRate, channels, 880)).toBeGreaterThan(.075);
  expect(amplitude(bytes, sampleRate, channels, 440)).toBeLessThan(.004);
}
function expectBlue(bytes) {
  expect(bytes[0]).toBeLessThan(8); expect(bytes[1]).toBeLessThan(8); expect(bytes[2]).toBeGreaterThan(246);
}
function cleanup(directory, prefix) {
  const resolved = fs.realpathSync(directory);
  if (path.dirname(resolved) !== fs.realpathSync(tmpdir()) || !path.basename(resolved).startsWith(prefix)) throw new Error('拒絕清除未核對的 native 時鐘測試目錄');
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

describe.skipIf(!fs.existsSync(FFMPEG) || !fs.existsSync(FFPROBE))('母素材影片／容器不同原點的 public native 內容', () => {
  it.each([0, 5])('容器起点 %s：探測→截格／PCM 預覽／真交付 runner 使用影片來源秒數', async origin => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-source-clock-native-'));
    const run = args => {
      const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], { cwd: directory,
        windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
      expect(result.error || result.status, result.stderr?.toString()).toBe(0);
      return result.stdout;
    };
    const source = path.join(directory, 'mother.mkv'), cacheRoot = path.join(directory, 'cache');
    const authority = new FileAuthority({ internalDirectories: [cacheRoot] });
    const probe = createMediaProbe({ executable: FFPROBE });
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => directory });
    const describeSource = (file, options) => probe.describe(file, options);
    const frameCache = createClipFrameCache({ cacheRoot: path.join(cacheRoot, 'frame'), fileAuthority: authority,
      probe: describeSource, execute: (args, options) => execution.execute(args, options) });
    const reverseCache = createClipAudioCache({ cacheRoot: path.join(cacheRoot, 'reverse'), fileAuthority: authority,
      probe: describeSource, execute: (args, options) => execution.execute(args, options) });
    const vocal = createVocalWaveformRuntime({ getFFmpegPath: () => FFMPEG, probe: describeSource });
    try {
      run(['-y', '-itsoffset', String(origin + .5), '-f', 'lavfi', '-i',
        "color=red:s=64x48:r=30:d=3,drawbox=c=blue:t=fill:enable='gte(n,75)'",
        '-itsoffset', String(origin), '-f', 'lavfi', '-i',
        'aevalsrc=if(lt(t\\,1)\\,0.12*sin(2*PI*440*t)\\,0.12*sin(2*PI*880*t)):s=48000:d=3.5',
        '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-fps_mode:v', 'passthrough', '-c:a', 'pcm_s16le', source]);
      authority.grantTrustedFile(source, { read: true });
      const descriptor = await probe.describe(source);
      expect(descriptor.duration).toBe(3); expect(descriptor.video.timestampOffset).toBe(-.5);
      const sender = new EventEmitter(); sender.isDestroyed = () => false;
      const chunk = await vocal.readChunk(sender, { path: source, start: .6, duration: .2, requestId: 'origin' });
      expect880(Buffer.from(chunk.samples), chunk.sampleRate, chunk.channels);
      const reverse = await reverseCache.reverse({ path: source, in: .6, out: .8 });
      expect880(run(['-i', reverse.path, '-ar', '4000', '-ac', '1', '-f', 'f32le', 'pipe:1']));
      const frame = await frameCache.frame({ path: source, time: 2.8, fps: 30 });
      expectBlue(run(['-i', frame.path, '-vf', 'scale=1:1', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']));
      const progress = [];
      const runner = createDeliveryRunner({ queue: { assertJobCapabilities() {}, registerActiveJob() {}, clearActiveJob() {},
        reportProgress: (_, data) => { progress.push(data); return true; } }, queueDir: () => directory, tempDir: directory,
      mediaProbe: () => probe, encoder: { bitrateArgs: () => ['-c:v', 'libx264'] },
      nativeCapabilities: { assertReady: async () => {} },
      runFfmpeg: async args => { run(args); return { maps: [] }; } });
      for (const mode of ['whole', 'trimmed', 'reverse', 'fixed']) {
        const start = mode === 'whole' ? 0 : 2.5, duration = 3 - start, output = path.join(directory, `${mode}.mp4`);
        const snapshot = buildExportSnapshot({ state: { fps: 24, videoTracks: [{}], clips: [{ path: source, type: 'video',
          in: start, out: 3, offset: 0, fps: 30, vtrack: 0, natW: 64, natH: 48,
          reverse: mode === 'reverse', ...(mode === 'fixed' ? { freezeTime: .2 } : {}) }] }, sequenceEnd: duration });
        await runner.run({ id: mode, payload: { ...snapshot, format: 'h264', fps: 30, width: 64, height: 48, outPath: output,
          audioPlan: { buses: [{ id: 'a1', inputs: [{ file: source, sourceStream: 0, sourceChannel: 0, offset: 0,
            trimStart: .6, trimEnd: .8, volume: 1, reverse: mode === 'reverse' }] }],
          streams: [{ id: 's1', layout: 'mono', busIds: ['a1'] }] } } });
        expect(progress.at(-1), `${mode}: public runner 終態`).toMatchObject({ done: true });
        const pixels = run(['-i', output, '-map', '0:v:0', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
        expect(pixels.length / 3).toBe(Math.ceil(duration * 30 - 1e-6));
        const blueStart = mode === 'whole' ? 75 : 0;
        for (let index = blueStart; index < pixels.length / 3; index++) {
          if (mode === 'fixed') {
            expect(pixels[index * 3]).toBeGreaterThan(246); expect(pixels[index * 3 + 1]).toBeLessThan(8); expect(pixels[index * 3 + 2]).toBeLessThan(8);
          } else expectBlue(pixels.subarray(index * 3, index * 3 + 3));
        }
        expect880(run(['-i', output, '-map', '0:a:0', '-ar', '4000', '-ac', '1', '-f', 'f32le', 'pipe:1']));
      }
    } finally {
      await vocal.cancelAllAndWait(); await reverseCache.waitForIdle(); await execution.cancelAllAndWait(); await probe.cancelAllAndWait();
      cleanup(directory, 'subtool-source-clock-native-');
    }
  }, 30000);

  it.each([{ format: 'mod-fhd', fps: 30000 / 1001 }, { format: 'dvd-iso', fps: 30000 / 1001 }, { format: 'bd-iso', fps: 25 }])
  ('$format：24fps 五格的半開尾端保留最後一場與 TFF', ({ format, fps }) => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-interlace-tail-native-'));
    const run = args => {
      const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], { cwd: directory,
        windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
      expect(result.error || result.status, result.stderr?.toString()).toBe(0); return result.stdout;
    };
    try {
      const source = path.join(directory, 'red.mov'), output = path.join(directory, 'output.ts'), duration = 5 / 24;
      run(['-y', '-f', 'lavfi', '-i', 'color=red:s=64x48:r=30:d=1', '-an', '-c:v', 'libx264', source]);
      const snapshot = buildExportSnapshot({ state: { fps: 24, videoTracks: [{}], clips: [{ path: source, type: 'video',
        in: 0, out: duration, offset: 0, fps: 30, vtrack: 0 }] }, sequenceEnd: duration });
      const plan = P.buildDeliveryArgv({ ...snapshot, format, fps: format === 'mod-fhd' ? 24 : fps, width: 64, height: 48, outPath: output },
        { hasAudioStream: () => false });
      run(plan.args);
      const metadata = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries',
        'stream=nb_read_frames,field_order', '-of', 'json', output], { windowsHide: true, timeout: 10000 });
      expect(metadata.status, metadata.stderr?.toString()).toBe(0);
      const stream = JSON.parse(metadata.stdout).streams[0];
      expect(Number(stream.nb_read_frames)).toBe(Math.ceil(duration * fps - 1e-6)); expect(stream.field_order).toBe('tt');
      const pixels = run(['-i', output, '-map', '0:v:0', '-vf', 'crop=8:8,scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
      expect(pixels.length / 3).toBe(Number(stream.nb_read_frames));
      for (let index = 0; index < pixels.length / 3; index++) {
        expect(pixels[index * 3]).toBeGreaterThan(246); expect(pixels[index * 3 + 1]).toBeLessThan(8); expect(pixels[index * 3 + 2]).toBeLessThan(8);
      }
    } finally { cleanup(directory, 'subtool-interlace-tail-native-'); }
  }, 30000);
});
