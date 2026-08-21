import { describe, expect, it, vi } from 'vitest';
import { createNativePreviewRuntime } from '../src/media-player-adapter.js';

describe('native preview runtime', () => {
  it('從 mpv 切回 HTML5 後仍能讓 OS 視窗讓位，並清掉 guides 與 bounds feeder', async () => {
    const calls = [];
    const mpv = {
      launch: vi.fn(async payload => { calls.push(['launch', payload]); return { ok: true, duration: 12 }; }),
      quit: vi.fn(async () => { calls.push(['quit']); }),
      show: vi.fn(async visible => { calls.push(['show', visible]); }),
      setBounds: vi.fn(async bounds => { calls.push(['bounds', bounds]); }),
      setGuide: vi.fn(async guide => { calls.push(['subtitle-guide', guide]); }),
      setImageGuide: vi.fn(async guide => { calls.push(['image-guide', guide]); }),
      play: vi.fn(async () => { calls.push(['mpv-play']); }),
    };
    const video = {
      play: vi.fn(async () => { calls.push(['html5-play']); }),
      pause: vi.fn(),
      currentTime: 0,
      playbackRate: 1,
    };
    const listeners = new Map();
    const windowTarget = {
      addEventListener: vi.fn((name, handler) => listeners.set(name, handler)),
      removeEventListener: vi.fn((name, handler) => {
        if (listeners.get(name) === handler) listeners.delete(name);
      }),
    };
    const resizeObserver = { observe: vi.fn(), disconnect: vi.fn() };
    const ResizeObserverCtor = vi.fn(function ResizeObserverBoundary() { return resizeObserver; });
    const clearIntervalFn = vi.fn();
    let bounds = { x: 10, y: 20, w: 640, h: 360 };

    const runtime = createNativePreviewRuntime({
      video,
      mpv,
      windowTarget,
      ResizeObserverCtor,
      setIntervalFn: vi.fn(() => 71),
      clearIntervalFn,
    });

    await runtime.enterMpv({
      src: 'C:\\media\\native.mxf',
      bounds,
      audio: [],
      boundsElement: {},
      readBounds: () => bounds,
    });
    await runtime.setSubtitleGuide({ x: 1, y: 2, w: 30, h: 40 });
    await runtime.setImageGuide({ html: '<div>image</div>', rect: bounds });
    await runtime.play();

    expect(runtime.snapshot()).toEqual({
      mode: 'mpv',
      activeTransport: 'mpv',
      nativeVisible: true,
      subtitleGuideActive: true,
      imageGuideActive: true,
      boundsFeeding: true,
    });

    await runtime.enterHtml5();
    await runtime.setNativeVisible(false); // 對話框／選單重疊：不能掉進 HTML5 no-op。
    await runtime.play();
    bounds = { x: 30, y: 40, w: 800, h: 450 };
    listeners.get('resize')?.();

    expect(runtime.snapshot()).toEqual({
      mode: 'html5',
      activeTransport: 'html5',
      nativeVisible: false,
      subtitleGuideActive: false,
      imageGuideActive: false,
      boundsFeeding: false,
    });
    expect(mpv.setGuide).toHaveBeenLastCalledWith(null);
    expect(mpv.setImageGuide).toHaveBeenLastCalledWith(null);
    expect(mpv.quit).toHaveBeenCalledOnce();
    expect(mpv.show).toHaveBeenLastCalledWith(false);
    expect(mpv.play).toHaveBeenCalledOnce();
    expect(video.play).toHaveBeenCalledOnce();
    expect(resizeObserver.disconnect).toHaveBeenCalledOnce();
    expect(clearIntervalFn).toHaveBeenCalledWith(71);
    expect(listeners.has('resize')).toBe(false);
    expect(mpv.setBounds).toHaveBeenCalledTimes(1);
  });
});
