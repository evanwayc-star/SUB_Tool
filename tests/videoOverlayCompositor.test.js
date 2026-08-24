import { describe, it, expect } from 'vitest';
import {
  computePreviewViewport,
  computeSafeFrameBounds,
  computeScaledFontSize,
} from '../src/video-overlay-compositor.js';

describe('video-overlay-compositor', () => {
  it('正確等比縮放並置中計算預覽畫布視窗', () => {
    const vp = computePreviewViewport(1920, 1080, 1920, 1080);
    expect(vp.width).toBe(1920);
    expect(vp.height).toBe(1080);
    expect(vp.left).toBe(0);
    expect(vp.top).toBe(0);
    expect(vp.scale).toBe(1.0);

    // 寬螢幕縮小預覽
    const vpSmall = computePreviewViewport(960, 540, 1920, 1080);
    expect(vpSmall.width).toBe(960);
    expect(vpSmall.height).toBe(540);
    expect(vpSmall.scale).toBe(0.5);
  });

  it('精確計算 90% 與 80% 安全框尺寸', () => {
    const { safe90, safe80 } = computeSafeFrameBounds(1000, 500);
    expect(safe90).toEqual({ x: 50, y: 25, w: 900, h: 450 });
    expect(safe80).toEqual({ x: 100, y: 50, w: 800, h: 400 });
  });

  it('嚴格遵守鐵律 §0.2：字級縮放基準為畫面高 ÷ PlayResY', () => {
    // 60px 字級，在 540px 高度（1080 的一半）下應為 30px
    const scaled = computeScaledFontSize(60, 540, 1080);
    expect(scaled).toBe(30);

    // 1080px 下維持 60px
    expect(computeScaledFontSize(60, 1080, 1080)).toBe(60);
  });
});
