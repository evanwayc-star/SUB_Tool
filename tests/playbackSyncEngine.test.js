// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/dom.js', () => ({ video: { playbackRate: 1 } }));

import { PlaybackSyncEngine } from '../src/playback-sync-engine.js';
import { State } from '../src/state.js';

describe('PlaybackSyncEngine fallback gap', () => {
  beforeEach(() => {
    State.clips = [{
      id: 'later-video', type: 'video', in: 0, out: 5, dur: 5, offset: 10, vtrack: 0,
    }];
    State.duration = 20;
    State.videoTracks = [{ name: '視訊軌 1', visible: true, locked: false }];
  });

  it('沒有 active clip 而進入 gap 時，同一 tick 的外部音訊仍持續播放', () => {
    const events = [];
    const audio = {
      paused: true,
      currentTime: 0,
      duration: 20,
      playbackRate: 1,
      preservesPitch: true,
      play() { events.push('play'); this.paused = false; return Promise.resolve(); },
      pause() { events.push('pause'); this.paused = true; },
    };
    const media = {
      playing: true,
      _seqSwitching: false,
      _gap: false,
      activeClipId: null,
      tracks: [{ kind: 'element', source: 'ext-1', el: audio, _srcHidden: false }],
      externalAudio: { sourceTime: () => 2 },
      audioOnlyTimeline: () => false,
      seqOn: () => true,
      tlTime: () => 5,
      _activeClip: () => null,
      _enterGap() {
        this._gap = true;
        audio.pause();
      },
      pause: vi.fn(),
      _transport: { sourceTime: vi.fn() },
    };

    const engine = new PlaybackSyncEngine(media);
    engine.seqTick();
    engine.seqTick();

    expect(audio.paused).toBe(false);
    expect(events).toEqual(['pause', 'play']);
  });

  it('已識別的 gap 播放路徑不會再次停掉外部音訊', () => {
    const audio = { paused: false };
    const media = {
      playing: true,
      _seqSwitching: false,
      _gap: true,
      activeClipId: null,
      tracks: [],
      externalAudio: { sourceTime: () => null },
      audioOnlyTimeline: () => false,
      seqOn: () => true,
      tlTime: () => 5,
      _enterGap() { audio.paused = true; },
      pause: vi.fn(),
    };

    new PlaybackSyncEngine(media).seqTick();

    expect(audio.paused).toBe(false);
  });

  it('clip 結束後進入後續 clip 前的 gap，下一 tick 會重啟外部音訊', () => {
    const first = {
      id: 'first-video', type: 'video', in: 0, out: 2, dur: 2, offset: 0, vtrack: 0,
    };
    const later = {
      id: 'later-video', type: 'video', in: 0, out: 2, dur: 2, offset: 10, vtrack: 0,
    };
    State.clips = [first, later];
    State.duration = 12;
    const events = [];
    const audio = {
      paused: true,
      currentTime: 0,
      duration: 20,
      playbackRate: 1,
      preservesPitch: true,
      play() { events.push('play'); this.paused = false; return Promise.resolve(); },
      pause() { events.push('pause'); this.paused = true; },
    };
    const media = {
      playing: true,
      _seqSwitching: false,
      _gap: false,
      activeClipId: first.id,
      _lastOverlapKey: first.id,
      tracks: [{ kind: 'element', source: 'ext-review', el: audio, _srcHidden: false }],
      externalAudio: { sourceTime: () => 1 },
      audioOnlyTimeline: () => false,
      seqOn: () => true,
      tlTime() { return this._gap ? 2.1 : 1.99; },
      _activeClip: () => first,
      _enterGap() {
        this._gap = true;
        audio.pause();
      },
      pause: vi.fn(),
      seek: vi.fn(),
    };

    const engine = new PlaybackSyncEngine(media);
    engine.seqTick();
    engine.seqTick();

    expect(events).toEqual(['play', 'pause', 'play']);
    expect(audio.paused).toBe(false);
  });

  it('呈現切換尚未完成時不以舊 presenter clock 推進片段或 gap', () => {
    const media = {
      playing: true,
      presenterClockMoving: () => false,
      _seqSwitching: false,
      _gap: false,
      tracks: [],
      externalAudio: { sourceTime: () => null },
      audioOnlyTimeline: () => false,
      seqOn: () => true,
      tlTime: vi.fn(() => 12),
    };

    new PlaybackSyncEngine(media).seqTick();

    expect(media.tlTime).not.toHaveBeenCalled();
  });
});
