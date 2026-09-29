// @subtool-ci windows
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

describe('航空 codec 選擇', () => {
  it('普通交付格式不啟用航空編碼，回傳的參數不共用可變陣列', () => {
    expect(airlineEncoding('h264')).toBeNull();
    const first = airlineEncoding('airline-exw');
    first.audioArgs.push('changed');
    expect(airlineEncoding('airline-exw').audioArgs).not.toContain('changed');
    expect(airlineEncoding('airline-s3k')).toBeNull();
    const mux = airlineMuxArgs();
    mux.push('changed');
    expect(airlineMuxArgs()).not.toContain('changed');
  });

  it('影音 encoder 可共同寫入 transport，不會在編碼參數中關閉另一條 stream', () => {
    for (const format of ['airline-exw', 'airline-dmpes']) {
      const encoding = airlineEncoding(format);
      expect([...encoding.videoArgs, ...encoding.audioArgs]).not.toEqual(expect.arrayContaining(['-an']));
      expect([...encoding.videoArgs, ...encoding.audioArgs]).not.toEqual(expect.arrayContaining(['-vn']));
      expect([...encoding.videoArgs, ...encoding.audioArgs]).not.toEqual(expect.arrayContaining(['-f']));
    }
  });

  it('exW 套用 CPF 的 500/2000 kbps VBR、125000-byte VBV 與 64 kbps AAC-LC，不指定 CBR muxrate', () => {
    const encoding = airlineEncoding('airline-exw');
    const value = (args, key) => args[args.indexOf(key) + 1];
    expect(value(encoding.videoArgs, '-b:v')).toBe('500k');
    expect(value(encoding.videoArgs, '-maxrate:v')).toBe('2000k');
    expect(value(encoding.videoArgs, '-bufsize:v')).toBe('1000000');
    expect(encoding.videoArgs).not.toContain('-minrate:v');
    expect(value(encoding.audioArgs, '-c:a')).toBe('aac');
    expect(value(encoding.audioArgs, '-profile:a')).toBe('aac_low');
    expect(value(encoding.audioArgs, '-b:a')).toBe('64k');
    expect(encoding.muxArgs).not.toContain('-muxrate');
    expect(airlineMuxArgs('airline-dmpes')).toContain('-muxrate');
  });
});

describe.skipIf(!nativeAvailable)('航空原生 elementary bitstream', () => {
  let directory;
  const outputs = new Map();
  beforeAll(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'subtool-airline-encoding-test-'));
    for (const format of ['airline-exw', 'airline-dmpes']) {
      const encoding = airlineEncoding(format);
      const size = format === 'airline-exw' ? '640x360' : '720x480';
      const video = path.join(directory, format + encoding.videoExtension);
      const audio = path.join(directory, format + encoding.audioExtension);
      run(FFMPEG, [
        '-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i',
        `testsrc2=size=${size}:rate=30000/1001:duration=3`,
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
        '-map', '0:v', ...encoding.videoArgs, '-an', '-f', 'h264', video,
        '-map', '1:a', ...encoding.audioArgs, '-vn', '-f', 'adts', audio,
      ]);
      outputs.set(format, { video, audio });
    }
  }, 60000);
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  it('exW H.264 為 640×360、Main@3.0、正方形像素與 15 格 GOP', () => {
    const { video, audio } = outputs.get('airline-exw');
    expect(probe(video)).toMatchObject({
      codec_name: 'h264', profile: 'Main', level: 30, width: 640, height: 360,
      field_order: 'progressive', pix_fmt: 'yuv420p', sample_aspect_ratio: '1:1', display_aspect_ratio: '16:9',
    });
    const trace = run(FFMPEG, ['-hide_banner', '-i', video, '-c:v', 'copy',
      '-bsf:v', 'trace_headers', '-frames:v', '5', '-f', 'null', '-']).stderr;
    for (const [field, value] of Object.entries({
      profile_idc: 77, level_idc: 30, max_num_ref_frames: 2, frame_mbs_only_flag: 1,
      aspect_ratio_idc: 1, num_units_in_tick: 1001, time_scale: 60000,
      nal_hrd_parameters_present_flag: 0, pic_struct_present_flag: 1,
      entropy_coding_mode_flag: 1,
      disable_deblocking_filter_idc: 1,
    })) expect(trace).toMatch(new RegExp(`\\b${field}\\s+[01]+ = ${value}\\s`));
    expect(trace).toMatch(/\bpic_struct\s+[01]+ = 0\s/);
    const units = starts(readFileSync(video));
    expect(units.filter(unit => (unit.code & 31) === 9)).toHaveLength(90);
    expect(units.filter(unit => (unit.code & 31) === 5)).toHaveLength(6);
    expect(probe(audio)).toMatchObject({ codec_name: 'aac', profile: 'LC', sample_rate: '48000', channels: 2 });
    const adts = readFileSync(audio);
    expect(adts[2] >> 6).toBe(1);
    expect((adts[2] >> 2) & 15).toBe(3);
  });

  it('exW 場景切換不提前插入 IDR，維持固定 15 格 GOP', () => {
    const output = path.join(directory, 'airline-exw-scene-cut.h264');
    const source = "testsrc2=size=640x360:rate=30000/1001:duration=3,drawbox=color=black:t=fill:enable='lt(t,0.1)'";
    run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', source, '-map', '0:v',
      ...airlineEncoding('airline-exw').videoArgs, '-an', '-f', 'h264', output]);
    const { frames } = JSON.parse(run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
      '-show_frames', '-show_entries', 'frame=key_frame', '-of', 'json', output]).stdout);
    expect(frames.flatMap((frame, index) => frame.key_frame ? [index] : []))
      .toEqual([0, 15, 30, 45, 60, 75]);
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
    for (const format of ['airline-dmpes']) {
      const encoding = airlineEncoding(format);
      const file = path.join(directory, `black-${format}${encoding.videoExtension}`);
      const size = '720x480';
      run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i',
        `color=black:size=${size}:rate=30000/1001:duration=8`, ...encoding.videoArgs,
        '-an', '-f', 'h264', file]);
      const bytes = readFileSync(file);
      const average = bytes.length * 8 / 8;
      // VBV startup/final buffering means a finite clip need not average exactly 1.5 Mbps.
      expect(average).toBeGreaterThan(1400000);
      expect(average).toBeLessThan(1600000);
      expect(starts(bytes).some(unit => (unit.code & 31) === 12)).toBe(true);
    }
  });
});
