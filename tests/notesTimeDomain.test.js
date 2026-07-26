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
});
