// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui.js', () => ({
  setStatus: vi.fn(),
  showToast: vi.fn(),
}));

import { State } from '../src/state.js';
import { showSettingsModal } from '../src/settings.js';
import { showToast } from '../src/ui.js';

describe('快捷鍵設定視窗的匯入工作歸屬', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    State.keymap = { toggle_play_pause: [{ key: ' ' }] };
    State.defaultKeymap = { toggle_play_pause: [{ key: ' ' }] };
    vi.clearAllMocks();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('已取消的舊視窗匯入完成時，不改寫新視窗的暫存設定', async () => {
    showSettingsModal();
    const oldInput = document.getElementById('settingsImportFile');
    document.getElementById('settingsImportBtn').click();

    document.getElementById('settingsCancelBtn').click();
    showSettingsModal();
    const currentModal = document.getElementById('settingsModal');

    const file = new File([
      JSON.stringify({ _type: 'subtool-keymap', version: 1, keymap: { toggle_play_pause: [{ key: 'q' }] } }),
    ], 'old-keymap.json', { type: 'application/json' });
    Object.defineProperty(oldInput, 'files', { configurable: true, value: [file] });
    oldInput.dispatchEvent(new Event('change', { bubbles: true }));

    await new Promise(resolve => setTimeout(resolve, 40));
    expect(document.getElementById('settingsModal')).toBe(currentModal);
    expect(document.getElementById('settings-input-toggle_play_pause-0').value).toBe('Space');
    expect(showToast).not.toHaveBeenCalledWith(expect.stringContaining('已匯入'));

    document.getElementById('settingsSaveBtn').click();
    expect(State.keymap.toggle_play_pause).toEqual([{ key: ' ' }]);
  });

  it('檔案已選但讀取尚未完成時關閉視窗，也不提交舊匯入', async () => {
    let reader;
    let notifyReadStarted;
    const readStarted = new Promise(resolve => { notifyReadStarted = resolve; });
    vi.stubGlobal('FileReader', class {
      readAsArrayBuffer() { reader = this; notifyReadStarted(); }
    });
    showSettingsModal();
    const oldInput = document.getElementById('settingsImportFile');
    const importButton = document.getElementById('settingsImportBtn');
    const startImport = importButton.onclick;
    let importing;
    importButton.onclick = event => { importing = startImport.call(importButton, event); };
    importButton.click();
    const file = new File(['unused'], 'pending.json', { type: 'application/json' });
    Object.defineProperty(oldInput, 'files', { configurable: true, value: [file] });
    oldInput.dispatchEvent(new Event('change', { bubbles: true }));
    // File picker orchestration may have several microtasks; wait for the read actually to start.
    await readStarted;
    expect(reader).toBeTruthy();

    document.getElementById('settingsCancelBtn').click();
    showSettingsModal();
    const json = JSON.stringify({ keymap: { toggle_play_pause: [{ key: 'q' }] } });
    reader.result = new TextEncoder().encode(json).buffer;
    reader.onload();
    await importing;

    expect(showToast).not.toHaveBeenCalledWith(expect.stringContaining('已匯入'));
    document.getElementById('settingsSaveBtn').click();
    expect(State.keymap.toggle_play_pause).toEqual([{ key: ' ' }]);
  });
});
