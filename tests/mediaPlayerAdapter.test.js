import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getPlayerAdapter, resetPlayerAdapter,
} from '../src/media-player-adapter.js';

afterEach(() => resetPlayerAdapter(null));

describe('desktop player adapter guide contract', () => {
  it('forwards subtitle guide updates and clear requests to the preload mpv bridge', async () => {
    const setGuide = vi.fn().mockResolvedValue(undefined);
    resetPlayerAdapter({ mpv: { setGuide } });

    const guide = { x: 12, y: 24, w: 320, h: 72 };
    await getPlayerAdapter().setGuide(guide);
    await getPlayerAdapter().setGuide(null);

    expect(setGuide).toHaveBeenNthCalledWith(1, guide);
    expect(setGuide).toHaveBeenNthCalledWith(2, null);
  });

  it('reports an unavailable guide capability instead of silently pretending success', async () => {
    resetPlayerAdapter({ mpv: {} });

    await expect(getPlayerAdapter().setGuide({ x: 0, y: 0, w: 1, h: 1 })).resolves.toBe(false);
  });
});

describe('active transport', () => {
  it('mpv mode exposes native reverse direction while HTML5 keeps the fallback contract', async () => {
    const direction = vi.fn().mockResolvedValue(true);
    const runtime = resetPlayerAdapter({ mpv: {
      launch: vi.fn().mockResolvedValue({ ok: true }),
      direction,
    } });

    expect(runtime.supportsNativeReverse()).toBe(false);
    await runtime.enterMpv({ src: 'D:/media/a.mxf' });
    expect(runtime.supportsNativeReverse()).toBe(true);
    await runtime.direction('backward');
    await runtime.direction('forward');

    expect(direction).toHaveBeenNthCalledWith(1, 'backward');
    expect(direction).toHaveBeenNthCalledWith(2, 'forward');

    await runtime.enterHtml5({ pause: vi.fn() });
    expect(runtime.supportsNativeReverse()).toBe(false);
    await expect(runtime.direction('backward')).resolves.toBe(false);
  });

  it('HTML5 mode delegates transport to the injected video element', async () => {
    const videoEl = {
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
      currentTime: 0,
      playbackRate: 1,
      preservesPitch: true,
    };
    const runtime = resetPlayerAdapter(null, videoEl);
    expect(runtime.type).toBe('html5');

    await runtime.play();
    expect(videoEl.play).toHaveBeenCalled();

    await runtime.pause();
    expect(videoEl.pause).toHaveBeenCalled();

    await runtime.seek(42);
    expect(videoEl.currentTime).toBe(42);

    await runtime.rate(0.5);
    expect(videoEl.playbackRate).toBe(0.5);
    expect(videoEl.preservesPitch).toBe(true);
  });

  it('HTML5 mode reports mpv-only transport operations as unavailable', async () => {
    const runtime = resetPlayerAdapter(null, {});
    await expect(runtime.subSet('test')).resolves.toBe(false);
    await expect(runtime.loadfile('/x')).resolves.toBe(false);
  });
});
