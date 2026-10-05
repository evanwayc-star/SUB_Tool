import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createMediaIngestCoordinator, IngestSupersededError } = require('../electron/media-intake-runtime.js');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

describe('media ingest coordinator', () => {
  it('shutdown 取消 active、清 pending 並等完整背景 completion，不能再准入', async () => {
    const coordinator = createMediaIngestCoordinator();
    const completion = deferred();
    const child = { kill: vi.fn() };
    await coordinator.replace(({ setProcess }) => { setProcess(child); return { response: 'ready', completion: completion.promise }; });
    const pendingWork = vi.fn(() => 'obsolete');
    const pending = coordinator.enqueue(pendingWork).catch(error => error);
    let ended = false;
    const closing = coordinator.cancelAllAndWait().then(() => { ended = true; });
    expect(child.kill).toHaveBeenCalledOnce();
    await expect(pending).resolves.toBeInstanceOf(IngestSupersededError);
    await expect(coordinator.replace(() => 'new')).rejects.toBeInstanceOf(IngestSupersededError);
    expect(ended).toBe(false);
    expect(pendingWork).not.toHaveBeenCalled();
    completion.resolve();
    await closing;
    expect(coordinator.resume()).toBe(true);
    await expect(coordinator.enqueue(() => 'resumed')).resolves.toBe('resumed');
  });

  it('holds queued cache work until a streaming ingest actually finishes', async () => {
    const coordinator = createMediaIngestCoordinator();
    const completion = deferred();
    const events = [];

    const streaming = coordinator.replace(() => ({ response: 'playable', completion: completion.promise }));
    await expect(streaming).resolves.toBe('playable');

    const queued = coordinator.enqueue(() => {
      events.push('queued:start');
      return 'cached';
    });
    await Promise.resolve();
    expect(events).toEqual([]);

    completion.resolve();
    await expect(queued).resolves.toBe('cached');
    expect(events).toEqual(['queued:start']);
  });

  it('supersedes the active replacement and drops obsolete queued cache work', async () => {
    const coordinator = createMediaIngestCoordinator();
    const oldCompletion = deferred();
    const oldProcess = { kill: vi.fn() };
    const events = [];

    const old = coordinator.replace(({ setProcess }) => {
      setProcess(oldProcess);
      return { response: 'old playable', completion: oldCompletion.promise };
    });
    await expect(old).resolves.toBe('old playable');

    const obsolete = coordinator.enqueue(() => {
      events.push('obsolete');
      return 'obsolete';
    });
    const replacement = coordinator.replace(() => {
      events.push('replacement');
      return 'replacement';
    });

    expect(oldProcess.kill).toHaveBeenCalledOnce();
    await expect(obsolete).rejects.toBeInstanceOf(IngestSupersededError);
    expect(events).toEqual([]);

    oldCompletion.resolve();
    await expect(replacement).resolves.toBe('replacement');
    expect(events).toEqual(['replacement']);
  });

  it('kills a process that appears after its work was already superseded', async () => {
    const coordinator = createMediaIngestCoordinator();
    const starter = deferred();
    const completion = deferred();
    let lateProcess;
    const old = coordinator.replace(({ setProcess }) => starter.promise.then(() => {
      lateProcess = { kill: vi.fn() };
      setProcess(lateProcess);
      return { response: lateProcess, completion: completion.promise };
    }));

    const events = [];
    const replacement = coordinator.replace(() => { events.push('replacement'); return 'replacement'; });
    starter.resolve();

    await expect(old).rejects.toBeInstanceOf(IngestSupersededError);
    expect(lateProcess.kill).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(events).toEqual([]);
    completion.resolve();
    await expect(replacement).resolves.toBe('replacement');
    expect(events).toEqual(['replacement']);
  });
});
