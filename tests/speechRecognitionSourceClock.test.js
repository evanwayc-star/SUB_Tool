// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/events.js', () => ({ emit: vi.fn(), on: vi.fn() }));
vi.mock('../src/history.js', () => ({ recordHistory: vi.fn() }));
vi.mock('../src/ui.js', () => ({ openModal: vi.fn(), closeModal: vi.fn(), showToast: vi.fn() }));
vi.mock('../src/decode/source-frame-index.js', () => ({ sourcePresentationMetadata: vi.fn() }));

import { sourcePresentationMetadata } from '../src/decode/source-frame-index.js';
import { AudioEngine } from '../src/audio-engine.js';
import { getClipAudioBuffer } from '../src/speech-recognition.js';

function pcm(channels, rate = 16000) {
  const data = channels.map(channel => Float32Array.from(channel));
  return { numberOfChannels: data.length, sampleRate: rate, length: data[0].length,
    duration: data[0].length / rate, getChannelData: channel => data[channel] };
}

let decoded;
const context = { state: 'running', destination: {}, createGain: () => ({ connect() {} }),
  createAnalyser: () => ({ fftSize: 8 }), decodeAudioData: async () => decoded,
  createBuffer: (channels, length, rate) => pcm(Array.from({ length: channels }, () => Array(length).fill(0)), rate) };
const metadata = { presentationTimestampOffset: -5 - 3 / 16000, duration: 5 / 16000,
  audioPresentationTimestampOffset: -4, decoderAudioPresentationTimestampOffsets: [-5, -5 - 1 / 16000, null] };

beforeEach(() => {
  vi.restoreAllMocks();
  sourcePresentationMetadata.mockReset().mockResolvedValue(metadata);
  Object.defineProperty(window, 'subtool', { configurable: true, value: undefined });
  window.AudioContext = function () { return context; };
  decoded = pcm([[.1, .2, .3, .4, .5, .6, .7, .8]]);
});

describe('ASR original audio source clock admission', () => {
  it.each(['default', 'injected'])('normalizes %s decoding and existing top-level buffers through the same owner', async mode => {
    const clip = { web: { url: 'blob:mother' }, file: { arrayBuffer: async () => new ArrayBuffer(4) } };
    const options = mode === 'injected' ? { decodeAudioData: vi.fn(async () => decoded) } : {};
    const result = await getClipAudioBuffer(clip, options);
    expect([...result.getChannelData(0)]).toEqual([.4, .5, .6, .7, .8].map(Math.fround));
    expect(result.length).toBe(5);
    const fromBuffer = await getClipAudioBuffer({ web: clip.web, audioBuffer: decoded });
    expect([...fromBuffer.getChannelData(0)]).toEqual([...result.getChannelData(0)]);
    expect([...decoded.getChannelData(0)]).toEqual([.1, .2, .3, .4, .5, .6, .7, .8].map(Math.fround));
  });

  it('uses the selected original stream clock and preserves a stream with unknown decoded epoch', async () => {
    const track = { sourceStream: 1, sourceChannel: 0, buffer: decoded };
    const result = await getClipAudioBuffer({ web: { url: 'blob:mother' }, recognitionTracks: [track] }, {
      recognitionSelection: { mode: 'source-channels', channels: [{ sourceStream: 1, sourceChannel: 0 }] }
    });
    expect([...result.getChannelData(0)]).toEqual([.3, .4, .5, .6, .7].map(Math.fround));
    const unknown = await getClipAudioBuffer({ web: { url: 'blob:mother' }, recognitionTracks: [
      { ...track, sourceStream: 2 }
    ] });
    expect([...unknown.getChannelData(0)]).toEqual([...decoded.getChannelData(0)]);
  });

  it('native source-zero caches and effects never shift against the original container clock', async () => {
    const cached = await getClipAudioBuffer({ path: 'mother.mov', preferCache: true,
      recognitionTracks: [{ sourceStream: 4, sourceChannel: 0, buffer: decoded }] });
    expect([...cached.getChannelData(0)]).toEqual([...decoded.getChannelData(0)]);
    const effect = await getClipAudioBuffer({ path: 'mother.mov', recognitionTracks: [
      { sourceStream: 1, sourceChannel: 0, buffer: pcm([[.2, .3]]), _audioEffect: true }
    ] });
    expect([...effect.getChannelData(0)]).toEqual([.2, .3].map(Math.fround));
    expect(sourcePresentationMetadata).not.toHaveBeenCalled();
  });

  it('inherited original mono buffers retain their clock proof and do not shift a second time', async () => {
    const normalized = await AudioEngine.normalizeSourceAudioBuffer(decoded, { metadata });
    const mono = AudioEngine.inheritSourceAudioClock(normalized, pcm([[.4, .5, .6, .7, .8]]));
    const result = await getClipAudioBuffer({ web: { url: 'blob:mother' }, recognitionTracks: [
      { sourceStream: 0, sourceChannel: 0, buffer: mono }
    ] });
    expect([...result.getChannelData(0)]).toEqual([...mono.getChannelData(0)]);
    expect(await getClipAudioBuffer({ web: { url: 'blob:mother' }, audioBuffer: result })).toBe(result);
    expect(sourcePresentationMetadata).not.toHaveBeenCalled();
  });

  it('a buffer with a desktop path obtains only an authorized URL for source metadata', async () => {
    const fileURL = vi.fn(async () => 'subtool-local://source/mother');
    Object.defineProperty(window, 'subtool', { configurable: true, value: { fileURL } });
    const result = await getClipAudioBuffer({ path: 'C:\\media\\mother.mov', audioBuffer: decoded });
    expect(fileURL).toHaveBeenCalledWith('C:\\media\\mother.mov');
    expect(sourcePresentationMetadata).toHaveBeenCalledWith('subtool-local://source/mother', expect.any(Object));
    expect(result.getChannelData(0)[0]).toBe(Math.fround(.4));
  });

  it('replacement without an AbortSignal rejects before decoding and after a pending decoder', async () => {
    const decodeAudioData = vi.fn(async () => decoded);
    const clip = { web: { url: 'blob:mother' }, file: { arrayBuffer: async () => new ArrayBuffer(4) } };
    await expect(getClipAudioBuffer(clip, { owns: () => false, decodeAudioData })).rejects.toMatchObject({ name: 'AbortError' });
    expect(decodeAudioData).not.toHaveBeenCalled();
    let finish, owns = true;
    decodeAudioData.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = getClipAudioBuffer(clip, { owns: () => owns, decodeAudioData });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    owns = false; finish(decoded);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(sourcePresentationMetadata).not.toHaveBeenCalled();
  });

  it('cancellation during a source header read rejects the late buffer', async () => {
    let finish;
    sourcePresentationMetadata.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const controller = new AbortController();
    const pending = getClipAudioBuffer({ web: { url: 'blob:mother' }, audioBuffer: decoded }, { signal: controller.signal });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    controller.abort(); finish(metadata);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
