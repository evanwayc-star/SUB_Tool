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
vi.mock('../src/timeline-renderer.js', () => ({
  renderCueBlocks: vi.fn(), updatePlayhead: vi.fn(), refreshTrackGutterActive: vi.fn(),
}));
vi.mock('../src/events.js', () => ({ emit: vi.fn() }));
vi.mock('../src/project.js', () => ({ ensureProjectSaved: vi.fn(), isProjectGuardDone: () => true }));
vi.mock('../src/ui.js', () => ({renderCurrentTimecode:vi.fn(), showToast: vi.fn(), openModal: vi.fn(), closeModal: vi.fn() }));
vi.mock('../src/history.js', () => ({ recordHistory: vi.fn() }));
vi.mock('../src/menus.js', () => ({ hideCtx: vi.fn(), showCueMenu: vi.fn() }));
vi.mock('../src/keyboard.js', () => ({ jklReset: vi.fn(), nudge: vi.fn() }));
vi.mock('../src/tcparse.js', () => ({ parseTimecodeInput: vi.fn(), setupTimecodeInput: vi.fn() }));
vi.mock('../src/subtitle-text-check.js', () => ({ inspectSubtitleCharacters: () => ({ simplified: [], unsupported: [] }) }));
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
  setSelectCueHandler: vi.fn(), getSelectCueHandler: vi.fn(), searchNext: vi.fn(), searchPrev: vi.fn(),
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
let renderCheckPanel,renderSubList,renderSubRow;

beforeAll(async () => {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  document.body.innerHTML = `
    <div id="sublist"></div><span id="subCount"></span><span id="stSel"></span>
    <div id="checkPanel" class="show">
      <p id="checkSummary"></p>
      <div id="cpConsecutiveIdentical"><span class="cp-nums"></span></div>
    </div>`;
  state = await import('../src/state.js');
  ({ renderCheckPanel,renderSubList,renderSubRow } = await import('../src/subtitles.js'));
});

it('同文按組著色，頭尾黏接另保留提示而不覆蓋群組色', () => {
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
  expect(orange.tagName).toBe('BUTTON');
  expect(orange.getAttribute('type')).toBe('button');
  expect(orange.getAttribute('aria-label')).toBe('前往第 1 句字幕');
  expect(getComputedStyle(darkGreen).color).not.toBe(getComputedStyle(orange).color);
  expect(getComputedStyle(darkGreen).color).toBe('rgb(74, 222, 128)');
  expect(darkGreen.title).toContain('頭尾黏接');
});

it('同文群組紅綠藍循環，三句一組保持同色，列表色標不改字幕樣式且編輯後更新鄰列',()=>{
  const texts=['甲','甲','單句','乙','乙','乙','丙','丙','甲','甲'];
  const cues=texts.map((text,index)=>({id:'group-'+index,text,start:index,end:index+1,track:0,timed:true}));
  Object.assign(state.State,{fps:25,listTrack:0,tracks:[{name:'字幕',visible:true}],cues});
  const before=structuredClone(cues);
  renderSubList();
  const buttons=[...document.querySelectorAll('#cpConsecutiveIdentical .cp-num')];
  expect(buttons.map(button=>getComputedStyle(button).color)).toEqual([
    'rgb(248, 113, 113)','rgb(248, 113, 113)',
    'rgb(74, 222, 128)','rgb(74, 222, 128)','rgb(74, 222, 128)',
    'rgb(96, 165, 250)','rgb(96, 165, 250)',
    'rgb(248, 113, 113)','rgb(248, 113, 113)',
  ]);
  expect(buttons.map(button=>Number(button.dataset.identicalGroup))).toEqual([1,1,2,2,2,3,3,4,4]);
  const rows=[...document.querySelectorAll('.sub-row')];
  expect(getComputedStyle(rows[0].querySelector('.idx')).color).toBe('rgb(248, 113, 113)');
  expect(getComputedStyle(rows[3].querySelector('.idx')).color).toBe('rgb(74, 222, 128)');
  expect(getComputedStyle(rows[6].querySelector('.idx')).color).toBe('rgb(96, 165, 250)');
  expect(rows[2].className).not.toContain('identical-group-');
  expect(cues).toEqual(before);
  cues[1].text='改成不同';renderSubRow(cues[1].id);
  expect(rows[0].className).not.toContain('identical-group-');
  expect(rows[1].className).not.toContain('identical-group-');
  expect(getComputedStyle(rows[3].querySelector('.idx')).color).toBe('rgb(248, 113, 113)');
});

it('空軌明確提示尚無字幕，已檢查而無命中顯示無', () => {
  Object.assign(state.State,{tracks:[{name:'中文字幕'}],listTrack:0,cues:[]});
  renderCheckPanel();
  expect(document.getElementById('checkSummary').textContent).toContain('中文字幕尚無字幕');
  expect(document.querySelector('#cpConsecutiveIdentical .cp-nums').textContent).toBe('無');
  expect(document.querySelectorAll('.cp-num')).toHaveLength(0);
});
