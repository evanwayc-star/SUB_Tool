import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beginTimelineGesture } from '../src/timeline-gesture-transaction.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

  it('is wired into renderer drag cancellation instead of leaving preview mutations behind', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'timeline-renderer.js'), 'utf8');

    expect(source).toMatch(/beginTimelineGesture/);
    expect(source).toMatch(/function cancelTimelineDrag/);
    expect(source).toMatch(/window\.addEventListener\('blur',\s*cancelTimelineDrag/);
    expect(source).toMatch(/window\.addEventListener\('pointercancel',\s*cancelTimelineDrag/);
    const cancel = source.slice(source.indexOf('function cancelTimelineDrag'), source.indexOf('const _handleDragUpdate'));
    expect(cancel).toMatch(/if\(pending\.transaction\)/);
    expect(cancel).not.toMatch(/if\(restored\)\{/);
    expect(source).toMatch(/addCancelEffect\(\(\)=>previewRowIds\.forEach\(renderSubRow\)\)/);
  });
});
