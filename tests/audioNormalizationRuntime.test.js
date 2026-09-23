import { describe, it, expect, vi } from 'vitest';
import {
  extractLoudnormJson,
  createAudioNormalizationRuntime,
} from '../electron/audio-normalization-runtime.js';

describe('audio-normalization-runtime.js', () => {
  describe('extractLoudnormJson 萃取 loudnorm JSON', () => {
    it('能正確從 stderr 輸出中抓取 JSON 物件', () => {
      const mockStderr = `
[Parsed_loudnorm_0 @ 000002166] 
{
\t"input_i" : "-24.12",
\t"input_tp" : "-1.50",
\t"input_lra" : "7.20",
\t"input_thresh" : "-34.50",
\t"output_i" : "-12.00",
\t"output_tp" : "-6.00",
\t"output_lra" : "6.00",
\t"output_thresh" : "-22.10",
\t"normalization_type" : "dynamic",
\t"target_offset" : "12.12"
}
[out#0/null @ 00000216] video:0KiB audio:123KiB
      `;
      const json = extractLoudnormJson(mockStderr);
      expect(json).toBeDefined();
      expect(json.input_i).toBe('-24.12');
      expect(json.target_offset).toBe('12.12');
    });

    it('沒有符合格式時回傳 null', () => {
      expect(extractLoudnormJson('random error output')).toBeNull();
      expect(extractLoudnormJson('')).toBeNull();
      expect(extractLoudnormJson(null)).toBeNull();
    });
  });

  describe('createAudioNormalizationRuntime 執行管線', () => {
    it('兩遍都明確選取指定來源stream，且原始report可供交付重建', async () => {
      const report={input_i:'-22',input_tp:'-2',input_lra:'0',input_thresh:'-32',target_offset:'0'};
      const execute=vi.fn(async (args,options)=>options.onStderr?.(JSON.stringify(report)));
      const runtime=createAudioNormalizationRuntime({createTempPath:()=>'/temp/one.wav',execute});
      const result=await runtime.normalize('master.mxf',{sourceStream:1,isTruePeak:true});
      expect(result.report).toEqual(report);
      for(const [args] of execute.mock.calls) expect(args.slice(args.indexOf('-map'),args.indexOf('-map')+2)).toEqual(['-map','0:a:1']);
      expect(execute.mock.calls[1][0].join(' ')).toContain('measured_LRA=0.0');
    });
    it('取消正在執行的Pass1會停止子程序、清理輸出，不能再做Pass2', async () => {
      const controller=new AbortController();const removeFile=vi.fn();const kill=vi.fn();
      let reject;
      const execute=vi.fn((args,options)=>{options.onProcess({kill});return new Promise((_,r)=>{reject=r;});});
      const runtime=createAudioNormalizationRuntime({createTempPath:()=>'/temp/cancel.wav',execute,removeFile});
      const pending=runtime.normalize('master.mxf',{isTruePeak:true},{signal:controller.signal});
      controller.abort();reject(new Error('killed'));
      await expect(pending).rejects.toMatchObject({name:'AbortError'});
      expect(kill).toHaveBeenCalledOnce();expect(execute).toHaveBeenCalledOnce();
      expect(removeFile).toHaveBeenCalledWith('/temp/cancel.wav');
    });
    it('在開始前取消不會執行ffmpeg',async()=>{
      const execute=vi.fn();const controller=new AbortController();controller.abort();
      const runtime=createAudioNormalizationRuntime({createTempPath:()=>'/temp/pre.wav',execute});
      await expect(runtime.normalize('master.wav',{}, {signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
      expect(execute).not.toHaveBeenCalled();
    });
    it('缺少必要 adapter 時拋出 TypeError', () => {
      expect(() => createAudioNormalizationRuntime()).toThrow(TypeError);
    });

    it('True Peak 模式：執行兩遍分析，並在 Pass 2 傳入測量結果', async () => {
      const calls = [];
      const runtime = createAudioNormalizationRuntime({
        createTempPath: ext => `tmp/test.${ext}`,
        execute: async (args, opts) => {
          calls.push({ args, opts });
          if (opts.jobId === 'loudnorm-p1' && typeof opts.onStderr === 'function') {
            opts.onStderr(`
              {
                "input_i" : "-18.0",
                "input_tp" : "-2.0",
                "input_lra" : "5.0",
                "input_thresh" : "-28.0",
                "target_offset" : "6.0"
              }
            `);
          }
        },
      });

      const res = await runtime.normalize('test.wav', {
        maximumAmplitude: -6.0,
        targetLoudness: -12.0,
        isTruePeak: true,
      });

      expect(calls.length).toBe(2);
      expect(calls[0].opts.jobId).toBe('loudnorm-p1');
      expect(calls[1].opts.jobId).toBe('loudnorm-p2');
      expect(calls[1].args.join(' ')).toContain('measured_I=-18.0');
      expect(res.outputPath).toBe('tmp/test.wav');
      expect(res.isSilence).toBe(false);
    });

    it('無聲保護：若 Pass 1 檢測到極弱無聲，Pass 2 維持 0 dB 不放大', async () => {
      const calls = [];
      const runtime = createAudioNormalizationRuntime({
        createTempPath: ext => `tmp/silence.${ext}`,
        execute: async (args, opts) => {
          calls.push({ args, opts });
          if (opts.jobId === 'loudnorm-p1' && typeof opts.onStderr === 'function') {
            opts.onStderr(`
              {
                "input_i" : "-99.0",
                "input_tp" : "-99.0",
                "input_thresh" : "-99.0",
                "target_offset" : "0.0"
              }
            `);
          }
        },
      });

      const res = await runtime.normalize('silence.wav', {
        maximumAmplitude: -6.0,
        targetLoudness: -12.0,
        isTruePeak: true,
        silenceProtection: true,
      });

      expect(calls.length).toBe(2);
      expect(calls[1].opts.jobId).toBe('loudnorm-p2-silence');
      // 不帶 loudnorm 濾鏡，直接無失真 copy / pcm
      expect(calls[1].args.join(' ')).not.toContain('-af');
      expect(res.isSilence).toBe(true);
    });

    it('Peak 模式：直接調用 alimiter 單遍處理', async () => {
      const calls = [];
      const runtime = createAudioNormalizationRuntime({
        createTempPath: ext => `tmp/peak.${ext}`,
        execute: async (args, opts) => {
          calls.push({ args, opts });
        },
      });

      const res = await runtime.normalize('test.wav', {
        maximumAmplitude: -6.0,
        inputBoost: 3.0,
        isTruePeak: false,
      });

      expect(calls.length).toBe(1);
      expect(calls[0].opts.jobId).toBe('limiter-peak');
      expect(calls[0].args.join(' ')).toContain('alimiter=limit=0.501187');
      expect(res.isSilence).toBe(false);
    });
  });
});
