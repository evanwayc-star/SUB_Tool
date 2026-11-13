import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normaliseMpvViewport, mpvWindowRegion } = require('../electron/mpv-window-region.js');

describe('mpv window visible region', () => {
  const bounds = { x: 10, y: 20, w: 8, h: 6 };

  it('validates and copies CSS rectangles before changing window state', () => {
    const input = { bounds, visible: false, occluders: [{ x: 12, y: 22, w: 3, h: 3 }] };
    expect(normaliseMpvViewport(input)).toEqual(input);
    const result = normaliseMpvViewport(input);
    expect(result.bounds).not.toBe(input.bounds);
    expect(result.occluders[0]).not.toBe(input.occluders[0]);
    for (const bad of [null, {}, { ...input, visible: 1 }, { ...input, occluders: null },
      { ...input, bounds: { ...bounds, x: NaN } }, { ...input, bounds: { ...bounds, w: 0 } },
      { ...input, bounds: { ...bounds, h: Infinity } }, { ...input, bounds: { ...bounds, x: '10' } },
      { ...input, bounds: { ...bounds, x: 100001 } },
      { ...input, occluders: Array.from({ length: 65 }, () => bounds) },
      { ...input, occluders: Array(1) },
      { ...input, occluders: [{ ...bounds, w: -1 }] }]) expect(normaliseMpvViewport(bad)).toBeNull();
  });

  it('distinguishes reset from fully covered so [] cannot accidentally reveal the video', () => {
    expect(mpvWindowRegion(bounds, [{ x: 100, y: 100, w: 1, h: 1 }], 1))
      .toMatchObject({ covered: false, shape: [] });
    expect(mpvWindowRegion(bounds, [bounds], 1)).toMatchObject({ covered: true });
    expect(mpvWindowRegion(bounds, [{ ...bounds, w: 4 }, { ...bounds, x: 14, w: 4 }], 1))
      .toMatchObject({ covered: true });
  });

  it('overlapping holes leave exactly the uncovered pixels, with no duplicate rectangles', () => {
    const holes = [{ x: 9, y: 21, w: 4, h: 3 }, { x: 12, y: 22, w: 4, h: 3 }];
    const { shape, covered } = mpvWindowRegion(bounds, holes, 1);
    expect(covered).toBe(false);
    for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) {
      const count = shape.filter(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height).length;
      const blocked = holes.some(r => x + 10 >= r.x && x + 10 < r.x + r.w && y + 20 >= r.y && y + 20 < r.y + r.h);
      expect(count, `pixel ${x},${y}`).toBe(blocked ? 0 : 1);
    }
  });

  it('uses page zoom and outward hole rounding in window-local DIP', () => {
    const region = mpvWindowRegion({ x: 10.2, y: 20.2, w: 10, h: 8 },
      [{ x: 12.1, y: 20.2, w: 2.2, h: 8 }], 1.25);
    expect(region.bounds).toEqual({ x: 13, y: 25, width: 13, height: 10 });
    expect(region.shape).toEqual([{ x: 0, y: 0, width: 2, height: 10 }, { x: 5, y: 0, width: 8, height: 10 }]);
    expect(mpvWindowRegion(bounds, [], NaN).bounds).toEqual({ x: 10, y: 20, width: 8, height: 6 });
  });

  it('keeps the maximum hole count bounded while preserving uncovered area', () => {
    const holes = Array.from({ length: 64 }, (_, i) => ({ x: i * 2, y: 0, w: 1, h: 128 }));
    const { shape } = mpvWindowRegion({ x: 0, y: 0, w: 128, h: 128 }, holes, 1);
    expect(shape.reduce((area, r) => area + r.width * r.height, 0)).toBe(64 * 128);
    expect(shape.length).toBeLessThanOrEqual(8192);
  });
});
