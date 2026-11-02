// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui.js', () => ({renderCurrentTimecode:vi.fn(),
  setStatus: vi.fn(),
  showToast: vi.fn(),
}));

import { State } from '../src/state.js';
import * as stateModule from '../src/state.js';
import { showSettingsModal } from '../src/settings.js';
import { showToast, setStatus } from '../src/ui.js';

describe('快捷鍵設定視窗的匯入工作歸屬', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    State.keymap = { toggle_play_pause: [{ key: ' ' }] };
    State.defaultKeymap = { toggle_play_pause: [{ key: ' ' }] };
    vi.clearAllMocks();
  });
  afterEach(() => {
    document.getElementById('settingsCancelBtn')?.click();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const recordKey = key => document.getElementById('settings-input-toggle_play_pause-0')
    .dispatchEvent(new KeyboardEvent('keydown', { key, bubbles:true, cancelable:true }));

  it.each(['Backspace', 'Delete'])('刪除第一組（%s）後，衝突標示對準仍在第二欄的綁定，後續編輯可儲存並重載', async deleteKey => {
    State.defaultKeymap = { toggle_play_pause:[{key:' '},{key:'enter'}], rewind:[{key:'j'}] };
    State.keymap = structuredClone(State.defaultKeymap);
    const input = (action, index) => document.getElementById(`settings-input-${action}-${index}`);
    const press = (action, index, key) => input(action, index)
      .dispatchEvent(new KeyboardEvent('keydown', {key, bubbles:true, cancelable:true}));
    const previousScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    try {
      showSettingsModal();
      press('toggle_play_pause', 0, deleteKey);
      expect(input('toggle_play_pause', 0).value).toBe('');
      expect(input('toggle_play_pause', 1).value).toBe('Enter');
      press('rewind', 0, 'Enter');
      expect(input('toggle_play_pause', 1).classList.contains('flash-duplicate')).toBe(true);
      expect(input('toggle_play_pause', 0).classList.contains('flash-duplicate')).toBe(false);
      expect(input('rewind', 0).value).toBe('J');
      expect(State.keymap).toEqual(State.defaultKeymap);

      press('toggle_play_pause', 0, 'q');
      press('toggle_play_pause', 1, deleteKey);
      press('toggle_play_pause', 2, 'w');
      await document.getElementById('settingsSaveBtn').onclick();
      const expected = {toggle_play_pause:[{key:'q'},{key:'w'}],rewind:[{key:'j'}]};
      expect(State.keymap).toEqual(expected);
      expect(JSON.parse(localStorage.getItem('subtool_keys'))).toEqual(expected);
      State.keymap = structuredClone(State.defaultKeymap);
      await stateModule.loadKeys();
      expect(State.keymap).toEqual(expected);
      showSettingsModal();
      expect([0,1,2].map(index => input('toggle_play_pause', index).value)).toEqual(['Q','W','']);
    } finally {
      if (previousScrollIntoView) HTMLElement.prototype.scrollIntoView = previousScrollIntoView;
      else delete HTMLElement.prototype.scrollIntoView;
    }
  });

  it('持久化失敗保留原快捷鍵與草稿，重試成功才套用及宣稱已儲存', async () => {
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('QuotaExceeded'); });
    showSettingsModal();
    recordKey('q');
    const modal = document.getElementById('settingsModal');
    await document.getElementById('settingsSaveBtn').onclick();
    expect(State.keymap.toggle_play_pause).toEqual([{key:' '}]);
    expect(document.getElementById('settingsModal')).toBe(modal);
    expect(document.getElementById('settings-input-toggle_play_pause-0').value).toBe('Q');
    expect(document.getElementById('settingsSaveBtn').disabled).toBe(false);
    expect(setStatus).not.toHaveBeenCalledWith('快捷鍵設定已儲存', 'ok');
    expect(setStatus).toHaveBeenCalledWith(expect.stringContaining('儲存失敗'), 'err');

    await document.getElementById('settingsSaveBtn').onclick();
    expect(write).toHaveBeenCalledTimes(2);
    expect(JSON.parse(localStorage.getItem('subtool_keys')).toggle_play_pause).toEqual([{key:'q'}]);
    expect(State.keymap.toggle_play_pause).toEqual([{key:'q'}]);
    expect(document.getElementById('settingsModal')).toBeNull();
    expect(setStatus).toHaveBeenCalledWith('快捷鍵設定已儲存', 'ok');
  });

  it.each([true, false])('送出後鎖住編輯、取消與重開，持久化結果為 %s 時保持儲存語意', async result => {
    let resolveSave;
    const save = vi.spyOn(stateModule, 'saveKeys').mockImplementation(() => new Promise(resolve => { resolveSave = resolve; }));
    showSettingsModal(); recordKey('q');
    const modal = document.getElementById('settingsModal');
    const button = document.getElementById('settingsSaveBtn');
    const pending = button.onclick();
    expect(State.keymap.toggle_play_pause).toEqual([{key:' '}]);
    expect([...modal.querySelectorAll('input, button')].every(control => control.disabled)).toBe(true);
    expect(save).toHaveBeenCalledWith({toggle_play_pause:[{key:'q'}]});
    await button.onclick();
    recordKey('w');
    document.getElementById('settingsRestoreBtn').onclick();
    document.getElementById('settingsCancelBtn').onclick();
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}));
    showSettingsModal();
    expect(document.getElementById('settingsModal')).toBe(modal);
    expect(save).toHaveBeenCalledOnce();
    expect(document.getElementById('settings-input-toggle_play_pause-0').value).toBe('Q');
    resolveSave(result); await pending;
    expect(State.keymap.toggle_play_pause).toEqual([{key:result ? 'q' : ' '}]);
    if (result) expect(document.getElementById('settingsModal')).toBeNull();
    else {
      expect(document.getElementById('settingsModal')).toBe(modal);
      expect(document.getElementById('settingsSaveBtn').disabled).toBe(false);
      expect(document.getElementById('settings-input-undo-0').disabled).toBe(true);
      document.getElementById('settingsCancelBtn').click();
      expect(document.getElementById('settingsModal')).toBeNull();
    }
  });

  it('持久化意外reject也解鎖並保留草稿，不回報成功', async () => {
    vi.spyOn(stateModule, 'saveKeys').mockRejectedValue(new Error('IPC closed'));
    showSettingsModal(); recordKey('q');
    await document.getElementById('settingsSaveBtn').onclick();
    expect(State.keymap.toggle_play_pause).toEqual([{key:' '}]);
    expect(document.getElementById('settings-input-toggle_play_pause-0').value).toBe('Q');
    expect(document.getElementById('settingsSaveBtn').disabled).toBe(false);
    expect(setStatus).toHaveBeenCalledWith(expect.stringContaining('IPC closed'), 'err');
    expect(setStatus).not.toHaveBeenCalledWith('快捷鍵設定已儲存', 'ok');
  });

  it('快捷鍵 JSON 以 UTF-16LE BOM 下載，匯入後按儲存能保留中文快捷鍵', async () => {
    State.keymap = {toggle_play_pause:[{key:'中'}]};
    let downloaded;
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL(blob) { downloaded = blob; return 'blob:keymap'; }
      static revokeObjectURL() {}
    });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      showSettingsModal();
      document.getElementById('settingsExportBtn').click();
      const bytes = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(new Uint8Array(reader.result));
        reader.onerror = reject;
        reader.readAsArrayBuffer(downloaded);
      });
      expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
      expect(downloaded.type).toBe('application/json;charset=utf-16le');
      expect(JSON.parse(Buffer.from(bytes).toString('utf16le').slice(1))).toEqual({
        _type:'subtool-keymap',version:1,keymap:{toggle_play_pause:[{key:'中'}]},
      });
      const input = document.getElementById('settingsImportFile');
      document.getElementById('settingsImportBtn').click();
      Object.defineProperty(input, 'files', {configurable:true,value:[new File([bytes], 'keymap.json')]});
      input.dispatchEvent(new Event('change', {bubbles:true}));
      await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining('已匯入')));
      await document.getElementById('settingsSaveBtn').onclick();
      expect(State.keymap.toggle_play_pause).toEqual([{key:'中'}]);
    } finally {
      anchorClick.mockRestore();
    }
  });

  it('刪光快捷鍵後匯出再匯入仍保持停用，匯出不改動目前草稿的欄位索引', async () => {
    State.defaultKeymap = {
      toggle_play_pause:[{key:' '},{key:'enter'}], rewind:[{key:'j'},{key:'h'}], forward:[{key:'l'}],
    };
    State.keymap = structuredClone(State.defaultKeymap);
    let downloaded;
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL(blob) { downloaded = blob; return 'blob:keymap'; }
      static revokeObjectURL() {}
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const previousScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const input = (action, index) => document.getElementById(`settings-input-${action}-${index}`);
    const press = (action, index, key) => input(action, index)
      .dispatchEvent(new KeyboardEvent('keydown', {key, bubbles:true, cancelable:true}));
    try {
      showSettingsModal();
      press('toggle_play_pause', 0, 'Backspace');
      press('toggle_play_pause', 1, 'Delete');
      press('rewind', 0, 'Backspace');
      document.getElementById('settingsExportBtn').click();
      const bytes = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(new Uint8Array(reader.result));
        reader.onerror = reject;
        reader.readAsArrayBuffer(downloaded);
      });
      const expected = {toggle_play_pause:[],rewind:[{key:'h'}],forward:[{key:'l'}]};
      expect(JSON.parse(Buffer.from(bytes).toString('utf16le').slice(1)).keymap).toEqual(expected);
      press('forward', 0, 'h');
      expect(input('rewind', 1).value).toBe('H');
      expect(input('rewind', 1).classList.contains('flash-duplicate')).toBe(true);
      expect(input('rewind', 0).classList.contains('flash-duplicate')).toBe(false);
      expect(State.keymap).toEqual(State.defaultKeymap);

      const fileInput = document.getElementById('settingsImportFile');
      document.getElementById('settingsImportBtn').click();
      Object.defineProperty(fileInput, 'files', {configurable:true,value:[new File([bytes], 'disabled-keymap.json')]});
      fileInput.dispatchEvent(new Event('change', {bubbles:true}));
      await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining('已匯入')));
      await document.getElementById('settingsSaveBtn').onclick();
      expect(State.keymap).toEqual(expected);
      expect(JSON.parse(localStorage.getItem('subtool_keys'))).toEqual(expected);
      State.keymap = structuredClone(State.defaultKeymap);
      await stateModule.loadKeys();
      expect(State.keymap).toEqual(expected);
    } finally {
      if (previousScrollIntoView) HTMLElement.prototype.scrollIntoView = previousScrollIntoView;
      else delete HTMLElement.prototype.scrollIntoView;
    }
  });

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

    await document.getElementById('settingsSaveBtn').onclick();
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
    await document.getElementById('settingsSaveBtn').onclick();
    expect(State.keymap.toggle_play_pause).toEqual([{ key: ' ' }]);
  });
});
