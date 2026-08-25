// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { callWhisperApi, transcribeAudioStream } from '../src/speech-recognition-engine.js';

function createQuietAudioBuffer(durationSeconds) {
  const sampleRate = 1;
  const samples = new Float32Array(Math.ceil(durationSeconds));
  return {
    sampleRate,
    numberOfChannels: 1,
    length: samples.length,
    duration: durationSeconds,
    getChannelData: channel => {
      if (channel !== 0) throw new RangeError('測試音訊只有一個聲道');
      return samples;
    }
  };
}

function whisperResponse(items) {
  return {
    ok: true,
    json: async () => ({
      text: items.map(item => item.text).join(' '),
      segments: items.map((item, index) => ({ id: index, ...item })),
      words: items.map(item => ({ word: item.text, start: item.start, end: item.end }))
    })
  };
}

describe('Whisper 雲端長音訊分段', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, 'subtool', { configurable: true, value: undefined });
  });

  it.each([
    ['openai', 'https://api.openai.com/v1/audio/transcriptions'],
    ['groq', 'https://api.groq.com/openai/v1/audio/transcriptions']
  ])('%s 超過安全單次長度時會分段上傳並把 segment 與 word 時間合併回原區間', async (provider, endpoint) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(whisperResponse([
        { text: 'first', start: 599, end: 599.8 }
      ]))
      .mockResolvedValueOnce(whisperResponse([
        { text: 'first', start: 9, end: 9.8 },
        { text: 'second', start: 10.2, end: 10.8 }
      ]));
    global.fetch = fetchMock;
    const progress = [];

    const segments = await transcribeAudioStream({
      audioBuffer: createQuietAudioBuffer(601),
      inT: 0,
      outT: 601,
      provider,
      apiKey: 'test-openai-key',
      language: 'en',
      onProgress: update => progress.push(update)
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => url === endpoint)).toBe(true);
    expect(fetchMock.mock.calls.map(([, options]) => options.body.get('file').size)).toEqual([
      19_200_044,
      352_044
    ]);
    expect(fetchMock.mock.calls.every(([, options]) => options.body.get('file').size < 20_000_000)).toBe(true);
    expect(fetchMock.mock.calls[0][1].body.getAll('timestamp_granularities[]')).toEqual([
      'word',
      'segment'
    ]);
    expect(segments).toEqual([
      {
        start: 599,
        end: 599.8,
        text: 'first',
        words: [{ start: 599, end: 599.8, text: 'first' }]
      },
      {
        start: 600.2,
        end: 600.8,
        text: 'second',
        words: [{ start: 600.2, end: 600.8, text: 'second' }]
      }
    ]);
    expect(progress).toContainEqual(expect.objectContaining({
      status: 'transcribing',
      percent: 100,
      message: expect.stringContaining('2/2')
    }));
    expect(progress
      .filter(update => update.message.includes('已完成第'))
      .map(update => update.percent)).toEqual([98, 100]);
  });

  it('落在相鄰 segment 邊界上的 word 只會成為一份時間證據', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        text: 'left boundary',
        segments: [
          { start: 0, end: 1, text: 'left' },
          { start: 1, end: 2, text: 'boundary' }
        ],
        words: [{ word: 'boundary', start: 0.9, end: 1.1 }]
      })
    });

    const result = await callWhisperApi({
      audioBlob: new Blob(['mock-wav'], { type: 'audio/wav' }),
      provider: 'openai',
      apiKey: 'test-openai-key',
      language: 'en'
    });

    expect(result.segments.flatMap(segment => segment.words || [])).toEqual([
      { start: 0.9, end: 1.1, text: 'boundary' }
    ]);
    expect(result.segments[1].words).toHaveLength(1);
  });

  it('跨越兩個上傳區塊的 segment 只保留各自 core 內的文字，不會複製整句', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          text: 'left right',
          segments: [{ start: 594, end: 600, text: 'left right' }],
          words: [
            { word: 'left', start: 594, end: 594.8 },
            { word: 'right', start: 599, end: 599.8 }
          ]
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          text: 'left right',
          segments: [{ start: 4, end: 10, text: 'left right' }],
          words: [
            { word: 'left', start: 4, end: 4.8 },
            { word: 'right', start: 9, end: 9.8 }
          ]
        })
      });

    const segments = await transcribeAudioStream({
      audioBuffer: createQuietAudioBuffer(601),
      inT: 0,
      outT: 601,
      provider: 'openai',
      apiKey: 'test-openai-key',
      language: 'en'
    });

    expect(segments.map(segment => segment.text)).toEqual(['left', 'right']);
    expect(segments.flatMap(segment => segment.words.map(word => word.text))).toEqual(['left', 'right']);
  });

  it('同一個 overlap word 的時間碼抖動跨過 core 邊界時仍只保留一份', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(whisperResponse([
        { text: 'same', start: 594.6, end: 594.9 }
      ]))
      .mockResolvedValueOnce(whisperResponse([
        { text: 'same', start: 5.1, end: 5.4 }
      ]));

    const segments = await transcribeAudioStream({
      audioBuffer: createQuietAudioBuffer(601),
      inT: 0,
      outT: 601,
      provider: 'groq',
      apiKey: 'test-groq-key',
      language: 'en'
    });

    expect(segments.flatMap(segment => segment.words.map(word => word.text))).toEqual(['same']);
  });

  it('overlap 內實際連說兩次相同單字時，依兩邊完整 word 序列保留兩份', async () => {
    const response = (offset = 0) => ({
      ok: true,
      json: async () => ({
        text: 'same same',
        segments: [{ start: 594.6 - offset, end: 595.4 - offset, text: 'same same' }],
        words: [
          { word: 'same', start: 594.6 - offset, end: 594.9 - offset },
          { word: 'same', start: 595.1 - offset, end: 595.4 - offset }
        ]
      })
    });
    global.fetch = vi.fn()
      .mockResolvedValueOnce(response(0))
      .mockResolvedValueOnce(response(590));

    const segments = await transcribeAudioStream({
      audioBuffer: createQuietAudioBuffer(601),
      inT: 0,
      outT: 601,
      provider: 'openai',
      apiKey: 'test-openai-key',
      language: 'en'
    });

    expect(segments.flatMap(segment => segment.words.map(word => word.text))).toEqual(['same', 'same']);
  });

  it('一側漏辨連續重複字時，不會把另一側保留的兩次誤合併成一次', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          text: 'same same',
          segments: [{ start: 594.6, end: 595.4, text: 'same same' }],
          words: [
            { word: 'same', start: 594.6, end: 594.9 },
            { word: 'same', start: 595.1, end: 595.4 }
          ]
        })
      })
      .mockResolvedValueOnce(whisperResponse([
        { text: 'same', start: 5.1, end: 5.4 }
      ]));

    const segments = await transcribeAudioStream({
      audioBuffer: createQuietAudioBuffer(601),
      inT: 0,
      outT: 601,
      provider: 'openai',
      apiKey: 'test-openai-key',
      language: 'en'
    });

    expect(segments.flatMap(segment => segment.words.map(word => word.text))).toEqual(['same', 'same']);
  });

  it('一側漏辨且剩餘重複字時間漂移時，候選不唯一就保守地不去重', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          text: 'same same',
          segments: [{ start: 594.55, end: 595.75, text: 'same same' }],
          words: [
            { word: 'same', start: 594.55, end: 594.85 },
            { word: 'same', start: 595.45, end: 595.75 }
          ]
        })
      })
      .mockResolvedValueOnce(whisperResponse([
        { text: 'same', start: 4.95, end: 5.25 }
      ]));

    const segments = await transcribeAudioStream({
      audioBuffer: createQuietAudioBuffer(601),
      inT: 0,
      outT: 601,
      provider: 'groq',
      apiKey: 'test-groq-key',
      language: 'en'
    });

    expect(segments.flatMap(segment => segment.words.map(word => word.text))).toEqual(['same', 'same']);
  });

  it.each([
    ['openai', 'https://api.openai.com/v1/audio/transcriptions'],
    ['groq', 'https://api.groq.com/openai/v1/audio/transcriptions']
  ])('桌面版的 %s 只在辨識當下把已混音 WAV 壓成較小的 MP3 再上傳', async (provider, endpoint) => {
    const compressSpeechAudio = vi.fn().mockResolvedValue({
      b64: btoa('small-recognition-mp3'),
      type: 'audio/mpeg',
      name: 'audio.mp3'
    });
    Object.defineProperty(window, 'subtool', {
      configurable: true,
      value: { isDesktop: true, compressSpeechAudio }
    });
    const fetchMock = vi.fn().mockResolvedValue(whisperResponse([
      { text: 'compressed', start: 0.1, end: 0.8 }
    ]));
    global.fetch = fetchMock;

    await transcribeAudioStream({
      audioBuffer: createQuietAudioBuffer(1),
      inT: 0,
      outT: 1,
      provider,
      apiKey: 'test-openai-key',
      language: 'en'
    });

    expect(compressSpeechAudio).toHaveBeenCalledTimes(1);
    expect(compressSpeechAudio.mock.calls[0][0]).toBeInstanceOf(Uint8Array);
    expect(compressSpeechAudio.mock.calls[0][0]).toHaveLength(32_044);
    const uploadedFile = fetchMock.mock.calls[0][1].body.get('file');
    expect(uploadedFile.name).toBe('audio.mp3');
    expect(uploadedFile.type).toBe('audio/mpeg');
    expect(uploadedFile.size).toBeLessThan(32_044);
    expect(fetchMock.mock.calls[0][0]).toBe(endpoint);
  });

  it('第一段完成後取消時不會再壓縮或上傳後續分段', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(async () => {
      controller.abort();
      return whisperResponse([{ text: 'first', start: 1, end: 2 }]);
    });
    global.fetch = fetchMock;
    const progress = [];

    await expect(transcribeAudioStream({
      audioBuffer: createQuietAudioBuffer(601),
      inT: 0,
      outT: 601,
      provider: 'openai',
      apiKey: 'test-openai-key',
      language: 'en',
      signal: controller.signal,
      onProgress: update => progress.push(update)
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(progress.some(update => update.percent === 100)).toBe(false);
  });

  it('MP3 壓縮 IPC 尚未回應時取消也會立即收斂，並通知 main 終止 ffmpeg', async () => {
    const controller = new AbortController();
    const compressSpeechAudio = vi.fn(() => new Promise(() => {}));
    const cancelSpeechAudioCompression = vi.fn().mockResolvedValue(true);
    Object.defineProperty(window, 'subtool', {
      configurable: true,
      value: { compressSpeechAudio, cancelSpeechAudioCompression }
    });
    const fetchMock = vi.fn();
    global.fetch = fetchMock;
    const resultPromise = transcribeAudioStream({
      audioBuffer: createQuietAudioBuffer(1),
      inT: 0,
      outT: 1,
      provider: 'groq',
      apiKey: 'test-groq-key',
      language: 'en',
      signal: controller.signal
    });
    await vi.waitFor(() => expect(compressSpeechAudio).toHaveBeenCalledTimes(1));

    controller.abort();

    await expect(resultPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelSpeechAudioCompression).toHaveBeenCalledWith(
      expect.stringMatching(/^speech-/)
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
