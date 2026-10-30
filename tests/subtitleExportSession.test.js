// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let State, Project, UI, showExportDialog, exportNotes;
const desktop = { isDesktop: true, fontsList: vi.fn().mockResolvedValue({ fonts: [] }),
  exportSub: vi.fn().mockResolvedValue(null), exportDirectory: vi.fn().mockResolvedValue(null) };
const data = label => ({ app: 'SUB Tool', version: 3, fps: 25, media: {}, clips: [],
  tracks: [{ name: label + '第一軌' }, { name: label + '第二軌' }],
  cues: [{ track: 1, start: 0, end: 1, text: label + '第一句' },
    { track: 2, start: 1, end: 2, text: label + '第二句' }],
  notes: [{ time: 0, text: label + '備註' }] });
const input = label => ({ path: `C:/projects/${label}.subtool`, b64: Buffer.from(JSON.stringify(data(label))).toString('base64') });
const confirmButton = () => document.querySelector('#modalFoot .primary');

beforeAll(async () => {
  document.body.innerHTML = new DOMParser().parseFromString(fs.readFileSync(path.resolve('index.html'), 'utf8'), 'text/html').body.innerHTML;
  window.subtool = desktop;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLMediaElement.prototype.pause = vi.fn(); HTMLMediaElement.prototype.load = vi.fn();
  HTMLCanvasElement.prototype.getContext = () => new Proxy({ measureText() { return { width: this.font?.includes('"') ? 2 : 1 }; },
    createLinearGradient: () => ({ addColorStop() {} }) },
  { get: (object, key) => object[key] || (() => {}), set: (object, key, value) => (object[key] = value, true) });
  ({ State } = await import('../src/state.js'));
  ({ Project } = await import('../src/project.js'));
  UI = await import('../src/ui.js');
  ({ showExportDialog } = await import('../src/subio.js'));
  ({ exportNotes } = await import('../src/notes.js'));
});
beforeEach(async () => {
  UI.closeModal();
  await Project.loadDesktop(input('原專案'));
  desktop.exportSub.mockClear(); desktop.exportDirectory.mockClear();
});
afterAll(() => { UI.closeModal(); vi.clearAllTimers(); });

function openExport(kind) {
  if (kind === '字幕') {
    showExportDialog();
    for (const checkbox of document.querySelectorAll('[data-fmt]')) checkbox.checked = checkbox.dataset.fmt === 'srt';
    document.querySelector('[data-tk="1"]').checked = false;
  } else {
    exportNotes();
    document.getElementById('expNoteEdius').checked = false;
    document.getElementById('expNoteGeneral').checked = true;
  }
}

it.each(['字幕', '備註'])('%s 舊匯出視窗不能在外部開啟另一個專案後提交新資料', async kind => {
  openExport(kind);
  const oldButton = confirmButton();
  // Matches app.onOpenFile: a clean workspace admits the supplied desktop file
  // without replacing the already open export dialog with a discard prompt.
  await Project.open(async () => input('新專案'));
  expect(State.cues[0].text).toBe('新專案第一句');
  expect(confirmButton()).toBe(oldButton);
  expect(document.getElementById('modalBg').classList.contains('show')).toBe(true);
  oldButton.click();
  expect(desktop.exportSub).not.toHaveBeenCalled();
  expect(desktop.exportDirectory).not.toHaveBeenCalled();
  expect(document.getElementById('modalBg').classList.contains('show')).toBe(false);
  expect(document.getElementById('toast').textContent).toContain('專案已變更');
  openExport(kind); confirmButton().click();
  expect(desktop.exportSub).toHaveBeenCalledTimes(1);
  const bytes = Buffer.from(desktop.exportSub.mock.calls[0][1], 'base64');
  expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
  const contents = bytes.toString('utf16le').slice(1);
  expect(contents).toContain(kind === '字幕' ? '新專案第一句' : '新專案備註');
  expect(contents).not.toContain('原專案');
});

it.each(['字幕', '備註'])('%s 在原專案仍有效時匯出使用者選擇的實際內容', async kind => {
  openExport(kind); confirmButton().click();
  expect(desktop.exportSub).toHaveBeenCalledTimes(1);
  const [, b64, ext] = desktop.exportSub.mock.calls[0];
  const bytes = Buffer.from(b64, 'base64');
  expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
  const contents = bytes.toString('utf16le').slice(1);
  expect(contents).toContain(kind === '字幕' ? '原專案第一句' : '原專案備註');
  expect(contents).not.toContain('原專案第二句');
  expect(ext).toBe(kind === '字幕' ? 'srt' : 'csv');
  expect(desktop.exportDirectory).not.toHaveBeenCalled();
});
