// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let State, setSelection, Styles, StylePanelController, UI;

function clickModal(label) {
  const button = [...document.querySelectorAll('#modalFoot button')].find(item => item.textContent === label);
  expect(button).toBeTruthy();
  button.click();
}

function renameFolder(from, to) {
  document.getElementById('tsPresetMgr').click();
  const button = [...document.querySelectorAll('[data-pre-ren-grp]')].find(item => item.dataset.preRenGrp === from);
  expect(button).toBeTruthy();
  button.click();
  document.getElementById('__presetFolderRen').value = to;
  clickModal('確定');
}

function applyPreset(group, name) {
  const select = document.getElementById('tsPresetSel');
  const option = [...select.options].find(item => item.value === Styles.presetIdentity({ group, name }));
  expect(option).toBeTruthy();
  select.value = option.value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  localStorage.clear();
  delete window.subtool;
  const source = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
  document.body.innerHTML = new DOMParser().parseFromString(source, 'text/html').body.innerHTML;
  ({ State, setSelection } = await import('../src/state.js'));
  Styles = await import('../src/substyle.js');
  ({ StylePanelController } = await import('../src/style-panel-controller.js'));
  UI = await import('../src/ui.js');
  const noop = () => {};
  StylePanelController.bindStylePanelEvents({
    renderAll: noop, renderVideoSub: noop, refreshMpvSubs: noop, drawTimeline: noop,
    refreshStyleSummaries: noop, initPresetLibrary: noop, styleChanged: noop,
  });
  const { initPresetLibrary } = await import('../src/preset-library.js');
  initPresetLibrary({ styleChanged: noop });
  Object.assign(State, {
    listTrack: 0, tracks: [{ name: '對白', visible: true, locked: false }],
    cues: [{ id: 'cue-1', start: 0, end: 1, text: '測試', track: 0, style: { fontSize: 100 } }],
    presetEdit: null, clips: [], notes: [], externalAudioState: [],
  });
  setSelection({ kind: 'sub', ids: ['cue-1'] });
  Styles.savePresets([]);
  StylePanelController.renderTrackStyle();
});

