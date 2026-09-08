'use strict';

// 交付影格率：UI 顯示值與 FFmpeg 的精確有理數共用同一份對照。
const DELIVERY_FRAME_RATES = Object.freeze([
  [23.976, '24000/1001'], [24, '24'], [25, '25'], [29.97, '30000/1001'],
  [30, '30'], [48, '48'], [50, '50'], [59.94, '60000/1001'], [60, '60'],
].map(([value, rate]) => Object.freeze({ value, label: String(value), rate })));

function numericRate(value) {
  if (typeof value === 'string' && /^\d+\/\d+$/.test(value)) {
    const [n, d] = value.split('/').map(Number);
    return d > 0 ? n / d : NaN;
  }
  return Number(value);
}

function normalizeDeliveryFrameRate(value, fallback = 25) {
  const n = numericRate(value);
  if (!Number.isFinite(n) || n < 1 || n > 240) return fallback;
  return DELIVERY_FRAME_RATES.find(item => Math.abs(item.value - n) < 0.01)?.value ?? n;
}

function deliveryFrameRateRatio(value, fallback = 25) {
  const n = normalizeDeliveryFrameRate(value, fallback);
  return DELIVERY_FRAME_RATES.find(item => item.value === n)?.rate ?? String(n);
}

function sameDeliveryFrameRate(a, b) {
  const first = normalizeDeliveryFrameRate(a, null);
  const second = normalizeDeliveryFrameRate(b, null);
  return first !== null && second !== null && first === second;
}

module.exports = { DELIVERY_FRAME_RATES, normalizeDeliveryFrameRate, deliveryFrameRateRatio, sameDeliveryFrameRate };
