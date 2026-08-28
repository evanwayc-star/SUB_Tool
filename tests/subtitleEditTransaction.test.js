// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let State;
let History;
let SubtitleModel;
let splitCue;
let addCue;
let addCueRelative;
let swapAdjacentCues;
let mergeAdjacentCues;
let Subtitles;
let StylePanelController;
let Media;
let renderInvalidations = 0;
let renderListSynchronously = false;

function mountSystemDom() {
  const source = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
  const parsed = new DOMParser().parseFromString(source, 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;
  // jsdom 沒有 Chromium 的 innerText / isContentEditable；只補瀏覽器 DOM seam，
  // production modules、State、History 與事件匯流排仍全部使用真實實作。
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() { return this.textContent; },
    set(value) { this.textContent = value; },
  });
  Object.defineProperty(HTMLElement.prototype, 'isContentEditable', {
    configurable: true,
    get() { return this.getAttribute('contenteditable') === 'true'; },
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

beforeAll(async () => {
  vi.useFakeTimers();
  mountSystemDom();
  ({ State } = await import('../src/state.js'));
  ({ History } = await import('../src/history.js'));
  SubtitleModel = await import('../src/subtitle-model.js');
  ({ splitCue, addCue, addCueRelative, swapAdjacentCues, mergeAdjacentCues } = SubtitleModel);
  Subtitles = await import('../src/subtitles.js');
  ({ Media } = await import('../src/media.js'));
  await import('../src/transport-controller.js');
  ({ StylePanelController } = await import('../src/ui/style-panel-controller.js'));
  StylePanelController.bindStylePanelEvents({
    renderAll: Subtitles.renderSubList,
    renderVideoSub: Subtitles.renderSubList,
    refreshMpvSubs: Subtitles.renderSubList,
    drawTimeline: Subtitles.renderSubList,
    refreshStyleSummaries: Subtitles.refreshStyleSummaries,
    initPresetLibrary: Subtitles.refreshStyleSummaries,
    styleChanged: Subtitles.refreshStyleSummaries,
  });
  const { on } = await import('../src/events.js');
  on('render:all', () => {
    renderInvalidations += 1;
    if (!renderListSynchronously) return;
    renderListSynchronously = false;
    const activeEditor = document.activeElement?.closest?.('#sublist .txt');
    activeEditor?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    Subtitles.renderSubList();
  });

  const { ensureProjectSaved } = await import('../src/project.js');
  const guard = ensureProjectSaved();
  document.querySelector('#modalFoot button:last-child').click();
  await guard;
});

beforeEach(() => {
  Object.assign(State, {
    cues: [
      { id: 'before', start: 1, end: 2, text: '前一句', track: 0, timed: true },
      { id: 'target', start: 10, end: 20, text: '前半後半', track: 0, timed: true },
      { id: 'after', start: 30, end: 31, text: '後一句', track: 0, timed: true },
    ],
    tracks: [{ name: '對白', visible: true, locked: false }],
    notes: [],
    selectedId: 'target',
    selectedIds: ['target'],
    selectedClipId: null,
    selectedAudioClipId: null,
    activeTrackKind: 'sub',
    activeEdge: 'start',
    subMode: false,
  });
  renderInvalidations = 0;
  renderListSynchronously = false;
  document.getElementById('toast').textContent = '';
  History.reset();
});

describe('字幕編輯交易：拆分字幕', () => {
  it('切分有時間字幕時，一次完成文字與時間 mutation、選取、History 與畫面失效', () => {
    const result = splitCue({
      cueId: 'target',
      textBefore: '前半',
      textAfter: '後半',
      timelineTime: 15,
    });

    expect(result.ok).toBe(true);
    expect(State.cues.map(cue => ({
      id: cue.id,
      start: cue.start,
      end: cue.end,
      text: cue.text,
      track: cue.track,
      timed: cue.timed,
    }))).toEqual([
      { id: 'before', start: 1, end: 2, text: '前一句', track: 0, timed: true },
      { id: 'target', start: 10, end: 15, text: '前半', track: 0, timed: true },
      { id: result.cue.id, start: 15, end: 20, text: '後半', track: 0, timed: true },
      { id: 'after', start: 30, end: 31, text: '後一句', track: 0, timed: true },
    ]);
    expect({ selectedId: State.selectedId, selectedIds: State.selectedIds, activeEdge: State.activeEdge })
      .toEqual({ selectedId: result.cue.id, selectedIds: [result.cue.id], activeEdge: 'start' });
    expect(History.stack.at(-1)?.label).toBe('拆分字幕');
    expect(renderInvalidations).toBe(1);
  });

  it('切分無時間字幕時，兩段都維持無時間狀態且不採用播放點', () => {
    State.cues = [
      { id: 'target', start: 0, end: 0, text: '前半後半', track: 0, timed: false },
    ];
    History.reset();

    const result = splitCue({
      cueId: 'target',
      textBefore: '前半',
      textAfter: '後半',
      timelineTime: 99,
    });

    expect(result.ok).toBe(true);
    expect(State.cues.map(cue => ({ start: cue.start, end: cue.end, text: cue.text, timed: cue.timed })))
      .toEqual([
        { start: 0, end: 0, text: '前半', timed: false },
        { start: 0, end: 0, text: '後半', timed: false },
      ]);
  });

  it.each([
    ['句首', '   ', '前半後半'],
    ['句尾', '前半後半', '\n'],
  ])('拒絕在%s切分，且不留下空白字幕或 History', (_label, textBefore, textAfter) => {
    const before = structuredClone(State.cues);

    const result = splitCue({ cueId: 'target', textBefore, textAfter, timelineTime: 15 });

    expect({
      result,
      cues: State.cues,
      historyLabels: History.stack.map(entry => entry.label),
      renderInvalidations,
      toast: document.getElementById('toast').textContent,
    }).toEqual({
      result: { ok: false, reason: 'blank-side' },
      cues: before,
      historyLabels: ['初始'],
      renderInvalidations: 0,
      toast: '不能在句首或句尾切分，以免產生空白字幕',
    });
  });

  it.each([
    ['起點', 10.049],
    ['終點', 19.951],
  ])('拒絕距離%s不足 0.05 秒的切分點', (_edge, timelineTime) => {
    const before = structuredClone(State.cues);

    const result = splitCue({
      cueId: 'target', textBefore: '前半', textAfter: '後半', timelineTime,
    });

    expect({
      result,
      cues: State.cues,
      historyLabels: History.stack.map(entry => entry.label),
      renderInvalidations,
      toast: document.getElementById('toast').textContent,
    }).toEqual({
      result: { ok: false, reason: 'split-time-out-of-range' },
      cues: before,
      historyLabels: ['初始'],
      renderInvalidations: 0,
      toast: '切分點距離起訖太近，或是超出了字幕範圍',
    });
  });

  it('鎖定軌道會在交易入口擋下拆分並保留原狀', () => {
    State.tracks[0].locked = true;
    const before = structuredClone(State.cues);

    const result = splitCue({
      cueId: 'target', textBefore: '前半', textAfter: '後半', timelineTime: 15,
    });

    expect({
      result,
      cues: State.cues,
      historyLabels: History.stack.map(entry => entry.label),
      renderInvalidations,
      toast: document.getElementById('toast').textContent,
    }).toEqual({
      result: { ok: false, reason: 'track-locked' },
      cues: before,
      historyLabels: ['初始'],
      renderInvalidations: 0,
      toast: '🔒「對白」已鎖定，無法拆分字幕',
    });
  });
});

describe('字幕編輯交易：相鄰交換與合併', () => {
  it('production interface 不再暴露未接線的影子純函式', () => {
    expect(['splitCueAtTime', 'mergeTwoCues', 'swapCueTexts'].filter(name => name in SubtitleModel))
      .toEqual([]);
  });

  it('合併由真實交易一次完成內容、時間、選取、History 與畫面失效', () => {
    mergeAdjacentCues('target', 1);

    expect({
      cues: State.cues.map(cue => ({ id: cue.id, start: cue.start, end: cue.end, text: cue.text })),
      selectedId: State.selectedId,
      historyLabels: History.stack.map(entry => entry.label),
      renderInvalidations,
    }).toEqual({
      cues: [
        { id: 'before', start: 1, end: 2, text: '前一句' },
        { id: 'target', start: 10, end: 31, text: '前半後半 後一句' },
      ],
      selectedId: 'target',
      historyLabels: ['初始', '合併字幕'],
      renderInvalidations: 1,
    });
  });

  it('相鄰換位由真實交易保留各自長度與間隔並只留一筆 History', () => {
    swapAdjacentCues('target', 1);

    expect({
      cues: State.cues.map(cue => ({ id: cue.id, start: cue.start, end: cue.end, text: cue.text })),
      historyLabels: History.stack.map(entry => entry.label),
      renderInvalidations,
    }).toEqual({
      cues: [
        { id: 'before', start: 1, end: 2, text: '前一句' },
        { id: 'after', start: 10, end: 11, text: '後一句' },
        { id: 'target', start: 21, end: 31, text: '前半後半' },
      ],
      historyLabels: ['初始', '相鄰換位'],
      renderInvalidations: 1,
    });
  });
});

describe('字幕區塊滑鼠跳轉政策', () => {
  it('跳轉暫停時，開啟字幕編輯會先停播再定位到字幕起點', async () => {
    State.pointerSeekPauses = true;
    Media.playing = true;
    const calls = [];
    const pauseSpy = vi.spyOn(Media, 'pause').mockImplementation(() => {
      calls.push('pause');
      Media.playing = false;
    });
    const seekSpy = vi.spyOn(Media, 'seek').mockImplementation(time => {
      calls.push(`seek:${time}`);
    });

    try {
      await StylePanelController.openCueEditModal(State.cues.find(cue => cue.id === 'target'));

      expect(calls).toEqual(['pause', 'seek:10']);
    } finally {
      document.querySelector('#modalFoot button:last-child')?.click();
      State.pointerSeekPauses = false;
      Media.playing = false;
      pauseSpy.mockRestore();
      seekSpy.mockRestore();
    }
  });
});

function placeCursor(textElement, offset) {
  const range = document.createRange();
  range.setStart(textElement.firstChild, offset);
  range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

describe('拆分字幕 UI adapters', () => {
  beforeEach(() => {
    State.cues = [
      { id: 'target', start: 0, end: 0, text: '前半後半', track: 0, timed: false },
    ];
    State.tracks = [{ name: '對白', visible: true, locked: true }];
    State.listTrack = 0;
    State.selectedId = 'target';
    State.selectedIds = ['target'];
    renderInvalidations = 0;
    document.getElementById('toast').textContent = '';
    History.reset();
  });

  it('字幕列表 Ctrl+Enter 拆分後會立即從原欄位移除游標後文字', () => {
    const frameCallbacks = [];
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });

    try {
      State.tracks[0].locked = false;
      Subtitles.renderSubList();
      const textElement = document.querySelector('.sub-row[data-id="target"] .txt');
      textElement.setAttribute('contenteditable', 'true');
      textElement.contentEditable = 'true';
      textElement.focus();
      placeCursor(textElement, 2);
      renderListSynchronously = true;

      textElement.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
      }));

      const newCue = State.cues.find(cue => cue.id !== 'target');
      frameCallbacks.splice(0).forEach(callback => callback(0));
      const originalField = document.querySelector('.sub-row[data-id="target"] .txt');
      const newField = document.querySelector(`.sub-row[data-id="${newCue.id}"] .txt`);
      expect({
        cueTexts: State.cues.map(cue => cue.text),
        originalFieldText: originalField.innerText,
        originalFieldEditable: originalField.contentEditable === 'true',
        newFieldText: newField.innerText,
        newFieldEditable: newField.contentEditable === 'true',
        activeElement: document.activeElement,
        historyLabels: History.stack.map(entry => entry.label),
      }).toEqual({
        cueTexts: ['前半', '後半'],
        originalFieldText: '前半',
        originalFieldEditable: false,
        newFieldText: '後半',
        newFieldEditable: true,
        activeElement: newField,
        historyLabels: ['初始', '拆分字幕'],
      });

      newField.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      expect({
        cueTexts: State.cues.map(cue => cue.text),
        newFieldEditable: newField.contentEditable === 'true',
        historyLabels: History.stack.map(entry => entry.label),
      }).toEqual({
        cueTexts: ['前半', '後半'],
        newFieldEditable: false,
        historyLabels: ['初始', '拆分字幕'],
      });
    } finally {
      renderListSynchronously = false;
      rafSpy.mockRestore();
    }
  });

  it('字幕列表 Ctrl+Enter 由交易入口擋下鎖定軌，不會自行 mutation', () => {
    Subtitles.renderSubList();
    const textElement = document.querySelector('.sub-row[data-id="target"] .txt');
    textElement.contentEditable = 'true';
    placeCursor(textElement, 2);

    textElement.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
    }));

    expect({
      cues: State.cues,
      historyLabels: History.stack.map(entry => entry.label),
      toast: document.getElementById('toast').textContent,
    }).toEqual({
      cues: [{ id: 'target', start: 0, end: 0, text: '前半後半', track: 0, timed: false }],
      historyLabels: ['初始'],
      toast: '🔒「對白」已鎖定，無法拆分字幕',
    });
  });

  it('修改字幕 modal 的 Ctrl+Enter 由同一交易入口擋下鎖定軌', async () => {
    await StylePanelController.openCueEditModal(State.cues[0]);
    vi.runOnlyPendingTimers();
    const textElement = document.getElementById('cueEditTa');
    placeCursor(textElement, 2);

    textElement.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
    }));

    expect({
      cues: State.cues,
      historyLabels: History.stack.map(entry => entry.label),
      toast: document.getElementById('toast').textContent,
    }).toEqual({
      cues: [{ id: 'target', start: 0, end: 0, text: '前半後半', track: 0, timed: false }],
      historyLabels: ['初始'],
      toast: '🔒「對白」已鎖定，無法拆分字幕',
    });
  });
});

