// @vitest-environment jsdom
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';

const mediaMocks = vi.hoisted(() => ({
  externalAudioList: [],
  externalAudioById: new Map(),
}));

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
  Media: {
    displayTime: () => 0,
    seek: vi.fn(),
    externalAudio: {
      list: () => mediaMocks.externalAudioList,
      get: id => mediaMocks.externalAudioById.get(id) || null,
    },
    mpvMode: false
  },
  Wave: {},
}));

vi.mock('../src/timeline-renderer.js', async importOriginal => ({
  ...(await importOriginal()),
  renderCueBlocks: vi.fn(),
}));


const project = vi.hoisted(() => ({ guardDone: true, ensureProjectSaved: vi.fn() }));
vi.mock('../src/project.js', () => ({
  Project: { captureWorkspaceOwnership:()=>()=>true },
  ensureProjectSaved: project.ensureProjectSaved,
  isProjectGuardDone: () => project.guardDone,
}));
vi.mock('../src/ui.js', () => ({ showToast: vi.fn(), openModal: vi.fn(), closeModal: vi.fn() }));
vi.mock('../src/history.js', () => ({
  recordHistory: vi.fn(),
  History: {
    beginPreview: vi.fn(() => {
      let active=true;
      const release=()=>{active=false;};
      release.isCurrent=()=>active;
      release.addTarget=vi.fn();
      return release;
    }),
  },
}));
vi.mock('../src/menus.js', () => ({ hideCtx: vi.fn(), showCueMenu: vi.fn() }));
vi.mock('../src/keyboard.js', () => ({ jklReset: vi.fn(), nudge: vi.fn() }));
vi.mock('../src/tcparse.js', () => ({ parseTimecodeInput: vi.fn(), setupTimecodeInput: vi.fn() }));
vi.mock('../src/subtitle-text-check.js', () => ({ inspectSubtitleCharacters: () => ({}) }));
vi.mock('../src/subtitle-audit.js', () => ({
  analyzeSubtitles: () => ({
    overlapNums: [], multiNums: [], twoNums: [], blankNums: [], bNums: [], iNums: [], uNums: [],
    fontNums: [], posNums: [], trimNums: [], overLenNums: [], containsNums: [], nonTraditionalIssues: [],
    noTimeNums: [], consecutiveIdenticalNums: [],
  }),
}));
vi.mock('../src/subtitle-model.js', async importOriginal => ({
  ...(await importOriginal()),
  snapAllCuesToFrames: vi.fn(), swapAdjacentCues: vi.fn(), mergeAdjacentCues: vi.fn(),
  detectOverlaps: () => new Set(), sweepContainedCues: vi.fn(), addCue: vi.fn(), addCueRelative: vi.fn(),
  deleteSelectedCues: vi.fn(), deleteCue: vi.fn(), clearSelectedCuesTime: vi.fn(), shiftTextsDown: vi.fn(),
  shiftTextsUp: vi.fn(), sortCues: vi.fn(), copyCues: vi.fn(), pasteCues: vi.fn(), trimTrackSpaces: vi.fn(),
  trackLocked: (tk) => !!state?.State?.tracks?.[tk]?.locked,
  cueTrackLocked: (c) => !!state?.State?.tracks?.[c?.track || 0]?.locked,
  splitCue: vi.fn(),
}));
vi.mock('../src/time.js', () => ({
  secToEncore: value => String(value), snapTimeToFrame: value => value,
  encoreParts: () => ({ hh: 0, mm: 0, ss: 0, ff: 0 }), fmtClock: String,
  secToSRT: String, secToASS: String, getExactFps: value => value || 25,
}));
vi.mock('../src/timeline-edit-transaction.js', async importOriginal => ({
  ...(await importOriginal()),
  beginTimelineTrackEdit: vi.fn(),
  updateTimelineTrack: vi.fn(),
}));
vi.mock('../src/sequence.js', () => ({
  Seq: { active: vi.fn(() => false), byId: vi.fn(), neighborBounds: vi.fn(), clipEnd: vi.fn(), snapEdges: () => [] },
}));
vi.mock('../src/timeline-interaction-engine.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    timeToX: value => value * 80, xToTime: value => value / 80, snapTargets: () => [],
    snapVal: value => value, cueNeighborBounds: () => ({ prevEnd: -Infinity, nextStart: Infinity }),
  };
});
vi.mock('../src/subtitle-style-engine.js', () => ({ planCueStyleAssignment: ({ cue }) => ({ style: cue.style }) }));

