// @subtool-ci windows
import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildDeliveryArgv } from '../electron/export-plan.js';
import { nativeTestTools } from './fixtures/native-tools.cjs';

const { ffmpeg, ffprobe } = nativeTestTools();
const fsHz = 48000;
const frequencies = [240, 360, 480, 60, 720, 840]; // L, R, C, LFE, Ls, Rs
const ids = frequencies.map((_, i) => 'bus-' + i);

function amplitude(bytes, channels, channel, Hz) {
  let re = 0, im = 0;
  const n = fsHz / 2;
  for (let i = 0; i < n; i++) {
    const sample = bytes.readFloatLE(((i + fsHz / 4) * channels + channel) * 4);
    const phase = 2 * Math.PI * Hz * i / fsHz;
    re += sample * Math.cos(phase);
    im += sample * Math.sin(phase);
  }
  return 2 * Math.hypot(re, im) / n;
}

it.skipIf(!existsSync(ffmpeg) || !existsSync(ffprobe))('MP3 解碼保留 Mono、左右編組及 5.1 各聲道的方向與電平', () => {
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'subtool-mp3-delivery-'));
  const options = { windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024 };
  try {
    const source = path.join(dir, 'tones.wav');
    const tones = frequencies.map(f => `0.15*sin(2*PI*${f}*t)`).join('|');
    execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `aevalsrc=${tones}:s=48000:d=1:c=5.1`,
      '-metadata', 'title=original mother title', '-c:a', 'pcm_s24le', source], options);
    const buses = ids.map((id, sourceChannel) => ({ id, inputs: [{ file: source, sourceStream: 0, sourceChannel, trimEnd: 1 }] }));
    const sum = 1 + 0.707 + 0.707 + 0.5;
    for (const [streams, gains] of [
      [[{ layout: 'mono', busIds: [ids[2]] }], [[0, 0, 1, 0, 0, 0]]],
      [[{ layout: 'mono', busIds: [ids[5]] }, { layout: 'mono', busIds: [ids[3]] }], [[0, 0, 0, 0, 0, 1], [0, 0, 0, 1, 0, 0]]],
      [[{ layout: '5.1', busIds: ids }], [[1, 0, .707, .5, .707, 0], [0, 1, .707, .5, 0, .707]].map(side => side.map(gain => gain / sum))],
    ]) {
      const outPath = path.join(dir, 'output.mp3');
      const plan = buildDeliveryArgv({ format: 'mp3', audioPlan: { buses, streams }, duration: 1, outPath });
      execFileSync(ffmpeg, ['-nostdin', '-v', 'error', ...plan.args], options);
      const meta = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_chapters', '-show_format', '-of', 'json', outPath], options));
      expect(meta.streams).toHaveLength(1);
      expect(meta.streams[0]).toMatchObject({ codec_name: 'mp3', codec_type: 'audio', sample_rate: '48000', bit_rate: '320000', channels: gains.length });
      expect(meta.chapters).toEqual([]);
      expect(meta.format.tags?.title).toBeUndefined();
      const samples = execFileSync(ffmpeg, ['-v', 'error', '-i', outPath, '-map', '0:a:0', '-f', 'f32le', 'pipe:1'], options);
      expect(samples.length).toBe(fsHz * gains.length * 4);
      gains.forEach((weights, side) => weights.forEach((gain, i) => {
        expect(amplitude(samples, gains.length, side, frequencies[i]), `聲道 ${side + 1} 的 ${frequencies[i]} Hz`).toBeCloseTo(0.15 * gain, 2);
      }));
    }
  } finally {
    const resolved = realpathSync(dir);
    if (path.dirname(resolved) !== realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-mp3-delivery-')) throw new Error('MP3 測試目錄不符');
    rmSync(resolved, { recursive: true, force: true });
  }
});
