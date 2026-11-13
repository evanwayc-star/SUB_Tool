// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const worker = vi.hoisted(() => ({ transcribeBuiltinAudioInWorker: vi.fn() }));
vi.mock('../src/speech-recognition-worker-client.js', () => worker);
import { transcribeAudioStream } from '../src/speech-recognition-engine.js';

function pcm(duration, value = 1) {
  const samples = new Float32Array(Math.round(duration * 16000)).fill(value);
  return { duration: samples.length / 16000, length: samples.length, sampleRate: 16000,
    numberOfChannels: 1, getChannelData: () => samples };
}

function reader(duration = 6313.54) {
  return { duration, close: vi.fn(), readRange: vi.fn(async (start, end) => {
    if (start < 0 || end > duration || !(end > start) || end - start > 600) {
      throw new Error(`unbounded source read: ${start}..${end}`);
    }
    return pcm(end - start);
  }) };
}

function response(words = []) {
  return { ok: true, json: async () => ({ text: words.map(word => word.text).join(' '),
    segments: words, words: words.map(word => ({ ...word, word: word.text })) }) };
}

function bytes(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new DataView(reader.result));
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });
}

beforeEach(() => {
  worker.transcribeBuiltinAudioInWorker.mockReset().mockResolvedValue({ segments: [] });
  Object.defineProperty(window, 'subtool', { configurable: true, value: undefined });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));
});
afterEach(() => vi.unstubAllGlobals());

