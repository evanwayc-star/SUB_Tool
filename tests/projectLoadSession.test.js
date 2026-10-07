import { describe, expect, it, vi } from 'vitest';

import { ProjectLoadSession } from '../src/project-intake-engine.js';

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

  it('keeps restore material in an explicit plan until its adapter commits replacement', () => {
    const session = new ProjectLoadSession();
    const generation = session.begin();
    const plan = session.createRestorePlan(generation, {
      clips: [{ id: 'image', type: 'image' }],
      externalAudioSources: [{ audioSourceId: 'audio-1', path: 'C:/audio.wav' }],
      playhead: -12,
      mediaRelink: true,
    });

    expect(session.activePlan).toBe(plan);
    expect(plan.owns()).toBe(true);
    expect(plan.pendingClips()).toEqual([{ id: 'image', type: 'image' }]);
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
    expect(plan.owns()).toBe(false);
    expect(invalidPlan.owns()).toBe(true);
  });
});

function restorationFixture({ desktop = true, material = {}, ...adapters } = {}) {
  const order = [];
  const live = [];
  const media = {
    loadDesktopMedia: vi.fn(async () => { order.push('primary'); }),
    waitForPendingProjectRestore: vi.fn(async () => { order.push('placements'); }),
    restorePendingImageClips: vi.fn(async () => { order.push('images'); }),
    externalAudio: { list: () => live },
    externalAudioSources: live,
    restoreExternalAudioSource: vi.fn(async source => { order.push('audio'); live.push(source); return source; }),
    removeExternalAudio: vi.fn(id => { const index = live.findIndex(source => source.id === id); if (index >= 0) live.splice(index, 1); }),
    seek: vi.fn(() => { order.push('playhead'); }),
  };
  const publishExternalSources = vi.fn();
  const finishProject = vi.fn(() => { order.push('baseline'); });
  const session = new ProjectLoadSession({ media, desktop, stat: vi.fn(async () => ({ exists: true })),
    publishExternalSources, finishProject, ...adapters });
  const generation = session.begin();
  const plan = session.createRestorePlan(generation, { playhead: 13, ...material });
  return { session, generation, plan, media, live, order, publishExternalSources, finishProject };
}

