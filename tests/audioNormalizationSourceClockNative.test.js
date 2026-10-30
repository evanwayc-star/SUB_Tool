// @subtool-ci windows
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { nativeTestTools } from './fixtures/native-tools.cjs';

const require = createRequire(import.meta.url);
const { createAudioNormalizationRuntime } = require('../electron/audio-normalization-runtime.js');
const { createFFmpegExecution } = require('../electron/ffmpeg-execution-engine.js');
const { createMediaProbe } = require('../electron/media-probe.js');
const { audioLimiterFilter } = require('../shared/audio-loudness.cjs');
const { ffmpeg: FFMPEG, ffprobe: FFPROBE } = nativeTestTools();
function amplitude(bytes, frequency, start = .62, end = .78) {
  const first = Math.round(start * 4000), last = Math.round(end * 4000);
  let sine = 0, cosine = 0;
  for (let index = first; index < last; index++) {
    const sample = bytes.readFloatLE(index * 4), phase = 2 * Math.PI * frequency * index / 4000;
    sine += sample * Math.sin(phase); cosine += sample * Math.cos(phase);
  }
  return 2 * Math.hypot(sine, cosine) / (last - first);
}

describe.skipIf(!fs.existsSync(FFMPEG) || !fs.existsSync(FFPROBE))('平衡化預覽 WAV 的來源時鐘', () => {
  it.each([[.1, -80], [1, -80], [1, -72]])('整體響度為 -inf 的 %s 秒、峰值 %s dB 底噪在預覽與交付保持原音', async (duration, peakDb) => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-normalization-clock-native-'));
    const source = path.join(directory, 'low-level.wav');
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => directory });
    const run = args => {
      const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], {
        cwd: directory, windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024,
      });
      expect(result.error || result.status, result.stderr?.toString()).toBe(0);
      return result.stdout;
    };
    const runtime = createAudioNormalizationRuntime({ createTempPath: () => path.join(directory, 'preview.wav'),
      execute: (args, options) => execution.execute(args, { ...options, executionKind: 'direct' }),
      removeFile: file => fs.promises.unlink(file),
    });
    try {
      run(['-y', '-f', 'lavfi', '-i', `aevalsrc=${10 ** (peakDb / 20)}*sin(2*PI*440*t):s=48000:d=${duration}`, '-c:a', 'pcm_f32le', source]);
      const result = await runtime.normalize(source, { maximumAmplitude: -6, targetLoudness: -12 });
      const sourcePcm = run(['-i', source, '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1']);
      const preview = run(['-i', result.outputPath, '-f', 's16le', 'pipe:1']);
      expect(preview.length).toBe(Math.round(duration * 48000) * 2);
      expect(preview.equals(sourcePcm), '缺少整體響度不應把低於門檻的底噪放大').toBe(true);
      expect(result.isSilence).toBe(true);
      expect(result.report.input_i).toBe('-inf');
      expect(Number(result.report.input_tp)).toBeCloseTo(peakDb, 1);
      const filter = audioLimiterFilter({ max: -6, min: -12, reports: { 0: result.report } });
      expect(filter).toBe('anull');
      const delivered = run(['-i', source, '-af', `${filter},aresample=48000:async=1:first_pts=0`, '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1']);
      expect(delivered).toEqual(sourcePcm);
    } finally {
      await execution.cancelAllAndWait();
      const resolved = fs.realpathSync(directory);
      if (path.dirname(resolved) !== fs.realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-normalization-clock-native-')) throw new Error('拒絕清除未核對的平衡化時鐘測試目錄');
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 30000);

  it('相對門檻低於 -70 但整體響度高於 -70 的實際音訊仍套用效果', async () => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-normalization-clock-native-'));
    const source = path.join(directory, 'quiet.wav');
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => directory });
    const run = args => {
      const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], {
        cwd: directory, windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024,
      });
      expect(result.error || result.status, result.stderr?.toString()).toBe(0);
      return result.stdout;
    };
    const runtime = createAudioNormalizationRuntime({ createTempPath: () => path.join(directory, 'preview.wav'),
      execute: (args, options) => execution.execute(args, { ...options, executionKind: 'direct' }),
      removeFile: file => fs.promises.unlink(file),
    });
    try {
      run(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1,volume=-39dB', '-c:a', 'pcm_s16le', source]);
      const result = await runtime.normalize(source, { maximumAmplitude: -6, targetLoudness: -12 });
      expect(result.isSilence).toBe(false);
      expect(Number(result.report.input_i)).toBeGreaterThan(-70);
      expect(Number(result.report.input_thresh)).toBeLessThan(-70);
      const filter = audioLimiterFilter({ max: -6, min: -12, reports: { 0: result.report } });
      const sourcePcm = run(['-i', source, '-f', 's16le', 'pipe:1']);
      const preview = run(['-i', result.outputPath, '-f', 's16le', 'pipe:1']);
      const delivered = run(['-i', source, '-af', `${filter},aresample=48000:async=1:first_pts=0`, '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1']);
      expect(preview.length).toBe(sourcePcm.length);
      expect(preview).not.toEqual(sourcePcm);
      expect(delivered).toEqual(preview);
    } finally {
      await execution.cancelAllAndWait();
      const resolved = fs.realpathSync(directory);
      if (path.dirname(resolved) !== fs.realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-normalization-clock-native-')) throw new Error('拒絕清除未核對的平衡化時鐘測試目錄');
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 30000);

  it('100ms 可聽短音的整體響度為 -inf 時，預覽與交付仍處理實際峰值', async () => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-normalization-clock-native-'));
    const source = path.join(directory, 'short.wav');
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => directory });
    const run = args => {
      const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], {
        cwd: directory, windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024,
      });
      expect(result.error || result.status, result.stderr?.toString()).toBe(0);
      return result.stdout;
    };
    let pass1Stderr = '';
    const runtime = createAudioNormalizationRuntime({ createTempPath: () => path.join(directory, 'preview.wav'),
      execute: (args, options) => execution.execute(args, { ...options, executionKind: 'direct', onStderr: chunk => {
        if (options.jobId === 'loudnorm-p1') pass1Stderr += chunk;
        options.onStderr?.(chunk);
      } }),
      removeFile: file => fs.promises.unlink(file),
    });
    const options = { isTruePeak: true, maximumAmplitude: -6, targetLoudness: -12 };
    try {
      run(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.1,volume=8', '-c:a', 'pcm_s16le', source]);
      const result = await runtime.normalize(source, options);
      expect(pass1Stderr).toMatch(/"input_i"\s*:\s*"-inf"/);
      expect(pass1Stderr).toMatch(/"input_tp"\s*:\s*"-0\.00"/);
      expect(result.isSilence).toBe(false);
      expect(result.report).toBeNull();
      const analysis = await runtime.analyze(source);
      expect(analysis.maxDb).toBeGreaterThan(-1);
      expect(analysis.meanDb).toBeGreaterThan(-5);
      expect(analysis.isSilence).toBe(false);
      expect(analysis.meanSource).toBe('volumedetect');
      const preview = run(['-i', result.outputPath, '-f', 's16le', 'pipe:1']);
      const delivered = run(['-i', source, '-af', `${audioLimiterFilter(options)},aresample=48000:async=1:first_pts=0`, '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1']);
      expect(preview.length).toBeGreaterThan(0);
      expect(delivered).toEqual(preview);
      let peak = 0;
      for (let offset = 0; offset < preview.length; offset += 2) peak = Math.max(peak, Math.abs(preview.readInt16LE(offset)) / 32768);
      expect(peak).toBeGreaterThan(.1);
      expect(peak).toBeLessThan(.55);
    } finally {
      await execution.cancelAllAndWait();
      const resolved = fs.realpathSync(directory);
      if (path.dirname(resolved) !== fs.realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-normalization-clock-native-')) throw new Error('拒絕清除未核對的平衡化時鐘測試目錄');
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 30000);

  it('實際靜音量測的 inf 偏移可保存，使預覽與交付均維持靜音保護', async () => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-normalization-clock-native-'));
    const source = path.join(directory, 'silence.wav');
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => directory });
    const run = args => {
      const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], {
        cwd: directory, windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024,
      });
      expect(result.error || result.status, result.stderr?.toString()).toBe(0);
      return result.stdout;
    };
    const runtime = createAudioNormalizationRuntime({
      createTempPath: () => path.join(directory, 'preview.wav'),
      execute: (args, options) => execution.execute(args, { ...options, executionKind: 'direct' }),
      removeFile: file => fs.promises.unlink(file),
    });
    try {
      run(['-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=1', '-c:a', 'pcm_s16le', source]);
      const result = await runtime.normalize(source, { maximumAmplitude: -6, targetLoudness: -12 });
      expect(result.isSilence).toBe(true);
      expect(result.report).toMatchObject({ input_i: '-inf', input_tp: '-inf', target_offset: 'inf' });
      const filter = audioLimiterFilter({ max: -6, min: -12, reports: { 0: result.report } });
      expect(filter).toBe('anull');
      const preview = run(['-i', result.outputPath, '-f', 'f32le', 'pipe:1']);
      const delivered = run(['-i', source, '-af', filter, '-f', 'f32le', 'pipe:1']);
      expect(preview.length).toBe(48000 * 4);
      expect(delivered).toEqual(preview);
      for (let offset = 0; offset < delivered.length; offset += 4) expect(delivered.readFloatLE(offset)).toBe(0);
    } finally {
      await execution.cancelAllAndWait();
      const resolved = fs.realpathSync(directory);
      if (path.dirname(resolved) !== fs.realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-normalization-clock-native-')) throw new Error('拒絕清除未核對的平衡化時鐘測試目錄');
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 30000);

  it('第一遍輸出報告後失敗時，實際 PCM 與單遍交付濾鏡一致', async () => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-normalization-clock-native-'));
    const source = path.join(directory, 'mother.wav');
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => directory });
    const run = args => {
      const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], {
        cwd: directory, windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024,
      });
      expect(result.error || result.status, result.stderr?.toString()).toBe(0);
      return result.stdout;
    };
    let pass1Stderr = '';
    const runtime = createAudioNormalizationRuntime({
      createTempPath: () => path.join(directory, 'processed.wav'),
      execute: async (args, options) => {
        const result = await execution.execute(args, {
          ...options, executionKind: 'direct', onStderr: chunk => {
            options.onStderr?.(chunk);
            if (options.jobId === 'loudnorm-p1') pass1Stderr += chunk;
          },
        });
        if (options.jobId === 'loudnorm-p1') throw new Error('injected failure after actual FFmpeg report');
        return result;
      },
      removeFile: file => fs.promises.unlink(file),
    });
    const options = { isTruePeak: true, maximumAmplitude: -6, targetLoudness: -12 };
    const originalWarn = console.warn;
    try {
      run(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:a', 'pcm_s16le', source]);
      console.warn = () => {};
      const result = await runtime.normalize(source, options);
      expect(pass1Stderr).toContain('target_offset');
      expect(result.report).toBeNull();
      const preview = run(['-i', result.outputPath, '-f', 's16le', 'pipe:1']);
      const delivery = run(['-i', source, '-af', `${audioLimiterFilter(options)},aresample=48000:async=1:first_pts=0`, '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1']);
      expect(preview.length).toBeGreaterThan(0);
      expect(preview).toEqual(delivery);
    } finally {
      console.warn = originalWarn;
      await execution.cancelAllAndWait();
      const resolved = fs.realpathSync(directory);
      if (path.dirname(resolved) !== fs.realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-normalization-clock-native-')) throw new Error('拒絕清除未核對的平衡化時鐘測試目錄');
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 30000);

  it.each([1, 7, 50])('Peak 預先讀取 %s ms：預覽、重做與交付濾鏡保留首尾脈衝樣本', async lookAheadTime => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-normalization-clock-native-'));
    const rate = 48000, pulseSamples = [0, 24000, 47999], input = Buffer.alloc(rate * 4);
    for (const sample of pulseSamples) input.writeFloatLE(.125, sample * 4);
    const run = (args, bytes) => {
      const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], {
        input: bytes, windowsHide: true, timeout: 20000, maxBuffer: 2 * 1024 * 1024,
      });
      expect(result.error || result.status, result.stderr?.toString()).toBe(0);
      return result.stdout;
    };
    const source = path.join(directory, 'impulses.wav'), probe = createMediaProbe({ executable: FFPROBE });
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => directory });
    let serial = 0;
    const runtime = createAudioNormalizationRuntime({
      createTempPath: () => path.join(directory, `processed-${serial++}.wav`),
      probe: (file, options) => probe.describe(file, options),
      execute: (args, options) => execution.execute(args, { ...options, executionKind: 'direct' }),
      removeFile: file => fs.promises.unlink(file),
    });
    const expectPulses = bytes => {
      expect(bytes.length / 4).toBe(rate);
      const actual = [];
      for (let sample = 0; sample < rate; sample++) {
        if (Math.abs(bytes.readFloatLE(sample * 4)) > .01) actual.push(sample);
      }
      expect(actual).toEqual(pulseSamples);
      for (const sample of pulseSamples) expect(bytes.readFloatLE(sample * 4)).toBeCloseTo(.125, 4);
    };
    const options = { isTruePeak: false, inputBoost: 0, maximumAmplitude: -6, lookAheadTime };
    const decode = file => run(['-i', file, '-f', 'f32le', 'pipe:1']);
    try {
      run(['-y', '-f', 'f32le', '-ar', String(rate), '-ac', '1', '-i', 'pipe:0', '-c:a', 'pcm_s16le', source], input);
      const first = await runtime.normalize(source, options);
      expectPulses(decode(first.outputPath));
      const second = await runtime.normalize(first.outputPath, options);
      expectPulses(decode(second.outputPath));
      expectPulses(run(['-i', source, '-af', audioLimiterFilter(options), '-f', 'f32le', 'pipe:1']));
    } finally {
      await execution.cancelAllAndWait(); await probe.cancelAllAndWait();
      const resolved = fs.realpathSync(directory);
      if (path.dirname(resolved) !== fs.realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-normalization-clock-native-')) throw new Error('拒絕清除未核對的平衡化時鐘測試目錄');
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it.each([0, 5])('容器原點 %s：Peak／True Peak／無聲／指定 delayed stream／再處理保持來源秒數', async origin => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-normalization-clock-native-'));
    const run = args => {
      const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], {
        cwd: directory, windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024,
      });
      expect(result.error || result.status, result.stderr?.toString()).toBe(0); return result.stdout;
    };
    const source = path.join(directory, 'mother.mkv'), probe = createMediaProbe({ executable: FFPROBE });
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => directory });
    let serial = 0;
    const runtime = createAudioNormalizationRuntime({ createTempPath: () => path.join(directory, `processed-${serial++}.wav`),
      probe: (file, options) => probe.describe(file, options),
      execute: (args, options) => execution.execute(args, { ...options, executionKind: 'direct' }),
      removeFile: file => fs.promises.unlink(file) });
    const decode = file => run(['-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '4000', '-f', 'f32le', 'pipe:1']);
    const expectSourceClock = bytes => {
      expect(bytes.length / 4 / 4000).toBe(3);
      const wanted = amplitude(bytes, 880);
      expect(wanted).toBeGreaterThan(.02); expect(amplitude(bytes, 440)).toBeLessThan(wanted * .04);
    };
    try {
      run(['-y', '-itsoffset', String(origin + .5), '-f', 'lavfi', '-i', 'color=red:s=64x48:r=30:d=3',
        '-itsoffset', String(origin), '-f', 'lavfi', '-i',
        'aevalsrc=if(lt(t\\,1)\\,0.12*sin(2*PI*440*t)\\,0.12*sin(2*PI*880*t)):s=48000:d=3.5',
        '-itsoffset', String(origin + 1.5), '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=2',
        '-itsoffset', String(origin), '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=3.5',
        '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0', '-map', '3:a:0',
        '-c:v', 'libx264', '-fps_mode:v', 'passthrough', '-c:a', 'pcm_s16le', source]);
      for (const isTruePeak of [false, true]) {
        const first = await runtime.normalize(source, { sourceStream: 0, isTruePeak, maximumAmplitude: -3, targetLoudness: -14 });
        expectSourceClock(decode(first.outputPath));
        const second = await runtime.normalize(first.outputPath, { isTruePeak, maximumAmplitude: -3, targetLoudness: -14 });
        expectSourceClock(decode(second.outputPath));
        expect((await probe.describe(second.outputPath)).audio[0].timestampOffset).toBe(0);
        const delayed = await runtime.normalize(source, { sourceStream: 1, isTruePeak, maximumAmplitude: -3, targetLoudness: -14 });
        const pcm = decode(delayed.outputPath);
        expect(pcm.length / 4 / 4000).toBe(3);
        expect(amplitude(pcm, 660, .2, .8)).toBeLessThan(.00001);
        expect(amplitude(pcm, 660, 1.12, 1.28)).toBeGreaterThan(.02);
      }
      const silent = await runtime.normalize(source, { sourceStream: 2, isTruePeak: true, silenceProtection: true });
      expect(silent.isSilence).toBe(true); const silence = decode(silent.outputPath);
      expect(silence.length / 4 / 4000).toBe(3);
      for (let index = 0; index < silence.length; index += 4) expect(silence.readFloatLE(index)).toBe(0);
    } finally {
      await execution.cancelAllAndWait(); await probe.cancelAllAndWait();
      const resolved = fs.realpathSync(directory);
      if (path.dirname(resolved) !== fs.realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-normalization-clock-native-')) throw new Error('拒絕清除未核對的平衡化時鐘測試目錄');
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 30000);
});
