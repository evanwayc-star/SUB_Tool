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
  it('拒絕在沒有專案 FPS 容差時猜測固定影格率', () => {
    expect(() => createMediaPresentationSession({
      timeline: { normalizeTarget: value => value },
      player: { adapter: () => ({ present: vi.fn() }) },
      commitPresented: value => value,
    })).toThrow('getTolerance must be a function');
  });

  function createSession(overrides = {}) {
    const calls = [];
    const clip = { id: 'clip-a' };
    const adapter = {
      type: 'html5',
      present: vi.fn(async sourceTarget => ({ backend: 'html5', presentedSourceTime: sourceTarget - 0.01 })),
    };
    const timeline = {
      normalizeTarget: target => Math.min(120, Math.max(0, Number(target) || 0)),
      hasSequence: () => true,
      clipAt: () => clip,
      enterGap: target => calls.push(`gap:${target}`),
      sourceTime: target => target - 100,
      requiresClip: () => false,
      ensureClip: vi.fn(),
      isVirtual: () => false,
      seekVirtual: target => calls.push(`virtual:${target}`),
      timelineTime: sourceTime => sourceTime + 100,
      ...overrides.timeline,
    };
    const player = {
      adapter: () => adapter,
      isNative: () => false,
      configureNativeSeek: clipArg => calls.push(`profile:${clipArg.id}`),
      exactSeek: () => false,
      setPresentedSourceTime: sourceTime => calls.push(`source:${sourceTime}`),
      ...overrides.player,
    };
    const commitPresented = vi.fn(target => {
      calls.push(`commit:${target}`);
      return target;
    });
    const session = createMediaPresentationSession({
      getTolerance: () => 0.05,
      timeoutMs: 1000,
      timeline,
      player,
      commitPresented,
      ...overrides.options,
    });
    return { session, calls, clip, adapter, timeline, player, commitPresented };
  }

  it('HTML5 呈現由 session 完成來源映射並只提交實際畫格', async () => {
    const { session, adapter, calls } = createSession();

    await expect(session.request(104)).resolves.toMatchObject({
      status: 'presented', requestedTime: 104, presentedTime: 103.99, source: 'html5',
    });
    expect(adapter.present).toHaveBeenCalledWith(4, expect.objectContaining({
      exact: false,
      tolerance: 0.05,
      signal: expect.any(Object),
    }));
    expect(calls).toEqual(['commit:103.99']);
  });

  it('mpv 呈現由 session 選擇 exact seek 並回寫來源時間', async () => {
    const nativeAdapter = {
      type: 'mpv',
      present: vi.fn(async () => ({ backend: 'mpv', presentedSourceTime: 4.02 })),
    };
    const { session, calls } = createSession({
      player: {
        adapter: () => nativeAdapter,
        isNative: () => true,
        exactSeek: () => true,
      },
    });

    await expect(session.request(104)).resolves.toMatchObject({
      status: 'presented', presentedTime: 104.02, source: 'mpv',
    });
    expect(nativeAdapter.present).toHaveBeenCalledWith(4, expect.objectContaining({ exact: true }));
    expect(calls).toEqual(['profile:clip-a', 'source:4.02', 'commit:104.02']);
  });

  it('gap 與虛擬時間軸由 session 合成呈現，不會呼叫播放器', async () => {
    const gap = createSession({ timeline: { clipAt: () => null } });
    await expect(gap.session.request(50)).resolves.toMatchObject({
      status: 'presented', presentedTime: 50, source: 'synthetic',
    });
    expect(gap.adapter.present).not.toHaveBeenCalled();
    expect(gap.calls).toEqual(['gap:50', 'commit:50']);

    const virtual = createSession({
      timeline: { hasSequence: () => false, isVirtual: () => true },
    });
    await expect(virtual.session.request(20)).resolves.toMatchObject({
      status: 'presented', presentedTime: 20, source: 'synthetic',
    });
    expect(virtual.adapter.present).not.toHaveBeenCalled();
    expect(virtual.calls).toEqual(['virtual:20', 'commit:20']);
  });

  it('WebCodecs takeover、合成畫格等待與 request lifecycle 由同一個 session 擁有', async () => {
    const { session } = createSession();
    session.setWebCodecsTakeover(true);

    const pending = session.request(104);
    expect({
      pending: session.isPending(),
      presentedTime: session.presentedTime(),
      webCodecsTakeover: session.webCodecsTakeover(),
    }).toEqual({
      pending: true,
      presentedTime: null,
      webCodecsTakeover: true,
    });

    await Promise.resolve();
    expect(session.reportWebCodecsPresentation([104.01, 103.99])).toBe(true);
    await expect(pending).resolves.toMatchObject({
      status: 'presented', requestedTime: 104, presentedTime: 103.99, source: 'webcodecs',
    });
    expect(session.reportWebCodecsPresentation([104.01, 103.99])).toBe(false);
    expect({
      pending: session.isPending(),
      presentedTime: session.presentedTime(),
      webCodecsTakeover: session.webCodecsTakeover(),
    }).toEqual({
      pending: false,
      presentedTime: 103.99,
      webCodecsTakeover: true,
    });
  });

  it('reset 取消尚未呈現的工作並一次清掉 takeover 與合成 waiter', async () => {
    const waitingAdapter = { type: 'html5', present: vi.fn(() => new Promise(() => {})) };
    const { session } = createSession({ player: { adapter: () => waitingAdapter } });
    session.setWebCodecsTakeover(true);
    const pending = session.request(8);

    session.reset('media-reset');

    await expect(pending).resolves.toMatchObject({
      status: 'cancelled', requestedTime: 8, reason: 'media-reset',
    });
    expect(session.reportWebCodecsPresentation(8)).toBe(false);
    expect({
      pending: session.isPending(),
      presentedTime: session.presentedTime(),
      webCodecsTakeover: session.webCodecsTakeover(),
    }).toEqual({
      pending: false,
      presentedTime: null,
      webCodecsTakeover: false,
    });
  });
});
