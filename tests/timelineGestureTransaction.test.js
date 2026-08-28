import { describe, expect, it } from 'vitest';
import {
  beginTimelineGesture,
  beginTimelineGestureLifecycle,
} from '../src/timeline-gesture-transaction.js';

describe('timeline gesture transaction', () => {
  it('restores every preview field and registered copy rollback when a gesture is cancelled', () => {
    const cue = { start: 1, end: 2, track: 0 };
    const copies = [{ id: 'copied' }];
    const gesture = beginTimelineGesture({
      targets: [{ target: cue, fields: ['start', 'end', 'track'] }],
    });
    gesture.addRollback(() => { copies.length = 0; });

    cue.start = 4;
    cue.end = 5;
    cue.track = 2;
    gesture.markMoved();

    expect(gesture.cancel()).toBe(true);
    expect(cue).toEqual({ start: 1, end: 2, track: 0 });
    expect(copies).toEqual([]);
    expect(gesture.isActive()).toBe(false);
  });

  it('runs cancel-only visual refresh effects after restoring preview fields', () => {
    const cue = { id: 'cue-1', start: 1, end: 2 };
    const rendered = [];
    const gesture = beginTimelineGesture({
      targets: [{ target: cue, fields: ['start', 'end'] }],
    });
    gesture.addCancelEffect(() => rendered.push({ start: cue.start, end: cue.end }));

    cue.start = 8;
    cue.end = 9;
    gesture.markMoved();
    gesture.cancel();

    expect(rendered).toEqual([{ start: 1, end: 2 }]);
  });

  it('does not run cancel visual effects after a committed gesture', () => {
    const effects = [];
    const gesture = beginTimelineGesture();
    gesture.addCancelEffect(() => effects.push('cancelled'));
    gesture.markMoved();
    gesture.commit();

    expect(gesture.cancel()).toBe(false);
    expect(effects).toEqual([]);
  });

  it('keeps preview changes after commit and cannot be cancelled afterwards', () => {
    const clip = { offset: 2, in: 1, out: 9, vtrack: 0 };
    const gesture = beginTimelineGesture({
      targets: [{ target: clip, fields: ['offset', 'in', 'out', 'vtrack'] }],
    });

    clip.offset = 5;
    clip.vtrack = 1;
    gesture.markMoved();

    expect(gesture.commit()).toBe(true);
    expect(gesture.cancel()).toBe(false);
    expect(clip).toMatchObject({ offset: 5, in: 1, out: 9, vtrack: 1 });
  });

  it('同一個 production lifecycle 依序執行 start、preview 與 commit', () => {
    const cue = { start: 1, end: 2 };
    const calls = [];
    const gesture = beginTimelineGestureLifecycle({
      mode: 'move',
      targets: [{ target: cue, fields: ['start', 'end'] }],
    });

    expect(gesture.kind).toBe('cue');
    expect(gesture.startPreview(() => calls.push('start'))).toBe(true);
    expect(gesture.preview(() => {
      cue.start = 3;
      cue.end = 4;
      calls.push('preview');
    })).toBe(true);
    expect(gesture.commit(() => calls.push(`commit:${cue.start}:${cue.end}`))).toEqual({
      committed: true,
      moved: true,
    });

    expect(calls).toEqual(['start', 'preview', 'commit:3:4']);
    expect(gesture.cancel()).toEqual({ cancelled: false, restored: false });
  });

  it('透過 production lifecycle 依序回復影片片段、畫面與播放呈現', () => {
    const clip = { offset: 2, in: 1, out: 9, vtrack: 0 };
    const calls = [];
    const gesture = beginTimelineGestureLifecycle({
      mode: 'clip-move',
      targets: [{ target: clip, fields: ['offset', 'in', 'out', 'vtrack'] }],
      effects: {
        clearSnapGuide: () => calls.push('snap'),
        stopAutoScroll: () => calls.push('scroll'),
        restoreClipMapping: () => calls.push(`clip:${clip.offset}:${clip.vtrack}`),
        redraw: () => calls.push('draw'),
        refreshPreview: () => calls.push('preview'),
      },
    });
    clip.offset = 5;
    clip.vtrack = 1;
    gesture.startPreview();

    const result = gesture.cancel();

    expect(result).toEqual({ cancelled: true, restored: true });
    expect(clip).toEqual({ offset: 2, in: 1, out: 9, vtrack: 0 });
    expect(calls).toEqual(['snap', 'scroll', 'clip:2:0', 'draw', 'preview']);
  });

  it('取消 copy-drag 時在 rollback 與重繪後才同步 selection UI', () => {
    const cues = [{ id: 'original' }, { id: 'copy' }];
    const calls = [];
    const gesture = beginTimelineGestureLifecycle({
      mode: 'move',
      context: { isCopyDrag: true },
      effects: {
        redraw: () => calls.push(`draw:${cues.length}`),
        refreshPreview: () => calls.push('preview'),
        refreshSelection: () => calls.push(`selection:${cues.length}`),
      },
    });
    gesture.addRollback(() => cues.pop());
    gesture.startPreview();

    gesture.cancel();

    expect(cues).toEqual([{ id: 'original' }]);
    expect(calls).toEqual(['draw:1', 'preview', 'selection:1']);
  });
});
