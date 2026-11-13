// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/media.js', () => ({ Media: { mpvMode: false } }));
vi.mock('../src/media-player-adapter.js', () => ({ getNativePreviewRuntime: vi.fn() }));
let ui;
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="modalBg"><div class="modal"><div id="modalTitle"></div><div id="modalBody"></div><div id="modalFoot"></div></div></div><div id="toast"></div>';
  ui = await import('../src/ui.js');
  const {State}=await import('../src/state.js');State.mediaPath='C:/media/original.mp4';
});
afterEach(() => { vi.useRealTimers(); delete window.subtool; });

describe('modal lifecycle ownership', () => {
  it('浮動面板開啟只聚焦中性容器，不預選按鈕或輸入框；關閉返回原操作',()=>{
    const trigger=document.createElement('button');trigger.setAttribute('aria-controls','notesPanel');
    const panel=document.createElement('div');panel.id='notesPanel';panel.className='float-panel';
    panel.innerHTML='<button>歸零</button><input aria-label="篩選">';
    for(const element of panel.children) Object.defineProperty(element,'offsetParent',{get:()=>panel});
    document.body.append(trigger,panel);trigger.focus();
    ui.togglePanel('notesPanel');vi.runAllTimers();
    expect(document.activeElement).toBe(panel);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    ui.closePanel('notesPanel');
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
  it('連續切換浮動面板只聚焦最後一個，關閉仍回到工作區來源',()=>{
    const trigger=document.createElement('button');document.body.append(trigger);trigger.focus();
    for(const id of ['notesPanel','historyPanel']){
      const panel=document.createElement('div');panel.id=id;panel.className='float-panel';document.body.append(panel);
    }
    ui.togglePanel('notesPanel');vi.runAllTimers();
    ui.togglePanel('historyPanel');vi.runAllTimers();
    expect(document.activeElement.id).toBe('historyPanel');
    expect(document.getElementById('notesPanel').classList.contains('show')).toBe(false);
    ui.closePanel('historyPanel');expect(document.activeElement).toBe(trigger);
  });
  it('浮動面板開啟後立刻關閉或被modal取代，不讓延遲聚焦搶走新視窗',()=>{
    const panel=document.createElement('div');panel.id='notesPanel';panel.className='float-panel';document.body.append(panel);
    ui.togglePanel('notesPanel');ui.closePanel('notesPanel');vi.runAllTimers();
    expect(document.activeElement).not.toBe(panel);
    ui.togglePanel('notesPanel');ui.openModal('較新的視窗','');
    document.querySelector('.modal').tabIndex=-1;vi.runAllTimers();
    expect(document.activeElement).toBe(document.querySelector('.modal'));
  });
  it('無素材時不查中央快取，清除停用且不發出清理 IPC',async()=>{
    const {State}=await import('../src/state.js');State.mediaPath=null;
    window.subtool={cacheInfo:vi.fn(async()=>({root:'C:/cache',folders:0,bytes:0})),cacheClearAll:vi.fn()};
    await ui.openCacheDialog();
    expect(window.subtool.cacheInfo).not.toHaveBeenCalled();
    const button=[...document.querySelectorAll('#modalFoot button')].find(button=>button.textContent==='清除快取');
    expect(button.disabled).toBe(true);button.click();
    expect(window.subtool.cacheClearAll).not.toHaveBeenCalled();
    expect(document.getElementById('modalBody').textContent).toContain('先開啟素材');
  });
  it('快取清除沿用畫面顯示的來源，來源先變更時不能另確認新素材',async()=>{
    const {State}=await import('../src/state.js');State.mediaPath='C:/old.mov';
    window.subtool={cacheInfo:vi.fn(async()=>({source:{path:'C:/old.mov',locations:[]}})),cacheClearAll:vi.fn()};
    await ui.openCacheDialog();State.mediaPath='C:/new.mov';
    [...document.querySelectorAll('#modalFoot button')].find(button=>button.textContent==='清除快取').click();
    expect(document.getElementById('modalBg').classList.contains('show')).toBe(false);
    expect(window.subtool.cacheClearAll).not.toHaveBeenCalled();
    expect(document.getElementById('toast').textContent).toContain('影片已變更');
  });
  it('清除中關閉再開共用原工作，不能重送，完成顯示在目前快取視窗',async()=>{
    const {State}=await import('../src/state.js');State.mediaPath='C:/current.mov';
    const gate=deferred();window.subtool={cacheInfo:vi.fn(async()=>({source:{path:State.mediaPath,locations:[{
      directory:'C:/.subtool_Cache/current',kind:'sidecar',waveform:{state:'complete'},proxy:true,channels:2,
    }]}})),cacheClearAll:vi.fn(()=>gate.promise)};
    await ui.openCacheDialog();
    [...document.querySelectorAll('#modalFoot button')].find(button=>button.textContent==='清除快取').click();
    const pending=document.getElementById('cacheClearConfirm').onclick();
    ui.closeModal();await ui.openCacheDialog();
    const clear=[...document.querySelectorAll('#modalFoot button')].find(button=>button.textContent.startsWith('清除'));
    expect(clear.disabled).toBe(true);clear.click();
    expect(window.subtool.cacheInfo).toHaveBeenCalledOnce();
    expect(window.subtool.cacheClearAll).toHaveBeenCalledExactlyOnceWith('C:/current.mov');
    expect(document.getElementById('modalBody').textContent).toContain('清除中');
    expect(document.querySelector('.cache-records').textContent).toContain('已有完整紀錄');
    gate.resolve({bytes:100,incomplete:false});await pending;await Promise.resolve();
    expect(document.getElementById('modalTitle').textContent).toBe('轉檔快取');
    expect(document.getElementById('modalBody').textContent).toContain('已清除快取，釋放 100 B');
    expect(document.querySelector('.cache-records')).toBeNull();
    expect(document.querySelector('.cache-source-summary').textContent).toContain('快取已清除，重新整理可查看最新保存紀錄。');
    expect(document.querySelector('.cache-source-summary').textContent).toContain('C:/current.mov');
    expect(window.subtool.cacheInfo).toHaveBeenCalledOnce();
    ui.closeModal();await ui.openCacheDialog();
    expect(window.subtool.cacheInfo).toHaveBeenCalledTimes(2);
    expect(document.getElementById('cacheClear').disabled).toBe(false);
    expect(document.getElementById('cacheActionStatus').hidden).toBe(true);
  });
  it('背景處理的拒絕結果說明忙碌原因，不能聲稱已清除',async()=>{
    const {State}=await import('../src/state.js');State.mediaPath='C:/current.mov';
    window.subtool={cacheInfo:vi.fn(async()=>({source:{path:State.mediaPath,locations:[]}})),cacheClearAll:vi.fn(async()=>({bytes:0,incomplete:true,reason:'busy'}))};
    await ui.openCacheDialog();
    [...document.querySelectorAll('#modalFoot button')].find(button=>button.textContent==='清除快取').click();
    await document.getElementById('cacheClearConfirm').onclick();
    expect(document.getElementById('modalBody').textContent).toContain('快取仍在處理或使用中，請完成或停止後再清除');
    expect(document.getElementById('toast').textContent).not.toContain('已清除');
    expect(document.getElementById('modalBg').classList.contains('show')).toBe(true);
  });
  it('關閉後已移到另一個面板的焦點不會被遲到的還原搶走',()=>{
    const trigger=document.createElement('button');
    const next=document.createElement('select');
    document.body.append(trigger,next);
    document.querySelector('.modal').tabIndex=-1;
    trigger.focus();
    ui.openModal('設定','');
    vi.runAllTimers();
    expect(document.activeElement).toBe(document.querySelector('.modal'));
    ui.closeModal();
    next.focus();
    vi.runAllTimers();
    expect(document.activeElement).toBe(next);
  });
  it('快取查詢失敗後可重新整理，清除期間不重複送出且錯誤留在視窗內可重試',async()=>{
    const {State}=await import('../src/state.js');State.mediaPath='C:/current.mov';
    const info=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({source:{path:State.mediaPath,locations:[]}});
    let fail;const cleanup=new Promise((_resolve,reject)=>{fail=reject;});
    window.subtool={cacheInfo:info,cacheClearAll:vi.fn().mockReturnValueOnce(cleanup).mockResolvedValue({bytes:100,incomplete:false})};
    await ui.openCacheDialog();
    const refresh=document.getElementById('cacheRefresh');expect(refresh).not.toBeNull();
    await refresh.onclick();expect(info).toHaveBeenCalledTimes(2);
    document.getElementById('cacheClear').click();
    const clean=document.getElementById('cacheClearConfirm');
    const pending=clean.onclick();await clean.onclick();
    expect(window.subtool.cacheClearAll).toHaveBeenCalledOnce();expect(clean.disabled).toBe(true);
    fail(new Error('busy'));await pending;
    expect(clean.disabled).toBe(false);
    expect(document.getElementById('cacheActionError').textContent).toContain('busy');
    expect(document.getElementById('cacheActionError').hidden).toBe(false);
    await clean.onclick();
    expect(window.subtool.cacheClearAll).toHaveBeenCalledTimes(2);
    expect(document.getElementById('cacheActionError').hidden).toBe(true);
    expect(document.getElementById('cacheActionStatus').textContent).toContain('已清除快取');
  });
  it('快取視窗只列目前素材同資料夾的保存進度，舊中央回覆不進畫面',async()=>{
    const {State}=await import('../src/state.js');State.mediaPath='C:/NAS/movie.mov';
    window.subtool={cacheInfo:vi.fn(async()=>({root:'C:/local',folders:0,bytes:0,source:{path:State.mediaPath,locations:[{
      directory:'C:/NAS/.subtool_Cache/abc',kind:'sidecar',waveform:{state:'partial',completedSamples:20000,totalSamples:40000,verified:false},proxy:false,channels:0,
    },{directory:'C:/local/old-central',kind:'central',waveform:{state:'complete'},proxy:true,channels:8}]}}))};
    await ui.openCacheDialog();
    expect(window.subtool.cacheInfo).toHaveBeenCalledWith('C:/NAS/movie.mov');
    const text=document.getElementById('modalBody').textContent;
    expect(text).toContain('同資料夾快取');expect(text).toContain('5.0 / 10.0 秒');
    expect(text).toContain('使用前重新驗證');expect(text).toContain('C:/NAS/.subtool_Cache/abc');
    expect(text).not.toContain('C:/local');expect(text).not.toContain('中央快取');
  });
  it('查詢期間換來源時不顯示舊素材快取或提供清除資格',async()=>{
    const {State}=await import('../src/state.js');State.mediaPath='C:/old.mov';
    const gate=deferred();window.subtool={cacheInfo:()=>gate.promise};
    const opening=ui.openCacheDialog();State.mediaPath='C:/new.mov';gate.resolve({folders:0,bytes:0});await opening;
    expect(document.getElementById('modalBg').classList.contains('show')).toBe(false);
    expect(document.getElementById('toast').textContent).toContain('影片已變更');
  });
  it('目前素材快取查詢整體失敗不顯示未找到紀錄',async()=>{
    const {State}=await import('../src/state.js');State.mediaPath='C:/movie.mov';
    window.subtool={cacheInfo:vi.fn(async()=>{throw new Error('worker unavailable');})};
    await ui.openCacheDialog();const text=document.getElementById('modalBody').textContent;
    expect(text).toContain('無法確認目前素材');expect(text).not.toContain('尚未找到屬於目前素材');
  });
  it('does not clear a newly opened source through an older cache confirmation', async () => {
    const { State } = await import('../src/state.js');
    State.mediaPath = 'C:/media/original.mp4';
    window.subtool = { cacheInfo: vi.fn().mockResolvedValue({ folders: 2 }),
      cacheClearAll: vi.fn().mockResolvedValue({ bytes: 100 }) };
    await ui.openCacheDialog();
    document.getElementById('cacheClear').click();
    const confirm = document.querySelector('#modalFoot .primary');
    // An OS project-open intent can replace the source while this modal remains visible.
    State.mediaPath = 'C:/media/new-project.mp4';
    await confirm.onclick();
    expect(window.subtool.cacheClearAll).not.toHaveBeenCalled();
    expect(document.getElementById('toast').textContent).toContain('影片已變更');
  });

  it.each([{ bytes: 100 }, { bytes: 100, incomplete: true }, { bytes: 100, incomplete: false }])
  ('clears only the displayed source and ignores its completion after the source changes', async result => {
    const { State } = await import('../src/state.js');
    State.mediaPath = 'C:/media/original.mp4';
    const io = deferred();
    window.subtool = { cacheInfo: vi.fn().mockResolvedValue({ folders: 2 }),
      cacheClearAll: vi.fn(() => io.promise) };
    await ui.openCacheDialog();
    document.getElementById('cacheClear').click();
    expect(document.getElementById('modalBody').textContent).toContain('C:/media/original.mp4');
    const action = document.querySelector('#modalFoot .primary').onclick();
    await document.querySelector('#modalFoot .primary').onclick();
    await Promise.resolve();
    expect(window.subtool.cacheClearAll).toHaveBeenCalledWith('C:/media/original.mp4');
    expect(window.subtool.cacheClearAll).toHaveBeenCalledOnce();
    State.mediaPath = 'C:/media/new-project.mp4';
    io.resolve(result);
    await action;
    expect(document.getElementById('toast').textContent).not.toContain('已清除快取');
    expect(document.getElementById('toast').textContent).not.toContain('已處理快取');
    expect(document.getElementById('toast').textContent).not.toContain('已處理部分快取');
  });

  it('reports successful cleanup for the confirmed source', async () => {
    const { State } = await import('../src/state.js');
    State.mediaPath = 'C:/media/original.mp4';
    window.subtool = { cacheInfo: vi.fn().mockResolvedValue({ folders: 2 }),
      cacheClearAll: vi.fn().mockResolvedValue({ bytes: 100, incomplete: false }) };
    await ui.openCacheDialog();
    document.getElementById('cacheClear').click();
    await document.querySelector('#modalFoot .primary').onclick();
    expect(window.subtool.cacheClearAll).toHaveBeenCalledExactlyOnceWith('C:/media/original.mp4');
    expect(document.getElementById('modalBg').classList.contains('show')).toBe(true);
    expect(document.getElementById('cacheActionStatus').textContent).toBe('已清除快取，釋放 100 B');
    expect(document.getElementById('cacheClearConfirm').disabled).toBe(true);
    expect(document.getElementById('toast').textContent).toBe('已清除快取，釋放 100 B');
  });

  it.each([
    [{ bytes: 100, incomplete: true }, '已處理部分快取，釋放 100 B；部分項目仍在使用或無法確認，已保留'],
    [{ bytes: 100 }, '已處理快取，釋放 100 B'],
  ])('clearAll 報告部分或舊版未知結果，不聲稱全部清除', async (result, message) => {
    const { State } = await import('../src/state.js');
    State.mediaPath = 'C:/media/original.mp4';
    window.subtool = { cacheInfo: vi.fn().mockResolvedValue({ folders: 2 }),
      cacheClearAll: vi.fn().mockResolvedValue(result) };
    await ui.openCacheDialog();
    document.getElementById('cacheClear').click();
    await document.querySelector('#modalFoot .primary').onclick();
    expect(window.subtool.cacheClearAll).toHaveBeenCalledExactlyOnceWith('C:/media/original.mp4');
    expect(document.getElementById('toast').textContent).toBe(message);
  });

  it('resolves dismissed and replaced prompts as cancellation', async () => {
    const first = ui.promptModal('First', 'Name');
    document.getElementById('modalBg').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await expect(first).resolves.toBeNull();
    const second = ui.promptModal('Second', 'Name');
    ui.openModal('Other', '<p>Other</p>');
    await expect(second).resolves.toBeNull();
    expect(document.getElementById('modalTitle').textContent).toBe('Other');
  });

  it('commits the input without treating confirmation as cancellation', async () => {
    const prompt = ui.promptModal('Name', 'Name', ' original ');
    document.getElementById('__promptInput').value = ' new name ';
    document.querySelector('#modalFoot .primary').click();
    await expect(prompt).resolves.toBe('new name');
  });

  it('keeps a dialog opened by onDismiss visible and ignores old close handles', () => {
    const old = ui.openModal('First', '', [], { onDismiss: () => ui.openModal('Next', '<p>Next</p>') });
    ui.closeModal();
    old.close();
    expect(document.getElementById('modalBg').classList.contains('show')).toBe(true);
    expect(document.getElementById('modalTitle').textContent).toBe('Next');
  });

  it('does not replace another dialog when cache information arrives late', async () => {
    const io = deferred();
    window.subtool = { cacheInfo: () => io.promise };
    const cache = ui.openCacheDialog();
    ui.openModal('Export', '<p>Keep export settings</p>');
    io.resolve({ folders: 2, bytes: 123, root: 'cache' });
    await cache;
    expect(document.getElementById('modalTitle').textContent).toBe('Export');
    expect(document.getElementById('modalBody').textContent).toBe('Keep export settings');
  });

  it.each(['unavailable', 'error'])('source cache %s does not falsely show zero items', async condition => {
    window.subtool = { cacheInfo: condition === 'error'
      ? vi.fn().mockRejectedValue(new Error('access denied'))
      : vi.fn().mockResolvedValue({ source: { path:'C:/media/original.mp4', unavailable: true } }) };
    await ui.openCacheDialog();
    const text = document.getElementById('modalBody').textContent;
    expect(text).toContain('無法確認目前素材');
    expect(text).not.toContain('尚未找到屬於目前素材');
  });

  it('does not replace another dialog when cache information fails late', async () => {
    let reject;
    window.subtool = { cacheInfo: () => new Promise((_resolve, fail) => { reject = fail; }) };
    const cache = ui.openCacheDialog();
    ui.openModal('Export', '<p>Keep export settings</p>');
    reject(new Error('access denied'));
    await cache;
    expect(document.getElementById('modalTitle').textContent).toBe('Export');
    expect(document.getElementById('modalBody').textContent).toBe('Keep export settings');
  });

  it.each(['success','failure'])('does not overwrite another dialog after source cleanup %s', async result => {
    const io = deferred();
    window.subtool = { cacheInfo: vi.fn().mockResolvedValue({ source:{path:'C:/media/original.mp4',locations:[]} }),
      cacheClearAll:async()=>{await io.promise;if(result==='failure')throw new Error('late failure');return {bytes:100,incomplete:false};} };
    await ui.openCacheDialog();
    document.getElementById('cacheClear').click();
    const action = document.getElementById('cacheClearConfirm').onclick();
    ui.openModal('Export', '<p>Keep</p>');
    io.resolve();
    await action;
    expect(document.getElementById('modalTitle').textContent).toBe('Export');
    expect(document.getElementById('modalBody').textContent).toBe('Keep');
    expect(document.getElementById('toast').textContent).toBe('');
    expect(window.subtool.cacheInfo).toHaveBeenCalledOnce();
  });
});
