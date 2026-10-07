// @subtool-ci windows
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExportSnapshot } from '../src/delivery-job.js';

const { buildDeliveryArgv } = createRequire(import.meta.url)('../electron/export-plan.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = path.join(ROOT, 'electron', 'ffmpeg', 'ffmpeg.exe');
const FFPROBE = path.join(ROOT, 'electron', 'ffmpeg', 'ffprobe.exe');
const fixedRedFrame = 29 / 30;

function plan(clips, outPath = 'C:/output.mp4', duration = 2) {
  return buildDeliveryArgv({ format: 'mp4', width: 64, height: 64, fps: 30,
    videoKbps: 800, clips, videoTracks: [{ vt: 0 }], duration, audioPlan: null, outPath },
  { hasAudioStream: () => true });
}

function clip(file, extra = {}) {
  return { path: file, type: 'video', name: 'source.mp4', in: 0, out: 2,
    offset: 0, vtrack: 0, fps: 30, natW: 64, natH: 64, ...extra };
}

describe('固定畫面的交付快照', () => {
  it('裁切範圍只改片段長度，固定來源秒數不被改動或捨入到下一格', () => {
    const state = { clips: [clip('C:/mother.mp4', { freezeTime: fixedRedFrame,
      freezeWeb: { url: 'subtool-local://preview-cache.png' } })],
    videoTracks: [{ visible: true }], exportIn: 1.5, exportOut: 1.9 };
    const snapshot = buildExportSnapshot({ state, sequenceEnd: 2 });
    expect(snapshot.clips[0]).toMatchObject({ path: 'C:/mother.mp4', type: 'video',
      in: 1.5, out: 1.9, offset: 0, freezeTime: fixedRedFrame, audio: [] });
    expect(snapshot.clips[0]).not.toHaveProperty('freezeWeb');
    expect(snapshot.duration).toBeCloseTo(0.4, 8);
  });

  it('後備音訊匯出不讀固定片段原音，合法的來源第零格也會固定', () => {
    const delivery = plan([clip('C:/mother.mp4', { freezeTime: 0 })]);
    const graph = delivery.args[delivery.args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('trim=end_frame=1');
    expect(graph).toContain('tpad=stop_mode=clone:stop_duration=2.000000');
    expect(graph).toContain('anullsrc=');
    expect(graph).not.toContain('[0:a]');
  });
});

describe.skipIf(!existsSync(FFMPEG) || !existsSync(FFPROBE))('固定畫面實際交付影格', () => {
  let directory, source;
  let outputSeq = 0;
  const execute = (binary, args) => {
    const result = spawnSync(binary, args, { windowsHide: true, timeout: 30000,
      maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || String(result.stderr));
    return result.stdout;
  };
  const ffmpeg = args => execute(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args]);

  beforeAll(() => {
    directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'subtool-fixed-frame-'));
    source = path.join(directory, 'source.mp4');
    ffmpeg(['-y', '-f', 'lavfi', '-i',
      "color=c=red:s=64x64:r=30:d=3,drawbox=c=blue:t=fill:enable='gte(t,1)'",
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
  });

  afterAll(() => {
    if (!directory) return;
    const resolved = realpathSync(directory);
    if (path.dirname(resolved) !== realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-fixed-frame-')) {
      throw new Error('拒絕清除未驗證的固定畫面測試目錄');
    }
    rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function render(clips, duration) {
    const output = path.join(directory, `delivery-${outputSeq++}.mp4`);
    ffmpeg(plan(clips, output, duration).args);
    const metadata = JSON.parse(execute(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
      '-count_frames', '-show_entries', 'stream=duration,nb_read_frames', '-of', 'json', output]));
    const pixels = ffmpeg(['-i', output, '-map', '0:v:0', '-vf', 'scale=1:1',
      '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
    const samples = ffmpeg(['-i', output, '-map', '0:a:0', '-ac', '1',
      '-f', 'f32le', '-c:a', 'pcm_f32le', '-']);
    let energy = 0;
    for (let i = 0; i < samples.length; i += 4) energy += samples.readFloatLE(i) ** 2;
    return { metadata: metadata.streams[0], pixels, audioRms: Math.sqrt(energy / (samples.length / 4)) };
  }

  function expectFrames(result, color, duration) {
    expect(Number(result.metadata.duration)).toBeCloseTo(duration, 5);
    expect(Number(result.metadata.nb_read_frames)).toBe(Math.round(duration * 30));
    expect(result.pixels.length).toBe(Math.round(duration * 30) * 3);
    for (let i = 0; i < result.pixels.length; i += 3) {
      const expected = color === 'red' ? 0 : 2, opposite = color === 'red' ? 2 : 0;
      expect(result.pixels[i + expected], `frame ${i / 3}`).toBeGreaterThan(200);
      expect(result.pixels[i + opposite], `frame ${i / 3}`).toBeLessThan(50);
    }
  }

  it('固定切點前一個紅色來源幀，speed與reverse不使畫面前進，長度維持原片段', () => {
    const result = render([clip(source, { freezeTime: fixedRedFrame, speed: 2, reverse: true })], 1);
    expectFrames(result, 'red', 1);
    expect(result.audioRms).toBeLessThan(0.00001);
  });

  it('固定藍色來源幀，在整段首、中、尾及全部影格都維持藍色', () => {
    const result = render([clip(source, { freezeTime: 1.2 })], 2);
    expectFrames(result, 'blue', 2);
    expect(result.audioRms).toBeLessThan(0.00001);
  });

  it('匯出範圍的in已晚於固定幀，仍讀原紅色母素材幀並輸出完整裁切長度', () => {
    const snapshot = buildExportSnapshot({ state: { clips: [clip(source, { freezeTime: fixedRedFrame })],
      videoTracks: [{ visible: true }], exportIn: 1.5, exportOut: 1.9 }, sequenceEnd: 2 });
    expect(snapshot.clips[0].in).toBeGreaterThan(snapshot.clips[0].freezeTime);
    expectFrames(render(snapshot.clips, snapshot.duration), 'red', 0.4);
  });

  it('同一母素材同時匯出一般藍色片段與固定紅色片段，輸入共用仍讀取正確幀', () => {
    const result = render([clip(source, { in: 1, out: 1.5 }),
      clip(source, { out: 1, offset: 0.5, freezeTime: fixedRedFrame })], 1.5);
    expect(Number(result.metadata.nb_read_frames)).toBe(45);
    for (let frame = 0; frame < 45; frame++) {
      const pixel = result.pixels.subarray(frame * 3, frame * 3 + 3);
      expect(pixel[frame < 15 ? 2 : 0], `frame ${frame}`).toBeGreaterThan(200);
      expect(pixel[frame < 15 ? 0 : 2], `frame ${frame}`).toBeLessThan(50);
    }
  });
});
