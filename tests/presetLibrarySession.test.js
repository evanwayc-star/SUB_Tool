// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { writeDirectoryFiles } = require('../electron/directory-output.js');
const { collectStyleDirectoryFiles } = require('../electron/style-directory-import.js');

let api, styles, state, ui, styleChanged, syncDraft, directoryRead;
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
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
    <div id="modalBg"><div class="modal"><div id="modalTitle"></div><div id="modalBody"></div><div id="modalFoot"></div></div></div><div id="toast"></div>`;
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
  vi.unstubAllGlobals();
});

function presetImportPicker(channel) {
  const bytes = payload => Buffer.from('\uFEFF' + payload, 'utf16le');
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
  if (channel === 'desktop') {
    const requests = [];
    api.importDirectory = vi.fn(() => {
      const request = deferred(); requests.push(request); return request.promise;
    });
    return (cancelled = false) => {
      click('#preImportBtn');
      const request = requests.at(-1);
      if (cancelled) request.resolve(null);
      return {
        async finish(payload) { request.resolve([{name:'preset.json',b64:bytes(payload).toString('base64')}]); await settle(); },
        async fail() { request.reject(new Error('樣式讀取失敗')); await settle(); },
      };
    };
  }
  api.importDirectory = undefined;
  let picker;
  const readers = [];
  vi.stubGlobal('FileReader', class { readAsArrayBuffer() { readers.push(this); } });
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag, ...options) => {
    const element = create(tag, ...options);
    if (tag === 'input') { picker = element; vi.spyOn(element, 'click').mockImplementation(() => {}); }
    return element;
  });
  return (cancelled = false) => {
    click('#preImportBtn');
    Object.defineProperty(picker, 'files', {value:cancelled ? [] : [new File(['pending'], 'preset.json')], configurable:true});
    if (cancelled) { picker.dispatchEvent(new Event('cancel')); return null; }
    const work = picker.onchange();
    const reader = readers.at(-1);
    return {
      async finish(payload) {
        const data = bytes(payload);
        reader.result = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        reader.onload(); await work;
      },
      async fail() { reader.onerror(); await work; },
    };
  };
}

describe('常用樣式 module 的工作歸屬', () => {
  it.each(['false','reject'])('匯入保存 %s 不假報成功，仍可重新匯入', async failure => {
    const save = vi.fn().mockImplementationOnce(() => failure==='reject' ? Promise.reject(new Error('disk unavailable')) : Promise.resolve(false)).mockResolvedValue(true);
    window.subtool = {configSave:save};
    const begin = presetImportPicker('desktop');
    click('#tsPresetMgr');
    const data=JSON.stringify([{name:'匯入樣式',style:{fontSize:80}}]);
    await begin().finish(data);
    await vi.waitFor(()=>expect(document.getElementById('toast').textContent).toContain('儲存失敗'));
    expect(styles.getPresets()).toEqual([]);
    await begin().finish(data);
    await vi.waitFor(()=>expect(document.getElementById('toast').textContent).toContain('已匯入 1'));
    expect(styles.getPresets()[0].name).toBe('匯入樣式');
  });

  it.each(['rename','folder','delete','delete-folder'])('%s 保存失敗維持原資料與操作資格，重試才成功', async action => {
    const original=[{name:'原名稱',group:'A',style:{fontSize:30}}];
    styles.savePresets(original);
    window.subtool = {configSave:vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)};
    vi.stubGlobal('confirm',()=>true);
    click('#tsPresetMgr');
    if(action==='rename') { click('[data-pre-ren]'); document.getElementById('__presetNameRen').value='新名稱'; }
    if(action==='folder') { click('[data-pre-ren-grp]'); document.getElementById('__presetFolderRen').value='B'; }
    const submit=()=>click(action==='delete' ? '[data-pre-del]' : action==='delete-folder' ? '[data-pre-del-grp]' : '#modalFoot .primary');
    submit();
    await vi.waitFor(()=>expect(document.getElementById('toast').textContent).toContain('儲存失敗'));
    expect(styles.getPresets()).toEqual(original);
    submit();
    await vi.waitFor(()=>expect(window.subtool.configSave).toHaveBeenCalledTimes(2));
    await vi.waitFor(()=>expect(styles.getPresets()).not.toEqual(original));
    if(action==='rename') expect(styles.getPresets()[0].name).toBe('新名稱');
    if(action==='folder') expect(styles.getPresets()[0].group).toBe('B');
    if(action.startsWith('delete')) expect(styles.getPresets()).toEqual([]);
  });

  it('舊刪除失敗後已重開的管理清單同步還原索引，不誤套用別筆樣式', async () => {
    styles.savePresets([{name:'A',style:{fontSize:30}},{name:'B',style:{fontSize:90}}]);
    const pending=deferred(); window.subtool={configSave:()=>pending.promise};
    click('#tsPresetMgr'); click('[data-pre-del="0"]');
    ui.closeModal(); click('#tsPresetMgr');
    expect(document.querySelector('[data-pre-edit="0"]').parentElement.textContent).toContain('B');
    ui.showToast('新視窗'); pending.resolve(false);
    await vi.waitFor(()=>expect(document.querySelector('[data-pre-edit="0"]').parentElement.textContent).toContain('A'));
    expect(document.getElementById('toast').textContent).toBe('新視窗');
    click('[data-pre-apply="1"]');
    expect(state.tracks[0].fontSize).toBe(30);
  });

  it.each(['rename','folder'])('%s 保存期間的新輸入保留，舊完成不關閉而下一次可保存新名稱', async action => {
    styles.savePresets([{name:'原名稱',group:'A',style:{fontSize:30}}]);
    const pending=deferred(); window.subtool={configSave:vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(true)};
    click('#tsPresetMgr'); click(action==='rename' ? '[data-pre-ren]' : '[data-pre-ren-grp]');
    const input=document.getElementById(action==='rename' ? '__presetNameRen' : '__presetFolderRen');
    input.value='第一次'; click('#modalFoot .primary');
    input.value='第二次'; pending.resolve(true);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(input.isConnected).toBe(true); expect(input.value).toBe('第二次');
    click('#modalFoot .primary');
    await vi.waitFor(()=>expect(document.getElementById('modalTitle').textContent).toContain('常用樣式管理'));
    expect(styles.getPresets()[0][action==='rename' ? 'name' : 'group']).toBe('第二次');
  });

  it('草稿保存期間的新編輯不被舊完成套用或關閉，下一次完成保存新草稿', async () => {
    styles.savePresets([{name:'對白',style:{fontSize:30}}]); state.tracks=[{...styles.STYLE_DEFAULTS,fontSize:30}];
    const pending=deferred();
    window.subtool={configSave:vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(true)};
    click('#tsPresetMgr'); click('[data-pre-edit]');
    const draft=state.presetEdit; draft.draft.fontSize=48; click('#tsEditDone');
    syncDraft(); expect(state.presetEdit).toBe(draft);
    draft.draft.fontSize=66; pending.resolve(true);
    await vi.waitFor(()=>expect(draft.saving).toBe(false));
    expect(state.presetEdit).toBe(draft); expect(state.tracks[0].fontSize).toBe(30);
    expect(styles.getPresets()[0].style.fontSize).toBe(48);
    click('#tsEditDone'); await vi.waitFor(()=>expect(state.presetEdit).toBeNull());
    expect(styles.getPresets()[0].style.fontSize).toBe(66); expect(state.tracks[0].fontSize).toBe(66);
  });

  it.each(['cancel','workspace'])('草稿保存已接受後 %s 不撤回庫保存，晚到完成不改新工作區或提示', async action => {
    styles.savePresets([{name:'對白',style:{fontSize:30}}]); state.tracks=[{...styles.STYLE_DEFAULTS,fontSize:30}];
    const pending=deferred(); window.subtool={configSave:()=>pending.promise};
    click('#tsPresetMgr'); click('[data-pre-edit]');
    state.presetEdit.draft.fontSize=48; click('#tsEditDone');
    if(action==='cancel') click('#tsEditCancel');
    else { state.tracks=[{fontSize:20}]; state.cues=[]; syncDraft(); }
    ui.showToast('新工作'); pending.resolve(true);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(styles.getPresets()[0].style.fontSize).toBe(48);
    expect(state.tracks[0].fontSize).toBe(action==='cancel' ? 30 : 20);
    expect(document.getElementById('toast').textContent).toBe('新工作');
  });

  it('草稿持久化失敗不更新字幕、不假報成功，保留草稿供重試', async () => {
    styles.savePresets([{name:'對白',style:{fontSize:30}}]);
    state.tracks = [{...styles.STYLE_DEFAULTS,fontSize:30}];
    window.subtool = {configSave:vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)};
    click('#tsPresetMgr'); click('[data-pre-edit]');
    const draft = state.presetEdit;
    draft.draft.fontSize = 48;
    click('#tsEditDone');
    await vi.waitFor(() => expect(document.getElementById('toast').textContent).toContain('儲存失敗'));
    expect(styles.getPresets()[0].style.fontSize).toBe(30);
    expect(state.tracks[0].fontSize).toBe(30);
    expect(state.presetEdit).toBe(draft);
    click('#tsEditDone');
    await vi.waitFor(() => expect(state.presetEdit).toBeNull());
    expect(styles.getPresets()[0].style.fontSize).toBe(48);
    expect(state.tracks[0].fontSize).toBe(48);
  });

  it.each(['web','desktop'])('同一樣式視窗 %s 較晚完成的舊匯入不能覆寫較新匯入', async channel => {
    const begin = presetImportPicker(channel);
    click('#tsPresetMgr');
    const earlier = begin(), latest = begin();
    await latest.finish(JSON.stringify([{name:'對白😀',group:'字幕',style:{fontSize:80}}]));
    expect(styles.getPresets()[0].style.fontSize).toBe(80);
    await earlier.finish(JSON.stringify([{name:'對白😀',group:'字幕',style:{fontSize:40}}]));
    expect(styles.getPresets()[0].style.fontSize).toBe(80);
  });

  it.each(['web','desktop'].flatMap(channel => ['取消','空樣式清單','毀損JSON','讀取失敗']
    .map(outcome => [channel,outcome])))('同一樣式視窗 %s 較新的%s仍撤銷舊匯入資格', async (channel, outcome) => {
    const original = [{name:'保留樣式😀',style:{fontSize:60}}];
    styles.savePresets(original);
    const begin = presetImportPicker(channel);
    click('#tsPresetMgr');
    const earlier = begin(), latest = begin(outcome === '取消');
    if (outcome === '空樣式清單') await latest.finish('[]');
    else if (outcome === '毀損JSON') await latest.finish('{broken');
    else if (outcome === '讀取失敗') await latest.fail();
    const status = document.getElementById('toast').textContent;
    await earlier.finish(JSON.stringify([{name:'遲到樣式',style:{fontSize:40}}]));
    expect(styles.getPresets()).toEqual(original);
    expect(document.getElementById('toast').textContent).toBe(status);
  });

  it.each(['web','desktop'])('同一樣式視窗 %s 已撤銷匯入的遲到錯誤不改寫較新成功回報', async channel => {
    const begin = presetImportPicker(channel);
    click('#tsPresetMgr');
    const earlier = begin(), latest = begin();
    await latest.finish(JSON.stringify([{name:'較新樣式😀',style:{fontSize:80}}]));
    expect(document.getElementById('toast').textContent).toBe('已匯入 1 組樣式');
    await earlier.fail();
    expect(styles.getPresets()).toEqual([{name:'較新樣式😀',style:{fontSize:80}}]);
    expect(document.getElementById('toast').textContent).toBe('已匯入 1 組樣式');
  });

  it('網頁匯出為 UTF-16LE BOM，重新匯入與舊 UTF-8 檔都保留繁體中文和 emoji', async () => {
    const original = [{name:'片頭😀',group:'節目🎬',style:{font:'思源黑體',fontSize:60}}];
    let downloaded;
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL(blob) { downloaded = blob; return 'blob:presets'; }
      static revokeObjectURL() {}
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    styles.savePresets(original);
    click('#tsPresetMgr'); click('#preExportBtn');
    const bytes = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result));
      reader.onerror = reject;
      reader.readAsArrayBuffer(downloaded);
    });
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(downloaded.type).toBe('application/json;charset=utf-16le');
    expect(JSON.parse(Buffer.from(bytes).toString('utf16le').slice(1))).toEqual(original);

    api.importDirectory = undefined;
    let picker;
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag, ...options) => {
      const element = create(tag, ...options);
      if (tag === 'input') {
        picker = element;
        vi.spyOn(element, 'click').mockImplementation(() => {});
      }
      return element;
    });
    for (const payload of [bytes, new TextEncoder().encode(JSON.stringify(original))]) {
      styles.savePresets([]);
      click('#preImportBtn');
      Object.defineProperty(picker, 'files', {value:[new File([payload], 'presets.json')], configurable:true});
      await picker.onchange();
      expect(styles.getPresets()).toEqual(original);
    }
  });

  it.each([
    ['淨化及大小寫', [
      { name:'對白', group:'A/B', style:{fontSize:40} },
      { name:'對白', group:'A:B', style:{fontSize:50} },
      { name:'News', group:'組別', style:{fontSize:60} },
      { name:'NEWS', group:'組別', style:{fontSize:70} },
      { name:'News (2)', group:'組別', style:{fontSize:80} },
      { name:'A/B', style:{fontSize:90} },
      { name:'A:B', style:{fontSize:100} },
    ]],
    ['檔案與資料夾', [
      { name:'A', style:{fontSize:40} },
      { name:'子樣式', group:'A.json', style:{fontSize:50} },
    ]],
    ['資料夾尾點與空白別名', [
      { name:'對白', group:'組別', style:{fontSize:40} },
      { name:'對白', group:'組別.', style:{fontSize:50} },
      { name:'對白', group:'組別 ', style:{fontSize:60} },
    ]],
    ['繁體中文與emoji', [
      { name:'片頭😀', group:'節目🎬', style:{font:'思源黑體',fontSize:60} },
    ]],
  ])('%s 碰撞的樣式各自寫入，重新匯入保留每筆 identity 與完整樣式', async (_label, original) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-preset-batch-'));
    try {
      styles.savePresets(original);
      api.exportDirectory = vi.fn(async files => {
        expect(writeDirectoryFiles(directory, files)).toEqual({written:original.length,blocked:0});
        return directory;
      });
      click('#tsPresetMgr'); click('#preExportBtn');
      await vi.waitFor(()=>expect(api.exportDirectory).toHaveBeenCalledOnce());
      const files = collectStyleDirectoryFiles(directory);
      const sort = list => list.map(value=>JSON.stringify(value)).sort();
      expect(sort(files.flatMap(file => {
        const bytes = Buffer.from(file.b64, 'base64');
        expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
        return JSON.parse(bytes.toString('utf16le').slice(1));
      }))).toEqual(sort(original));
      styles.savePresets([]);
      click('#preImportBtn'); directoryRead.resolve(files);
      await vi.waitFor(()=>expect(sort(styles.getPresets())).toEqual(sort(original)));
    } finally {
      expect(path.dirname(fs.realpathSync(directory))).toBe(fs.realpathSync(os.tmpdir()));
      fs.rmSync(directory, {recursive:true,force:true});
    }
  });

  it('樣式內明示的群組優先於淨化後資料夾；無群組的舊檔仍從資料夾還原', async () => {
    click('#tsPresetMgr'); click('#preImportBtn');
    directoryRead.resolve([
      {name:'A_B/one.json',b64:Buffer.from(JSON.stringify({name:'同名',group:'A/B',style:{fontSize:40}})).toString('base64')},
      {name:'A_B/two.json',b64:Buffer.from(JSON.stringify({name:'同名',group:'A:B',style:{fontSize:50}})).toString('base64')},
      {name:'舊資料夾/legacy.json',b64:Buffer.from(JSON.stringify({name:'舊樣式',style:{fontSize:60}})).toString('base64')},
    ]);
    await vi.waitFor(()=>expect(styles.getPresets()).toHaveLength(3));
    expect(styles.getPresets().map(p=>[p.group,p.name,p.style.fontSize])).toEqual([
      ['A/B','同名',40],['A:B','同名',50],['舊資料夾','舊樣式',60],
    ]);
  });

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

  it('有效草稿仍能一次完成 preset 與其原有軌道', async () => {
    styles.savePresets([{name:'對白',style:{fontSize:30}}]);
    state.tracks = [{...styles.STYLE_DEFAULTS,fontSize:30}];
    click('#tsPresetMgr'); click('[data-pre-edit]');
    state.presetEdit.draft.fontSize=48;
    click('#tsEditDone');
    await vi.waitFor(() => expect(state.presetEdit).toBeNull());
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
