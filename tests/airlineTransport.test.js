// @subtool-ci windows
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { airlineEncoding, airlineMuxArgs } from '../electron/airline-encoding.js';
import { finalizeAirlineOutput } from '../electron/airline-output.js';
import { buildDeliveryArgv } from '../electron/export-plan.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.FFMPEG_PATH || path.join(ROOT, 'electron/ffmpeg/ffmpeg.exe');
const FFPROBE = process.env.FFPROBE_PATH || path.join(ROOT, 'electron/ffmpeg/ffprobe.exe');
const nativeAvailable = existsSync(FFMPEG) && existsSync(FFPROBE);
const FORMATS = ['airline-s3k', 'airline-dmpes', 'airline-dmpes-4m'];
const BAD_ENCODER_LOG = /error parsing option|buffer (?:underflow|overflow)|VBV underflow|dts < pcr|non.?monoton|timestamps are unset/i;

function run(binary, args, { binaryOutput = false } = {}) {
  const result = spawnSync(binary, args, {
    encoding: binaryOutput ? undefined : 'utf8', timeout: 60000,
    maxBuffer: 32 * 1024 * 1024, windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || String(result.stderr));
  return result;
}

function probe(file) {
  return JSON.parse(run(FFPROBE, ['-v', 'error', '-show_streams', '-show_frames',
    '-show_packets', '-of', 'json', file]).stdout);
}

// Independent MPEG-2 section CRC check, including the transmitted CRC bytes.
function sectionCrc(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc ^ (byte << 24)) >>> 0;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = ((crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0)) >>> 0;
    }
  }
  return crc;
}

function pesTimestamp(bytes, offset) {
  return (bytes[offset] & 14) * 536870912 + bytes[offset + 1] * 4194304
    + (bytes[offset + 2] & 254) * 16384 + bytes[offset + 3] * 128 + (bytes[offset + 4] >> 1);
}

