import { describe, expect, it } from 'vitest';
import { GEOMETRY_STYLE_KEYS, planCueStyleAssignment, planTrackStyleAssignment } from '../src/subtitle-style-engine.js';

describe('字幕樣式 assignment plan', () => {
  it('把 desired effective style 轉為相對目標軌道的最小 cue override', () => {
    const plan = planCueStyleAssignment({
      cue: { id: 'cue-1', style: { color: '#ffffff' } },
      targetTrack: { fontSize: 60, color: '#ffffff' },
      desiredStyle: { fontSize: 80, color: '#ffffff' },
    });

    expect(plan.changed).toBe(true);
    expect(plan.style).toEqual({ fontSize: 80 });
  });

  it('desired style 等於目標軌道時不留下無作用 override', () => {
    const plan = planCueStyleAssignment({
      cue: { id: 'cue-1' },
      targetTrack: { fontSize: 80, color: '#ffee00' },
      desiredStyle: { fontSize: 80, color: '#ffee00' },
    });

    expect(plan.changed).toBe(false);
    expect(plan.style).toBeUndefined();
  });

  it('目標軌道改成新基準時，會清掉 cue 既有的冗餘 canonical override', () => {
    const plan = planCueStyleAssignment({
      cue: { id: 'cue-1', style: { fontSize: 90, legacyTag: 'keep' } },
      targetTrack: { fontSize: 90 },
      desiredStyle: { fontSize: 90 },
    });

    expect(plan.style).toEqual({ legacyTag: 'keep' });
  });

  it('可保留既有幾何欄位，同時套用其他生效樣式', () => {
    const plan = planCueStyleAssignment({
      cue: { id: 'cue-1', style: { posX: 20 } },
      targetTrack: { posX: 50, fontSize: 60 },
      desiredStyle: { posX: 80, fontSize: 90 },
      preserveKeys: GEOMETRY_STYLE_KEYS,
    });

    expect(plan.style).toMatchObject({ posX: 20, fontSize: 90 });
    expect(plan.style).not.toHaveProperty('angle');
  });

  it('不讓非 canonical desired key 滲入 cue style', () => {
    const plan = planCueStyleAssignment({
      cue: { id: 'cue-1' },
      targetTrack: {},
      desiredStyle: { fontSize: 90, unsafeCustomKey: 'must-not-copy' },
    });

    expect(plan.style).toEqual({ fontSize: 90 });
  });

  it('全軌排除幾何時，保留每一句原本的有效位置', () => {
    const firstCue = { id: 'first', style: { posX: 20 } };
    const secondCue = { id: 'second' };
    const plan = planTrackStyleAssignment({
      track: { fontSize: 60, posX: 50 },
      cues: [firstCue, secondCue],
      desiredStyle: { fontSize: 90, posX: 80 },
      preserveKeys: GEOMETRY_STYLE_KEYS,
    });

    expect(plan.trackPatch).toMatchObject({ fontSize: 90 });
    expect(plan.trackPatch).not.toHaveProperty('posX');
    expect(plan.cuePatches[0].style).toMatchObject({ posX: 20 });
    expect(plan.cuePatches[1].style).toBeUndefined();
  });
});
