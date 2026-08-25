// @vitest-environment jsdom
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../src/dom.js', () => ({
  $: id => document.getElementById(id),
  video: document.getElementById('video'),
  tlScroll: document.getElementById('tlScroll'),
  tlLayer: document.getElementById('tlLayer'),
  tlTracks: document.getElementById('tlTracks'),
  rulerCv: document.getElementById('rulerCanvas'),
  sublist: document.getElementById('sublist'),
  imageLayer: document.getElementById('imageLayer'),
}));
vi.mock('../src/events.js', () => ({ emit: vi.fn(), on: vi.fn() }));
vi.mock('../src/media.js', () => ({
  Media: { displayTime: () => 0, seek: vi.fn(), externalAudio: { list: () => [], get: () => null }, mpvMode: false },
  Wave: {},
}));
vi.mock('../src/timeline.js', () => ({
  renderCueBlocks: vi.fn(), drawTimeline: vi.fn(), updatePlayhead: vi.fn(), refreshTrackGutterActive: vi.fn(),
}));

const project = vi.hoisted(() => ({ guardDone: true, ensureProjectSaved: vi.fn() }));
vi.mock('../src/project.js', () => ({
  ensureProjectSaved: project.ensureProjectSaved,
  isProjectGuardDone: () => project.guardDone,
}));
vi.mock('../src/ui.js', () => ({ showToast: vi.fn(), openModal: vi.fn(), closeModal: vi.fn() }));
vi.mock('../src/history.js', () => ({ recordHistory: vi.fn() }));
vi.mock('../src/menus.js', () => ({ hideCtx: vi.fn(), showCueMenu: vi.fn() }));
vi.mock('../src/keyboard.js', () => ({ jklReset: vi.fn(), nudge: vi.fn() }));
vi.mock('../src/tcparse.js', () => ({ parseTimecodeInput: vi.fn(), setupTimecodeInput: vi.fn() }));
vi.mock('../src/subtitle-text-check.js', () => ({ inspectSubtitleCharacters: () => ({}) }));
vi.mock('../src/subtitle-view.js', () => ({ deleteSelectedWithPrompt: vi.fn() }));
vi.mock('../src/subtitle-analyzer.js', () => ({
  analyzeSubtitles: () => ({
    overlapNums: [], multiNums: [], twoNums: [], blankNums: [], bNums: [], iNums: [], uNums: [],
    fontNums: [], posNums: [], trimNums: [], overLenNums: [], containsNums: [], nonTraditionalIssues: [],
    noTimeNums: [], consecutiveIdenticalNums: [],
  }),
}));
vi.mock('../src/subtitle-model.js', () => ({
  snapAllCuesToFrames: vi.fn(), swapAdjacentCues: vi.fn(), mergeAdjacentCues: vi.fn(),
  detectOverlaps: () => new Set(), sweepContainedCues: vi.fn(), addCue: vi.fn(), addCueRelative: vi.fn(),
  deleteSelectedCues: vi.fn(), deleteCue: vi.fn(), clearSelectedCuesTime: vi.fn(), shiftTextsDown: vi.fn(),
  shiftTextsUp: vi.fn(), sortCues: vi.fn(), copyCues: vi.fn(), pasteCues: vi.fn(), trimTrackSpaces: vi.fn(),
  trackLocked: (tk) => !!state?.State?.tracks?.[tk]?.locked,
  cueTrackLocked: (c) => !!state?.State?.tracks?.[c?.track || 0]?.locked,
  splitCue: vi.fn(),
}));
vi.mock('../src/subtitle-search.js', () => ({
  searchSelectAll: vi.fn(), txtHTML: value => String(value ?? ''), isSearchHit: () => false,
  getSearchCountText: () => '', searchUpdate: vi.fn(), searchNav: vi.fn(), searchReplace: vi.fn(),
}));

