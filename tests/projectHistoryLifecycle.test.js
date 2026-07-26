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

vi.mock('../src/media.js', () => ({ Media: mediaMock }));
vi.mock('../src/timeline.js', () => ({ drawTimeline: vi.fn() }));
vi.mock('../src/notes.js', () => ({ renderNotes: vi.fn() }));
vi.mock('../src/ui.js', () => ({
  openModal: vi.fn(),
  closeModal: vi.fn(),
  showToast: vi.fn(),
  setStatus: vi.fn(),
}));

let History;
let Project;
let State;

function projectB64(data) {
  return Buffer.concat([
    Buffer.from([0xFF, 0xFE]),
    Buffer.from(JSON.stringify(data), 'utf16le'),
  ]).toString('base64');
}

function savedProject() {
  return {
    app: 'SUB Tool',
    version: 3,
    media: { name: 'program.mov', size: 100, path: 'C:/source/program.mov' },
    duration: 20,
    fps: 25,
    tracks: [],
    cues: [],
    notes: [],
    clips: [{
      id: 'saved-primary',
      name: 'program.mov',
      path: 'C:/source/program.mov',
      dur: 20,
      in: 2,
      out: 16,
      offset: 7,
      vtrack: 0,
      primary: true,
    }],
  };
}

describe('project history lifecycle', () => {
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = '<div id="historyList"></div>';
    Object.defineProperty(window, 'subtool', {
      configurable: true,
      value: {
        isDesktop: true,
        stat: vi.fn().mockResolvedValue({ exists: true, size: 100 }),
      },
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
    mediaMock.waitForPendingProjectRestore.mockReset();
    mediaMock.waitForPendingProjectRestore.mockResolvedValue();
    mediaMock.loadDesktopMedia.mockReset();
    mediaMock.seek.mockClear();
    mediaMock.loadDesktopMedia.mockImplementation(async () => {
      State.clips = [{
        id: 'runtime-primary',
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
    });
  });

  it('creates the initial undo snapshot after desktop media restoration finishes', async () => {
    await Project.loadDesktop({
      path: 'C:/projects/program.subtool',
      b64: projectB64(savedProject()),
    });

    State.clips[0].offset = 11;
    History.record('移動影片');
    History.undo();

    expect(State.clips).toHaveLength(1);
    expect(State.clips[0].offset).toBe(7);
  });

  it('waits for secondary clip restoration before establishing the undo baseline', async () => {
    let finishSecondary;
    mediaMock.waitForPendingProjectRestore.mockImplementation(() => new Promise(resolve => {
      finishSecondary = () => {
        State.clips.push({
          id: 'secondary',
          name: 'insert.mov',
          path: 'C:/source/insert.mov',
          web: { url: 'file:///C:/source/insert.mov' },
          dur: 5,
          in: 0,
          out: 5,
          offset: 15,
          vtrack: 0,
          primary: false,
        });
        resolve();
      };
    }));

    const loading = Project.loadDesktop({
      path: 'C:/projects/program.subtool',
      b64: projectB64(savedProject()),
    });
    await vi.waitFor(() => expect(mediaMock.loadDesktopMedia).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mediaMock.waitForPendingProjectRestore).toHaveBeenCalledTimes(1));
    expect(History.stack).toEqual([]);

    finishSecondary();
    await loading;
    expect(History.stack[0].snap.clipGeo.map(clip => clip.id)).toEqual([
      'runtime-primary',
      'secondary',
    ]);
  });

  it('restores the saved playhead only after project media restoration is complete', async () => {
    vi.useFakeTimers();
    try {
      const data = savedProject();
      data.playhead = 13;

      await Project.loadDesktop({
        path: 'C:/projects/program.subtool',
        b64: projectB64(data),
      });

      expect(mediaMock.waitForPendingProjectRestore).toHaveBeenCalledTimes(1);
      expect(mediaMock.seek).toHaveBeenCalledWith(13);
      expect(State._pendingPlayhead).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
