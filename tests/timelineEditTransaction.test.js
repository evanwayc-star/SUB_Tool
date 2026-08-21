// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const domMock = vi.hoisted(() => ({
  $: vi.fn(() => ({ innerHTML: '', querySelectorAll: () => [] })),
}));

vi.mock('../src/dom.js', () => domMock);
vi.mock('../src/timeline.js', () => ({ drawTimeline: vi.fn() }));
vi.mock('../src/notes.js', () => ({ renderNotes: vi.fn() }));
vi.mock('../src/ui.js', () => ({ setStatus: vi.fn() }));

let History;
let State;
let beginTimelineTrackEdit;
let updateTimelineTrack;
let timelineInvalidations;
let mpvRefreshes;
let clearedClips;

describe('timeline track edit transaction', () => {
  beforeAll(async () => {
    ({ History } = await import('../src/history.js'));
    ({ State } = await import('../src/state.js'));
    ({ beginTimelineTrackEdit, updateTimelineTrack } = await import('../src/timeline-edit-transaction.js'));
    const { on } = await import('../src/events.js');
    on('history:record', label => History.record(label));
    on('timeline:invalidate', detail => timelineInvalidations.push(detail));
    on('mpv:refreshSubs', () => mpvRefreshes.push(true));
    on('selection:clipCleared', detail => clearedClips.push(detail));
  });

  beforeEach(() => {
    State.cues = [];
    State.notes = [];
    State.tracks = [{ name: '字幕軌 1', visible: true, locked: false }];
    State.trackCount = 1;
    State.videoTracks = [{ name: '視訊軌 1', visible: true, locked: false }];
    State.clips = [{ id: 'clip-a', vtrack: 0, in: 0, out: 5, offset: 0, dur: 5 }];
    State.selectedClipId = 'clip-a';
    History.stack = [];
    History.hi = -1;
    History.reset();
    timelineInvalidations = [];
    mpvRefreshes = [];
    clearedClips = [];
  });

  it('records visibility immediately so the next unrelated action cannot swallow it', () => {
    updateTimelineTrack({ kind: 'subtitle', index: 0, field: 'visible', value: false });

    expect(State.tracks[0].visible).toBe(false);
    expect(History.stack.at(-1).label).toBe('隱藏字幕軌：字幕軌 1');

    History.undo();
    expect(State.tracks[0].visible).toBe(true);
  });

  it('previews a resize continuously but commits exactly one undo step', () => {
    const edit = beginTimelineTrackEdit({ kind: 'video', index: 0, field: 'height' });

    edit.preview(72);
    edit.preview(84);
    expect(State.videoTracks[0].height).toBe(84);
    expect(History.stack).toHaveLength(1);
    expect(timelineInvalidations).toEqual([]);

    expect(edit.commit()).toBe(true);
    expect(History.stack).toHaveLength(2);
    expect(timelineInvalidations).toHaveLength(1);
    History.undo();
    expect(State.videoTracks[0].height).toBeUndefined();
  });

  it('locking a video track clears a selected clip that belongs to that track', () => {
    updateTimelineTrack({ kind: 'video', index: 0, field: 'locked', value: true });

    expect(State.videoTracks[0].locked).toBe(true);
    expect(State.selectedClipId).toBeNull();
    expect(clearedClips).toEqual([{ id: 'clip-a', reason: 'track-locked' }]);
  });

  it('video visibility does not request an unrelated mpv subtitle refresh', () => {
    updateTimelineTrack({ kind: 'video', index: 0, field: 'visible', value: false });

    expect(mpvRefreshes).toEqual([]);
  });

  it('previews and commits audio track height with undo/redo support', () => {
    State.externalAudioState = [{ id: 'ext-asset-1', audioSourceId: 'asset-1', name: '配樂' }];
    const onApply = vi.fn();
    const edit = beginTimelineTrackEdit({ kind: 'audio', id: 'ext-asset-1', field: 'height', onApply });

    edit.preview(88);
    expect(State.externalAudioState[0].height).toBe(88);
    expect(onApply).toHaveBeenCalledWith(88, State.externalAudioState[0]);
    expect(History.stack).toHaveLength(1);

    expect(edit.commit()).toBe(true);
    expect(History.stack).toHaveLength(2);
    expect(History.stack.at(-1).label).toBe('調整音訊軌高度：配樂');

    // Resetting height back to default
    updateTimelineTrack({ kind: 'audio', id: 'ext-asset-1', field: 'height', value: undefined, onApply });
    expect(State.externalAudioState[0].height).toBeUndefined();
  });

  it('cancels a queued resize preview frame before the commit redraw', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/timeline-renderer.js'), 'utf8');
    const body = src.slice(src.indexOf('function _onRowResizeUp'));
    const fn = body.slice(0, body.indexOf('\n}') + 2);

    expect(fn).toMatch(/cancelAnimationFrame\(resize\._raf\)/);
  });
});