describe('bounded recognition source reader', () => {
  it.each(['groq', 'openai'])('%s uploads only the nonzero IN/OUT PCM, with local zero timestamps', async provider => {
    const source = reader();
    source.readRange.mockImplementation(async (start, end) => {
      expect([start, end]).toEqual([4000, 4000.125]);
      const buffer = pcm(end - start);
      buffer.getChannelData(0).fill(-1, 1000);
      return buffer;
    });
    let sent;
    fetch.mockImplementation(async (_url, options) => {
      sent = await bytes(options.body.get('file'));
      return response([{ start: 0.025, end: 0.1, text: 'selected' }]);
    });
    const result = await transcribeAudioStream({ audioBuffer: source, inT: 4000,
      outT: 4000.125, provider, apiKey: 'test', language: 'en' });
    expect(sent.byteLength).toBe(4044);
    expect(sent.getUint32(24, true)).toBe(16000);
    expect(sent.getInt16(44, true)).toBe(32767);
    expect(sent.getInt16(44 + 1000 * 2, true)).toBe(-32768);
    expect(result[0]).toMatchObject({ start: 0.025, end: 0.1, text: 'selected' });
    expect(source.readRange).toHaveBeenCalledOnce();
    expect(source.close).not.toHaveBeenCalled(); // The session owns the reader's lifetime.
  });

  it('plans with a 45 second window and merges overlapping word evidence with one source offset', async () => {
    const source = reader();
    const uploads = [];
    fetch.mockImplementationOnce(async (_url, options) => {
      uploads.push(options.body.get('file').size);
      return response([{ start: 550, end: 550.08, text: 'same' }]);
    }).mockImplementationOnce(async (_url, options) => {
      uploads.push(options.body.get('file').size);
      return response([{ start: 5.2, end: 5.4, text: 'same' },
        { start: 15, end: 16, text: 'next' }]);
    });
    const result = await transcribeAudioStream({ audioBuffer: source, inT: 123,
      outT: 724, provider: 'groq', apiKey: 'test', language: 'en' });
    expect(source.readRange.mock.calls.map(([start, end]) => [start, end]))
      .toEqual([[678, 723], [123, 678.1], [668.1, 724]]);
    expect(uploads).toEqual([17_763_244, 1_788_844]);
    expect(result.flatMap(segment => segment.words.map(word => word.text))).toEqual(['same', 'next']);
    expect(result[1].start).toBeCloseTo(560.1, 6);
    expect(result[1].end).toBeCloseTo(561.1, 6);
    expect(JSON.stringify(result)).not.toContain('_whisperOverlapRef');
  });

  it('builtin inference also stays bounded and retains model options and source-relative word times', async () => {
    const source = reader();
    const lengths = [];
    worker.transcribeBuiltinAudioInWorker.mockImplementation(async options => {
      lengths.push(options.audioFloat32.length);
      expect(options).toMatchObject({ language: 'en', temperature: 0.5, prompt: 'context',
        modelId: 'onnx-community/whisper-small_timestamped' });
      const text = lengths.length === 1 ? 'first' : 'second';
      return { segments: [{ start: 15, end: 16, text, words: [{ start: 15, end: 16, text }] }] };
    });
    const result = await transcribeAudioStream({ audioBuffer: source, inT: 123, outT: 724,
      provider: 'builtin', builtinModel: 'onnx-community/whisper-small',
      language: 'en', temperature: 0.5, prompt: 'context' });
    expect(lengths).toEqual([8_881_600, 894_400]);
    expect(result.map(segment => segment.text)).toEqual(['first', 'second']);
    expect(result[1].start).toBeCloseTo(560.1, 6);
  });

  it.each(['azure', 'elevenlabs', 'google'])('%s uses bounded source windows and preserves provider options', async provider => {
    const source = reader();
    const payloads = [];
    fetch.mockImplementation(async (url, options) => {
      if (url.endsWith('/models')) return { ok: true, json: async () => ({ models: [
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }
      ] }) };
      if (provider === 'google') {
        const payload = JSON.parse(options.body);
        expect(payload.contents[0].parts[0].text).toContain('context');
        payloads.push(atob(payload.contents[0].parts[1].inlineData.data).length);
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [
          { text: JSON.stringify([{ start: 15, end: 16, text: 'spoken' }]) }
        ] } }] }) };
      }
      payloads.push(options.body.get(provider === 'azure' ? 'audio' : 'file').size);
      if (provider === 'azure') {
        expect(url).toContain('westus.api.');
        expect(JSON.parse(options.body.get('definition'))).toMatchObject({
          locales: ['en-US'], phraseList: { phrases: ['term'] }, profanityFilterMode: 'Removed'
        });
        return { ok: true, json: async () => ({ phrases: [{ text: 'spoken', offsetMilliseconds: 15000,
          durationMilliseconds: 1000, speaker: 2, locale: 'en-US', confidence: 0.9 }] }) };
      }
      expect(options.body.getAll('keyterms')).toEqual(['term']);
      expect(options.body.get('num_speakers')).toBe('3');
      expect(options.body.get('tag_audio_events')).toBe('true');
      return { ok: true, json: async () => ({ words: [
        { text: 'spoken', start: 15, end: 16, type: 'word', speaker_id: 'speaker_2' }
      ] }) };
    });
    const result = await transcribeAudioStream({ audioBuffer: source, inT: 123, outT: 724,
      provider, apiKey: 'test', language: 'en', prompt: 'context', azureRegion: 'westus',
      azurePhrases: ['term'], azureProfanity: 'Removed', keyterms: ['term'],
      elevenlabsNumSpeakers: 3, elevenlabsTagAudioEvents: true });
    expect(payloads).toEqual([17_763_244, 1_788_844]);
    expect(result).toHaveLength(2);
    expect(result[1].start).toBeCloseTo(560.1, 6);
    if (provider === 'azure') expect(result[1]).toMatchObject({ speaker: 2, locale: 'en-US', confidence: 0.9 });
    if (provider === 'elevenlabs') expect(result[1].speaker).toBe('speaker_2');
  });

  it('keeps untimed text-only chunk responses without inventing a timed sentence', async () => {
    const source = reader();
    fetch.mockResolvedValue({ ok: true, json: async () => ({ text: 'unanchored words' }) });
    const result = await transcribeAudioStream({ audioBuffer: source, inT: 123, outT: 724,
      provider: 'groq', apiKey: 'test', language: 'en' });
    expect(result).toHaveLength(2);
    expect(result.every(segment => segment.start === segment.end)).toBe(true);
    expect(result[1].start).toBeCloseTo(545.1, 6);
  });

  it('missing OUT stops at source duration rather than adding IN to the full duration', async () => {
    const source = reader();
    const controller = new AbortController();
    await transcribeAudioStream({ audioBuffer: source, inT: 6313, provider: 'builtin',
      signal: controller.signal });
    expect(source.readRange).toHaveBeenCalledExactlyOnceWith(6313, 6313.54, { signal: controller.signal });
    expect(worker.transcribeBuiltinAudioInWorker.mock.calls[0][0].audioFloat32).toHaveLength(8640);
  });

  it.each([
    ['short PCM', () => pcm(0.5)],
    ['wrong sample rate', () => ({ ...pcm(1), sampleRate: 48000 })],
    ['wrong channel count', () => ({ ...pcm(1), numberOfChannels: 2 })],
    ['missing samples', () => ({ ...pcm(1), getChannelData: () => new Float32Array(0) })]
  ])('rejects %s instead of submitting incomplete audio', async (_name, makeBuffer) => {
    const source = reader();
    source.readRange.mockResolvedValue(makeBuffer());
    await expect(transcribeAudioStream({ audioBuffer: source, inT: 123, outT: 124,
      provider: 'groq', apiKey: 'test' })).rejects.toThrow('16 kHz');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a late builtin worker result after cancellation', async () => {
    const source = reader();
    const controller = new AbortController();
    let finish;
    worker.transcribeBuiltinAudioInWorker.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = transcribeAudioStream({ audioBuffer: source, inT: 123, outT: 124,
      provider: 'builtin', signal: controller.signal });
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    controller.abort();
    finish({ segments: [{ start: 0, end: 1, text: 'late' }] });
    expect((await outcome).error).toMatchObject({ name: 'AbortError' });
    expect(source.readRange).toHaveBeenCalledOnce();
    expect(worker.transcribeBuiltinAudioInWorker).toHaveBeenCalledOnce();
  });

  it.each(['planning', 'audio'])('cancel during %s read rejects the late PCM before provider submission', async phase => {
    const source = reader();
    const controller = new AbortController();
    let finish;
    source.readRange.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = transcribeAudioStream({ audioBuffer: source, inT: 123,
      outT: phase === 'planning' ? 724 : 124, provider: 'groq', apiKey: 'test', signal: controller.signal });
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(source.readRange.mock.calls[0][2].signal).toBe(controller.signal);
    controller.abort();
    finish(pcm(phase === 'planning' ? 45 : 1));
    expect((await outcome).error).toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancelled late API output cannot start another read or escape as completed segments', async () => {
    const source = reader();
    const controller = new AbortController();
    let finish;
    fetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = transcribeAudioStream({ audioBuffer: source, inT: 123, outT: 724,
      provider: 'groq', apiKey: 'test', signal: controller.signal });
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const readCount = source.readRange.mock.calls.length;
    controller.abort();
    finish(response([{ start: 0, end: 1, text: 'late' }]));
    expect((await outcome).error).toMatchObject({ name: 'AbortError' });
    expect(source.readRange).toHaveBeenCalledTimes(readCount);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
