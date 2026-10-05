/** @vitest-environment jsdom */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let State;
let StylePanelController;
let savePresets;
let loadKeys;

beforeAll(async () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
  const parsed = new DOMParser().parseFromString(source, 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;
  ({ State, loadKeys } = await import('../src/state.js'));
  ({ StylePanelController } = await import('../src/style-panel-controller.js'));
  ({ savePresets } = await import('../src/substyle.js'));
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
  it('持久化快捷鍵中的錯誤綁定會正規化，設定重啟後仍能格式化全部動作',async()=>{
    const original=structuredClone(State.keymap);
    localStorage.setItem('subtool_keys',JSON.stringify({toggle_play_pause:[{key:42},{key:'P',ctrl:true}],step_boundary_prev:[{code:[]}],step_boundary_next:[]}));
    try {
      await loadKeys();
      const {formatBind}=await import('../src/keybinding-engine.js');
      expect(State.keymap.toggle_play_pause).toEqual([{key:'p',ctrl:true}]);
      expect(State.keymap.step_boundary_prev).toEqual(State.defaultKeymap.step_boundary_prev);
      expect(State.keymap.step_boundary_next).toEqual([]);
      expect(()=>Object.values(State.keymap).flat().map(formatBind)).not.toThrow();
    } finally { State.keymap=original;localStorage.removeItem('subtool_keys'); }
  });
  it('合法樣式資料夾使用物件保留字時仍能渲染下拉選單', async () => {
    await savePresets([
      {name:'樣式 A',group:'__proto__',style:{fontSize:72}},
      {name:'樣式 B',group:'constructor',style:{fontSize:60}},
    ]);
    try {
      StylePanelController.renderTrackStyle();
      const groups=[...document.querySelectorAll('#tsPresetSel optgroup')];
      expect(groups.map(group=>group.label)).toEqual(['📁 __proto__','📁 constructor']);
      const {presetIdentity}=await import('../src/substyle.js');
      expect(groups.map(group=>group.querySelector('option').value)).toEqual([
        presetIdentity({name:'樣式 A',group:'__proto__'}),presetIdentity({name:'樣式 B',group:'constructor'}),
      ]);
    } finally { await savePresets([]); }
  });
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
