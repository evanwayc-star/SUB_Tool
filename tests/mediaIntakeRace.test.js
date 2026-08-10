// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const domMock = vi.hoisted(() => {
  const video = {
    style: {},
    src: '',
    readyState: 1,
    duration: 12,
    videoWidth: 1920,
    videoHeight: 1080,
    playbackRate: 1,
    currentTime: 0,
    muted: false,
    hasAttribute: () => false,
    pause: vi.fn(),
  };
  const elements = new Map();
  return {
    video,
    $(id) {
      if (!elements.has(id)) {
        elements.set(id, {
          style: {}, textContent: '', innerHTML: '', value: '',
          classList: { add: vi.fn(), remove: vi.fn() },
          querySelectorAll: () => [],
          getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }),
        });
      }
      return elements.get(id);
    },
  };
});

const deskMock = vi.hoisted(() => ({
  stat: vi.fn(async () => ({ exists: true, size: 1024 })),
  probe: vi.fn(async () => ({
    duration: 12,
    video: { codec: 'h264', fps: 25, width: 1920, height: 1080 },
    audio: [{ channels: 6, channelLayout: '5.1' }],
  })),
  ingest: vi.fn(),
  fileURL: vi.fn(async path => `file:///${String(path).replaceAll('\\', '/')}`),
  waveAudio: vi.fn(),
  cleanupAudio: vi.fn(),
}));

vi.mock('../src/dom.js', () => domMock);
vi.mock('../src/events.js', () => ({ emit: vi.fn(), on: vi.fn() }));
vi.mock('../src/ui.js', () => ({
  setStatus: vi.fn(), showToast: vi.fn(), openModal: vi.fn(), closeModal: vi.fn(),
}));
vi.mock('../src/mixer.js', () => ({ renderAudioTracks: vi.fn(), clearMeterStrips: vi.fn() }));
vi.mock('../src/timeline.js', () => ({ drawTimeline: vi.fn(), updatePlayhead: vi.fn() }));

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

let Media;
let Wave;
let State;
let resetAudioProject;
let resetPlayerAdapter;
let pending;

