// @subtool-ci windows
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { nativeTestTools } from './fixtures/native-tools.cjs';

const require = createRequire(import.meta.url);
const { createSpeechAudioReader } = require('../electron/speech-audio-reader.js');
const { descriptorOf } = require('../electron/media-probe.js');
const { ffmpeg, ffprobe } = nativeTestTools();
const directories = [], readers = [];
const rate = 16000;

function run(binary, args) {
  const result = spawnSync(binary, args, { windowsHide: true, timeout: 15000, maxBuffer: 8 << 20 });
  expect(result.error || result.status, result.stderr?.toString()).toBe(0);
  return result.stdout;
}

function amplitude(samples, seconds, frequency) {
  const first = Math.round(seconds * rate), count = 1600;
  let sine = 0, cosine = 0;
  for (let index = 0; index < count; index++) {
    const phase = 2 * Math.PI * frequency * index / rate;
    sine += samples[first + index] * Math.sin(phase);
    cosine += samples[first + index] * Math.cos(phase);
  }
  return 2 * Math.hypot(sine, cosine) / count;
}

function fixture(origin, lateAudio = false) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-speech-native-'));
  directories.push(dir);
  const mother = path.join(dir, '母片 # source.mov');
  const frequency = 'if(lt(t\\,0.5)\\,440\\,880)';
  run(ffmpeg, ['-v', 'error', '-nostdin', '-y',
    '-itsoffset', String(origin + .5), '-f', 'lavfi', '-i', 'color=red:s=64x48:r=24:d=4',
    '-itsoffset', String(origin + (lateAudio ? 1 : 0)), '-f', 'lavfi', '-i',
    `aevalsrc=0.2*sin(2*PI*${frequency}*t)|0.2*sin(2*PI*1320*t):s=48000:d=3`,
    '-itsoffset', String(origin + (lateAudio ? 1 : 0)), '-f', 'lavfi', '-i',
    'aevalsrc=0.2*sin(2*PI*1760*t):s=48000:d=3',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-c:a', 'pcm_s16le', mother]);
  const probe = async file => descriptorOf(JSON.parse(run(ffprobe,
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file])));
  const runtime = createSpeechAudioReader({ getFFmpegPath: () => ffmpeg, probe });
  readers.push(runtime);
  const sender = new EventEmitter(); sender.isDestroyed = () => false;
  let counter = 0;
  const read = async (start, duration, extra = {}) => {
    const result = await runtime.read(sender, { path: mother, start, duration,
      sourceStream: 0, sourceChannel: 0, processed: false, requestId: `native-${++counter}`, ...extra });
    expect(result.sampleRate).toBe(rate);
    expect(result.numberOfChannels).toBe(1);
    expect(result.frames).toBe(Math.round(duration * rate));
    expect(result.pcm.byteLength).toBe(result.frames * 4);
    expect(runtime.activeCount()).toBe(0);
    expect(sender.listenerCount('destroyed')).toBe(0);
    return new Float32Array(result.pcm);
  };
  return { read, mother, dir };
}

afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.cancelAllAndWait();
  for (const dir of directories.splice(0)) {
    const real = fs.realpathSync(dir);
    if (path.dirname(real) !== fs.realpathSync(os.tmpdir()) || !path.basename(real).startsWith('subtool-speech-native-')) {
      throw new Error('speech fixture cleanup boundary');
    }
    fs.rmSync(real, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe.skipIf(!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe))('ASR native range PCM content', () => {
  it.each([0, 5])('epoch %s reads video source time, requested stream/channel and equal mono mix', async origin => {
    const { read } = fixture(origin);
    const first = await read(0, 1);
    expect(amplitude(first, .1, 880)).toBeGreaterThan(.19);
    expect(amplitude(first, .1, 440)).toBeLessThan(.002);
    const later = await read(1.25, .5);
    expect(amplitude(later, .1, 880)).toBeGreaterThan(.19);
    const right = await read(.3, .5, { sourceChannel: 1 });
    expect(amplitude(right, .1, 1320)).toBeGreaterThan(.19);
    expect(amplitude(right, .1, 880)).toBeLessThan(.002);
    const secondStream = await read(.3, .5, { sourceStream: 1, sourceChannel: 0 });
    expect(amplitude(secondStream, .1, 1760)).toBeGreaterThan(.19);
    const mixed = await read(.3, .5, { sourceChannel: null });
    expect(amplitude(mixed, .1, 880)).toBeCloseTo(.1, 2);
    expect(amplitude(mixed, .1, 1320)).toBeCloseTo(.1, 2);
    const ended = await read(3.5, .5);
    expect(ended.every(sample => sample === 0)).toBe(true);
  });

  it('late audio keeps leading silence and source-zero processed cache does not shift twice', async () => {
    const { read, dir } = fixture(5, true);
    const first = await read(0, 1);
    expect(first.subarray(0, 7000).every(sample => sample === 0)).toBe(true);
    expect(amplitude(first, .6, 440)).toBeGreaterThan(.19);
    const cache = path.join(dir, 'processed.wav');
    run(ffmpeg, ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i',
      'aevalsrc=0.2*sin(2*PI*2200*t):s=48000:d=2', '-c:a', 'pcm_s16le', cache]);
    const processed = await read(.2, .5, { path: cache, processed: true });
    expect(amplitude(processed, .1, 2200)).toBeGreaterThan(.19);
    expect(amplitude(processed, .1, 440)).toBeLessThan(.002);
  });
});
