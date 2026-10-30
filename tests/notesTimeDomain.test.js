// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mediaMock = vi.hoisted(() => ({
  displayTime: vi.fn(() => 105),
  vTime: vi.fn(() => 15),
  seek: vi.fn(),
}));

vi.mock('../src/media.js', () => ({ Media: mediaMock }));
vi.mock('../src/timeline-renderer.js', () => ({ updatePlayhead: vi.fn(), drawRuler: vi.fn() }));
vi.mock('../src/history.js', async importOriginal => ({ ...await importOriginal(), recordHistory: vi.fn() }));
vi.mock('../src/ui.js', () => ({
  showToast: vi.fn(),
  setStatus: vi.fn(),
  openModal: vi.fn(),
  closeModal: vi.fn(),
}));
vi.mock('../src/menus.js', () => ({ showCtx: vi.fn() }));
vi.mock('../src/subio.js', () => ({ executeBatchExport: vi.fn() }));

let State;
let addNote;

describe('note time domain', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    document.body.innerHTML = `
      <div id="notesPanel"></div>
      <div id="notesList"></div>
    `;
    ({ State } = await import('../src/state.js'));
    ({ addNote } = await import('../src/notes.js'));
    State.notes = [];
    State.fps = 25;
    mediaMock.displayTime.mockClear();
    mediaMock.vTime.mockClear();
  });

  it('stores a new note at the timeline playhead', () => {
    addNote();

    expect(State.notes).toHaveLength(1);
    expect(State.notes[0].time).toBe(105);
    expect(mediaMock.displayTime).toHaveBeenCalled();
    expect(mediaMock.vTime).not.toHaveBeenCalled();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('新增空白備註時不開啟面板，也不搶走影片編輯焦點', () => {
    const editingSurface = document.createElement('button');
    editingSurface.type = 'button';
    editingSurface.textContent = '影片編輯區';
    document.body.appendChild(editingSurface);
    editingSurface.focus();

    addNote();
    vi.advanceTimersByTime(50);

    const noteText = document.querySelector('.note-item .nt-text');
    expect({
      noteText: State.notes[0]?.text,
      panelOpened: document.getElementById('notesPanel').classList.contains('show'),
      noteEditable: noteText?.getAttribute('contenteditable'),
      activeElement: document.activeElement,
    }).toEqual({
      noteText: '',
      panelOpened: false,
      noteEditable: 'false',
      activeElement: editingSurface,
    });

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('在已有備註的時間點上再次新增備註，會刪除該時間點的備註', () => {
    // 第一次：在 t=105 新增備註
    addNote();
    expect(State.notes).toHaveLength(1);
    expect(State.notes[0].time).toBe(105);

    // 第二次：在同一時間點 t=105 再次新增，應刪除備註
    addNote();
    expect(State.notes).toHaveLength(0);

    // 第三次：再次執行，應重新新增備註
    addNote();
    expect(State.notes).toHaveLength(1);
    expect(State.notes[0].time).toBe(105);

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each(['\n', '\r\n', '\r'])('一般 CSV 將 %j 備註換行攤平，保留每筆資料的三個欄位', async newline => {
    const { getNotesGeneralFileData } = await import('../src/notes.js');
    State.notes = [
      { time: 2, text: `第一段${newline}第二段`, done: false },
      { time: 3, text: '另一筆備註', done: true },
    ];
    try {
      const file = getNotesGeneralFileData();
      const bytes = Buffer.from(file.content, 'base64');
      expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
      expect(file.mime).toBe('text/csv;charset=utf-16le');
      const records = bytes.toString('utf16le').replace(/^\uFEFF/, '')
        .split(/\r\n|\r|\n/).map(row => row.split(','));
      expect(records).toEqual([
        ['狀態', '時間', '內容'],
        ['K', '00:00:02:00', '第一段 第二段'],
        ['V', '00:00:03:00', '另一筆備註'],
      ]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each(['getNotesGeneralFileData', 'getNotesEdiusFileData'])('%s 以 UTF-16LE BOM 保存繁體中文、emoji 與 CSV 引號', async exportName => {
    const notes = await import('../src/notes.js');
    State.notes = [{ time: 2, text: '中文😀，備註,"引號"', done: false }];
    try {
      const file = notes[exportName]();
      const bytes = Buffer.from(file.content, 'base64');
      expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
      expect(file.mime).toBe('text/csv;charset=utf-16le');
      expect(bytes.toString('utf16le').slice(1)).toContain('"中文😀，備註,""引號"""');
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
