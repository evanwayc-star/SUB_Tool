// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createAudioEngineForTest } from '../src/audio-engine.js';

function pcm(channels, rate = 2) {
  const data = channels.map(values => Float32Array.from(values));
  return { sampleRate: rate, numberOfChannels: data.length, length: data[0].length,
    duration: data[0].length / rate, getChannelData: channel => data[channel] };
}
function setup(kind = 'element') {
  const sources = [], splitters = [], buffers = [], elements = [], blobs = [];
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const context = { currentTime: 10, state: 'running', destination: {},
    createGain: () => ({ ...node(), gain: { value: 1 } }),
    createAnalyser: () => ({ ...node(), fftSize: 2048 }),
    createBuffer: (channels, count, rate) => pcm(Array.from({ length: channels }, () => Array(count).fill(0)), rate),
    createMediaElementSource: vi.fn(el => { const source = { ...node(), el }; sources.push(source); return source; }),
    createChannelSplitter: vi.fn(channels => { const splitter = { ...node(), channels }; splitters.push(splitter); return splitter; }),
    createBufferSource: () => { const source = { ...node(), playbackRate: { value: 1 }, start: vi.fn(), stop: vi.fn() }; buffers.push(source); return source; },
  };
  const makeElement = () => {
    const el = new EventTarget(); Object.assign(el, { src: '', currentTime: 0, duration: 3,
      readyState: 1, playbackRate: 1, preservesPitch: false, paused: true, tagName: 'AUDIO', load: vi.fn() });
    el.play = vi.fn(async () => { el.paused = false; }); el.pause = vi.fn(() => { el.paused = true; });
    return el;
  };
  const revokeURL = vi.fn();
  const engine = createAudioEngineForTest({ createContext: () => context, reverseOptions: {
    createAudio: () => { const el = makeElement(); elements.push(el); return el; },
    createURL: blob => { blobs.push(blob); return `blob:reverse-${blobs.length}`; }, revokeURL,
  } });
  const clip = { id: 'reverse', reverse: true, in: 1, out: 4, offset: 20, speed: 2 };
  const track = { kind, source: 'video', gain: context.createGain(), analyser: context.createAnalyser(),
    muted: false, solo: false, volume: 1, _srcHidden: false,
    ...(kind === 'buffer' ? { buffer: pcm([[.1, .2, .3, .4, .5, .6, .7, .8], [-.1, -.2, -.3, -.4, -.5, -.6, -.7, -.8]]) } : { el: makeElement() }),
  };
  const state = { tracks: [track], timeline: 20.5, playback: { clip, reverse: true, sourceTime: 3, offset: 1, rate: 2 }, transportMuted: false };
  engine.bind({ tracks: () => state.tracks, timelineTime: () => state.timeline, sourcePlaybackFor: () => state.playback,
    sourceTimeFor: () => state.playback?.sourceTime ?? null, transportMuted: () => state.transportMuted,
    playbackRate: () => 1, muted: () => false });
  engine.ensureCtx();
  const spec = (over = {}) => ({ key: 'reverse-1-4', clip, start: 1, end: 4,
    load: vi.fn(async () => ({ url: 'file:///reverse.wav', channel: 1 })), ...over });
  return { engine, context, track, state, clip, spec, sources, splitters, buffers, elements, blobs, revokeURL };
}
function readBlob(blob) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error); reader.readAsArrayBuffer(blob); });
}

