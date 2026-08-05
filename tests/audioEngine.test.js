// @vitest-environment jsdom
/* Web Audio 傳輸層（src/audio-engine.js）。

   這 250 多行在 v6.1.2 之前【一行測試都沒有】——模組層直接 `new AudioContext()`，
   vitest 的 node 環境起不動、jsdom 也沒有 Web Audio，於是播放起停、序列時間域
   換算、scrub 與可聽性篩選全部碰不到。改成注入 createContext 之後就測得到了。

   這裡守的重點：
     - 可聽性只有 project-audio.js 一份判準（Solo 是【專案級】，且預覽語意要
       排除被來源篩選藏起來的聲道）。此檔曾有兩處寫法不一致。
     - 時間域（鐵律 §0.5）：序列模式下 offset 必須經過 sourceTimeFor／
       externalSourceTimeFor 換算，不可以直接拿時間軸時間去設 currentTime。
     - 具名參數：以前是 6～11 個位置參數，寫錯順序型別還都對得上。

   測不到的：真正的聲音。那需要真機驗收（AGENTS.md §4）。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAudioEngineForTest } from '../src/audio-engine.js';

/* 夠用就好的假 AudioContext——只實作被碰到的那幾個工廠與屬性。 */
function fakeContext() {
  const created = [];
  return {
    currentTime: 10,
    state: 'running',
    destination: { id: 'destination' },
    resume: vi.fn(),
    createGain: () => ({ connect: vi.fn(), gain: { value: 1 } }),
    createAnalyser: () => ({ fftSize: 2048, getFloatTimeDomainData: vi.fn() }),
    createBufferSource() {
      const node = {
        buffer: null,
        playbackRate: { value: 1 },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        disconnect: vi.fn(),
      };
      created.push(node);
      return node;
    },
    _created: created,
  };
}

function engineWithCtx() {
  const ctx = fakeContext();
  const engine = createAudioEngineForTest({ createContext: () => ctx });
  engine.ensureCtx();
  return { engine, ctx };
}

const bufferTrack = (over = {}) => ({
  kind: 'buffer',
  buffer: { duration: 100 },
  gain: { connect: vi.fn() },
  muted: false, solo: false,
  ...over,
});

const elementTrack = (over = {}) => ({
  kind: 'element',
  source: 'video',
  muted: false, solo: false,
  el: { currentTime: 0, duration: 100, playbackRate: 1, play: vi.fn(), pause: vi.fn() },
  ...over,
});

describe('ensureCtx', () => {
  it('只建立一次 AudioContext，並接好 master → destination 與 analyser', () => {
    const ctx = fakeContext();
    const createContext = vi.fn(() => ctx);
    const engine = createAudioEngineForTest({ createContext });
    expect(engine.ensureCtx()).toBe(ctx);
    expect(engine.ensureCtx()).toBe(ctx);
    expect(createContext).toHaveBeenCalledTimes(1);
    expect(engine.master).toBeTruthy();
    expect(engine.analyser.fftSize).toBe(2048);
  });

  it('suspended 的 context 會被 resume（瀏覽器自動播放政策）', () => {
    const ctx = fakeContext();
    ctx.state = 'suspended';
    const engine = createAudioEngineForTest({ createContext: () => ctx });
    engine.ensureCtx();
    expect(ctx.resume).toHaveBeenCalled();
  });
});

describe('readTimeDomain', () => {
  it('還沒有 AudioContext 時回 null，不可以丟例外', () => {
    const engine = createAudioEngineForTest({ createContext: () => fakeContext() });
    expect(engine.readTimeDomain()).toBe(null);
  });

  /* Wave.captureLive() 曾因為讀取端留在 media.js 而永遠拿不到資料
     （守衛 `if(!Media.analyser) return` 永遠成立）。這裡鎖住入口存在且可用。 */
  it('有 context 時回傳緩衝區並向 analyser 取樣', () => {
    const { engine } = engineWithCtx();
    const buf = engine.readTimeDomain();
    expect(buf).toBeInstanceOf(Float32Array);
    expect(engine.analyser.getFloatTimeDomainData).toHaveBeenCalledWith(buf);
  });
});

