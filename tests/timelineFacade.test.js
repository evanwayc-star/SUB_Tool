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

vi.mock('../src/dom.js', () => ({
  $: id => document.getElementById(id),
  video: document.getElementById('video'),
  tlScroll: document.getElementById('tlScroll'),
  tlLayer: document.getElementById('tlLayer'),
  tlTracks: document.getElementById('tlTracks'),
  rulerCv: document.getElementById('rulerCanvas'),
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
    getExternalAudioSources: () => [],
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
  refreshSelectionUI: vi.fn(),
  renderSubRow: vi.fn(),
  sortCues: vi.fn(),
  sweepContainedCues: vi.fn(),
}));
vi.mock('../src/events.js', () => ({ emit: vi.fn() }));
vi.mock('../src/project.js', () => ({ ensureProjectSaved: vi.fn(), isProjectGuardDone: () => true }));
vi.mock('../src/ui.js', () => ({ showToast: vi.fn(), openModal: vi.fn(), closeModal: vi.fn() }));
vi.mock('../src/keyboard.js', () => ({ jklReset: vi.fn(), nudge: vi.fn() }));
vi.mock('../src/history.js', () => ({ recordHistory: vi.fn() }));
vi.mock('../src/menus.js', () => ({ hideCtx: vi.fn(), showCueMenu: vi.fn() }));
vi.mock('../src/sequence.js', () => ({ Seq: { active: () => false, clipEnd: vi.fn() } }));
vi.mock('../src/tcparse.js', () => ({ parseTimecodeInput: vi.fn(), setupTimecodeInput: vi.fn() }));

describe('timeline public facade', () => {
  it('re-exports one cohesive timeline engine for rendering and timeline operations', async () => {
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
    const timeline = await import('../src/timeline.js');

    const operations = [
      'trackFromY', 'addTrack', 'removeTrack', 'moveSelectedToTrack',
      'setZoom', 'zoomFit', 'zoomFitVideo', 'snapTargets', 'snapVal', 'neighborBounds',
    ];
    for (const name of operations) {
      expect(engine[name]).toBeTypeOf('function');
      expect(timeline[name]).toBe(engine[name]);
    }

    expect(engine.trackFromY(35)).toBe(0);
    expect(engine.trackFromY(120)).toBe(1);
    expect(engine.snapVal(4.9, [0, 5, 10], 0.2)).toBe(5);
    expect(engine.neighborBounds(4, 6, 0)).toEqual({ prevEnd: 3, nextStart: 7 });
  });

  /* 接縫的寬度是一個決定，不是副作用。timeline.js 從 `export *` 改成逐一列名，
     就是為了讓「在 timeline-renderer.js 加一個 export」不再等於「全專案多一個
     可見名稱」。這條把清單釘住：要拓寬接縫，這個陣列也得一起改，diff 看得見。

     不是為了湊測試數字——`export *` 時期這條測不出東西，因為清單就是實作本身。 */
  it('對外名稱是一份明確清單，不會因為繪製模組多 export 就自動變寬', async () => {
    const timeline = await import('../src/timeline.js');
    expect(Object.keys(timeline).sort()).toEqual([
      'ROW_H', 'RULER_H',
      'addTrack', 'clearClipSelection', 'closeClipGapLeft',
      'deleteSelectedClip', 'drawRuler', 'drawTimeline', 'drawWave',
      'fmtTick', 'layoutTimeline', 'moveSelectedToTrack', 'neighborBounds',
      'niceStep', 'refreshTrackGutterActive', 'removeTrack', 'renderCueBlocks',
      'renderTrackRows', 'selectClip', 'setZoom', 'showClipFade',
      'showCrossfade', 'showImageGeom', 'snapTargets', 'snapVal',
      'timeToX', 'trackFromY', 'tracksScrollTop', 'tracksTop',
      'updatePlayhead', 'viewportW', 'xToTime', 'zoomFit', 'zoomFitVideo',
    ]);
  });

  /* 只在繪製模組內部用到的名稱不該出現在接縫上；死碼更不該。 */
  it('內部度量與已移除的死碼都不在接縫上', async () => {
    const timeline = await import('../src/timeline.js');
    for (const name of ['yToTrack', 'tlTotal', 'redrawTimeline', 'navigateClip']) {
      expect(timeline[name], `${name} 不應該還在 timeline.js 的對外清單裡`).toBeUndefined();
    }
  });
});