function mount() {
  Element.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = `
    <video id="video"></video><div id="imageLayer"></div>
    <select id="listTrackSel"></select><span id="subCount"></span><span id="stSel"></span>
    <select id="subStyleFilter"></select><div id="sublist"></div><div id="checkPanel"></div>
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
let timelineRenderer;
let sequence;
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
    videoTracks: [{ name: 'V1', visible: true, locked: false }], clips: [],
    selectedClipId: null, selectedAudioClipId: null,
    duration: 10, fps: 25, dropFrame: false, pxPerSec: 80, viewStart: 0, overwriteMode: false,
  });
  document.getElementById('subStyleFilter').value='';
  subtitles.renderSubList();
  for(const block of document.querySelectorAll('.cue-block')) block.removeAttribute('style');
}

beforeAll(async () => {
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.requestAnimationFrame = vi.fn(() => 1);
  globalThis.cancelAnimationFrame = vi.fn();
  mount();
  Object.defineProperty(document.getElementById('tlScroll'),'clientWidth',{configurable:true,value:1000});
  Object.defineProperty(document.getElementById('tlLayer'),'clientHeight',{configurable:true,value:400});
  document.getElementById('tlScroll').getBoundingClientRect = () => (
    { top: 0, left: 0, right: 1000, bottom: 400, width: 1000, height: 400 }
  );
  state = await import('../src/state.js');
  subtitles = await import('../src/subtitles.js');
  timelineRenderer = await import('../src/timeline-renderer.js');
  sequence = await import('../src/sequence.js');
  blockB = document.querySelector('.cue-block[data-id="b"]');
});

beforeEach(() => {
  vi.clearAllMocks();
  mediaMocks.externalAudioList.length = 0;
  mediaMocks.externalAudioById.clear();
  project.guardDone = true;
  resetScenario();
  sequence.Seq.active.mockReturnValue(false);
  sequence.Seq.byId.mockReturnValue(null);
  sequence.Seq.clipEnd.mockImplementation(c => c.offset + (c.out - c.in));
});

const snapshot=()=>({primary:state.State.selectedId,ids:[...state.State.selectedIds],kind:state.State.activeTrackKind});
const listPress=(id,opts={})=>document.querySelector(`.sub-row[data-id="${id}"] .txt`).dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,...opts}));
it('list Shift range stays in visible subtitle track rather than selecting interleaved foreign-track cue',()=>{
 state.State.cues=[{id:'a',text:'A',start:1,end:2,track:0,timed:true},{id:'foreign',text:'X',start:2,end:3,track:1,timed:true},{id:'c',text:'C',start:3,end:4,track:0,timed:true}];
 subtitles.renderSubList();listPress('a');listPress('c',{shiftKey:true});
 expect(snapshot()).toEqual({primary:'a',ids:['a','c'],kind:'sub'});
});
it('list click on locked subtitle preserves existing video selection',()=>{
 state.State.tracks[1].locked=true;state.State.listTrack=1;subtitles.renderSubList();state.setSelection({kind:'video',ids:'retained-video'});
 listPress('b');expect(state.State.selectedClipId).toBe('retained-video');expect(state.State.selectedIds).toEqual([]);
});
it('locked list cue permits pointer positioning without becoming selected',async()=>{
 const {Media}=await import('../src/media.js');
 state.State.tracks[1].locked=true;state.State.listTrack=1;subtitles.renderSubList();state.setSelection({kind:'video',ids:'retained-video'});
 listPress('b');expect(Media.seek).toHaveBeenCalledWith(3);expect(state.State.selectedClipId).toBe('retained-video');
});
it('timeline click on locked subtitle preserves existing video selection',()=>{
 state.State.tracks[1].locked=true;state.setSelection({kind:'video',ids:'retained-video'});
 clickBlock(blockB);expect(state.State.selectedClipId).toBe('retained-video');expect(state.State.selectedIds).toEqual([]);
});
it('timeline Ctrl click on locked selected cue cannot collapse original multi-selection',()=>{
 state.setSelection({kind:'sub',ids:['a','b'],primary:'a'});state.State.tracks[1].locked=true;
 clickBlock(blockB,{ctrlKey:true});expect(snapshot()).toEqual({primary:'a',ids:['a','b'],kind:'sub'});
});
it('programmatic selectCue never selects a non-existent ID',()=>{
 subtitles.selectCue('a');subtitles.selectCue('gone',{seek:false});expect(snapshot()).toEqual({primary:'a',ids:['a'],kind:'sub'});
});
it('explicit null selection clears subtitles when transport leaves the last cue',()=>{
 subtitles.selectCue('a');subtitles.selectCueSingle(null);
 expect(snapshot().ids).toEqual([]);expect(snapshot().primary).toBeNull();
 state.setSelection({kind:'video',ids:'retained-video'});subtitles.selectCueSingle(null);
 expect(state.State.selectedClipId).toBe('retained-video');
});
it('explicit null selection still closes the temporary end of an unlocked cue',()=>{
 const cue=state.State.cues[0];cue._tempEnd=true;cue.end=10;
 subtitles.selectCue('a');subtitles.selectCueSingle(null);
 expect(cue.end).toBe(3);expect(cue._tempEnd).toBeUndefined();expect(snapshot().ids).toEqual([]);
});
it('selecting another cue cannot finalize a temporary end on a locked track',()=>{
 const locked=state.State.cues[1];locked._tempEnd=true;locked.end=10;state.State.tracks[1].locked=true;
 subtitles.selectCue('a');
 expect(locked.end).toBe(10);expect(locked._tempEnd).toBe(true);
});
it('locked subtitle permits pointer seeking and scrubbing without replacing selection',async()=>{
 const {Media}=await import('../src/media.js');
 state.State.tracks[1].locked=true;state.setSelection({kind:'video',ids:'retained-video'});
 dragBlock(blockB);
 expect(Media.seek).toHaveBeenCalledWith(260/80);
 expect(Media.seek.mock.calls.at(-1)[0]).toBe(340/80);
 expect(state.State.selectedClipId).toBe('retained-video');expect(state.State.cues[1].start).toBe(3);
});
it('search-selected cue is visibly present when style filter hid that match',()=>{
 state.State.cues=[{id:'a',text:'normal',start:1,end:2,track:0,timed:true},{id:'custom',text:'custom match',start:3,end:4,track:0,timed:true,style:{fontSize:120}}];
 subtitles.renderSubList();const filter=document.getElementById('subStyleFilter');filter.value='預設';subtitles.renderSubList();
 expect(document.querySelector('.sub-row[data-id="custom"]')).toBeNull();
 subtitles.searchUpdate('custom match');subtitles.renderSubList();
 expect(state.State.selectedId).toBe('custom');expect(document.querySelector('.sub-row[data-id="custom"]')).not.toBeNull();
});
it('select all search matches reveals every selected cue even when the primary was already visible',()=>{
 state.State.cues=[{id:'a',text:'match A',start:1,end:2,track:0,timed:true,style:{fontSize:120}},{id:'b',text:'match B',start:3,end:4,track:0,timed:true}];
 subtitles.renderSubList();document.getElementById('subStyleFilter').value='預設';subtitles.renderSubList();
 subtitles.selectCue('b');subtitles.searchUpdate('match');subtitles.searchSelectAll();subtitles.refreshSelectionUI();
 expect(snapshot().ids).toEqual(['a','b']);
 expect([...document.querySelectorAll('.sub-row.sel')].map(row=>row.dataset.id)).toEqual(['a','b']);
});
it('style-filtered list Shift cannot silently include a filtered-out cue',()=>{
 state.State.cues=[{id:'a',text:'A',start:1,end:2,track:0,timed:true,style:{fontSize:120}},{id:'hidden',text:'hidden default',start:2,end:3,track:0,timed:true},{id:'c',text:'C',start:3,end:4,track:0,timed:true,style:{fontSize:120}}];
 subtitles.renderSubList();document.getElementById('subStyleFilter').value='__non_default';subtitles.renderSubList();expect([...document.querySelectorAll('.sub-row')].map(r=>r.dataset.id)).toEqual(['a','c']);
 listPress('a');listPress('c',{shiftKey:true});expect(snapshot()).toEqual({primary:'a',ids:['a','c'],kind:'sub'});
});
it('timeline rubber-band excludes locked subtitle track while selecting unlocked track',()=>{
 state.State.tracks[1].locked=true;const top=timelineRenderer.tracksTop();const layer=document.getElementById('tlLayer');
 layer.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:50,clientY:top+5}));
 window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,button:0,buttons:1,clientX:350,clientY:top+120}));
 window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0,clientX:350,clientY:top+120}));
 expect(snapshot().ids).toEqual(['a']);
});
it('searchUpdate on locked track does not replace existing video selection',()=>{
 state.State.listTrack=1;state.State.tracks[1].locked=true;state.setSelection({kind:'video',ids:'retained-video'});
 subtitles.searchUpdate('B');expect(state.State.selectedClipId).toBe('retained-video');expect(state.State.selectedIds).toEqual([]);
});
it('searchSelectAll on locked track does not replace existing video selection',async()=>{
 state.State.listTrack=1;state.State.tracks[1].locked=true;state.setSelection({kind:'video',ids:'retained-video'});
 subtitles.searchUpdate('B');state.setSelection({kind:'video',ids:'retained-video'});const search=await import('../src/subtitle-search.js');
 search.searchSelectAll();expect(state.State.selectedClipId).toBe('retained-video');expect(state.State.selectedIds).toEqual([]);
});
it('public State selection keeps type exclusivity and pruning of deleted IDs',()=>{
 state.setSelection({kind:'video',ids:'retained-video'});state.setSelection({kind:'sub',ids:['a','deleted','b'],primary:'deleted'});state.pruneSelection();
 expect(snapshot()).toEqual({primary:'a',ids:['a','b'],kind:'sub'});expect(state.State.selectedClipId).toBeNull();
});
it('Ctrl and Shift timeline anchors retain existing additive/range contract',()=>{
 state.State.cues=[{id:'a',text:'A',start:1,end:2,track:0,timed:true},{id:'b',text:'B',start:3,end:4,track:0,timed:true},{id:'c',text:'C',start:5,end:6,track:0,timed:true}];
 document.getElementById('tlTracks').innerHTML='<div class="tl-track" data-track="0"><div class="cue-block" data-id="a"></div><div class="cue-block" data-id="b"></div><div class="cue-block" data-id="c"></div></div>';
 subtitles.selectCue('a');clickBlock(document.querySelector('.cue-block[data-id="b"]'),{ctrlKey:true});expect(snapshot().ids).toEqual(['a','b']);expect(snapshot().primary).toBe('b');
 clickBlock(document.querySelector('.cue-block[data-id="c"]'),{shiftKey:true});expect(snapshot()).toEqual({primary:'b',ids:['b','c'],kind:'sub'});
});
