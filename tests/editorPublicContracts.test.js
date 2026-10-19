// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let State, StateModule, History, SubtitleModel, Subtitles, StylePanelController, UI, insertAsrSubtitles;
let SubFormats, buildSubtitleImportPlan, normalizeStyleRecord, on;
let deletionRenderBridge = false, deletionTrackChanges = null;

beforeAll(async () => {
  vi.useFakeTimers();
  const parsed = new DOMParser().parseFromString(fs.readFileSync(path.resolve('index.html'), 'utf8'), 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;
  // Browser seams only: every editor/model/selection/history module is real.
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true, get() { return this.textContent; }, set(value) { this.textContent = value; },
  });
  Object.defineProperty(HTMLElement.prototype, 'isContentEditable', {
    configurable: true, get() { return this.getAttribute('contenteditable') === 'true'; },
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue();
  HTMLCanvasElement.prototype.getContext = () => new Proxy({
    measureText: () => ({ width: 1 }), createLinearGradient: () => ({ addColorStop() {} }),
  }, { get: (target, key) => target[key] || (() => {}), set: (target, key, value) => (target[key] = value, true) });
  StateModule = await import('../src/state.js'); ({ State } = StateModule);
  ({ History } = await import('../src/history.js'));
  SubtitleModel = await import('../src/subtitle-model.js');
  Subtitles = await import('../src/subtitles.js');
  UI = await import('../src/ui.js');
  await import('../src/transport-controller.js');
  ({ StylePanelController } = await import('../src/style-panel-controller.js'));
  ({ insertAsrSubtitles } = await import('../src/speech-recognition.js'));
  ({ SubFormats } = await import('../src/formats.js'));
  ({ buildSubtitleImportPlan } = await import('../src/project-intake-engine.js'));
  ({ normalizeStyleRecord } = await import('../src/substyle.js'));
  ({ on } = await import('../src/events.js'));
  on('render:all', () => {
    if (!deletionRenderBridge) return;
    Subtitles.renderSubList(); StylePanelController.renderTrackStyle();
  });
  on('render:selection', () => { if (deletionRenderBridge) Subtitles.refreshSelectionUI(); });
  on('render:listTrackSel', () => { deletionTrackChanges?.push(State.listTrack); });
  StylePanelController.bindStylePanelEvents({
    renderAll: Subtitles.renderSubList, renderVideoSub: Subtitles.renderSubList,
    refreshMpvSubs: Subtitles.renderSubList, drawTimeline: Subtitles.renderSubList,
    refreshStyleSummaries: Subtitles.refreshStyleSummaries,
    initPresetLibrary: Subtitles.refreshStyleSummaries, styleChanged: Subtitles.refreshStyleSummaries,
  });
  const { ensureProjectSaved } = await import('../src/project.js');
  const guard = ensureProjectSaved();
  [...document.querySelectorAll('#modalFoot button')].find(button => button.textContent === '稍後再說')?.click();
  await guard;
});

beforeEach(() => {
  UI.closeModal();
  Object.assign(State, {
    cues: [{ id: 'target', start: 10, end: 20, text: '原文\\N{literal}\n第二行', track: 0, timed: true }],
    tracks: [{ name: '對白', visible: true, locked: false }], trackCount: 1,
    notes: [], clips: [], externalAudioState: [], externalAudioEnd: 0,
    videoTracks: [{ name: 'V1', visible: true, locked: false }],
    audioProject: { buses: [], sourceMaps: {}, exportLayout: { streams: [] } },
    activeEdge: 'end', listTrack: 0, subMode: false, presetEdit: null,
    fps: 25, dropFrame: false, duration: 20, exportIn: null, exportOut: null,
  });
  StateModule.setSelection({ kind: 'sub', ids: ['target'] });
  History.reset();
});

afterAll(() => { UI.closeModal(); vi.clearAllTimers(); vi.useRealTimers(); });

it.each(['list', 'inline', 'modal'])('%s 文字編輯的組字按鍵不確認、取消或切分，一般 Enter 仍提交', async mode => {
  const original=State.cues[0].text;
  let editor,block;
  if(mode==='list'){
    Subtitles.renderSubList();
    editor=document.querySelector('.sub-row[data-id="target"] .txt');
    editor.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}));
    await Promise.resolve();
  }else if(mode==='inline'){
    block=document.createElement('div');document.getElementById('tlLayer').appendChild(block);
    await StylePanelController.startInlineEdit(block,State.cues[0]);
    editor=document.querySelector('.cue-inline-edit');
  }else{
    await StylePanelController.openCueEditModal(State.cues[0]);await vi.advanceTimersByTimeAsync(30);
    editor=document.getElementById('cueEditTa');
  }
  const active=()=>mode==='inline'?editor.isConnected:mode==='list'?editor.contentEditable==='true':document.getElementById('modalBg').classList.contains('show');
  for(const options of [{key:'Enter',isComposing:true},{key:'Enter',ctrlKey:true,isComposing:true},
    {key:'Escape',isComposing:true},{key:'ArrowDown',isComposing:true},{key:'Enter',keyCode:229}]){
    const event=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,...options});
    editor.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(active()).toBe(true);expect(State.cues).toHaveLength(1);
    expect(State.cues[0].text).toBe(original);expect(History.stack).toHaveLength(1);
  }
  if(mode==='inline')editor.value='組字完成';else editor.innerText='組字完成';
  editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  expect(active()).toBe(false);expect(State.cues[0].text).toBe('組字完成');expect(History.stack).toHaveLength(2);
  History.undo();expect(State.cues[0].text).toBe(original);block?.remove();
});

