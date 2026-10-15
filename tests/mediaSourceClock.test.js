import { describe, expect, it } from 'vitest';
import { playerClockTime, sourceClockTime, timestampOffset, sourceFrameTargetUs } from '../shared/media-source-clock.cjs';

describe('video source zero', () => {
  it('only absorbs floating point representation error at half-open trim ticks',()=>{
    const out=30/(30000/1001);
    expect(out).toBeGreaterThan(1.001);
    expect(sourceFrameTargetUs(out,{in:0,out})).toBe(1000999);
    expect(sourceFrameTargetUs(.04,{in:0,out:.28})).toBe(40000);
    // A real fraction above the tick still admits that tick before trim-out.
    expect(sourceFrameTargetUs(1.001,{in:0,out:1.0010000001})).toBe(1001000);
    expect(sourceFrameTargetUs(0,{in:30/(30000/1001),out:2})).toBe(1001000);
  });
  it('keeps unknown and already normalized sources unchanged', () => {
    for (const clock of [null, {}, { timestampOffset: NaN }, { timestampOffset: 0 }]) {
      expect(timestampOffset(clock)).toBe(0);
      expect(sourceClockTime(2.8, clock)).toBe(2.8);
      expect(playerClockTime(2.8, clock)).toBe(2.8);
    }
  });
  it('converts both directions without rounding away sub-frame precision', () => {
    for (const offset of [-.5, -.021333, .25, -5]) {
      const clock = { timestampOffset: offset };
      for (const time of [0, .03336666666667, 2.8, 21600.024]) {
        expect(sourceClockTime(playerClockTime(time, clock), clock)).toBeCloseTo(time, 10);
      }
    }
    expect(playerClockTime(2.8, { timestampOffset: -.5 })).toBe(3.3);
    expect(sourceClockTime(3.5, { timestampOffset: -.5 })).toBe(3);
  });
});
