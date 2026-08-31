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

  it('同目標的新嚴格容差不能合併進仍在等待的一般請求', async () => {
    const presentTarget = vi.fn();
    const core = createMediaPresentationCore({
      presentTarget,
      getTolerance: () => 0.05,
    });

    const ordinary = core.request(5);
    const strict = core.request(5, { tolerance: 0.01 });

    expect(strict).not.toBe(ordinary);
    expect(presentTarget).toHaveBeenCalledTimes(1);

    const ordinaryRequestId = presentTarget.mock.calls[0][1].requestId;
    expect(core.observe(5.04, { requestId: ordinaryRequestId, source: 'mpv' })).toBe(true);
    await expect(ordinary).resolves.toMatchObject({ status: 'presented', presentedTime: 5.04 });

    expect(presentTarget).toHaveBeenNthCalledWith(2, 5, expect.objectContaining({
      tolerance: 0.01,
    }));
    const strictRequestId = presentTarget.mock.calls[1][1].requestId;
    expect(core.observe(5.04, { requestId: strictRequestId, source: 'mpv' })).toBe(false);
    expect(core.observe(5.005, { requestId: strictRequestId, source: 'mpv' })).toBe(true);
    await expect(strict).resolves.toMatchObject({ status: 'presented', presentedTime: 5.005 });
  });

  it('最新目標回到 active 時會淘汰中間 pending，避免稍後反跳', async () => {
    const presentTarget = vi.fn();
    const core = createMediaPresentationCore({ presentTarget });

    const first = core.request(5);
    const stale = core.request(6);
    const latest = core.request(5);

    expect(latest).toBe(first);
    await expect(stale).resolves.toMatchObject({ status: 'superseded', requestedTime: 6 });

    const requestId = presentTarget.mock.calls[0][1].requestId;
    expect(core.observe(5, { requestId, source: 'mpv' })).toBe(true);
    await expect(latest).resolves.toMatchObject({ status: 'presented', presentedTime: 5 });
    expect(presentTarget).toHaveBeenCalledTimes(1);
  });
});