function inspectTransport(bytes, format) {
  const muxRate = format === 'airline-dmpes-4m' ? 4600000 : 1855594;
  expect(bytes.length % 188).toBe(0);
  const pids = new Map();
  const tables = [];
  const pcr = [];
  const decodeTimestamps = new Map();
  let clockAnchor;
  let minimumDecodeLead = Infinity;
  let maximumVideoDecodeLead = -Infinity;
  for (let offset = 0; offset < bytes.length; offset += 188) {
    expect(bytes[offset]).toBe(0x47);
    expect(bytes[offset + 1] & 0x80).toBe(0); // transport error
    expect(bytes[offset + 3] & 0xc0).toBe(0); // scrambling
    const pid = ((bytes[offset + 1] & 31) << 8) | bytes[offset + 2];
    const start = Boolean(bytes[offset + 1] & 0x40);
    const priority = Boolean(bytes[offset + 1] & 0x20);
    const adaptation = (bytes[offset + 3] >> 4) & 3;
    const counter = bytes[offset + 3] & 15;
    const previous = pids.get(pid);
    if (previous && (adaptation & 1) && pid !== 8191) expect(counter).toBe((previous.counter + 1) & 15);
    pids.set(pid, { count: (previous?.count || 0) + 1, counter, priority });
    expect(priority).toBe([48, 49, 63].includes(pid));
    let payload = offset + 4;
    if (adaptation & 2) {
      const length = bytes[payload];
      expect(length).toBeLessThanOrEqual(183);
      const adaptationFlags = length ? bytes[payload + 1] : 0;
      const hasPcr = length >= 7 && !!(adaptationFlags & 0x10);
      if (pid === 48 && (adaptationFlags & 0x40)) {
        expect(hasPcr, 'random_access_indicator 必須與 PCR 位於同一個 TS 封包').toBe(true);
      }
      if (length && (bytes[payload + 1] & 0x10)) {
        expect(pid).toBe(48);
        const pos = payload + 2;
        const base = bytes[pos] * 33554432 + bytes[pos + 1] * 131072 + bytes[pos + 2] * 512
          + bytes[pos + 3] * 2 + (bytes[pos + 4] >> 7);
        const ticks = base * 300 + ((bytes[pos + 4] & 1) << 8) + bytes[pos + 5];
        pcr.push({ offset, ticks });
        clockAnchor = { offset: pos + 6, ticks };
      }
      payload += 1 + length;
    }
    if ((adaptation & 1) && [48, 49].includes(pid)) {
      if (start) {
        expect(bytes.subarray(payload, payload + 3)).toEqual(Buffer.from([0, 0, 1]));
        const flags = (bytes[payload + 7] >> 6) & 3;
        expect([2, 3]).toContain(flags);
        decodeTimestamps.set(pid, pesTimestamp(bytes, payload + (flags === 3 ? 14 : 9)));
      }
      if (clockAnchor && decodeTimestamps.has(pid)) {
        // Check arrival of the entire PES, including continuation packets. An
        // encoder can return 0 (or suppress the warning) after missing its DTS.
        const arrival = clockAnchor.ticks / 27000000
          + (offset + 188 - clockAnchor.offset) * 8 / muxRate;
        const lead = decodeTimestamps.get(pid) / 90000 - arrival;
        minimumDecodeLead = Math.min(minimumDecodeLead, lead);
        if (pid === 48) maximumVideoDecodeLead = Math.max(maximumVideoDecodeLead, lead);
      }
    }
    if (!(adaptation & 1) || !start || ![0, 63].includes(pid)) continue;
    const first = payload + 1 + bytes[payload];
    const length = 3 + (((bytes[first + 1] & 15) << 8) | bytes[first + 2]);
    expect(first + length).toBeLessThanOrEqual(offset + 188);
    const section = bytes.subarray(first, first + length);
    expect(sectionCrc(section)).toBe(0);
    tables.push({ pid, section });
  }
  expect([...pids.keys()].sort((a, b) => a - b)).toEqual([0, 48, 49, 63, 8191]);
  expect(pcr.length).toBeGreaterThan(10);
  expect(Number.isFinite(minimumDecodeLead)).toBe(true);
  expect(minimumDecodeLead, '每個影音 PES 必須在 DTS 解碼期限前完整送達').toBeGreaterThanOrEqual(0);
  if (format === 'airline-s3k') {
    expect(maximumVideoDecodeLead, 'S3K 視訊不得提前超過 1 秒送達解碼器').toBeLessThanOrEqual(1);
  }
  const first = pcr[0];
  const last = pcr.at(-1);
  const rate = (last.offset - first.offset) * 8 * 27000000 / (last.ticks - first.ticks);
  expect(rate).toBeCloseTo(muxRate, 0);
  for (let index = 1; index < pcr.length; index += 1) {
    const interval = (pcr[index].ticks - pcr[index - 1].ticks) / 27000000;
    expect(interval).toBeGreaterThan(0);
    expect(interval).toBeLessThanOrEqual(0.1);
  }
  return tables;
}

function expectTables(tables, format) {
  const pat = tables.filter(table => table.pid === 0);
  const pmt = tables.filter(table => table.pid === 63);
  expect(pat.length).toBeGreaterThan(10);
  expect(pmt.length).toBeGreaterThan(10);
  for (const { section } of pat) {
    expect(section[0]).toBe(0);
    expect(section.readUInt16BE(3)).toBe(1); // transport stream id
    expect(section.readUInt16BE(8)).toBe(1); // program number
    expect(section.readUInt16BE(10) & 0x1fff).toBe(63);
  }
  for (const { section } of pmt) {
    expect(section[0]).toBe(2);
    expect(section.readUInt16BE(3)).toBe(1);
    expect(section.readUInt16BE(8) & 0x1fff).toBe(48); // PCR PID
    const streams = [];
    for (let pos = 12 + (section.readUInt16BE(10) & 0xfff); pos < section.length - 4;) {
      streams.push({ type: section[pos], pid: section.readUInt16BE(pos + 1) & 0x1fff });
      pos += 5 + (section.readUInt16BE(pos + 3) & 0xfff);
    }
    expect(streams).toEqual(format === 'airline-s3k'
      ? [{ type: 1, pid: 48 }, { type: 3, pid: 49 }]
      : [{ type: 27, pid: 48 }, { type: 15, pid: 49 }]);
  }
}

