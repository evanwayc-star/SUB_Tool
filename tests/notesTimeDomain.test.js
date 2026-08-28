// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mediaMock = vi.hoisted(() => ({
  displayTime: vi.fn(() => 105),
  vTime: vi.fn(() => 15),
  seek: vi.fn(),
}));

vi.mock('../src/media.js', () => ({ Media: mediaMock }));
vi.mock('../src/timeline.js', () => ({ updatePlayhead: vi.fn(), drawRuler: vi.fn() }));
vi.mock('../src/history.js', () => ({ recordHistory: vi.fn() }));
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
});
