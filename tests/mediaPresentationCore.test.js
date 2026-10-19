import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  createMediaPresentationCore,
  createMediaPresentationSession,
} from '../src/media-presentation-core.js';
import { createNativePreviewRuntime } from '../src/media-player-adapter.js';

function handoffSession(){
  const acknowledgements=[];
  const adapter={type:'mpv',present:vi.fn(()=>new Promise(resolve=>{acknowledgements.push(resolve);} ))};
  const commit=vi.fn(time=>time);
  const session=createMediaPresentationSession({getTolerance:()=>0.01,timeoutMs:2000,
    timeline:{normalizeTarget:t=>t,hasSequence:()=>false,isVirtual:()=>false},
    player:{adapter:()=>adapter,isNative:()=>true},commitPresented:commit});
  return {session,commit,ack:(time)=>acknowledgements.shift()({backend:'mpv',presentedSourceTime:time})};
}

describe('held presented-frame capture',()=>{
  const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
  function fixture(){
    const adapter={type:'mpv',present:vi.fn(async time=>({backend:'mpv',presentedSourceTime:time}))};
    const playback={suspend:vi.fn(),resume:vi.fn(),fail:vi.fn()};
    const session=createMediaPresentationSession({getTolerance:()=>.01,timeoutMs:2000,
      timeline:{normalizeTarget:t=>t,hasSequence:()=>false,isVirtual:()=>false},
      player:{adapter:()=>adapter,isNative:()=>true},commitPresented:t=>t,playback});
    session.setPlaybackIntent(true);playback.resume.mockClear();
    return{session,adapter,playback};
  }
  it.each([false,true])('keeps the native frame paused through pixel capture and resumes only latest intent=%s',async wantsPlay=>{
    const {session,playback,adapter}=fixture(),pixels=deferred(),started=deferred();
    const capture=session.withPresentedFrame(4,async({isCurrent})=>{started.resolve();await pixels.promise;expect(isCurrent()).toBe(true);return'bitmap';});
    await started.promise;
    expect(adapter.present).toHaveBeenCalledWith(4,expect.objectContaining({waitForFrame:true}));
    expect(session.isPlaybackPending()).toBe(true);expect(session.isPending()).toBe(true);
    expect(playback.suspend).toHaveBeenCalledOnce();expect(playback.resume).not.toHaveBeenCalled();
    session.setPlaybackIntent(false);if(wantsPlay)session.setPlaybackIntent(true);
    expect(playback.resume).not.toHaveBeenCalled();pixels.resolve();
    await expect(capture).resolves.toBe('bitmap');
    expect(playback.resume).toHaveBeenCalledTimes(wantsPlay?1:0);
    expect(session.isPending()).toBe(false);
  });
  it.each(['new-seek','reset'])('discards a captured frame after %s and never resumes its obsolete intent',async reason=>{
    const {session,playback,adapter}=fixture(),pixels=deferred(),started=deferred();
    let owns;
    const capture=session.withPresentedFrame(4,async({isCurrent})=>{owns=isCurrent;started.resolve();await pixels.promise;return'obsolete bitmap';});
    const rejected=expect(capture).rejects.toMatchObject({name:'AbortError'});
    await started.promise;
    const newer=reason==='new-seek'?session.requestPlayback(8):null;
    if(reason==='reset')session.reset('new-workspace');
    expect(owns()).toBe(false);pixels.resolve();await rejected;
    if(newer){await newer;expect(adapter.present.mock.calls.at(-1)[0]).toBe(8);}
    expect(playback.resume).toHaveBeenCalledTimes(newer?1:0);
  });
  it('capture I/O failure releases a valid frame and preserves the latest playback intent',async()=>{
    const {session,playback}=fixture();
    await expect(session.withPresentedFrame(4,async()=>{throw new Error('image read failed');})).rejects.toThrow('image read failed');
    expect(playback.resume).toHaveBeenCalledOnce();expect(playback.fail).not.toHaveBeenCalled();
    expect(session.isPlaybackPending()).toBe(false);
  });
});

