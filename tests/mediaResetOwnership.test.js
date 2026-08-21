// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

const desktopMock = vi.hoisted(() => ({
  isDesktop: true,
  fileURL: vi.fn(),
  ingest: vi.fn(),
  probe: vi.fn(),
}));

const domMock = vi.hoisted(() => {
  const listeners = new Map();
  const video = {
    style: {}, src: '', readyState: 0, duration: 5, videoWidth: 1920, videoHeight: 1080,
    playbackRate: 1, currentTime: 0, muted: false,
    pause: vi.fn(), play: vi.fn(), load: vi.fn(),
    hasAttribute: name => name === 'src' && !!video.src,
    removeAttribute: name => { if (name === 'src') video.src = ''; },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type) { for (const listener of [...(listeners.get(type) || [])]) listener({ type }); },
    resetEvents() { listeners.clear(); },
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

const eventMock = vi.hoisted(() => ({ emit: vi.fn(), on: vi.fn() }));
vi.mock('../src/dom.js', () => domMock);
vi.mock('../src/events.js', () => eventMock);
vi.mock('../src/ui.js', () => ({
  setStatus: vi.fn(), showToast: vi.fn(), openModal: vi.fn(), closeModal: vi.fn(),
}));
vi.mock('../src/mixer.js', () => ({ renderAudioTracks: vi.fn(), clearMeterStrips: vi.fn() }));
vi.mock('../src/timeline.js', () => ({ drawTimeline: vi.fn(), updatePlayhead: vi.fn() }));

let Media, Wave, State, resetAudioProject, resetPlayerAdapter;

describe('reset-scoped media ownership', () => {
  beforeAll(async () => {
    window.subtool = desktopMock;
    window.AudioContext = class {
      constructor(){ this.state = 'running'; this.destination = {}; this.currentTime = 0; }
      createGain(){ return { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } }; }
      createAnalyser(){ return { connect: vi.fn(), disconnect: vi.fn(), fftSize: 32 }; }
      createMediaElementSource(){ return { channelCount: 2, connect: vi.fn(), disconnect: vi.fn() }; }
      createChannelSplitter(){ return { connect: vi.fn(), disconnect: vi.fn() }; }
      decodeAudioData(){ return Promise.resolve({
        duration: 1, numberOfChannels: 1, sampleRate: 100,
        getChannelData: () => new Float32Array(100),
      }); }
      resume(){}
    };
    ({ Media, Wave } = await import('../src/media.js'));
    ({ State, resetAudioProject } = await import('../src/state.js'));
    ({ resetPlayerAdapter } = await import('../src/media-player-adapter.js'));
  });

  beforeEach(() => {
    Media.reset();
    Media.ctx = null;
    Media.master = null;
    Media.tracks = [];
    State.clips = [];
    State.audioSources = [];
    desktopMock.fileURL.mockReset();
    desktopMock.ingest.mockReset();
    desktopMock.probe.mockReset();
    desktopMock.probe.mockResolvedValue({ duration: 8, audio: [{ channels: 1 }] });
    eventMock.emit.mockClear();
    domMock.video.src = '';
    domMock.video.readyState = 0;
    domMock.video.duration = 5;
    domMock.video.resetEvents();
    delete desktopMock.mpv;
    resetPlayerAdapter(desktopMock);
  });

  it('drops a late external-audio metadata result after project reset', async () => {
    const audios = [];
    class PendingAudio {
      constructor(){
        this.readyState = 0; this.src = ''; this.preload = ''; this.duration = 8;
        this._target = new EventTarget(); this.pause = vi.fn(); this.load = vi.fn();
        audios.push(this);
      }
      addEventListener(...args){ this._target.addEventListener(...args); }
      removeEventListener(...args){ this._target.removeEventListener(...args); }
      removeAttribute(name){ if (name === 'src') this.src = ''; }
      dispatch(type){ this._target.dispatchEvent(new Event(type)); }
    }
    const oldAudio = globalThis.Audio;
    const oldCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const oldRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    vi.stubGlobal('Audio', PendingAudio);
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:late-audio' });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });

    try {
      const pending = Media.addAudioFile({ name: 'A.wav', size: 100 });
      await vi.waitFor(() => expect(audios).toHaveLength(1));
      Media.reset();
      audios[0].dispatch('loadedmetadata');

      await expect(pending).resolves.toBeNull();
      expect(State.audioSources).toEqual([]);
      expect(Media.tracks).toEqual([]);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:late-audio');
    } finally {
      vi.unstubAllGlobals();
      if (oldAudio) globalThis.Audio = oldAudio;
      if (oldCreate) Object.defineProperty(URL, 'createObjectURL', oldCreate);
      else delete URL.createObjectURL;
      if (oldRevoke) Object.defineProperty(URL, 'revokeObjectURL', oldRevoke);
      else delete URL.revokeObjectURL;
    }
  });

  it('does not recreate a removed audio asset waveform after late file decode', async () => {
    const readers = [];
    class ControlledFileReader {
      constructor(){ this.result = null; this.onload = null; this.onerror = null; readers.push(this); }
      readAsArrayBuffer(){}
    }
    class ReadyAudio {
      constructor(){
        this.readyState = 1; this.src = ''; this.preload = ''; this.duration = 8;
        this._target = new EventTarget(); this.pause = vi.fn(); this.load = vi.fn();
      }
      addEventListener(...args){ this._target.addEventListener(...args); }
      removeEventListener(...args){ this._target.removeEventListener(...args); }
      removeAttribute(name){ if (name === 'src') this.src = ''; }
    }
    const oldCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const oldRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    vi.stubGlobal('FileReader', ControlledFileReader);
    vi.stubGlobal('Audio', ReadyAudio);
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:removed-audio' });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const originalFromFile = Wave.fromFile.bind(Wave);
    let waveformWork = null;
    const fromFile = vi.spyOn(Wave, 'fromFile').mockImplementation((...args) => {
      waveformWork = originalFromFile(...args);
      return waveformWork;
    });

    try {
      const asset = await Media.addAudioFile({ name: 'late.wav', size: 100 });
      expect(asset).not.toBeNull();
      expect(readers).toHaveLength(1);
      expect(Media.removeExternalAudio(asset.id, { record: false })).toBe(true);
      const durationAfterRemove = State.duration;

      readers[0].result = new ArrayBuffer(64);
      readers[0].onload();
      await expect(waveformWork).resolves.toBe(false);

      expect(Wave._sourceState(asset, false)).toBeNull();
      expect(State.duration).toBe(durationAfterRemove);
    } finally {
      fromFile.mockRestore();
      vi.unstubAllGlobals();
      if (oldCreate) Object.defineProperty(URL, 'createObjectURL', oldCreate);
      else delete URL.createObjectURL;
      if (oldRevoke) Object.defineProperty(URL, 'revokeObjectURL', oldRevoke);
      else delete URL.revokeObjectURL;
    }
  });

  it('restores native video audio after the last external mix source is deleted', () => {
    const asset = Media.createExternalAudioSource({
      name: 'reference.wav', path: 'C:/audio/reference.wav', duration: 8,
      in: 0, out: 8, offset: 0, fallbackCount: 1,
    });
    const element = { pause: vi.fn(), src: 'file:///reference.wav' };
    const gain = { disconnect: vi.fn(), gain: { value: 1 } };
    Media.tracks = [{
      id: 'external-track', kind: 'element', source: asset.audioSrc,
      el: element, gain, muted: false, solo: false, volume: 1,
      audioSourceId: asset.audioSourceId,
    }];
    domMock.video.src = 'file:///picture.mp4';
    domMock.video.muted = true;

    expect(Media.removeExternalAudio(asset.id, { record: false })).toBe(true);

    expect(Media.tracks).toEqual([]);
    expect(domMock.video.muted).toBe(false);
  });

  it('mutes mpv immediately when the active clip audio is detached', async () => {
    const mute = vi.fn().mockResolvedValue(undefined);
    desktopMock.mpv = { mute, launch: vi.fn().mockResolvedValue({ ok: true, duration: 8 }) };
    const runtime = resetPlayerAdapter(desktopMock);
    await runtime.enterMpv({ src: 'C:/media/picture.mov', bounds: { x: 0, y: 0, w: 640, h: 360 }, audio: [] });
    const clip = {
      id: 'detached-video', name: 'picture.mov', path: 'C:/media/picture.mov',
      dur: 8, in: 0, out: 8, offset: 0, vtrack: 0, primary: true,
      audioSrc: 'video', audioSourceId: 'source-picture', audioDetached: true,
    };
    State.clips = [clip];
    Media.activeClipId = clip.id;
    Media._applyClipAudio(clip, 0);
    await Promise.resolve();

    expect(mute).toHaveBeenCalledWith(true);
  });

  it('does not cancel primary audio preparation when an unrelated image is deleted', () => {
    const primary = {
      id: 'primary-video', name: 'picture.mov', path: 'C:/media/picture.mov',
      dur: 8, in: 0, out: 8, offset: 0, vtrack: 0, primary: true,
      audioSrc: 'video', audioSourceId: 'source-picture',
    };
    const image = {
      id: 'overlay-image', name: 'card.png', path: 'C:/media/card.png',
      type: 'image', dur: 4, in: 0, out: 4, offset: 1, vtrack: 1,
    };
    const pending = [{ id: 'pending-primary-channel' }];
    const ingestDone = vi.fn();
    State.clips = [primary, image];
    Media.pendingChannels = pending;
    Media._ingestDoneHandler = ingestDone;

    expect(Media.removeClip(image.id)).toBe(true);

    expect(Media.pendingChannels).toBe(pending);
    expect(Media._ingestDoneHandler).toBe(ingestDone);
  });

  it('cancels an older history audio restore when redo replaces its snapshot', async () => {
    const urlGate = deferred();
    desktopMock.fileURL.mockReturnValueOnce(urlGate.promise);
    const restoreSpy = vi.spyOn(Media, 'restoreExternalAudioSource');

    Media.restoreExternalAudioEditState([{
      audioSourceId: 'history-A', timelineLaneId: 'history-A', name: 'A.wav',
      path: 'C:/audio/A.wav', duration: 8, in: 0, out: 8, offset: 0,
    }]);
    await vi.waitFor(() => expect(desktopMock.fileURL).toHaveBeenCalledWith('C:/audio/A.wav'));
    const staleRestore = restoreSpy.mock.results[0].value;

    Media.restoreExternalAudioEditState([]);
    urlGate.resolve('file:///C:/audio/A.wav');
    await staleRestore;

    expect(Media.externalAudioSources).toEqual([]);
    expect(State.externalAudioState).toEqual([]);
    restoreSpy.mockRestore();
  });

  it('does not expose an optimistic half-clip while an external-audio split is pending', async () => {
    const rightGate = deferred();
    const asset = Media.createExternalAudioSource({
      name: 'dialog.wav', path: 'C:/audio/dialog.wav', duration: 8,
      in: 0, out: 8, offset: 0, fallbackCount: 1,
    });
    const addRight = vi.spyOn(Media, 'addAudioFileDesktop').mockReturnValue(rightGate.promise);

    const splitting = Media.splitExternalAudio(asset.id, 4);
    await vi.waitFor(() => expect(addRight).toHaveBeenCalledTimes(1));
    expect(asset.out).toBe(8);
    Media.moveExternalAudio(asset.id, 2);
    rightGate.resolve(null);
    await expect(splitting).resolves.toBeNull();

    expect(asset.offset).toBe(2);
    expect(asset.out).toBe(8);
    expect(Media.externalAudioSources).toEqual([asset]);
    addRight.mockRestore();
  });

  it('cancels detach when a new split placement joins the source during cache work', async () => {
    const cacheGate = deferred();
    const clip = {
      id: 'detach-A', name: 'A.mov', path: 'C:/media/A.mov', dur: 5,
      in: 0, out: 5, offset: 0, vtrack: 0, primary: true,
      audioSrc: 'video', audioSourceId: 'source-A', audioDetached: false,
    };
    State.clips = [clip];
    const cache = vi.spyOn(Media, '_addDesktopCachedAudio').mockReturnValue(cacheGate.promise);

    const detaching = Media.detachClipAudio(clip.id);
    await vi.waitFor(() => expect(cache).toHaveBeenCalledTimes(1));
    expect(Media.splitClipAt(2.5)).toBe(true);
    cacheGate.resolve({ id: 'late-external', audioSourceId: 'external-A' });
    await expect(detaching).resolves.toBeNull();

    expect(State.clips).toHaveLength(2);
    expect(State.clips.every(item => item.audioDetached !== true)).toBe(true);
    cache.mockRestore();
  });

  it('does not register clip audio after proxy lookup loses reset ownership', async () => {
    const proxyURL = deferred();
    const clip = {
      id: 'clip-A', name: 'A.mov', path: 'C:/media/A.mov', dur: 5,
      in: 0, out: 5, offset: 0, vtrack: 0, audioSourceId: 'source-A', audioSrc: 'clip:clip-A',
    };
    State.clips = [clip];
    resetAudioProject();
    desktopMock.ingest.mockResolvedValue({
      proxy: 'C:/cache/A-proxy.mp4',
      channels: [{ file: 'C:/cache/A-ch1.m4a', sourceStream: 0, sourceChannel: 0 }],
    });
    desktopMock.fileURL.mockImplementation(path => path === 'C:/cache/A-proxy.mp4'
      ? proxyURL.promise
      : Promise.resolve(`file:///${path}`));

    const pending = Media._clipIngest(clip, { audio: [{ channels: 1 }] });
    await vi.waitFor(() => expect(desktopMock.fileURL).toHaveBeenCalledWith('C:/cache/A-proxy.mp4'));
    Media.reset();
    resetAudioProject();
    State.clips = [];
    proxyURL.resolve('file:///C:/cache/A-proxy.mp4');
    await pending;

    expect(State.audioProject.sourceMaps['source-A']).toBeUndefined();
    expect(Media.tracks).toEqual([]);
  });

  it('does not recreate a deleted primary clip waveform after late file decode', async () => {
    const readers = [];
    class ControlledFileReader {
      constructor(){ this.result = null; this.onload = null; this.onerror = null; readers.push(this); }
      readAsArrayBuffer(){}
    }
    vi.stubGlobal('FileReader', ControlledFileReader);
    const primary = {
      id: 'primary-A', name: 'A.mov', dur: 5, in: 0, out: 5, offset: 0,
      vtrack: 0, primary: true, audioSrc: 'video', audioSourceId: 'source-A',
    };
    State.clips = [primary];
    const work = Wave.fromFile({ name: 'A.mov' }, primary);
    await vi.waitFor(() => expect(readers).toHaveLength(1));
    expect(Media.removeClip(primary.id)).toBe(true);
    const durationAfterDelete = State.duration;

    readers[0].result = new ArrayBuffer(64);
    readers[0].onload();
    await expect(work).resolves.toBe(false);

    expect(Wave._sourceState(primary, false)).toBeNull();
    expect(State.duration).toBe(durationAfterDelete);
    vi.unstubAllGlobals();
  });

  it('drops late mother-source background ingest after the last clip is deleted', async () => {
    const ingest = deferred();
    const primary = {
      id: 'primary-A', name: 'A.mov', path: 'C:/media/A.mov', dur: 5,
      in: 0, out: 5, offset: 0, vtrack: 0, primary: true,
      audioSrc: 'video', audioSourceId: 'source-A',
    };
    State.clips = [primary];
    resetAudioProject();
    desktopMock.ingest.mockReturnValueOnce(ingest.promise);

    const work = Media._bgAudioIngest('C:/media/A.mov', [{ channels: 1 }], 5, primary);
    await vi.waitFor(() => expect(desktopMock.ingest).toHaveBeenCalledTimes(1));
    expect(Media.removeClip(primary.id)).toBe(true);
    ingest.resolve({
      channels: [{ file: 'C:/cache/A-ch1.m4a', sourceStream: 0, sourceChannel: 0 }],
    });
    await work;

    expect(State.audioProject.sourceMaps['source-A']).toBeUndefined();
    expect(Media.tracks).toEqual([]);
  });

  it('keeps source work alive when a split placement still references the mother source', async () => {
    const ingest = deferred();
    const primary = {
      id: 'primary-A', name: 'A.mov', path: 'C:/media/A.mov', dur: 10,
      in: 0, out: 5, offset: 0, vtrack: 0, primary: true,
      audioSrc: 'video', audioSourceId: 'source-A',
    };
    const split = {
      ...primary, id: 'split-A', primary: false, in: 5, out: 10, offset: 5,
    };
    State.clips = [primary, split];
    resetAudioProject();
    desktopMock.ingest.mockReturnValueOnce(ingest.promise);

    const work = Media._bgAudioIngest('C:/media/A.mov', [{ channels: 1 }], 10, primary);
    await vi.waitFor(() => expect(desktopMock.ingest).toHaveBeenCalledTimes(1));
    expect(Media.removeClip(primary.id)).toBe(true);
    ingest.resolve({ channels: [] });
    await work;

    expect(State.clips).toContain(split);
    expect(State.audioProject.sourceMaps['source-A']).toEqual({ channels: [] });
  });

  it('does not let an old waveform request recreate a cleared registry', async () => {
    const urlGate = deferred();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    desktopMock.fileURL.mockReturnValueOnce(urlGate.promise);
    Wave.registerSourceWaveforms('video', { mixPath: 'A.wav' });

    const pending = Wave.loadSourceWaveform('video');
    Wave.clearSources();
    urlGate.resolve('file:///A.wav');

    await expect(pending).resolves.toBeNull();
    expect(Wave.sourceWaveforms.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('uses source identity and generation, not a reused numeric waveform index', async () => {
    Media.ensureCtx();
    const urlGate = deferred();
    desktopMock.fileURL.mockReturnValueOnce(urlGate.promise);
    const sourceA = { label: 'A', path: 'A.wav', peaks: null, sourceId: 'video', kind: 'mix', sourceKey: 'video' };
    const sourceB = { label: 'B', path: 'B.wav', peaks: null, sourceId: 'video', kind: 'mix', sourceKey: 'video' };
    Wave.sources = [sourceA];
    Wave.srcIdx = -1;

    const pending = Wave.selectSource(0);
    await vi.waitFor(() => expect(desktopMock.fileURL).toHaveBeenCalledWith('A.wav'));
    Wave.clearSources();
    Wave.sources = [sourceB];
    Wave.srcIdx = 0;
    urlGate.resolve('file:///A.wav');

    await pending;
    expect(sourceA.peaks).toBeNull();
    expect(sourceB.peaks).toBeNull();
    expect(Wave.sources[0]).toBe(sourceB);
  });

  it('keeps a newer clip switch lock when an older metadata wait is cancelled by reset', async () => {
    const clipA = { id: 'A', name: 'A', type: 'video', web: { url: 'blob:A' }, in: 0, out: 5, offset: 0, vtrack: 0 };
    const clipB = { id: 'B', name: 'B', type: 'video', web: { url: 'blob:B' }, in: 0, out: 5, offset: 0, vtrack: 0 };
    State.clips = [clipA];
    const first = Media._ensureClip(clipA, 0, false);
    await vi.waitFor(() => expect(domMock.video.src).toBe('blob:A'));

    Media.reset();
    domMock.video.readyState = 0;
    State.clips = [clipB];
    const second = Media._ensureClip(clipB, 0, false);
    await vi.waitFor(() => expect(domMock.video.src).toBe('blob:B'));
    expect(Media._seqSwitching).toBe(true);

    domMock.video.readyState = 1;
    domMock.video.dispatch('loadedmetadata');
    await Promise.all([first, second]);

    expect(Media.activeClipId).toBe('B');
    expect(Media._gap).toBe(false);
    expect(Media._seqSwitching).toBe(false);
  });

  it('clears a failed clip ownership so the same clip can retry metadata intake', async () => {
    const clip = { id: 'retry', name: 'retry', type: 'video', web: { url: 'blob:retry' }, in: 0, out: 5, offset: 0, vtrack: 0 };
    State.clips = [clip];
    const failed = Media._ensureClip(clip, 0, false);
    await vi.waitFor(() => expect(domMock.video.src).toBe('blob:retry'));
    domMock.video.dispatch('error');
    await failed;

    expect(Media.activeClipId).toBeNull();
    expect(Media._gap).toBe(true);
    expect(domMock.video.src).toBe('');

    domMock.video.readyState = 1;
    await Media._ensureClip(clip, 0, false);
    expect(Media.activeClipId).toBe('retry');
    expect(Media._gap).toBe(false);
  });

  it('retries the current paused clip after an older metadata switch is superseded', async () => {
    const oldClip = {
      id: 'same-id', name: 'old', type: 'video', web: { url: 'blob:old' },
      audioSrc: 'clip:same-id', path: 'C:/old.mov', in: 0, out: 5, offset: 0, vtrack: 0,
    };
    const currentClip = {
      ...oldClip, name: 'current', web: { url: 'blob:current' }, path: 'C:/current.mov',
    };
    State.clips = [oldClip];
    const switching = Media._ensureClip(oldClip, 0, false);
    await vi.waitFor(() => expect(domMock.video.src).toBe('blob:old'));

    State.clips = [currentClip];
    Media.restoreSequenceEditState(0);
    domMock.video.readyState = 1;
    await switching;
    await vi.waitFor(() => expect(domMock.video.src).toBe('blob:current'));

    expect(Media.activeClipId).toBe('same-id');
    expect(Media._gap).toBe(false);
    expect(Media._seqSwitching).toBe(false);
  });

  it('rolls back late project clips without consuming the restore plan after History supersedes it', async () => {
    const imageGate = deferred();
    const pending = [
      {
        id: 'saved-primary', primary: true, name: 'A.mov', path: 'C:/media/A.mov',
        dur: 8, in: 0, out: 8, offset: 0, audioSourceId: 'source-A',
      },
      {
        id: 'saved-image', type: 'image', name: 'card.png', path: 'C:/media/card.png',
        dur: 36000, in: 0, out: 4, offset: 2, vtrack: 1,
      },
      {
        id: 'saved-secondary', name: 'B.mov', path: 'C:/media/B.mov',
        dur: 5, in: 0, out: 5, offset: 8, audioSourceId: 'source-B',
      },
    ];
    const replaceClips = vi.fn();
    const plan = {
      owns: () => true,
      pendingClips: () => pending,
      consumeMediaRelink: () => false,
      replaceClips,
    };
    const lateImage = { ...pending[1] };
    const addImage = vi.spyOn(Media, 'addImageDesktop').mockImplementation(async () => {
      await imageGate.promise;
      State.clips.push(lateImage);
      return lateImage;
    });

    Media._registerPrimary({
      id: 'runtime-primary', name: 'A.mov', path: 'C:/media/A.mov', dur: 8, fps: 25,
    }, plan);
    await vi.waitFor(() => expect(addImage).toHaveBeenCalledTimes(1));

    State.clips = [];
    Media.restoreSequenceEditState(0);
    imageGate.resolve();
    await Media.waitForPendingProjectRestore();

    expect(State.clips).toEqual([]);
    expect(replaceClips).not.toHaveBeenCalled();
    expect(plan.pendingClips()).toEqual(pending);
    addImage.mockRestore();
  });
});
