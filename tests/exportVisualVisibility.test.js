// @subtool-ci windows
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDeliveryArgv } from '../electron/export-plan.js';

const FFMPEG = process.env.FFMPEG_PATH || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../electron/ffmpeg/ffmpeg.exe');
const nativeIt = existsSync(FFMPEG) ? it : it.skip;
const roots = [];

function ffmpeg(args) {
  const result = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], {
    windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024,
  });
  expect(result.error || result.status, result.stderr?.toString()).toBe(0);
  return result.stdout;
}

function fixture() {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'subtool-export-visible-'));
  roots.push(directory);
  const red = path.join(directory, 'red.mov');
  const blue = path.join(directory, 'blue.mov');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=25:d=0.4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.4',
    '-c:v', 'prores_ks', '-c:a', 'pcm_s16le', red]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=25:d=0.4', '-c:v', 'prores_ks', '-an', blue]);
  const clip = (file, vtrack, extra = {}) => ({ path: file, type: 'video', vtrack,
    in: 0, out: 0.4, offset: 0, natW: 160, natH: 90, ...extra });
  function render(clips, videoTracks) {
    const outPath = path.join(directory, 'delivery.mov');
    const plan = buildDeliveryArgv({ format: 'prores', outPath, width: 160, height: 90,
      fps: 25, duration: 0.4, clips, videoTracks }, {
      hasAudioStream: file => file === red,
      proresArgs: () => ['-c:v', 'prores_ks', '-c:a', 'pcm_s24le'],
    });
    ffmpeg(plan.args);
    const pixels = ffmpeg(['-i', outPath, '-map', '0:v:0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    const samples = ffmpeg(['-i', outPath, '-map', '0:a:0', '-ac', '1', '-f', 'f32le', '-c:a', 'pcm_f32le', 'pipe:1']);
    let energy = 0;
    for (let i = 0; i < samples.length; i += 4) energy += samples.readFloatLE(i) ** 2;
    expect(Math.sqrt(energy / (samples.length / 4))).toBeGreaterThan(0.05);
    return (x, y) => [...pixels.subarray((y * 160 + x) * 3, (y * 160 + x) * 3 + 3)];
  }
  return { red, blue, clip, render };
}

afterEach(() => {
  const temp = realpathSync(tmpdir());
  for (const directory of roots.splice(0)) {
    const resolved = realpathSync(directory);
    if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith('subtool-export-visible-')) {
      throw new Error('拒絕清除未驗證的測試路徑');
    }
    rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('真實交付的視訊可見性與片段幾何', () => {
  nativeIt.each([
    ['隱藏頂層露出下層', [{ vt: 0 }, { vt: 1, visible: false }], 'red'],
    ['全部隱藏輸出黑底', [{ vt: 0, visible: false }, { vt: 1, visible: false }], 'black'],
    ['舊工作未指定 visible 仍可見', [{ vt: 0 }, { vt: 1 }], 'blue'],
  ])('%s 並保留隱藏軌的母素材音訊', (label, tracks, color) => {
    const { red, blue, clip, render } = fixture();
    const pixel = render([clip(red, 0), clip(blue, 1)], tracks)(80, 45);
    if (color === 'black') expect(pixel.every(channel => channel < 20)).toBe(true);
    else {
      expect(pixel[color === 'red' ? 0 : 2]).toBeGreaterThan(200);
      expect(pixel[color === 'red' ? 2 : 0]).toBeLessThan(50);
    }
  });

  nativeIt('影片逐片段縮小位移會出現在實際畫格，外側保留黑底', () => {
    const { red, clip, render } = fixture();
    const pixel = render([clip(red, 0, { scale: 0.5, posX: 0.25, posY: 0.5 })], [{ vt: 0 }]);
    expect(pixel(20, 45)[0]).toBeGreaterThan(200);
    expect(pixel(20, 45)[2]).toBeLessThan(50);
    expect(pixel(120, 45).every(channel => channel < 20)).toBe(true);
  });
});
