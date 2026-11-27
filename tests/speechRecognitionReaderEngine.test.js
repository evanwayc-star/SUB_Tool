// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

const worker = vi.hoisted(() => ({ transcribeBuiltinAudioInWorker: vi.fn() }));
vi.mock('../src/speech-recognition-worker-client.js', () => worker);
import { transcribeAudioStream } from '../src/speech-recognition-engine.js';
import { resolveRecognitionAlignment } from '../src/transcript-alignment.js';

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

it('全零不上傳，微弱語音仍辨識；相同短段重跑沿用結果，詞表變更會重新辨識',async()=>{
  vi.stubGlobal('crypto',webcrypto);
  const cache=new Map(),checkpoints={read:key=>cache.get(key),write:(key,value)=>cache.set(key,value)};
  const options={provider:'groq',taskMode:'transcribe',apiKey:'mock',inT:0,outT:4,checkpoints};
  await transcribeAudioStream({...options,audioBuffer:pcm(4,0)});
  expect(fetch).not.toHaveBeenCalled();
  const source=pcm(4,0);source.getChannelData(0)[32000]=.000001;
  await transcribeAudioStream({...options,audioBuffer:source});
  await transcribeAudioStream({...options,audioBuffer:source});
  expect(fetch).toHaveBeenCalledOnce();
  await transcribeAudioStream({...options,projectTerms:['人名'],audioBuffer:source});
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('延長剪輯 OUT 沿用相同已完成視窗，來源 PCM 只讀一次',async()=>{
  vi.stubGlobal('crypto',webcrypto);
  const cache=new Map(),checkpoints={read:key=>cache.get(key),write:(key,value)=>cache.set(key,value)};
  const options={inT:0,provider:'builtin',taskMode:'transcribe',checkpoints};
  await transcribeAudioStream({...options,audioBuffer:reader(1210),outT:610});
  worker.transcribeBuiltinAudioInWorker.mockClear();
  const longer=reader(1210),progress=vi.fn();
  await transcribeAudioStream({...options,audioBuffer:longer,outT:1210,onProgress:progress});
  expect(progress.mock.calls.filter(([p])=>p.message.includes('已還原'))).toHaveLength(1);
  expect(worker.transcribeBuiltinAudioInWorker).toHaveBeenCalledTimes(2);
  expect(longer.readRange.mock.calls.reduce((sum,[s,e])=>sum+e-s,0)).toBeCloseTo(1210,8);
});

it('聲紋標籤只在供應商一次回應內有效，還原快取沿用當時識別',async()=>{
  vi.stubGlobal('crypto',webcrypto);
  const cache=new Map(),checkpoints={read:key=>cache.get(key),write:(key,rows)=>cache.set(key,structuredClone(rows))};
  fetch.mockResolvedValue({ok:true,json:async()=>({segments:[{text:'Hi',start:.1,end:.3,speaker:'A'}]})});
  const options={provider:'openai',taskMode:'transcribe',audioBuffer:reader(601),apiKey:'test',inT:0,outT:601,checkpoints};
  const first=await transcribeAudioStream(options),again=await transcribeAudioStream(options);
  expect(first).toHaveLength(2);
  expect(first[0].speakerScope).not.toBe(first[1].speakerScope);
  expect(again.map(segment=>segment.speakerScope)).toEqual(first.map(segment=>segment.speakerScope));
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('第三段中斷後重開只重做缺段，仍保留時間、語言及字幕順序', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const cache = new Map();
  const checkpoints = { read: key => cache.get(key), write: (key, value) => cache.set(key, JSON.parse(JSON.stringify(value))) };
  const options = { provider: 'builtin', taskMode: 'transcribe', language: 'auto', checkpoints, channelSelection: 'all' };
  const response = word => ({ language:'chinese', segments:[{ text: word, start:1, end:2 }] });
  const recognize = worker.transcribeBuiltinAudioInWorker;
  recognize.mockResolvedValueOnce(response('学校')).mockResolvedValueOnce(response('软件')).mockRejectedValueOnce(new Error('interrupted'));
  await expect(transcribeAudioStream({ ...options, audioBuffer:reader(1210) })).rejects.toThrow('interrupted');
  expect(cache.size).toBe(2);
  recognize.mockClear().mockResolvedValue(response('国立'));
  const progress = vi.fn();
  const result = await transcribeAudioStream({ ...options, audioBuffer:reader(1210), onProgress:progress });
  expect(recognize).toHaveBeenCalledTimes(1);
  expect(progress.mock.calls.filter(([status])=>status.message.includes('已還原'))).toHaveLength(2);
  expect(result.map(segment=>segment.text)).toContain('學校');
  expect(result.every((entry,i)=>i===0 || entry.start>result[i-1].start)).toBe(true);
  expect(cache.size).toBe(3);
  recognize.mockClear();
  await transcribeAudioStream({ ...options, channelSelection:'dialogue', audioBuffer:reader(1210) });
  expect(recognize).toHaveBeenCalledTimes(3);
});

it.each(['google', 'openai'])('%s 自動辨識回傳未標語言的華語時，轉為繁體並保留原詞', async provider => {
  const text = '我 在 用 数 据 库 。';
  const responseData = provider === 'google'
    ? { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text,
      annotations: text.split(' ').map((word, index) => ({ type: 'word_info', text: word,
        start_offset: `${index + 1}s`, end_offset: `${index + 1}.5s` })) }] }] }
    : { text, segments: [{ text, start: 1, end: 7.5, speaker: 'A' }] };
  fetch.mockResolvedValue({ ok: true, json: async () => responseData });

  const segments = await transcribeAudioStream({ audioBuffer: pcm(8), provider, apiKey: 'test',
    taskMode: 'transcribe', language: 'auto' });

  expect(segments).toMatchObject([{ start: 1, end: 7.5, text: '我在用數據庫。' }]);
});