function expectTimeline(data, format, expectedFrames) {
  const video = data.streams.find(stream => stream.codec_type === 'video');
  const audio = data.streams.find(stream => stream.codec_type === 'audio');
  expect(data.streams).toHaveLength(2);
  expect(video).toMatchObject(format === 'airline-s3k'
    ? { codec_name: 'mpeg1video', width: 352, height: 240, sample_aspect_ratio: '200:219', display_aspect_ratio: '880:657' }
    : { codec_name: 'h264', profile: 'Main', level: 30, width: 720, height: 480, sample_aspect_ratio: '32:27', display_aspect_ratio: '16:9' });
  // MPEG-1 probing may report a field-rate r_frame_rate; avg and every decoded
  // frame PTS below must still prove the actual 30000/1001 progressive cadence.
  expect(video.avg_frame_rate).toBe('30000/1001');
  expect(video.field_order).toBe('progressive');
  expect(audio).toMatchObject({ codec_name: format === 'airline-s3k' ? 'mp2' : 'aac', channels: 2, sample_rate: '48000' });
  const frames = data.packets_and_frames.filter(item => item.type === 'frame' && item.media_type === 'video');
  const packets = data.packets_and_frames.filter(item => item.type === 'packet' && item.codec_type === 'video');
  expect(frames).toHaveLength(expectedFrames);
  expect([...new Set(frames.map(frame => frame.pict_type))].sort()).toEqual(['B', 'I', 'P']);
  expect(packets).toHaveLength(expectedFrames);
  expect(packets.some((packet, index) => index > 0 && packet.pts < packets[index - 1].pts)).toBe(true);
  for (let index = 0; index < frames.length; index += 1) {
    expect(frames[index].pts - frames[0].pts).toBe(index * 3003);
    expect(packets[index].dts - packets[0].dts).toBe(index * 3003);
    expect(Number.isFinite(packets[index].pts)).toBe(true);
  }
  // MediaInfo's audio delay relative to video must be zero for both airline outputs.
  expect(audio.start_pts).toBe(video.start_pts);
  return { video, audio, frames };
}

