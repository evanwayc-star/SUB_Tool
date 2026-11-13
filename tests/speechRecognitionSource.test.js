// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/events.js', () => ({ emit: vi.fn(), on: vi.fn() }));
vi.mock('../src/history.js', () => ({ recordHistory: vi.fn() }));
vi.mock('../src/ui.js', () => ({ renderCurrentTimecode: vi.fn(), openModal: vi.fn(), closeModal: vi.fn(), showToast: vi.fn() }));
vi.mock('../src/decode/source-frame-index.js', () => ({ sourcePresentationMetadata: vi.fn() }));
import { sourcePresentationMetadata } from '../src/decode/source-frame-index.js';
import { AudioEngine } from '../src/audio-engine.js';
import { getClipRecognitionSource, getRecognitionAudioSourceChoices } from '../src/speech-recognition.js';
import { clearAsrSession, startAsrWork } from '../src/speech-recognition-session.js';

const pcm = (channels, sampleRate = 16000) => {
  const data = channels.map(channel => Float32Array.from(channel));
  return { sampleRate, numberOfChannels: data.length, length: data[0].length,
    duration: data[0].length / sampleRate, getChannelData: channel => data[channel] };
};
const response = (value, duration) => {
  const samples = new Float32Array(Math.round(duration * 16000)).fill(value);
  return { sampleRate: 16000, numberOfChannels: 1, frames: samples.length, pcm: samples.buffer };
};
const channels = (...streams) => ({ mode: 'source-channels', channels: streams.map(sourceStream => ({ sourceStream, sourceChannel: 0 })) });
let bridge;
beforeEach(() => {
  clearAsrSession();
  vi.restoreAllMocks();
  sourcePresentationMetadata.mockReset().mockResolvedValue(null);
  bridge = { speechAudioRead: vi.fn(async request => response(request.path.includes('ch2') ? .4 : .2, request.duration)),
    speechAudioCancel: vi.fn(async () => {}), fileURL: vi.fn(async path => `subtool-local://${path}`) };
  window.subtool = bridge;
});

