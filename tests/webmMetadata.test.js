import { afterEach, describe, expect, it, vi } from 'vitest';
import { webmPresentationMetadata } from '../src/decode/webm-metadata.js';
import { sourceFrameWindow, sourcePresentationMetadata, clearSourceFrameIndexes } from '../src/decode/source-frame-index.js';
import { createAudioEngineForTest } from '../src/audio-engine.js';

afterEach(() => { clearSourceFrameIndexes(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function element(id, contents) {
  return [...id, 0x80 | contents.length, ...contents];
}

function movie() {
  const duration = new Uint8Array(8);
  new DataView(duration.buffer).setFloat64(0, 2000);
  return new Uint8Array([
    ...element([0x1a, 0x45, 0xdf, 0xa3], []),
    ...element([0x18, 0x53, 0x80, 0x67], [
      ...element([0x15, 0x49, 0xa9, 0x66], [
        ...element([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]),
        ...element([0x44, 0x89], [...duration]),
      ]),
      ...element([0x16, 0x54, 0xae, 0x6b], element([0xae], [
        ...element([0xd7], [1]), ...element([0x83], [1]),
      ])),
      ...element([0x1f, 0x43, 0xb6, 0x75], [
        ...element([0xe7], [0x03, 0xe8]),
        ...element([0xa3], [0x81, 0x01, 0xf4, 0x80, 0]),
      ]),
    ]),
  ]);
}

function movieWithAudio() {
  const duration=new Uint8Array(8);new DataView(duration.buffer).setFloat64(0,2000);
  return new Uint8Array([
    ...element([0x1a,0x45,0xdf,0xa3],[]),
    ...element([0x18,0x53,0x80,0x67],[
      ...element([0x15,0x49,0xa9,0x66],[...element([0x2a,0xd7,0xb1],[0x0f,0x42,0x40]),...element([0x44,0x89],[...duration])]),
      ...element([0x16,0x54,0xae,0x6b],[
        ...element([0xae],[...element([0xd7],[1]),...element([0x83],[1])]),
        ...element([0xae],[...element([0xd7],[2]),...element([0x83],[2])]),
      ]),
      ...element([0x1f,0x43,0xb6,0x75],[...element([0xe7],[0x03,0xe8]),
        ...element([0xa3],[0x81,0x01,0xf4,0x80,0]),...element([0xa3],[0x82,0,0,0x80,0])]),
    ]),
  ]);
}

describe('WebM metadata 的有界回應讀取', () => {
  it('同一來源暫時只有短標頭時不保留空結果，完整資料回來後可恢復來源時鐘', async () => {
    const bytes=movie();let available=16;
    vi.stubGlobal('fetch',vi.fn(async (_url,{headers})=>{
      const end=Number(/bytes=0-(\d+)/.exec(headers.Range)[1])+1;
      return new Response(bytes.subarray(0,Math.min(end,available)));
    }));
    expect(await sourcePresentationMetadata('blob:recoverable')).toBeNull();
    available=bytes.length;
    expect(await sourcePresentationMetadata('blob:recoverable')).toEqual({presentationTimestampOffset:-1.5,duration:0.5});
  });

  it('短標頭恢復後實際 AudioEngine 使用同 URL 校正 PCM 原點', async () => {
    const bytes=movieWithAudio();let available=16;
    vi.stubGlobal('fetch',vi.fn(async (_url,{headers})=>{
      const end=Number(/bytes=0-(\d+)/.exec(headers.Range)[1])+1;
      return new Response(bytes.subarray(0,Math.min(end,available)));
    }));
    const pcm=data=>({numberOfChannels:1,length:data.length,sampleRate:10,getChannelData:()=>data});
    const original=pcm(Float32Array.from([1,2,3,4,5,6,7,8,9,10]));
    const context={state:'running',destination:{},createGain:()=>({connect(){}}),
      createAnalyser:()=>({fftSize:8}),createBuffer:(_channels,length)=>pcm(new Float32Array(length))};
    const audio=createAudioEngineForTest({createContext:()=>context});
    expect(await sourcePresentationMetadata('blob:audio-recoverable')).toBeNull();
    available=bytes.length;
    const aligned=await audio.normalizeSourceAudioBuffer(original,{url:'blob:audio-recoverable'});
    expect([...aligned.getChannelData(0)]).toEqual([6,7,8,9,10]);
  });

  it('標頭已知影片但首個音訊 block 尚未完整時，之後可補回音訊原點', async () => {
    const bytes=movieWithAudio();let available=bytes.length-4;
    vi.stubGlobal('fetch',vi.fn(async (_url,{headers})=>{
      const end=Number(/bytes=0-(\d+)/.exec(headers.Range)[1])+1;
      return new Response(bytes.subarray(0,Math.min(end,available)));
    }));
    const partial=await sourcePresentationMetadata('blob:partial-audio');
    expect(partial.audioPresentationTimestampOffsets).toEqual([null]);
    available=bytes.length;
    const complete=await sourcePresentationMetadata('blob:partial-audio');
    expect(complete.audioPresentationTimestampOffsets).toEqual([-1]);
    expect(complete.decoderAudioPresentationTimestampOffsets).toEqual([-1]);
  });

  it('部分來源時鐘在補讀失敗時仍保留既有影片證據，恢復後再補完音訊', async () => {
    const bytes=movieWithAudio();let available=bytes.length-4,fail=false;
    vi.stubGlobal('fetch',vi.fn(async (_url,{headers})=>{
      if(fail)throw new Error('暫時讀取失敗');
      const end=Number(/bytes=0-(\d+)/.exec(headers.Range)[1])+1;
      return new Response(bytes.subarray(0,Math.min(end,available)));
    }));
    const partial=await sourcePresentationMetadata('blob:partial-preserved');
    expect(partial.presentationTimestampOffset).toBe(-1.5);
    expect(partial.audioPresentationTimestampOffsets).toEqual([null]);
    fail=true;expect(await sourcePresentationMetadata('blob:partial-preserved')).toEqual(partial);
    fail=false;available=bytes.length;
    expect((await sourcePresentationMetadata('blob:partial-preserved')).audioPresentationTimestampOffsets).toEqual([-1]);
  });

  it('逐格查詢對暫時無證據的來源限流，到期後可恢復而非每格重新讀取', async () => {
    const bytes=movie();let available=16,now=0;
    vi.spyOn(Date,'now').mockImplementation(()=>now);
    vi.stubGlobal('fetch',vi.fn(async (_url,{headers})=>{
      const end=Number(/bytes=0-(\d+)/.exec(headers.Range)[1])+1;
      return new Response(bytes.subarray(0,Math.min(end,available)));
    }));
    expect(await sourceFrameWindow('blob:partial',0)).toBeNull();
    expect(await sourceFrameWindow('blob:partial',0)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    available=bytes.length;now=1001;
    expect(await sourceFrameWindow('blob:partial',0)).toBeNull(); // WebM 此處只提供 metadata。
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(await sourcePresentationMetadata('blob:partial')).toEqual({presentationTimestampOffset:-1.5,duration:0.5});
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('重設前晚到的空結果不能覆寫同 URL 已恢復的來源時鐘', async () => {
    const bytes=movie();let call=0,release,entered;
    const waiting=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    vi.stubGlobal('fetch',vi.fn(async (_url,{headers})=>{
      const end=Number(/bytes=0-(\d+)/.exec(headers.Range)[1])+1;
      if(++call===2){entered();await gate;return new Response(bytes.subarray(0,16));}
      return new Response(bytes.subarray(0,end));
    }));
    const old=sourcePresentationMetadata('blob:replacement');
    await waiting;clearSourceFrameIndexes();
    expect(await sourcePresentationMetadata('blob:replacement')).toEqual({presentationTimestampOffset:-1.5,duration:0.5});
    release();expect(await old).toBeNull();
    const count=fetch.mock.calls.length;
    expect(await sourcePresentationMetadata('blob:replacement')).toEqual({presentationTimestampOffset:-1.5,duration:0.5});
    expect(fetch).toHaveBeenCalledTimes(count);
  });

  it.each([null, '1'])('長度標頭 %s 不能讓忽略 Range 的回應整檔載入', async length => {
    let pulls = 0;
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      pull(controller) {
        if (++pulls <= 8) controller.enqueue(new Uint8Array(8));
        else controller.close();
      }, cancel,
    }, { highWaterMark: 0 }), { headers: length ? { 'content-length': length } : {} })));

    await expect(webmPresentationMetadata('source.webm')).rejects.toThrow();
    expect(pulls).toBe(3);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('合法分段回應仍回報實際首格原點與來源片長', async () => {
    const bytes = movie();
    vi.stubGlobal('fetch', vi.fn(async (url, { headers }) => {
      const end = Number(/bytes=0-(\d+)/.exec(headers.Range)[1]) + 1;
      return new Response(new ReadableStream({
        start(controller) {
          const selected = bytes.subarray(0, end);
          controller.enqueue(selected.subarray(0, 7));
          controller.enqueue(selected.subarray(7));
          controller.close();
        },
      }));
    }));

    await expect(webmPresentationMetadata('source.webm')).resolves.toEqual({
      presentationTimestampOffset: -1.5, duration: 0.5,
    });
    expect(fetch.mock.calls.map(([, { headers }]) => headers.Range)).toEqual(['bytes=0-15', 'bytes=0-1048575']);
  });
});
