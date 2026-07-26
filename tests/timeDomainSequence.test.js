import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Seq } from '../src/sequence.js';

describe('timeline/source time boundaries', () => {
  it('filters cues in timeline time before mapping them to the active source', () => {
    const clip = {
      id: 'offset-clip',
      in: 10,
      out: 30,
      offset: 100,
      dur: 40,
      vtrack: 0,
    };
    const cues = [
      { id: 'near', start: 104, end: 106, text: 'near', timed: true },
      { id: 'far', start: 200, end: 202, text: 'far', timed: true },
      { id: 'untimed', start: 0, end: 0, text: 'untimed', timed: false },
    ];

    const mapped = Seq.timedRangesForSource(cues, clip, { center: 105, radius: 5 });

    expect(mapped).toEqual([
      expect.objectContaining({ id: 'near', start: 14, end: 16 }),
      expect.objectContaining({ id: 'untimed', start: 0, end: 0 }),
    ]);
    expect(cues[0]).toMatchObject({ start: 104, end: 106 });
  });

  it('keeps all cues while mapping a full refresh to source time', () => {
    const clip = { in: 10, out: 30, offset: 100, dur: 40, vtrack: 0 };
    const mapped = Seq.timedRangesForSource([
      { id: 'a', start: 104, end: 106, timed: true },
      { id: 'b', start: 110, end: 112, timed: true },
    ], clip);

    expect(mapped.map(cue => [cue.start, cue.end])).toEqual([[14, 16], [20, 22]]);
  });

  it('keeps public UI wiring on displayTime instead of player source time', () => {
    const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
    const keyboard = readFileSync(new URL('../src/keyboard.js', import.meta.url), 'utf8');
    const notes = readFileSync(new URL('../src/notes.js', import.meta.url), 'utf8');

    expect(app).toContain('Seq.timedRangesForSource(State.cues');
    expect(app).toContain('updateNoteActive(Media.displayTime())');
    expect(app).not.toContain('updateNoteActive(video.currentTime)');
    expect(keyboard).not.toContain('const t = Media.vTime();');
    expect(notes).not.toContain('const t=Media.vTime();');
  });
});
