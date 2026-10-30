import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { waitForReverseAudioProgress } = require('../scripts/acceptance/verify-media-context-menus.js');
const clipId = 'reverse-fixture', clipPath = 'C:/fixture.mp4';

function sampleAt(now, startDelay = 0) {
  const playing = now >= startDelay;
  const source = 4.96 - Math.max(0, now - startDelay) / 500;
  return {
    clipId, clipPath, source, timeline: (6 - source) / 2,
    playing, pending: false, presentation: false, audible: true,
    probeIndex: 0, liveTrack: true, liveGain: true,
    rms: playing ? .12 : 0, frequency: playing ? (source >= 3 ? 880 : 330) : 0,
  };
}

async function observe(read, elapsed = 10000) {
  // Attach the rejection handler before advancing the clock: negative controls
  // must report a real rejected acceptance result, not an unhandled promise.
  const settled = waitForReverseAudioProgress({ read, clipId, clipPath })
    .then(value => ({ value }), error => ({ error, elapsed: Date.now() }));
  await vi.advanceTimersByTimeAsync(elapsed);
  const outcome = await settled;
  expect(vi.getTimerCount()).toBe(0);
  return outcome;
}

describe('媒體右鍵驗收以實際來源與 PCM 進度取樣', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => vi.useRealTimers());

  it.each([0, 650])('起播延遲 %i ms 仍驗兩段同音軌的原始頻率與反向時間', async startDelay => {
    const { value, error } = await observe(() => sampleAt(Date.now(), startDelay));
    expect(error).toBeUndefined();
    expect(value.first).toMatchObject({ frequency: 880, rms: .12, probeIndex: 0 });
    expect(value.last).toMatchObject({ frequency: 330, rms: .12, probeIndex: 0 });
    expect(value.last.source).toBeLessThan(value.first.source);
    expect(value.last.timeline).toBeGreaterThan(value.first.timeline);
    expect(value.elapsedMs).toBe(1300 + startDelay);
    expect(value.timeoutMs).toBe(10000);
  });

  it('來源尚未可聽或尚在呈現／起播交接時，舊 analyser PCM 不能通過', async () => {
    const { value } = await observe(() => {
      const now = Date.now();
      if (now < 500) return {
        ...sampleAt(300), audible: now >= 150, pending: now < 300, presentation: now < 500,
      };
      return sampleAt(now - 200);
    });
    expect(value.first.source).toBeCloseTo(4.36);
    expect(value.elapsedMs).toBe(1500);
  });

  it.each([
    ['錯誤頻率', { frequency: 1000 }],
    ['沒有實際出聲', { rms: 0 }],
    ['只剩不可聽 analyser 的舊 PCM', { audible: false }],
  ])('%s 必須在離開來源區間時失敗', async (_name, override) => {
    const { error, elapsed } = await observe(() => ({ ...sampleAt(Date.now()), ...override }));
    expect(error.message).toMatch(/已離開 880Hz 來源區間/);
    expect(elapsed).toBe(600);
  });

  it.each([
    ['音軌被替換', { liveTrack: false }, /音軌或 gain 資格/],
    ['gain 被替換', { liveGain: false }, /音軌或 gain 資格/],
    ['換成另一探針', { probeIndex: 1 }, /不同音軌探針/],
    ['換片段', { clipId: 'other' }, /來源已變更/],
    ['原片段改換來源', { clipPath: 'C:/other.mp4' }, /來源已變更/],
    ['使用者暫停', { playing: false }, /播放已停止/],
  ])('首段完成後%s不能使第二段假通過', async (_name, override, message) => {
    const { error, elapsed } = await observe(() => ({
      ...sampleAt(Date.now()), ...(Date.now() >= 500 ? override : {}),
    }));
    expect(error.message).toMatch(message);
    expect(elapsed).toBe(500);
  });

  it('音訊與來源都有數值但時間軸反向移動仍失敗', async () => {
    const { error } = await observe(() => ({ ...sampleAt(Date.now()), timeline: -Date.now() }));
    expect(error.message).toMatch(/時間方向未前進/);
  });

  it.each([0, 9000])('首段在 %i ms 才出現後停鐘，仍用原先共同期限', async firstAt => {
    const { error, elapsed } = await observe(() => Date.now() < firstAt
      ? sampleAt(0, 1) : sampleAt(300));
    expect(error.message).toMatch(/進度超過共同期限/);
    expect(elapsed).toBe(10000);
  });

  it('讀取本身不完成時也在共同期限結束', async () => {
    const { error, elapsed } = await observe(() => new Promise(() => {}));
    expect(error.message).toMatch(/讀取超過共同期限/);
    expect(elapsed).toBe(10000);
  });
});
