// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

vi.mock('../src/media.js', () => ({ Media: { mpvMode: false } }));
vi.mock('../src/media-player-adapter.js', () => ({ getNativePreviewRuntime: vi.fn() }));
let ui;
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const require = createRequire(import.meta.url);
const { FileAuthority } = require('../electron/file-authority');
const { createMediaIntakeRuntime } = require('../electron/media-intake-runtime');

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="modalBg"><div class="modal"><div id="modalTitle"></div><div id="modalBody"></div><div id="modalFoot"></div></div></div><div id="toast"></div>';
  ui = await import('../src/ui.js');
});
afterEach(() => { vi.useRealTimers(); delete window.subtool; });

describe('modal lifecycle ownership', () => {
  it('快取視窗列目前素材的共享保存進度，清楚區分中央用量與待重驗紀錄',async()=>{
    const {State}=await import('../src/state.js');State.mediaPath='C:/NAS/movie.mov';
    window.subtool={cacheInfo:vi.fn(async()=>({root:'C:/local',folders:0,bytes:0,source:{path:State.mediaPath,locations:[{
      directory:'C:/NAS/.subtool_Cache/abc',kind:'sidecar',waveform:{state:'partial',completedSamples:20000,totalSamples:40000,verified:false},proxy:false,channels:0,
    }]}}))};
    await ui.openCacheDialog();
    expect(window.subtool.cacheInfo).toHaveBeenCalledWith('C:/NAS/movie.mov');
    const text=document.getElementById('modalBody').textContent;
    expect(text).toContain('同資料夾快取');expect(text).toContain('5.0 / 10.0 秒');
    expect(text).toContain('使用前重新驗證');expect(text).toContain('C:/NAS/.subtool_Cache/abc');
    expect(text).not.toContain('此處管理的是本機的中央快取');
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
    document.querySelectorAll('#modalFoot button')[1].click();
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
    document.querySelectorAll('#modalFoot button')[1].click();
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
    document.querySelectorAll('#modalFoot button')[1].click();
    await document.querySelector('#modalFoot .primary').onclick();
    expect(window.subtool.cacheClearAll).toHaveBeenCalledExactlyOnceWith('C:/media/original.mp4');
    expect(document.getElementById('modalBg').classList.contains('show')).toBe(false);
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
    document.querySelectorAll('#modalFoot button')[1].click();
    await document.querySelector('#modalFoot .primary').onclick();
    expect(window.subtool.cacheClearAll).toHaveBeenCalledExactlyOnceWith('C:/media/original.mp4');
    expect(document.getElementById('toast').textContent).toBe(message);
  });

  it('真快取 runtime 保留超出深度限制的目錄時，UI 明確回報部分保留', async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-ui-cleanup-'));
    const cacheRoot = path.join(root, 'cache'), tempRoot = path.join(root, 'temp');
    let runtime;
    try {
      fs.mkdirSync(cacheRoot); fs.mkdirSync(tempRoot);
      let nested = path.join(cacheRoot, 'large'); fs.mkdirSync(nested);
      for (let depth = 0; depth < 50; depth++) { nested = path.join(nested, 'd'); fs.mkdirSync(nested); }
      const protectedFile = path.join(nested, 'wave.bin'); fs.writeFileSync(protectedFile, 'kept cache');
      runtime = createMediaIntakeRuntime({ cacheRoot, tempRoot, allowSidecarCache: false,
        fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
        ffmpegExecution: { async execute() {} } });
      const { State } = await import('../src/state.js'); State.mediaPath = null;
      window.subtool = { cacheInfo: vi.fn(async () => runtime.cacheInfo()),
        cacheClearAll: vi.fn(async source => runtime.clearAll(source)) };
      await ui.openCacheDialog();
      document.querySelectorAll('#modalFoot button')[1].click();
      await document.querySelector('#modalFoot .primary').onclick();
      expect(fs.readFileSync(protectedFile, 'utf8')).toBe('kept cache');
      expect(document.getElementById('toast').textContent)
        .toBe('已處理部分快取，釋放 0 B；部分項目仍在使用或無法確認，已保留');
    } finally {
      await runtime?.close();
      const resolved = fs.realpathSync(root);
      if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('subtool-ui-cleanup-')) throw new Error('拒絕刪除測試目錄以外資料');
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });

  it.each([
    [{ removed: 1, bytes: 100, incomplete: true }, '已清理 1 個無效項目，釋放 100 B；部分項目仍在使用或無法確認，已保留'],
    [{ removed: 1, bytes: 100 }, '已處理孤兒快取，清理 1 個項目，釋放 100 B'],
    [{ removed: 1, bytes: 100, incomplete: false }, '已清理 1 個無效項目，釋放 100 B'],
  ])('清理孤兒項目依實際可確認程度回報', async (result, message) => {
    window.subtool = { cacheInfo: vi.fn().mockResolvedValue({ folders: 2 }),
      cacheCleanOrphans: vi.fn().mockResolvedValue(result) };
    await ui.openCacheDialog();
    await document.querySelector('#modalFoot button').onclick();
    expect(window.subtool.cacheCleanOrphans).toHaveBeenCalledOnce();
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

  it.each(['unavailable', 'error'])('central cache %s does not falsely show zero items', async condition => {
    window.subtool = { cacheInfo: condition === 'error'
      ? vi.fn().mockRejectedValue(new Error('access denied'))
      : vi.fn().mockResolvedValue({ root: 'C:/cache', unavailable: true }) };
    await ui.openCacheDialog();
    const text = document.getElementById('modalBody').textContent;
    expect(text).toContain('無法確認中央快取狀態');
    expect(text).not.toMatch(/中央快取：\s*0/);
  });

  it('central root is replaced: real runtime and dialog report unavailable without inspecting replacement', async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-ui-info-'));
    const cacheRoot = path.join(root, 'cache'), tempRoot = path.join(root, 'temp');
    let runtime;
    try {
      fs.mkdirSync(cacheRoot); fs.mkdirSync(tempRoot);
      runtime = createMediaIntakeRuntime({ cacheRoot, tempRoot, allowSidecarCache: false,
        fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
        ffmpegExecution: { async execute() {} } });
      fs.renameSync(cacheRoot, path.join(root, 'old-cache'));
      fs.mkdirSync(cacheRoot); fs.mkdirSync(path.join(cacheRoot, 'foreign'));
      fs.writeFileSync(path.join(cacheRoot, 'foreign', 'important.txt'), 'keep foreign');
      window.subtool = { cacheInfo: vi.fn(async () => runtime.cacheInfo()) };
      await ui.openCacheDialog();
      expect(document.getElementById('modalBody').textContent).toContain('無法確認中央快取狀態');
      expect(fs.readFileSync(path.join(cacheRoot, 'foreign', 'important.txt'), 'utf8')).toBe('keep foreign');
    } finally {
      await runtime?.close();
      const resolved = fs.realpathSync(root);
      if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('subtool-ui-info-')) throw new Error('拒絕刪除測試目錄以外資料');
      fs.rmSync(resolved, { recursive: true, force: true });
    }
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

  it('does not reopen the cache dialog after cleanup finishes behind a new dialog', async () => {
    const io = deferred();
    window.subtool = { cacheInfo: vi.fn().mockResolvedValue({ folders: 2 }), cacheCleanOrphans: () => io.promise };
    await ui.openCacheDialog();
    const action = document.querySelector('#modalFoot button').onclick();
    ui.openModal('Export', '<p>Keep</p>');
    io.resolve({ removed: 1, bytes: 100 });
    await action;
    expect(document.getElementById('modalTitle').textContent).toBe('Export');
    expect(window.subtool.cacheInfo).toHaveBeenCalledOnce();
  });
});
