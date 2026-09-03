// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const State = {
    cues: [],
    tracks: [],
    trackCount: 0,
    selectedId: null,
    selectedIds: [],
    videoTracks: [{ name: '視訊軌 1', visible: true, locked: false }],
    clips: [],
    duration: 0,
    fps: 25,
    dropFrame: false,
    pxPerSec: 80,
    viewStart: 0,
    vtracksCollapsed: false,
    audioProject: {},
    notes: [],
    inPoint: null,
  };

  return { State };
});

if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = function() {
    return {
      save: vi.fn(), scale: vi.fn(), clearRect: vi.fn(), restore: vi.fn(),
      beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
      fillText: vi.fn(), strokeText: vi.fn(), fillRect: vi.fn(),
    };
  };
}

vi.mock('../src/dom.js', () => ({
  $: id => document.getElementById(id),
  get video() { return document.getElementById('video'); },
  get tlScroll() { return document.getElementById('tlScroll'); },
  get tlLayer() { return document.getElementById('tlLayer'); },
  get tlTracks() { return document.getElementById('tlTracks'); },
  get rulerCv() { return document.getElementById('rulerCanvas'); },
}));

vi.mock('../src/state.js', () => ({
  State: harness.State,
  trackVisible: track => harness.State.tracks[track]?.visible !== false,
  newTrack: () => ({ name: `軌道 ${harness.State.tracks.length + 1}`, visible: true, locked: false }),
  syncTrackCount: () => { harness.State.trackCount = harness.State.tracks.length; },
  isSel: id => harness.State.selectedIds.includes(id),
  cueSuffix: () => '',
  newVideoTrack: () => ({ name: '視訊軌', visible: true, locked: false }),
  ensureVideoTrackCount: () => false,
  videoTrackVisible: track => harness.State.videoTracks[track]?.visible !== false,
  resetVideoTracks: vi.fn(),
  newId: () => 'test-cue',
  setSelection: vi.fn(),
}));

vi.mock('../src/util.js', () => ({
  clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
  pad: value => String(value).padStart(2, '0'),
  escapeHTML: value => String(value ?? ''),
}));

vi.mock('../src/media.js', () => ({
  Media: {
    displayTime: () => 0,
    externalAudio: { list: () => [], get: () => null },
    mpvMode: false,
  },
  Wave: {},
}));

vi.mock('../src/time.js', () => ({
  encoreParts: () => ({ hh: 0, mm: 0, ss: 0, ff: 0 }),
  snapTimeToFrame: value => value,
  fmtClock: value => String(value),
  secToSRT: value => String(value),
  secToASS: value => String(value),
  secToEncore: value => String(value),
  getExactFps: value => value || 25,
}));

vi.mock('../src/subtitles.js', () => ({
  selectCue: vi.fn(),
  selectCueSingle: vi.fn(),
  refreshSelectionUI: vi.fn(),
  renderSubRow: vi.fn(),
  sortCues: vi.fn(),
  sweepContainedCues: vi.fn(),
}));
vi.mock('../src/events.js', () => ({ emit: vi.fn(), on: vi.fn() }));
vi.mock('../src/project.js', () => ({ ensureProjectSaved: vi.fn(), isProjectGuardDone: () => true }));
vi.mock('../src/ui.js', () => ({ showToast: vi.fn(), openModal: vi.fn(), closeModal: vi.fn() }));
vi.mock('../src/keyboard.js', () => ({ jklReset: vi.fn(), nudge: vi.fn() }));
vi.mock('../src/history.js', () => ({ recordHistory: vi.fn() }));
vi.mock('../src/menus.js', () => ({ hideCtx: vi.fn(), showCueMenu: vi.fn() }));
vi.mock('../src/sequence.js', () => ({ Seq: { active: () => false, clipEnd: vi.fn() } }));
vi.mock('../src/tcparse.js', () => ({ parseTimecodeInput: vi.fn(), setupTimecodeInput: vi.fn() }));