it.each([
  ['chinese', '国 立 学 校', '國立學校'],
  ['japanese', '中国語：「謝謝」。', '中国語：「謝謝」。'],
  [undefined, '中国語の「謝謝」', '中国語の「謝謝」'],
  [undefined, '国立学校', '国立学校'],
  ['korean', '오늘 날씨가 좋네요.', '오늘 날씨가 좋네요.'],
  ['english', 'Adobe Premiere is ready.', 'Adobe Premiere is ready.']
])('Groq 自動偵測語言 %s 時保留正確的文字和詞間空白', async (language, text, expected) => {
  fetch.mockResolvedValue({ ok: true, json: async () => ({ language, text,
    segments: [{ start: 0.25, end: 0.75, text }] }) });

  const segments = await transcribeAudioStream({ audioBuffer: pcm(1), provider: 'groq', apiKey: 'test',
    taskMode: 'transcribe', language: 'auto' });

  expect(segments).toMatchObject([{ start: 0.25, end: 0.75, text: expected }]);
});

it.each([
  ['azure', { durationMilliseconds: 1000, phrases: [{ locale: 'zh-CN',
    text: '国 立 学 校', offsetMilliseconds: 250, durationMilliseconds: 500 }] }],
  ['elevenlabs', { language_code: 'zho', text: '国 立 学 校', words: [
    { type: 'word', text: '国立', start: 0.25, end: 0.5 },
    { type: 'word', text: '学校', start: 0.5, end: 0.75 }
  ] }]
])('%s 自動辨識可依服務回傳的中文語言代碼整理字幕', async (provider, data) => {
  fetch.mockResolvedValue({ ok: true, json: async () => data });

  const segments = await transcribeAudioStream({ audioBuffer: pcm(1), provider, apiKey: 'test',
    taskMode: 'transcribe', language: 'auto' });

  expect(segments).toMatchObject([{ start: 0.25, end: 0.75, text: '國立學校' }]);
});

it.each([
  ['zh', '軟體、滑鼠、資料庫。'],
  ['auto', '軟件、鼠標、數據庫。']
])('句級文本匹配保留 %s 原稿和時間', async (language, transcript) => {
  const text = '软件、鼠标、数据库。';
  fetch.mockResolvedValue({ ok: true, json: async () => ({ language: 'chinese', text,
    segments: [{ start: 1, end: 3, text }] }) });

  const evidenceSegments = await transcribeAudioStream({ audioBuffer: reader(8), inT: 2, outT: 6,
    provider: 'groq', apiKey: 'test', taskMode: 'align', language });
  const { alignment, segments } = resolveRecognitionAlignment({ taskMode: 'align', transcript, evidenceSegments });

  expect(alignment.status).toBe('aligned');
  expect(alignment.summary.coverage).toBe(1);
  expect(segments).toMatchObject([{ start: 1, end: 3, text: transcript, timed: true,
    alignment: { timingEvidence: 'segment' } }]);
});

