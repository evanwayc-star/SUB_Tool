// @subtool-ci windows
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DVD_ISO, BD_ISO } from '../shared/delivery-formats.cjs';
import { discEncoding, prepareDiscOutput, cleanupDiscOutput, nativeDiscPaths,
  finalizeDiscOutput, verifyDiscIso, dvdAuthorXml, blurayMeta } from '../electron/disc-authoring.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.FFMPEG_PATH || path.join(ROOT, 'electron/ffmpeg/ffmpeg.exe');
const FFPROBE = process.env.FFPROBE_PATH || path.join(ROOT, 'electron/ffmpeg/ffprobe.exe');
const NATIVE = nativeDiscPaths(process.env.SUBTOOL_DISC_NATIVE_DIR || path.join(ROOT, 'electron/disc'));
const SEVENZIP = process.env.SEVENZIP_PATH || 'C:/Program Files/7-Zip/7z.exe';
const nativeAvailable = [FFMPEG, FFPROBE, SEVENZIP, ...Object.values(NATIVE)].every(existsSync);
const AUDIO = { streams: [{ layout: 'mono' }, { layout: 'stereoLtRt' }, { layout: '5.1' }] };

function run(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true,
    timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout);
  return result;
}

describe('光碟編碼與容量預算', () => {
  it('沿用 shared 容量、音訊碼率與串流上限；null plan 保留既有 stereo fallback', () => {
    for (const preset of [DVD_ISO, BD_ISO]) {
      const encoding = discEncoding(preset.format, { duration: 180, audioPlan: null });
      expect(encoding.capacityBytes).toBe(preset.capacityBytes);
      expect(encoding.audioKbps).toBe(preset.audioKbps);
      expect(encoding.maxStreams).toBe(preset.maxAudioStreams);
      expect(encoding.audioArgs).toContain(`${preset.audioKbps}k`);
      expect(() => discEncoding(preset.format, { duration: 180, audioPlan: { streams: [] } })).toThrow(/音訊/);
      expect(() => discEncoding(preset.format, { duration: 180,
        audioPlan: { streams: Array.from({ length: preset.maxAudioStreams + 1 }, () => ({ layout: 'mono' })) } })).toThrow(/音訊/);
    }
  });

  it('長片與多串流會降低影像碼率，無法容納最低碼率時明確拒絕', () => {
    for (const preset of [DVD_ISO, BD_ISO]) {
      const options = { duration: 4 * 3600, audioPlan: AUDIO };
      const encoded = discEncoding(preset.format, options);
      const payload = (encoded.videoKbps + preset.audioKbps * AUDIO.streams.length) * 1000 / 8 * options.duration;
      expect(payload).toBeLessThan(preset.capacityBytes * 0.92);
      expect(encoded.videoKbps).toBeLessThan(discEncoding(preset.format, { duration: 10 }).videoKbps);
      expect(() => discEncoding(preset.format, { duration: 1e8 })).toThrow(/容量/);
      expect(() => discEncoding(preset.format, { duration: 0 })).toThrow(/時長/);
    }
  });

  it('Mono、Stereo/LtRt、5.1 分開編碼，不摺成單一 stereo', () => {
    const encoding = discEncoding('dvd-iso', { duration: 3, audioPlan: AUDIO });
    expect(encoding.audioArgs.filter(value => value === 'ac3')).toHaveLength(3);
    expect(encoding.audioArgs).toContain('-dsur_mode:a:1');
    expect(dvdAuthorXml(AUDIO)).toContain('channels="6"');
    expect(dvdAuthorXml(AUDIO)).toContain('dolby="surround"');
    expect(dvdAuthorXml(AUDIO)).toContain('<fpc>jump title 1;</fpc>');
    expect(blurayMeta(AUDIO)).toContain('--label="BD"');
    expect(blurayMeta(AUDIO)).toContain('track=259');
    expect(() => discEncoding('bd-iso', { duration: 3, audioPlan: { streams: [{ layout: '7.1' }] } })).toThrow(/音訊/);
  });

  it('映像檔完成後仍硬性檢查實際容量', async () => {
    const close = vi.fn(async () => {});
    const mockedOpen = vi.spyOn(fs, 'open').mockResolvedValue({
      stat: async () => ({ size: Math.ceil((DVD_ISO.capacityBytes + 1) / 2048) * 2048 }), close,
    });
    try {
      await expect(verifyDiscIso('dvd-iso', 'unused.iso')).rejects.toMatchObject({ code: 'DISC_CAPACITY_EXCEEDED' });
      expect(close).toHaveBeenCalledOnce();
    } finally { mockedOpen.mockRestore(); }
  });
});

