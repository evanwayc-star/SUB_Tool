import { describe, it, expect } from 'vitest';
import {
  LIMITER_DB_RANGE,
  HARD_LIMITER_PRESETS,
  dbToLinear,
  linearToDb,
  normalizeLimiterOptions,
  normalizeAudioLimiterSpec,
  audioLimiterFilter,
  isAudioReportSilence,
  buildLimiterFilter,
} from '../shared/audio-loudness.cjs';

describe('audio-loudness.cjs — 限制器與 ITU-R BS.1770 純規則', () => {
  it.each([null, '', '  ', true, false, [], {}].map(value => [value]))(
    '缺失或錯型量測值 %j 不可轉成零後用於交付的雙遍濾鏡', value => {
      const valid = { input_i: '-21', input_tp: '-8', input_lra: '3', input_thresh: '-31', target_offset: '0.4' };
      const spec = { max: -6, min: -12, reports: { 0: { ...valid, input_i: value }, 1: valid } };
      const normalized = normalizeAudioLimiterSpec(spec);
      expect(normalized.reports['0']).toBeUndefined();
      expect(normalized.reports['1'].input_i).toBe(-21);
      expect(audioLimiterFilter(spec, 0)).not.toContain('measured_I=');
      expect(audioLimiterFilter(spec, 1)).toContain('measured_I=-21.0');
    },
  );

  it('實際靜音報告的 -inf 仍保留，並維持原音不放大', () => {
    const spec = { max: -6, min: -12, reports: { 0: {
      input_i: '-inf', input_tp: '-inf', input_lra: '0', input_thresh: '-inf', target_offset: '0',
    } } };
    expect(normalizeAudioLimiterSpec(spec).reports['0'].input_i).toBe('-inf');
    expect(audioLimiterFilter(spec, 0)).toBe('anull');
  });

  it.each([
    ['input_i', 20], ['input_tp', 100], ['input_lra', -1], ['input_lra', 100],
    ['input_thresh', 1], ['target_offset', 1000],
  ])('非靜音的 %s=%s 超出 FFmpeg 範圍時不能用於雙遍交付', (field, value) => {
    const report = { input_i: -21, input_tp: -8, input_lra: 3, input_thresh: -31, target_offset: .4 };
    const spec = { max: -6, min: -12, reports: { 0: { ...report, [field]: value }, 1: report } };
    const normalized = normalizeAudioLimiterSpec(spec);
    expect(normalized.reports['0']).toBeUndefined();
    expect(audioLimiterFilter(spec, 0)).not.toContain('measured_I=');
    expect(audioLimiterFilter(spec, 1)).toContain('measured_I=-21.0');
  });
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
        maximumAmplitude: 10, // 超過 -1
        inputBoost: 100, // 超過 50
        targetLoudness: 0, // 超過 -1
        lookAheadTime: 999,
        releaseTime: 5000,
      });
      expect(opts.maximumAmplitude).toBe(-1);
      expect(opts.inputBoost).toBe(50);
      expect(opts.targetLoudness).toBe(-1);
      expect(opts.lookAheadTime).toBe(50);
      expect(opts.releaseTime).toBe(1000);
    });

    it.each([
      [-100, -50], [-50, -50], [-25.5, -25.5], [-1, -1], [0, -1],
    ])('最大聲音與目標共用 -50 到 -1 範圍，%s 正規化為 %s', (raw, expected) => {
      expect(LIMITER_DB_RANGE).toEqual({ min: -50, max: -1 });
      const opts = normalizeLimiterOptions({ maximumAmplitude: raw, targetLoudness: raw });
      expect(opts.maximumAmplitude).toBe(expected);
      expect(opts.targetLoudness).toBe(expected);
    });
  });

  describe('isAudioReportSilence 無聲門限判定', () => {
    it('短音訊沒有整體響度但可聽峰值存在時，不得當成靜音', () => {
      expect(isAudioReportSilence({ input_i: '-inf', input_tp: '-0.00', input_thresh: '-70.00' })).toBe(false);
      expect(isAudioReportSilence({ input_i: '-inf', input_tp: '-95.00', input_thresh: '-70.00' })).toBe(true);
      expect(isAudioReportSilence({ input_i: '-inf', input_tp: '-inf', input_thresh: '-70.00' })).toBe(true);
    });
    it.each([-70, -72, -80])('整體響度不可測且峰值僅 %s dB 時，保存無聲保護而不放大底噪', peak => {
      const report = { input_i: '-inf', input_tp: peak, input_lra: 0, input_thresh: -70, target_offset: 'inf' };
      const spec = { max: -6, min: -12, reports: { 0: report } };
      expect(isAudioReportSilence(report)).toBe(true);
      expect(normalizeAudioLimiterSpec(spec).reports[0]).toEqual(report);
      expect(audioLimiterFilter(spec)).toBe('anull');
    });
    it('相對量測門檻低於 -70 不代表整體響度低於絕對門檻', () => {
      expect(isAudioReportSilence({ input_i: '-60.05', input_tp: '-57.06', input_thresh: '-70.05' })).toBe(false);
      expect(isAudioReportSilence({ input_i: '-65.05', input_tp: '-62.06', input_thresh: '-75.05' })).toBe(false);
    });
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

    it('-12 dB True Peak 單遍使用合法中間目標，再衰減至要求的響度與上限', () => {
      const res = buildLimiterFilter({ maximumAmplitude: -12, targetLoudness: -18 });
      expect(res.mode).toBe('itu1770_single_pass');
      expect(res.filter).toBe('loudnorm=I=-15.0:TP=-9.0:LRA=6.0:linear=true:print_format=json,volume=-3.00dB');
    });

    it('-12 dB True Peak 雙遍保留原輸入量測與偏移，兩遍使用相同中間目標', () => {
      const measured = {
        input_i: '-24.0',
        input_tp: '-1.0',
        input_lra: '10.0',
        input_thresh: '-34.0',
        target_offset: '0.15',
      };
      const res = buildLimiterFilter({ maximumAmplitude: -12, targetLoudness: -18 }, measured);
      expect(res.mode).toBe('itu1770_two_pass');
      expect(res.filter).toBe('loudnorm=I=-15.0:TP=-9.0:LRA=6.0:measured_I=-24.0:measured_TP=-1.0:measured_LRA=10.0:measured_thresh=-34.0:offset=0.15:linear=true:print_format=summary,volume=-3.00dB');
    });

    it('低峰值上限搭配偏高自訂響度時，中間目標仍在 loudnorm 有效範圍內', () => {
      const res = buildLimiterFilter({ maximumAmplitude: -12, targetLoudness: -5 });
      expect(res.filter).toContain('loudnorm=I=-5.0:TP=-9.0:');
      expect(res.filter).toContain(',volume=-3.00dB');
    });

    it('-9 dB 邊界維持原 loudnorm 目標，不追加衰減', () => {
      const res = buildLimiterFilter({ maximumAmplitude: -9, targetLoudness: -15 });
      expect(res.filter).toBe('loudnorm=I=-15.0:TP=-9.0:LRA=6.0:linear=true:print_format=json');
    });

    it('-1 響度目標用合法中間 I / TP 與後增益，不被靜默改成 -5', () => {
      const options = normalizeLimiterOptions({ maximumAmplitude: -1, targetLoudness: -1 });
      expect(options.targetLoudness).toBe(-1);
      expect(buildLimiterFilter(options).filter).toBe('loudnorm=I=-5.0:TP=-5.0:LRA=6.0:linear=true:print_format=json,volume=4.00dB');
      const measured = {
        input_i: '-18.0', input_tp: '-15.0', input_lra: '1.0',
        input_thresh: '-28.0', target_offset: '0.05',
      };
      expect(buildLimiterFilter(options, measured).filter).toBe('loudnorm=I=-5.0:TP=-5.0:LRA=6.0:measured_I=-18.0:measured_TP=-15.0:measured_LRA=1.0:measured_thresh=-28.0:offset=0.05:linear=true:print_format=summary,volume=4.00dB');
    });

    it.each([
      [-50, -50, 'I=-9.0:TP=-9.0:LRA=6.0', ',volume=-41.00dB'],
      [-50, -1, 'I=-5.0:TP=-9.0:LRA=49.0', ',volume=-41.00dB'],
      [-1, -50, 'I=-50.0:TP=-1.0:LRA=49.0', ''],
    ])('True Peak 上限 %s / 目標 %s 在合法參數內優先維持峰值上限', (maximumAmplitude, targetLoudness, loudnorm, postFilter) => {
      const res = buildLimiterFilter({ maximumAmplitude, targetLoudness });
      expect(res.filter).toBe(`loudnorm=${loudnorm}:linear=true:print_format=json${postFilter}`);
    });

    it.each([undefined, true, false])('無聲保護固定啟用（舊設定 %s）：輸出 anull，維持 0 dB 不放大', (silenceProtection) => {
      const measuredSilence = {
        input_i: '-99.0',
        input_tp: '-99.0',
        input_thresh: '-99.0',
      };
      const res = buildLimiterFilter({
        maximumAmplitude: -6.0,
        targetLoudness: -12.0,
        silenceProtection,
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
      expect(res.filter).toContain('alimiter=limit=0.501187:attack=7:release=100:asc=0:level=false');
    });

    it.each([[-50, 3], [-24.09, 0]])('Peak %s dB 的前後補償保留原增益 %s，且限制器範圍合法、最終上限不變', (maximumAmplitude, inputBoost) => {
      const res = buildLimiterFilter({ maximumAmplitude, inputBoost, isTruePeak: false });
      const stages = res.filter.split(',');
      const before = Number(stages[0].match(/^volume=([\d.-]+)dB$/)[1]);
      const nativeLimit = Number(stages[1].match(/alimiter=limit=([\d.]+)/)[1]);
      const after = Number(stages[2].match(/^volume=([\d.-]+)dB$/)[1]);
      expect(nativeLimit).toBeGreaterThanOrEqual(0.0625);
      expect(stages[1]).toContain(':level=false');
      expect(before + after).toBeCloseTo(inputBoost, 6);
      expect(linearToDb(nativeLimit) + after).toBeCloseTo(maximumAmplitude, 6);
      expect(res.gainOffset).toBe(inputBoost);
    });
  });

  describe('HARD_LIMITER_PRESETS 預設集清單', () => {
    it('只提供依序 -1、-6、-12 的提高限制預設，保留既有 -1 與 -6 的參數', () => {
      expect(HARD_LIMITER_PRESETS).toEqual([
        {
          id: 'limit_minus_1db', label: '提高限制到 -1 db', maximumAmplitude: -1,
          inputBoost: 0, targetLoudness: -14, isTruePeak: true, lookAheadTime: 5,
          releaseTime: 100, linkChannels: true, silenceProtection: true,
        },
        {
          id: 'limit_minus_6db', label: '提高限制到 -6 db', maximumAmplitude: -6,
          inputBoost: 0, targetLoudness: -12, isTruePeak: true, lookAheadTime: 7,
          releaseTime: 100, linkChannels: true, silenceProtection: true,
        },
        {
          id: 'limit_minus_12db', label: '提高限制到 -12 db', maximumAmplitude: -12,
          inputBoost: 0, targetLoudness: -18, isTruePeak: true, lookAheadTime: 7,
          releaseTime: 100, linkChannels: true, silenceProtection: true,
        },
      ]);
    });
  });
});
