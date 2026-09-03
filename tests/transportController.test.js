// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../src/timeline.js', () => ({
  updatePlayhead: vi.fn(),
  drawTimeline: vi.fn(),
}));
vi.mock('../src/notes.js', () => ({
  updateNoteActive: vi.fn(),
}));
vi.mock('../src/ui.js', () => ({
  setStatus: vi.fn(),
  showOsd: vi.fn(),
}));
vi.mock('../src/history.js', () => ({
  recordHistory: vi.fn(),
}));

import { State } from '../src/state.js';
import { getExactFps, snapTimeToFrame, secToEncore } from '../src/time.js';
import { stepFrame, getJklSpeed, setJklSpeed } from '../src/transport-controller.js';
import { Media } from '../src/media.js';
import { getCueInMinusFrames } from '../src/timeline-navigation.js';
import { setExportIn, setExportOut, clearExport } from '../src/export-range.js';

describe('TransportController 與 FPS/時碼不變量', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = `
      <div id="speedIndicator"></div>
      <div id="tcCur"></div>
      <input id="seekBar" type="range" />
    `;
    State.fps = 29.97;
    State.dropFrame = false;
    State.notes = [];
    setJklSpeed(0);
  });

  it('I5: 單格步進 (stepFrame) 在 29.97 NDF 下嚴格加減整數格，且容差小於半格', () => {
    const exactFps = getExactFps(29.97);
    const halfFrame = 0.5 / exactFps;
    let seekTarget = null;
    let seekOptions = null;

    vi.spyOn(Media, 'displayTime').mockReturnValue(10.0);
    vi.spyOn(Media, 'seek').mockImplementation((t, opts) => {
      seekTarget = t;
      seekOptions = opts;
    });
    vi.spyOn(Media, 'scrubAudio').mockImplementation(() => {});

    // 前進一格
    stepFrame(1, false);
    const expectedFrame = Math.round(10.0 * exactFps) + 1;
    const expectedTime = snapTimeToFrame(expectedFrame / exactFps, 29.97, false);

    expect(seekTarget).toBeCloseTo(expectedTime, 8);
    expect(seekOptions?.presentationTolerance).toBeLessThan(halfFrame);

    // 後退一格
    stepFrame(-1, false);
    const expectedPrevFrame = Math.round(10.0 * exactFps) - 1;
    const expectedPrevTime = snapTimeToFrame(expectedPrevFrame / exactFps, 29.97, false);
    expect(seekTarget).toBeCloseTo(expectedPrevTime, 8);
  });

  it('I5: 在 23.976 FPS 下連續前進再連續倒退相同格數，時碼讀數零漂移', () => {
    State.fps = 23.976;
    const exactFps = getExactFps(23.976);
    let currentTime = 0;

    vi.spyOn(Media, 'displayTime').mockImplementation(() => currentTime);
    vi.spyOn(Media, 'seek').mockImplementation((t) => {
      currentTime = t;
    });
    vi.spyOn(Media, 'scrubAudio').mockImplementation(() => {});

    // 前進 10 格
    for (let i = 0; i < 10; i++) {
      stepFrame(1, false);
    }
    expect(secToEncore(currentTime, 23.976, false)).toBe('00:00:00:10');

    // 倒退 10 格
    for (let i = 0; i < 10; i++) {
      stepFrame(-1, false);
    }
    expect(currentTime).toBe(0);
    expect(secToEncore(currentTime, 23.976, false)).toBe('00:00:00:00');
  });

  it('I3: getCueInMinusFrames 計算倒退影格時，目標時間精確吸附影格格網', () => {
    const cues = [
      { id: 'c1', start: 10.0, end: 12.0, timed: true, track: 0 }
    ];
    const result = getCueInMinusFrames({
      cues,
      selectedId: 'c1',
      listTrack: 0,
      currentTime: 10.0,
      fps: 29.97,
      dropFrame: false,
      dir: 0,
      frames: 5
    });

    expect(result).not.toBeNull();
    const exactFps = getExactFps(29.97);
    const expected = snapTimeToFrame(10.0 - (5 / exactFps), 29.97, false);
    expect(result.targetTime).toBeCloseTo(expected, 8);
  });

  it('I3: setExportIn 與 setExportOut 寫入之時間經 snapTimeToFrame 吸附格網', () => {
    vi.spyOn(Media, 'displayTime').mockReturnValue(5.00123);
    State.fps = 25;

    setExportIn();
    expect(State.exportIn).toBe(snapTimeToFrame(5.00123, 25, false));

    vi.spyOn(Media, 'displayTime').mockReturnValue(8.77777);
    setExportOut();
    expect(State.exportOut).toBe(snapTimeToFrame(8.77777, 25, false));

    clearExport();
    expect(State.exportIn).toBeNull();
    expect(State.exportOut).toBeNull();
  });
});
