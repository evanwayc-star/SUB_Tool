// @subtool-ci windows
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildDeliveryArgv } from '../electron/export-plan.js';
import { airlineEncoding } from '../electron/airline-encoding.js';
import { finalizeAirlineOutput } from '../electron/airline-output.js';
import { nativeTestTools } from './fixtures/native-tools.cjs';

const { ffmpeg, ffprobe } = nativeTestTools();
const duration = 132, rate = 48000;
function run(args, binary = ffmpeg) {
  const result = spawnSync(binary, args, { windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr.toString());
  return result.stdout;
}
const timestamp = (bytes, at) => (bytes[at] & 14) * 536870912 + bytes[at + 1] * 4194304
  + (bytes[at + 2] & 254) * 16384 + bytes[at + 3] * 128 + (bytes[at + 4] >> 1);

// Independent TS/ADTS inspection: derive the clock from the encoded sample
// count, not FFmpeg's packet duration or the scheduler's implementation.
function audioSamples(file) {
  const bytes = readFileSync(file), packets = [];
  for (let at = 0; at < bytes.length; at += 188) {
    const packet = bytes.subarray(at, at + 188), pid = ((packet[1] & 31) << 8) | packet[2];
    if (pid !== 49 || !(packet[3] & 16)) continue;
    const payload = 4 + (packet[3] & 32 ? packet[4] + 1 : 0);
    if (packet[1] & 64) packets.push({ pts: timestamp(packet, payload + 9),
      parts: [packet.subarray(payload + 9 + packet[payload + 8])] });
    else packets.at(-1).parts.push(packet.subarray(payload));
  }
  let samples = 0;
  const errors = [], elementary = [];
  for (const [index, packet] of packets.entries()) {
    const bytes = Buffer.concat(packet.parts), expected = packets[0].pts + samples * 90000 / rate;
    if (packet.pts !== expected) errors.push({ index, pts: packet.pts, expected, error: packet.pts - expected });
    for (let at = 0; at < bytes.length;) {
      expect(bytes[at]).toBe(255); expect(bytes[at + 1] & 0xf6).toBe(0xf0);
      expect((bytes[at + 2] >> 2) & 15).toBe(3); // 48 kHz
      const length = ((bytes[at + 3] & 3) << 11) | (bytes[at + 4] << 3) | (bytes[at + 5] >> 5);
      expect(length).toBeGreaterThanOrEqual(7); expect(at + length).toBeLessThanOrEqual(bytes.length);
      samples += 1024 * ((bytes[at + 6] & 3) + 1); at += length;
    }
    elementary.push(bytes);
  }
  return { errors, samples, packets: packets.length, elementary: Buffer.concat(elementary) };
}

describe.skipIf(!existsSync(ffmpeg) || !existsSync(ffprobe))('航空音訊交付的整數樣本時鐘', () => {
  let directory, source, reference;
  beforeAll(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'subtool-airline-audio-clock-'));
    source = path.join(directory, 'source.avi'); reference = path.join(directory, 'reference.aac');
    run(['-hide_banner', '-loglevel', 'error', '-cpucount', '2', '-f', 'lavfi', '-i',
      `color=black:size=16x16:rate=30000/1001:duration=${duration}`, '-f', 'lavfi', '-i',
      `aevalsrc=0.15*sin(2*PI*997*t)|0.11*sin(2*PI*523*t):s=${rate}:d=${duration}`,
      '-map', '0:v', '-map', '1:a', '-c:v', 'rawvideo', '-pix_fmt', 'yuv420p', '-threads:v', '1', '-c:a', 'pcm_s16le', source]);
    run(['-hide_banner', '-loglevel', 'error', '-cpucount', '2', '-i', source, '-map', '0:a:0',
      ...airlineEncoding('airline-dmpes').audioArgs, '-threads', '1', '-f', 'adts', reference]);
  });
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  it.each(['audioPlan', 'legacy'])('%s 真交付在 64/128/131 秒仍逐 AAC frame 保持 1920 ticks，PCM 不變', async route => {
    const output = path.join(directory, `${route}.mpg`);
    const audioPlan = route === 'audioPlan' ? {
      buses: ['left', 'right'].map((id, sourceChannel) => ({ id, inputs: [{ file: source,
        sourceStream: 0, sourceChannel, trimStart: 0, trimEnd: duration, offset: 0 }] })),
      streams: [{ layout: 'stereo', busIds: ['left', 'right'] }],
    } : undefined;
    const plan = buildDeliveryArgv({ format: 'airline-dmpes', clips: [{ type: 'video', path: source,
      in: 0, out: duration, offset: 0, vtrack: 0, natW: 16, natH: 16, fps: 30000 / 1001 }],
    videoTracks: [{ vt: 0 }], width: 16, height: 16, fps: 30000 / 1001, duration, audioPlan, outPath: output });
    run(['-hide_banner', '-loglevel', 'error', '-cpucount', '2', '-filter_complex_threads', '1',
      ...plan.args.slice(0, -1), '-threads:v', '1', output]);
    const encoded = audioSamples(output);
    // The actual user's TSA6 report identifies these exact AAC frame indices.
    expect(encoded.errors).toEqual([]);
    expect(encoded.packets).toBeGreaterThan(6127);
    expect(encoded.elementary.equals(readFileSync(reference)), '編碼後 AAC bytes 必須與相同 PCM 的直接編碼一致').toBe(true);
    await finalizeAirlineOutput('airline-dmpes', output);
    const completed = audioSamples(output);
    expect(completed.errors).toEqual([]);
    expect(completed.samples).toBe(encoded.samples);
    expect(completed.elementary.equals(encoded.elementary), '封裝不得改變 AAC 內容').toBe(true);
    const pcm = file => run(['-v', 'error', '-xerror', '-i', file, '-map', '0:a:0', '-c:a', 'pcm_s16le', '-f', 's16le', '-']);
    expect(pcm(output).equals(pcm(reference)), '完成品解碼 PCM 必須逐 sample 等於直接編碼參考').toBe(true);
    const metadata = JSON.parse(run(['-v', 'error', '-select_streams', 'a:0', '-show_streams', '-of', 'json', output], ffprobe));
    expect(metadata.streams[0]).toMatchObject({ codec_name: 'aac', profile: 'LC', channels: 2, sample_rate: '48000' });
  }, 60000);
});
