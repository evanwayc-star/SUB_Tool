// @subtool-ci windows
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { File } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { nativeTestTools } from './fixtures/native-tools.cjs';

vi.mock('../src/events.js', () => ({ emit: vi.fn(), on: vi.fn() }));
vi.mock('../src/history.js', () => ({ recordHistory: vi.fn() }));
vi.mock('../src/ui.js', () => ({ openModal: vi.fn(), closeModal: vi.fn(), showToast: vi.fn() }));

import { AudioEngine } from '../src/audio-engine.js';
import { getClipAudioBuffer } from '../src/speech-recognition.js';
import { sourcePresentationMetadata, clearSourceFrameIndexes } from '../src/decode/source-frame-index.js';

const { ffmpeg, ffprobe } = nativeTestTools(), directories = [];
const pcm = (samples, rate = 48000) => ({ sampleRate: rate, numberOfChannels: 1,
  length: samples.length, duration: samples.length / rate, getChannelData: () => samples });
let original;
const context = { state: 'running', destination: {}, createGain: () => ({ connect() {} }),
  createAnalyser: () => ({ fftSize: 8 }), decodeAudioData: async () => original,
  createBuffer: (_channels, length, rate) => pcm(new Float32Array(length), rate) };

function amplitude(buffer, start, frequency) {
  const first = Math.round(start * buffer.sampleRate), count = Math.round(.1 * buffer.sampleRate), samples = buffer.getChannelData(0);
  let sine = 0, cosine = 0;
  for (let index = 0; index < count; index++) {
    const phase = 2 * Math.PI * frequency * index / buffer.sampleRate;
    sine += samples[first + index] * Math.sin(phase); cosine += samples[first + index] * Math.cos(phase);
  }
  return 2 * Math.hypot(sine, cosine) / count;
}

afterEach(() => {
  clearSourceFrameIndexes(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) {
    const resolved = fs.realpathSync(directory);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('subtool-asr-source-clock-')) {
      throw new Error('ASR fixture cleanup boundary');
    }
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe.skipIf(!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe))('public ASR original and processed PCM source clock', () => {
  it.each([0, 5].flatMap(origin => ['aac', 'pcm_s16le'].map(codec => ({ origin, codec })))
    .concat([{ origin: 5, codec: 'libopus' }]))
  ('true $codec epoch $origin: default File/URL/Element/track decoders use video source seconds', async ({ origin, codec }) => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-asr-source-clock-')); directories.push(directory);
    const opus = codec === 'libopus', filePath = path.join(directory, opus ? 'mother.webm' : 'mother.mov');
    const run = args => {
      const result = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], {
        windowsHide: true, timeout: 20000, maxBuffer: 4 << 20
      });
      expect(result.error || result.status, result.stderr?.toString()).toBe(0);
      return result.stdout;
    };
    run(['-y', '-itsoffset', String(origin + .5), '-f', 'lavfi', '-i', 'color=red:s=64x48:r=30:d=3',
      '-itsoffset', String(origin), '-f', 'lavfi', '-i', 'aevalsrc=if(lt(t\\,0.5)\\,0.12*sin(2*PI*440*t)\\,0.12*sin(2*PI*880*t)):s=48000:d=3.5',
      '-map', '0:v', '-map', '1:a', '-c:v', opus ? 'libvpx-vp9' : 'libx264', '-bf', '3', '-fps_mode', 'passthrough', '-c:a', codec, filePath]);
    const bytes = fs.readFileSync(filePath), encoded = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
    const raw = run(['-i', filePath, '-map', '0:a:0', '-ar', '48000', '-ac', '1', '-f', 'f32le', 'pipe:1']);
    original = pcm(new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length)));
    window.AudioContext = function () { return context; };
    const createObjectURL = vi.fn(() => `blob:asr-source-${origin}-${codec}`), revokeObjectURL = vi.fn();
    const NativeURL = URL;
    vi.stubGlobal('URL', class extends NativeURL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    });
    const readBytes = vi.fn(async (_url, { headers } = {}) => {
      const range = /bytes=(\d+)-(\d+)/.exec(headers?.Range || '');
      const part = range ? bytes.subarray(Number(range[1]), Number(range[2]) + 1) : bytes;
      return new Response(part, { status: range ? 206 : 200 });
    });
    vi.stubGlobal('fetch', readBytes);
    const metadata = await sourcePresentationMetadata(filePath);
    const decodedProbe = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'frame=pts_time',
      '-read_intervals', '%+#2', '-of', 'json', filePath], { windowsHide: true, timeout: 10000 });
    expect(decodedProbe.status, decodedProbe.stderr?.toString()).toBe(0);
    const firstDecoded = Number(JSON.parse(decodedProbe.stdout).frames[0].pts_time);
    const startSample = Math.round((origin + .5 - firstDecoded) * 48000);
    const reference = original.getChannelData(0).subarray(startSample, startSample + 48000);
    expect(amplitude(original, .1, 440)).toBeGreaterThan(.075);
    const sourceFile = new File([encoded], path.basename(filePath));
    const cases = [
      { file: sourceFile },
      { web: { url: filePath } },
      { audioElement: { src: filePath } },
      { audioBuffer: original, web: { url: filePath } },
      { recognitionTracks: [{ sourceStream: 0, sourceChannel: 0, buffer: original }], web: { url: filePath } }
    ];
    for (const clip of cases) {
      const result = await getClipAudioBuffer({ id: 'original', name: path.basename(filePath), ...clip });
      expect(result.length).toBe(Math.round(metadata.duration * 48000));
      expect([...result.getChannelData(0).subarray(0, 48000)]).toEqual([...reference]);
      for (const sourceTime of [.1, .6, 2.8]) {
        expect(amplitude(result, sourceTime, 880)).toBeGreaterThan(.075);
        expect(amplitude(result, sourceTime, 440)).toBeLessThan(.004);
      }
    }
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith(`blob:asr-source-${origin}-${codec}`);

    // Processed cache PCM is already source-zero even when its owning mother
    // has a nonzero epoch. Its bytes must not be shifted a second time.
    const processed = pcm(original.getChannelData(0).slice(startSample, startSample + Math.round(metadata.duration * 48000)));
    original = processed;
    const beforeReads = readBytes.mock.calls.length;
    const cache = await getClipAudioBuffer({ path: filePath, preferCache: true,
      recognitionTracks: [{ sourceStream: 0, sourceChannel: 0, el: { src: 'subtool-local://cache/mono.wav' } }] });
    expect([...cache.getChannelData(0)]).toEqual([...processed.getChannelData(0)]);
    expect(readBytes.mock.calls.length - beforeReads).toBe(1);
    const inherited = AudioEngine.inheritSourceAudioClock(AudioEngine.markSourceAudioBuffer(processed), pcm(processed.getChannelData(0).slice()));
    const inheritedResult = await getClipAudioBuffer({ web: { url: filePath }, recognitionTracks: [
      { sourceStream: 0, sourceChannel: 0, buffer: inherited }
    ] });
    expect([...inheritedResult.getChannelData(0)]).toEqual([...processed.getChannelData(0)]);
  }, 30000);
});
