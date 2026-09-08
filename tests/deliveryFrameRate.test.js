import { describe, it, expect } from 'vitest';
import { DELIVERY_FRAME_RATES, deliveryFrameRateRatio, normalizeDeliveryFrameRate, sameDeliveryFrameRate } from '../shared/delivery-frame-rate.cjs';
import { createDeliveryList } from '../src/delivery-list.js';
import { buildDeliveryArgv } from '../electron/export-plan.js';

describe('交付 FPS', () => {
  it('NTSC 使用精確分數，24 與 30 不會誤認為 NTSC', () => {
    expect(DELIVERY_FRAME_RATES.map(r => deliveryFrameRateRatio(r.value))).toEqual([
      '24000/1001', '24', '25', '30000/1001', '30', '48', '50', '60000/1001', '60',
    ]);
    expect(normalizeDeliveryFrameRate('30000/1001')).toBe(29.97);
    expect(normalizeDeliveryFrameRate('25;bad')).toBe(25);
    expect(sameDeliveryFrameRate(29.97, 30000 / 1001)).toBe(true);
    expect(sameDeliveryFrameRate(undefined, 25)).toBe(false);
  });

  it('每列 FPS 可獨立指定、折返保留，WAV 不套用影格轉換', () => {
    const config = { projectTag: 'test', fps: 25, canvasW: 1920, canvasH: 1080 };
    const list = createDeliveryList(config);
    list.add(); list.setTargetFps(1, 29.97);
    list.add(); list.setTargetFps(2, 60); list.setFormat(2, 'wav');
    const restored = createDeliveryList({ ...config, initial: structuredClone(list.rows()) });
    const jobs = restored.toJobs({ duration: 12, timelineStartTimecode: '00:00:00:00' });
    expect(jobs.map(j => j.fps)).toEqual([25, 29.97, 25]);
    expect(jobs.map(j => j.duration)).toEqual([12, 12, 12]);
    expect(jobs[1].defaultName).toContain('_29.97fps');
    restored.setName(1, 'custom.mp4'); restored.setTargetFps(1, 24);
    expect(restored.get(1).customName).toBe('custom.mp4');
    restored.setTargetFps(0, 0);
    expect(restored.toJobs({})[0].fps).toBe(25);
  });

  it('不同或未知來源 FPS 禁止直接複製影片，改用精確 FPS 重編碼', () => {
    const spec = {
      format: 'h264', width: 320, height: 180, fps: 29.97, duration: 2, outPath: 'out.mp4',
      clips: [{ path: 'master.mp4', type: 'video', in: 0, out: 2, offset: 0, natW: 320, natH: 180, fps: 25 }],
    };
    const env = { hasAudioStream: () => false, vencArgsBitrate: () => ['-c:v', 'libx264'] };
    const converted = buildDeliveryArgv(spec, env);
    expect(converted.plannedEncoder).toBe('libx264');
    expect(converted.args[converted.args.indexOf('-r') + 1]).toBe('30000/1001');
    expect(converted.args[converted.args.indexOf('-filter_complex') + 1]).toContain('fps=30000/1001');
    const matched = buildDeliveryArgv({ ...spec, fps: 25 }, env);
    expect(matched.plannedEncoder).toBe('copy');
    expect(buildDeliveryArgv({ ...spec, clips: [{ ...spec.clips[0], fps: undefined }] }, env).plannedEncoder).toBe('libx264');
  });
});
