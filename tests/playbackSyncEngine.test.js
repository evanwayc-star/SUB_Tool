// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlaybackSyncEngine } from '../src/media-presentation-core.js';
import {getPlayerAdapter,resetPlayerAdapter} from '../src/media-player-adapter.js';

function createHarness(overrides = {}) {
  const state = {
    playing: true,
    switching: false,
    presenterMoving: true,
    audioOnly: false,
    enabled: true,
    time: 5,
    gap: false,
    activeClip: null,
    activeClipId: null,
    duration: 20,
    videoClips: [],
    overlapKey: '',
    tracks: [],
    ...overrides.state,
  };
  const sequence = {
    audioOnly: () => state.audioOnly,
    enabled: () => state.enabled,
    duration: () => state.duration,
    inGap: () => state.gap,
    activeClip: () => state.activeClip,
    activeClipId: () => state.activeClipId,
    videoClips: () => state.videoClips,
    clipAt: vi.fn(() => null),
    clipsAt: vi.fn(() => []),
    nextAfter: vi.fn(() => null),
    clipEnd: clip => clip.offset + clip.out - clip.in,
    sourceTime: vi.fn((time, clip) => time - clip.offset + clip.in),
    ...overrides.sequence,
  };
  const actions = {
    pause: vi.fn(),
    seek: vi.fn(),
    enterGap: vi.fn(() => { state.gap = true; }),
    ensureClip: vi.fn(),
    applyClipAudio: vi.fn(),
    startElementSources: vi.fn(),
    stopBufferSources: vi.fn(),
    startBufferSources: vi.fn(),
    overlapKey: () => state.overlapKey,
    setOverlapKey: key => { state.overlapKey = key; },
    ...overrides.actions,
  };
  const port = {
    clock: {
      isPlaying: () => state.playing,
      isSwitching: () => state.switching,
      presenterMoving: () => state.presenterMoving,
      timelineTime: () => typeof state.time === 'function' ? state.time() : state.time,
      sourceTime: () => 0,
      playbackRate: () => 1,
    },
    sequence,
    audio: {
      tracks: () => state.tracks,
      externalSourceTime: () => null,
      sourceLocalTime: () => null,
      ...overrides.audio,
    },
    actions,
  };
  return { engine: new PlaybackSyncEngine(port), state, sequence, actions };
}