const defaultStyle = {
  fontSize: 60, bold: false, italic: false, valign: 'bottom', align: 'center', vertical: false,
  color: '#ffffff', font: 'sans-serif', posX: 50, posY: 90, angle: 0, letterSpacing: 0,
  lineSpacing: 0, outlineColor: '#000000', outline: 2, shadow: 0, bgColor: '#000000',
  bgAlpha: 0, bgBox: false,
};
vi.mock('../src/substyle.js', () => ({
  effStyle: cue => ({ ...defaultStyle, ...(cue?.style || {}) }),
  getAllPresets: () => [], STYLE_DEFAULTS: defaultStyle, colorName: () => '',
  posToPx: style => ({ x: Math.round(style.posX), y: Math.round(style.posY) }), styleMatchesPreset: () => false,
}));
vi.mock('../src/time.js', () => ({
  secToEncore: value => String(value), snapTimeToFrame: value => value,
  encoreParts: () => ({ hh: 0, mm: 0, ss: 0, ff: 0 }), fmtClock: String,
  secToSRT: String, secToASS: String, getExactFps: value => value || 25,
}));
vi.mock('../src/painters/clip-painter.js', () => ({ paintClipBlocks: vi.fn() }));
vi.mock('../src/painters/subtitle-painter.js', () => ({ paintSubtitleBlocks: vi.fn() }));
vi.mock('../src/painters/waveform-painter.js', () => ({ paintClipWave: vi.fn() }));
vi.mock('../src/timeline-edit-transaction.js', () => ({ beginTimelineTrackEdit: vi.fn(), updateTimelineTrack: vi.fn() }));
vi.mock('../src/timeline-gesture-transaction.js', () => ({
  beginTimelineGesture: () => ({ markMoved: vi.fn(), addCancelEffect: vi.fn(), commit: vi.fn(), cancel: vi.fn() }),
}));
vi.mock('../src/sequence.js', () => ({
  Seq: { active: () => false, byId: vi.fn(), neighborBounds: vi.fn(), clipEnd: vi.fn(), snapEdges: () => [] },
}));
vi.mock('../src/timeline-interaction.js', () => ({
  timeToX: value => value * 80, xToTime: value => value / 80, snapTargets: () => [],
  snapVal: value => value, cueNeighborBounds: () => ({ prevEnd: -Infinity, nextStart: Infinity }),
}));
vi.mock('../src/style-assignment.js', () => ({ planCueStyleAssignment: ({ cue }) => ({ style: cue.style }) }));
vi.mock('../src/clip-model.js', () => ({ selectClip: vi.fn(), clearClipSelection: vi.fn() }));

function mount() {
  Element.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = `
    <video id="video"></video><div id="imageLayer"></div>
    <select id="listTrackSel"></select><span id="subCount"></span><span id="stSel"></span>
    <div id="sublist"></div><div id="checkPanel"></div>
    <div id="tlScroll"><div id="tlSpacer"></div><div id="tlLayer"><canvas id="rulerCanvas"></canvas>
      <div id="tlVtracks"></div><div id="tlAtracks"></div>
      <div id="tlTracks">
        <div class="tl-track" data-track="0"><div class="cue-block" data-id="a"><i>A</i></div></div>
        <div class="tl-track" data-track="1"><div class="cue-block" data-id="b"><i>B</i></div></div>
      </div>
      <div id="tlPlayhead"></div><div id="tlInpoint"></div><div id="tlRubber"></div><div id="tlSnapGuide"></div>
    </div></div>
    <div id="tlGutterTracks"></div><div id="tlGutterVtracks"></div><div id="tlGutterAtracks"></div>`;
  document.getElementById('tlLayer').getBoundingClientRect = () => (
    { top: 0, left: 0, right: 1000, bottom: 400, width: 1000, height: 400 }
  );
}

function pressBlock(block, { ctrlKey = false, shiftKey = false, altKey = false } = {}) {
  block.dispatchEvent(new MouseEvent('mousedown', {
    bubbles: true, button: 0, detail: 1, clientX: 260, clientY: 120, ctrlKey, shiftKey, altKey,
  }));
}

function releaseBlock({ clientX = 260, clientY = 120, ctrlKey = false, shiftKey = false, altKey = false } = {}) {
  window.dispatchEvent(new MouseEvent('mouseup', {
    bubbles: true, button: 0, detail: 1, clientX, clientY, ctrlKey, shiftKey, altKey,
  }));
}

function clickBlock(block, options = {}) {
  pressBlock(block, options);
  releaseBlock(options);
}

