// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const domMock = vi.hoisted(() => {
  const video = {
    style: {},
    playbackRate: 1,
    currentTime: 0,
    hasAttribute: () => false,
    pause: vi.fn(),
    dispatchEvent: vi.fn(),
  };
  const elements = new Map();
  return {
    video,
    $(id) {
      if (!elements.has(id)) {
        elements.set(id, {
          style: {},
          textContent: '',
          value: 0,
          innerHTML: '',
          classList: { add: vi.fn(), remove: vi.fn() },
          querySelectorAll: () => [],
        });
      }
      return elements.get(id);
    },
  };
});

vi.mock('../src/dom.js', () => domMock);
vi.mock('../src/ui.js', () => ({
  setStatus: vi.fn(),
  showToast: vi.fn(),
  openModal: vi.fn(),
  closeModal: vi.fn(),
}));
vi.mock('../src/mixer.js', () => ({
  renderAudioTracks: vi.fn(),
  clearMeterStrips: vi.fn(),
}));
vi.mock('../src/timeline-renderer.js', () => ({
  drawTimeline: vi.fn(),
  updatePlayhead: vi.fn(),
}));
vi.mock('../src/notes.js', () => ({ renderNotes: vi.fn() }));

const deskMock = {
  fileURL: vi.fn(async path => `file:///${path.replaceAll('\\', '/')}`),
  ingest: vi.fn(async () => ({ channels: [] })),
  probe: vi.fn(async () => ({
    duration: 5,
    video: { codec: 'h264', fps: 25 },
    audio: [],
  })),
};

let History;
let Media;
let State;
let emit;