describe('media presentation session', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

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
    const playback = {
      suspend: vi.fn(),
      resume: vi.fn(),
      fail: vi.fn(),
      commit: vi.fn(),
      ...overrides.playback,
    };
    const session = createMediaPresentationSession({
      getTolerance: () => 0.05,
      timeoutMs: 1000,
      timeline,
      player,
      commitPresented,
      playback,
      ...overrides.options,
    });
    return { session, calls, clip, adapter, timeline, player, commitPresented, playback };
  }

  it('一般跳轉後的播放意圖會等實際畫格呈現完成才恢復', async () => {
    let finishPresentation;
    const waitingAdapter = {
      type: 'html5',
      present: vi.fn(() => new Promise(resolve => { finishPresentation = resolve; })),
    };
    const { session, playback } = createSession({
      player: { adapter: () => waitingAdapter },
    });

    const pending = session.requestPlayback(104);
    expect(session.isPlaybackPending()).toBe(true);
    expect(session.setPlaybackIntent(true)).toBe(true);
    expect(session.playbackIntent()).toBe(true);
    expect(playback.resume).not.toHaveBeenCalled();

    finishPresentation({ backend: 'html5', presentedSourceTime: 4 });
    await expect(pending).resolves.toMatchObject({
      status: 'presented', requestedTime: 104, presentedTime: 104,
    });
    await Promise.resolve();

    expect(playback.resume).toHaveBeenCalledOnce();
    expect(session.isPlaybackPending()).toBe(false);
  });

  it('等待呈現期間又改成暫停，晚到畫格不可恢復播放', async () => {
    let finishPresentation;
    const waitingAdapter = {
      type: 'html5',
      present: vi.fn(() => new Promise(resolve => { finishPresentation = resolve; })),
    };
    const { session, playback } = createSession({
      player: { adapter: () => waitingAdapter },
    });

    const pending = session.requestPlayback(104);
    expect(session.setPlaybackIntent(true)).toBe(true);
    expect(session.setPlaybackIntent(false)).toBe(false);

    finishPresentation({ backend: 'html5', presentedSourceTime: 4 });
    await pending;
    await Promise.resolve();

    expect(playback.resume).not.toHaveBeenCalled();
    expect(session.playbackIntent()).toBe(false);
    expect(session.isPlaybackPending()).toBe(false);
  });

  it('最新播放跳轉逾時時回報失敗並清除播放意圖', async () => {
    vi.useFakeTimers();
    const waitingAdapter = { type: 'html5', present: vi.fn(() => new Promise(() => {})) };
    const { session, playback } = createSession({
      player: { adapter: () => waitingAdapter },
      options: { timeoutMs: 50 },
    });

    const pending = session.requestPlayback(104);
    session.setPlaybackIntent(true);
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toMatchObject({ status: 'timeout', requestedTime: 104 });
    await Promise.resolve();

    expect(playback.fail).toHaveBeenCalledOnce();
    expect(playback.fail).toHaveBeenCalledWith(expect.objectContaining({ status: 'timeout' }));
    expect(session.playbackIntent()).toBe(false);
    expect(session.isPlaybackPending()).toBe(false);
  });

  it('reset 會清除播放 transition，舊呈現結果晚到也不可恢復', async () => {
    let finishPresentation;
    const waitingAdapter = {
      type: 'html5',
      present: vi.fn(() => new Promise(resolve => { finishPresentation = resolve; })),
    };
    const { session, playback } = createSession({
      player: { adapter: () => waitingAdapter },
    });
    session.setPlaybackIntent(true);
    playback.resume.mockClear();
    const pending = session.requestPlayback(104);

    session.reset('media-reset');
    await expect(pending).resolves.toMatchObject({ status: 'cancelled', reason: 'media-reset' });
    expect(session.playbackIntent()).toBe(false);
    expect(session.isPlaybackPending()).toBe(false);

    finishPresentation({ backend: 'html5', presentedSourceTime: 4 });
    await Promise.resolve();
    await Promise.resolve();
    expect(playback.resume).not.toHaveBeenCalled();
  });

  it('播放中連續跳轉只暫停一次，且只有最新目標能恢復', async () => {
    const presentations = [];
    const waitingAdapter = {
      type: 'html5',
      present: vi.fn(() => new Promise(resolve => { presentations.push(resolve); })),
    };
    const { session, playback, commitPresented } = createSession({
      player: { adapter: () => waitingAdapter },
    });
    session.setPlaybackIntent(true);
    playback.resume.mockClear();

    const first = session.requestPlayback(103);
    const obsolete = session.requestPlayback(102);
    const latest = session.requestPlayback(104);

    expect(playback.suspend).toHaveBeenCalledOnce();
    await expect(obsolete).resolves.toMatchObject({ status: 'superseded', requestedTime: 102 });

    presentations[0]({ backend: 'html5', presentedSourceTime: 3 });
    await expect(first).resolves.toMatchObject({ status: 'presented', presentedTime: 103 });
    await Promise.resolve();
    expect(commitPresented).not.toHaveBeenCalled();
    expect(playback.resume).not.toHaveBeenCalled();
    expect(session.isPlaybackPending()).toBe(true);

    presentations[1]({ backend: 'html5', presentedSourceTime: 4 });
    await expect(latest).resolves.toMatchObject({ status: 'presented', presentedTime: 104 });
    await Promise.resolve();
    expect(commitPresented).toHaveBeenCalledOnce();
    expect(commitPresented).toHaveBeenCalledWith(104);
    expect(playback.resume).toHaveBeenCalledOnce();
    expect(session.isPlaybackPending()).toBe(false);
  });

  it('最新播放跳轉失敗時使用 fail port，較舊結果不會接管', async () => {
    const failingAdapter = {
      type: 'html5',
      present: vi.fn().mockRejectedValue(new Error('decoder failed')),
    };
    const { session, playback } = createSession({
      player: { adapter: () => failingAdapter },
    });

    const pending = session.requestPlayback(104);
    session.setPlaybackIntent(true);
    await expect(pending).resolves.toMatchObject({ status: 'failed', requestedTime: 104 });
    await Promise.resolve();

    expect(playback.fail).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed', error: expect.objectContaining({ message: 'decoder failed' }),
    }));
    expect(playback.resume).not.toHaveBeenCalled();
    expect(session.playbackIntent()).toBe(false);
  });

  it('cancel 與 reset 一樣會清除一般播放 transition', async () => {
    const waitingAdapter = { type: 'html5', present: vi.fn(() => new Promise(() => {})) };
    const { session } = createSession({ player: { adapter: () => waitingAdapter } });
    const pending = session.requestPlayback(104);
    session.setPlaybackIntent(true);

    session.cancel('external-seek');

    await expect(pending).resolves.toMatchObject({ status: 'cancelled', reason: 'external-seek' });
    expect(session.playbackIntent()).toBe(false);
    expect(session.isPlaybackPending()).toBe(false);
  });

  it('mpv 實際停止會提交到 session，下一次播放意圖必須重新 resume', () => {
    const { session, playback } = createSession();
    session.setPlaybackIntent(true);
    playback.resume.mockClear();

    expect(session.observePlaybackState(false, { source: 'mpv', reason: 'pause' })).toBe(true);
    expect(session.playbackIntent()).toBe(false);
    expect(playback.commit).toHaveBeenCalledWith(false, { source: 'mpv', reason: 'pause' });

    session.setPlaybackIntent(true);
    expect(playback.resume).toHaveBeenCalledOnce();
  });

  it('呈現中的 pause 是 session 主動 suspend 的回報，不可清掉最新播放意圖', () => {
    const waitingAdapter = { type: 'mpv', present: vi.fn(() => new Promise(() => {})) };
    const { session, playback } = createSession({
      player: { adapter: () => waitingAdapter, isNative: () => true },
    });
    session.requestPlayback(104);
    session.setPlaybackIntent(true);

    expect(session.observePlaybackState(false, { source: 'mpv', reason: 'pause' })).toBe(false);
    expect(session.playbackIntent()).toBe(true);
    expect(session.isPlaybackPending()).toBe(true);
    expect(playback.commit).not.toHaveBeenCalled();
  });

  it.each(['error', 'end-file', 'ended'])(
    '呈現中的 %s 是真正終止，必須取消 transition 並提交停止',
    async reason => {
      const waitingAdapter = { type: 'mpv', present: vi.fn(() => new Promise(() => {})) };
      const { session, playback } = createSession({
        player: { adapter: () => waitingAdapter, isNative: () => true },
      });
      const pending = session.requestPlayback(104);
      session.setPlaybackIntent(true);

      expect(session.observePlaybackState(false, { source: 'mpv', reason })).toBe(true);

      await expect(pending).resolves.toMatchObject({
        status: 'cancelled', reason: `player-${reason}`,
      });
      expect(session.playbackIntent()).toBe(false);
      expect(session.isPlaybackPending()).toBe(false);
      expect(playback.commit).toHaveBeenCalledWith(false, { source: 'mpv', reason });
      expect(playback.resume).not.toHaveBeenCalled();
    },
  );

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

  it('單次請求可縮小呈現容差，逐格時不能把上一格當成目標格', async () => {
    const { session, adapter } = createSession();

    await session.request(104, { tolerance: 0.01 });

    expect(adapter.present).toHaveBeenCalledWith(4, expect.objectContaining({
      tolerance: 0.01,
    }));
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
