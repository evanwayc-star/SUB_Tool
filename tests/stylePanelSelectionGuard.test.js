/** @vitest-environment jsdom */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let State;
let StylePanelController;

beforeAll(async () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
  const parsed = new DOMParser().parseFromString(source, 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;
  ({ State } = await import('../src/state.js'));
  ({ StylePanelController } = await import('../src/ui/style-panel-controller.js'));
  const noop = () => {};
  StylePanelController.bindStylePanelEvents({
    renderAll: noop,
    renderVideoSub: noop,
    refreshMpvSubs: noop,
    drawTimeline: noop,
    refreshStyleSummaries: noop,
    initPresetLibrary: noop,
    styleChanged: noop,
  });
});

beforeEach(() => {
  Object.assign(State, {
    listTrack: 0,
    tracks: [{ name: '對白', visible: true, locked: false }],
    cues: [{ id: 'cue-1', start: 0, end: 1, text: '測試', track: 0 }],
    selectedId: null,
    selectedIds: [],
    presetEdit: null,
  });
});

describe('字幕樣式面板選取守衛', () => {
  it('沒有選取字幕時不提供可寫入整軌的樣式目標', () => {
    expect(StylePanelController.styleTarget()).toBeNull();
  });

  it('沒有選取字幕時停用整個面板並提示先選取字幕', () => {
    StylePanelController.renderTrackStyle();

    const panel = document.getElementById('trackStyle');
    const controls = [...panel.querySelectorAll('button, input, select, textarea')];
    expect(controls.length).toBeGreaterThan(10);
    expect(controls.every(control => control.disabled)).toBe(true);
    expect(panel.classList.contains('selection-disabled')).toBe(true);
    expect(panel.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById('tsTitle').textContent).toBe('字幕樣式｜請先選取字幕');
  });

  it('沒有選取字幕時即使收到輸入事件也不會回退修改整軌', () => {
    State.tracks[0].fontSize = 60;
    StylePanelController.renderTrackStyle();
    const sizeInput = document.getElementById('tsSize');
    sizeInput.value = '120';
    sizeInput.dispatchEvent(new Event('input', { bubbles: true }));

    expect(State.tracks[0].fontSize).toBe(60);
  });

  it('選取字幕後重新啟用面板並只回傳該字幕作為樣式目標', () => {
    StylePanelController.renderTrackStyle();
    State.selectedId = 'cue-1';
    State.selectedIds = ['cue-1'];
    StylePanelController.renderTrackStyle();

    const panel = document.getElementById('trackStyle');
    const controls = [...panel.querySelectorAll('button, input, select, textarea')];
    expect(controls.every(control => !control.disabled)).toBe(true);
    expect(panel.classList.contains('selection-disabled')).toBe(false);
    expect(panel.getAttribute('aria-disabled')).toBe('false');
    expect(StylePanelController.styleTarget()?.cue?.id).toBe('cue-1');
    expect(document.getElementById('tsTitle').textContent).toBe('第 1 句樣式');
  });

  it('選取鎖定軌字幕時樣式面板唯讀且輸入事件不能修改樣式', () => {
    State.tracks[0].locked = true;
    State.selectedId = 'cue-1';
    State.selectedIds = ['cue-1'];
    State.cues[0].style = { fontSize: 60 };
    StylePanelController.renderTrackStyle();

    const panel = document.getElementById('trackStyle');
    const controls = [...panel.querySelectorAll('button, input, select, textarea')];
    const sizeInput = document.getElementById('tsSize');
    expect(controls.every(control => control.disabled)).toBe(true);
    expect(panel.classList.contains('selection-disabled')).toBe(true);
    expect(panel.getAttribute('aria-disabled')).toBe('true');
    expect(StylePanelController.styleTarget()).toBeNull();
    expect(document.getElementById('tsTitle').textContent).toBe('字幕樣式｜軌道已鎖定');

    sizeInput.value = '120';
    sizeInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(State.cues[0].style).toEqual({ fontSize: 60 });
  });

  it('明確編輯常用樣式時只開放樣式欄位，仍停用需要字幕來源的全軌操作', () => {
    State.tracks[0].fontSize = 60;
    State.presetEdit = {
      name: '訪談樣式',
      trackIdx: 0,
      draft: { fontSize: 72 },
    };
    StylePanelController.renderTrackStyle();

    const target = StylePanelController.styleTarget();
    expect(target.trk).toBe(State.presetEdit.draft);
    expect(document.getElementById('tsSize').disabled).toBe(false);
    expect(document.getElementById('tsEditDone').disabled).toBe(false);
    expect(document.getElementById('tsUnify').disabled).toBe(true);
    expect(document.getElementById('tsUnifyExclude').disabled).toBe(true);
    expect(document.getElementById('tsPresetSel').disabled).toBe(true);
    const sizeInput = document.getElementById('tsSize');
    sizeInput.value = '88';
    sizeInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(State.presetEdit.draft.fontSize).toBe(88);
    expect(State.tracks[0].fontSize).toBe(60);
  });
});