it('瀏覽器長音檔的 Gemini 文本匹配分批取逐字時間並還原到選定範圍', async () => {
  const lengths = [];
  fetch.mockImplementation(async (url, options) => {
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(Buffer.byteLength(options.body, 'utf8')).toBeLessThanOrEqual(20_000_000);
    const body = JSON.parse(options.body);
    expect(body.model).toBe('models/gemini-3.5-transcribe');
    const wav = Buffer.from(body.input[0].data, 'base64');
    lengths.push(wav.readUInt32LE(40) / 32000);
    const text = `Part ${lengths.length}!`;
    return { ok: true, json: async () => ({ status:'completed', steps:[{ type:'model_output',
      content:[{type:'text', text, annotations:[{type:'word_info', text, start_offset:'11s', end_offset:'11.5s'}]}]
    }] }) };
  });
  const duration = 603.5, inT = 1;
  const segments = await transcribeAudioStream({ audioBuffer:pcm(duration), provider:'google', apiKey:'test',
    taskMode:'align', inT, outT:duration });
  expect(lengths.length).toBeGreaterThan(1);
  expect(segments.map(segment=>segment.text)).toEqual(lengths.map((_, index)=>`Part ${index + 1}!`));
  expect(segments[0].start).toBe(11);
  let offset = 0;
  for (let index = 0; index < lengths.length; index++) {
    expect(segments[index].words[0].start).toBeCloseTo(offset + 11, 4);
    offset += lengths[index] - (index < lengths.length - 1 ? 10 : 0);
  }
  expect(offset).toBeCloseTo(duration - inT, 4);
});

it('Google 長片每次上傳的實際 JSON 低於 20 MB，無損 PCM 與重疊來源連續且只加一次 IN 偏移', async () => {
  const source = reader(), uploads = [];
  const inT = 123.125, outT = 744.375;
  const reads=[];
  const sampleAt = index => ((index % 1024) - 512) / 512;
  const encodedSample = value => Math.trunc(value * (value < 0 ? 32768 : 32767));
  source.readRange.mockImplementation(async (start, end) => {
    reads.push({start,end});
    const buffer = pcm(end - start);
    const samples = buffer.getChannelData(0), firstSample = Math.round(start * 16000);
    for (let index = 0; index < samples.length; index++) samples[index] = sampleAt(firstSample + index);
    return buffer;
  });
  fetch.mockImplementation(async (url, options) => {
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(Buffer.byteLength(options.body, 'utf8')).toBeLessThanOrEqual(20_000_000);
    const body = JSON.parse(options.body), wav = Buffer.from(body.input[0].data, 'base64');
    expect(body.input[0].mime_type).toBe('audio/wav');
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(34)).toBe(16);
    const sampleCount = wav.readUInt32LE(40) / 2;
    expect(sampleCount).toBeLessThanOrEqual(300*16000);
    const start=uploads.length?uploads.at(-1).end-10:inT;
    const readSpan={start,end:start+sampleCount/16000};
    for (const index of [0, Math.floor(sampleCount / 2), sampleCount - 1]) {
      expect(wav.readInt16LE(44 + index * 2)).toBe(encodedSample(sampleAt(Math.round(readSpan.start * 16000) + index)));
    }
    uploads.push({ ...readSpan, samples: sampleCount });
    const text = `Part ${uploads.length}!`;
    return { ok:true, json:async()=>({status:'completed',steps:[{type:'model_output',content:[{
      type:'text',text,annotations:[{type:'word_info',text,start_offset:'11s',end_offset:'11.5s'}]
    }]}]}) };
  });
  const segments = await transcribeAudioStream({audioBuffer:source,inT,outT,
    provider:'google',apiKey:'test',taskMode:'transcribe',language:'en'});
  expect(uploads.length).toBeGreaterThan(1);
  expect(uploads[0].start).toBe(inT);
  expect(uploads.at(-1).end).toBe(outT);
  for (let index = 0; index < uploads.length; index++) {
    if (index) expect(uploads[index].start).toBeCloseTo(uploads[index - 1].end - 10, 6);
    expect(segments[index].words[0].start).toBeCloseTo(uploads[index].start - inT + 11, 6);
    expect(segments[index].words[0].end).toBeCloseTo(uploads[index].start - inT + 11.5, 6);
  }
  expect(segments).toHaveLength(uploads.length);
  expect(reads.reduce((sum,span)=>sum+span.end-span.start,0)).toBeCloseTo(outT-inT,8);
  expect(source.close).not.toHaveBeenCalled();
});