it('時碼組字的 Enter 不提早改字幕時間，一般 Enter 才提交',async()=>{
  Subtitles.renderSubList();
  document.querySelector('.sub-row[data-id="target"] .tin').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}));
  await Promise.resolve();const input=document.querySelector('.tc-edit');expect(input).toBeTruthy();
  input.value='12';
  const event=new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true});
  input.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);expect(input.isConnected).toBe(true);
  expect(State.cues[0].start).toBe(10);expect(History.stack).toHaveLength(1);
  input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  expect(input.isConnected).toBe(false);expect(State.cues[0].start).toBe(12/25);expect(History.stack).toHaveLength(2);
});

it('背景辨識提交保留列表文字草稿與選取，文字稍後確認成為獨立 Undo', async () => {
  const cue = State.cues[0], original = cue.text;
  Subtitles.renderSubList();
  const editor = document.querySelector('.sub-row[data-id="target"] .txt');
  editor.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  await Promise.resolve();
  editor.innerText = '正在輸入的草稿';
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  expect(cue.text).toBe('正在輸入的草稿');
  deletionRenderBridge = true;
  try {
    insertAsrSubtitles([{ clip: { offset: 30, in: 0, out: 3 }, segments: [{ start: 0, end: 1, text: '辨識結果' }] }]);
    expect(State.listTrack).toBe(0); expect(State.selectedId).toBe('target');
    expect(document.querySelector('.sub-row[data-id="target"] .txt')).toBe(editor);
    expect(editor.contentEditable).toBe('true'); expect(editor.innerText).toBe('正在輸入的草稿');
    expect(document.activeElement).toBe(editor);
    expect(History.stack).toHaveLength(2);
    expect(History.stack[1].snap.cues.find(item => item.id === 'target').text).toBe(original);
    editor.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(State.cues.find(item => item.id === 'target').text).toBe('正在輸入的草稿');
    expect(History.stack).toHaveLength(3);
    History.undo();
    expect(State.cues.find(item => item.id === 'target').text).toBe(original);
    expect(State.cues.some(item => item.text === '辨識結果')).toBe(true);
    History.undo(); expect(State.cues.some(item => item.text === '辨識結果')).toBe(false);
    History.redo(); History.redo();
    expect(State.cues.find(item => item.id === 'target').text).toBe('正在輸入的草稿');
  } finally { deletionRenderBridge = false; }
});

it('沒有有效文字 editor 時背景辨識仍揭露新字幕軌並選取辨識結果', () => {
  insertAsrSubtitles([{ clip: { offset: 30, in: 0, out: 3 }, segments: [{ start: 0, end: 1, text: '正常辨識結果' }] }]);
  const result = State.cues.find(cue => cue.text === '正常辨識結果');
  expect(State.listTrack).toBe(result.track); expect(State.selectedId).toBe(result.id);
});

