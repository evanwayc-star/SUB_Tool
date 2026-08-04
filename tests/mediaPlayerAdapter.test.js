import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getPlayerAdapter, resetPlayerAdapter, setPlayerAdapter,
  BaseMediaPlayerAdapter, Html5Adapter, MpvAdapter,
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

  it('is a safe no-op when the preload bridge has no guide method', async () => {
    resetPlayerAdapter({ mpv: {} });

    await expect(getPlayerAdapter().setGuide({ x: 0, y: 0, w: 1, h: 1 })).resolves.toBeUndefined();
  });
});

describe('BaseMediaPlayerAdapter（no-op 基底）', () => {
  it('所有方法都回傳 resolved promise，不拋例外', async () => {
    const base = new BaseMediaPlayerAdapter();
    expect(base.type).toBe('base');
    expect(base.isAvailable).toBe(true);

    // 每個 async 方法都不該拋
    await expect(base.play()).resolves.toBeUndefined();
    await expect(base.pause()).resolves.toBeUndefined();
    await expect(base.seek(5)).resolves.toBeUndefined();
    await expect(base.rate(2)).resolves.toBeUndefined();
    await expect(base.loadfile('/tmp/x.mp4')).resolves.toBeUndefined();
    await expect(base.quit()).resolves.toBeUndefined();
    await expect(base.subSet('test')).resolves.toBeUndefined();
    await expect(base.mute(true)).resolves.toBeUndefined();

    // sync 方法也不拋
    expect(() => base.brightness(50)).not.toThrow();
    expect(() => base.onEvent(() => {})).not.toThrow();
    expect(() => base.onImagePointer(() => {})).not.toThrow();
  });
});

describe('Html5Adapter（<video> 封裝）', () => {
  it('play/pause/seek/rate 委派給注入的 video 元素', async () => {
    const videoEl = {
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
      currentTime: 0,
      playbackRate: 1,
      preservesPitch: true,
    };
    const adapter = new Html5Adapter(videoEl);
    expect(adapter.type).toBe('html5');

    await adapter.play();
    expect(videoEl.play).toHaveBeenCalled();

    await adapter.pause();
    expect(videoEl.pause).toHaveBeenCalled();

    await adapter.seek(42);
    expect(videoEl.currentTime).toBe(42);

    await adapter.rate(0.5);
    expect(videoEl.playbackRate).toBe(0.5);
    expect(videoEl.preservesPitch).toBe(true);
  });

  it('mpv 專屬方法是安全的 no-op（繼承自 Base）', async () => {
    const adapter = new Html5Adapter({});
    await expect(adapter.subSet('test')).resolves.toBeUndefined();
    await expect(adapter.setGuide({ x: 0, y: 0, w: 1, h: 1 })).resolves.toBeUndefined();
    await expect(adapter.loadfile('/x')).resolves.toBeUndefined();
  });
});

describe('MpvAdapter（mpv IPC 封裝）', () => {
  it('mpv 不存在時所有呼叫都是安全的 no-op', async () => {
    const adapter = new MpvAdapter(null);
    expect(adapter.type).toBe('mpv');
    expect(adapter.isAvailable).toBe(false);

    await expect(adapter.play()).resolves.toBeUndefined();
    await expect(adapter.pause()).resolves.toBeUndefined();
    await expect(adapter.seek(10)).resolves.toBeUndefined();
  });
});

describe('setPlayerAdapter 注入', () => {
  it('setPlayerAdapter 可注入自訂 adapter', () => {
    const custom = new Html5Adapter({});
    setPlayerAdapter(custom);
    expect(getPlayerAdapter()).toBe(custom);
  });
});
