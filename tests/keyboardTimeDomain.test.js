// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mediaMock = vi.hoisted(() => ({
  displayTime: vi.fn(() => 105),
  vTime: vi.fn(() => 15),
  seek: vi.fn(),
  scrubAudio: vi.fn(),
  pause: vi.fn(),
  play: vi.fn(),
  setRate: vi.fn(),
  externalAudio: { list: vi.fn(() => []), get: vi.fn(() => null) },
  playing: false,
}));

vi.mock('../src/media.js', () => ({ Media: mediaMock }));
vi.mock('../src/subtitles.js', () => ({
  addCue: vi.fn(),
  selectCue: vi.fn(),
  selectCueSingle: vi.fn(),
  commitCueTimeEdit: vi.fn(),
  deleteSelected: vi.fn(),
  addCueRelative: vi.fn(),
  sortCues: vi.fn(),
  cancelSwapMode: vi.fn(),
  refreshSelectionUI: vi.fn(),
  copyCues: vi.fn(),
  pasteCues: vi.fn(),
}));
vi.mock('../src/timeline.js', () => ({
  updatePlayhead: vi.fn(),
  zoomFit: vi.fn(),
  zoomFitVideo: vi.fn(),
  setZoom: vi.fn(),
  drawTimeline: vi.fn(),
  deleteSelectedClip: vi.fn(),
  clearClipSelection: vi.fn(),
  closeClipGapLeft: vi.fn(),
}));
vi.mock('../src/project.js', () => ({
  Project: {},
  ensureProjectSaved: vi.fn().mockResolvedValue(),
}));
vi.mock('../src/history.js', () => ({
  History: {},
  recordHistory: vi.fn(),
  renderHistory: vi.fn(),
}));
vi.mock('../src/notes.js', () => ({
  addNote: vi.fn(),
  renderNotes: vi.fn(),
  updateNoteActive: vi.fn(),
}));
vi.mock('../src/ui.js', () => ({
  setStatus: vi.fn(),
  closeModal: vi.fn(),
  showOsd: vi.fn(),
}));

let State;
let jklReset;

describe('JKL reverse shuttle time domain', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    document.body.innerHTML = `
      <video id="video"></video>
      <div id="modalBg"></div>
      <div id="speedIndicator"></div>
      <div id="tcCur"></div>
      <input id="seekBar" value="0">
    `;
    ({ State } = await import('../src/state.js'));
    ({ jklReset } = await import('../src/keyboard.js'));
    State.keymap = { rewind: [{ key: 'j' }] };
    State.clips = [{
      id: 'offset-clip',
      in: 10,
      out: 30,
      offset: 100,
      dur: 40,
      vtrack: 0,
      primary: true,
    }];
    mediaMock.displayTime.mockClear();
    mediaMock.vTime.mockClear();
    mediaMock.seek.mockClear();
    mediaMock.scrubAudio.mockClear();
  });

  afterEach(() => {
    jklReset?.();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('passes timeline time to seek and audio scrub', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ' }));
    vi.advanceTimersByTime(34);

    expect(mediaMock.seek).toHaveBeenCalledWith(expect.closeTo(105 - 1 / 30, 8));
    expect(mediaMock.scrubAudio).toHaveBeenCalledWith(
      expect.closeTo(105 - 1 / 30, 8),
      expect.any(Number),
    );
    expect(mediaMock.displayTime).toHaveBeenCalled();
    expect(mediaMock.vTime).not.toHaveBeenCalled();
  });

  it('播放時按下左右鍵會先暫停並往左/右移動一格', async () => {
    State.keymap = {
      nudge_left_1f: [{ key: 'arrowleft' }],
      nudge_right_1f: [{ key: 'arrowright' }],
    };
    mediaMock.playing = true;
    mediaMock.pause.mockImplementation(() => { mediaMock.playing = false; });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    expect(mediaMock.pause).toHaveBeenCalled();
    expect(mediaMock.seek).toHaveBeenCalledWith(expect.closeTo(105 - 1 / State.fps, 8));

    mediaMock.pause.mockClear();
    mediaMock.seek.mockClear();
    mediaMock.playing = true;

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(mediaMock.pause).toHaveBeenCalled();
    expect(mediaMock.seek).toHaveBeenCalledWith(expect.closeTo(105 + 1 / State.fps, 8));
  });
});
