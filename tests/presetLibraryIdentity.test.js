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
  it.each(['false','reject'])('公開存為常用保存 %s 保留輸入，重試後才關閉並回報成功', async failure => {
    window.subtool={configSave:vi.fn().mockImplementationOnce(()=>failure==='reject' ? Promise.reject(new Error('disk unavailable')) : Promise.resolve(false)).mockResolvedValue(true)};
    document.getElementById('tsPresetSave').click();
    document.getElementById('__presetName').value='新常用';
    clickModal('儲存');
    await vi.waitFor(()=>expect(document.getElementById('toast').textContent).toContain('儲存失敗'));
    expect(Styles.getPresets()).toEqual([]);
    expect(document.getElementById('__presetName').value).toBe('新常用');
    clickModal('儲存');
    await vi.waitFor(()=>expect(document.getElementById('toast').textContent).toContain('已儲存常用樣式'));
    expect(Styles.getPresets()[0].name).toBe('新常用');
    expect(document.getElementById('modalBg').classList.contains('show')).toBe(false);
  });

  it('兩次公開新增保存回覆倒序，第二次磁碟快照保留第一個已接受樣式', async () => {
    const replies=[]; let disk=[];
    window.subtool={configSave:vi.fn(patch=>{disk=structuredClone(patch.subPresets);return new Promise(resolve=>replies.push(resolve));})};
    document.getElementById('tsPresetSave').click(); document.getElementById('__presetName').value='A'; clickModal('儲存');
    clickModal('取消');
    document.getElementById('tsPresetSave').click(); document.getElementById('__presetName').value='B'; clickModal('儲存');
    expect(disk.map(p=>p.name)).toEqual(['A','B']);
    replies[1](true);
    await vi.waitFor(()=>expect(document.getElementById('toast').textContent).toContain('已儲存常用樣式：B'));
    replies[0](true); await Promise.resolve(); await Promise.resolve();
    expect(Styles.getPresets()).toEqual(disk);
    expect(document.getElementById('toast').textContent).toContain('已儲存常用樣式：B');
  });

  it('覆蓋確認保存失敗保留原樣式與確認資格，重試只提交一次', async () => {
    Styles.savePresets([{name:'已有樣式',style:{fontSize:30}}]);
    window.subtool={configSave:vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)};
    document.getElementById('tsPresetSave').click(); document.getElementById('__presetName').value='已有樣式'; clickModal('儲存');
    clickModal('覆蓋'); clickModal('覆蓋');
    await vi.waitFor(()=>expect(document.getElementById('toast').textContent).toContain('儲存失敗'));
    expect(window.subtool.configSave).toHaveBeenCalledOnce();
    expect(Styles.getPresets()[0].style.fontSize).toBe(30);
    expect(document.getElementById('modalTitle').textContent).toBe('名稱已存在');
    clickModal('覆蓋'); await vi.waitFor(()=>expect(document.getElementById('modalBg').classList.contains('show')).toBe(false));
    expect(Styles.getPresets()[0].style.fontSize).toBe(100);
    expect(window.subtool.configSave).toHaveBeenCalledTimes(2);
  });

  it('已接受新增在舊視窗關閉後失敗，目前管理清單立即移除該樣式', async () => {
    let finish; window.subtool={configSave:()=>new Promise(resolve=>{finish=resolve;})};
    document.getElementById('tsPresetSave').click(); document.getElementById('__presetName').value='未保存'; clickModal('儲存');
    document.getElementById('tsPresetMgr').click();
    expect(document.querySelector('[data-pre-del="0"]')).not.toBeNull();
    UI.showToast('目前管理視窗'); finish(false);
    await vi.waitFor(()=>expect(document.querySelector('[data-pre-del="0"]')).toBeNull());
    expect(Styles.getPresets()).toEqual([]);
    expect(document.getElementById('modalTitle').textContent).toContain('常用樣式管理');
    expect(document.getElementById('toast').textContent).toBe('目前管理視窗');
  });

  it('保存期間輸入新名稱不被舊完成關閉，第二次仍能新增新名稱', async () => {
    let finish; window.subtool={configSave:vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValue(true)};
    document.getElementById('tsPresetSave').click(); document.getElementById('__presetName').value='A'; clickModal('儲存');
    document.getElementById('__presetName').value='B'; finish(true);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(document.getElementById('modalBg').classList.contains('show')).toBe(true);
    expect(document.getElementById('__presetName').value).toBe('B');
    clickModal('儲存'); await vi.waitFor(()=>expect(document.getElementById('modalBg').classList.contains('show')).toBe(false));
    expect(Styles.getPresets().map(p=>p.name)).toEqual(['A','B']);
  });

  it.each([30, 77])('完成草稿保留較新貼上的樣式欄位（貼上字級 %s）', async pastedSize => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new Proxy({
      measureText: () => ({ width: 1 }), createLinearGradient: () => ({ addColorStop() {} }),
    }, { get: (target, key) => target[key] || (() => {}) }));
    const { History } = await import('../src/history.js');
    const { copySelectedStyle, pasteStyleToSelected } = await import('../src/subtitles.js');
    const old = { ...Styles.STYLE_DEFAULTS, fontSize: 30, color: '#ff0000' };
    State.tracks = [{ ...old, name: '對白', visible: true, locked: false }];
    State.cues = [
      { id: 'target', start: 0, end: 2, track: 0, text: '目標', style: { ...old } },
      { id: 'clipboard', start: 3, end: 4, track: 0, text: '樣式來源', style: { fontSize: pastedSize, color: '#00ff00' } },
    ];
    Styles.savePresets([{ name: '共用', style: old }]);
    History.reset();
    setSelection({ kind: 'sub', ids: ['clipboard'] }); copySelectedStyle();
    setSelection({ kind: 'sub', ids: ['target'] });
    StylePanelController.renderTrackStyle();
    document.getElementById('tsPresetMgr').click();
    document.querySelector('[data-pre-edit="0"]').click();
    State.presetEdit.draft.fontSize = 48;
    pasteStyleToSelected();
    document.getElementById('tsEditDone').click();
    await vi.waitFor(() => expect(State.presetEdit).toBeNull());

    expect(Styles.getPresets()[0].style.fontSize).toBe(48);
    expect(State.tracks[0].fontSize).toBe(48);
    expect(Styles.effStyle(State.cues[0], State.tracks[0])).toMatchObject({
      fontSize: pastedSize === 30 ? 48 : 77, color: '#00ff00',
    });
    History.undo();
    expect(Styles.effStyle(State.cues[0], State.tracks[0])).toMatchObject({ fontSize: pastedSize, color: '#00ff00' });
    expect(State.tracks[0].fontSize).toBe(30);
  });

  it('網頁匯出以十四位時間戳命名實際下載', () => {
    vi.setSystemTime(new Date('2026-10-16T08:07:09Z'));
    vi.stubGlobal('URL', Object.assign(class extends URL {}, {
      createObjectURL: vi.fn(() => 'blob:preset-export'), revokeObjectURL: vi.fn(),
    }));
    let downloaded;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { downloaded = this.download; });
    try {
      Styles.savePresets([{ name: '對白', style: { fontSize: 48 } }]);
      document.getElementById('tsPresetMgr').click();
      document.getElementById('preExportBtn').click();
      expect(downloaded).toBe('presets_20261016080709.json');
    } finally { vi.unstubAllGlobals(); }
  });

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

  it('沒有同名衝突時仍可合併資料夾，兩筆選项各自套用正確樣式', async () => {
    Styles.savePresets([
      { name: '中文', group: 'A', style: { fontSize: 40 } },
      { name: '英文', group: 'B', style: { fontSize: 120 } },
    ]);
    StylePanelController.renderTrackStyle();
    renameFolder('A', 'B');
    await vi.waitFor(() => expect(document.getElementById('modalTitle').textContent).toContain('常用樣式管理'));
    expect(Styles.getPresets().map(item => [item.group, item.name])).toEqual([['B', '中文'], ['B', '英文']]);
    UI.closeModal({ committed: true });
    applyPreset('B', '中文');
    expect(State.cues[0].style.fontSize).toBe(40);
    applyPreset('B', '英文');
    expect(State.cues[0].style.fontSize).toBe(120);
  });

  it.each(['字幕-','Title-Blue'])('公開存為常用操作的連字號名稱 %s，重新載入仍保留原樣式', async name => {
    document.getElementById('tsPresetSave').click();
    document.getElementById('__presetName').value = name;
    document.getElementById('__presetGroup').value = '';
    clickModal('儲存');
    await Promise.resolve();
    await Promise.resolve();
    const saved = structuredClone(Styles.getPresets());
    expect(saved.map(item => item.name)).toEqual([name]);

    vi.resetModules();
    const restarted = await import('../src/substyle.js');
    expect(await restarted.loadPresets()).toEqual(saved);
    expect(restarted.getAllPresets().map(item => item.name)).toEqual(['預設', name]);
    expect(JSON.parse(localStorage.getItem('subtool.subPresets'))).toEqual(saved);
  });

  it.each([false, true])('連字號 literal 名稱與分群 identity 均保留原資料（desktop=%s）', async desktop => {
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
    expect(loaded).toEqual(original);
    expect(new Set(loaded.map(restarted.presetIdentity)).size).toBe(loaded.length);
    expect(desktop ? persisted : JSON.parse(localStorage.getItem('subtool.subPresets'))).toEqual(loaded);
  });
  it('公開管理員改名成中間連字號後，重新啟動仍有相同identity與樣式',async()=>{
    Styles.savePresets([{name:'original',style:{fontSize:120,color:'#112233'}}]);StylePanelController.renderTrackStyle();
    document.getElementById('tsPresetMgr').click();document.querySelector('[data-pre-ren="0"]').click();
    document.getElementById('__presetNameRen').value='Title-Blue';clickModal('儲存');
    const saved=structuredClone(Styles.getPresets()),identity=Styles.presetIdentity(saved[0]);
    expect(saved[0].name).toBe('Title-Blue');vi.resetModules();const restarted=await import('../src/substyle.js');
    expect(await restarted.loadPresets()).toEqual(saved);expect(restarted.presetIdentity(restarted.getPresets()[0])).toBe(identity);
  });

  it.each([false, true])('連字號名稱含內建保留名時仍保留原條目（desktop=%s）', async desktop => {
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
    expect(loaded).toEqual(original);
    expect(restarted.getAllPresets().map(item => item.name)).toEqual(['預設', '影片-預設', '舊版-合法']);
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