it.each(['取消', '確認'])('字幕文字視窗開啟時背景辨識保留操作目標，%s後下一次辨識可正常揭露', async action => {
  await StylePanelController.openCueEditModal(State.cues[0]); await vi.advanceTimersByTimeAsync(30);
  const input = document.getElementById('cueEditTa'); input.innerText = '視窗草稿';
  insertAsrSubtitles([{ clip: { offset: 30, in: 0, out: 3 }, segments: [{ start: 0, end: 1, text: '第一筆背景結果' }] }]);
  expect(State.listTrack).toBe(0); expect(State.selectedId).toBe('target');
  expect(document.getElementById('cueEditTa')).toBe(input); expect(input.innerText).toBe('視窗草稿');
  [...document.querySelectorAll('#modalFoot button')].find(button => button.textContent === action).click();
  insertAsrSubtitles([{ clip: { offset: 40, in: 0, out: 3 }, segments: [{ start: 0, end: 1, text: '第二筆背景結果' }] }]);
  const result = State.cues.find(cue => cue.text === '第二筆背景結果');
  expect(State.listTrack).toBe(result.track); expect(State.selectedId).toBe(result.id);
});

it('時間軸 inline 文字衝突關閉後釋放 editor，後續辨識可揭露結果', async () => {
  const block = document.createElement('div'); document.getElementById('tlLayer').appendChild(block);
  await StylePanelController.startInlineEdit(block, State.cues[0]);
  const input = document.querySelector('.cue-inline-edit'); input.value = 'inline 草稿';
  SubtitleModel.editCue({ cueId: 'target', operation: 'text', value: '較新的提交' });
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  expect(document.querySelector('.cue-inline-edit')).toBe(null);
  expect(State.cues[0].text).toBe('較新的提交');
  insertAsrSubtitles([{ clip: { offset: 30, in: 0, out: 3 }, segments: [{ start: 0, end: 1, text: '後續背景結果' }] }]);
  const result = State.cues.find(cue => cue.text === '後續背景結果');
  expect(State.listTrack).toBe(result.track); expect(State.selectedId).toBe(result.id);
  block.remove();
});

it.each(['forward', 'backward', 'none'])('刪除字幕只選可編輯的 %s 相鄰句，並可一次 Undo/Redo', direction => {
  State.tracks = [
    { name: 'free', visible: true, locked: false },
    { name: 'protected', visible: true, locked: true },
  ];
  State.cues = [
    { id: 'previous', start: 0, end: 1, text: 'previous', track: direction === 'backward' ? 0 : 1 },
    { id: 'delete', start: 1, end: 2, text: 'delete', track: 0 },
    { id: 'locked-next', start: 2, end: 3, text: 'protected', track: 1 },
    { id: 'next', start: 3, end: 4, text: 'next', track: direction === 'forward' ? 0 : 1 },
  ];
  StateModule.setSelection({ kind: 'sub', ids: ['delete'] });
  History.reset();
  const before = structuredClone(State.cues);
  expect(SubtitleModel.deleteSelectedCues(['delete'])).toBe(true);
  const expected = direction === 'none' ? [] : [direction === 'forward' ? 'next' : 'previous'];
  expect(State.selectedIds).toEqual(expected);
  expect(State.selectedId).toBe(expected[0] ?? null);
  expect(State.cues).toEqual(before.filter(cue => cue.id !== 'delete'));
  expect(History.stack).toHaveLength(2);
  History.undo(); expect(State.cues).toEqual(before);
  History.redo(); expect(State.cues).toEqual(before.filter(cue => cue.id !== 'delete'));
});

it('延遲確認刪除的替代選取同樣略過鎖定軌，全部刪除會清空選取', () => {
  State.tracks.push({ name: 'locked', visible: true, locked: true });
  State.cues.push({ id: 'locked', start: 20, end: 21, text: 'keep', track: 1 });
  History.reset();
  const confirm = SubtitleModel.captureCueDeletion(['target']);
  expect(confirm()).toBe(true);
  expect(State.cues.map(cue => cue.id)).toEqual(['locked']);
  expect(State.selectedIds).toEqual([]); expect(State.selectedId).toBe(null);
  expect(History.stack).toHaveLength(2);
  State.tracks[1].locked = false;
  expect(SubtitleModel.deleteSelectedCues(['locked'])).toBe(true);
  expect(State.cues).toEqual([]); expect(State.selectedIds).toEqual([]);
});

