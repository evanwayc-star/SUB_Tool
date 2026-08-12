// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mediaMock = vi.hoisted(() => ({
  displayTime: vi.fn(() => 0),
  externalAudio: { list: vi.fn(() => []), get: vi.fn(() => null) },
  reset: vi.fn(),
  seek: vi.fn(),
}));

vi.mock('../src/media.js', () => ({ Media: mediaMock }));
vi.mock('../src/timeline.js', () => ({ drawTimeline: vi.fn() }));
vi.mock('../src/history.js', () => ({ History: { reset: vi.fn() } }));
vi.mock('../src/notes.js', () => ({ renderNotes: vi.fn() }));
vi.mock('../src/ui.js', () => ({
  openModal: vi.fn(),
  closeModal: vi.fn(),
  showToast: vi.fn(),
  setStatus: vi.fn(),
}));

let Project;
let State;
let effStyle;
let trackStyleSnapshot;
let saveProject;

function savedData() {
  const b64 = saveProject.mock.calls.at(-1)[1];
  const bytes = Buffer.from(b64, 'base64');
  return JSON.parse(bytes.subarray(2).toString('utf16le'));
}

function baseProject(tracks) {
  return {
    app: 'SUB Tool',
    version: 3,
    media: {},
    fps: 25,
    trackCount: tracks.length,
    tracks,
    cues: [],
    notes: [],
  };
}

describe('subtitle style project persistence', () => {
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = '<div id="historyList"></div>';
    saveProject = vi.fn().mockResolvedValue('C:/projects/style.subtool');
    Object.defineProperty(window, 'subtool', {
      configurable: true,
      value: { isDesktop: true, saveProject },
    });
    ({ State } = await import('../src/state.js'));
    ({ effStyle, trackStyleSnapshot } = await import('../src/substyle.js'));
    ({ Project } = await import('../src/project.js'));
    State.tracks = [];
    State.cues = [];
    State.notes = [];
    State.clips = [];
    State.videoTracks = [{ name: '視訊軌 1', visible: true, locked: false }];
  });

  it('snapshots the effective style when saving a sparse track', async () => {
    State.tracks = [{ name: 'Sparse', visible: true, locked: false }];

    await Project.saveAs();
    const track = savedData().tracks[0];

    expect(track).toMatchObject({
      name: 'Sparse',
      fontSize: 60,
      posX: 50,
      posY: 90,
      posPct: 90,
    });
  });

  it('loads a sparse track through defaults without injecting obsolete raw values', () => {
    Project.apply(baseProject([{ name: 'Sparse', visible: true, locked: false }]));

    expect(State.tracks[0]).toEqual({
      name: 'Sparse',
      visible: true,
      locked: false,
    });
    expect(effStyle(null, State.tracks[0])).toMatchObject({
      fontSize: 60,
      posY: 90,
    });
  });

  it('preserves explicit historical values and migrates legacy aliases only when present', () => {
    const explicitY = 91.20370370370371;
    Project.apply(baseProject([
      {
        name: 'Explicit',
        fontSize: 65,
        fontScale: 2,
        posY: explicitY,
        posPct: 88,
        bold: false,
        outline: 0,
        bgAlpha: 0,
      },
      { name: 'Legacy', fontScale: 1.5, posPct: 88 },
    ]));

    expect(effStyle(null, State.tracks[0])).toMatchObject({
      fontSize: 65,
      posY: explicitY,
      bold: false,
      outline: 0,
      bgAlpha: 0,
    });
    expect(State.tracks[1]).toMatchObject({
      fontSize: 90,
      posY: 88,
    });
    expect(effStyle(null, State.tracks[1])).toMatchObject({
      fontSize: 90,
      posY: 88,
    });
  });

  it('copies the effective track style instead of a second set of fallbacks', () => {
    const copied = {
      name: 'Copied',
      visible: true,
      locked: false,
      ...trackStyleSnapshot({
        name: 'Source',
        fontSize: 65,
        posPct: 88,
        bold: false,
        outline: 0,
      }),
    };

    expect(copied).toMatchObject({
      name: 'Copied',
      visible: true,
      locked: false,
      fontSize: 65,
      posY: 88,
      bold: false,
      outline: 0,
    });
    expect(copied).not.toHaveProperty('posPct');

    // 接線檢查只負責鎖住 app 使用上面已實際執行過的 helper；行為正確性不靠比字串判定。
    const source = readFileSync('src/actions/track-actions.js', 'utf8');
    expect(source).not.toContain('srcTrack.fontSize||80');
    expect(source).not.toContain('st.posY:91.2');
    expect(source).toContain('trackStyleSnapshot(srcTrack)');

    const html = new DOMParser().parseFromString(readFileSync('index.html', 'utf8'), 'text/html');
    expect([...html.querySelectorAll('[data-ts-size]')].map(button => button.dataset.tsSize))
      .toEqual(['45', '60']);
    for (const id of [
      'tsSize', 'tsColor', 'tsPosX', 'tsPosY', 'tsAngle', 'tsSpacing', 'tsLineSp',
      'tsOutlineColor', 'tsOutline', 'tsShadow', 'tsBgColor', 'tsBgAlpha',
    ]) {
      expect(html.getElementById(id)?.hasAttribute('value'), id).toBe(false);
    }
  });
});
