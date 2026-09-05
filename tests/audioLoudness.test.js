import { describe, it, expect } from 'vitest';
import {
  HARD_LIMITER_PRESETS,
  dbToLinear,
  linearToDb,
  normalizeLimiterOptions,
  isAudioReportSilence,
  buildLimiterFilter,
} from '../shared/audio-loudness.cjs';

describe('audio-loudness.cjs — 限制器與 ITU-R BS.1770 純規則', () => {
  describe('dbToLinear 與 linearToDb 數值換算', () => {
    it('0 dB 換算為線性振幅 1.0', () => {
      expect(dbToLinear(0)).toBeCloseTo(1.0, 5);
      expect(linearToDb(1.0)).toBeCloseTo(0, 5);
    });

    it('-6 dB 換算為約 0.501187', () => {
      expect(dbToLinear(-6)).toBeCloseTo(0.501187, 4);
      expect(linearToDb(0.501187)).toBeCloseTo(-6, 2);
    });

    it('-12 dB 換算為約 0.251189', () => {
      expect(dbToLinear(-12)).toBeCloseTo(0.251189, 4);
      expect(linearToDb(0.251189)).toBeCloseTo(-12, 2);
    });

    it('極低 dB 或 0 振幅正確限制不噴例外', () => {
      expect(dbToLinear(-120)).toBe(0);
      expect(linearToDb(0)).toBe(-100);
      expect(linearToDb(-5)).toBe(-100);
    });
  });

  describe('normalizeLimiterOptions 參數邊界保護', () => {
    it('空物件或無效值回退安全預設值', () => {
      const opts = normalizeLimiterOptions({});
      expect(opts.maximumAmplitude).toBe(-6.0);
      expect(opts.inputBoost).toBe(0.0);
      expect(opts.targetLoudness).toBe(-12.0);
      expect(opts.isTruePeak).toBe(true);
      expect(opts.lookAheadTime).toBe(7);
      expect(opts.releaseTime).toBe(100);
      expect(opts.linkChannels).toBe(true);
      expect(opts.silenceProtection).toBe(true);
    });

    it('超出範圍之數值被正確 clamp', () => {
      const opts = normalizeLimiterOptions({
        maximumAmplitude: 10, // 超過 0
        inputBoost: 100, // 超過 50
        targetLoudness: 0, // 超過 -5
        lookAheadTime: 999,
        releaseTime: 5000,
      });
      expect(opts.maximumAmplitude).toBe(0);
      expect(opts.inputBoost).toBe(50);
      expect(opts.targetLoudness).toBe(-5);
      expect(opts.lookAheadTime).toBe(50);
      expect(opts.releaseTime).toBe(1000);
    });
  });

  describe('isAudioReportSilence 無聲門限判定', () => {
    it('低於 -70 LKFS 絕對門限判定為無聲', () => {
      expect(isAudioReportSilence({ input_i: '-75.2', input_thresh: '-80.0' })).toBe(true);
      expect(isAudioReportSilence({ input_i: '-99.0', input_thresh: '-99.0' })).toBe(true);
    });

    it('真峰值低於 -90 dB 判定為無聲', () => {
      expect(isAudioReportSilence({ input_i: '-65.0', input_tp: '-95.0' })).toBe(true);
    });

    it('正常音量不判定為無聲', () => {
      expect(isAudioReportSilence({ input_i: '-16.5', input_thresh: '-26.8', input_tp: '-2.1' })).toBe(false);
      expect(isAudioReportSilence({ input_i: '-12.0', input_thresh: '-22.0', input_tp: '-6.0' })).toBe(false);
    });

    it('無效 report 物件回傳 false 不崩潰', () => {
      expect(isAudioReportSilence(null)).toBe(false);
      expect(isAudioReportSilence({})).toBe(false);
    });
  });

  describe('buildLimiterFilter 濾鏡建置', () => {
    it('True Peak 模式 (Pass 1)：產生 json 輸出規格之 loudnorm', () => {
      const res = buildLimiterFilter({
        maximumAmplitude: -6.0,
        targetLoudness: -12.0,
        isTruePeak: true,
      });
      expect(res.mode).toBe('itu1770_single_pass');
      expect(res.filter).toContain('loudnorm=I=-12.0:TP=-6.0:LRA=6.0:linear=true:print_format=json');
      expect(res.isSilence).toBe(false);
    });

    it('True Peak 模式 (Pass 2)：代入量測報告產出精準 Two-Pass loudnorm', () => {
      const measured = {
        input_i: '-18.5',
        input_tp: '-3.2',
        input_lra: '8.4',
        input_thresh: '-28.5',
        target_offset: '4.5',
      };
      const res = buildLimiterFilter({
        maximumAmplitude: -6.0,
        targetLoudness: -12.0,
        isTruePeak: true,
      }, measured);

      expect(res.mode).toBe('itu1770_two_pass');
      expect(res.filter).toContain('measured_I=-18.5');
      expect(res.filter).toContain('measured_TP=-3.2');
      expect(res.filter).toContain('measured_LRA=-8.4' === '' ? '' : 'measured_LRA=8.4');
      expect(res.filter).toContain('offset=4.50');
      expect(res.isSilence).toBe(false);
    });

    it('無聲保護觸發時：輸出 anull (維持 0 dB，不放大)', () => {
      const measuredSilence = {
        input_i: '-99.0',
        input_tp: '-99.0',
        input_thresh: '-99.0',
      };
      const res = buildLimiterFilter({
        maximumAmplitude: -6.0,
        targetLoudness: -12.0,
        silenceProtection: true,
      }, measuredSilence);

      expect(res.mode).toBe('silence_bypass');
      expect(res.filter).toBe('anull');
      expect(res.isSilence).toBe(true);
      expect(res.gainOffset).toBe(0);
    });

    it('Peak 模式 (Hard Limiter)：產生 alimiter 濾鏡', () => {
      const res = buildLimiterFilter({
        maximumAmplitude: -6.0,
        inputBoost: 3.0,
        isTruePeak: false,
        lookAheadTime: 7,
        releaseTime: 100,
      });

      expect(res.mode).toBe('hard_limiter_peak');
      expect(res.filter).toContain('volume=3.00dB');
      expect(res.filter).toContain('alimiter=limit=0.501187:attack=7:release=100:asc=0');
    });
  });

  describe('HARD_LIMITER_PRESETS 預設集清單', () => {
    it('包含常用的限制器與 ITU 1770 平衡化預設', () => {
      expect(HARD_LIMITER_PRESETS.length).toBeGreaterThanOrEqual(4);
      const limit6 = HARD_LIMITER_PRESETS.find(p => p.id === 'limit_minus_6db');
      expect(limit6).toBeDefined();
      expect(limit6.maximumAmplitude).toBe(-6.0);

      const bal12to6 = HARD_LIMITER_PRESETS.find(p => p.id === 'balance_minus_12_to_minus_6');
      expect(bal12to6).toBeDefined();
      expect(bal12to6.maximumAmplitude).toBe(-6.0);
      expect(bal12to6.targetLoudness).toBe(-12.0);
    });
  });
});
