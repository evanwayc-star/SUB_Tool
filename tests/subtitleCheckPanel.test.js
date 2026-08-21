// @vitest-environment jsdom
import { beforeAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');

vi.mock('../src/dom.js', () => ({
  $: id => document.getElementById(id),
  sublist: document.getElementById('sublist'),
}));
vi.mock('../src/media.js', () => ({ Media: { displayTime: () => 0, seek: vi.fn() }, Wave: {} }));
vi.mock('../src/timeline.js', () => ({
  renderCueBlocks: vi.fn(), updatePlayhead: vi.fn(), refreshTrackGutterActive: vi.fn(),
}));
vi.mock('../src/events.js', () => ({ emit: vi.fn() }));
vi.mock('../src/project.js', () => ({ ensureProjectSaved: vi.fn(), isProjectGuardDone: () => true }));
vi.mock('../src/ui.js', () => ({ showToast: vi.fn(), openModal: vi.fn(), closeModal: vi.fn() }));
vi.mock('../src/history.js', () => ({ recordHistory: vi.fn() }));
vi.mock('../src/menus.js', () => ({ hideCtx: vi.fn(), showCueMenu: vi.fn() }));
vi.mock('../src/keyboard.js', () => ({ jklReset: vi.fn(), nudge: vi.fn() }));
vi.mock('../src/tcparse.js', () => ({ parseTimecodeInput: vi.fn(), setupTimecodeInput: vi.fn() }));
vi.mock('../src/subtitle-text-check.js', () => ({ inspectSubtitleCharacters: () => ({ simplified: [], unsupported: [] }) }));
vi.mock('../src/subtitle-view.js', () => ({ deleteSelectedWithPrompt: vi.fn() }));
vi.mock('../src/subtitle-model.js', () => ({
  detectOverlaps: () => new Set(), sweepContainedCues: vi.fn(), addCue: vi.fn(), addCueRelative: vi.fn(),
  deleteSelectedCues: vi.fn(), deleteCue: vi.fn(), clearSelectedCuesTime: vi.fn(), shiftTextsDown: vi.fn(),
  shiftTextsUp: vi.fn(), sortCues: vi.fn(), copyCues: vi.fn(), pasteCues: vi.fn(), trimTrackSpaces: vi.fn(),
  swapAdjacentCues: vi.fn(), mergeAdjacentCues: vi.fn(), snapAllCuesToFrames: vi.fn(),
  trackLocked: () => false, cueTrackLocked: () => false, splitCue: vi.fn(),
}));
vi.mock('../src/subtitle-search.js', () => ({
  searchSelectAll: vi.fn(), txtHTML: value => String(value ?? ''), isSearchHit: () => false,
  getSearchCountText: () => '', searchUpdate: vi.fn(), searchNav: vi.fn(), searchReplace: vi.fn(),
}));
vi.mock('../src/substyle.js', () => ({
  effStyle: () => ({}), getAllPresets: () => [], STYLE_DEFAULTS: {}, colorName: () => '',
  posToPx: () => ({ x: 0, y: 0 }), styleMatchesPreset: () => false,
}));
vi.mock('../src/time.js', async importOriginal => {
  const original = await importOriginal();
  return { ...original, secToEncore: value => String(value) };
});

let state;
let renderCheckPanel;

beforeAll(async () => {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  document.body.innerHTML = `
    <div id="sublist"></div><span id="stSel"></span>
    <div id="checkPanel" class="show">
      <div id="cpConsecutiveIdentical"><span class="cp-nums"></span></div>
    </div>`;
  state = await import('../src/state.js');
  ({ renderCheckPanel } = await import('../src/subtitles.js'));
});

it('連續相同且頭尾黏接時，這一對的兩個編號都套用深綠 class', () => {
  Object.assign(state.State, {
    fps: 25,
    listTrack: 0,
    cues: [
      { id: 'gap-a', text: '橘色一對', start: 0, end: 1, track: 0, timed: true },
      { id: 'gap-b', text: '橘色一對', start: 1.08, end: 2, track: 0, timed: true },
      { id: 'joined-a', text: '深綠一對', start: 3, end: 4, track: 0, timed: true },
      { id: 'joined-b', text: '深綠一對', start: 4, end: 5, track: 0, timed: true },
    ],
  });

  renderCheckPanel();

  expect([...document.querySelectorAll('#cpConsecutiveIdentical .cp-num')].map(node => ({
    number: Number(node.textContent),
    joined: node.classList.contains('cp-joined-identical'),
  }))).toEqual([
    { number: 1, joined: false },
    { number: 2, joined: false },
    { number: 3, joined: true },
    { number: 4, joined: true },
  ]);
  const [orange, , darkGreen] = document.querySelectorAll('#cpConsecutiveIdentical .cp-num');
  expect(getComputedStyle(darkGreen).color).not.toBe(getComputedStyle(orange).color);
  expect(getComputedStyle(darkGreen).color).toBe('rgb(31, 122, 63)');
});