describe.skipIf(!nativeAvailable)('原生 DVD／BD 合成內容與生命週期', () => {
  let directory;
  const generated = new Map();
  beforeAll(async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'subtool-disc-test-'));
    for (const preset of [DVD_ISO, BD_ISO]) {
      const work = await prepareDiscOutput(preset.format, { tempDir: directory });
      const encoding = discEncoding(preset.format, { duration: 3, audioPlan: AUDIO });
      const video = `testsrc2=size=${preset.width}x${preset.height}:rate=${preset.format === 'dvd-iso' ? '30000/1001' : '24'}:duration=3`;
      const args = ['-v', 'warning', '-nostdin', '-y', '-f', 'lavfi', '-i', video];
      for (const [index, channels] of [1, 2, 6].entries()) {
        args.push('-f', 'lavfi', '-i', `aevalsrc=${Array.from({ length: channels }, (_, channel) =>
          // AC-3 deliberately low-passes its LFE channel; exercise it with bass.
          `0.05*sin(2*PI*${channels === 6 && channel === 3 ? 60 : 440 + index * 220 + channel * 30}*t)`).join('|')}:s=48000:d=3`);
      }
      args.push('-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:a',
        ...encoding.videoArgs, ...encoding.audioArgs, ...encoding.muxArgs, work.encodedPath);
      const encodingLog = run(FFMPEG, args).stderr;
      expect(encodingLog).not.toMatch(/underflow|overflow|error parsing|non.?monoton/i);
      const outPath = path.join(directory, `${preset.format}.iso`);
      const pids = [];
      const order = [];
      const result = await finalizeDiscOutput(preset.format, work.encodedPath, outPath, {
        audioPlan: AUDIO, nativePaths: NATIVE,
        onOutputStart: async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          order.push('output');
        },
        onProcess: async child => {
          expect(child.pid).toBeGreaterThan(0);
          pids.push(child.pid);
          order.push(path.basename(child.spawnfile));
          await new Promise(resolve => setTimeout(resolve, 10));
        },
      });
      expect(pids).toHaveLength(preset.format === 'dvd-iso' ? 2 : 1);
      expect(order).toEqual(preset.format === 'dvd-iso' ? ['dvdauthor.exe', 'output', 'mkisofs.exe'] : ['output', 'tsMuxeR.exe']);
      const extracted = path.join(directory, preset.format);
      const listing = run(SEVENZIP, ['l', outPath]).stdout;
      run(SEVENZIP, ['x', '-y', `-o${extracted}`, outPath]);
      generated.set(preset.format, { work, outPath, extracted, listing, result });
    }
  }, 120000);

  afterAll(async () => {
    if (!directory) return;
    for (const { work } of generated.values()) await cleanupDiscOutput(work, { tempDir: directory });
    await fs.rm(directory, { recursive: true, force: true });
  });

  for (const preset of [DVD_ISO, BD_ISO]) {
    it(`${preset.label} 有正確 UDF、導覽結構、影像及三組可解碼音訊`, () => {
      const { extracted, listing, result } = generated.get(preset.format);
      expect(result.bytes).toBeLessThan(preset.capacityBytes);
      expect(result.volumeLabel).toBe(preset.format === 'dvd-iso' ? 'DVD' : 'BD');
      expect(listing).toContain(`Version = ${preset.format === 'dvd-iso' ? '1.02' : '2.50'}`);
      const content = preset.format === 'dvd-iso' ? 'VIDEO_TS/VTS_01_1.VOB' : 'BDMV/STREAM/00000.m2ts';
      const required = preset.format === 'dvd-iso' ? ['VIDEO_TS/VIDEO_TS.IFO', 'VIDEO_TS/VIDEO_TS.BUP', 'VIDEO_TS/VTS_01_0.IFO']
        : ['BDMV/index.bdmv', 'BDMV/MovieObject.bdmv', 'BDMV/PLAYLIST/00000.mpls', 'BDMV/CLIPINF/00000.clpi', 'CERTIFICATE'];
      for (const name of required) expect(existsSync(path.join(extracted, name))).toBe(true);
      const mediaPath = path.join(extracted, content);
      const probe = JSON.parse(run(FFPROBE, ['-v', 'error', '-show_streams', '-of', 'json', mediaPath]).stdout);
      const video = probe.streams.find(stream => stream.codec_type === 'video');
      expect([video.width, video.height, video.display_aspect_ratio]).toEqual([preset.width, preset.height, '16:9']);
      expect(video.codec_name).toBe(preset.format === 'dvd-iso' ? 'mpeg2video' : 'h264');
      expect(video.avg_frame_rate).toBe(preset.format === 'dvd-iso' ? '30000/1001' : '24/1');
      expect(video.field_order).toBe(preset.format === 'dvd-iso' ? 'tt' : 'progressive');
      const audio = probe.streams.filter(stream => stream.codec_type === 'audio');
      expect(audio.map(stream => stream.channels)).toEqual([1, 2, 6]);
      expect(audio.every(stream => stream.codec_name === 'ac3' && stream.sample_rate === '48000')).toBe(true);
      const decoded = run(FFMPEG, ['-v', 'error', '-threads', '1', '-i', mediaPath, '-map', '0:v', '-map', '0:a', '-f', 'null', '-']);
      expect(decoded.stderr.trim()).toBe('');
      for (let index = 0; index < audio.length; index += 1) {
        const level = run(FFMPEG, ['-v', 'info', '-i', mediaPath, '-map', `0:a:${index}`, '-af',
          'astats=metadata=0:reset=0:measure_perchannel=RMS_level:measure_overall=none', '-f', 'null', '-']).stderr;
        const values = [...level.matchAll(/RMS level dB: ([^\r\n]+)/g)].map(match => Number(match[1]));
        expect(values).toHaveLength(audio[index].channels);
        expect(values.every(value => value > -35 && value < -20)).toBe(true);
      }
    });
  }

  it('拒絕有 UDF 字樣卻沒有合法 anchor 的損壞映像', async () => {
    const bytes = readFileSync(generated.get('bd-iso').outPath);
    bytes.writeUInt16LE(0, 256 * 2048);
    const corrupt = path.join(directory, 'corrupt.iso');
    writeFileSync(corrupt, bytes);
    await expect(verifyDiscIso('bd-iso', corrupt)).rejects.toMatchObject({ code: 'INVALID_DISC_ISO' });
    await expect(verifyDiscIso('dvd-iso', generated.get('bd-iso').outPath)).rejects.toMatchObject({ code: 'INVALID_DISC_ISO' });
  });

  it('DVD 長片預算降低實際 VOB／ISO 碼率，muxrate 不會把成品補滿為 10.08 Mbps', async () => {
    const sizes = [];
    for (const duration of [10, 10000]) {
      const work = await prepareDiscOutput('dvd-iso', { tempDir: directory });
      try {
        const encoding = discEncoding('dvd-iso', { duration });
        const encoded = run(FFMPEG, ['-v', 'warning', '-nostdin', '-y', '-f', 'lavfi', '-i',
          'testsrc2=size=720x480:rate=30000/1001:duration=10', '-f', 'lavfi', '-i',
          'sine=frequency=880:sample_rate=48000:duration=10', '-map', '0:v', '-map', '1:a', '-ac', '2',
          ...encoding.videoArgs, ...encoding.audioArgs, ...encoding.muxArgs, work.encodedPath]);
        expect(encoded.stderr).not.toMatch(/underflow|overflow|non.?monoton/i);
        const result = await finalizeDiscOutput('dvd-iso', work.encodedPath,
          path.join(directory, `dvd-budget-${duration}.iso`), { nativePaths: NATIVE });
        const vobBytes = (await fs.stat(path.join(work.workDir, 'dvd/VIDEO_TS/VTS_01_1.VOB'))).size;
        const plannedBytes = (encoding.videoKbps + encoding.audioKbps) * 1000 / 8 * 10;
        expect(vobBytes).toBeGreaterThan(plannedBytes * 0.85);
        expect(vobBytes).toBeLessThan(plannedBytes * 1.10);
        expect(result.bytes).toBeLessThan(plannedBytes * 1.10 + 1024 * 1024);
        sizes.push({ vobBytes, isoBytes: result.bytes });
      } finally { await cleanupDiscOutput(work, { tempDir: directory }); }
    }
    expect(sizes[1].vobBytes).toBeLessThan(sizes[0].vobBytes * 0.65);
    expect(sizes[1].isoBytes).toBeLessThan(sizes[0].isoBytes * 0.65);
  });

  it('開始寫成品前的 callback 拒絕會保留既有 ISO，缺合成器也不宣告開始寫入', async () => {
    const outPath = path.join(directory, 'existing.iso');
    writeFileSync(outPath, 'existing output');
    const onProcess = vi.fn();
    const onOutputStart = vi.fn(async () => { throw Object.assign(new Error('lease rejected'), { code: 'LEASE_REJECTED' }); });
    await expect(finalizeDiscOutput('bd-iso', generated.get('bd-iso').work.encodedPath, outPath,
      { audioPlan: AUDIO, nativePaths: NATIVE, onProcess, onOutputStart })).rejects.toMatchObject({ code: 'LEASE_REJECTED' });
    expect(onOutputStart).toHaveBeenCalledOnce();
    expect(onProcess).not.toHaveBeenCalled();
    expect(readFileSync(outPath, 'utf8')).toBe('existing output');
    onOutputStart.mockClear();
    await expect(finalizeDiscOutput('bd-iso', generated.get('bd-iso').work.encodedPath, outPath,
      { audioPlan: AUDIO, nativePaths: { tsmuxer: path.join(directory, 'missing.exe') }, onOutputStart }))
      .rejects.toMatchObject({ code: 'DISC_NATIVE_MISSING' });
    expect(onOutputStart).not.toHaveBeenCalled();
  });

  it('取消會等原生程序退出；lease callback 拒絕也不留下寫入者', async () => {
    for (const cancel of [true, false]) {
      const controller = new AbortController();
      let process;
      const promise = finalizeDiscOutput('bd-iso', generated.get('bd-iso').work.encodedPath,
        path.join(directory, `cancel-${cancel}.iso`), { audioPlan: AUDIO, nativePaths: NATIVE, signal: controller.signal,
          onProcess: async child => {
            process = child;
            await new Promise(resolve => setTimeout(resolve, 1));
            if (cancel) controller.abort();
            else throw Object.assign(new Error('lease rejected'), { code: 'LEASE_REJECTED' });
          },
        });
      await expect(promise).rejects.toMatchObject({ code: cancel ? 'ABORT_ERR' : 'LEASE_REJECTED' });
      expect(process.exitCode !== null || process.signalCode !== null).toBe(true);
    }
  });

  it('cleanup 只移除由本工作建立的直接子目錄', async () => {
    const work = await prepareDiscOutput('dvd-iso', { tempDir: directory });
    await expect(cleanupDiscOutput({ workDir: directory }, { tempDir: directory })).rejects.toMatchObject({ code: 'INVALID_DISC_TEMP' });
    await cleanupDiscOutput(work, { tempDir: directory });
    expect(existsSync(work.workDir)).toBe(false);
  });
});
