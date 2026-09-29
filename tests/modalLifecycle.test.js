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
