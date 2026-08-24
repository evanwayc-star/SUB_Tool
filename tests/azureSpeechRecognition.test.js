import { describe, expect, it, vi } from 'vitest';

import {
  callAzureSpeechTranscription,
  parseAzureTranscriptionResponse,
  transcribeAudioStream
} from '../src/speech-recognition-engine.js';

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
      locales: ['zh-TW'],
      phraseList: { phrases: ['SUB Tool', 'Evan'] }
    });
  });

  it('Azure 認證失敗訊息不會洩漏 Speech Key', async () => {
    const secret = 'azure-super-secret-key';
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: { message: `Invalid subscription key: ${secret}` } })
    });

    let caught;
    try {
      await callAzureSpeechTranscription({
        audioBlob: new Blob(['wav'], { type: 'audio/wav' }),
        apiKey: secret,
        region: 'southeastasia',
        language: 'en'
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toContain('HTTP 401');
    expect(caught.message).not.toContain(secret);
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
      locales: ['en-US'],
      phraseList: { phrases: ['Azure Speech'] }
    });
  });
});
