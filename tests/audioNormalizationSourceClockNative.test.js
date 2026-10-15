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
