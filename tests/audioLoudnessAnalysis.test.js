import { describe, it, expect, vi } from 'vitest';
import {
  analyzePeaksLoudness,
  parseVolumeAnalysis,
} from '../shared/audio-loudness.cjs';
import {
  createAudioNormalizationRuntime,
} from '../electron/audio-normalization-runtime.js';

describe('音訊聲量分析 (analyzePeaksLoudness & parseVolumeAnalysis)', () => {
  describe('analyzePeaksLoudness 純函式', () => {
    it('在 peaks 為空或全零時回傳無聲狀態', () => {
      const emptyRes = analyzePeaksLoudness(null);
      expect(emptyRes.isSilence).toBe(true);
      expect(emptyRes.maxDb).toBe(-100);

      const zeros = new Float32Array([0, 0, 0, 0, 0, 0]);
      const zeroRes = analyzePeaksLoudness(zeros);
      expect(zeroRes.isSilence).toBe(true);
      expect(zeroRes.maxDb).toBe(-100);
    });

    it('能正確計算方波峰值與均方根 dB', () => {
      // 0.5 振幅 -> 20*log10(0.5) = -6.02 dB
      const pks = new Float32Array([
        -0.5, 0.5,
        -0.5, 0.5,
        -0.5, 0.5,
        -0.5, 0.5,
      ]);
      const res = analyzePeaksLoudness(pks);
      expect(res.isSilence).toBe(false);
      expect(res.maxDb).toBeCloseTo(-6.0, 1);
      expect(res.meanDb).toBeCloseTo(-6.0, 1);
    });

    it('能正確計算包含動態變化的波形之最大、平均與最小有效聲量', () => {
      // 模擬有較大聲 (1.0 = 0dB) 與較小聲 (0.1 = -20dB) 的動態音訊
      const pks = new Float32Array([
        -1.0, 1.0,  // 0 dB
        -0.8, 0.8,  // -1.9 dB
        -0.2, 0.2,  // -14 dB
        -0.1, 0.1,  // -20 dB
        -0.05, 0.05 // -26 dB
      ]);
      const res = analyzePeaksLoudness(pks);
      expect(res.isSilence).toBe(false);
      expect(res.maxDb).toBe(0.0);
      expect(res.meanDb).toBeLessThan(res.maxDb);
      expect(res.minDb).toBeLessThan(res.meanDb);
      expect(res.dynamicRangeDb).toBeGreaterThan(10);
    });
  });

  describe('parseVolumeAnalysis 純函式', () => {
    it('能解析 volumedetect 輸出', () => {
      const stderr = `
[Parsed_volumedetect_0 @ 0x7f8a9b] n_samples: 44100
[Parsed_volumedetect_0 @ 0x7f8a9b] mean_volume: -19.4 dB
[Parsed_volumedetect_0 @ 0x7f8a9b] max_volume: -2.3 dB
[Parsed_volumedetect_0 @ 0x7f8a9b] histogram_0db: 0
      `;
      const res = parseVolumeAnalysis(stderr);
      expect(res).not.toBeNull();
      expect(res.maxDb).toBe(-2.3);
      expect(res.meanDb).toBe(-19.4);
      expect(res.minDb).toBe(-39.4);
      expect(res.isSilence).toBe(false);
    });

    it('能解析 loudnorm JSON 並優先採用 ITU-R BS.1770 指標', () => {
      const stderr = `
[Parsed_loudnorm_1 @ 0x7f8a9c] 
{
	"input_i" : "-16.50",
	"input_tp" : "-1.20",
	"input_lra" : "9.80",
	"input_thresh" : "-27.10",
	"output_i" : "-12.00",
	"target_offset" : "4.50"
}
      `;
      const res = parseVolumeAnalysis(stderr);
      expect(res).not.toBeNull();
      expect(res.maxDb).toBe(-1.2);
      expect(res.meanDb).toBe(-16.5);
      expect(res.minDb).toBe(-27.1);
      expect(res.dynamicRangeDb).toBe(9.8);
      expect(res.isSilence).toBe(false);
    });

    it('在全無聲 (-75 LKFS) 時正確判定為無聲', () => {
      const stderr = `
{
	"input_i" : "-85.00",
	"input_tp" : "-99.00",
	"input_lra" : "0.00",
	"input_thresh" : "-95.00",
	"output_i" : "-85.00",
	"target_offset" : "0.00"
}
      `;
      const res = parseVolumeAnalysis(stderr);
      expect(res.isSilence).toBe(true);
    });
  });

  describe('audioNormalizationRuntime.analyze', () => {
    it('能呼叫 ffmpeg 執行 volumedetect 與 loudnorm 快速分析', async () => {
      let executedArgs = null;
      const mockExecute = vi.fn(async (args, opts) => {
        executedArgs = args;
        if (opts && typeof opts.onStderr === 'function') {
          opts.onStderr(`
[Parsed_volumedetect_0] max_volume: -3.5 dB
[Parsed_volumedetect_0] mean_volume: -18.2 dB
{
	"input_i" : "-17.80",
	"input_tp" : "-2.10",
	"input_lra" : "8.50",
	"input_thresh" : "-28.40",
	"target_offset" : "0.00"
}
          `);
        }
      });

      const runtime = createAudioNormalizationRuntime({
        createTempPath: () => 'C:/tmp/test.wav',
        execute: mockExecute,
      });

      const report = await runtime.analyze('C:/test/sample.mp3', { duration: 10 });
      expect(mockExecute).toHaveBeenCalled();
      expect(executedArgs).toContain('-af');
      expect(executedArgs).toContain('volumedetect,loudnorm=print_format=json');
      expect(executedArgs).toContain('-f');
      expect(executedArgs).toContain('null');
      expect(report.maxDb).toBe(-2.1);
      expect(report.meanDb).toBe(-17.8);
      expect(report.minDb).toBe(-28.4);
      expect(report.dynamicRangeDb).toBe(8.5);
    });
  });
});