function dragBlock(block, { dx = 80, dy = 0 } = {}) {
  pressBlock(block);
  window.dispatchEvent(new MouseEvent('mousemove', {
    bubbles: true, button: 0, detail: 1, clientX: 260 + dx, clientY: 120 + dy,
  }));
  releaseBlock({ clientX: 260 + dx, clientY: 120 + dy });
}

let state;
let subtitles;
let blockB;

function resetScenario() {
  Object.assign(state.State, {
    tracks: [{ name: 'T0', visible: true, locked: false }, { name: 'T1', visible: true, locked: false }],
    trackCount: 2,
    cues: [
      { id: 'a', text: 'A', start: 1, end: 2, track: 0, timed: true },
      { id: 'b', text: 'B', start: 3, end: 4, track: 1, timed: true },
    ],
    listTrack: 0, selectedId: null, selectedIds: [], activeTrackKind: 'sub', activeEdge: 'start',
    duration: 10, fps: 25, dropFrame: false, pxPerSec: 80, viewStart: 0, overwriteMode: false,
  });
  subtitles.renderSubList();
  for(const block of document.querySelectorAll('.cue-block')) block.removeAttribute('style');
}

function makeCrossTrackSelection() {
  subtitles.selectCue('a');
  clickBlock(blockB, { ctrlKey: true });
  expect({
    listTrack: state.State.listTrack,
    selectedId: state.State.selectedId,
    selectedIds: [...state.State.selectedIds],
  }).toEqual({ listTrack: 0, selectedId: 'b', selectedIds: ['a', 'b'] });
}

beforeAll(async () => {
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.requestAnimationFrame = vi.fn(() => 1);
  globalThis.cancelAnimationFrame = vi.fn();
  mount();
  document.getElementById('tlScroll').getBoundingClientRect = () => (
    { top: 0, left: 0, right: 1000, bottom: 400, width: 1000, height: 400 }
  );
  state = await import('../src/state.js');
  subtitles = await import('../src/subtitles.js');
  await import('../src/timeline-renderer.js');
  blockB = document.querySelector('.cue-block[data-id="b"]');
});

beforeEach(() => {
  vi.clearAllMocks();
  project.guardDone = true;
  resetScenario();
});

it('未辨識句保留原編號並在列表顯示雙重無時間碼', () => {
  state.State.cues = [
    { id: 'line-1', text: '第一句', start: 1, end: 2, track: 0, timed: true },
    { id: 'line-2', text: '無法辨識句', start: 0, end: 0, track: 0, timed: false },
    { id: 'line-3', text: '第三句', start: 3, end: 4, track: 0, timed: true },
  ];

  subtitles.renderSubList();

  const rows = [...document.querySelectorAll('.sub-row')];
  expect(rows.map(row => row.querySelector('.idx').textContent)).toEqual(['1', '2', '3']);
  expect(rows.map(row => row.querySelector('.txt').textContent)).toEqual(['第一句', '無法辨識句', '第三句']);
  expect(rows[1].classList.contains('no-time')).toBe(true);
  expect(rows[1].querySelector('.times').textContent.replace(/\s+/g, ' ').trim())
    .toBe('--:--:--:-- → --:--:--:--');
});

it('第一次點字幕會先顯示選取，再開啟專案儲存守衛', () => {
  project.guardDone = false;

  pressBlock(blockB);

  expect(project.ensureProjectSaved).toHaveBeenCalledOnce();
  expect({
    listTrack: state.State.listTrack,
    selectedId: state.State.selectedId,
    selectedIds: [...state.State.selectedIds],
  }).toEqual({ listTrack: 1, selectedId: 'b', selectedIds: ['b'] });
});

it('普通點跨軌多選中的字幕，會在 mouseup 切換列表並收斂成該句單選', () => {
  makeCrossTrackSelection();

  pressBlock(blockB);
  expect({
    listTrack: state.State.listTrack,
    selectedId: state.State.selectedId,
    selectedIds: [...state.State.selectedIds],
  }).toEqual({ listTrack: 0, selectedId: 'b', selectedIds: ['a', 'b'] });

  releaseBlock();

  expect({
    listTrack: state.State.listTrack,
    selectedId: state.State.selectedId,
    selectedIds: [...state.State.selectedIds],
    visibleRows: [...document.querySelectorAll('.sub-row')].map(row => ({
      id: row.dataset.id, yellow: row.classList.contains('sel'), primary: row.classList.contains('primary'),
    })),
  }).toEqual({
    listTrack: 1, selectedId: 'b', selectedIds: ['b'],
    visibleRows: [{ id: 'b', yellow: true, primary: true }],
  });
});