it('真多句刪除確認視窗略過受保護的相鄰句，確認一次只留一筆 History', () => {
  State.tracks.push({ name: 'protected', visible: true, locked: true });
  State.cues.push(
    { id: 'delete-second', start: 20, end: 21, text: 'delete', track: 0 },
    { id: 'locked-next', start: 21, end: 22, text: 'protected', track: 1 },
    { id: 'editable-next', start: 22, end: 23, text: 'next', track: 0 },
  );
  StateModule.setSelection({ kind: 'sub', ids: ['target', 'delete-second'] }); History.reset();
  const before = structuredClone(State.cues);
  Subtitles.deleteSelectedWithPrompt();
  expect(State.cues).toEqual(before); expect(History.stack).toHaveLength(1);
  document.querySelector('#modalFoot button.primary').click();
  expect(State.cues.map(cue => cue.id)).toEqual(['locked-next', 'editable-next']);
  expect(State.selectedIds).toEqual(['editable-next']); expect(History.stack).toHaveLength(2);
  History.undo(); expect(State.cues).toEqual(before);
});

it('鎖定待刪字幕時拒絕整筆，資料、選取與 History 都保留', () => {
  State.tracks[0].locked = true;
  const before = structuredClone(State.cues);
  expect(SubtitleModel.deleteSelectedCues(['target'])).toBe(false);
  expect(State.cues).toEqual(before); expect(State.selectedId).toBe('target');
  expect(History.stack).toHaveLength(1);
});

it.each(['forward', 'backward', 'none'])(
  '真刪除入口的 %s 替代選取同步列表與樣式，Undo/Redo 保留可見選取', direction => {
    State.tracks = [
      { name: '原軌', visible: true, locked: false },
      { name: '鎖定軌', visible: true, locked: true },
      { name: '另一可編輯軌', visible: true, locked: false },
    ];
    State.trackCount = 3;
    const target = { id: 'delete', start: 1, end: 2, text: '刪除', track: 0 };
    const locked = { id: 'locked', start: 2, end: 3, text: '保護', track: 1 };
    const cross = { id: 'cross', start: 3, end: 4, text: '跨軌選取', track: 2 };
    State.cues = direction === 'forward' ? [target, locked, cross]
      : direction === 'backward' ? [cross, locked, target] : [target, locked];
    StateModule.setSelection({ kind: 'sub', ids: ['delete'] }); History.reset();
    const before = structuredClone(State.cues), trackChanges = [];
    deletionRenderBridge = true; deletionTrackChanges = trackChanges;
    const assertVisibleSelection = () => {
      const expected = direction === 'none' ? null : 'cross';
      expect(State.selectedId).toBe(expected);
      expect(State.listTrack).toBe(direction === 'none' ? 0 : 2);
      const rows = [...document.querySelectorAll('#sublist .sub-row')].map(row => row.dataset.id);
      if (expected) expect(rows).toContain(expected);
      expect(document.getElementById('trackStyle').getAttribute('aria-disabled'))
        .toBe(direction === 'none' ? 'true' : 'false');
    };
    try {
      Subtitles.deleteSelectedWithPrompt();
      expect(State.cues).toEqual(before.filter(cue => cue.id !== 'delete'));
      expect(trackChanges).toEqual(direction === 'none' ? [] : [2]);
      expect(History.stack).toHaveLength(2); assertVisibleSelection();
      History.undo(); expect(State.cues).toEqual(before); assertVisibleSelection();
      History.redo();
      expect(State.cues).toEqual(before.filter(cue => cue.id !== 'delete')); assertVisibleSelection();
    } finally { deletionRenderBridge = false; deletionTrackChanges = null; }
  },
);

it('真多句刪除確認前保留軌道，取消後保留全部狀態，確認才同步跨軌選取', () => {
  State.tracks.push({ name: '另一可編輯軌', visible: true, locked: false }); State.trackCount = 2;
  State.cues.push(
    { id: 'second', start: 20, end: 21, text: '同軌刪除', track: 0 },
    { id: 'cross', start: 21, end: 22, text: '跨軌保留', track: 1 },
  );
  StateModule.setSelection({ kind: 'sub', ids: ['target', 'second'] }); History.reset();
  const before = structuredClone(State.cues);
  deletionRenderBridge = true;
  try {
    Subtitles.deleteSelectedWithPrompt();
    [...document.querySelectorAll('#modalFoot button')].find(button => button.textContent === '取消').click();
    expect(State.cues).toEqual(before); expect(State.listTrack).toBe(0);
    expect(State.selectedIds).toEqual(['target', 'second']); expect(History.stack).toHaveLength(1);
    Subtitles.deleteSelectedWithPrompt();
    document.querySelector('#modalFoot button.primary').click();
    expect(State.cues.map(cue => cue.id)).toEqual(['cross']); expect(State.listTrack).toBe(1);
    expect(State.selectedId).toBe('cross'); expect(History.stack).toHaveLength(2);
    expect([...document.querySelectorAll('#sublist .sub-row')].map(row => row.dataset.id)).toEqual(['cross']);
    expect(document.getElementById('trackStyle').getAttribute('aria-disabled')).toBe('false');
  } finally { deletionRenderBridge = false; }
});

