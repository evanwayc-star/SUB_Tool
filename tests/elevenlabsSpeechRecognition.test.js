import { describe, expect, it, vi } from 'vitest';

import {
  callElevenLabsSpeechTranscription,
  parseElevenLabsTranscriptionResponse,
  transcribeAudioStream
} from '../src/speech-recognition-engine.js';

describe('ElevenLabs Scribe v2 語音辨識', () => {
  it('將逐字時間轉為相對音檔秒數，並依句末標點切出標準字幕與保留 words 錨點', () => {
    const result = parseElevenLabsTranscriptionResponse({
      language_code: 'zh',
      audio_duration_secs: 5.0,
      text: '今天天氣很好。明天我們再去公園。',
      words: [
        { text: '今天', start: 0.1, end: 0.5, type: 'word', speaker_id: 'speaker_0' },
        { text: '天氣', start: 0.5, end: 1.0, type: 'word', speaker_id: 'speaker_0' },
        { text: '很好。', start: 1.0, end: 1.5, type: 'word', speaker_id: 'speaker_0' },
        { text: ' ', start: 1.5, end: 1.6, type: 'spacing' },
        { text: '明天', start: 1.8, end: 2.2, type: 'word', speaker_id: 'speaker_0' },
        { text: '我們', start: 2.2, end: 2.5, type: 'word', speaker_id: 'speaker_0' },
        { text: '再去', start: 2.5, end: 2.8, type: 'word', speaker_id: 'speaker_0' },
        { text: '公園。', start: 2.8, end: 3.3, type: 'word', speaker_id: 'speaker_0' }
      ]
    });

    expect(result.segments).toEqual([
      {
        start: 0.1,
        end: 1.5,
        text: '今天天氣很好。',
        words: [
          { text: '今天', start: 0.1, end: 0.5 },
          { text: '天氣', start: 0.5, end: 1.0 },
          { text: '很好。', start: 1.0, end: 1.5 }
        ],
        speaker: 'speaker_0'
      },
      {
        start: 1.8,
        end: 3.3,
        text: '明天我們再去公園。',
        words: [
          { text: '明天', start: 1.8, end: 2.2 },
          { text: '我們', start: 2.2, end: 2.5 },
          { text: '再去', start: 2.5, end: 2.8 },
          { text: '公園。', start: 2.8, end: 3.3 }
        ],
        speaker: 'speaker_0'
      }
    ]);
  });

  it('遇到說話者切換（speaker_id 變更）時自動切分字幕段落', () => {
    const result = parseElevenLabsTranscriptionResponse({
      language_code: 'zh',
      audio_duration_secs: 4.0,
      words: [
        { text: '哈囉你好', start: 0.2, end: 0.8, type: 'word', speaker_id: 'speaker_0' },
        { text: '你好呀', start: 0.9, end: 1.5, type: 'word', speaker_id: 'speaker_1' }
      ]
    });

    expect(result.segments).toEqual([
      expect.objectContaining({
        start: 0.2,
        end: 0.8,
        text: '哈囉你好',
        speaker: 'speaker_0'
      }),
      expect.objectContaining({
        start: 0.9,
        end: 1.5,
        text: '你好呀',
        speaker: 'speaker_1'
      })
    ]);
  });

  it('相鄰 word 停頓時間 >= 0.75 秒時自動切分字幕', () => {
    const result = parseElevenLabsTranscriptionResponse({
      language_code: 'zh',
      audio_duration_secs: 5.0,
      words: [
        { text: '第一句話', start: 0.1, end: 0.8, type: 'word' },
        { text: '第二句話', start: 1.7, end: 2.4, type: 'word' } // gap = 0.9s
      ]
    });

    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].text).toBe('第一句話');
    expect(result.segments[1].text).toBe('第二句話');
  });

  it('忽略 spacing 與 audio_event 標籤，並將時間限制在音檔長度內', () => {
    const result = parseElevenLabsTranscriptionResponse({
      audio_duration_secs: 2.0,
      words: [
        { text: ' ', start: 0, end: 0.1, type: 'spacing' },
        { text: '[laughter]', start: 0.1, end: 0.4, type: 'audio_event' },
        { text: '有效對白', start: 0.5, end: 2.5, type: 'word' } // 結束時間超出 2.0s
      ]
    }, 2.0);

    expect(result.segments).toEqual([
      {
        start: 0.5,
        end: 2.0,
        text: '有效對白',
        words: [{ text: '有效對白', start: 0.5, end: 2.0 }]
      }
    ]);
  });

  it('自動消除中文字元之間的不必要空白，並在與英文或數字混排時保留適度空格', () => {
    const result = parseElevenLabsTranscriptionResponse({
      language_code: 'zh',
      audio_duration_secs: 4.0,
      text: '九 品 芝 麻 官 2026 Trailer 正 式 預 告 片',
      words: [
        { text: '九', start: 0.1, end: 0.3, type: 'word' },
        { text: '品', start: 0.3, end: 0.5, type: 'word' },
        { text: '芝', start: 0.5, end: 0.7, type: 'word' },
        { text: '麻', start: 0.7, end: 0.9, type: 'word' },
        { text: '官', start: 0.9, end: 1.1, type: 'word' },
        { text: '2026', start: 1.2, end: 1.6, type: 'word' },
        { text: 'Trailer', start: 1.7, end: 2.1, type: 'word' },
        { text: '正式', start: 2.2, end: 2.5, type: 'word' },
        { text: '預告片', start: 2.5, end: 3.0, type: 'word' }
      ]
    });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].text).toBe('九品芝麻官 2026 Trailer 正式預告片');
  });

  it('遇到逗號且停頓達標或字數充足時自然切分字幕', () => {
    const result = parseElevenLabsTranscriptionResponse({
      language_code: 'zh',
      audio_duration_secs: 6.0,
      words: [
        { text: '啟稟包大人，', start: 0.1, end: 1.2, type: 'word' },
        { text: '小人', start: 1.5, end: 1.8, type: 'word' }, // gap 0.3s >= 0.25s
        { text: '真的', start: 1.8, end: 2.1, type: 'word' },
        { text: '是', start: 2.1, end: 2.3, type: 'word' },
        { text: '冤枉的啊！', start: 2.3, end: 3.0, type: 'word' }
      ]
    });

    expect(result.segments).toEqual([
      expect.objectContaining({
        start: 0.1,
        end: 1.2,
        text: '啟稟包大人，'
      }),
      expect.objectContaining({
        start: 1.5,
        end: 3.0,
        text: '小人真的是冤枉的啊！'
      })
    ]);
  });

  it('英文單字之間能自動保留空格，標點符號不留多餘空格', () => {
    const result = parseElevenLabsTranscriptionResponse({
      language_code: 'en',
      audio_duration_secs: 3.0,
      words: [
        { text: 'Hello', start: 0.1, end: 0.4, type: 'word' },
        { text: 'world', start: 0.5, end: 0.9, type: 'word' },
        { text: '!', start: 0.9, end: 1.0, type: 'word' }
      ]
    });

    expect(result.segments[0].text).toBe('Hello world!');
  });

  it('正確傳遞 ElevenLabs API 請求參數（xi-api-key、model_id、keyterms 等）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        language_code: 'zh',
        audio_duration_secs: 2.0,
        text: '測試辨識',
        words: [{ text: '測試辨識', start: 0.1, end: 1.2, type: 'word' }]
      })
    });
    global.fetch = fetchMock;

    const dummyBlob = new Blob([new Uint8Array(100)], { type: 'audio/wav' });
    const result = await callElevenLabsSpeechTranscription({
      audioBlob: dummyBlob,
      apiKey: 'test-elevenlabs-key',
      language: 'zh',
      keyterms: ['SUB Tool', 'Evan', 'SUB Tool'] // 包含重複值
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(options.method).toBe('POST');
    expect(options.headers['xi-api-key']).toBe('test-elevenlabs-key');
    expect(options.body).toBeInstanceOf(FormData);
    expect(options.body.get('model_id')).toBe('scribe_v2');
    expect(options.body.get('language_code')).toBe('zh');
    expect(options.body.get('diarize')).toBe('true');
    expect(options.body.get('tag_audio_events')).toBe('false');
    expect(options.body.getAll('keyterms')).toEqual(['SUB Tool', 'Evan']);
    expect(result.segments[0].text).toBe('測試辨識');
  });

  it('若 API 回報錯誤，隱藏 API Key 避免機敏資料洩漏', async () => {
    const secretKey = 'sk_secret_1234567890';
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        detail: { message: `Invalid key provided: ${secretKey}` }
      })
    });

    const dummyBlob = new Blob([new Uint8Array(100)], { type: 'audio/wav' });
    await expect(callElevenLabsSpeechTranscription({
      audioBlob: dummyBlob,
      apiKey: secretKey
    })).rejects.toThrowError(/ElevenLabs 語音辨識失敗 \(HTTP 401\)：Invalid key provided: \[已隱藏\]/);
  });

  it('透過 transcribeAudioStream 執行 ElevenLabs 並自動轉為台灣繁體中文', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        language_code: 'zh',
        audio_duration_secs: 2.0,
        text: '简体中文识别测试。',
        words: [
          { text: '简体', start: 0.1, end: 0.5, type: 'word' },
          { text: '中文', start: 0.5, end: 0.9, type: 'word' },
          { text: '识别', start: 0.9, end: 1.3, type: 'word' },
          { text: '测试。', start: 1.3, end: 1.8, type: 'word' }
        ]
      })
    });

    const mockBuffer = {
      sampleRate: 16000,
      numberOfChannels: 1,
      length: 32000,
      duration: 2.0,
      getChannelData: () => new Float32Array(32000)
    };

    const segments = await transcribeAudioStream({
      audioBuffer: mockBuffer,
      inT: 0,
      outT: 2.0,
      provider: 'elevenlabs',
      apiKey: 'test-key',
      language: 'zh',
      keyterms: ['SUB Tool']
    });

    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe('簡體中文識別測試。');
    expect(segments[0].start).toBe(0.1);
    expect(segments[0].end).toBe(1.8);
    expect(segments[0].words).toHaveLength(4);
  });
});
