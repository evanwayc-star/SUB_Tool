import { describe, expect, it } from 'vitest';
import {
  beginTimelineGesture,
  beginTimelineGestureLifecycle,
  planCueGesturePreview,
  planClipGesturePreview,
  planAudioGesturePreview,
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

  it('新手勢會取消並回復尚未結束的舊手勢', () => {
    const cue = { start: 1, end: 2 };
    const first = beginTimelineGestureLifecycle({
      mode: 'move',
      targets: [{ target: cue, fields: ['start', 'end'] }]
    });
    first.startPreview();
    cue.start = 4;
    cue.end = 5;

    const second = beginTimelineGestureLifecycle({ mode: 'rubber' });

    expect(first.isActive()).toBe(false);
    expect(cue).toEqual({ start: 1, end: 2 });
    expect(second.isActive()).toBe(true);
    second.cancel();
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

  it('手勢自己判定 3px 拖曳門檻，並凍結開始時的意圖與目標', () => {
    const target = { id: 'cue-1', start: 1, end: 2 };
    const gesture = beginTimelineGestureLifecycle({
      mode: 'move',
      targets: [{ target, fields: ['start', 'end'] }],
      context: {
        startPoint: { x: 10, y: 20 },
        modifiers: { alt: true },
        targetIds: ['cue-1']
      }
    });

    expect(gesture.acceptSample({ x: 13, y: 20 })).toEqual({ accepted: false, started: false });
    expect(gesture.acceptSample({ x: 14, y: 20 })).toEqual({ accepted: true, started: true });
    expect(gesture.intent).toMatchObject({
      mode: 'move', kind: 'cue', targetIds: ['cue-1'], modifiers: { alt: true }
    });
    expect(Object.isFrozen(gesture.intent)).toBe(true);
  });

  it('字幕群組移動集中處理防重疊、鎖定目的軌、磁吸與影格格網', () => {
    const snapFrame = value => Math.round(value * 10) / 10;
    const plan = planCueGesturePreview({
      mode: 'move',
      originals: [{ start: 1, end: 2, track: 0, prevEnd: 0, nextStart: 5 }],
      deltaTime: 0.26,
      targetTrackDelta: 1,
      trackCount: 2,
      lockedTracks: [false, true],
      overwriteMode: false,
      snaps: [1.3],
      snapThreshold: 0.1,
      snapFrame
    });

    expect(plan.items).toEqual([{ start: 1.3, end: 2.3, track: 0 }]);
    expect(plan.snapTarget).toBe(1.3);
  });

  it('字幕逐格化後仍不可越過鄰居邊界', () => {
    const snapFrame = value => Math.round(value * 24) / 24;
    const plan = planCueGesturePreview({
      mode: 'move',
      originals: [{ start: 1.5, end: 2.5, track: 0, prevEnd: 1.02, nextStart: 5 }],
      deltaTime: -0.5,
      trackCount: 1,
      snapFrame,
      frameStep: 1 / 24
    });

    expect(plan.items[0].start).toBeGreaterThanOrEqual(1.02);
    expect(plan.items[0].start * 24).toBeCloseTo(Math.round(plan.items[0].start * 24), 8);
  });

  it('影片與外部音訊使用同一組純 preview planner，不直接改 model', () => {
    const snapFrame = value => Math.round(value * 10) / 10;
    const clip = { offset: 2, in: 1, out: 5, duration: 8, vtrack: 0, type: 'video' };
    const clipPlan = planClipGesturePreview({
      mode: 'clip-move', original: clip, deltaTime: 0.24,
      targetTrack: 1, targetTrackLocked: true,
      snaps: [2.2], snapThreshold: 0.1, snapFrame,
      leftLimit: 0, rightLimit: Infinity
    });
    const audio = { offset: 3, in: 1, out: 5, duration: 8 };
    const audioPlan = planAudioGesturePreview({
      mode: 'audio-r', original: audio, deltaTime: -0.64,
      snaps: [6.4], snapThreshold: 0.1, snapFrame
    });

    expect(clipPlan).toMatchObject({ offset: 2.2, in: 1, out: 5, vtrack: 0, snapTarget: 2.2 });
    expect(clip).toEqual({ offset: 2, in: 1, out: 5, duration: 8, vtrack: 0, type: 'video' });
    expect(audioPlan).toMatchObject({ offset: 3, in: 1, out: 4.4, snapTarget: 6.4 });
    expect(audio).toEqual({ offset: 3, in: 1, out: 5, duration: 8 });
  });
});