describe('反向預覽沿用音訊傳輸的公開接縫', () => {
  it('裁切的雙聲道 buffer 反向 PCM 正確，倍率與原 buffer 不變', async () => {
    const { engine, track, spec, buffers } = setup('buffer');
    const original = [...track.buffer.getChannelData(0)];
    expect(await engine.prepareReverseTrack(track, spec())).toBe(true);
    engine.startBuffers(3);
    expect([...buffers[0].buffer.getChannelData(0)]).toEqual([.8, .7, .6, .5, .4, .3].map(Math.fround));
    expect([...buffers[0].buffer.getChannelData(1)]).toEqual([-.8, -.7, -.6, -.5, -.4, -.3].map(Math.fround));
    expect(buffers[0].start).toHaveBeenCalledWith(0, 1);
    expect(buffers[0].playbackRate.value).toBe(2);
    expect(buffers[0].connect).toHaveBeenCalledWith(track.gain);
    expect([...track.buffer.getChannelData(0)]).toEqual(original);
  });

  it('反向 buffer 的來源時鐘向後走，不會每幀誤重啟；seek 和倍率更新會重啟', async () => {
    const { engine, context, track, state, spec, buffers } = setup('buffer');
    await engine.prepareReverseTrack(track, spec()); engine.startBuffers(3);
    context.currentTime = 10.4; state.playback.sourceTime = 2.2; state.playback.offset = 1.8;
    expect(engine.syncBuffers(2.2)).toBe(false); expect(buffers).toHaveLength(1);
    state.playback.sourceTime = 3.7; state.playback.offset = .3;
    expect(engine.syncBuffers(3.7)).toBe(true); expect(buffers[0].stop).toHaveBeenCalled();
    expect(buffers[1].start).toHaveBeenCalledWith(0, .3);
    state.playback.rate = .5; expect(engine.syncBuffers(3.7)).toBe(true);
    expect(buffers[2].playbackRate.value).toBe(.5);
  });

  it.each(['element', 'native'])('%s 使用獨立反向元素、原 gain/analyser、指定聲道與保留音高', async kind => {
    const { engine, track, spec, elements, splitters, state } = setup(kind);
    expect(await engine.prepareReverseTrack(track, spec())).toBe(true);
    expect(splitters[0].channels).toBe(2);
    expect(splitters[0].connect).toHaveBeenCalledWith(track.gain, 1);
    expect(splitters[0].connect).toHaveBeenCalledWith(track.analyser, 1);
    engine.startElements(3, 20.5);
    expect(track.el.play).not.toHaveBeenCalled(); expect(track.el.pause).toHaveBeenCalled();
    expect(elements[0].play).toHaveBeenCalledTimes(1); expect(elements[0].currentTime).toBe(1);
    expect(elements[0].playbackRate).toBe(2); expect(elements[0].preservesPitch).toBe(true);
    state.playback.offset = 2.4; state.playback.rate = .5;
    engine.syncReverseSources(21.2);
    expect(elements[0].currentTime).toBe(2.4); expect(elements[0].playbackRate).toBe(.5);
    engine.stopElements(); expect(elements[0].paused).toBe(true);
  });

  it('瀏覽器解碼的右聲道會裁切倒轉成 mono WAV，來源提早結束補靜音', async () => {
    const { engine, track, spec, blobs, splitters, elements } = setup('native');
    const buffer = pcm([[.1, .2, .3, .4, .5, .6], [.6, .5, .4, .3, .2, .1]]);
    await engine.prepareReverseTrack(track, spec({ load: async () => ({ buffer, channel: 1 }) }));
    const wav = new DataView(await readBlob(blobs[0]));
    expect(wav.getUint16(22, true)).toBe(1); expect(wav.getUint32(24, true)).toBe(2);
    expect(Array.from({ length: 6 }, (_, i) => wav.getInt16(44 + i * 2, true))).toEqual([0, 0, 3277, 6553, 9830, 13107]);
    expect(splitters[0].channels).toBe(1); expect(splitters[0].connect).toHaveBeenCalledWith(track.gain, 0);
    expect(elements[0].src).toBe('blob:reverse-1');
  });

  it('ready 後 J/K/L 倒帶仍靜音，回到正播與離開片段會停止反向聲音', async () => {
    const { engine, track, state, spec, elements } = setup();
    await engine.prepareReverseTrack(track, spec()); engine.startElements(3, 20.5);
    state.transportMuted = true; engine.startElements(3, 20.5);
    expect(elements[0].paused).toBe(true); expect(elements[0].play).toHaveBeenCalledTimes(1);
    expect(engine.scrub(1)).toBeUndefined();
    state.transportMuted = false; state.playback.reverse = false;
    engine.startElements(3, 20.5); expect(track.el.play).toHaveBeenCalledTimes(1);
    expect(elements[0].paused).toBe(true);
    state.playback.reverse = true; engine.startElements(3, 20.5);
    state.playback = null; engine.syncReverseSources(25);
    expect(elements[0].paused).toBe(true);
  });

  it('倒帶 shuttle 不會啟動已準備的反向 buffer', async () => {
    const { engine, track, state, spec, buffers } = setup('buffer');
    await engine.prepareReverseTrack(track, spec()); state.transportMuted = true;
    expect(engine.startBuffers(3)).toBeNull(); expect(buffers).toHaveLength(0);
  });

  it('相同所有權共用準備，失敗可重試，並保留原聲道 gain 的身份', async () => {
    const { engine, track, spec, sources } = setup();
    const gain = track.gain; const failing = spec({ load: vi.fn(async () => { throw new Error('cache failed'); }) });
    await expect(engine.prepareReverseTrack(track, failing)).rejects.toThrow('cache failed');
    const good = spec(); const one = engine.prepareReverseTrack(track, good), two = engine.prepareReverseTrack(track, good);
    expect(one).toBe(two); expect(await one).toBe(true); expect(good.load).toHaveBeenCalledTimes(1);
    expect(await engine.prepareReverseTrack(track, good)).toBe(true); expect(sources).toHaveLength(1); expect(track.gain).toBe(gain);
  });

  it.each(['owner', 'reset', 'sameIdReplacement'])('延後來源回覆失去 %s 不會建立或播放音源', async reason => {
    const { engine, track, spec, sources, elements, state, clip } = setup();
    let resolveLoad; let owns = true;
    const pending = engine.prepareReverseTrack(track, spec({ owns: () => owns,
      load: () => new Promise(resolve => { resolveLoad = resolve; }) }));
    if (reason === 'owner') owns = false;
    else if (reason === 'reset') engine.clearReverseSources();
    else { state.playback.clip = { ...clip }; owns = false; }
    resolveLoad({ url: 'file:///late.wav' }); expect(await pending).toBe(false);
    engine.startElements(3, 20.5); expect(sources).toHaveLength(0); expect(elements).toHaveLength(0);
    expect(track.el.play).not.toHaveBeenCalled();
  });

  it('移除聲道或效果替換時立即斷開反向音源，回收瀏覽器 URL', async () => {
    const { engine, track, state, spec, elements, sources, splitters, revokeURL } = setup('native');
    await engine.prepareReverseTrack(track, spec({ load: async () => ({ buffer: pcm([[.1, .2, .3, .4, .5, .6, .7, .8]]) }) }));
    engine.startElements(3, 20.5); state.tracks = [{ ...track, gain: { gain: { value: 1 } } }];
    engine.pruneReverseSources();
    expect(elements[0].paused).toBe(true); expect(elements[0].src).toBe('');
    expect(sources[0].disconnect).toHaveBeenCalled(); expect(splitters[0].disconnect).toHaveBeenCalled();
    expect(revokeURL).toHaveBeenCalledWith('blob:reverse-1');
  });

  it('反向原生聲道的 scrub 經正確 splitter channel，不回播主影片', async () => {
    const { engine, track, spec, elements } = setup('native');
    await engine.prepareReverseTrack(track, spec());
    const scrub = vi.spyOn(engine, 'scrubElement').mockImplementation(() => {});
    expect(engine.scrub(20.5)).toEqual({ scrubMainVideo: false, localT: 20.5 });
    expect(scrub).toHaveBeenCalledWith(elements[0], 1, expect.objectContaining({ rate: 2, channels: 2,
      routes: [{ gain: track.gain, channel: 1 }], preservesPitch: true }));
  });
});
