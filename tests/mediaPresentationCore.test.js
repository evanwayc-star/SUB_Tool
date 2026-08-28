import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  createMediaPresentationCore,
  createMediaPresentationSession,
} from '../src/media-presentation-core.js';

describe('media-presentation-core', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('同時只呈現一個目標，忙碌期間只保留最新請求', async () => {
    vi.useFakeTimers();
    const presentTarget = vi.fn();
    const core = createMediaPresentationCore({
      presentTarget,
      getTolerance: () => 0.05,
      timeoutMs: 1000,
    });

    const first = core.request(9);
    const superseded = core.request(8);
    const latest = core.request(7);

    expect(core.isPending()).toBe(true);
    expect(presentTarget).toHaveBeenCalledTimes(1);
    await expect(superseded).resolves.toMatchObject({ status: 'superseded', requestedTime: 8 });

    const firstRequest = presentTarget.mock.calls[0][1];
    core.observe(9.01, { source: 'html5', requestId: firstRequest.requestId });
    await expect(first).resolves.toMatchObject({
      status: 'presented', requestedTime: 9, presentedTime: 9.01, source: 'html5',
    });
    expect(presentTarget).toHaveBeenNthCalledWith(2, 7, expect.objectContaining({
      requestId: expect.any(Number), signal: expect.any(Object),
    }));

    const latestRequest = presentTarget.mock.calls[1][1];
    core.observe(6.99, { source: 'webcodecs', requestId: latestRequest.requestId });
    await expect(latest).resolves.toMatchObject({
      status: 'presented', requestedTime: 7, presentedTime: 6.99, source: 'webcodecs',
    });
    expect(core.isPending()).toBe(false);
  });

  it('逾時只釋放目前請求，之後改送最新目標', async () => {
    vi.useFakeTimers();
    const presentTarget = vi.fn();
    const core = createMediaPresentationCore({ presentTarget, timeoutMs: 250 });

    const first = core.request(5);
    const latest = core.request(3);
    await vi.advanceTimersByTimeAsync(250);

    await expect(first).resolves.toMatchObject({ status: 'timeout', requestedTime: 5 });
    expect(presentTarget).toHaveBeenNthCalledWith(2, 3, expect.objectContaining({
      requestId: expect.any(Number), signal: expect.any(Object),
    }));

    core.observe(3, { requestId: presentTarget.mock.calls[1][1].requestId });
    await expect(latest).resolves.toMatchObject({ status: 'presented', presentedTime: 3 });
  });

  it('取消後晚到的呈現回報不會完成舊請求', async () => {
    const presentTarget = vi.fn();
    const core = createMediaPresentationCore({ presentTarget });
    const pending = core.request(4);

    core.cancel('transport-stopped');
    core.observe(4);

    await expect(pending).resolves.toMatchObject({
      status: 'cancelled', requestedTime: 4, reason: 'transport-stopped',
    });
    expect(core.presentedTime()).toBe(4);
  });

  it('逾時請求的晚到畫格不能誤完成下一個請求', async () => {
    vi.useFakeTimers();
    const presentTarget = vi.fn();
    const core = createMediaPresentationCore({
      presentTarget,
      getTolerance: () => 0.1,
      timeoutMs: 100,
    });
    const first = core.request(5);
    const latest = core.request(4.95);
    const firstRequestId = presentTarget.mock.calls[0][1].requestId;

    await vi.advanceTimersByTimeAsync(100);
    await first;
    const latestRequestId = presentTarget.mock.calls[1][1].requestId;
    core.observe(5, { requestId: firstRequestId, source: 'mpv' });

    let latestSettled = false;
    latest.then(() => { latestSettled = true; });
    await Promise.resolve();
    expect(latestSettled).toBe(false);

    core.observe(4.95, { requestId: latestRequestId, source: 'mpv' });
    await expect(latest).resolves.toMatchObject({ status: 'presented', presentedTime: 4.95 });
  });
});

describe('media presentation session', () => {
  it('WebCodecs takeover、合成畫格等待與 request lifecycle 由同一個 session 擁有', async () => {
    let session;
    session = createMediaPresentationSession({
      getTolerance: () => 0.05,
      presentTarget(targetTime, request) {
        return session.waitForWebCodecsPresentation(targetTime, request);
      },
    });
    session.setWebCodecsTakeover(true);

    const pending = session.request(12);
    expect(session.snapshot()).toEqual({
      pending: true,
      presentedTime: null,
      webCodecsTakeover: true,
      compositeWaiterCount: 1,
    });

    expect(session.reportWebCodecsPresentation([12.01, 11.99])).toBe(true);
    await expect(pending).resolves.toMatchObject({
      status: 'presented', requestedTime: 12, presentedTime: 11.99, source: 'webcodecs',
    });
    expect(session.snapshot()).toEqual({
      pending: false,
      presentedTime: 11.99,
      webCodecsTakeover: true,
      compositeWaiterCount: 0,
    });
  });

  it('reset 取消尚未呈現的工作並一次清掉 takeover 與合成 waiter', async () => {
    let session;
    session = createMediaPresentationSession({
      presentTarget(targetTime, request) {
        return session.waitForWebCodecsPresentation(targetTime, request);
      },
    });
    session.setWebCodecsTakeover(true);
    const pending = session.request(8);

    session.reset('media-reset');

    await expect(pending).resolves.toMatchObject({
      status: 'cancelled', requestedTime: 8, reason: 'media-reset',
    });
    expect(session.snapshot()).toEqual({
      pending: false,
      presentedTime: null,
      webCodecsTakeover: false,
      compositeWaiterCount: 0,
    });
  });
});
