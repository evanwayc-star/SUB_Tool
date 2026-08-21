// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaAudioRouter } from '../src/media-audio-router.js';

function fakeAudioContext() {
  const created = [];
  return {
    currentTime: 10,
    state: 'running',
    destination: {},
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
    created,
  };
}

afterEach(() => {
  delete window.AudioContext;
});

describe('MediaAudioRouter buffer drift clock', () => {
  it('mpv source clock advances while the inactive HTML video clock is stopped without restarting buffers', () => {
    const context = fakeAudioContext();
    window.AudioContext = function AudioContext() { return context; };
    const track = {
      kind: 'buffer',
      buffer: { duration: 100 },
      gain: { connect: vi.fn() },
      muted: false,
      solo: false,
    };
    let sourceTime = 2;
    const media = {
      tracks: [track],
      playing: true,
      activeSource: 'video',
      activeClipId: null,
      seqOn: () => false,
      inGap: () => false,
      tlTime: () => sourceTime,
      vTime: () => sourceTime,
      sourceLocalTime: () => sourceTime,
      externalAudio: { sourceTime: () => null },
    };
    const video = { currentTime: 0, playbackRate: 1 };
    const router = new MediaAudioRouter(media, video, { muted: false });

    router.ensureCtx();
    router.startBufferSources(sourceTime);
    context.currentTime = 11;
    sourceTime = 3;
    router.syncDrift();
    context.currentTime = 12;
    sourceTime = 4;
    router.syncDrift();

    expect(context.created, 'the stopped HTML video clock must not trigger repeated buffer restarts').toHaveLength(1);
  });

  it('calibrates external element tracks against externalAudio.sourceTime instead of global timeline time', () => {
    const el = {
      paused: false,
      currentTime: 5.0,
      pause: vi.fn(),
    };
    const track = {
      kind: 'element',
      source: 'ext-1',
      el,
      _srcHidden: false,
    };
    let tlTime = 1385; // 23:05 on timeline
    const media = {
      tracks: [track],
      playing: true,
      activeSource: 'video',
      activeClipId: null,
      seqOn: () => true,
      inGap: () => false,
      tlTime: () => tlTime,
      vTime: () => tlTime,
      sourceLocalTime: () => tlTime,
      externalAudio: {
        sourceTime: (src, t) => {
          if (src === 'ext-1' && t >= 1380 && t <= 1440) return t - 1380;
          return null;
        },
      },
    };
    const video = { playbackRate: 1 };
    const router = new MediaAudioRouter(media, video, { muted: false });

    // When currentTime is 5.0 and expected source time is 5.0 (1385 - 1380), no drift adjustment should occur
    router.syncDrift();
    expect(el.currentTime).toBe(5.0);
    expect(el.pause).not.toHaveBeenCalled();

    // When element drifts to 5.5, it should calibrate back to 5.0, NOT 1385
    el.currentTime = 5.5;
    router.syncDrift();
    expect(el.currentTime).toBe(5.0);

    // When timeline time moves outside the clip (e.g. 100s, where sourceTime returns null), element should pause
    tlTime = 100;
    router.syncDrift();
    expect(el.pause).toHaveBeenCalled();
  });
});