describe('字幕編輯交易：新增字幕', () => {
  it('新增 interface 自己完成選取、History 與畫面失效，不接收 UI callback', () => {
    State.cues = [];
    State.tracks = [{ name: '對白', visible: true, locked: false }];
    State.selectedId = null;
    State.selectedIds = [];
    renderInvalidations = 0;
    History.reset();

    const cue = addCue(5, 7, '新增內容', 0, { historyLabel: '新增字幕(I)' });

    expect({
      cue,
      selectedId: State.selectedId,
      selectedIds: State.selectedIds,
      historyLabels: History.stack.map(entry => entry.label),
      renderInvalidations,
    }).toEqual({
      cue: { id: cue.id, start: 5, end: 7, text: '新增內容', track: 0, timed: true },
      selectedId: cue.id,
      selectedIds: [cue.id],
      historyLabels: ['初始', '新增字幕(I)'],
      renderInvalidations: 1,
    });
  });

  it('相對新增沿用同一交易，只留下方向明確的一筆 History', () => {
    State.cues = [
      { id: 'target', start: 10, end: 20, text: '原字幕', track: 0, timed: true },
    ];
    State.tracks = [{ name: '對白', visible: true, locked: false }];
    State.selectedId = 'target';
    State.selectedIds = ['target'];
    State.fps = 25;
    State.dropFrame = false;
    renderInvalidations = 0;
    History.reset();

    const cue = addCueRelative(1);

    expect({
      cue: { id: cue.id, start: cue.start, end: cue.end, text: cue.text, track: cue.track, timed: cue.timed },
      selectedId: State.selectedId,
      historyLabels: History.stack.map(entry => entry.label),
      renderInvalidations,
    }).toEqual({
      cue: { id: cue.id, start: 20, end: 22, text: '', track: 0, timed: true },
      selectedId: cue.id,
      historyLabels: ['初始', '下方新增字幕'],
      renderInvalidations: 1,
    });
  });
});

