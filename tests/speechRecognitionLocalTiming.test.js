// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { transcribeAudioStream } from '../src/speech-recognition-engine.js';
import { transcribeBuiltinAudioInWorker } from '../src/speech-recognition-worker-client.js';

vi.mock('../src/speech-recognition-worker-client.js', () => ({transcribeBuiltinAudioInWorker:vi.fn()}));
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

function recognize() {
  const samples = new Float32Array(4 * 16000).fill(.25);
  return transcribeAudioStream({
    audioBuffer:{ duration:4, sampleRate:16000, length:samples.length, numberOfChannels:1, getChannelData:() => samples },
    provider:'openai', openaiTiming:'local', taskMode:'transcribe', language:'en',
    apiKey:'test', projectTerms:['SUB Tool', ' SUB Tool ', 'Taipei']
  });
}

describe('OpenAI 原文與本機對時', () => {
  it('只將有證據的句子定時，保留供應商的標點及未出現在本機結果的句子', async () => {
    const words = [{text:'Hello', start:.25, end:.5}, {text:'world', start:.6, end:.9}];
    transcribeBuiltinAudioInWorker.mockResolvedValue({segments:[{text:'hello world', start:.25, end:.9, words}]});
    const cloud = vi.fn(async () => new Response(JSON.stringify({
      text:'Hello world!\nCompletely unrelated.', languages:[{code:'en'}]
    })));
    vi.stubGlobal('fetch', cloud);
    const result = await recognize();
    const body = cloud.mock.calls[0][1].body;
    expect(body.get('model')).toBe('gpt-transcribe');
    expect(body.getAll('keywords[]')).toEqual(['SUB Tool', 'Taipei']);
    expect(body.getAll('languages[]')).toEqual(['en']);
    expect(body.has('timestamp_granularities[]')).toBe(false);
    expect(result).toMatchObject([{text:'Hello world!', start:.25, end:.9, words}, {
      text:'Completely unrelated.', timed:false, start:0, end:0
    }]);
  });

  it('本機模型未就緒時尚未送出雲端請求', async () => {
    transcribeBuiltinAudioInWorker.mockRejectedValue(new Error('模型未就緒'));
    const cloud = vi.fn();
    vi.stubGlobal('fetch', cloud);
    await expect(recognize()).rejects.toThrow('模型未就緒');
    expect(cloud).not.toHaveBeenCalled();
  });
});