describe('bounded recognition source selection and lifetime', () => {
  const cached = () => ({ path: 'C:/mother.mxf', duration: 6313.54, in: 3000, out: 6000, dur: 3000, preferCache: true,
    recognitionTracks: [
      { sourceStream: 0, sourceChannel: 0, file: 'C:/cache/ch1.m4a', el: { src: 'subtool-local://one' } },
      { sourceStream: 1, sourceChannel: 0, file: 'C:/cache/ch2.m4a', el: { src: 'subtool-local://two' } }
    ] });
  it('reads a long source only in bounded source-clock ranges, mixing caches sequentially without browser decoding', async () => {
    const decode = vi.spyOn(AudioEngine, 'decodeAudioData');
    const fetchImpl = vi.fn();
    const source = await getClipRecognitionSource(cached(), { fetchImpl });
    expect(source.duration).toBe(6313.54);
    const window = await source.readRange(3000, 3000.01);
    expect(window).toMatchObject({ sampleRate: 16000, numberOfChannels: 1, length: 160, duration: .01 });
    expect([...window.getChannelData(0)]).toEqual(Array(160).fill(Math.fround(.3)));
    expect(bridge.speechAudioRead.mock.calls.map(([request]) => ({ ...request, requestId: 'id' }))).toEqual([
      { path: 'C:/cache/ch1.m4a', start: 3000, duration: expect.closeTo(.01), sourceStream: 0, sourceChannel: null, processed: true, requestId: 'id' },
      { path: 'C:/cache/ch2.m4a', start: 3000, duration: expect.closeTo(.01), sourceStream: 0, sourceChannel: null, processed: true, requestId: 'id' }
    ]);
    expect(decode).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
    await expect(source.readRange(0, 600.1)).rejects.toThrow(/600/);
    source.close();
    await expect(source.readRange(0, .01)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('freezes accepted resources, selects the requested original channel and never substitutes playback buses', async () => {
    const clip = cached();
    const source = await getClipRecognitionSource(clip, { recognitionSelection: channels(1) });
    clip.recognitionTracks[1].file = 'C:/replacement.m4a';
    const window = await source.readRange(10, 10.01);
    expect(window.getChannelData(0)[0]).toBeCloseTo(.4);
    expect(bridge.speechAudioRead).toHaveBeenCalledWith(expect.objectContaining({ path: 'C:/cache/ch2.m4a', sourceStream: 0, sourceChannel: 0, processed: true }));
    source.close();
    const original = await getClipRecognitionSource({ path: 'C:/mother.mov', duration: 10,
      recognitionTracks: [{ sourceStream: 2, sourceChannel: 4 }] }, {
      recognitionSelection: { mode: 'source-channels', channels: [{ sourceStream: 2, sourceChannel: 4 }] }
    });
    await original.readRange(1, 1.01);
    expect(bridge.speechAudioRead).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'C:/mother.mov', sourceStream: 2, sourceChannel: 4, processed: false }));
    original.close();
  });
  it('deduplicates shared mono caches while retaining every distinct selected channel', async () => {
    const clip = cached();
    clip.recognitionTracks.splice(1, 0, { ...clip.recognitionTracks[0], sourceStream: 8 });
    const source = await getClipRecognitionSource(clip);
    expect((await source.readRange(0, .01)).getChannelData(0)[0]).toBeCloseTo(.3);
    expect(bridge.speechAudioRead).toHaveBeenCalledTimes(2);
    source.close();
  });
  it('preserves 6+2 channel weights for native effects and projects one selected effect channel', async () => {
    const clip = { path: 'C:/mother.mov', duration: 10, recognitionTracks: [
      ...Array.from({ length: 6 }, (_, sourceChannel) => ({ sourceStream: 0, sourceChannel, file: 'C:/effect-surround.wav', _audioEffect: true })),
      ...Array.from({ length: 2 }, (_, sourceChannel) => ({ sourceStream: 1, sourceChannel, file: 'C:/effect-stereo.wav', _audioEffect: true }))
    ] };
    bridge.speechAudioRead.mockImplementation(async request => response(request.path.includes('surround') ? .8 : 0, request.duration));
    const all = await getClipRecognitionSource(clip);
    expect((await all.readRange(0, .01)).getChannelData(0)[0]).toBeCloseTo(.6);
    expect(bridge.speechAudioRead.mock.calls.map(([request]) => [request.sourceStream, request.sourceChannel, request.processed])).toEqual([[0, null, true], [0, null, true]]);
    const selected = await getClipRecognitionSource(clip, { recognitionSelection: {
      mode: 'source-channels', channels: [{ sourceStream: 0, sourceChannel: 4 }]
    } });
    await selected.readRange(0, .01);
    expect(bridge.speechAudioRead).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'C:/effect-surround.wav', sourceStream: 0, sourceChannel: 4 }));
    all.close(); selected.close();
  });
  it('retains all eight original stream/channel coordinates instead of averaging two stream means', async () => {
    const clip = { path: 'C:/mother.mov', out: 10, recognitionTracks: [
      ...Array.from({ length: 6 }, (_, sourceChannel) => ({ sourceStream: 0, sourceChannel })),
      ...Array.from({ length: 2 }, (_, sourceChannel) => ({ sourceStream: 1, sourceChannel }))
    ] };
    bridge.speechAudioRead.mockImplementation(async request => response(request.sourceStream === 0 ? .8 : 0, request.duration));
    const source = await getClipRecognitionSource(clip);
    expect((await source.readRange(0, .01)).getChannelData(0)[0]).toBeCloseTo(.6);
    expect(bridge.speechAudioRead.mock.calls.map(([request]) => [request.sourceStream, request.sourceChannel])).toEqual([[0,0],[0,1],[0,2],[0,3],[0,4],[0,5],[1,0],[1,1]]);
    source.close();
  });
  it('keeps 6+2 buffer channel weights, selection, and source clock while allocating only the requested window', async () => {
    const surround = pcm(Array.from({ length: 6 }, () => [.8, 0, .4, .2]));
    const stereo = pcm(Array.from({ length: 2 }, () => [0, .8, 0, .2]));
    const clip = { recognitionTracks: [
      ...Array.from({ length: 6 }, (_, sourceChannel) => ({ sourceStream: 0, sourceChannel, buffer: surround })),
      ...Array.from({ length: 2 }, (_, sourceChannel) => ({ sourceStream: 1, sourceChannel, buffer: stereo }))
    ] };
    const createBuffer = vi.spyOn(AudioEngine, 'createBuffer').mockImplementation(() => { throw new Error('whole-source clone'); });
    const all = await getClipRecognitionSource(clip);
    expect([...(await all.readRange(0, 2 / 16000)).getChannelData(0)]).toEqual([Math.fround(.6), Math.fround(.2)]);
    const tail = await getClipRecognitionSource(clip, { recognitionSelection: getRecognitionAudioSourceChoices(clip).find(choice => choice.value === 'tail').selection });
    expect([...(await tail.readRange(0, 2 / 16000)).getChannelData(0)]).toEqual([0, Math.fround(.8)]);
    expect(createBuffer).not.toHaveBeenCalled(); expect(bridge.speechAudioRead).not.toHaveBeenCalled();
    all.close(); tail.close();
  });
  it('uses unnormalized buffer clock metadata without copying the full PCM, and preserves inherited zero proof', async () => {
    sourcePresentationMetadata.mockResolvedValue({ presentationTimestampOffset: -5 - 3 / 16000,
      decoderAudioPresentationTimestampOffsets: [-5], duration: 5 / 16000 });
    const buffer = pcm([[.1, .2, .3, .4, .5, .6, .7, .8]]);
    const createBuffer = vi.spyOn(AudioEngine, 'createBuffer').mockImplementation(() => { throw new Error('whole-source clone'); });
    const source = await getClipRecognitionSource({ audioBuffer: buffer, web: { url: 'blob:mother' } });
    expect(source.duration).toBe(5 / 16000);
    expect([...(await source.readRange(1 / 16000, 3 / 16000)).getChannelData(0)]).toEqual([.5, .6].map(Math.fround));
    const normalized = AudioEngine.markSourceAudioBuffer(pcm([[.4, .5, .6, .7, .8]]));
    sourcePresentationMetadata.mockClear();
    const same = await getClipRecognitionSource({ audioBuffer: normalized, web: { url: 'blob:mother' } });
    expect([...(await same.readRange(0, 2 / 16000)).getChannelData(0)]).toEqual([.4, .5].map(Math.fround));
    expect(sourcePresentationMetadata).not.toHaveBeenCalled(); expect(createBuffer).not.toHaveBeenCalled();
    source.close(); same.close();
  });
  it('refuses missing effect/cache channels and native errors instead of silently decoding the mother', async () => {
    const clip = cached(); clip.recognitionTracks[1] = { sourceStream: 1, sourceChannel: 0 };
    await expect(getClipRecognitionSource(clip)).rejects.toThrow(/快取/);
    const source = await getClipRecognitionSource(cached());
    bridge.speechAudioRead.mockRejectedValueOnce(new Error('native read failed'));
    await expect(source.readRange(0, .1)).rejects.toThrow('native read failed');
    expect(bridge.fileURL).not.toHaveBeenCalled(); source.close();
  });
  it('pads a late-starting buffer, resamples only its range, and rejects cancellation during metadata lookup', async () => {
    sourcePresentationMetadata.mockResolvedValue({ presentationTimestampOffset: 10,
      decoderAudioPresentationTimestampOffsets: [9.5], duration: 2 });
    const buffer = pcm([[.2, .4, .6, .8]], 4);
    const source = await getClipRecognitionSource({ audioBuffer: buffer, web: { url: 'blob:mother' } });
    const window = await source.readRange(0, 1);
    expect(window.getChannelData(0)[0]).toBe(0);
    expect(window.getChannelData(0)[8000]).toBeCloseTo(.2);
    expect(window.getChannelData(0)[10000]).toBeCloseTo(.3);
    source.close();
    let resolve;
    sourcePresentationMetadata.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const controller = new AbortController();
    const pending = getClipRecognitionSource({ audioBuffer: buffer, web: { url: 'blob:mother' } }, { signal: controller.signal });
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    controller.abort(); resolve(null);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(bridge.speechAudioRead).not.toHaveBeenCalled();
  });
  it.each(['signal', 'close', 'ownership'])('cancels a pending read on %s and rejects late PCM without starting the next channel', async reason => {
    let resolve; let owns = true;
    bridge.speechAudioRead.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const controller = new AbortController();
    const source = await getClipRecognitionSource(cached(), { signal: controller.signal, owns: () => owns });
    const pending = source.readRange(0, .01);
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    if (reason === 'signal') controller.abort();
    else if (reason === 'close') source.close();
    else owns = false;
    resolve(response(.2, .01));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(bridge.speechAudioRead).toHaveBeenCalledTimes(1);
    if (reason !== 'ownership') expect(bridge.speechAudioCancel).toHaveBeenCalledTimes(1);
    source.close(); source.close();
  });
  it('rejects malformed native PCM and concurrent read requests', async () => {
    let resolve;
    bridge.speechAudioRead.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const source = await getClipRecognitionSource(cached());
    const pending = source.readRange(0, .01);
    await expect(source.readRange(1, 1.01)).rejects.toThrow(/讀取/);
    resolve({ ...response(.2, .01), frames: 159 });
    await expect(pending).rejects.toThrow(/PCM/); source.close();
  });
  it('uses the existing web decoder only when the native capability is unavailable', async () => {
    delete window.subtool;
    const buffer = pcm([[.2, .4]]);
    const decodeAudioData = vi.fn(async () => buffer);
    const source = await getClipRecognitionSource({ file: { arrayBuffer: async () => new ArrayBuffer(2) } }, { decodeAudioData });
    expect(source).toBe(buffer); expect(decodeAudioData).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('a replacement session waits for cancelled native read cleanup (cancel replacement: %s)', async cancelReplacement => {
    let finishOld, active = false;
    bridge.speechAudioRead.mockImplementation(request => {
      if (active) return Promise.reject(new Error('SPEECH_AUDIO_BUSY'));
      active = true;
      if (!finishOld) return new Promise((resolve, reject) => {
        finishOld = () => { active = false; reject(new DOMException('Native read cancelled after child close', 'AbortError')); };
      });
      active = false; return Promise.resolve(response(.4, request.duration));
    });
    // Cancel IPC acknowledges immediately; its subprocess still owns the slot
    // until the original read promise rejects at real child-close.
    bridge.speechAudioCancel.mockResolvedValue({ ok: true });
    const commit = vi.fn(async () => 0);
    const begin = id => startAsrWork({ clips: [{ id, path: 'C:/mother.mov', in: 0, out: 1 }],
      recognitionSelection: { mode: 'all-source-channels' } }, {
      extractAudio: (clip, options) => getClipRecognitionSource(clip, options),
      transcribe: async ({ audioBuffer, signal }) => {
        await audioBuffer.readRange(0, .01, { signal }); return [];
      }, commit
    });
    const old = begin('old');
    const oldOutcome = old.promise.then(value => ({ value }), error => ({ error }));
    let replacement, replacementOutcome;
    try {
      await vi.waitFor(() => expect(finishOld).toBeTypeOf('function'));
      old.cancel(); replacement = begin('replacement');
      replacementOutcome = replacement.promise.then(value => ({ value }), error => ({ error }));
      // Flush source creation and the next admission attempt, without resolving
      // old child-close. A legitimate new work must remain pending, not BUSY.
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(bridge.speechAudioRead).toHaveBeenCalledTimes(1);
      expect(commit).not.toHaveBeenCalled();
      if (cancelReplacement) replacement.cancel();
      finishOld();
      expect(await oldOutcome).toMatchObject({ value: { status: 'cancelled' } });
      expect(await replacementOutcome).toMatchObject({ value: { status: cancelReplacement ? 'cancelled' : 'completed' } });
      expect(bridge.speechAudioRead).toHaveBeenCalledTimes(cancelReplacement ? 1 : 2);
      expect(commit).toHaveBeenCalledTimes(cancelReplacement ? 0 : 1);
      expect(bridge.speechAudioCancel).toHaveBeenCalledTimes(1);
    } finally {
      finishOld?.(); old.cancel(); replacement?.cancel();
      await oldOutcome; await replacementOutcome; clearAsrSession();
    }
  });
  it('does not hide BUSY or wait for a different read that was never cancelled', async () => {
    let finish, active = false;
    bridge.speechAudioRead.mockImplementation(request => {
      if (active) return Promise.reject(new Error('SPEECH_AUDIO_BUSY'));
      active = true; return new Promise(resolve => { finish = () => { active = false; resolve(response(.2, request.duration)); }; });
    });
    const first = await getClipRecognitionSource({ path: 'C:/mother.mov', out: 1 });
    const second = await getClipRecognitionSource({ path: 'C:/other.mov', out: 1 });
    const pending = first.readRange(0, .01);
    try {
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      await expect(second.readRange(0, .01)).rejects.toThrow('SPEECH_AUDIO_BUSY');
      expect(bridge.speechAudioRead).toHaveBeenCalledTimes(2);
      expect(bridge.speechAudioCancel).not.toHaveBeenCalled();
    } finally { finish(); await pending; first.close(); second.close(); }
  });
});