describe('startBufferSources：序列模式的時間域換算（§0.5）', () => {
  it('非序列模式直接用 offset', () => {
    const { engine, ctx } = engineWithCtx();
    const tr = bufferTrack();
    const res = engine.startBufferSources([tr], { offset: 42 });
    expect(res.startMediaTime).toBe(42);
    expect(res.startCtxTime).toBe(ctx.currentTime);
    expect(ctx._created[0].start).toHaveBeenCalledWith(0, 42);
  });

  it('序列模式改用 sourceTimeFor(tlTime) 的來源時間', () => {
    const { engine, ctx } = engineWithCtx();
    const sourceTimeFor = vi.fn(() => 7);
    const res = engine.startBufferSources([bufferTrack()], {
      offset: 42, seqOn: true, tlTime: 99, sourceTimeFor,
    });
    expect(sourceTimeFor).toHaveBeenCalledWith('video', 99);
    expect(res.startMediaTime).toBe(7);
    expect(ctx._created[0].start).toHaveBeenCalledWith(0, 7);
  });

  it('sourceTimeFor 回 null（播放頭不在此來源上）時保留原 offset', () => {
    const { engine } = engineWithCtx();
    const res = engine.startBufferSources([bufferTrack()], {
      offset: 42, seqOn: true, tlTime: 99, sourceTimeFor: () => null,
    });
    expect(res.startMediaTime).toBe(42);
  });

  it('offset 會被夾在 [0, buffer.duration]', () => {
    const { engine, ctx } = engineWithCtx();
    engine.startBufferSources([bufferTrack({ buffer: { duration: 5 } })], { offset: 999 });
    expect(ctx._created[0].start).toHaveBeenCalledWith(0, 5);
  });

  it('_srcHidden 的聲道不發聲', () => {
    const { engine, ctx } = engineWithCtx();
    engine.startBufferSources([bufferTrack({ _srcHidden: true })], { offset: 0 });
    expect(ctx._created.length).toBe(0);
  });

  it('沒有 AudioContext 時回 null，不可以丟例外', () => {
    const engine = createAudioEngineForTest({ createContext: () => fakeContext() });
    expect(engine.startBufferSources([bufferTrack()], { offset: 0 })).toBe(null);
  });
});

describe('stopBufferSources', () => {
  it('停止並斷開，且把 srcNode 清乾淨（不清會重複 stop 丟例外）', () => {
    const { engine, ctx } = engineWithCtx();
    const tr = bufferTrack();
    engine.startBufferSources([tr], { offset: 0 });
    const node = ctx._created[0];
    engine.stopBufferSources([tr]);
    expect(node.stop).toHaveBeenCalled();
    expect(node.disconnect).toHaveBeenCalled();
    expect(tr.srcNode).toBe(null);
  });
});

