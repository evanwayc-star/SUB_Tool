// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let api, styles, state, ui, styleChanged, syncDraft, directoryRead;
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function click(selector) {
  const element = document.querySelector(selector);
  expect(element, selector).not.toBeNull();
  element.click();
}

beforeEach(async () => {
  vi.resetModules();
  localStorage.removeItem('subtool.subPresets');
  document.body.innerHTML = `<button id="tsPresetMgr"></button><div id="tsEditBar" hidden><span id="tsEditName"></span></div>
    <button id="tsEditDone"></button><button id="tsEditCancel"></button><input id="tsEditPreviewText">
    <div id="modalBg"><div class="modal"><div id="modalTitle"></div><div id="modalBody"></div><div id="modalFoot"></div></div></div>`;
  directoryRead = deferred();
  api = { importDirectory:vi.fn(()=>directoryRead.promise), configLoad:async()=>({subPresets:[]}), configSave:vi.fn() };
  state = { tracks:[{}], cues:[], presetEdit:null };
  vi.doMock('../src/state.js', () => ({ State:state, DESK:api, IS_DESKTOP:true }));
  vi.doMock('../src/dom.js', () => ({ $:id=>document.getElementById(id) }));
  vi.doMock('../src/media.js', () => ({ Media:{ mpvMode:false } }));
  vi.doMock('../src/media-player-adapter.js', () => ({ getNativePreviewRuntime:()=>({}) }));
  vi.doMock('../src/style-panel-controller.js', () => ({ StylePanelController:{
    styleTarget:()=>({i:0,trk:state.tracks[0],cues:[]}), renderTrackStyle:vi.fn(),
  } }));
  vi.doMock('../src/subtitles.js', () => ({ refreshStyleSummaries:vi.fn() }));
  vi.doMock('../src/history.js', () => ({ recordHistory:vi.fn() }));
  vi.doMock('../src/video-renderer.js', () => ({ renderVideoSub:vi.fn(), refreshMpvSubs:vi.fn() }));
  styles = await import('../src/substyle.js');
  await styles.loadPresets();
  ui = await import('../src/ui.js');
  const { initPresetLibrary } = await import('../src/preset-library.js');
  styleChanged = vi.fn();
  syncDraft = initPresetLibrary({styleChanged});
});

afterEach(() => {
  delete window.subtool;
  vi.restoreAllMocks();
});

describe('常用樣式 module 的工作歸屬', () => {
  it('不同folder同名preset匯入保留兩筆，只更新相同identity',async()=>{
    styles.savePresets([{name:'same',group:'A',style:{fontSize:40}}]);
    click('#tsPresetMgr');click('#preImportBtn');
    directoryRead.resolve([{name:'styles.json',b64:Buffer.from(JSON.stringify([
      {name:'same',group:'B',style:{fontSize:90}},{name:'same',group:'A',style:{fontSize:50}},
    ]),'utf8').toString('base64')}]);
    await vi.waitFor(()=>expect(styles.getPresets()).toHaveLength(2));
    expect(styles.getPresets().map(p=>[p.group,p.style.fontSize])).toEqual([['A',50],['B',90]]);
  });
  it('遲到匯入不能改寫替換後的 dialog 或樣式庫', async () => {
    click('#tsPresetMgr'); click('#preImportBtn');
    ui.openModal('交付', '<div id="delivery-sentinel">保持交付</div>', [{label:'送出',act:()=>{}}]);
    directoryRead.resolve([{ name:'old.json', b64:Buffer.from(JSON.stringify([{name:'遲到',style:{fontSize:80}}]),'utf8').toString('base64') }]);
    await vi.waitFor(() => expect(api.importDirectory).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(document.querySelector('#delivery-sentinel')?.textContent).toBe('保持交付');
    expect(styles.getPresets()).toEqual([]);
    expect(document.getElementById('modalFoot').textContent).toBe('送出');
  });

  it('匯入略過 null / 毀損資料，並安全顯示保留物件鍵的群組', async () => {
    click('#tsPresetMgr'); click('#preImportBtn');
    const values = [null,{name:42},{name:'合法',group:'__proto__',style:{fontSize:44}},
      {name:'另一組',group:'constructor',style:{color:'red" onmouseover="oops'}}];
    directoryRead.resolve([{ name:'styles.json', b64:Buffer.from(JSON.stringify(values),'utf8').toString('base64') }]);
    await vi.waitFor(() => expect(styles.getPresets()).toHaveLength(2));
    expect(document.getElementById('modalBody').textContent).toContain('__proto__');
    expect(document.getElementById('modalBody').textContent).toContain('constructor');
    expect(document.querySelector('[onmouseover]')).toBeNull();
  });

  it('群組改名被另一視窗取代後不會重新開啟管理視窗', async () => {
    styles.savePresets([{name:'對白',group:'資料夾',style:{}}]);
    click('#tsPresetMgr'); click('[data-pre-ren-grp]');
    ui.openModal('交付', '<div id="replacement">新的視窗</div>', []);
    await Promise.resolve();
    expect(document.getElementById('modalTitle').textContent).toBe('交付');
    expect(document.getElementById('replacement')).not.toBeNull();
  });

  it('草稿不能套用到新專案同索引軌或已替換的 preset', () => {
    styles.savePresets([{name:'對白',style:{fontSize:30}}]);
    state.tracks = [{...styles.STYLE_DEFAULTS,fontSize:30}];
    click('#tsPresetMgr'); click('[data-pre-edit]');
    expect(state.presetEdit).not.toBeNull();
    state.presetEdit.draft.fontSize = 88;
    state.tracks = [{fontSize:25}]; state.cues=[];
    click('#tsEditDone');
    expect(state.tracks[0].fontSize).toBe(25);
    expect(styles.getPresets()[0].style.fontSize).toBe(30);
    expect(state.presetEdit).toBeNull();
    expect(document.getElementById('tsEditBar').hidden).toBe(true);
  });

  it('有效草稿仍能一次完成 preset 與其原有軌道', () => {
    styles.savePresets([{name:'對白',style:{fontSize:30}}]);
    state.tracks = [{...styles.STYLE_DEFAULTS,fontSize:30}];
    click('#tsPresetMgr'); click('[data-pre-edit]');
    state.presetEdit.draft.fontSize=48;
    click('#tsEditDone');
    expect(styles.getPresets()[0].style.fontSize).toBe(48);
    expect(state.tracks[0].fontSize).toBe(48);
  });

  it('專案或 Undo 撤銷草稿後，render 也會清除編輯列', () => {
    styles.savePresets([{name:'對白',style:{}}]);
    click('#tsPresetMgr'); click('[data-pre-edit]');
    state.presetEdit=null;
    syncDraft();
    expect(document.getElementById('tsEditBar').hidden).toBe(true);
  });
});
