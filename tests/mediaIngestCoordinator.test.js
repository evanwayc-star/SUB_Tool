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
  it('取消舊專案的背景 Proxy 後等待 close，再啟動新專案，不執行舊排隊工作', async () => {
    const coordinator = createMediaIngestCoordinator();
    const owner = { sender: {}, sessionId: 'old-project', requestId: 'old-active' };
    const closed = deferred();
    const child = { kill: vi.fn() };
    await coordinator.enqueue(({ setProcess }) => {
      setProcess(child);
      return { response: 'old playable', completion: closed.promise };
    }, owner);
    const obsoleteWork = vi.fn();
    const obsolete = coordinator.enqueue(obsoleteWork, { ...owner, requestId: 'old-queued' }).catch(error => error);
    let cancelled = false;
    const cancellation = coordinator.cancel({ sender: owner.sender, sessionId: owner.sessionId })
      .then(() => { cancelled = true; });
    const nextWork = vi.fn(() => 'new playable');
    const next = coordinator.enqueue(nextWork, { ...owner, sessionId: 'new-project', requestId: 'new-job' });
    expect(child.kill).toHaveBeenCalledOnce();
    await expect(obsolete).resolves.toBeInstanceOf(IngestSupersededError);
    expect(obsoleteWork).not.toHaveBeenCalled();
    expect(nextWork).not.toHaveBeenCalled();
    expect(cancelled).toBe(false);
    closed.resolve();
    await cancellation;
    await expect(next).resolves.toBe('new playable');
    expect(nextWork).toHaveBeenCalledOnce();
  });

  it('已取消的 session 不再准入遲到工作；新 session 可立即重試', async () => {
    const coordinator = createMediaIngestCoordinator();
    const owner = { sender: {}, sessionId: 'old-project', requestId: 'late' };
    await coordinator.cancel({ sender: owner.sender, sessionId: owner.sessionId });
    const late = vi.fn();
    await expect(coordinator.enqueue(late, owner)).rejects.toBeInstanceOf(IngestSupersededError);
    expect(late).not.toHaveBeenCalled();
    await expect(coordinator.enqueue(() => 'retry', { ...owner, sessionId: 'new-project' })).resolves.toBe('retry');
  });

  it('其他 sender 與晚到的舊 request cancel 不可取消同 session 的新工作', async () => {
    const coordinator = createMediaIngestCoordinator();
    const owner = { sender: {}, sessionId: 'project', requestId: 'retry' };
    const closed = deferred();
    const child = { kill: vi.fn() };
    await coordinator.enqueue(({ setProcess }) => {
      setProcess(child);
      return { response: 'playable', completion: closed.promise };
    }, owner);
    await expect(coordinator.cancel({ ...owner, sender: {} })).resolves.toBe(0);
    await expect(coordinator.cancel({ ...owner, sessionId: 'other-project' })).resolves.toBe(0);
    await expect(coordinator.cancel({ ...owner, requestId: 'old-request' })).resolves.toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
    closed.resolve();
  });

  it('單一 request 取消統一回覆取消錯誤，保留其他 request 與另一視窗的工作', async () => {
    const coordinator = createMediaIngestCoordinator();
    const closed = deferred();
    const owner = { sender: {}, sessionId: 'project', requestId: 'cancelled' };
    const child = { kill: vi.fn() };
    const active = coordinator.enqueue(({ setProcess }) => { setProcess(child); return closed.promise; }, owner)
      .catch(error => error);
    const ownQueued = coordinator.enqueue(() => 'own kept', { ...owner, requestId: 'kept' });
    const other = coordinator.enqueue(() => 'other kept', { ...owner, sender: {} });
    const cancellation = coordinator.cancel(owner);
    closed.reject(new Error('ffmpeg exited 1'));
    await expect(active).resolves.toMatchObject({ code: 'INGEST_SUPERSEDED', message: '媒體轉檔已被較新的載入取代' });
    await cancellation;
    await expect(ownQueued).resolves.toBe('own kept');
    await expect(other).resolves.toBe('other kept');
    await expect(coordinator.enqueue(() => 'same session retry', { ...owner, requestId: 'retry' })).resolves.toBe('same session retry');
  });

  it('有 sender 的 replace 只取代自己工作，不能終止另一視窗的 active writer', async () => {
    const coordinator = createMediaIngestCoordinator();
    const closed = deferred();
    const foreign = { sender: {}, sessionId: 'other-project', requestId: 'other' };
    const child = { kill: vi.fn() };
    await coordinator.enqueue(({ setProcess }) => {
      setProcess(child); return { response: 'other ready', completion: closed.promise };
    }, foreign);
    const next = coordinator.replace(() => 'own ready', { sender: {}, sessionId: 'project', requestId: 'own' });
    expect(child.kill).not.toHaveBeenCalled();
    closed.resolve();
    await expect(next).resolves.toBe('own ready');
  });

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
