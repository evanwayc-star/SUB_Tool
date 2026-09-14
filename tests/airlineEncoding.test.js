// @subtool-ci windows
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { airlineEncoding, airlineMuxArgs } from '../electron/airline-encoding.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.FFMPEG_PATH || path.join(ROOT, 'electron/ffmpeg/ffmpeg.exe');
const FFPROBE = process.env.FFPROBE_PATH || path.join(ROOT, 'electron/ffmpeg/ffprobe.exe');
const nativeAvailable = existsSync(FFMPEG) && existsSync(FFPROBE);

function run(binary, args) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr);
  return result;
}

function probe(file) {
  return JSON.parse(run(FFPROBE, ['-v', 'error', '-show_streams', '-of', 'json', file]).stdout).streams[0];
}

function starts(bytes) {
  const result = [];
  for (let i = 0; i < bytes.length - 4; i += 1) {
    if (bytes[i] !== 0 || bytes[i + 1] !== 0) continue;
    const prefix = bytes[i + 2] === 1 ? 3 : bytes[i + 2] === 0 && bytes[i + 3] === 1 ? 4 : 0;
    if (!prefix) continue;
    result.push({ code: bytes[i + prefix], payload: i + prefix + 1 });
    i += prefix;
  }
  return result;
}

function bits(bytes, byteOffset, bitOffset, length) {
  let value = 0;
  for (let i = bitOffset; i < bitOffset + length; i += 1) {
    value = value * 2 + ((bytes[byteOffset + (i >> 3)] >> (7 - (i & 7))) & 1);
  }
  return value;
}

describe('航空 codec 選擇', () => {
  it('普通交付格式不啟用航空編碼，回傳的參數不共用可變陣列', () => {
    expect(airlineEncoding('h264')).toBeNull();
    const first = airlineEncoding('airline-s3k');
    first.audioArgs.push('changed');
    expect(airlineEncoding('airline-s3k').audioArgs).not.toContain('changed');
    const mux = airlineMuxArgs();
    mux.push('changed');
    expect(airlineMuxArgs()).not.toContain('changed');
  });

  it('影音 encoder 可共同寫入 transport，不會在編碼參數中關閉另一條 stream', () => {
    for (const format of ['airline-s3k', 'airline-dmpes']) {
      const encoding = airlineEncoding(format);
      expect([...encoding.videoArgs, ...encoding.audioArgs]).not.toEqual(expect.arrayContaining(['-an']));
      expect([...encoding.videoArgs, ...encoding.audioArgs]).not.toEqual(expect.arrayContaining(['-vn']));
      expect([...encoding.videoArgs, ...encoding.audioArgs]).not.toEqual(expect.arrayContaining(['-f']));
    }
  });
});