it('OpenAI 自動辨識依服務實際段落與說話者交接，長片靜音切點前後各上傳一次', async () => {
  const source = reader(), forms = [];
  const segmentsByChunk = [
    [{ start: 549.5, end: 555.1, text: 'First sentence. Still the same speaker.', speaker: 'A' }],
    [{ start: 0, end: 1.6, text: 'After the cut.', speaker: 'B' }, { start: 5, end: 6, text: 'Again.', speaker: 'B' }]
  ];
  fetch.mockImplementation(async (_url, { body }) => {
    const segments = segmentsByChunk[forms.length];
    forms.push(body);
    return { ok: true, json: async () => ({ segments, text: segments.map(segment => segment.text).join(' ') }) };
  });
  const result = await transcribeAudioStream({ audioBuffer: source, inT: 123, outT: 724,
    provider: 'openai', apiKey: 'test', taskMode: 'transcribe' });
  expect(source.readRange.mock.calls.map(([start, end]) => [start, end])).toEqual([[123,723],[723,724]]);
  for (const body of forms) {
    expect(body.get('model')).toBe('gpt-4o-transcribe-diarize');
    expect(body.get('response_format')).toBe('diarized_json');
    expect(body.get('chunking_strategy')).toBe('auto');
    for (const field of ['timestamp_granularities[]', 'language', 'prompt', 'temperature']) expect(body.has(field)).toBe(false);
  }
  expect(result.map(({text, speaker}) => [text,speaker])).toEqual([['First sentence. Still the same speaker.', 'A'], ['After the cut.', 'B'], ['Again.', 'B']]);
  expect(result[0].speakerScope).toMatch(/^[a-f0-9]{32}$/);
  expect(result[1].speakerScope).not.toBe(result[0].speakerScope);
  expect(result[1].speakerScope).toBe(result[2].speakerScope);
  for (const [i, [start, end]] of [[549.5,555.1],[555.1,556.7],[560.1,561.1]].entries()) {
    expect(result[i].start).toBeCloseTo(start, 6);
    expect(result[i].end).toBeCloseTo(end, 6);
    expect(result[i]).not.toHaveProperty('words');
  }
});

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
      .toEqual([[123,723],[723,724]]);
    expect(uploads).toEqual([17_763_244, 1_788_844]);
    expect(result.flatMap(segment => segment.words.map(word => word.text))).toEqual(['same', 'next']);
    expect(result[1].start).toBeCloseTo(560.1, 6);
    expect(result[1].end).toBeCloseTo(561.1, 6);
    expect(JSON.stringify(result)).not.toContain('_whisperOverlapRef');
  });

  it('桌面長片先依原始詞裁掉重疊段，再整理字幕文字、保留標點與英文詞界', async () => {
    const source = reader();
    const words = '我 在 用 数 据 库 和 Adobe Premiere'.split(' ').map((text, index) => ({
      start: 549 + index / 16, end: 549 + index / 16 + 1 / 32, text
    }));
    const excluded = { start: 550.25, end: 550.5, text: '另 一 句' };
    const text = `「${words.map(word => word.text).join(' ')}。」 ${excluded.text}`;
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ language: 'chinese', text,
      segments: [{ start: words[0].start, end: excluded.end, text }],
      words: [...words, excluded].map(({ text, ...timing }) => ({ ...timing, word: text }))
    }) }).mockResolvedValueOnce(response([{ start: 15, end: 16, text: 'New line.' }]));

    const result = await transcribeAudioStream({ audioBuffer: source, inT: 123, outT: 724,
      provider: 'groq', apiKey: 'test', taskMode: 'transcribe', language: 'auto' });

    expect(result.map(segment => segment.text)).toEqual(['「我在用數據庫和 Adobe Premiere。」', 'New line.']);
    expect(result[0]).toMatchObject({ start: words[0].start, end: words.at(-1).end, words });
    expect(result[1].start).toBeCloseTo(560.1, 6);
    expect(result[1].end).toBeCloseTo(561.1, 6);
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
        expect(Buffer.byteLength(options.body, 'utf8')).toBeLessThanOrEqual(20_000_000);
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
    if (provider === 'google') {
      expect(payloads).toEqual([8_163_244, 8_163_244, 3_545_644]);
      expect(result).toHaveLength(3);
      expect(result[1].start).toBeCloseTo(260.1, 6);
      expect(result[2].start).toBeCloseTo(505.2, 6);
    } else {
      expect(payloads).toEqual([17_763_244, 1_788_844]);
      expect(result).toHaveLength(2);
      expect(result[1].start).toBeCloseTo(560.1, 6);
    }
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