it('真字幕文字視窗以 literal text 顯示 sibling 軌名，並維持複製入口', async () => {
  const name = '英文 <b>主要</b> & "參考" O\'Brien';
  State.tracks.push({ name, visible: true, locked: false });
  State.cues.push({ id: 'sibling', start: 10, end: 20, text: 'sibling <text>', track: 1 });
  await StylePanelController.openCueEditModal(State.cues[0]);
  await vi.advanceTimersByTimeAsync(30);
  const copy = document.getElementById('cueEditCopySib1');
  expect(copy.previousElementSibling.textContent).toBe('軌道：' + name);
  expect(copy.previousElementSibling.querySelector('b')).toBe(null);
  expect(document.getElementById('modalBody').textContent).toContain('sibling <text>');
});

it.each([false, true])('ASR commit 使用真 selection 介面並可 Undo/Redo（untimed=%s）', untimed => {
  StateModule.setSelection({ kind: 'video', ids: ['old-video'] });
  History.reset();
  const before = structuredClone(State.cues);
  const oldTracks = State.tracks.length;
  const count = insertAsrSubtitles([{
    clip: { id: 'source-video', offset: 0, in: 0, out: 3, dur: 3 },
    segments: [{ start: 0.4, end: 1, text: 'new ASR', ...(untimed ? { timed: false } : {}) }],
  }], { preserveUntimedSegments: untimed });
  expect(count).toBe(1);
  const generated = State.cues.find(cue => cue.text === 'new ASR');
  expect(generated).toMatchObject({ track: oldTracks, timed: !untimed });
  expect(State.selectedId).toBe(generated.id); expect(State.selectedIds).toEqual([generated.id]);
  expect(State.activeTrackKind).toBe('sub'); expect(State.activeEdge).toBe('start');
  expect(State.selectedClipId).toBe(null); expect(State.selectedAudioClipId).toBe(null);
  expect(History.stack).toHaveLength(2);
  History.undo(); expect(State.cues).toEqual(before); expect(State.tracks).toHaveLength(oldTracks);
  expect(State.selectedId).toBe(null);
  History.redo();
  expect(State.cues.find(cue => cue.id === generated.id)).toEqual(generated);
  expect(State.tracks).toHaveLength(oldTracks + 1);
});