describe('ProjectLoadSession media restoration completion', () => {
  it('waits for placements and the fixed-frame preview before restoring audio, playhead and Undo baseline', async () => {
    const f = restorationFixture({ material: {
      clips: [{ id: 'fixed', path: 'mother.mp4', freezeTime: 1 }, { id: 'missing', path: 'missing.mp4' }],
      externalAudioSources: [{ audioSourceId: 'audio-1', path: 'audio.wav' }],
    } });
    const visual = deferred();
    f.media.waitForPendingProjectRestore.mockImplementation(async () => {
      f.order.push('placements');
      await visual.promise;
      // The real Media adapter likewise owns image/freeze reconstruction and
      // replaces only the committed placements; unresolved metadata stays.
      f.plan.replaceClips(f.plan.pendingClips().filter(clip => clip.id === 'missing'));
    });
    const work = f.session.restoreMedia(f.generation, { kind: 'load', path: 'mother.mp4' });
    await vi.waitFor(() => expect(f.order).toEqual(['primary', 'placements']));
    expect(f.media.restoreExternalAudioSource).not.toHaveBeenCalled();
    expect(f.media.seek).not.toHaveBeenCalled();
    expect(f.finishProject).not.toHaveBeenCalled();
    visual.resolve();
    await expect(work).resolves.toBe(true);
    expect(f.order).toEqual(['primary', 'placements', 'audio', 'playhead', 'baseline']);
    expect(f.plan.pendingClips()).toEqual([{ id: 'missing', path: 'missing.mp4' }]);
    expect(f.plan.peekPlayhead()).toBeNull();
  });

  it('restores image-only projects before audio and preserves unavailable audio timeline metadata', async () => {
    const unavailable = { audioSourceId: 'missing', path: 'offline.wav', in: 2, out: 9, offset: 20 };
    const f = restorationFixture({ stat: vi.fn(async () => ({ exists: false })), material: {
      clips: [{ id: 'image', type: 'image', path: 'card.png' }], externalAudioSources: [unavailable],
    } });
    const images = deferred();
    f.media.restorePendingImageClips.mockImplementation(async () => { f.order.push('images'); await images.promise; });
    const work = f.session.restoreMedia(f.generation, { kind: 'images' });
    await vi.waitFor(() => expect(f.order).toEqual(['images']));
    expect(f.finishProject).not.toHaveBeenCalled();
    images.resolve();
    await expect(work).resolves.toBe(true);
    expect(f.order).toEqual(['images', 'playhead', 'baseline']);
    expect(f.plan.pendingExternalAudioSources()).toEqual([unavailable]);
    expect(f.publishExternalSources).toHaveBeenCalledWith([unavailable]);
    expect(f.media.loadDesktopMedia).not.toHaveBeenCalled();
  });

  it('keeps browser pending material until File relink, then completes once through the same seam', async () => {
    const material = { mediaRelink: true, clips: [{ id: 'file', path: null }],
      externalAudioSources: [{ audioSourceId: 'browser-audio', path: null, offset: 5 }] };
    const f = restorationFixture({ desktop: false, material });
    await expect(f.session.restoreMedia(f.generation, { kind: 'deferred' })).resolves.toBe(true);
    expect(f.plan.peekPlayhead()).toBe(13);
    expect(f.order).toEqual(['baseline']);
    f.finishProject.mockClear();
    const first = f.session.restoreMedia(f.generation, { kind: 'ready' });
    const duplicate = f.session.restoreMedia(f.generation, { kind: 'ready' });
    expect(duplicate).toBe(first);
    await expect(first).resolves.toBe(true);
    expect(f.finishProject).not.toHaveBeenCalled();
    expect(f.media.seek).toHaveBeenCalledOnce();
    expect(f.media.loadDesktopMedia).not.toHaveBeenCalled();
    expect(f.media.restoreExternalAudioSource).not.toHaveBeenCalled();
    expect(f.plan.pendingClips()).toEqual(material.clips);
    expect(f.plan.pendingExternalAudioSources()).toEqual(material.externalAudioSources);
    expect(f.plan.peekPlayhead()).toBeNull();
  });

  it('does not consume material or complete an old plan when a newer project wins during placement restoration', async () => {
    const f = restorationFixture({ material: { clips: [{ id: 'old' }], externalAudioSources: [{ audioSourceId: 'old', path: 'old.wav' }] } });
    const visual = deferred();
    f.media.waitForPendingProjectRestore.mockReturnValue(visual.promise);
    const work = f.session.restoreMedia(f.generation, { kind: 'ready' });
    const next = f.session.begin();
    f.session.createRestorePlan(next, { playhead: 22 });
    visual.resolve();
    await expect(work).resolves.toBe(false);
    expect(f.media.restoreExternalAudioSource).not.toHaveBeenCalled();
    expect(f.media.seek).not.toHaveBeenCalled();
    expect(f.finishProject).not.toHaveBeenCalled();
    expect(f.plan.pendingClips()).toEqual([{ id: 'old' }]);
    expect(f.plan.peekPlayhead()).toBe(13);
  });

  it.each([true, false])('rolls back a late audio result by object identity, registered=%s', async registered => {
    const f = restorationFixture({ material: { externalAudioSources: [{ audioSourceId: 'old', path: 'old.wav' }] } });
    const audio = deferred();
    f.media.restoreExternalAudioSource.mockReturnValue(audio.promise);
    const work = f.session.restoreMedia(f.generation, { kind: 'audio' });
    await vi.waitFor(() => expect(f.media.restoreExternalAudioSource).toHaveBeenCalledOnce());
    const next = f.session.begin();
    f.session.createRestorePlan(next, {});
    const old = { id: 'same-id', audioSourceId: 'old' };
    const newer = { id: 'same-id', audioSourceId: 'new' };
    f.live.push(registered ? old : newer);
    audio.resolve(old);
    await expect(work).resolves.toBe(false);
    expect(f.media.removeExternalAudio).toHaveBeenCalledTimes(registered ? 1 : 0);
    expect(f.live).toEqual(registered ? [] : [newer]);
    expect(f.plan.pendingExternalAudioSources()).toHaveLength(1);
    expect(f.finishProject).not.toHaveBeenCalled();
  });

  it('lets postponed media restore audio without consuming its saved playhead', async () => {
    const f = restorationFixture({ material: { mediaRelink: true, externalAudioSources: [{ audioSourceId: 'audio', path: 'audio.wav' }] } });
    await f.session.restoreMedia(f.generation, { kind: 'deferred' });
    expect(f.media.restoreExternalAudioSource).not.toHaveBeenCalled();
    await f.session.restoreMedia(f.generation, { kind: 'audio' });
    expect(f.media.restoreExternalAudioSource).toHaveBeenCalledOnce();
    expect(f.media.seek).not.toHaveBeenCalled();
    expect(f.plan.peekPlayhead()).toBe(13);
    expect(f.plan.needsMediaRelink()).toBe(true);
  });

  it('retries an unresolved audio source after it becomes readable in the same plan', async () => {
    const stat = vi.fn().mockResolvedValueOnce({ exists: false }).mockResolvedValue({ exists: true });
    const source = { audioSourceId: 'audio', path: 'returned.wav', offset: 10 };
    const f = restorationFixture({ stat, material: { externalAudioSources: [source] } });
    await f.session.restoreMedia(f.generation, { kind: 'audio' });
    expect(f.plan.pendingExternalAudioSources()).toEqual([source]);
    expect(f.media.restoreExternalAudioSource).not.toHaveBeenCalled();
    await f.session.restoreMedia(f.generation, { kind: 'audio' });
    expect(f.media.restoreExternalAudioSource).toHaveBeenCalledOnce();
    expect(f.plan.pendingExternalAudioSources()).toEqual([]);
    expect(f.finishProject).toHaveBeenCalledOnce();
  });
});
