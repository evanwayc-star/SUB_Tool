import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMpvSourceTransition } from '../src/mpv-source-transition.js';

afterEach(() => vi.useRealTimers());

describe('mpv 來源切換', () => {
  it('忽略載入初始影格，直到 seek 目標來源時間到達才交還播放點', () => {
    const transition = createMpvSourceTransition();
    const token = transition.begin();
    expect(transition.observe(0, 0.05)).toBe(false);
    transition.ready(token, 8);
    expect(transition.observe(0, 0.05)).toBe(false);
    expect(transition.observe(8.02, 0.05)).toBe(true);
    expect(transition.pending()).toBe(false);
    transition.reset();
  });

  it('舊切換的完成／失敗不能清掉新切換；新切換沒有畫格則逾時釋放', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const transition = createMpvSourceTransition({ timeoutMs: 100, onTimeout });
    const old = transition.begin();
    const current = transition.begin();
    expect(transition.ready(old, 3)).toBe(false);
    transition.fail(old);
    expect(transition.pending()).toBe(true);
    transition.ready(current, 7);
    vi.advanceTimersByTime(100);
    expect(transition.pending()).toBe(false);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});
