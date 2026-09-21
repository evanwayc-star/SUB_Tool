// @subtool-ci windows
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { airlineEncoding, airlineMuxArgs } from '../electron/airline-encoding.js';
import { finalizeAirlineOutput } from '../electron/airline-output.js';

const ffmpeg = process.env.FFMPEG_PATH || path.resolve('electron/ffmpeg/ffmpeg.exe');
const directory = mkdtempSync(path.join(tmpdir(), 'subtool-airline-buffers-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
function timestamp(b, o) {
  return (b[o] & 14) * 536870912 + b[o + 1] * 4194304 + (b[o + 2] & 254) * 16384 + b[o + 3] * 128 + (b[o + 4] >> 1);
}
// Independent packet-arrival model: 188-byte TB at 1.2 * AVC HRD bit_rate,
// PES elementary bytes retained until DTS, audio retained until its PTS.
function buffers(bytes, format) {
  const rate = format === 'airline-dmpes-4m' ? 4600000 : 1855594;
  const drain = format === 'airline-dmpes-4m' ? 4800000 : 1799961.6;
  const queue = { 48: [], 49: [] }, level = { 48: 0, 49: 0 }, maximum = { 48: 0, 49: 0 };
  const current = new Map();
  let anchor, previous = 0, tb = 0, maxTb = 0, minLead = Infinity;
  for (let p = 0; p < bytes.length; p += 188) {
    const b = bytes.subarray(p, p + 188), pid = ((b[1] & 31) << 8) | b[2], af = (b[3] >> 4) & 3;
    let q = 4;
    if (af & 2) {
      q += b[4] + 1;
      if (b[4] >= 7 && (b[5] & 16)) {
        anchor = { p: p + 12, t: (b[6] * 33554432 + b[7] * 131072 + b[8] * 512 + b[9] * 2 + (b[10] >> 7)) / 90000
          + (((b[10] & 1) << 8) + b[11]) / 27000000 };
      }
    }
    if (!anchor) continue;
    const time = anchor.t + (p + 188 - anchor.p) * 8 / rate;
    if (pid === 48) {
      tb = Math.max(0, tb - (time - previous) * drain / 8) + 188;
      previous = time; maxTb = Math.max(maxTb, tb);
    }
    if (![48, 49].includes(pid) || !(af & 1)) continue;
    for (const id of [48, 49]) {
      while (queue[id].length && queue[id][0].dts <= time) level[id] -= queue[id].shift().size;
    }
    if (b[1] & 64) {
      const flags = (b[q + 7] >> 6) & 3;
      const frame = { dts: timestamp(b, q + (flags === 3 ? 14 : 9)) / 90000, size: 0 };
      current.set(pid, frame); queue[pid].push(frame); q += 9 + b[q + 8];
    }
    const frame = current.get(pid);
    if (!frame) continue;
    frame.size += 188 - q; level[pid] += 188 - q;
    maximum[pid] = Math.max(maximum[pid], level[pid]);
    minLead = Math.min(minLead, frame.dts - time);
  }
  return { maxTb, maximum, minLead };
}

function encode(format, name) {
  const encoding = airlineEncoding(format);
  const output = path.join(directory, name);
  const size = format === 'airline-s3k' ? '352x240' : '720x480';
  const result = spawnSync(ffmpeg, ['-v', 'error', '-y', '-cpucount', '4', '-f', 'lavfi', '-i',
    `testsrc2=size=${size}:rate=30000/1001:duration=8,noise=alls=35:allf=t+u:all_seed=1`,
    '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=48000:duration=8', '-map', '0:v', '-map', '1:a',
    ...encoding.videoArgs, ...encoding.audioArgs, ...airlineMuxArgs(format), '-muxdelay', '0.7', output],
  { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  expect(result.status, result.stderr).toBe(0);
  return output;
}

describe.skipIf(!existsSync(ffmpeg))('航空 T-STD 緩衝與解碼期限', () => {
  it.each(['airline-dmpes', 'airline-dmpes-4m', 'airline-s3k'])('%s 影片 TB、VBV 與音訊主緩衝不能重現 TSA 報表溢位', async format => {
    const output = encode(format, `${format}-motion.mpg`);
    const before = buffers(readFileSync(output), format);
    if (format === 'airline-dmpes') {
      expect(before.maxTb).toBeGreaterThan(512);
      expect(before.maximum[49]).toBeGreaterThan(3584);
    }
    const tempDir = mkdtempSync(path.join(directory, 'lease-'));
    await finalizeAirlineOutput(format, output, { tempDir });
    expect(readdirSync(tempDir)).toEqual([]);
    const measured = buffers(readFileSync(output), format);
    expect(measured.maxTb, JSON.stringify(measured)).toBeLessThanOrEqual(512);
    expect(measured.maximum[49]).toBeLessThanOrEqual(3584);
    expect(measured.minLead).toBeGreaterThanOrEqual(0);
    expect(measured.maximum[48]).toBeGreaterThan(1000);
    expect(measured.maximum[48]).toBeLessThanOrEqual(format === 'airline-s3k' ? 229376
      : format === 'airline-dmpes-4m' ? 347124 : 130124);
  }, 90000);

  it.each(['reshape', 'publish'])('取消 %s 階段會刪除 lease 暫存並釋放所有檔案 handle', async phase => {
    const output = encode('airline-dmpes', `cancel-${phase}.mpg`);
    const tempDir = mkdtempSync(path.join(directory, 'cancel-lease-'));
    const controller = new AbortController();
    let observed = false;
    const signal = {
      throwIfAborted() {
        const stage = readdirSync(tempDir).map(name => path.join(tempDir, name));
        const reached = phase === 'reshape' ? stage.some(file => statSync(file).size >= 188 * 1024)
          : stage.length > 0 && statSync(output).size === 0;
        if (reached) { observed = true; controller.abort(); }
        controller.signal.throwIfAborted();
      },
    };
    await expect(finalizeAirlineOutput('airline-dmpes', output, { tempDir, signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(observed).toBe(true);
    expect(readdirSync(tempDir)).toEqual([]);
    // The watchdog owns deletion of the unfinished output after publication starts.
    rmSync(output);
  });
});
