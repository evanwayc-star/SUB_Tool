// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/timeline.js', () => ({ drawTimeline: vi.fn() }));
vi.mock('../src/notes.js', () => ({ renderNotes: vi.fn() }));
vi.mock('../src/ui.js', () => ({ setStatus: vi.fn() }));

import { State } from '../src/state.js';
import { History } from '../src/history.js';

describe('history export range', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="historyList"></div>';
    State.cues = [];
    State.tracks = [{ name: '軌道 1', visible: true, locked: false }];
    State.notes = [];
    State.clips = [];
    State.videoTracks = [{ name: '視訊軌 1', visible: true, locked: false }];
    State.exportIn = null;
    State.exportOut = null;
    History.stack = [];
    History.hi = -1;
  });

  it('records and restores the [In]/[Out] export range', () => {
    History.reset();

    State.exportIn = 12.5;
    History.record('設定輸出起點 [In]');
    State.exportOut = 48;
    History.record('設定輸出終點 [Out]');
    State.exportIn = null;
    State.exportOut = null;
    History.record('清除輸出範圍');

    expect(History.stack.map(entry => entry.label)).toEqual([
      '初始', '設定輸出起點 [In]', '設定輸出終點 [Out]', '清除輸出範圍'
    ]);

    History.undo();
    expect(State.exportIn).toBe(12.5);
    expect(State.exportOut).toBe(48);

    History.redo();
    expect(State.exportIn).toBeNull();
    expect(State.exportOut).toBeNull();
  });
});