describe('timeline-renderer commands and operations', () => {
  it('provides cohesive timeline commands and coordinate operations', async () => {
    document.body.innerHTML = `
      <video id="video"></video>
      <div id="tlScroll"><div id="tlLayer"></div><div id="tlTracks"></div></div>
      <canvas id="rulerCanvas"></canvas>
      <div id="tlVtracks"></div><div id="tlAtracks"></div>
      <div id="tlGutterTracks"></div><div id="tlGutterVtracks"></div><div id="tlGutterAtracks"></div>
      <div id="tlPlayhead"></div><div id="tlInpoint"></div><div id="tlRubber"></div>
    `;
    const layer = document.getElementById('tlLayer');
    layer.getBoundingClientRect = () => ({ top: 10, left: 0, right: 1000, bottom: 400, width: 1000, height: 390 });

    Object.assign(harness.State, {
      cues: [
        { id: 'before', start: 1, end: 3, track: 0 },
        { id: 'after', start: 7, end: 9, track: 0 },
      ],
      tracks: [{}, {}],
      trackCount: 2,
      selectedId: null,
      selectedIds: [],
      clips: [],
      duration: 10,
      fps: 25,
      dropFrame: false,
      pxPerSec: 80,
      viewStart: 0,
      vtracksCollapsed: false,
      videoTracks: [{ name: '視訊軌 1', visible: true, locked: false }],
    });

    const engine = await import('../src/timeline-renderer.js');
    const interaction = await import('../src/timeline-interaction-engine.js');

    const engineOps = [
      'trackFromY', 'addTrack', 'removeTrack', 'moveSelectedToTrack',
      'setZoom', 'zoomFit', 'zoomFitVideo', 'zoomIn', 'zoomOut',
      'toggleZoomFit', 'toggleVideoTracks', 'toggleAllVisibility', 'toggleAllLock',
    ];
    for (const name of engineOps) {
      expect(engine[name]).toBeTypeOf('function');
    }

    expect(engine.trackFromY(35)).toBe(0);
    expect(engine.trackFromY(120)).toBe(1);
    expect(interaction.snapVal(4.9, [0, 5, 10], 0.2)).toBe(5);
    expect(interaction.cueNeighborBounds(4, 6, 0)).toEqual({ prevEnd: 3, nextStart: 7 });
  });

  it('執行縮放與軌道鎖定命令正確變更狀態', async () => {
    document.body.innerHTML = `
      <video id="video"></video>
      <div id="tlScroll"><div id="tlLayer"></div><div id="tlTracks"></div></div>
      <div id="tlSpacer"></div><input id="zoomBar" />
      <canvas id="rulerCanvas"></canvas>
      <div id="tlVtracks"></div><div id="tlAtracks"></div>
      <div id="tlGutterTracks"></div><div id="tlGutterVtracks"></div><div id="tlGutterAtracks"></div>
      <div id="tlPlayhead"></div><div id="tlInpoint"></div><div id="tlRubber"></div>
    `;
    const layer = document.getElementById('tlLayer');
    layer.getBoundingClientRect = () => ({ top: 10, left: 0, right: 1000, bottom: 400, width: 1000, height: 390 });
    const ruler = document.getElementById('rulerCanvas');
    ruler.getContext = () => ({
      save: vi.fn(), scale: vi.fn(), clearRect: vi.fn(), restore: vi.fn(),
      beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
      fillText: vi.fn(), strokeText: vi.fn(), fillRect: vi.fn(),
    });

    const engine = await import('../src/timeline-renderer.js');
    harness.State.pxPerSec = 80;
    engine.zoomIn();
    expect(harness.State.pxPerSec).toBeCloseTo(104, 0);

    engine.zoomOut();
    expect(harness.State.pxPerSec).toBeCloseTo(80, 0);

    engine.toggleVideoTracks();
    expect(harness.State.vtracksCollapsed).toBe(true);

    engine.toggleAllLock();
    expect(harness.State.tracks.every(t => t.locked)).toBe(true);
  });
});
