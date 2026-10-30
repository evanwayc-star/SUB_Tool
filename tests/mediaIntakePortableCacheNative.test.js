// @subtool-ci windows
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
import { nativeTestTools } from './fixtures/native-tools.cjs';

const require = createRequire(import.meta.url);
const { FileAuthority } = require('../electron/file-authority.js');
const { createMediaIntakeRuntime, cacheKeyFor } = require('../electron/media-intake-runtime.js');
const { createMediaProbe } = require('../electron/media-probe.js');
const { createFFmpegExecution } = require('../electron/ffmpeg-execution-engine.js');
const { ffmpeg, ffprobe } = nativeTestTools();

function run(args) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], {
    windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024,
  });
  expect(result.error || result.status, result.stderr?.toString()).toBe(0);
  return result.stdout;
}

it.skipIf(!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe))('真 Proxy 與聲道搬到另一電腦位置後沿用原 bytes，不再執行 FFmpeg，像素與 PCM 內容相同', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-portable-intake-native-'));
  const firstMedia = path.join(root, 'computer-A', 'media'), secondMedia = path.join(root, 'computer-B', 'different-drive');
  fs.mkdirSync(firstMedia, { recursive: true });
  const source = path.join(firstMedia, 'red-tone.mkv');
  const probe = createMediaProbe({ executable: ffprobe });
  const execution = createFFmpegExecution({ getFFmpegPath: () => ffmpeg, getUserDataDir: () => root });
  const runtimes = [];
  try {
    run(['-y', '-f', 'lavfi', '-i', 'color=red:s=64x48:r=10:d=0.5',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=0.5',
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-bf', '0', '-c:a', 'pcm_s16le', source]);
    const info = await probe.describe(source);
    const firstCache = path.join(root, 'profile-A', 'mediacache');
    const first = createMediaIntakeRuntime({
      cacheRoot: firstCache, tempRoot: root, delay: async () => {},
      fileAuthority: new FileAuthority({ internalDirectories: [firstCache] }),
      ffmpegExecution: execution, describeVideo: async file => (await probe.describe(file)).video,
    });
    runtimes.push(first);
    const saved = await first.ingest({ src: source, duration: 0.5, needsProxy: true, audio: info.audio });
    expect(saved.cached).toBe(false);
    expect(saved.channels).toHaveLength(1);
    const originalProxy = fs.readFileSync(saved.proxy), originalChannel = fs.readFileSync(saved.channels[0].file);
    const pixel = run(['-i', saved.proxy, '-vf', 'scale=1:1', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
    expect(pixel[0]).toBeGreaterThan(240); expect(pixel[1]).toBeLessThan(30); expect(pixel[2]).toBeLessThan(30);
    const originalPcm = run(['-i', saved.channels[0].file, '-ar', '4000', '-ac', '1', '-f', 'f32le', 'pipe:1']);
    expect(originalPcm.length / 4).toBeGreaterThanOrEqual(1600);
    let energy = 0;
    for (let sample = 200; sample < 1600; sample++) energy += originalPcm.readFloatLE(sample * 4) ** 2;
    expect(Math.sqrt(energy / 1400)).toBeGreaterThan(0.05);
    expect(Math.sqrt(energy / 1400)).toBeLessThan(0.15);
    fs.cpSync(firstMedia, secondMedia, { recursive: true });
    const copiedSource = path.join(secondMedia, path.basename(source));
    fs.utimesSync(copiedSource, new Date('2026-01-01'), new Date('2026-01-01'));
    expect(cacheKeyFor(copiedSource)).not.toBe(cacheKeyFor(source));
    const secondCache = path.join(root, 'profile-B', 'mediacache');
    const execute = vi.fn(async () => { throw new Error('另一電腦不應重新計算已有 Proxy'); });
    const secondProbe = vi.fn(async file => (await probe.describe(file)).video);
    const second = createMediaIntakeRuntime({ cacheRoot: secondCache, tempRoot: root, delay: async () => {},
      fileAuthority: new FileAuthority({ internalDirectories: [secondCache] }),
      ffmpegExecution: { execute }, describeVideo: secondProbe });
    runtimes.push(second);
    const reused = await second.ingest({ src: copiedSource, duration: 0.5, needsProxy: true, audio: info.audio });
    expect(reused.cached).toBe(true);
    expect(reused.proxy).toBe(path.join(secondMedia, path.relative(firstMedia, saved.proxy)));
    expect(fs.readFileSync(reused.proxy)).toEqual(originalProxy);
    expect(fs.readFileSync(reused.channels[0].file)).toEqual(originalChannel);
    expect(execute).not.toHaveBeenCalled(); expect(secondProbe).not.toHaveBeenCalled();
    expect(run(['-i', reused.proxy, '-vf', 'scale=1:1', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])).toEqual(pixel);
    expect(run(['-i', reused.channels[0].file, '-ar', '4000', '-ac', '1', '-f', 'f32le', 'pipe:1'])).toEqual(originalPcm);
  } finally {
    await Promise.all(runtimes.map(runtime => runtime.close()));
    await execution.cancelAllAndWait(); await probe.cancelAllAndWait();
    const resolved = fs.realpathSync(root);
    if (path.dirname(resolved) !== fs.realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-portable-intake-native-')) {
      throw new Error('拒絕清除未核對的可攜原生快取測試目錄');
    }
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 30000);
