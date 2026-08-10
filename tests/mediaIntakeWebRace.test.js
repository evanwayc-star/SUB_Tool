// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const domMock = vi.hoisted(() => {
  const video = {
    style: {}, src: '', readyState: 1, duration: 12, videoWidth: 1920, videoHeight: 1080,
    playbackRate: 1, currentTime: 0, muted: false, hasAttribute: () => false, pause: vi.fn(),
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

vi.mock('../src/dom.js', () => domMock);
vi.mock('../src/events.js', () => ({ emit: vi.fn(), on: vi.fn() }));
vi.mock('../src/ui.js', () => ({
  setStatus: vi.fn(), showToast: vi.fn(), openModal: vi.fn(), closeModal: vi.fn(),
}));
vi.mock('../src/mixer.js', () => ({ renderAudioTracks: vi.fn(), clearMeterStrips: vi.fn() }));
vi.mock('../src/timeline.js', () => ({ drawTimeline: vi.fn(), updatePlayhead: vi.fn() }));

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

let Media;
let State;
let resetAudioProject;
let probeAndMaybeExtract;
let detectFpsWeb;
let ui;

describe('web mother-source intake ownership', () => {
  beforeAll(async () => {
    delete window.subtool;
    window.AudioContext = class {
      constructor(){ this.state = 'running'; this.destination = {}; this.currentTime = 0; }
      createGain(){ return { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } }; }
      createAnalyser(){ return { connect: vi.fn(), fftSize: 0 }; }
      resume(){}
    };
    ({ Media, detectFpsWeb } = await import('../src/media.js'));
    ({ State, resetAudioProject } = await import('../src/state.js'));
    ui = await import('../src/ui.js');
  });

  beforeEach(() => {
    Media.reset();
    Media.ctx = null;
    Media.master = null;
    Media.tracks = [];
    State.cues = [];
    State.clips = [];
    State.mediaPath = null;
    resetAudioProject();
    ui.setStatus.mockClear();
    ui.showToast.mockClear();
    domMock.video.src = '';
    domMock.video.readyState = 1;
    domMock.video.duration = 12;
    probeAndMaybeExtract = vi.spyOn(Media, 'probeAndMaybeExtract').mockResolvedValue();
    vi.spyOn(Media, '_connectStereo').mockReturnValue([]);
  });

  it('late native capability detection for A cannot replace B', async () => {
    const probes = new Map();
    let urlSequence = 0;
    const originalCreateElement = document.createElement.bind(document);
    const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: file => `blob:${file.name}:${++urlSequence}`,
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    vi.spyOn(document, 'createElement').mockImplementation(tag => {
      if (tag !== 'video') return originalCreateElement(tag);
      const probe = { readyState: 0, onloadedmetadata: null, onerror: null };
      Object.defineProperty(probe, 'src', {
        set(value) { probes.set(value, probe); },
      });
      return probe;
    });

    try {
      const a = { name: 'A.mp4', size: 2_000_000_000 };
      const b = { name: 'B.mp4', size: 2_000_000_000 };
      const loadA = Media.loadVideoFile(a);
      await vi.waitFor(() => expect([...probes.keys()]).toContain('blob:A.mp4:2'));

      const loadB = Media.loadVideoFile(b);
      await vi.waitFor(() => expect([...probes.keys()]).toContain('blob:B.mp4:4'));

      probes.get('blob:B.mp4:4').onloadedmetadata();
      await loadB;
      probes.get('blob:A.mp4:2').onloadedmetadata();
      await loadA;

      expect(State.mediaName).toBe('B.mp4');
      expect(State.clips).toHaveLength(1);
      expect(State.clips[0]).toMatchObject({ name: 'B.mp4', primary: true });
      expect(domMock.video.src).toBe('blob:B.mp4:3');
      expect(probeAndMaybeExtract).toHaveBeenCalledTimes(1);
      expect(probeAndMaybeExtract).toHaveBeenCalledWith(b, expect.objectContaining({ owns: expect.any(Function) }));
    } finally {
      vi.restoreAllMocks();
      if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL);
      else delete URL.createObjectURL;
      if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL);
      else delete URL.revokeObjectURL;
    }
  });

  it('drops an already-scheduled FPS callback after its intake loses ownership', () => {
    const callbacks = [];
    const originalPrototype = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'requestVideoFrameCallback');
    const originalVideoCallback = domMock.video.requestVideoFrameCallback;
    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
      configurable: true,
      value: () => 1,
    });
    domMock.video.requestVideoFrameCallback = callback => {
      callbacks.push(callback);
      return callbacks.length;
    };
    let current = true;
    const before = State.fps;

    try {
      detectFpsWeb(() => current);
      expect(callbacks).toHaveLength(1);

      current = false;
      callbacks[0](0, { mediaTime: 0 });

      expect(callbacks).toHaveLength(1);
      expect(State.fps).toBe(before);
    } finally {
      if (originalPrototype) Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', originalPrototype);
      else delete HTMLVideoElement.prototype.requestVideoFrameCallback;
      domMock.video.requestVideoFrameCallback = originalVideoCallback;
    }
  });

  it('serializes the shared ffmpeg.wasm worker and drops queued stale work', async () => {
    Media._webFfmpegTail = Promise.resolve();
    const firstGate = deferred();
    const events = [];
    const first = Media.runWebFfmpeg(async () => {
      events.push('A:start');
      await firstGate.promise;
      events.push('A:finish');
      return 'A';
    });
    await vi.waitFor(() => expect(events).toEqual(['A:start']));

    const second = Media.runWebFfmpeg(() => {
      events.push('B:start');
      return 'B';
    });
    expect(events).toEqual(['A:start']);

    firstGate.resolve();
    await expect(first).resolves.toBe('A');
    await expect(second).resolves.toBe('B');
    expect(events).toEqual(['A:start', 'A:finish', 'B:start']);

    let staleStarted = false;
    await expect(Media.runWebFfmpeg(() => { staleStarted = true; }, { owns: () => false })).resolves.toBeNull();
    expect(staleStarted).toBe(false);
  });

  it('releases the ffmpeg lane when A loses ownership while waiting for shared-video metadata', async () => {
    const { waitForOwnedMediaMetadata } = await import('../src/media-intake-session.js');
    const element = new EventTarget();
    Object.defineProperty(element, 'readyState', { configurable: true, value: 0 });
    const existingHandler = vi.fn();
    element.onloadedmetadata = existingHandler;
    let ownsA = true;
    const events = [];

    Media._webFfmpegTail = Promise.resolve();
    const first = Media.runWebFfmpeg(async () => {
      events.push('A:start');
      return waitForOwnedMediaMetadata(element, { owns: () => ownsA, timeoutMs: 500, pollMs: 5 });
    });
    await vi.waitFor(() => expect(events).toEqual(['A:start']));
    const second = Media.runWebFfmpeg(() => { events.push('B:start'); return 'B'; });

    ownsA = false;
    await expect(first).resolves.toBe('cancelled');
    await expect(second).resolves.toBe('B');
    expect(events).toEqual(['A:start', 'B:start']);
    expect(element.onloadedmetadata).toBe(existingHandler);
  });

  it('does not announce a stale A ffmpeg load as ready after B takes ownership', async () => {
    const gate = deferred();
    const loader = vi.spyOn(Media, 'loadFFmpeg').mockReturnValue(gate.promise);
    let ownsA = true;

    try {
      const a = Media._loadFFmpegForIntake(() => ownsA);
      expect(ui.setStatus).toHaveBeenCalledWith('載入 ffmpeg.wasm（首次需下載 ~25MB）…', 'busy');

      ownsA = false;
      gate.resolve({});
      await expect(a).resolves.toBeNull();

      expect(ui.setStatus).not.toHaveBeenCalledWith('ffmpeg 就緒', 'ok');
      expect(domMock.$('stEngine').textContent).toBe('');
    } finally {
      loader.mockRestore();
    }
  });

  it('does not report a stale A ffmpeg load failure after B takes ownership', async () => {
    const gate = deferred();
    const loader = vi.spyOn(Media, 'loadFFmpeg').mockReturnValue(gate.promise);
    let ownsA = true;

    try {
      const a = Media._loadFFmpegForIntake(() => ownsA);
      ownsA = false;
      gate.reject(new Error('offline'));
      await expect(a).rejects.toThrow('offline');

      expect(ui.setStatus).not.toHaveBeenCalledWith('ffmpeg 載入失敗（需網路；或改用本機伺服器/Electron 版）', '');
      expect(ui.showToast).not.toHaveBeenCalled();
    } finally {
      loader.mockRestore();
    }
  });
});