it.each([[40, 4], [100, 100]])('真 side panel 樣式 %s/%s 經自身 ASS 與 import 完整往返', (letterSpacing, lineSpacing) => {
  const cue = State.cues[0];
  for (const [id, value] of [['tsSpacing', letterSpacing], ['tsLineSp', lineSpacing]]) {
    const input = document.getElementById(id); input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  expect(cue.style).toMatchObject({ letterSpacing, lineSpacing });
  const ass = SubFormats.toASS([cue], 25, State.tracks, 1920, 1080, { includeMetadata: true });
  const plan = buildSubtitleImportPlan(SubFormats.parseASS(ass), { fps: 25, target: 'new' });
  expect(plan.usedMetadata).toBe(true);
  expect(plan.cues[0]).toMatchObject({ text: cue.text, start: 10, end: 20, style: { letterSpacing, lineSpacing } });
});

it('真 cue modal 提交最大字距/行距改變原 cue.style，ASS import 保留逐句與軌道樣式', async () => {
  State.tracks[0].letterSpacing = 40; State.tracks[0].lineSpacing = 4;
  const cue = State.cues[0]; cue.style = { color: '#123456', angle: 12 };
  await StylePanelController.openCueEditModal(cue); await vi.advanceTimersByTimeAsync(30);
  document.getElementById('cueStyle_letterSpacing').value = 100;
  document.getElementById('cueStyle_lineSpacing').value = 100;
  document.querySelector('#modalFoot button.primary').click();
  expect(cue.style).toEqual({ color: '#123456', angle: 12, letterSpacing: 100, lineSpacing: 100 });
  expect(State.tracks[0]).toMatchObject({ letterSpacing: 40, lineSpacing: 4 });
  const plan = buildSubtitleImportPlan(SubFormats.parseASS(SubFormats.toASS(
    [cue], 25, State.tracks, 1920, 1080, { includeMetadata: true },
  )), { fps: 25, target: 'new' });
  expect(plan.usedMetadata).toBe(true); expect(plan.cues[0].style).toEqual(cue.style);
  expect(plan.trackPatch).toMatchObject({ letterSpacing: 40, lineSpacing: 4 });
});

it.each([['fontSize', 600], ['letterSpacing', 101], ['lineSpacing', 101]])(
  '真 cue modal 新修改 %s=%s 超界時不提交文字、樣式或 History', async (key, value) => {
    const cue = State.cues[0], before = structuredClone(cue);
    await StylePanelController.openCueEditModal(cue); await vi.advanceTimersByTimeAsync(30);
    document.getElementById('cueEditTa').innerText = 'must not commit';
    document.getElementById('cueStyle_' + key).value = value;
    document.querySelector('#modalFoot button.primary').click();
    expect(cue).toEqual(before); expect(History.stack).toHaveLength(1);
    expect(document.getElementById('modalBg').classList.contains('show')).toBe(true);
    expect(document.getElementById('toast').textContent).toContain('樣式值無效');
  },
);

it('真 cue modal 未修改原有 legacy 數值時可只改文字，保留其樣式且可 Undo', async () => {
  const cue = State.cues[0];
  cue.style = { fontSize: 600, letterSpacing: -2, lineSpacing: 0.8 };
  History.reset();
  const before = structuredClone(cue);
  await StylePanelController.openCueEditModal(cue); await vi.advanceTimersByTimeAsync(30);
  document.getElementById('cueEditTa').innerText = 'edited legacy text';
  document.querySelector('#modalFoot button.primary').click();
  expect(cue.text).toBe('edited legacy text'); expect(cue.style).toEqual(before.style);
  expect(History.stack).toHaveLength(2);
  History.undo(); expect(State.cues[0]).toEqual(before);
});

it.each([
  { letterSpacing: 101 }, { lineSpacing: 101 }, { letterSpacing: 1e100 }, { lineSpacing: 1e100 },
  { letterSpacing: NaN }, { lineSpacing: Infinity }, { letterSpacing: '40' }, { lineSpacing: 0 },
  { fontSize: 600 }, { color: '#ffffff;background:red' }, { font: 'a'.repeat(201) }, { unknown: 1 },
])('metadata style admission 仍拒絕非法/超界值 %j', style => {
  expect(normalizeStyleRecord(style, true, true)).toBe(null);
  const unsafe = { ...State.cues[0], style };
  const parsed = SubFormats.parseASS(SubFormats.toASS([unsafe], 25, State.tracks, 1920, 1080, { includeMetadata: true }));
  expect(parsed.subtool).toBeUndefined();
});

it.each([
  { letterSpacing: 101 }, { lineSpacing: 1e100 }, { letterSpacing: '40' },
  { color: '#zzzzzz' }, { font: 'a'.repeat(201) }, { unknown: 1 }, [], null,
])('匯入外來 metadata 的非法樣式 %j 仍退回標準 ASS', style => {
  const valid = SubFormats.toASS(
    [{ ...State.cues[0], style: { letterSpacing: 100, lineSpacing: 100 } }],
    25, State.tracks, 1920, 1080, { includeMetadata: true },
  );
  const metadata = structuredClone(SubFormats.parseASS(valid).subtool);
  expect(metadata.cues[0].style).toEqual({ letterSpacing: 100, lineSpacing: 100 });
  metadata.cues[0].style = style;
  // Corrupt the public file format, not the validator or its return value.
  const base64 = Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64');
  const external = valid.replace(/^; SUBTOOL-META:.*\n/gm, '')
    .replace('[Script Info]', `[Script Info]\n; SUBTOOL-META:1:1/1:${base64}`);
  const parsed = SubFormats.parseASS(external);
  expect(parsed.subtool).toBeUndefined();
  expect(parsed.length).toBeGreaterThan(0);
  expect(buildSubtitleImportPlan(parsed, { fps: 25, target: 'new' }).usedMetadata).toBe(false);
});

it('巨型外來 metadata 不阻止標準 Dialogue fallback', () => {
  const valid = SubFormats.toASS(State.cues, 25, State.tracks, 1920, 1080, { includeMetadata: true });
  const metadata = structuredClone(SubFormats.parseASS(valid).subtool);
  metadata.cues[0].text = 'x'.repeat(9 * 1024 * 1024);
  const base64 = Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64');
  const external = valid.replace(/^; SUBTOOL-META:.*\n/gm, '')
    .replace('[Script Info]', `[Script Info]\n; SUBTOOL-META:1:1/1:${base64}`);
  const parsed = SubFormats.parseASS(external);
  expect(parsed.subtool).toBeUndefined(); expect(parsed.length).toBeGreaterThan(0);
  expect(buildSubtitleImportPlan(parsed, { fps: 25, target: 'new' }).usedMetadata).toBe(false);
});

it.each([
  { previousLength: 4, incomingSourceLength: 0.04, speed: 1, overlap: 0.04 },
  { previousLength: 0.04, incomingSourceLength: 4, speed: 1, overlap: 0.04 },
  { previousLength: 4, incomingSourceLength: 0.08, speed: 2, overlap: 0.04 },
  { previousLength: 4, incomingSourceLength: 4, speed: 1, overlap: 1 },
])('真溶接視窗以兩片段時間軸長度限制重疊並保持 Undo/Redo：%j', async spec => {
  const { showCrossfade } = await import('../src/menus.js');
  const { Media } = await import('../src/media.js');
  const seek = vi.spyOn(Media, 'seek').mockResolvedValue(true);
  const restore = vi.spyOn(Media, 'restoreSequenceEditState').mockResolvedValue([]);
  const previous = { id: 'xf-previous', name: '前段', path: 'C:/previous.mp4', offset: 0,
    in: 0, out: spec.previousLength, dur: 4, vtrack: 0 };
  const incoming = { id: 'xf-incoming', name: '後段', path: 'C:/incoming.mp4', offset: spec.previousLength,
    in: 0, out: spec.incomingSourceLength, dur: 4, vtrack: 0, speed: spec.speed };
  State.clips = [previous, incoming]; History.reset();
  try {
    showCrossfade(incoming);
    const limit = Math.min(spec.previousLength, spec.incomingSourceLength / spec.speed);
    expect(Number(document.getElementById('xfT').max)).toBeCloseTo(limit, 9);
    document.querySelector('#modalFoot button.primary').click();
    expect(incoming.offset).toBeCloseTo(spec.previousLength - spec.overlap, 9);
    expect(incoming.fadeIn).toBeCloseTo(spec.overlap, 9);
    expect(incoming.offset + spec.incomingSourceLength / spec.speed).toBeGreaterThanOrEqual(spec.previousLength);
    expect(incoming.vtrack).toBe(1); expect(History.stack).toHaveLength(2);
    History.undo();
    expect(State.clips.find(clip => clip.id === incoming.id)).toMatchObject({ offset: spec.previousLength, vtrack: 0, fadeIn: 0 });
    History.redo();
    const replay = State.clips.find(clip => clip.id === incoming.id);
    expect(replay.offset).toBeCloseTo(spec.previousLength - spec.overlap, 9);
    expect(replay.fadeIn).toBeCloseTo(spec.overlap, 9); expect(replay.vtrack).toBe(1);
  } finally { seek.mockRestore(); restore.mockRestore(); }
});

it.each([0, -0.04, NaN, Infinity])('溶接模型拒絕無效時長 %s，不移軌、不改片段與 History', async duration => {
  const { crossfadeWithPrev } = await import('../src/clip-model.js');
  const previous = { id: 'xf-previous', name: '前段', offset: 0, in: 0, out: 4, dur: 4, vtrack: 0 };
  const incoming = { id: 'xf-incoming', name: '後段', offset: 4, in: 0, out: 4, dur: 4, vtrack: 0 };
  State.clips = [previous, incoming]; History.reset();
  const before = structuredClone(State.clips), tracks = structuredClone(State.videoTracks);
  expect(crossfadeWithPrev(incoming, duration)).toBe(false);
  expect(State.clips).toEqual(before); expect(State.videoTracks).toEqual(tracks); expect(History.stack).toHaveLength(1);
});
