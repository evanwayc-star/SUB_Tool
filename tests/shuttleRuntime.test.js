import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMediaPresentationCore } from '../src/media-presentation-core.js';
import { createReverseShuttleSession } from '../src/transport-controller.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function makeHarness({ time = 10, fps = 25, native = false, presentation: suppliedPresentation } = {}) {
  let nowMs = 0;
  let presentedTime = time;
  const scheduled = [];
  const media = {
    displayTime: vi.fn(() => time),
    pause: vi.fn(),
    play: vi.fn(),
    setRate: vi.fn(),
    supportsNativeReverse: vi.fn(() => native),
    setPlaybackDirection: vi.fn().mockResolvedValue(true),
    setReverseShuttleMuted: vi.fn(),
  };
  const presentation = suppliedPresentation || {
    request: vi.fn(target => {
      presentedTime = target;
      time = target;
      return Promise.resolve({ status: 'presented', requestedTime: target, presentedTime: target });
    }),
    cancel: vi.fn(),
    presentedTime: vi.fn(() => presentedTime),
  };
  const onPresented = vi.fn();
  const onReachedStart = vi.fn();
  const session = createReverseShuttleSession({
    media,
    presentation,
    getExactFps: () => fps,
    now: () => nowMs,
    setIntervalFn: callback => {
      const handle = { callback, active: true };
      scheduled.push(handle);
      return handle;
    },
    clearIntervalFn: handle => { if (handle) handle.active = false; },
    onPresented,
    onReachedStart,
  });
  return {
    media, presentation, session, onPresented, onReachedStart, scheduled,
    setNow(value) { nowMs = value; },
    setPresentedTime(value) { presentedTime = value; },
    run(handle) { if (handle?.active) handle.callback(); },
  };
}

describe('reverse shuttle session', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fallback 同時只呈現一個目標，完成後只送忙碌期間的最新位置', async () => {
    const outbound = vi.fn();
    const core = createMediaPresentationCore({
      presentTarget: outbound,
      getTolerance: () => 0.05,
      timeoutMs: 1000,
    });
    const h = makeHarness({ presentation: core });
    await h.session.start(-1);
    const fallbackTick = h.scheduled[0];

    h.setNow(100); h.run(fallbackTick);
    h.setNow(200); h.run(fallbackTick);
    h.setNow(280); h.run(fallbackTick);
    expect(outbound).toHaveBeenCalledTimes(1);

    const firstRequestId = outbound.mock.calls[0][1].requestId;
    core.observe(9.9, { requestId: firstRequestId });
    await flushPromises();
    expect(outbound).toHaveBeenNthCalledWith(2, 9.72, expect.objectContaining({
      requestId: expect.any(Number), signal: expect.any(Object),
    }));
    expect(h.onPresented).toHaveBeenCalledWith(9.9);
  });

  it.each([
    [24000 / 1001, 1],
    [24000 / 1001, 1.5],
    [25, 1.5],
    [30000 / 1001, 2],
  ])('以單調時間與精確 FPS 計算 %.6f fps 的 %sx 目標', async (fps, rate) => {
    const h = makeHarness({ fps });
    await h.session.start(-rate);
    h.setNow(1000);
    h.run(h.scheduled[0]);
    await flushPromises();

    const expected = Math.round((10 - rate) * fps) / fps;
    expect(h.presentation.request).toHaveBeenLastCalledWith(expected);
    h.session.stop();
  });

  it('原生倒播曾有進度後再次停滯，仍會持續監測並切回 fallback', async () => {
    const h = makeHarness({ native: true });
    await h.session.start(-1);
    const healthTick = h.scheduled[0];

    h.setPresentedTime(9.5);
    h.setNow(200);
    h.run(healthTick);
    h.setNow(700);
    h.run(healthTick);

    expect(h.media.setPlaybackDirection).toHaveBeenLastCalledWith('forward');
    expect(h.scheduled).toHaveLength(2);
    h.setNow(800);
    h.run(h.scheduled[1]);
    expect(h.presentation.request).toHaveBeenCalled();
  });

  it('長 GOP 第一次反向畫格有暖機寬限，開始出畫後才使用短 stall 門檻', async () => {
    const h = makeHarness({ native: true });
    await h.session.start(-1);
    const healthTick = h.scheduled[0];

    h.setNow(900);
    h.run(healthTick);
    expect(h.scheduled).toHaveLength(1);

    h.setPresentedTime(9.9);
    h.setNow(1000);
    h.run(healthTick);
    h.setNow(1399);
    h.run(healthTick);
    expect(h.scheduled).toHaveLength(1);

    h.setNow(1400);
    h.run(healthTick);
    expect(h.scheduled).toHaveLength(2);
    expect(h.media.setPlaybackDirection).toHaveBeenLastCalledWith('forward');
  });

  it('停止會封鎖晚到的 backward 啟動結果', async () => {
    const startDirection = deferred();
    const h = makeHarness({ native: true });
    h.media.setPlaybackDirection.mockImplementationOnce(() => startDirection.promise);

    const starting = h.session.start(-1);
    h.session.stop();
    startDirection.resolve(true);
    await starting;
    await flushPromises();

    expect(h.media.setPlaybackDirection).toHaveBeenLastCalledWith('forward');
    expect(h.media.play).not.toHaveBeenCalled();
    expect(h.presentation.cancel).toHaveBeenCalled();
  });

  it('實際呈現開頭後只停止並通知一次', async () => {
    const h = makeHarness({ time: 0.02, fps: 25 });
    await h.session.start(-1);
    h.setNow(100);
    h.run(h.scheduled[0]);
    await flushPromises();

    expect(h.onReachedStart).toHaveBeenCalledTimes(1);
    expect(h.onPresented).toHaveBeenCalledWith(0);
    h.run(h.scheduled[0]);
    expect(h.presentation.request).toHaveBeenCalledTimes(1);
  });

  it('持續倒帶只切換靜音政策，不依賴正向 scrub 音訊', async () => {
    const h = makeHarness();
    await h.session.start(-1);
    h.session.stop();

    expect(h.media.setReverseShuttleMuted).toHaveBeenNthCalledWith(1, true);
    expect(h.media.setReverseShuttleMuted).toHaveBeenLastCalledWith(false);
    expect('scrubAudio' in h.media).toBe(false);
  });
});
