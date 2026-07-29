import { describe, expect, it } from 'vitest';

import { ProjectLoadSession } from '../src/project-load-session.js';

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

describe('ProjectLoadSession', () => {
  it('serializes runtime work while letting the newest request win', async () => {
    const session = new ProjectLoadSession();
    const first = session.begin();
    const gate = deferred();
    const started = deferred();
    const order = [];

    const firstWork = session.append(first, async () => {
      order.push('first:start');
      started.resolve();
      await gate.promise;
      order.push('first:finish');
    });
    await started.promise;
    const second = session.begin();
    const secondWork = session.append(second, () => {
      order.push('second');
    });

    gate.resolve();
    await Promise.all([firstWork, secondWork]);

    expect(order).toEqual(['first:start', 'first:finish', 'second']);
  });

  it('keeps restore material in an explicit plan until its adapter consumes it', () => {
    const session = new ProjectLoadSession();
    const generation = session.begin();
    const plan = session.createRestorePlan(generation, {
      clips: [{ id: 'image', type: 'image' }],
      externalAudioSources: [{ audioSourceId: 'audio-1', path: 'C:/audio.wav' }],
      playhead: -12,
      mediaRelink: true,
    });

    expect(session.activePlan).toBe(plan);
    expect(plan.takeClips()).toEqual([{ id: 'image', type: 'image' }]);
    expect(plan.pendingClips()).toEqual([]);
    plan.replaceClips([{ id: 'missing', type: 'image' }]);
    expect(plan.pendingClips()).toEqual([{ id: 'missing', type: 'image' }]);
    expect(plan.pendingExternalAudioSources()).toEqual([
      { audioSourceId: 'audio-1', path: 'C:/audio.wav' },
    ]);
    expect(plan.peekPlayhead()).toBe(0);
    expect(plan.consumeMediaRelink()).toBe(true);
    expect(plan.consumeMediaRelink()).toBe(false);
    plan.clearPlayhead();
    expect(plan.peekPlayhead()).toBeNull();
    const invalidPlan = session.createRestorePlan(generation, { playhead: '01:00:00:00' });
    expect(invalidPlan.peekPlayhead()).toBeNull();
  });
});
