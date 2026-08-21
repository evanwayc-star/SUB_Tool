// @vitest-environment jsdom
/* Web Audio 傳輸層（src/audio-engine.js）。

   這 250 多行在 v6.1.2 之前【一行測試都沒有】——模組層直接 `new AudioContext()`，
   vitest 的 node 環境起不動、jsdom 也沒有 Web Audio，於是播放起停、序列時間域
   換算、scrub 與可聽性篩選全部碰不到。改成注入 createContext 之後就測得到了。

   v6.1.7 起 transport 的狀態由 bind() 注入一次，呼叫端只傳「這一刻要做什麼」
   （startBuffers(offset) / startElements(localT, tlT) / scrub(at, duration)）。
   以前是每次呼叫都推 6～11 個參數，其中好幾個是回呼——寫錯位置或名字時
   型別又都對得上，會靜默跑出錯的行為。**這份測試自己變短就是介面變好的證據。**

   這裡守的重點：
     - 可聽性只有 project-audio.js 一份判準（Solo 是【專案級】，且預覽語意要
       排除被來源篩選藏起來的聲道）。此檔曾有兩處寫法不一致。
     - 時間域（鐵律 §0.5）：序列模式下 offset 必須經換算，不可以直接拿時間軸
       時間去設 currentTime。
     - 封裝不可有洞：createAnalyser / connectToMaster / isReady / setMasterGain
       都要存在，否則呼叫端會自己去戳 .context / .master（先前有 21 處）。

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
    createAnalyser: () => ({ fftSize: 2048, smoothingTimeConstant: 0, getFloatTimeDomainData: vi.fn() }),
    createBufferSource() {
      const node = {
        buffer: null, playbackRate: { value: 1 },
        connect: vi.fn(), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(),
      };
      created.push(node);
      return node;
    },
    _created: created,
  };
}

/* 建一個接好狀態的引擎。env 的每一項都是 getter（Media 的狀態一直在變）。 */
function engineWith(env = {}, { ready = true } = {}) {
  const ctx = fakeContext();
  const engine = createAudioEngineForTest({ createContext: () => ctx });
  if (ready) engine.ensureCtx();
  engine.bind({
    tracks: () => env.tracks || [],
    seqOn: () => !!env.seqOn,
    playing: () => !!env.playing,
    muted: () => !!env.muted,
    activeSource: () => env.activeSource ?? null,
    activeClipId: () => env.activeClipId ?? null,
    playbackRate: () => env.playbackRate ?? 1,
    timelineTime: () => env.timelineTime ?? 0,
    sourceTimeFor: env.sourceTimeFor || (() => null),
    externalSourceTimeFor: env.externalSourceTimeFor || (() => null),
    clipSourceTimeFor: env.clipSourceTimeFor || (() => 0),
  });
  return { engine, ctx };
}

const bufferTrack = (over = {}) => ({
  kind: 'buffer', buffer: { duration: 100 }, gain: { connect: vi.fn() },
  muted: false, solo: false, ...over,
});

