import { describe, expect, it, vi } from 'vitest';

import {
  callAzureSpeechTranscription,
  parseAzureTranscriptionResponse,
  transcribeAudioStream
} from '../src/speech-recognition-engine.js';
import { resolveRecognitionAlignment } from '../src/transcript-alignment.js';

describe('Azure Speech Fast Transcription', () => {
  it('將逐句與逐字毫秒時間轉為相對音檔秒數', () => {
    const result = parseAzureTranscriptionResponse({
      durationMilliseconds: 4200,
      combinedPhrases: [{ text: '今天天氣很好。' }],
      phrases: [{
        offsetMilliseconds: 125,
        durationMilliseconds: 1375,
        text: '今天天氣很好。',
        words: [
          { text: '今天', offsetMilliseconds: 125, durationMilliseconds: 375 },
          { text: '天氣', offsetMilliseconds: 500, durationMilliseconds: 500 },
          { text: '很好。', offsetMilliseconds: 1000, durationMilliseconds: 500 }
        ],
        locale: 'zh-TW',
        confidence: 0.96
      }]
    });

    expect(result).toEqual({
      text: '今天天氣很好。',
      segments: [{
        start: 0.125,
        end: 1.5,
        text: '今天天氣很好。',
        words: [
          { text: '今天', start: 0.125, end: 0.5 },
          { text: '天氣', start: 0.5, end: 1 },
          { text: '很好。', start: 1, end: 1.5 }
        ],
        locale: 'zh-TW',
        confidence: 0.96
      }]
    });
  });

  it('不產生無效字幕，並將 Azure 邊界限制在音檔長度內', () => {
    const result = parseAzureTranscriptionResponse({
      durationMilliseconds: 4200,
      combinedPhrases: [{ text: '最後一句。' }],
      phrases: [
        { offsetMilliseconds: -1, durationMilliseconds: 100, text: '無效' },
        { offsetMilliseconds: 100, durationMilliseconds: 0, text: '無效' },
        { offsetMilliseconds: 3500, durationMilliseconds: 1000, text: '最後一句。', words: [
          { text: '最後一句。', offsetMilliseconds: 3500, durationMilliseconds: 1000 }
        ] }
      ]
    });

    expect(result.segments).toEqual([expect.objectContaining({
      start: 3.5,
      end: 4.2,
      words: [{ text: '最後一句。', start: 3.5, end: 4.2 }]
    })]);
    expect(result.segments[0]).not.toHaveProperty('confidence');
  });

  it('依逐字時間與句末標點把同一個 Azure phrase 切成自然字幕', () => {
    const result = parseAzureTranscriptionResponse({
      durationMilliseconds: 4000,
      phrases: [{
        offsetMilliseconds: 100,
        durationMilliseconds: 2800,
        text: '今天先到這裡。明天再繼續。',
        words: [
          { text: '今天', offsetMilliseconds: 100, durationMilliseconds: 300 },
          { text: '先到', offsetMilliseconds: 400, durationMilliseconds: 300 },
          { text: '這裡。', offsetMilliseconds: 700, durationMilliseconds: 500 },
          { text: '明天', offsetMilliseconds: 1500, durationMilliseconds: 300 },
          { text: '再', offsetMilliseconds: 1800, durationMilliseconds: 200 },
          { text: '繼續。', offsetMilliseconds: 2000, durationMilliseconds: 900 }
        ],
        locale: 'zh-TW'
      }]
    });

    expect(result.segments).toEqual([
      expect.objectContaining({
        start: 0.1,
        end: 1.2,
        text: '今天先到這裡。'
      }),
      expect.objectContaining({
        start: 1.5,
        end: 2.9,
        text: '明天再繼續。'
      })
    ]);
  });

  it('合併短暫停頓內尚未完句的 Azure 碎片，且保留首尾逐字時間', () => {
    const result = parseAzureTranscriptionResponse({
      durationMilliseconds: 2500,
      phrases: [
        {
          offsetMilliseconds: 100,
          durationMilliseconds: 500,
          text: '我想',
          words: [{ text: '我想', offsetMilliseconds: 100, durationMilliseconds: 500 }],
          locale: 'zh-TW',
          speaker: 0
        },
        {
          offsetMilliseconds: 700,
          durationMilliseconds: 800,
          text: '先確認一下。',
          words: [
            { text: '先', offsetMilliseconds: 700, durationMilliseconds: 200 },
            { text: '確認', offsetMilliseconds: 900, durationMilliseconds: 300 },
            { text: '一下。', offsetMilliseconds: 1200, durationMilliseconds: 300 }
          ],
          locale: 'zh-TW',
          speaker: 0
        }
      ]
    });

    expect(result.segments).toEqual([expect.objectContaining({
      start: 0.1,
      end: 1.5,
      text: '我想先確認一下。',
      words: [
        { text: '我想', start: 0.1, end: 0.6 },
        { text: '先', start: 0.7, end: 0.9 },
        { text: '確認', start: 0.9, end: 1.2 },
        { text: '一下。', start: 1.2, end: 1.5 }
      ]
    })]);
  });

  it('沒有明確 speaker 時不跨 Azure phrase 合併', () => {
    const result = parseAzureTranscriptionResponse({
      durationMilliseconds: 2000,
      phrases: [
        {
          offsetMilliseconds: 100,
          durationMilliseconds: 400,
          text: '你先',
          words: [{ text: '你先', offsetMilliseconds: 100, durationMilliseconds: 400 }],
          locale: 'zh-TW'
        },
        {
          offsetMilliseconds: 600,
          durationMilliseconds: 500,
          text: '等一下',
          words: [{ text: '等一下', offsetMilliseconds: 600, durationMilliseconds: 500 }],
          locale: 'zh-TW'
        }
      ]
    });

    expect(result.segments.map(segment => segment.text)).toEqual(['你先', '等一下']);
  });

  it('英文斷句保留單字之間的空格與各句時間碼', () => {
    const result = parseAzureTranscriptionResponse({
      durationMilliseconds: 4000,
      phrases: [{
        offsetMilliseconds: 200,
        durationMilliseconds: 2600,
        text: 'This is the first sentence. This is next.',
        words: [
          { text: 'This', offsetMilliseconds: 200, durationMilliseconds: 200 },
          { text: 'is', offsetMilliseconds: 400, durationMilliseconds: 100 },
          { text: 'the', offsetMilliseconds: 500, durationMilliseconds: 100 },
          { text: 'first', offsetMilliseconds: 600, durationMilliseconds: 250 },
          { text: 'sentence.', offsetMilliseconds: 850, durationMilliseconds: 450 },
          { text: 'This', offsetMilliseconds: 1600, durationMilliseconds: 200 },
          { text: 'is', offsetMilliseconds: 1800, durationMilliseconds: 100 },
          { text: 'next.', offsetMilliseconds: 1900, durationMilliseconds: 400 }
        ],
        locale: 'en-US'
      }]
    });

    expect(result.segments.map(segment => ({
      start: segment.start,
      end: segment.end,
      text: segment.text
    }))).toEqual([
      { start: 0.2, end: 1.3, text: 'This is the first sentence.' },
      { start: 1.6, end: 2.3, text: 'This is next.' }
    ]);
  });

  it('英文人名縮寫不會被誤判為句尾', () => {
    const result = parseAzureTranscriptionResponse({
      durationMilliseconds: 3500,
      phrases: [{
        offsetMilliseconds: 100,
        durationMilliseconds: 2600,
        text: 'Dr. Chen is here. Welcome.',
        words: [
          { text: 'Dr', offsetMilliseconds: 100, durationMilliseconds: 200 },
          { text: '.', offsetMilliseconds: 300, durationMilliseconds: 50 },
          { text: 'Chen', offsetMilliseconds: 350, durationMilliseconds: 300 },
          { text: 'is', offsetMilliseconds: 650, durationMilliseconds: 150 },
          { text: 'here.', offsetMilliseconds: 800, durationMilliseconds: 500 },
          { text: 'Welcome.', offsetMilliseconds: 1600, durationMilliseconds: 700 }
        ],
        locale: 'en-US'
      }]
    });

    expect(result.segments.map(segment => segment.text)).toEqual([
      'Dr. Chen is here.',
      'Welcome.'
    ]);
  });

  it('獨立句末標點會附著前文，不產生只有標點的字幕', () => {
    const paddedSentence = '甲'.repeat(24);
    const result = parseAzureTranscriptionResponse({
      durationMilliseconds: 3500,
      phrases: [{
        offsetMilliseconds: 100,
        durationMilliseconds: 2500,
        text: `${paddedSentence}。下一句。`,
        words: [
          { text: paddedSentence, offsetMilliseconds: 100, durationMilliseconds: 1200 },
          { text: '。', offsetMilliseconds: 1300, durationMilliseconds: 50 },
          { text: '下一句', offsetMilliseconds: 1700, durationMilliseconds: 500 },
          { text: '。', offsetMilliseconds: 2200, durationMilliseconds: 50 }
        ],
        locale: 'zh-TW',
        speaker: 0
      }]
    });

    expect(result.segments.map(segment => segment.text)).toEqual([
      `${paddedSentence}。`,
      '下一句。'
    ]);
    expect(result.segments.every(segment => !/^[\p{Punctuation}\p{Symbol}]+$/u.test(segment.text))).toBe(true);
  });

  it('英文開引號保留空格，結尾獨立引號附著同一句', () => {
    const result = parseAzureTranscriptionResponse({
      durationMilliseconds: 3000,
      phrases: [
        {
          offsetMilliseconds: 100,
          durationMilliseconds: 700,
          text: 'He said',
          words: [
            { text: 'He', offsetMilliseconds: 100, durationMilliseconds: 250 },
            { text: 'said', offsetMilliseconds: 350, durationMilliseconds: 450 }
          ],
          locale: 'en-US',
          speaker: 0
        },
        {
          offsetMilliseconds: 900,
          durationMilliseconds: 700,
          text: '"Hello."',
          words: [
            { text: '"', offsetMilliseconds: 900, durationMilliseconds: 50 },
            { text: 'Hello.', offsetMilliseconds: 950, durationMilliseconds: 600 },
            { text: '"', offsetMilliseconds: 1550, durationMilliseconds: 50 }
          ],
          locale: 'en-US',
          speaker: 0
        }
      ]
    });

    expect(result.segments).toEqual([expect.objectContaining({
      start: 0.1,
      end: 1.6,
      text: 'He said "Hello."'
    })]);
  });

  it('合併片段補齊 locale；任一片段缺 confidence 時不保留不完整信心值', () => {
    const result = parseAzureTranscriptionResponse({
      durationMilliseconds: 2000,
      phrases: [
        {
          offsetMilliseconds: 100,
          durationMilliseconds: 500,
          text: '前半',
          words: [{ text: '前半', offsetMilliseconds: 100, durationMilliseconds: 500 }],
          speaker: 0,
          confidence: 0.9
        },
        {
          offsetMilliseconds: 700,
          durationMilliseconds: 600,
          text: '後半。',
          words: [{ text: '後半。', offsetMilliseconds: 700, durationMilliseconds: 600 }],
          locale: 'zh-TW',
          speaker: 0
        }
      ]
    });

    expect(result.segments).toEqual([expect.objectContaining({
      text: '前半後半。',
      locale: 'zh-TW',
      speaker: 0
    })]);
    expect(result.segments[0]).not.toHaveProperty('confidence');
  });

  it('沒有標點的長句仍依字幕長度上限切開', () => {
    const tokens = ['這是一段', '沒有標點', '但是內容', '持續很久', '而且需要', '切成字幕', '避免整段', '塞在一起'];
    const result = parseAzureTranscriptionResponse({
      durationMilliseconds: 5000,
      phrases: [{
        offsetMilliseconds: 0,
        durationMilliseconds: 4100,
        text: tokens.join(''),
        words: tokens.map((text, index) => ({
          text,
          offsetMilliseconds: index * 500,
          durationMilliseconds: 400
        })),
        locale: 'zh-TW'
      }]
    });

    expect(result.segments).toHaveLength(2);
    expect(result.segments.map(segment => segment.text)).toEqual([
      '這是一段沒有標點但是內容持續很久而且需要切成字幕',
      '避免整段塞在一起'
    ]);
    expect(result.segments.every(segment => Array.from(segment.text).length <= 24)).toBe(true);
  });

  it('逐字停頓達 0.75 秒時切句，但不跨 speaker 合併', () => {
    const result = parseAzureTranscriptionResponse({
      durationMilliseconds: 4000,
      phrases: [
        {
          offsetMilliseconds: 100,
          durationMilliseconds: 1900,
          text: '我們先走',
          words: [
            { text: '我們', offsetMilliseconds: 100, durationMilliseconds: 400 },
            { text: '先走', offsetMilliseconds: 1250, durationMilliseconds: 750 }
          ],
          locale: 'zh-TW',
          speaker: 0
        },
        {
          offsetMilliseconds: 2100,
          durationMilliseconds: 500,
          text: '等等',
          words: [{ text: '等等', offsetMilliseconds: 2100, durationMilliseconds: 500 }],
          locale: 'zh-TW',
          speaker: 1
        }
      ]
    });

    expect(result.segments.map(segment => ({ text: segment.text, speaker: segment.speaker }))).toEqual([
      { text: '我們', speaker: 0 },
      { text: '先走', speaker: 0 },
      { text: '等等', speaker: 1 }
    ]);
  });

  it('缺少逐字資料時保留 Azure 原始 phrase 與時間，不猜測切點', () => {
    const text = '這是一個沒有逐字時間資料，因此即使很長也不能自行猜測時間切點的 Azure phrase。';
    const result = parseAzureTranscriptionResponse({
      durationMilliseconds: 8000,
      phrases: [{
        offsetMilliseconds: 500,
        durationMilliseconds: 7000,
        text,
        locale: 'zh-TW'
      }]
    });

    expect(result.segments).toEqual([expect.objectContaining({
      start: 0.5,
      end: 7.5,
      text,
      words: []
    })]);
  });

  it('未指定 Region 時預設呼叫 Japan East', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ durationMilliseconds: 1000, phrases: [] })
    });
    global.fetch = fetchMock;

    await callAzureSpeechTranscription({
      audioBlob: new Blob(['wav'], { type: 'audio/wav' }),
      apiKey: 'azure-test-key',
      language: 'zh'
    });

    expect(fetchMock.mock.calls[0][0]).toContain('https://japaneast.api.cognitive.microsoft.com/');
  });

  it('以 zh-TW 與專有名詞清單呼叫指定 Region 的 Fast Transcription', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        durationMilliseconds: 1500,
        combinedPhrases: [{ text: '歡迎使用 SUB Tool。' }],
        phrases: [{
          offsetMilliseconds: 100,
          durationMilliseconds: 1200,
          text: '歡迎使用 SUB Tool。',
          words: []
        }]
      })
    });
    global.fetch = fetchMock;

    const result = await callAzureSpeechTranscription({
      audioBlob: new Blob(['wav'], { type: 'audio/wav' }),
      apiKey: 'azure-test-key',
      region: 'southeastasia',
      language: 'zh',
      phrases: ['SUB Tool', 'Evan']
    });

    expect(result.segments[0]).toMatchObject({
      start: 0.1,
      end: 1.3,
      text: '歡迎使用 SUB Tool。'
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://southeastasia.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15');
    expect(options).toMatchObject({
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': 'azure-test-key' }
    });
    expect(options.headers).not.toHaveProperty('Content-Type');
    expect(options.body).toBeInstanceOf(FormData);
    expect(options.body.get('audio')).toBeInstanceOf(Blob);
    expect(JSON.parse(options.body.get('definition'))).toEqual({
      diarization: { enabled: true, maxSpeakers: 10 },
      profanityFilterMode: 'None',
      locales: ['zh-TW'],
      phraseList: { phrases: ['SUB Tool', 'Evan'] }
    });
  });

  it.each([401, 403])('Azure HTTP %i 說明單欄更正方式，至多呼叫一次且不顯示金鑰', async status => {
    const secret = 'azure-super-secret-key';
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status,
      statusText: 'Unauthorized',
      json: async () => ({ error: { message: `Invalid subscription key: ${secret}` } })
    });

    let caught;
    try {
      await callAzureSpeechTranscription({
        audioBlob: new Blob(['wav'], { type: 'audio/wav' }),
        apiKey: 'eastus:' + secret,
        region: 'southeastasia',
        language: 'en'
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toContain('HTTP ' + status);
    expect(caught.message).toContain('區域:金鑰');
    expect(caught.message).not.toContain(secret);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['malformed.example:mock-key', 'https://other.example/secret', 'eastus:a:b', 'eastus:', 'eastus:key\r\nheader'])(
    '無效的單欄 Azure 憑證不會撥出請求 (%s)', async value => {
      global.fetch = vi.fn();
      await expect(callAzureSpeechTranscription({ apiKey: value, audioBlob: new Blob(['wav']) })).rejects.toThrow('Azure Speech');
      expect(global.fetch).not.toHaveBeenCalled();
    });

  it.each([['auto', null], ['zh', 'zh-TW'], ['en', 'en-US'], ['ja', 'ja-JP'], ['ko', 'ko-KR']])(
    '一般轉錄 %s 的語言、區域與認證會套到同一個 Azure 請求', async (language, locale) => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ phrases: [] }) });
      const samples = new Float32Array(16000);
      await transcribeAudioStream({
        audioBuffer: { duration: 1, length: samples.length, sampleRate: 16000, numberOfChannels: 1, getChannelData: () => samples },
        provider: 'azure', taskMode: 'transcribe', apiKey: ' KoreaCentral:mock-key ', azureRegion: 'eastus',
        azurePhrases: ['歷史草稿'], azureProfanity: 'Removed', language
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, options] = global.fetch.mock.calls[0];
      expect(new URL(url).host).toBe('koreacentral.api.cognitive.microsoft.com');
      expect(options).toMatchObject({ redirect: 'error', headers: { 'Ocp-Apim-Subscription-Key': 'mock-key' } });
      const definition = JSON.parse(options.body.get('definition'));
      if (locale) expect(definition.locales).toEqual([locale]);
      else expect(definition).not.toHaveProperty('locales');
      expect(definition).not.toHaveProperty('phraseList');
      expect(definition.profanityFilterMode).toBe('None');
    });

  it('統一辨識入口會把 Azure 設定送到 Fast Transcription', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        combinedPhrases: [{ text: 'Azure Speech works.' }],
        phrases: [{
          offsetMilliseconds: 250,
          durationMilliseconds: 1000,
          text: 'Azure Speech works.',
          words: []
        }]
      })
    });
    global.fetch = fetchMock;
    const sampleRate = 48000;
    const audioBuffer = {
      sampleRate,
      numberOfChannels: 1,
      length: sampleRate * 2,
      duration: 2,
      getChannelData: () => new Float32Array(sampleRate * 2).fill(0.25)
    };

    const segments = await transcribeAudioStream({
      audioBuffer,
      inT: 0,
      outT: 2,
      provider: 'azure',
      apiKey: 'azure-test-key',
      azureRegion: 'southeastasia',
      language: 'en',
      azurePhrases: ['Azure Speech']
    });

    expect(segments).toEqual([expect.objectContaining({
      start: 0.25,
      end: 1.25,
      text: 'Azure Speech works.'
    })]);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('southeastasia.api.cognitive.microsoft.com');
    expect(JSON.parse(options.body.get('definition'))).toEqual({
      diarization: { enabled: true, maxSpeakers: 10 },
      profanityFilterMode: 'None',
      locales: ['en-US'],
      phraseList: { phrases: ['Azure Speech'] }
    });
  });

  it('文本匹配預設自動語言，取回 Azure 的逐詞時間供每一行原稿對位', async () => {
    const samples = new Float32Array(32000);
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      durationMilliseconds: 2000,
      phrases: [{ text: 'Good morning everyone.', offsetMilliseconds: 100, durationMilliseconds: 1780, locale: 'en-US', words: [
        { text: 'Good', offsetMilliseconds: 175, durationMilliseconds: 225 },
        { text: 'morning', offsetMilliseconds: 530, durationMilliseconds: 325 },
        { text: 'everyone.', offsetMilliseconds: 1300, durationMilliseconds: 310 }
      ] }]
    }) });
    const evidenceSegments = await transcribeAudioStream({
      provider: 'azure', taskMode: 'align', apiKey: 'westus2:mock-key', azureRegion: 'japaneast',
      azurePhrases: ['舊版名詞'], azureProfanity: 'Masked',
      audioBuffer: { duration: 2, length: samples.length, sampleRate: 16000, numberOfChannels: 1, getChannelData: () => samples }
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(new URL(url).hostname).toBe('westus2.api.cognitive.microsoft.com');
    expect(options.headers['Ocp-Apim-Subscription-Key']).toBe('mock-key');
    expect(JSON.parse(options.body.get('definition'))).toEqual({
      diarization: { enabled: true, maxSpeakers: 10 }, profanityFilterMode: 'None'
    });
    const { alignment, segments } = resolveRecognitionAlignment({ taskMode: 'align', transcript: 'Good morning\nEveryone!', evidenceSegments });
    expect(alignment.summary.timingEvidence).toBe('word');
    expect(segments.map(({ text, start, end }) => [text, start, end])).toEqual([
      ['Good morning', 0.175, 0.855], ['Everyone!', 1.3, 1.61]
    ]);
  });
});