describe.skipIf(!nativeAvailable)('航空原生 elementary bitstream', () => {
  let directory;
  const outputs = new Map();
  beforeAll(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'subtool-airline-encoding-test-'));
    for (const format of ['airline-s3k', 'airline-dmpes']) {
      const encoding = airlineEncoding(format);
      const size = format === 'airline-s3k' ? '352x240' : '720x480';
      const video = path.join(directory, format + encoding.videoExtension);
      const audio = path.join(directory, format + encoding.audioExtension);
      run(FFMPEG, [
        '-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i',
        `testsrc2=size=${size}:rate=30000/1001:duration=3`,
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
        '-map', '0:v', ...encoding.videoArgs, '-an', '-f', format === 'airline-s3k' ? 'mpeg1video' : 'h264', video,
        '-map', '1:a', ...encoding.audioArgs, '-vn', '-f', format === 'airline-s3k' ? 'mp2' : 'adts', audio,
      ]);
      outputs.set(format, { video, audio });
    }
  }, 60000);
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  it('S3K sequence header 保留 aspect code 12、NTSC、CBR、224 KiB VBV 與每 15 格 GOP', () => {
    const { video } = outputs.get('airline-s3k');
    expect(probe(video)).toMatchObject({
      codec_name: 'mpeg1video', width: 352, height: 240, field_order: 'progressive',
      pix_fmt: 'yuv420p', sample_aspect_ratio: '200:219', display_aspect_ratio: '880:657',
    });
    // Raw ES demuxers may assume 25 fps: check the actual sequence header instead.
    const bytes = readFileSync(video);
    const units = starts(bytes);
    const headers = units.filter(unit => unit.code === 0xb3);
    expect(headers.length).toBeGreaterThanOrEqual(6);
    for (const { payload } of headers) {
      expect(bits(bytes, payload, 0, 12)).toBe(352);
      expect(bits(bytes, payload, 12, 12)).toBe(240);
      expect(bits(bytes, payload, 24, 4)).toBe(12);
      expect(bits(bytes, payload, 28, 4)).toBe(4); // 30000/1001
      expect(bits(bytes, payload, 32, 18) * 400).toBe(1500000);
      expect(bits(bytes, payload, 51, 10) * 16384).toBe(224 * 1024 * 8);
    }
    const pictures = units.filter(unit => unit.code === 0);
    expect(pictures).toHaveLength(90);
    const intra = pictures.flatMap((unit, index) => bits(bytes, unit.payload, 10, 3) === 1 ? [index] : []);
    expect(intra[0]).toBe(0);
    const boundaries = [...intra, pictures.length];
    expect(boundaries.slice(1).every((n, i) => n - boundaries[i] <= 15)).toBe(true);
    const gops = units.filter(unit => unit.code === 0xb8);
    expect(gops).toHaveLength(headers.length);
    expect(gops.slice(1).every(unit => bits(bytes, unit.payload, 25, 1) === 0)).toBe(true);
  });

  it('S3K MPEG-1 Layer-2 Stereo 每一格帶有效 CRC，48 kHz/128 kbps 且不設 copyright/original', () => {
    const { audio } = outputs.get('airline-s3k');
    expect(probe(audio)).toMatchObject({ codec_name: 'mp2', sample_rate: '48000', channels: 2, bit_rate: '128000' });
    const bytes = readFileSync(audio);
    // 1152 samples at 48 kHz and 128 kbps is exactly 384 bytes per Layer-2 frame.
    expect(bytes.length % 384).toBe(0);
    for (let offset = 0; offset < bytes.length; offset += 384) {
      expect(bytes[offset]).toBe(0xff);
      expect(bytes[offset + 1]).toBe(0xfc); // MPEG-1, Layer-2, protection enabled
      expect(bytes[offset + 2]).toBe(0x84); // 128 kbps, 48 kHz, no padding
      expect(bytes[offset + 3]).toBe(0); // Stereo, no copyright/original/emphasis
    }
    const decode = file => run(FFMPEG, ['-v', 'warning', '-err_detect', 'crccheck', '-i', file, '-f', 'null', '-']);
    expect(decode(audio).stderr).not.toMatch(/CRC mismatch/);
    bytes[4] ^= 0xff;
    const corrupted = path.join(directory, 'bad-crc.m1a');
    writeFileSync(corrupted, bytes);
    expect(decode(corrupted).stderr).toMatch(/CRC mismatch/); // prove the decoder actually checks CRC
  });

  it('DMPES 720×480 顯示 16:9，Main@3.0、29.97p、2 refs、CABAC、CBR HRD 與停用去區塊', () => {
    const { video, audio } = outputs.get('airline-dmpes');
    expect(probe(video)).toMatchObject({
      codec_name: 'h264', profile: 'Main', level: 30, width: 720, height: 480,
      pix_fmt: 'yuv420p', field_order: 'progressive', sample_aspect_ratio: '32:27', display_aspect_ratio: '16:9',
    });
    const trace = run(FFMPEG, ['-hide_banner', '-i', video, '-c:v', 'copy',
      '-bsf:v', 'trace_headers', '-frames:v', '5', '-f', 'null', '-']).stderr;
    for (const [field, value] of Object.entries({
      profile_idc: 77, level_idc: 30, max_num_ref_frames: 2, frame_mbs_only_flag: 1,
      aspect_ratio_idc: 255, sar_width: 32, sar_height: 27,
      num_units_in_tick: 1001, time_scale: 60000, video_format: 2,
      fixed_frame_rate_flag: 1, nal_hrd_parameters_present_flag: 1, vcl_hrd_parameters_present_flag: 0,
      entropy_coding_mode_flag: 1, weighted_pred_flag: 0, weighted_bipred_idc: 0,
      chroma_qp_index_offset: 1, disable_deblocking_filter_idc: 1,
    })) expect(trace).toMatch(new RegExp(`\\b${field}\\s+[01]+ = ${value}\\s`));
    const units = starts(readFileSync(video));
    expect(units.filter(unit => (unit.code & 31) === 9)).toHaveLength(90);
    expect(units.filter(unit => (unit.code & 31) === 5)).toHaveLength(6);
    expect(units.filter(unit => [10, 11].includes(unit.code & 31))).toHaveLength(0);
    expect(probe(audio)).toMatchObject({ codec_name: 'aac', profile: 'LC', sample_rate: '48000', channels: 2 });
    const adts = readFileSync(audio);
    expect(adts[0]).toBe(0xff);
    expect(adts[1] & 0xf6).toBe(0xf0); // ADTS sync, layer zero
    expect(adts[2] >> 6).toBe(1); // AAC LC, not HE
    expect((adts[2] >> 2) & 15).toBe(3); // 48 kHz
  });

  it('低複雜度純黑也維持 1.5 Mbps 目標，DMPES filler 可用且沒有偷偷改成 VBR', () => {
    for (const format of ['airline-s3k', 'airline-dmpes']) {
      const encoding = airlineEncoding(format);
      const file = path.join(directory, `black-${format}${encoding.videoExtension}`);
      const size = format === 'airline-s3k' ? '352x240' : '720x480';
      run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i',
        `color=black:size=${size}:rate=30000/1001:duration=8`, ...encoding.videoArgs,
        '-an', '-f', format === 'airline-s3k' ? 'mpeg1video' : 'h264', file]);
      const bytes = readFileSync(file);
      const average = bytes.length * 8 / 8;
      // VBV startup/final buffering means a finite clip need not average exactly 1.5 Mbps.
      expect(average).toBeGreaterThan(1400000);
      expect(average).toBeLessThan(1600000);
      if (format === 'airline-dmpes') expect(starts(bytes).some(unit => (unit.code & 31) === 12)).toBe(true);
    }
  });
});