describe('history restores the media runtime', () => {
  beforeAll(async () => {
    Object.defineProperty(window, 'subtool', {
      configurable: true,
      value: { isDesktop: true, ...deskMock },
    });
    window.AudioContext = class {
      constructor() {
        this.state = 'running';
        this.destination = {};
      }
      createGain() {
        return { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } };
      }
      createAnalyser() {
        return { connect: vi.fn(), fftSize: 0 };
      }
      resume() {}
    };
    ({ History } = await import('../src/history.js'));
    ({ Media } = await import('../src/media.js'));
    ({ State } = await import('../src/state.js'));
    ({ emit } = await import('../src/events.js'));
  });

  beforeEach(() => {
    State.cues = [];
    State.notes = [];
    State.tracks = [{ name: '字幕軌 1', visible: true, locked: false }];
    State.videoTracks = [{ name: '視訊軌 1', visible: true, locked: false }];
    State.clips = [{
      id: 'clip-a',
      name: 'program.mov',
      path: 'C:/source/program.mov',
      web: { url: 'file:///C:/source/program.mov' },
      dur: 20,
      in: 2,
      out: 16,
      offset: 7,
      vtrack: 0,
      primary: true,
    }];
    State.duration = 21;
    State.externalAudioEnd = 0;
    State.exportIn = null;
    State.exportOut = null;
    Media.activeClipId = 'clip-a';
    Media.playing = false;
    Media._lastSeekTime = 8;
    History.stack = [];
    History.hi = -1;
    Media.tracks = [];
    Media.ctx = null;
    Media.master = { gain: { value: 1 }, connect: vi.fn() };
    Media._clipRuntimePromises = new Map();
    Media._clipRuntimeReadySources = new Set();
    Media._gap = false;
    Media._gapT = 0;
    Media._gapStart = null;
    domMock.video.style.visibility = '';
    domMock.video.pause.mockClear();
    domMock.video.dispatchEvent.mockClear();
    deskMock.ingest.mockClear();
    deskMock.probe.mockClear();
    History.reset();
  });

  it('re-seeks the player to the same timeline position after undoing clip geometry', () => {
    State.clips[0].offset = 10;
    History.record('移動影片');
    const seek = vi.spyOn(Media, 'seek').mockImplementation(() => {});

    History.undo();

    expect(State.clips[0].offset).toBe(7);
    expect(seek).toHaveBeenCalledWith(8);
    seek.mockRestore();
  });

  it('notifies preview consumers when seeking a subtitle-only timeline without media', () => {
    State.clips = [];
    State.duration = 30;
    State.externalAudioEnd = 0;
    Media.activeClipId = null;
    Media.tracks = [];

    const seeked = vi.fn();
    window.addEventListener('mpv:seeked', seeked, { once: true });

    Media.seek(12);

    expect(Media.displayTime()).toBe(12);
    expect(seeked).toHaveBeenCalledTimes(1);
    expect(seeked.mock.calls[0][0].detail).toBe(12);
  });

  it('prunes removed clip audio and rebuilds it when redo revives the clip', async () => {
    const secondary = {
      id: 'clip-b',
      name: 'insert.mov',
      path: 'C:/source/insert.mov',
      web: { url: 'file:///C:/source/insert.mov' },
      dur: 5,
      in: 0,
      out: 5,
      offset: 14,
      vtrack: 0,
      primary: false,
      audioSrc: 'clip:clip-b',
      audioSourceId: 'source-b',
    };
    State.clips.push(secondary);
    const element = { pause: vi.fn(), src: 'file:///cache/ch1.m4a' };
    Media.tracks.push({
      source: 'clip:clip-b',
      kind: 'element',
      el: element,
      gain: { disconnect: vi.fn(), gain: { value: 1 } },
    });
    History.record('加入影片');

    History.undo();
    expect(State.clips.map(clip => clip.id)).toEqual(['clip-a']);
    expect(Media.tracks.some(track => track.source === 'clip:clip-b')).toBe(false);
    expect(element.pause).toHaveBeenCalled();
    expect(element.src).toBe('');

    History.redo();
    await Media.waitForHistorySequenceRestore();
    expect(State.clips.map(clip => clip.id)).toEqual(['clip-a', 'clip-b']);
    expect(deskMock.probe).toHaveBeenCalledWith('C:/source/insert.mov');
    expect(deskMock.ingest).toHaveBeenCalledWith(expect.objectContaining({
      path: 'C:/source/insert.mov',
      queue: true,
    }));
  });

  it('lets pending source work follow a same-fingerprint clip clone across undo and redo', async () => {
    const firstProbe = {};
    firstProbe.promise = new Promise(resolve => { firstProbe.resolve = resolve; });
    deskMock.probe
      .mockReturnValueOnce(firstProbe.promise)
      .mockResolvedValue({ duration: 5, video: { codec: 'h264', fps: 25 }, audio: [] });
    const secondary = {
      id: 'clip-b', name: 'insert.mov', path: 'C:/source/insert.mov',
      web: { url: 'file:///C:/source/insert.mov' }, dur: 5, in: 0, out: 5,
      offset: 14, vtrack: 0, primary: false, audioSrc: 'clip:clip-b', audioSourceId: 'source-b',
    };
    State.clips.push(secondary);
    History.record('加入影片');
    History.undo();

    History.redo();
    await vi.waitFor(() => expect(deskMock.probe).toHaveBeenCalledTimes(1));
    const firstRedoClip = State.clips.find(clip => clip.id === 'clip-b');
    History.undo();
    History.redo();
    const secondRedoClip = State.clips.find(clip => clip.id === 'clip-b');
    expect(secondRedoClip).not.toBe(firstRedoClip);
    expect(deskMock.probe).toHaveBeenCalledTimes(1);

    firstProbe.resolve({ duration: 5, video: { codec: 'h264', fps: 25 }, audio: [] });
    await Media.waitForHistorySequenceRestore();

    expect(deskMock.ingest).toHaveBeenCalledTimes(1);
    expect(deskMock.ingest).toHaveBeenCalledWith(expect.objectContaining({
      path: 'C:/source/insert.mov', queue: true,
    }));
  });

  it('rebases pre-media history so delayed project relinking survives undo', () => {
    State.clips = [];
    History.reset();
    State.cues = [{ id: 'cue-a', start: 1, end: 2, text: '字幕', track: 0 }];
    History.record('加入字幕');

    State.clips = [
      {
        id: 'clip-a',
        name: 'program.mov',
        path: 'C:/source/program.mov',
        dur: 20,
        in: 2,
        out: 16,
        offset: 7,
        vtrack: 0,
        primary: true,
      },
      {
        id: 'clip-b',
        name: 'insert.mov',
        path: 'C:/source/insert.mov',
        dur: 5,
        in: 0,
        out: 5,
        offset: 14,
        vtrack: 0,
        primary: false,
        audioSrc: 'clip:clip-b',
      },
    ];
    emit('media:projectReady', { clips: State.clips.map(clip => ({ ...clip })) });

    History.undo();
    expect(State.clips.map(clip => clip.id)).toEqual(['clip-a', 'clip-b']);
  });

  it('does not rebase media added by the user while a missing project source is waiting', () => {
    State.clips = [];
    History.reset();
    const image = {
      id: 'image-user',
      type: 'image',
      name: 'new-card.png',
      path: 'C:/source/new-card.png',
      dur: 36000,
      in: 0,
      out: 10,
      offset: 0,
      vtrack: 0,
    };
    State.clips = [image];
    History.record('加入圖片');

    const restoredProjectVideo = {
      id: 'clip-project',
      name: 'program.mov',
      path: 'C:/source/program.mov',
      dur: 20,
      in: 0,
      out: 20,
      offset: 0,
      vtrack: 1,
      primary: true,
      audioSrc: 'video',
    };
    State.clips.push(restoredProjectVideo);
    emit('media:projectReady', { clips: [{ ...restoredProjectVideo }] });

    History.undo();
    expect(State.clips.map(clip => clip.id)).toEqual(['clip-project']);
  });

  it('stops and hides stale player runtime when redo restores an empty video sequence', async () => {
    const primaryTrack = {
      source: 'video',
      kind: 'element',
      _srcHidden: false,
      gain: { disconnect: vi.fn(), gain: { value: 1 } },
    };
    Media.tracks = [primaryTrack];
    Media.playing = true;
    History.reset();
    State.clips = [];
    History.record('刪除最後影片');
    const seek = vi.spyOn(Media, 'seek').mockImplementation(() => {});

    History.undo();
    await Media.waitForHistorySequenceRestore();
    domMock.video.pause.mockClear();

    History.redo();
    await Media.waitForHistorySequenceRestore();

    expect(State.clips).toEqual([]);
    expect(Media.activeClipId).toBe(null);
    expect(Media._gap).toBe(true);
    expect(Media.playing).toBe(false);
    expect(domMock.video.pause).toHaveBeenCalled();
    expect(domMock.video.style.visibility).toBe('hidden');
    expect(primaryTrack._srcHidden).toBe(true);
    seek.mockRestore();
  });

  it('keeps an audio-only playhead on the transport virtual clock while the visual gap stays black', () => {
    State.clips = [];
    State.duration = 60;
    Media.externalAudioSources = [{
      id: 'external-a', duration: 60, in: 0, out: 60, offset: 0, enabled: true,
    }];
    Media._transport.reset();
    Media._transport.enterGap(10, { running: false }); // visual black-screen state
    Media._transport.seekVirtual(40, { running: false });
    Media.playing = true;

    expect(Media.audioOnlyTimeline()).toBe(true);
    expect(Media._gap).toBe(true);
    expect(Media.tlTime()).toBe(40);

    Media.pause();
    expect(Media.displayTime()).toBe(40);
    expect(Media._vStart).toBeNull();
  });
});
