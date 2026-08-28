// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const domMock = vi.hoisted(() => {
  const frameCallbacks = [];
  const video = {
    style: {},
    src: 'file:///program.mov',
    currentSrc: 'file:///program.mov',
    currentTime: 15,
    duration: 30,
    playbackRate: 1,
    muted: false,
    preservesPitch: true,
    pause: vi.fn(),
    play: vi.fn().mockResolvedValue(undefined),
    dispatchEvent: vi.fn(),
    hasAttribute: vi.fn(name => name === 'src'),
    requestVideoFrameCallback: vi.fn(callback => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    }),
    cancelVideoFrameCallback: vi.fn(),
  };
  const elements = new Map();
  return {
    video,
    frameCallbacks,
    $(id) {
      if (!elements.has(id)) {
        elements.set(id, {
          style: {}, textContent: '', value: 0, innerHTML: '',
          classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
          querySelectorAll: () => [],
        });
      }
      return elements.get(id);
    },
  };
});

vi.mock('../src/dom.js', () => domMock);
vi.mock('../src/events.js', () => ({ emit: vi.fn(), on: vi.fn() }));
vi.mock('../src/ui.js', () => ({
  setStatus: vi.fn(), showToast: vi.fn(), openModal: vi.fn(), closeModal: vi.fn(),
}));
vi.mock('../src/mixer.js', () => ({ renderAudioTracks: vi.fn(), clearMeterStrips: vi.fn() }));
vi.mock('../src/timeline.js', () => ({ drawTimeline: vi.fn(), updatePlayhead: vi.fn() }));

let Media;
let State;
let resetPlayerAdapter;

describe('Media presentation runtime', () => {
  beforeAll(async () => {
    window.AudioContext = class {
      constructor() { this.state = 'running'; this.destination = {}; this.currentTime = 0; }
      createGain() { return { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } }; }
      createAnalyser() { return { connect: vi.fn(), fftSize: 0 }; }
      resume() {}
    };
    ({ Media } = await import('../src/media.js'));
    ({ State } = await import('../src/state.js'));
    ({ resetPlayerAdapter } = await import('../src/media-player-adapter.js'));
  });

  beforeEach(() => {
    State.fps = 25;
    State.dropFrame = false;
    State.duration = 130;
    State.videoTracks = [{ name: 'V1', visible: true, locked: false }];
    State.clips = [{
      id: 'clip-a', name: 'program.mov', web: { url: 'file:///program.mov' },
      dur: 30, in: 10, out: 20, offset: 100, vtrack: 0, primary: true,
    }];
    State.externalAudioEnd = 0;
    Media.activeClipId = 'clip-a';
    Media.playing = false;
    Media._gap = false;
    Media._transport.reset();
    Media._lastSeekTime = 105;
    Media._presentationCore = null;
    Media._webCodecsPresentationWaiters?.clear?.();
    Media._wcTakeover = false;
    domMock.video.currentTime = 15;
    domMock.video.muted = false;
    domMock.video.hasAttribute.mockImplementation(name => name === 'src');
    domMock.frameCallbacks.length = 0;
    resetPlayerAdapter(null, domMock.video);
  });

  it('畫格完成前不提交播放頭，完成後才把來源時間映回時間軸', async () => {
    const pending = Media.requestPresentation(104);

    expect(domMock.video.currentTime).toBe(14);
    expect(Media.displayTime()).toBe(105);

    domMock.frameCallbacks.shift()(0, { mediaTime: 13.95 });
    const result = await pending;

    expect(result).toMatchObject({
      status: 'presented', requestedTime: 104, presentedTime: 103.95, source: 'html5',
    });
    expect(Media.displayTime()).toBe(103.96);
  });

  it('影片間隙由 synthetic presenter 立即提交黑畫面位置', async () => {
    const result = await Media.requestPresentation(50);

    expect(result).toMatchObject({
      status: 'presented', requestedTime: 50, presentedTime: 50, source: 'synthetic',
    });
    expect(Media.displayTime()).toBe(50);
  });

  it('WebCodecs 接管時會等所有合成層的實際 PTS，再提交播放頭', async () => {
    Media._wcTakeover = true;
    const pending = Media.requestPresentation(104);
    domMock.frameCallbacks.shift()(0, { mediaTime: 14 });

    let settled = false;
    pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(Media.displayTime()).toBe(105);

    Media.reportWebCodecsPresentation([104.01, 103.95]);
    await expect(pending).resolves.toMatchObject({
      status: 'presented', requestedTime: 104, presentedTime: 103.95, source: 'webcodecs',
    });
    expect(Media.displayTime()).toBe(103.96);
  });
});
