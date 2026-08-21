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
});