describe('visible presenter may change during an acknowledged seek',()=>{
  it('反向畫格使用左開右閉區間，拒絕相鄰舊畫格並保留片段起點的clamp',async()=>{
    const {session,ack,commit}=handoffSession();session.setWebCodecsTakeover(true);
    const pending=session.request(3.04);ack(3.04);
    expect(session.reportWebCodecsPresentation([{time:3.2,start:3.04,end:3.2,reverse:true}])).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(session.reportWebCodecsPresentation([{time:3.04,start:2.88,end:3.04,reverse:true}])).toBe(true);
    await expect(pending).resolves.toMatchObject({status:'presented',presentedTime:3.04});
    const initial=session.request(0);ack(0);
    expect(session.reportWebCodecsPresentation([{time:0.16,start:0,end:0.16,reverse:true,startInclusive:true}])).toBe(true);
    await expect(initial).resolves.toMatchObject({status:'presented',presentedTime:0});
  });

  it('WC yields to native before ACK without waiting for an obsolete compositor',async()=>{
    const {session,ack}=handoffSession();session.setWebCodecsTakeover(true);
    const pending=session.request(4);session.setWebCodecsTakeover(false);ack(4);
    await expect(pending).resolves.toMatchObject({status:'presented',presentedTime:4,source:'mpv'});
  });

  it('native ACK cannot complete a seek after WC takes over until every WC layer hits the target',async()=>{
    const {session,ack,commit}=handoffSession();
    const pending=session.request(4);session.setWebCodecsTakeover(true);ack(4);
    await Promise.resolve();await Promise.resolve();
    expect(session.isPending()).toBe(true);expect(commit).not.toHaveBeenCalled();
    expect(session.reportWebCodecsPresentation([4,3])).toBe(false);
    expect(session.reportWebCodecsPresentation([4,4])).toBe(true);
    await expect(pending).resolves.toMatchObject({status:'presented',presentedTime:4,source:'webcodecs'});
  });

  it('a second WC takeover invalidates evidence from the first takeover',async()=>{
    const {session,ack}=handoffSession();session.setWebCodecsTakeover(true);
    const pending=session.request(4);
    expect(session.reportWebCodecsPresentation([4])).toBe(true);
    session.setWebCodecsTakeover(false);session.setWebCodecsTakeover(true);ack(4);
    await Promise.resolve();await Promise.resolve();
    expect(session.isPending()).toBe(true);
    session.reportWebCodecsPresentation([4]);
    await expect(pending).resolves.toMatchObject({status:'presented',source:'webcodecs'});
  });

  it('reset removes an old handoff waiter, and late evidence cannot complete the new target',async()=>{
    const {session,ack,commit}=handoffSession();session.setWebCodecsTakeover(true);
    const old=session.request(4);session.reset('new-media');ack(4);
    await expect(old).resolves.toMatchObject({status:'cancelled'});
    session.setWebCodecsTakeover(true);
    const current=session.request(8);ack(8);
    await Promise.resolve();await Promise.resolve();
    expect(session.reportWebCodecsPresentation([4])).toBe(false);expect(commit).not.toHaveBeenCalled();
    session.reportWebCodecsPresentation([8]);
    await expect(current).resolves.toMatchObject({status:'presented',presentedTime:8});
    expect(commit).toHaveBeenCalledOnce();
  });
});

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
    expect(core.presentedTime()).toBeNull(); // 新目標已排隊，舊畫格不可成為暫停權威值
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

  it('舊 adapter Promise 晚到時不覆寫最新呈現位置', async () => {
    const finish = [];
    const core = createMediaPresentationCore({
      presentTarget: () => new Promise(resolve => finish.push(resolve)),
    });
    const old = core.request(5);
    const latest = core.request(7);
    finish[0]({ presentedTime: 5 });
    await expect(old).resolves.toMatchObject({ status: 'presented', presentedTime: 5 });
    expect(core.presentedTime()).toBeNull();
    finish[1]({ presentedTime: 7 });
    await expect(latest).resolves.toMatchObject({ status: 'presented', presentedTime: 7 });
    expect(core.presentedTime()).toBe(7);
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
    expect(core.presentedTime()).toBeNull();

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
      tolerance: expect.closeTo(0.05,12),
      signal: expect.any(Object),
    }));
    expect(calls).toEqual(['commit:103.99']);
  });

  it.each([false,true])('慢速frame覆蓋目標時保留TL意圖、容差轉來源只用同一clip（reverse=%s）',async reverse=>{
    const slow={id:'slow',speed:.25,reverse,in:0,out:2,offset:0};
    const sourceTime=vi.fn((t,c)=>c.reverse?c.out-t*c.speed:t*c.speed);
    const target=4.04,source=reverse?.96:1;
    const adapter={type:'mpv',present:vi.fn(async()=>({backend:'mpv',presentedSourceTime:source,presentedSourceDuration:.04}))};
    const {session,commitPresented}=createSession({timeline:{clipAt:()=>slow,sourceTime,
      timelineTime:s=>reverse?(2-s)/.25:s/.25},player:{adapter:()=>adapter,frameWindow:async()=>({start:source,end:source+.04})}});
    await expect(session.request(target,{tolerance:.018})).resolves.toMatchObject({status:'presented',presentedTime:target});
    expect(adapter.present.mock.calls[0][1].tolerance).toBeCloseTo(.0045,12);
    expect(sourceTime.mock.calls.every(([,c])=>c===slow)).toBe(true);
    expect(commitPresented).toHaveBeenCalledWith(target);
  });

  it('慢速來源的future frame不能靠來源秒數容差冒充目標',async()=>{
    const adapter={type:'mpv',present:vi.fn(async()=>({backend:'mpv',presentedSourceTime:1.01,presentedSourceDuration:.04}))};
    const {session,commitPresented}=createSession({timeline:{clipAt:()=>({speed:.25}),sourceTime:t=>t*.25,timelineTime:s=>s/.25},player:{adapter:()=>adapter,frameWindow:async()=>({start:1,end:1.04})}});
    await expect(session.request(4,{tolerance:.018})).resolves.toMatchObject({status:'failed'});
    expect(commitPresented).not.toHaveBeenCalled();
  });

  it('反轉片段首格使用來源末格coverage而不把播放頭推到後面',async()=>{
    const clip={reverse:true,out:10,speed:.25};
    const adapter={type:'mpv',present:vi.fn(async()=>({backend:'mpv',presentedSourceTime:9.96,presentedSourceDuration:.04}))};
    const {session}=createSession({timeline:{clipAt:()=>clip,sourceTime:t=>10-t*.25,timelineTime:s=>(10-s)/.25},player:{adapter:()=>adapter,frameWindow:async()=>({start:9.96,end:10})}});
    await expect(session.request(0,{tolerance:.018})).resolves.toMatchObject({status:'presented',presentedTime:0});
  });

  it('NTSC reverse trim-out drops only its half-open endpoint, not an internal exact PTS',async()=>{
    const out=30/(30000/1001),clip={in:0,out,offset:0,reverse:true,speed:1};
    const frameWindow=vi.fn(async target=>target>=.967633?{start:.967633,end:1.001}:{start:.934267,end:.967633});
    const adapter={type:'mpv',present:vi.fn(async time=>({backend:'mpv',presentedSourceTime:time}))};
    const {session}=createSession({timeline:{clipAt:()=>clip,sourceTime:t=>out-t,timelineTime:s=>out-s},player:{adapter:()=>adapter,frameWindow}});
    await expect(session.request(0)).resolves.toMatchObject({status:'presented',presentedTime:0});
    expect(frameWindow).toHaveBeenLastCalledWith(1.000999,clip);
    await expect(session.request(out-.967633)).resolves.toMatchObject({status:'presented'});
    expect(frameWindow).toHaveBeenLastCalledWith(.967633,clip);
  });

  it('VFR HTML畫格以實際區間定位，平均FPS不能使上一張紅格冒充藍格',async()=>{
    const callbacks=[];
    const video={currentTime:0,requestVideoFrameCallback:callback=>{callbacks.push(callback);return callbacks.length;},cancelVideoFrameCallback:vi.fn()};
    const adapter=createNativePreviewRuntime({video});
    const clip={speed:.25,fps:1250/49,in:0,out:1,offset:0};
    const {session,commitPresented}=createSession({timeline:{clipAt:()=>clip,sourceTime:t=>t*.25,timelineTime:s=>s/.25},
      player:{adapter:()=>adapter,frameWindow:async()=>({start:.02,end:.08})}});
    const pending=session.request(.08,{tolerance:.018});
    await Promise.resolve();
    expect(video.currentTime).toBe(.02);
    callbacks.shift()(0,{mediaTime:0});
    expect(commitPresented).not.toHaveBeenCalled();
    callbacks.shift()(0,{mediaTime:.02});
    await expect(pending).resolves.toMatchObject({status:'presented',presentedTime:.08});
    expect(commitPresented).toHaveBeenCalledExactlyOnceWith(.08);
  });

  it('無真實來源索引時不信任adapter附上的平均FPS格長',async()=>{
    const adapter={type:'mpv',present:vi.fn(async()=>({backend:'mpv',presentedSourceTime:0,presentedSourceDuration:49/1250}))};
    const {session,commitPresented}=createSession({timeline:{clipAt:()=>({speed:.25}),sourceTime:t=>t*.25,timelineTime:s=>s/.25},
      player:{adapter:()=>adapter,frameWindow:async()=>null}});
    await expect(session.request(.08,{tolerance:.018})).resolves.toMatchObject({status:'failed'});
    expect(adapter.present).toHaveBeenCalledWith(.02,expect.not.objectContaining({frameDuration:expect.anything()}));
    expect(commitPresented).not.toHaveBeenCalled();
  });

  it('等待來源索引時取消呈現，晚到索引不得再送出seek',async()=>{
    let finishIndex;
    const {session,adapter}=createSession({player:{frameWindow:()=>new Promise(resolve=>{finishIndex=resolve;})}});
    const pending=session.request(104);
    session.cancel('new-project');
    finishIndex({start:4,end:4.04});
    await expect(pending).resolves.toMatchObject({status:'cancelled'});
    await Promise.resolve();
    expect(adapter.present).not.toHaveBeenCalled();
  });

  it('單次請求可縮小呈現容差，逐格時不能把上一格當成目標格', async () => {
    const { session, adapter } = createSession();

    await session.request(104, { tolerance: 0.01 });

    expect(adapter.present).toHaveBeenCalledWith(4, expect.objectContaining({
      tolerance: expect.closeTo(0.01,12),
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

  it('mpv 舊畫格完成時不回寫來源時間或提交播放點', async () => {
    const finish = [];
    const nativeAdapter = {
      type: 'mpv',
      present: vi.fn(() => new Promise(resolve => finish.push(resolve))),
    };
    const { session, calls } = createSession({
      player: { adapter: () => nativeAdapter, isNative: () => true },
    });
    const old = session.request(104);
    const latest = session.request(106);
    finish[0]({ backend: 'mpv', presentedSourceTime: 4 });
    await old;
    expect(calls).not.toContain('source:4');
    expect(calls).not.toContain('commit:104');
    expect(session.presentedTime()).toBeNull();
    finish[1]({ backend: 'mpv', presentedSourceTime: 6 });
    await expect(latest).resolves.toMatchObject({ status: 'presented', presentedTime: 106 });
    expect(calls).toContain('source:6');
    expect(calls).toContain('commit:106');
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