describe('PlaybackSyncEngine', () => {
  afterEach(()=>resetPlayerAdapter(null));
  it('sequence seeking uses normalized source time through the shared delayed element transport',async()=>{
    const element=new EventTarget();Object.assign(element,{src:'subtool-local://source/origin-five.mov',duration:3.5});
    let current=0;Object.defineProperty(element,'currentTime',{get:()=>current,set:value=>{current=Math.min(value,element.duration);}});
    getPlayerAdapter().registerSourceClock(element.src,{timestampOffset:-.5,presentationTimestampOffset:-5.5});
    const track={kind:'element',source:'video',el:element};
    const harness=createHarness({state:{tracks:[track]},audio:{sourceLocalTime:()=>2.8,
      seekElement:(track,time)=>getPlayerAdapter().seekElement(track.el,time)}});
    harness.engine.syncSequenceElements(2.8);expect(element.currentTime).toBe(3.5);
    element.duration=8.5;element.dispatchEvent(new Event('durationchange'));await Promise.resolve();
    expect(element.currentTime).toBe(8.3);
  });
  it.each(['hide','gap'])('sequence %s cancels its earlier deferred element seek',action=>{
    const track={kind:'element',source:'video',el:{}};
    const seekElement=vi.fn(),cancelElementSeek=vi.fn();let localTime=2.8;
    const harness=createHarness({state:{tracks:[track]},audio:{sourceLocalTime:()=>localTime,seekElement,cancelElementSeek}});
    harness.engine.syncSequenceElements(2.8);
    if(action==='hide')track._srcHidden=true;else localTime=null;
    harness.engine.syncSequenceElements(3);
    expect(seekElement).toHaveBeenCalledExactlyOnceWith(track,2.8);
    expect(cancelElementSeek).toHaveBeenCalledExactlyOnceWith(track);
  });

  it('只由呼叫端 tick，不建立自己的 interval 排程器', () => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    const { engine } = createHarness();

    expect(engine.start).toBeUndefined();
    expect(interval).not.toHaveBeenCalled();
    interval.mockRestore();
  });

  it('沒有 active clip 而進入 gap 時，同一 tick 的外部音訊仍持續播放', () => {
    const events = [];
    const audioElement = {
      paused: true, currentTime: 0, duration: 20, playbackRate: 1, preservesPitch: true,
      play() { events.push('play'); this.paused = false; return Promise.resolve(); },
      pause() { events.push('pause'); this.paused = true; },
    };
    const harness = createHarness({
      state: {
        videoClips: [{ id: 'later', type: 'video', in: 0, out: 5, dur: 5, offset: 10 }],
        tracks: [{ kind: 'element', source: 'ext-1', el: audioElement, _srcHidden: false }],
      },
      sequence: { nextAfter: () => ({ id: 'later' }) },
      audio: { externalSourceTime: () => 2 },
      actions: {
        enterGap: () => { harness.state.gap = true; audioElement.pause(); },
        startElementSources: () => audioElement.play(),
      },
    });

    harness.engine.seqTick();
    harness.engine.seqTick();

    expect(audioElement.paused).toBe(false);
    expect(events).toEqual(['pause', 'play']);
  });

  it('已識別的 gap 播放路徑不會再次停掉外部音訊', () => {
    const audioElement = { paused: false };
    const harness = createHarness({
      state: { gap: true },
      actions: { enterGap: () => { audioElement.paused = true; } },
    });

    harness.engine.seqTick();

    expect(audioElement.paused).toBe(false);
  });

  it('clip 結束後進入後續 gap，下一 tick 會重啟外部音訊', () => {
    const first = { id: 'first', type: 'video', in: 0, out: 2, dur: 2, offset: 0 };
    const later = { id: 'later', type: 'video', in: 0, out: 2, dur: 2, offset: 10 };
    const events = [];
    const audioElement = {
      paused: true, currentTime: 0, duration: 20, playbackRate: 1, preservesPitch: true,
      play() { events.push('play'); this.paused = false; return Promise.resolve(); },
      pause() { events.push('pause'); this.paused = true; },
    };
    const harness = createHarness({
      state: {
        time: () => harness.state.gap ? 2.1 : 1.99,
        activeClip: first,
        activeClipId: first.id,
        overlapKey: first.id,
        duration: 12,
        videoClips: [first, later],
        tracks: [{ kind: 'element', source: 'ext-review', el: audioElement, _srcHidden: false }],
      },
      sequence: {
        clipsAt: () => [first],
        nextAfter: () => later,
      },
      audio: { externalSourceTime: () => 1 },
      actions: {
        enterGap: () => { harness.state.gap = true; audioElement.pause(); },
        startElementSources: () => audioElement.play(),
      },
    });

    harness.engine.seqTick();
    harness.engine.seqTick();

    expect(events).toEqual(['play', 'pause', 'play']);
    expect(audioElement.paused).toBe(false);
  });

  it('呈現切換尚未完成時不以舊 presenter clock 推進', () => {
    const harness = createHarness({ state: { presenterMoving: false } });
    const timelineTime = vi.spyOn(harness.engine.port.clock, 'timelineTime');

    harness.engine.seqTick();

    expect(timelineTime).not.toHaveBeenCalled();
  });

  it('外音活動切換只交給音源owner，不能自行啟動未反轉的母素材元素', () => {
    const original={play:vi.fn(),pause:vi.fn(),currentTime:0};
    const harness=createHarness({state:{audioOnly:true,time:1,tracks:[{kind:'element',source:'ext-reverse',el:original}]},
      audio:{externalSourceTime:(_source,time)=>time<3?6-time*2:null}});
    harness.engine.seqTick();
    harness.state.time=2;harness.engine.seqTick();
    expect(harness.actions.startElementSources).toHaveBeenCalledExactlyOnceWith(0,1);
    expect(original.play).not.toHaveBeenCalled();
    expect(original.currentTime).toBe(0);
    harness.state.time=3;harness.engine.seqTick();
    expect(harness.actions.startElementSources).toHaveBeenLastCalledWith(0,3);
    expect(harness.actions.startElementSources).toHaveBeenCalledTimes(2);
  });
});