afterEach(() => {
  UI?.closeModal({ committed: true });
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('常用樣式公開操作的 identity 保全', () => {
  it('資料夾改名不能讓兩筆同名樣式變成同一個選項識別', () => {
    const original = [
      { name: '同名', group: 'A', style: { fontSize: 40 } },
      { name: '同名', group: 'B', style: { fontSize: 120 } },
    ];
    Styles.savePresets(original);
    StylePanelController.renderTrackStyle();
    renameFolder('A', 'B');

    expect.soft(Styles.getPresets()).toEqual(original);
    expect.soft(new Set(Styles.getPresets().map(Styles.presetIdentity)).size).toBe(2);
    expect.soft(document.getElementById('__presetFolderRen')?.value).toBe('B');
    expect.soft(document.getElementById('toast').textContent).toContain('同名');
    UI.closeModal({ committed: true });
    applyPreset('B', '同名');
    expect(State.cues[0].style.fontSize).toBe(120);
  });

  it('沒有同名衝突時仍可合併資料夾，兩筆選项各自套用正確樣式', () => {
    Styles.savePresets([
      { name: '中文', group: 'A', style: { fontSize: 40 } },
      { name: '英文', group: 'B', style: { fontSize: 120 } },
    ]);
    StylePanelController.renderTrackStyle();
    renameFolder('A', 'B');
    expect(Styles.getPresets().map(item => [item.group, item.name])).toEqual([['B', '中文'], ['B', '英文']]);
    UI.closeModal({ committed: true });
    applyPreset('B', '中文');
    expect(State.cues[0].style.fontSize).toBe(40);
    applyPreset('B', '英文');
    expect(State.cues[0].style.fontSize).toBe(120);
  });

  it('公開存為常用操作的尾端連字號名稱，重新載入仍保留原樣式', async () => {
    document.getElementById('tsPresetSave').click();
    document.getElementById('__presetName').value = '字幕-';
    document.getElementById('__presetGroup').value = '';
    clickModal('儲存');
    await Promise.resolve();
    await Promise.resolve();
    const saved = structuredClone(Styles.getPresets());
    expect(saved.map(item => item.name)).toEqual(['字幕-']);

    vi.resetModules();
    const restarted = await import('../src/substyle.js');
    expect(await restarted.loadPresets()).toEqual(saved);
    expect(restarted.getAllPresets().map(item => item.name)).toEqual(['預設', '字幕-']);
    expect(JSON.parse(localStorage.getItem('subtool.subPresets'))).toEqual(saved);
  });

  it.each([false, true])('舊名称遷移撞現有 identity 時保留兩筆原資料（desktop=%s）', async desktop => {
    const original = [
      { name: 'A-同名', style: { fontSize: 40 } },
      { name: '同名', group: 'A', style: { fontSize: 120 } },
      { name: '舊版-合法', style: { fontSize: 70 } },
    ];
    Styles.savePresets(original);
    let persisted = JSON.parse(localStorage.getItem('subtool.subPresets'));
    if (desktop) window.subtool = {
      configLoad: async () => ({ subPresets: structuredClone(persisted) }),
      configSave: patch => { persisted = structuredClone(patch.subPresets); },
    };
    vi.resetModules();
    const restarted = await import('../src/substyle.js');
    const loaded = await restarted.loadPresets();
    expect(loaded).toEqual([
      original[0], original[1], { name: '合法', group: '舊版', style: { fontSize: 70 } },
    ]);
    expect(new Set(loaded.map(restarted.presetIdentity)).size).toBe(loaded.length);
    expect(desktop ? persisted : JSON.parse(localStorage.getItem('subtool.subPresets'))).toEqual(loaded);
  });

  it.each([false, true])('舊名称遷移拆出內建保留名時保留原條目（desktop=%s）', async desktop => {
    const original = [
      { name: '影片-預設', style: { fontSize: 40 } },
      { name: '舊版-合法', style: { fontSize: 70 } },
    ];
    Styles.savePresets(original);
    let persisted = JSON.parse(localStorage.getItem('subtool.subPresets'));
    if (desktop) window.subtool = {
      configLoad: async () => ({ subPresets: structuredClone(persisted) }),
      configSave: patch => { persisted = structuredClone(patch.subPresets); },
    };
    vi.resetModules();
    const restarted = await import('../src/substyle.js');
    const loaded = await restarted.loadPresets();
    expect(loaded).toEqual([original[0], { name: '合法', group: '舊版', style: { fontSize: 70 } }]);
    expect(restarted.getAllPresets().map(item => item.name)).toEqual(['預設', '影片-預設', '合法']);
    expect(desktop ? persisted : JSON.parse(localStorage.getItem('subtool.subPresets'))).toEqual(loaded);
  });

  it('完整列舉大量選项並保留跨群同名、保留物件鍵與 HTML 名稱', () => {
    const presets = Array.from({ length: 90 }, (_, index) => ({
      name: index % 3 === 0 ? '同名' : `樣式 <${index}> & "`,
      group: index === 0 ? '__proto__' : index === 1 ? 'constructor' : `資料夾 ${index}`,
      style: { fontSize: 40 + index },
    }));
    Styles.savePresets(presets);
    StylePanelController.renderTrackStyle();
    const options = [...document.querySelectorAll('#tsPresetSel option')];
    expect(options).toHaveLength(presets.length + 2);
    expect(new Set(options.map(item => item.value)).size).toBe(options.length);
    for (const preset of presets) {
      expect(options.find(item => item.value === Styles.presetIdentity(preset))?.textContent).toBe(preset.name);
    }
    expect(document.querySelector('#tsPresetSel [onmouseover]')).toBeNull();
    document.getElementById('tsPresetMgr').click();
    expect(document.querySelectorAll('[data-pre-apply]')).toHaveLength(presets.length + 1);
  });
});