const elementTrack = (over = {}) => ({
  kind: 'element', source: 'video', muted: false, solo: false,
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

/* 封裝有洞時呼叫端會自己去戳內部欄位——v6.1.6 之前全專案有 21 處
   `AudioEngine.context.X` / `AudioEngine.master`，起因就是 wrapper
   少了 createAnalyser。這一組確保那些入口都在。 */
describe('封裝不可有洞', () => {
  it('createAnalyser 存在，並套用預設的 fftSize / smoothing', () => {
    const { engine } = engineWith();
    const an = engine.createAnalyser();
    expect(an.fftSize).toBe(1024);
    expect(an.smoothingTimeConstant).toBe(0.3);
    expect(engine.createAnalyser({ fftSize: 512 }).fftSize).toBe(512);
  });

  it('connectToMaster 取代 node.connect(AudioEngine.master)', () => {
    const { engine } = engineWith();
    const node = { connect: vi.fn() };
    expect(engine.connectToMaster(node)).toBe(node);
    expect(node.connect).toHaveBeenCalledWith(engine.master);
  });

  it('isReady 取代 if(!AudioEngine.context)', () => {
    const notReady = createAudioEngineForTest({ createContext: () => fakeContext() });
    expect(notReady.isReady).toBe(false);
    notReady.ensureCtx();
    expect(notReady.isReady).toBe(true);
  });

  it('setMasterGain 取代直接寫 master.gain.value，且夾在 0 以上', () => {
    const { engine } = engineWith();
    engine.setMasterGain(0);
    expect(engine.master.gain.value).toBe(0);
    engine.setMasterGain(-5);
    expect(engine.master.gain.value).toBe(0);
    engine.setMasterGain(1);
    expect(engine.master.gain.value).toBe(1);
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
    const { engine } = engineWith();
    const buf = engine.readTimeDomain();
    expect(buf).toBeInstanceOf(Float32Array);
    expect(engine.analyser.getFloatTimeDomainData).toHaveBeenCalledWith(buf);
  });
});

describe('未 bind 時 transport 是安全的 no-op', () => {
  it('沒接上 Media 也不可以丟例外', () => {
    const engine = createAudioEngineForTest({ createContext: () => fakeContext() });
    engine.ensureCtx();
    expect(() => engine.startBuffers(0)).not.toThrow();
    expect(() => engine.startElements(0, 0)).not.toThrow();
    expect(() => engine.stopBuffers()).not.toThrow();
    expect(() => engine.stopElements()).not.toThrow();
    expect(() => engine.scrub(1)).not.toThrow();
  });
});

describe('startBuffers：序列模式的時間域換算（§0.5）', () => {
  it('非序列模式直接用 offset', () => {
    const tr = bufferTrack();
    const { engine, ctx } = engineWith({ tracks: [tr] });
    const res = engine.startBuffers(42);
    expect(res.startMediaTime).toBe(42);
    expect(res.startCtxTime).toBe(ctx.currentTime);
    expect(ctx._created[0].start).toHaveBeenCalledWith(0, 42);
  });

  it('序列模式改用 sourceTimeFor(timelineTime) 的來源時間', () => {
    const sourceTimeFor = vi.fn(() => 7);
    const { engine, ctx } = engineWith({
      tracks: [bufferTrack()], seqOn: true, timelineTime: 99, sourceTimeFor,
    });
    const res = engine.startBuffers(42);
    expect(sourceTimeFor).toHaveBeenCalledWith('video', 99);
    expect(res.startMediaTime).toBe(7);
    expect(ctx._created[0].start).toHaveBeenCalledWith(0, 7);
  });

  it('sourceTimeFor 回 null（播放頭不在此來源上）時保留原 offset', () => {
    const { engine } = engineWith({
      tracks: [bufferTrack()], seqOn: true, timelineTime: 99, sourceTimeFor: () => null,
    });
    expect(engine.startBuffers(42).startMediaTime).toBe(42);
  });

  it('offset 會被夾在 [0, buffer.duration]', () => {
    const { engine, ctx } = engineWith({ tracks: [bufferTrack({ buffer: { duration: 5 } })] });
    engine.startBuffers(999);
    expect(ctx._created[0].start).toHaveBeenCalledWith(0, 5);
  });

  it('_srcHidden 的聲道不發聲', () => {
    const { engine, ctx } = engineWith({ tracks: [bufferTrack({ _srcHidden: true })] });
    engine.startBuffers(0);
    expect(ctx._created.length).toBe(0);
  });

  it('沒有 AudioContext 時回 null，不可以丟例外', () => {
    const { engine } = engineWith({ tracks: [bufferTrack()] }, { ready: false });
    expect(engine.startBuffers(0)).toBe(null);
  });
});

describe('stopBuffers', () => {
  it('停止並斷開，且把 srcNode 清乾淨（不清會重複 stop 丟例外）', () => {
    const tr = bufferTrack();
    const { engine, ctx } = engineWith({ tracks: [tr] });
    engine.startBuffers(0);
    const node = ctx._created[0];
    engine.stopBuffers();
    expect(node.stop).toHaveBeenCalled();
    expect(node.disconnect).toHaveBeenCalled();
    expect(tr.srcNode).toBe(null);
  });
});

describe('syncBuffers', () => {
  it('以 AudioContext 時鐘偵測 drift，並從目前來源時間重啟 buffer', () => {
    const tr = bufferTrack();
    const { engine, ctx } = engineWith({ tracks: [tr], playbackRate: 1 });
    engine.startBuffers(2);
    const firstNode = ctx._created[0];
    ctx.currentTime = 11;

    expect(engine.syncBuffers(50)).toBe(true);
    expect(firstNode.stop).toHaveBeenCalled();
    expect(firstNode.disconnect).toHaveBeenCalled();
    expect(ctx._created).toHaveLength(2);
    expect(ctx._created[1].start).toHaveBeenCalledWith(0, 50);
  });

  it('序列 gap 內不會為了校正已停住的影片時鐘而重啟 buffer', () => {
    const tr = bufferTrack();
    const { engine, ctx } = engineWith({ tracks: [tr] });
    engine.startBuffers(2);
    ctx.currentTime = 20;

    expect(engine.syncBuffers(50, { inGap: true })).toBe(false);
    expect(ctx._created).toHaveLength(1);
    expect(ctx._created[0].stop).not.toHaveBeenCalled();
  });
});

describe('startElements：來源類型決定用哪個時間域（§0.5）', () => {
  it('非序列模式用 localT（來源時間）', () => {
    const tr = elementTrack();
    const { engine } = engineWith({ tracks: [tr] });
    engine.startElements(12, 99);
    expect(tr.el.currentTime).toBe(12);
    expect(tr.el.play).toHaveBeenCalled();
  });

  it('ext-* 來源用 externalSourceTimeFor(tlT)——它吃的是時間軸時間', () => {
    const tr = elementTrack({ source: 'ext-3' });
    const externalSourceTimeFor = vi.fn(() => 5);
    const { engine } = engineWith({ tracks: [tr], externalSourceTimeFor });
    engine.startElements(12, 99);
    expect(externalSourceTimeFor).toHaveBeenCalledWith('ext-3', 99);
    expect(tr.el.currentTime).toBe(5);
  });

  it('ext-* 落在素材範圍外（回 null）時暫停，不可以亂放', () => {
    const tr = elementTrack({ source: 'ext-3' });
    const { engine } = engineWith({ tracks: [tr], externalSourceTimeFor: () => null });
    engine.startElements(12, 99);
    expect(tr.el.pause).toHaveBeenCalled();
    expect(tr.el.play).not.toHaveBeenCalled();
  });

  it('序列模式用 sourceTimeFor；回 null 時暫停', () => {
    const play = elementTrack();
    const e1 = engineWith({ tracks: [play], seqOn: true, sourceTimeFor: () => 3 });
    e1.engine.startElements(12, 99);
    expect(play.el.currentTime).toBe(3);

    const skip = elementTrack();
    const e2 = engineWith({ tracks: [skip], seqOn: true, sourceTimeFor: () => null });
    e2.engine.startElements(12, 99);
    expect(skip.el.pause).toHaveBeenCalled();
    expect(skip.el.play).not.toHaveBeenCalled();
  });

  /* tlT 不給時要由 env.timelineTime() 補（序列模式）或退回 localT。
     這正是「時間域轉換收在邊界」的形狀（§0.5）。 */
  it('不給 tlT 時：序列模式取 timelineTime，非序列退回 localT', () => {
    const seqTr = elementTrack({ source: 'ext-1' });
    const extFor = vi.fn(() => 4);
    const e1 = engineWith({ tracks: [seqTr], seqOn: true, timelineTime: 77, externalSourceTimeFor: extFor });
    e1.engine.startElements(12);
    expect(extFor).toHaveBeenCalledWith('ext-1', 77);

    const flatTr = elementTrack({ source: 'ext-1' });
    const extFor2 = vi.fn(() => 4);
    const e2 = engineWith({ tracks: [flatTr], seqOn: false, externalSourceTimeFor: extFor2 });
    e2.engine.startElements(12);
    expect(extFor2).toHaveBeenCalledWith('ext-1', 12);
  });

  it('_srcHidden 的聲道直接暫停', () => {
    const tr = elementTrack({ _srcHidden: true });
    const { engine } = engineWith({ tracks: [tr] });
    engine.startElements(12, 12);
    expect(tr.el.pause).toHaveBeenCalled();
    expect(tr.el.play).not.toHaveBeenCalled();
  });

  it('preservesPitch 只在 0.25–4 倍速間開啟（超出範圍瀏覽器會爆音）', () => {
    const inRange = elementTrack();
    inRange.el.preservesPitch = false;
    engineWith({ tracks: [inRange], playbackRate: 2 }).engine.startElements(0, 0);
    expect(inRange.el.preservesPitch).toBe(true);

    const outOfRange = elementTrack();
    outOfRange.el.preservesPitch = true;
    engineWith({ tracks: [outOfRange], playbackRate: 8 }).engine.startElements(0, 0);
    expect(outOfRange.el.preservesPitch).toBe(false);
  });
});

describe('scrub：可聽性只有一份判準', () => {
  it('播放中或靜音時什麼都不做', () => {
    const a = engineWith({ tracks: [bufferTrack()], playing: true });
    expect(a.engine.scrub(1)).toBeUndefined();
    expect(a.ctx._created.length).toBe(0);

    const b = engineWith({ tracks: [bufferTrack()], muted: true });
    expect(b.engine.scrub(1)).toBeUndefined();
    expect(b.ctx._created.length).toBe(0);
  });

  /* 這一條是重點：此檔曾有兩處 anySolo，一處排除 _srcHidden、一處沒有。
     被藏起來的聲道若把 Solo 帶進判斷，可見的未靜音聲道就會整組被判為不可聽。 */
  it('預覽語意：被 _srcHidden 藏起來的聲道不把 Solo 帶進判斷', () => {
    const hidden = bufferTrack({ solo: true, _srcHidden: true });
    const visible = bufferTrack({ muted: false });
    const { engine, ctx } = engineWith({ tracks: [hidden, visible] });
    engine.scrub(1, 0.15);
    expect(ctx._created.length, '可見且未靜音的聲道應該要出聲').toBe(1);
  });

  it('有可見的 Solo 時，未 Solo 的聲道不出聲', () => {
    const { engine, ctx } = engineWith({
      tracks: [bufferTrack({ solo: true }), bufferTrack({ solo: false })],
    });
    engine.scrub(1, 0.15);
    expect(ctx._created.length).toBe(1);
  });

  it('沒有 Solo 時，靜音的不出聲、未靜音的出聲', () => {
    const { engine, ctx } = engineWith({
      tracks: [bufferTrack({ muted: true }), bufferTrack({ muted: false })],
    });
    engine.scrub(1, 0.15);
    expect(ctx._created.length).toBe(1);
  });

  it('全部不可聽且 activeSource 是主影片時，回報要改 scrub 主 <video>', () => {
    const { engine } = engineWith({ tracks: [bufferTrack({ muted: true })], activeSource: 'video' });
    expect(engine.scrub(1, 0.15)).toEqual({ scrubMainVideo: true, localT: 1 });
  });

  it('有可聽的軌時不要求主影片接手', () => {
    const { engine } = engineWith({ tracks: [bufferTrack()], activeSource: 'video' });
    expect(engine.scrub(1, 0.15).scrubMainVideo).toBe(false);
  });
});