describe('字幕一般編輯 UI adapters', () => {
  it('字幕列的起點編輯由交易入口擋下鎖定軌，不留 mutation 或 History', async () => {
    State.tracks[0].locked = true;
    State.fps = 25;
    State.dropFrame = false;
    Subtitles.renderSubList();
    const startCell = document.querySelector('.sub-row[data-id="target"] .tin');

    startCell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    const editor = startCell.querySelector('input');
    expect(editor).not.toBeNull();
    editor.value = '00:00:12:00';
    editor.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    }));

    expect({
      cue: State.cues.find(cue => cue.id === 'target'),
      historyLabels: History.stack.map(entry => entry.label),
      toast: document.getElementById('toast').textContent,
    }).toEqual({
      cue: { id: 'target', start: 10, end: 20, text: '前半後半', track: 0, timed: true },
      historyLabels: ['初始'],
      toast: '🔒「對白」已鎖定，無法修改字幕起點',
    });
  });

  it('字幕列的終點編輯也不能繞過同一個鎖軌交易', async () => {
    State.tracks[0].locked = true;
    State.fps = 25;
    State.dropFrame = false;
    Subtitles.renderSubList();
    const endCell = document.querySelector('.sub-row[data-id="target"] .tout');

    endCell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    const editor = endCell.querySelector('input');
    editor.value = '00:00:18:00';
    editor.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    }));

    expect({
      cue: State.cues.find(cue => cue.id === 'target'),
      historyLabels: History.stack.map(entry => entry.label),
      toast: document.getElementById('toast').textContent,
    }).toEqual({
      cue: { id: 'target', start: 10, end: 20, text: '前半後半', track: 0, timed: true },
      historyLabels: ['初始'],
      toast: '🔒「對白」已鎖定，無法修改字幕終點',
    });
  });

  it('字幕列的 contenteditable 即時預覽與 focusout commit 共用鎖軌交易', async () => {
    State.tracks[0].locked = true;
    Subtitles.renderSubList();
    const textCell = document.querySelector('.sub-row[data-id="target"] .txt');

    textCell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    textCell.innerText = '不應寫入';
    textCell.dispatchEvent(new InputEvent('input', { bubbles: true }));
    textCell.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

    expect({
      cueText: State.cues.find(cue => cue.id === 'target').text,
      historyLabels: History.stack.map(entry => entry.label),
      toast: document.getElementById('toast').textContent,
    }).toEqual({
      cueText: '前半後半',
      historyLabels: ['初始'],
      toast: '🔒「對白」已鎖定，無法編輯字幕',
    });
  });

  it('時間軸區塊的 inline textarea 不再自己寫 cue 或 History', async () => {
    State.tracks[0].locked = true;
    const block = document.createElement('div');
    document.getElementById('tlLayer').appendChild(block);

    await StylePanelController.startInlineEdit(block, State.cues.find(cue => cue.id === 'target'));
    const editor = document.querySelector('.cue-inline-edit');
    editor.value = '時間軸不應寫入';
    editor.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    }));

    expect({
      cueText: State.cues.find(cue => cue.id === 'target').text,
      historyLabels: History.stack.map(entry => entry.label),
      toast: document.getElementById('toast').textContent,
    }).toEqual({
      cueText: '前半後半',
      historyLabels: ['初始'],
      toast: '🔒「對白」已鎖定，無法編輯字幕',
    });
  });

  it('修改字幕 modal 的文字與樣式在同一筆交易中被鎖軌擋下', async () => {
    State.tracks[0].locked = true;
    const cue = State.cues.find(item => item.id === 'target');

    await StylePanelController.openCueEditModal(cue);
    await vi.advanceTimersByTimeAsync(30);
    document.getElementById('cueEditTa').innerText = '對話框不應寫入';
    document.getElementById('covK_bold').checked = true;
    document.getElementById('covV_bold').value = '1';
    document.querySelector('#modalFoot button.primary').click();

    expect({
      cue,
      historyLabels: History.stack.map(entry => entry.label),
      toast: document.getElementById('toast').textContent,
    }).toEqual({
      cue: { id: 'target', start: 10, end: 20, text: '前半後半', track: 0, timed: true },
      historyLabels: ['初始'],
      toast: '🔒「對白」已鎖定，無法編輯字幕',
    });
  });
});
