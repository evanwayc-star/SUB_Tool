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
vi.mock('../src/timeline-interaction-engine.js', () => ({ requestPointerSeek: vi.fn() }));
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
  trackLocked: () => false, cueTrackLocked: () => false, splitCue: vi.fn(), finalizeProvisionalCueEnds: vi.fn(),
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
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('requestAnimationFrame', vi.fn());
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

it('相接字幕壓成範圍，有間隙仍分開，保留原同文組色', () => {
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
    number: node.textContent,
    joined: node.classList.contains('cp-joined-identical'),
  }))).toEqual([
    { number: '1', joined: false },
    { number: '2', joined: false },
    { number: '3–4', joined: true },
  ]);
  const [orange, , darkGreen] = document.querySelectorAll('#cpConsecutiveIdentical .cp-num');
  expect(orange.tagName).toBe('BUTTON');
  expect(orange.getAttribute('type')).toBe('button');
  expect(orange.getAttribute('aria-label')).toBe('前往第 1 句字幕');
  expect(getComputedStyle(darkGreen).color).not.toBe(getComputedStyle(orange).color);
  expect(getComputedStyle(darkGreen).color).toBe('rgb(74, 222, 128)');
  expect(darkGreen.title).toContain('頭尾相接');
  expect(darkGreen.getAttribute('aria-label')).toBe('選取第 3 至 4 句字幕，前往第 3 句');
});