describe('startElementSources：來源類型決定用哪個時間域（§0.5）', () => {
  it('非序列模式用 localT（來源時間）', () => {
    const { engine } = engineWithCtx();
    const tr = elementTrack();
    engine.startElementSources([tr], { localT: 12, tlT: 99 });
    expect(tr.el.currentTime).toBe(12);
    expect(tr.el.play).toHaveBeenCalled();
  });

  it('ext-* 來源用 externalSourceTimeFor(tlT)——它吃的是時間軸時間', () => {
    const { engine } = engineWithCtx();
    const tr = elementTrack({ source: 'ext-3' });
    const externalSourceTimeFor = vi.fn(() => 5);
    engine.startElementSources([tr], { localT: 12, tlT: 99, externalSourceTimeFor });
    expect(externalSourceTimeFor).toHaveBeenCalledWith('ext-3', 99);
    expect(tr.el.currentTime).toBe(5);
  });

  it('ext-* 落在素材範圍外（回 null）時暫停，不可以亂放', () => {
    const { engine } = engineWithCtx();
    const tr = elementTrack({ source: 'ext-3' });
    engine.startElementSources([tr], { localT: 12, tlT: 99, externalSourceTimeFor: () => null });
    expect(tr.el.pause).toHaveBeenCalled();
    expect(tr.el.play).not.toHaveBeenCalled();
  });

  it('序列模式用 sourceTimeFor；回 null 時暫停', () => {
    const { engine } = engineWithCtx();
    const play = elementTrack();
    engine.startElementSources([play], { localT: 12, tlT: 99, seqOn: true, sourceTimeFor: () => 3 });
    expect(play.el.currentTime).toBe(3);

    const skip = elementTrack();
    engine.startElementSources([skip], { localT: 12, tlT: 99, seqOn: true, sourceTimeFor: () => null });
    expect(skip.el.pause).toHaveBeenCalled();
    expect(skip.el.play).not.toHaveBeenCalled();
  });

  it('_srcHidden 的聲道直接暫停', () => {
    const { engine } = engineWithCtx();
    const tr = elementTrack({ _srcHidden: true });
    engine.startElementSources([tr], { localT: 12, tlT: 12 });
    expect(tr.el.pause).toHaveBeenCalled();
    expect(tr.el.play).not.toHaveBeenCalled();
  });

  it('preservesPitch 只在 0.25–4 倍速間開啟（超出範圍瀏覽器會爆音）', () => {
    const { engine } = engineWithCtx();
    const inRange = elementTrack();
    inRange.el.preservesPitch = false;
    engine.startElementSources([inRange], { localT: 0, tlT: 0, playbackRate: 2 });
    expect(inRange.el.preservesPitch).toBe(true);

    const outOfRange = elementTrack();
    outOfRange.el.preservesPitch = true;
    engine.startElementSources([outOfRange], { localT: 0, tlT: 0, playbackRate: 8 });
    expect(outOfRange.el.preservesPitch).toBe(false);
  });
});

describe('scrubAudio：可聽性只有一份判準', () => {
  let engine, ctx;
  beforeEach(() => { ({ engine, ctx } = engineWithCtx()); });

  it('播放中或靜音時什麼都不做', () => {
    expect(engine.scrubAudio([bufferTrack()], { at: 1, playing: true })).toBeUndefined();
    expect(engine.scrubAudio([bufferTrack()], { at: 1, muted: true })).toBeUndefined();
    expect(ctx._created.length).toBe(0);
  });

  /* 這一條是重點：此檔曾有兩處 anySolo，一處排除 _srcHidden、一處沒有。
     被藏起來的聲道若把 Solo 帶進判斷，可見的未靜音聲道就會整組被判為不可聽。 */
  it('預覽語意：被 _srcHidden 藏起來的聲道不把 Solo 帶進判斷', () => {
    const hidden = bufferTrack({ solo: true, _srcHidden: true });
    const visible = bufferTrack({ muted: false });
    engine.scrubAudio([hidden, visible], { at: 1, duration: 0.15 });
    expect(ctx._created.length, '可見且未靜音的聲道應該要出聲').toBe(1);
  });

  it('有可見的 Solo 時，未 Solo 的聲道不出聲', () => {
    const soloed = bufferTrack({ solo: true });
    const other = bufferTrack({ solo: false });
    engine.scrubAudio([soloed, other], { at: 1, duration: 0.15 });
    expect(ctx._created.length).toBe(1);
  });

  it('沒有 Solo 時，靜音的不出聲、未靜音的出聲', () => {
    engine.scrubAudio([bufferTrack({ muted: true }), bufferTrack({ muted: false })], { at: 1, duration: 0.15 });
    expect(ctx._created.length).toBe(1);
  });

  it('全部不可聽且 activeSource 是主影片時，回報要改 scrub 主 <video>', () => {
    const res = engine.scrubAudio([bufferTrack({ muted: true })], { at: 1, duration: 0.15, activeSource: 'video' });
    expect(res).toEqual({ scrubMainVideo: true, localT: 1 });
  });

  it('有可聽的軌時不要求主影片接手', () => {
    const res = engine.scrubAudio([bufferTrack()], { at: 1, duration: 0.15, activeSource: 'video' });
    expect(res.scrubMainVideo).toBe(false);
  });
});
