import { describe, expect, it } from 'vitest';
import { clipSourceFingerprint, clipSourceStillReferenced, liveClipForSource } from '../src/media-intake-engine.js';

describe('media source lease', () => {
  it('survives placement splitting while any piece still references the same source', () => {
    const original = { id: 'a', audioSrc: 'video', audioSourceId: 'source-a', path: 'C:/A.mov' };
    const split = { id: 'b', audioSrc: 'video', audioSourceId: 'source-a', path: 'C:/A.mov' };
    expect(clipSourceStillReferenced([split], original)).toBe(true);
    expect(liveClipForSource([split], original)).toBe(split);
  });

  it('does not reuse work for the same clip id when the underlying source changed', () => {
    const oldClip = { id: 'a', audioSrc: 'clip:a', path: 'C:/old.mov' };
    const replacement = { id: 'a', audioSrc: 'clip:a', path: 'C:/new.mov' };
    expect(clipSourceFingerprint(oldClip)).not.toBe(clipSourceFingerprint(replacement));
    expect(clipSourceStillReferenced([replacement], oldClip)).toBe(false);
  });
});
