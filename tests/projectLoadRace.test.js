// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mediaMock = vi.hoisted(() => ({
  displayTime: vi.fn(() => 0),
  getExternalAudioSources: vi.fn(() => []),
  loadDesktopMedia: vi.fn(),
  reset: vi.fn(),
  restorePendingImageClips: vi.fn().mockResolvedValue({ restored: 0, pending: 0 }),
  seek: vi.fn(),
  waitForPendingProjectRestore: vi.fn().mockResolvedValue(),
}));

const uiMock = vi.hoisted(() => ({
  openModal: vi.fn(),
  closeModal: vi.fn(),
  showToast: vi.fn(),
  setStatus: vi.fn(),
}));

vi.mock('../src/media.js', () => ({ Media: mediaMock }));
vi.mock('../src/timeline.js', () => ({ drawTimeline: vi.fn() }));
vi.mock('../src/notes.js', () => ({ renderNotes: vi.fn() }));
vi.mock('../src/ui.js', () => uiMock);

let History;
let Project;
let State;
let desk;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function projectB64(data) {
  return Buffer.concat([
    Buffer.from([0xFF, 0xFE]),
    Buffer.from(JSON.stringify(data), 'utf16le'),
  ]).toString('base64');
}

function projectData(label, mediaPath, playhead = null) {
  return {
    app: 'SUB Tool',
    version: 3,
    media: { name: `${label}.mov`, size: 100, path: mediaPath },
    duration: 20,
    fps: 25,
    tracks: [],
    cues: [{ start: 1, end: 2, text: label, track: 1 }],
    notes: [],
    clips: [{
      id: `clip-${label}`,
      name: `${label}.mov`,
      path: mediaPath,
      dur: 20,
      in: 0,
      out: 20,
      offset: 0,
      vtrack: 0,
      primary: true,
    }],
    ...(playhead == null ? {} : { playhead }),
  };
}

function request(label, mediaPath, playhead = null) {
  return {
    path: `C:/projects/${label}.subtool`,
    b64: projectB64(projectData(label, mediaPath, playhead)),
  };
}

describe('project load transactions', () => {
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = '<div id="historyList"></div>';
    desk = {
      isDesktop: true,
      stat: vi.fn(),
      openMedia: vi.fn(),
    };
    Object.defineProperty(window, 'subtool', {
      configurable: true,
      value: desk,
    });

    ({ State } = await import('../src/state.js'));
    ({ History } = await import('../src/history.js'));
    ({ Project } = await import('../src/project.js'));

    History.stack = [];
    History.hi = -1;
    State.clips = [];
    State.cues = [];
    State.notes = [];
    mediaMock.reset.mockClear();
    mediaMock.loadDesktopMedia.mockReset();
    mediaMock.waitForPendingProjectRestore.mockReset();
    mediaMock.waitForPendingProjectRestore.mockResolvedValue();
    mediaMock.seek.mockClear();
    uiMock.openModal.mockClear();
    uiMock.closeModal.mockClear();
    uiMock.setStatus.mockClear();
  });

  it('skips stale work when a newer project is requested during the first stat', async () => {
    const statA = deferred();
    desk.stat.mockImplementation(path => {
      if (path === 'C:/media/A.mov') return statA.promise;
      return Promise.resolve({ exists: true });
    });
    const resetHistory = vi.spyOn(History, 'reset');

    const loadingA = Project.loadDesktop(request('A', 'C:/media/A.mov'));
    await vi.waitFor(() => expect(desk.stat).toHaveBeenCalledWith('C:/media/A.mov'));
    const loadingB = Project.loadDesktop(request('B', 'C:/media/B.mov'));
    expect(desk.stat).not.toHaveBeenCalledWith('C:/media/B.mov');

    statA.resolve({ exists: true });
    await Promise.all([loadingA, loadingB]);

    expect(mediaMock.loadDesktopMedia).toHaveBeenCalledTimes(1);
    expect(mediaMock.loadDesktopMedia).toHaveBeenCalledWith('C:/media/B.mov');
    expect(State.cues.map(cue => cue.text)).toEqual(['B']);
    expect(resetHistory).toHaveBeenCalledTimes(1);
  });

  it('serializes a newer project behind an in-flight media load and only finalizes the winner', async () => {
    const mediaA = deferred();
    const callOrder = [];
    desk.stat.mockResolvedValue({ exists: true });
    mediaMock.loadDesktopMedia.mockImplementation(path => {
      callOrder.push(`start:${path}`);
      if (path === 'C:/media/A.mov') {
        return mediaA.promise.then(() => {
          callOrder.push(`finish:${path}`);
        });
      }
      callOrder.push(`finish:${path}`);
      return Promise.resolve();
    });
    const resetHistory = vi.spyOn(History, 'reset');

    const loadingA = Project.loadDesktop(request('A', 'C:/media/A.mov', 11));
    await vi.waitFor(() => expect(mediaMock.loadDesktopMedia).toHaveBeenCalledWith('C:/media/A.mov'));
    const loadingB = Project.loadDesktop(request('B', 'C:/media/B.mov', 22));
    expect(mediaMock.loadDesktopMedia).not.toHaveBeenCalledWith('C:/media/B.mov');

    mediaA.resolve();
    await Promise.all([loadingA, loadingB]);

    expect(callOrder).toEqual([
      'start:C:/media/A.mov',
      'finish:C:/media/A.mov',
      'start:C:/media/B.mov',
      'finish:C:/media/B.mov',
    ]);
    expect(State.cues.map(cue => cue.text)).toEqual(['B']);
    expect(mediaMock.seek).toHaveBeenCalledTimes(1);
    expect(mediaMock.seek).toHaveBeenCalledWith(22);
    expect(resetHistory).toHaveBeenCalledTimes(1);
  });

  it('invalidates a missing-media modal callback after another project wins', async () => {
    desk.stat.mockImplementation(path => Promise.resolve({
      exists: path === 'C:/media/B.mov',
    }));
    mediaMock.loadDesktopMedia.mockResolvedValue();

    await Project.loadDesktop(request('A', 'C:/media/missing-A.mov'));
    const actions = uiMock.openModal.mock.calls.at(-1)?.[2];
    expect(actions?.[0]?.act).toBeTypeOf('function');

    await Project.loadDesktop(request('B', 'C:/media/B.mov'));
    await actions[0].act();

    expect(desk.openMedia).not.toHaveBeenCalled();
    expect(mediaMock.loadDesktopMedia).toHaveBeenCalledTimes(1);
    expect(mediaMock.loadDesktopMedia).toHaveBeenCalledWith('C:/media/B.mov');
    expect(State.cues.map(cue => cue.text)).toEqual(['B']);
  });

  it('keeps the transaction tail usable after an older load rejects', async () => {
    const statA = deferred();
    desk.stat.mockImplementation(path => {
      if (path === 'C:/media/A.mov') return statA.promise;
      return Promise.resolve({ exists: true });
    });
    mediaMock.loadDesktopMedia.mockResolvedValue();

    const loadingA = Project.loadDesktop(request('A', 'C:/media/A.mov'));
    await vi.waitFor(() => expect(desk.stat).toHaveBeenCalledWith('C:/media/A.mov'));
    const loadingB = Project.loadDesktop(request('B', 'C:/media/B.mov'));
    statA.reject(new Error('磁碟暫時不可用'));

    await expect(loadingA).rejects.toThrow('磁碟暫時不可用');
    await loadingB;

    expect(mediaMock.loadDesktopMedia).toHaveBeenCalledWith('C:/media/B.mov');
    expect(State.cues.map(cue => cue.text)).toEqual(['B']);
  });
});
