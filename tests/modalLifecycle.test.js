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
});
afterEach(() => { vi.useRealTimers(); delete window.subtool; });

describe('modal lifecycle ownership', () => {
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

  it('clears only the displayed source and ignores its completion after the source changes', async () => {
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
    io.resolve({ bytes: 100 });
    await action;
    expect(document.getElementById('toast').textContent).not.toContain('已清除快取');
  });

  it('reports successful cleanup for the confirmed source', async () => {
    const { State } = await import('../src/state.js');
    State.mediaPath = 'C:/media/original.mp4';
    window.subtool = { cacheInfo: vi.fn().mockResolvedValue({ folders: 2 }),
      cacheClearAll: vi.fn().mockResolvedValue({ bytes: 100 }) };
    await ui.openCacheDialog();
    document.querySelectorAll('#modalFoot button')[1].click();
    await document.querySelector('#modalFoot .primary').onclick();
    expect(window.subtool.cacheClearAll).toHaveBeenCalledExactlyOnceWith('C:/media/original.mp4');
    expect(document.getElementById('modalBg').classList.contains('show')).toBe(false);
    expect(document.getElementById('toast').textContent).toBe('已清除快取，釋放 100 B');
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