describe.skipIf(!nativeAvailable)('航空內建 MPEG transport 合成', () => {
  let directory;
  beforeAll(() => { directory = mkdtempSync(path.join(tmpdir(), 'subtool-airline-transport-test-')); });
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  async function encode(format, pattern, seconds, cpus = 4) {
    const encoding = airlineEncoding(format);
    const size = format === 'airline-s3k' ? '352x240' : '720x480';
    const source = pattern === 'motion'
      ? `testsrc2=size=${size}:rate=30000/1001:duration=${seconds},noise=alls=35:allf=t+u:all_seed=1`
      : `color=black:size=${size}:rate=30000/1001:duration=${seconds}`
        + (pattern === 'sync' ? ",drawbox=color=white:t=fill:enable='between(t,1,1.05)'" : '');
    const sound = pattern === 'sync'
      ? `aevalsrc='0.7*sin(2*PI*997*t)*(between(t,0,0.05)+between(t,1,1.05))':s=48000:d=${seconds}`
      : `sine=frequency=997:sample_rate=48000:duration=${seconds}`;
    const output = path.join(directory, `${format}-${pattern}-${seconds}s-${cpus}cpu.mpg`);
    const result = run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-cpucount', String(cpus),
      '-f', 'lavfi', '-i', source, '-f', 'lavfi', '-i', sound,
      '-map', '0:v:0', '-map', '1:a:0', '-vf', `setsar=${encoding.sar}`,
      ...(encoding.audioPrerollSamples ? ['-af', `adelay=${encoding.audioPrerollSamples}S:all=1`] : []),
      ...encoding.videoArgs, ...encoding.audioArgs, ...airlineMuxArgs(format), output]);
    expect(result.stderr).not.toMatch(BAD_ENCODER_LOG);
    await finalizeAirlineOutput(format, output);
    expectTables(inspectTransport(readFileSync(output), format), format);
    const timing = expectTimeline(probe(output), format, Math.ceil(seconds * 30000 / 1001));
    // Decode every audio and video packet. Exit 0 without this check can hide a broken PMT or truncated stream.
    const decoded = run(FFMPEG, ['-v', 'warning', '-xerror', '-threads', '1', '-err_detect', 'crccheck+explode',
      '-i', output, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
    expect(decoded.stderr.trim()).toBe('');
    const elementary = run(FFMPEG, ['-v', 'error', '-i', output, '-map', '0:v', '-c:v', 'copy',
      '-f', format === 'airline-s3k' ? 'mpeg1video' : 'h264', '-'], { binaryOutput: true }).stdout;
    const ending = format === 'airline-s3k' ? Buffer.from([0, 0, 1, 0xb7])
      : Buffer.from([0, 0, 1, 10, 128, 0, 0, 1, 11, 128]);
    expect(elementary.subarray(-ending.length)).toEqual(ending);
    if (format === 'airline-s3k') {
      const gopFlags = [];
      let aspectCode;
      for (let offset = 0; offset < elementary.length - 8; offset++) {
        if (elementary[offset] === 0 && elementary[offset + 1] === 0
          && elementary[offset + 2] === 1 && elementary[offset + 3] === 0xb3 && aspectCode == null) {
          aspectCode = elementary[offset + 7] >> 4;
        }
        if (elementary[offset] === 0 && elementary[offset + 1] === 0
          && elementary[offset + 2] === 1 && elementary[offset + 3] === 0xb8) {
          gopFlags.push(!!(elementary[offset + 4] & 0x80));
        }
      }
      expect(aspectCode, '保留 Carbon S3K 的 MPEG-1 aspect code 12').toBe(12);
      expect(gopFlags.length).toBeGreaterThan(0);
      expect(gopFlags.every(Boolean), '29.97 S3K GOP 應標示 drop-frame 時碼').toBe(true);
    }
    return { output, timing };
  }

  it.each(FORMATS)('%s：90 格 B-frame 重排、PID/CRC/PCR 正確，解碼後 beep 與閃白同步', async format => {
    const { output, timing } = await encode(format, 'sync', 3);
    const gray = run(FFMPEG, ['-v', 'error', '-i', output, '-map', '0:v:0',
      '-vf', 'scale=1:1,setsar=1,format=gray', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'], { binaryOutput: true }).stdout;
    expect(gray).toHaveLength(90);
    const white = gray.findIndex(value => value > 200);
    expect(white).toBe(30);
    const pcm = run(FFMPEG, ['-v', 'error', '-i', output, '-map', '0:a:0',
      '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { binaryOutput: true }).stdout;
    let firstSound = -1;
    for (let offset = 0; offset < pcm.length; offset += 4) {
      if (Math.abs(pcm.readFloatLE(offset)) > 0.1) { firstSound = offset / 4; break; }
    }
    expect(firstSound).toBeGreaterThanOrEqual(0);
    expect(firstSound, '片頭原始音訊不能被吃掉或推遲超過 12 ms').toBeLessThan(576);
    let secondSound = -1;
    for (let offset = 43200 * 4; offset < pcm.length; offset += 4) {
      if (Math.abs(pcm.readFloatLE(offset)) > 0.1) { secondSound = offset / 4; break; }
    }
    expect(secondSound).toBeGreaterThan(0);
    const audioTime = Number(timing.audio.start_time) + secondSound / 48000;
    const videoTime = timing.frames[white].pts / 90000;
    expect(Math.abs(audioTime - videoTime)).toBeLessThan(0.01);
  }, 60000);

  it.each(['airline-s3k', 'airline-dmpes'])('%s：再轉已有音訊前導的 MPG，0 ms 封裝仍保留真實聲畫同步', async format => {
    const encoding = airlineEncoding(format);
    const size = format === 'airline-s3k' ? '352x240' : '720x480';
    const source = path.join(directory, `${format}-source-with-priming.mpg`);
    const output = path.join(directory, `${format}-reencoded.mpg`);
    run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=black:size=${size}:rate=30000/1001:duration=3,drawbox=color=white:t=fill:enable='between(t,1,1.05)'`,
      '-f', 'lavfi', '-i', "aevalsrc='0.7*sin(2*PI*997*t)*(between(t,0,0.05)+between(t,1,1.05))':s=48000:d=3",
      '-map', '0:v:0', '-map', '1:a:0', '-vf', `setsar=${encoding.sar}`,
      ...encoding.videoArgs,
      ...(format === 'airline-s3k' ? encoding.audioArgs
        : ['-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '128k', '-ar', '48000', '-ac', '2']),
      ...airlineMuxArgs(format), source]);
    const sourceStreams = probe(source).streams;
    const sourceVideo = sourceStreams.find(stream => stream.codec_type === 'video');
    const sourceAudio = sourceStreams.find(stream => stream.codec_type === 'audio');
    const offset = Number(sourceAudio.start_time) - Number(sourceVideo.start_time);
    expect(offset).toBeLessThan(0);
    const audioPlan = {
      buses: ['left', 'right'].map((id, sourceChannel) => ({ id, inputs: [{
        file: source, sourceStream: 0, sourceChannel, trimStart: 0, trimEnd: 3, offset: 0,
      }] })),
      streams: [{ layout: 'stereo', busIds: ['left', 'right'] }],
    };
    const plan = buildDeliveryArgv({ format, clips: [{ type: 'video', path: source,
      in: 0, out: 3, offset: 0, vtrack: 0, natW: sourceVideo.width, natH: sourceVideo.height,
      fps: 30000 / 1001 }], videoTracks: [{ vt: 0 }], width: sourceVideo.width,
    height: sourceVideo.height, fps: 30000 / 1001, duration: 3, audioPlan, outPath: output }, {
      hasAudioStream: () => true, audioVideoStartOffset: () => offset,
    });
    run(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...plan.args]);
    await finalizeAirlineOutput(format, output);
    const timing = expectTimeline(probe(output), format, 90);
    const gray = run(FFMPEG, ['-v', 'error', '-i', output, '-map', '0:v:0',
      '-vf', 'scale=1:1,setsar=1,format=gray', '-fps_mode', 'passthrough',
      '-f', 'rawvideo', '-'], { binaryOutput: true }).stdout;
    const white = gray.findIndex(value => value > 200);
    expect(white).toBe(30);
    const pcm = run(FFMPEG, ['-v', 'error', '-i', output, '-map', '0:a:0',
      '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { binaryOutput: true }).stdout;
    let firstSound = -1;
    let secondSound = -1;
    for (let index = 0; index < pcm.length / 4; index++) {
      if (Math.abs(pcm.readFloatLE(index * 4)) <= 0.1) continue;
      if (firstSound < 0) firstSound = index;
      if (index > 43200) { secondSound = index; break; }
    }
    expect(firstSound).toBeGreaterThanOrEqual(0);
    expect(firstSound).toBeLessThan(576);
    expect(secondSound).toBeGreaterThan(0);
    expect(Math.abs(Number(timing.audio.start_time) + secondSound / 48000
      - timing.frames[white].pts / 90000)).toBeLessThan(0.01);
  }, 60000);

  it.each(FORMATS)('%s：12 秒純黑及高動態影片均可完整解碼且沒有 mux overflow', async format => {
    await encode(format, 'black', 12);
    await encode(format, 'motion', 12);
  }, 90000);

  it.each([1, 4])('S3K：%s 核心下 60 秒固定雜訊，所有 PES 均在 DTS 前送達', async cpus => {
    await encode('airline-s3k', 'motion', 60, cpus);
  }, 90000);
});