it('普通點已選字幕，仍會把該列捲入字幕列表可視範圍', () => {
  subtitles.selectCue('b');
  Element.prototype.scrollIntoView.mockClear();
  requestAnimationFrame.mockClear();

  clickBlock(blockB);

  const selectedRow = document.querySelector('.sub-row[data-id="b"]');
  expect({
    selectedId: state.State.selectedId,
    yellow: selectedRow.classList.contains('sel'),
    primary: selectedRow.classList.contains('primary'),
  }).toEqual({ selectedId: 'b', yellow: true, primary: true });
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  expect(Element.prototype.scrollIntoView.mock.instances).toContain(selectedRow);
  expect(requestAnimationFrame).toHaveBeenCalledOnce();

  const revealAfterLayout = requestAnimationFrame.mock.calls[0][0];
  Element.prototype.scrollIntoView.mockClear();
  revealAfterLayout();
  expect(Element.prototype.scrollIntoView.mock.instances).toContain(selectedRow);
});

it('後續 preventScroll 會取消同一句字幕尚未執行的延後揭示', () => {
  subtitles.selectCue('b');
  expect(requestAnimationFrame).toHaveBeenCalledOnce();
  const staleReveal = requestAnimationFrame.mock.calls[0][0];

  subtitles.selectCue('b', { preventScroll: true });
  Element.prototype.scrollIntoView.mockClear();
  staleReveal();

  expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
});

it('普通拖曳跨軌多選中的字幕，會保留群組並讓全部字幕一起移動', () => {
  makeCrossTrackSelection();

  dragBlock(blockB);

  expect({
    listTrack: state.State.listTrack,
    selectedId: state.State.selectedId,
    selectedIds: [...state.State.selectedIds],
    cues: state.State.cues.map(cue => ({
      id: cue.id, start: cue.start, end: cue.end, track: cue.track,
    })),
  }).toEqual({
    listTrack: 0,
    selectedId: 'b',
    selectedIds: ['a', 'b'],
    cues: [
      { id: 'a', start: 2, end: 3, track: 0 },
      { id: 'b', start: 4, end: 5, track: 1 },
    ],
  });
});

it('選取字幕時狀態列格式為「已選取 N 句 · [軌道名稱] - #編號」', () => {
  subtitles.selectCue('a');
  const stSel = document.getElementById('stSel');
  expect(stSel.textContent).toBe('已選取 1 句 · [T0] - #1');
  expect(stSel.innerHTML).toContain('<span class="sel-track-name">[T0]</span>');
  expect(stSel.innerHTML).toContain('<span class="sel-cue-idx">#1</span>');

  subtitles.selectCue('b');
  expect(stSel.textContent).toBe('已選取 1 句 · [T1] - #1');
  expect(stSel.innerHTML).toContain('<span class="sel-track-name">[T1]</span>');
  expect(stSel.innerHTML).toContain('<span class="sel-cue-idx">#1</span>');

  makeCrossTrackSelection();
  expect(stSel.textContent).toBe('已選取 2 句 · [T1] - #1');
});


it('拖曳字幕時不可移入已鎖定的軌道', () => {
  state.State.tracks[1].locked = true;
  const blockA = document.querySelector('.cue-block[data-id="a"]');
  // 嘗試將 track 0 的 a 拖曳至 track 1（dy = 50px）
  dragBlock(blockA, { dx: 0, dy: 50 });
  const cueA = state.State.cues.find(c => c.id === 'a');
  expect(cueA.track).toBe(0); // 仍維持在 track 0，未被移入 track 1
});

it('moveSelectedToTrack 嘗試移動字幕至鎖定軌道時被擋下', async () => {
  const { moveSelectedToTrack } = await import('../src/timeline-renderer.js');
  state.State.tracks[1].locked = true;
  state.State.selectedId = 'a';
  state.State.selectedIds = ['a'];
  moveSelectedToTrack(1);
  const cueA = state.State.cues.find(c => c.id === 'a');
  expect(cueA.track).toBe(0);
});
