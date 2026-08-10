import { describe, expect, it } from 'vitest';
import { ResetEpoch } from '../src/reset-epoch.js';

describe('reset-scoped project asset epoch', () => {
  it('allows concurrent work in one project but invalidates all old work on reset', () => {
    const epoch = new ResetEpoch();
    const audio = epoch.capture('audio');
    const image = epoch.capture('image');

    expect(epoch.owns(audio)).toBe(true);
    expect(epoch.owns(image)).toBe(true);
    epoch.invalidate();
    expect(epoch.owns(audio)).toBe(false);
    expect(epoch.owns(image)).toBe(false);
    expect(epoch.owns(epoch.capture('new project'))).toBe(true);
  });

  it('can compose a caller-owned transaction with the reset generation', () => {
    const epoch = new ResetEpoch();
    let current = true;
    const token = epoch.capture('project restore', () => current);
    expect(epoch.owns(token)).toBe(true);
    current = false;
    expect(epoch.owns(token)).toBe(false);
  });
});