it('同文群組紅綠藍循環，三句一組保持同色，列表色標不改字幕樣式且編輯後更新鄰列',()=>{
  const texts=['甲','甲','單句','乙','乙','乙','丙','丙','甲','甲'];
  const cues=texts.map((text,index)=>({id:'group-'+index,text,start:index,end:index+1,track:0,timed:true}));
  Object.assign(state.State,{fps:25,listTrack:0,tracks:[{name:'字幕',visible:true}],cues});
  const before=structuredClone(cues);
  renderSubList();
  const buttons=[...document.querySelectorAll('#cpConsecutiveIdentical .cp-num')];
  expect(buttons.map(button=>button.textContent)).toEqual(['1–2','4–6','7–8','9–10']);
  expect(buttons.map(button=>getComputedStyle(button).color)).toEqual([
    'rgb(248, 113, 113)', 'rgb(74, 222, 128)', 'rgb(96, 165, 250)', 'rgb(248, 113, 113)',
  ]);
  expect(buttons.map(button=>Number(button.dataset.identicalGroup))).toEqual([1,2,3,4]);
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

it('範圍點選選取全段並只定位首句，有間隙的同文不被一併選取', async () => {
  const { requestPointerSeek } = await import('../src/timeline-interaction-engine.js');
  const { recordHistory } = await import('../src/history.js');
  const cues=[
    {id:'a',text:'同句',start:10,end:11,track:0},
    {id:'b',text:'同句',start:11,end:12,track:0},
    {id:'c',text:'同句',start:12,end:13,track:0},
    {id:'d',text:'同句',start:13.04,end:14,track:0},
    {id:'other',text:'別軌',start:11,end:12,track:1},
  ];
  Object.assign(state.State,{fps:25,listTrack:0,tracks:[{name:'字幕'},{name:'別軌'}],cues});
  state.setSelection({kind:'sub',ids:['other'],primary:'other'});
  renderSubList();
  const before=structuredClone(cues);
  vi.clearAllMocks();
  const buttons=[...document.querySelectorAll('#cpConsecutiveIdentical .cp-num')];
  expect(buttons.map(button=>button.textContent)).toEqual(['1–3','4']);
  expect(buttons[0].tagName).toBe('BUTTON');
  expect(buttons[0].getAttribute('type')).toBe('button');
  buttons[0].click();
  expect(state.State.selectedIds).toEqual(['a','b','c']);
  expect(state.State.selectedId).toBe('a');
  expect([...document.querySelectorAll('.sub-row.sel')].map(row=>row.dataset.id)).toEqual(['a','b','c']);
  expect(requestPointerSeek).toHaveBeenCalledExactlyOnceWith(10);
  const {renderCueBlocks}=await import('../src/timeline-renderer.js');
  expect(renderCueBlocks).toHaveBeenCalledTimes(1);
  expect(recordHistory).not.toHaveBeenCalled();
  expect(cues).toEqual(before);
  buttons[1].click();
  expect(state.State.selectedIds).toEqual(['d']);
  expect(requestPointerSeek).toHaveBeenLastCalledWith(13.04);
});

it('重繪後保留相同的檢查編號及焦點，按鈕可定位到新軌的字幕；刪到空軌清除舊編號', () => {
  const cues=Array.from({length:4},(_,i)=>({id:'audit-'+i,text:'相同',start:i,end:i+1,track:i>>1}));
  Object.assign(state.State,{fps:25,listTrack:0,tracks:[{name:'軌一'},{name:'軌二'}],cues});
  renderSubList();
  const button=document.querySelector('#cpConsecutiveIdentical .cp-num');
  button.focus();
  renderCheckPanel();
  expect(document.activeElement).toBe(button);
  state.State.listTrack=1;
  renderSubList();
  expect(document.querySelector('#cpConsecutiveIdentical .cp-num')).toBe(button);
  button.click();
  expect(state.State.selectedIds).toEqual(['audit-2','audit-3']);
  state.State.cues=cues.slice(0,2);
  renderSubList();
  expect(document.querySelectorAll('#checkPanel .cp-num')).toHaveLength(0);
  expect(document.getElementById('checkSummary').textContent).toContain('軌二尚無字幕');
});

it('空軌明確提示尚無字幕，已檢查而無命中顯示無', () => {
  Object.assign(state.State,{tracks:[{name:'中文字幕'}],listTrack:0,cues:[]});
  renderCheckPanel();
  expect(document.getElementById('checkSummary').textContent).toContain('中文字幕尚無字幕');
  expect(document.querySelector('#cpConsecutiveIdentical .cp-nums').textContent).toBe('無');
  expect(document.querySelectorAll('.cp-num')).toHaveLength(0);
});

it('就地鎖軌可定位但不能修剪，解鎖及就地改文會重新核對結果', () => {
  const panel=document.getElementById('checkPanel');
  panel.insertAdjacentHTML('beforeend','<button data-act="trim-track"></button><div id="cpTrim"><span class="cp-nums"></span></div>');
  const trim=panel.querySelector('[data-act="trim-track"]'), section=document.getElementById('cpTrim');
  const track={name:'對白',locked:false}, cue={id:'lock-check',text:' 前空白',start:8,end:9,track:0};
  try {
    Object.assign(state.State,{fps:24,listTrack:0,tracks:[track],cues:[cue]});
    renderSubList();
    const button=section.querySelector('.cp-num');
    expect(trim.disabled).toBe(false);
    track.locked=true;renderCheckPanel();
    expect(trim.disabled).toBe(true);
    expect(section.querySelector('.cp-num')).toBe(button);
    button.click();
    expect(state.State.selectedId).toBe(cue.id);
    track.locked=false;renderCheckPanel();
    expect(trim.disabled).toBe(false);
    cue.text='已修正';renderCheckPanel();
    expect(section.textContent).toBe('無');
    expect(trim.disabled).toBe(true);
    state.deselect('sub');
    button.click();
    expect(state.State.selectedId).toBeNull();
  } finally { section.remove();trim.remove(); }
});

it('長軌檢查保持編號、文字編輯及未選列不動，只更新命中標示和選取列', () => {
  const panel=document.getElementById('checkPanel'), sublist=document.getElementById('sublist');
  panel.insertAdjacentHTML('beforeend','<input id="cpContainsInput"><input id="cpLenInput"><div id="cpContains"><span class="cp-nums"></span></div>');
  const cues=Array.from({length:1316},(_,i)=>({id:'long-'+i,text:'話'+i,start:i,end:i+1,track:0}));
  Object.assign(state.State,{fps:24,listTrack:0,tracks:[{name:'對白'}],cues});
  state.deselect('sub');
  sublist.innerHTML=cues.map(cue=>`<div class="sub-row" data-id="${cue.id}"><div class="txt">${cue.text}</div></div>`).join('');
  const edit=sublist.querySelector('.txt');
  edit.contentEditable='true';
  edit.textContent='正在輸入';
  const contains=document.getElementById('cpContainsInput'), limit=document.getElementById('cpLenInput');
  contains.value='話'; limit.value='1';
  renderCheckPanel();
  const results=panel.querySelector('#cpContains .cp-nums');
  expect(results.childElementCount).toBe(1316);
  const button=results.lastElementChild;
  const observer=new MutationObserver(()=>{});
  observer.observe(sublist,{subtree:true,attributes:true,attributeFilter:['class']});
  try {
    renderCheckPanel();
    expect(results.lastElementChild).toBe(button);
    expect(edit.isConnected && edit.textContent==='正在輸入').toBe(true);
    expect(sublist.querySelectorAll('.contains-match')).toHaveLength(1316);
    expect(sublist.querySelector('.sub-row:last-child .over-len')?.textContent).toBe('1315');
    button.click();
    expect(state.State.selectedId).toBe('long-1315');
    expect(observer.takeRecords().every(record=>record.target===sublist.lastElementChild)).toBe(true);
    contains.value='不存在';limit.value='100';renderCheckPanel();
    expect(results.textContent).toBe('無');
    expect(sublist.querySelector('.contains-match, .over-len')).toBeNull();
    expect(edit.textContent).toBe('正在輸入');
  } finally {
    observer.disconnect();
    contains.remove();limit.remove();results.parentElement.remove();
  }
});