describe('desktop mother-source intake ownership', () => {
  beforeAll(async () => {
    Object.defineProperty(window, 'subtool', {
      configurable: true,
      value: { isDesktop: true, ...deskMock },
    });
    window.AudioContext = class {
      constructor(){ this.state = 'running'; this.destination = {}; this.currentTime = 0; }
      createGain(){ return { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } }; }
      createAnalyser(){ return { connect: vi.fn(), fftSize: 0 }; }
      createMediaElementSource(){ return { channelCount: 2, connect: vi.fn(), disconnect: vi.fn() }; }
      createChannelSplitter(){ return { connect: vi.fn(), disconnect: vi.fn() }; }
      createChannelMerger(){ return { connect: vi.fn(), disconnect: vi.fn() }; }
      resume(){}
    };
    ({ Media, Wave } = await import('../src/media.js'));
    ({ State, resetAudioProject } = await import('../src/state.js'));
    ({ resetPlayerAdapter } = await import('../src/media-player-adapter.js'));
  });

  beforeEach(() => {
    pending = new Map();
    deskMock.stat.mockClear();
    deskMock.probe.mockClear();
    deskMock.fileURL.mockClear();
    deskMock.ingest.mockReset();
    deskMock.waveAudio.mockReset();
    deskMock.cleanupAudio.mockReset();
    deskMock.ingest.mockImplementation(({ path }) => {
      const work = deferred();
      pending.set(path, work);
      return work.promise;
    });
    Media.reset();
    Media.ctx = null;
    Media.master = null;
    Media.tracks = [];
    State.cues = [];
    State.clips = [];
    State.mediaPath = null;
    resetAudioProject();
    domMock.video.src = '';
    domMock.video.readyState = 1;
    domMock.video.duration = 12;
  });

  it('discarding A after B starts prevents late ingest results from replacing B', async () => {
    const loadA = Media.loadDesktopMedia('C:/media/A.mp4');
    await vi.waitFor(() => expect(pending.has('C:/media/A.mp4')).toBe(true));

    const loadB = Media.loadDesktopMedia('C:/media/B.mp4');
    await vi.waitFor(() => expect(pending.has('C:/media/B.mp4')).toBe(true));

    pending.get('C:/media/B.mp4').resolve({ channels: [] });
    await loadB;
    pending.get('C:/media/A.mp4').resolve({ channels: [] });
    await loadA;

    expect(State.mediaPath).toBe('C:/media/B.mp4');
    expect(domMock.video.src).toBe('file:///C:/media/B.mp4');
    expect(State.clips).toHaveLength(1);
    expect(State.clips[0]).toMatchObject({ path: 'C:/media/B.mp4', primary: true });
  });

  it('does not attach stale background channels to the new primary after proxy URL lookup', async () => {
    const proxyURL = deferred();
    deskMock.ingest.mockResolvedValueOnce({
      proxy: 'C:/cache/A-proxy.mp4',
      channels: [{ file: 'C:/cache/A-ch1.m4a', sourceStream: 0, sourceChannel: 0 }],
    });
    deskMock.fileURL.mockImplementation(path => path === 'C:/cache/A-proxy.mp4'
      ? proxyURL.promise
      : Promise.resolve(`file:///${String(path).replaceAll('\\', '/')}`));

    const primaryA = Media._registerPrimary({
      name: 'A.mp4', path: 'C:/media/A.mp4', dur: 12, audioSourceId: 'source-a',
    });
    const stale = Media._bgAudioIngest('C:/media/A.mp4', [{ channels: 1 }], 12, primaryA);
    await vi.waitFor(() => expect(deskMock.fileURL).toHaveBeenCalledWith('C:/cache/A-proxy.mp4'));

    Media.reset();
    resetAudioProject();
    State.mediaName = 'B.mp4';
    Media._registerPrimary({
      name: 'B.mp4', path: 'C:/media/B.mp4', dur: 12, audioSourceId: 'source-b',
    });
    proxyURL.resolve('file:///C:/cache/A-proxy.mp4');
    await stale;

    expect(State.audioProject.sourceMaps['source-b']).toBeUndefined();
    expect(Media.tracks).toEqual([]);
  });

  it('does not commit desktop native waveform data after the last source placement is deleted', async () => {
    const wavePath = deferred();
    deskMock.probe.mockResolvedValueOnce({
      duration: 12,
      video: { codec: 'h264', fps: 25, width: 1920, height: 1080 },
      audio: [{ channels: 2, channelLayout: 'stereo' }],
    });
    deskMock.ingest.mockResolvedValueOnce({ channels: [] });
    deskMock.waveAudio.mockReturnValueOnce(wavePath.promise);

    const loading = Media.loadDesktopMedia('C:/media/A.mp4');
    await vi.waitFor(() => expect(deskMock.waveAudio).toHaveBeenCalledTimes(1));
    const primary = State.clips[0];
    expect(Media.removeClip(primary.id)).toBe(true);
    wavePath.resolve('C:/cache/A-wave.wav');
    await loading;

    expect(Wave._sourceState(primary, false)).toBeNull();
    expect(deskMock.cleanupAudio).toHaveBeenCalledWith('C:/cache/A-wave.wav');
  });

  it('serializes overlapping mpv launches and cleans the stale native runtime before B starts', async () => {
    const launches = new Map();
    const mpv = {
      detect: vi.fn(async () => ({ available: true })),
      launch: vi.fn(({ src }) => {
        const work = deferred();
        launches.set(src, work);
        return work.promise;
      }),
      quit: vi.fn(async () => {}),
      onEvent: vi.fn(),
      setBounds: vi.fn(async () => {}),
    };
    window.subtool.mpv = mpv;
    resetPlayerAdapter(window.subtool);
    deskMock.probe.mockResolvedValue({
      duration: 12,
      video: { codec: 'prores', fps: 25, width: 1920, height: 1080 },
      audio: [],
    });

    try {
      const loadA = Media.loadDesktopMedia('C:/media/A.mov');
      await vi.waitFor(() => expect(launches.has('C:/media/A.mov')).toBe(true));
      const loadB = Media.loadDesktopMedia('C:/media/B.mov');
      await Promise.resolve();
      expect(mpv.launch).toHaveBeenCalledTimes(1);

      // 主程序可能已建立 native window/process，卻在 pipe 連線階段失敗。
      launches.get('C:/media/A.mov').reject(new Error('mpv pipe failed'));
      await vi.waitFor(() => expect(launches.has('C:/media/B.mov')).toBe(true));
      const staleRuntimeWasCleaned = mpv.quit.mock.calls.length === 1;
      launches.get('C:/media/B.mov').resolve({ duration: 12 });
      await Promise.all([loadA, loadB]);

      expect(staleRuntimeWasCleaned).toBe(true);
      expect(State.mediaPath).toBe('C:/media/B.mov');
      expect(State.clips).toHaveLength(1);
      expect(State.clips[0]).toMatchObject({ path: 'C:/media/B.mov', primary: true });
    } finally {
      Media.reset();
      delete window.subtool.mpv;
      resetPlayerAdapter(window.subtool);
    }
  });

  it('ignores late events from an mpv intake after a newer HTML media load owns the timeline', async () => {
    const callbacks = [];
    const mpv = {
      detect: vi.fn(async () => ({ available: true })),
      launch: vi.fn(async () => ({ duration: 12 })),
      quit: vi.fn(async () => {}),
      onEvent: vi.fn(callback => callbacks.push(callback)),
      setBounds: vi.fn(async () => {}),
    };
    window.subtool.mpv = mpv;
    resetPlayerAdapter(window.subtool);
    deskMock.probe
      .mockResolvedValueOnce({
        duration: 12,
        video: { codec: 'prores', fps: 25, width: 1920, height: 1080 },
        audio: [],
      })
      .mockResolvedValueOnce({
        duration: 12,
        video: { codec: 'h264', fps: 25, width: 1920, height: 1080 },
        audio: [{ channels: 6, channelLayout: '5.1' }],
      });
    deskMock.ingest.mockResolvedValue({ channels: [] });

    try {
      await Media.loadDesktopMedia('C:/media/A.mov');
      expect(callbacks).toHaveLength(1);
      await Media.loadDesktopMedia('C:/media/B.mp4');
      const current = State.clips[0];

      callbacks[0]({ event: 'property-change', name: 'duration', data: 99 });

      expect(State.mediaPath).toBe('C:/media/B.mp4');
      expect(current).toMatchObject({ path: 'C:/media/B.mp4', dur: 12, out: 12 });
      expect(State.duration).toBe(12);
    } finally {
      Media.reset();
      delete window.subtool.mpv;
      resetPlayerAdapter(window.subtool);
    }
  });
});
