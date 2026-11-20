import { describe, expect, it } from 'vitest';
import { estimateDeliveryBytes, deliverySizeLabel } from '../shared/delivery-formats.cjs';

const oneHour = { duration: 3600, width: 1920, height: 1080, fps: 29.97, videoKbps: 8000 };
const estimate = (format, overrides = {}) => estimateDeliveryBytes({ ...oneHour, format, ...overrides });

describe('按實際交付片長與音訊編組估算成品大小', () => {
  it('MP3 依所選位元率，WAV 依每個 48 kHz / 24-bit 聲道計算', () => {
    expect(estimate('mp3', { mp3Kbps: 96 })).toBe(43_200_000);
    expect(estimate('mp3')).toBe(144_000_000);
    expect(estimate('wav', { audioPlan: { buses: ['L', 'R'] } })).toBe(1_036_800_000);
  });
  it('H.264 加總每個 AAC stream，ProRes 隨像素數與 FPS 調整', () => {
    expect(estimate('h264', { audioPlan: { streams: [{ layout: '5.1' }, { layout: 'stereo' }] } })).toBe(4_032_000_000);
    expect(estimate('prores')).toBe(100_036_800_000);
    expect(estimate('prores', { width: 960, height: 540, fps: 29.97 / 2 })).toBe(13_411_800_000);
  });
  it.each([
    ['mod-fhd', 7980000], ['airline-dmpes', 1855594], ['airline-dmpes-4m', 4600000],
    ['airline-exw', (500 + 64) * 1050],
  ])('%s 使用封裝碼率或可變碼率估算', (format, bps) => {
    expect(estimate(format)).toBe(3600 * bps / 8);
  });
  it.each([['dvd-iso', 4.5e9], ['bd-iso', 24e9]])('%s 短片小於容量，容量不足則不顯示失真的數字', (format, capacity) => {
    expect(estimate(format, { duration: 60 })).toBeLessThan(capacity / 20);
    expect(estimate(format, { duration: 7200 })).toBeLessThanOrEqual(capacity);
    expect(estimate(format, { duration: 1e7 })).toBeNull();
  });
  it('未定時長或尚在輸入的尺寸不顯示大小', () => {
    expect(estimate('h264', { duration: 0 })).toBeNull();
    expect(estimate('prores', { width: null, height: null })).toBeNull();
    expect(deliverySizeLabel({ duration: 60, format: 'mp3', mp3Kbps: 128 })).toBe('預估約 960 kB');
  });
});
