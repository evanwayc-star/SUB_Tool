import { describe, expect, it } from 'vitest';
import { buildDeliveryArgv } from '../electron/export-plan.js';

const source = { path: 'master.mov', type: 'video', in: 0, out: 10, offset: 0,
  natW: 1920, natH: 1080, fps: 25 };
const audioPlan = {
  buses: ['left', 'right'].map((id, channel) => ({ id, inputs: [{ file: 'master.mov',
    sourceStream: 0, sourceChannel: channel, trimStart: 0, trimEnd: 10 }] })),
  streams: [{ layout: 'stereo', busIds: ['left', 'right'] }],
};
const spec = (format, patch = {}) => ({ format, clips: [source], width: 1280, height: 720,
  fps: 25, duration: 10, videoKbps: 8000, outPath: 'delivery.out', audioPlan, ...patch });
const env = {
  vencArgsBitrate: kbps => ['-c:v', 'libx264', '-b:v', `${kbps}k`],
  proresArgs: () => ['-c:v', 'prores_ks', '-profile:v', '3', '-c:a', 'pcm_s24le'],
};
const value = (args, key) => args[args.indexOf(key) + 1];

describe('完整交付規格由正式 plan 編譯', () => {
  it.each([
    ['prores', 'prores_ks', '1280x720', '25', null],
    ['h264', 'libx264', '1280x720', '25', 8000],
    ['wav', 'pcm_s24le', null, null, null],
    ['dvd-iso', 'mpeg2video', '854x480', '60000/1001', 8500],
    ['bd-iso', 'libx264', '1920x1080', '24', 30000],
    ['mod-fhd', 'libx264', '1920x1080', '60000/1001', 7280],
    ['airline-dmpes', 'libx264', '854x480', '30000/1001', 1500],
    ['airline-dmpes-4m', 'libx264', '854x480', '30000/1001', 4000],
    ['airline-s3k', 'mpeg1video', '322x240', '30000/1001', 1500],
  ])('%s 不需 caller 配對格式設定，保留 codec、畫面與碼率', (format, encoder, size, cadence, kbps) => {
    const input = spec(format);
    const original = structuredClone(input);
    const plan = buildDeliveryArgv(input, env);
    expect(input).toEqual(original);
    expect(plan).toMatchObject({ plannedEncoder: encoder, kbps, duration: 10, isGpu: false });
    const graph = value(plan.args, '-filter_complex');
    if (size) {
      expect(graph).toContain(`s=${size}:r=${cadence}`);
      expect(value(plan.args, '-c:v')).toBe(encoder);
    } else {
      expect(plan.audioChannels).toBe(2);
      expect(value(plan.args, '-c:a')).toBe('pcm_s24le');
      expect(plan.args).not.toContain('-c:v');
    }
    expect(plan.args.at(-1)).toBe('delivery.out');
  });

  it('容量先納入正規化音訊尾端，無法被過期的外部 disc 預算覆寫', () => {
    const longAudio = {
      buses: [{ id: 'mono', inputs: [{ file: 'long.wav', trimStart: '0', trimEnd: '7200' }] }],
      streams: [{ layout: 'mono', busIds: ['mono'] }],
    };
    const plan = buildDeliveryArgv(spec('dvd-iso', { audioPlan: longAudio }), {
      // 舊 caller 可傳入按 10 秒計算的預算；已移除的欄位不得影響現在的決策。
      discEncoding: { videoKbps: 8500, videoArgs: ['-b:v', '8500k'], audioArgs: [], muxArgs: [] },
    });
    expect(plan).toMatchObject({ duration: 7200, kbps: 4100 });
    expect(value(plan.args, '-b:v')).toBe('4100k');
    expect((plan.kbps + 384) * 1000 / 8 * plan.duration).toBeLessThan(4500000000 * 0.92);
    expect(plan.discAudioPlan.streams).toHaveLength(1);
    expect(value(plan.args, '-filter_complex')).toContain('d=7200.000');
  });

  it('DMPES 4M 固定選同規格 codec 與 4.6 Mbps mux，不接受另配 1.5M 封裝', () => {
    const plan = buildDeliveryArgv(spec('airline-dmpes-4m'), {
      airlineEncoding: { videoArgs: ['-c:v', 'mpeg1video'], audioArgs: [], sar: '1/1' },
      airlineMuxArgs: ['-muxrate', '1855594'],
    });
    expect(value(plan.args, '-c:v')).toBe('libx264');
    expect(value(plan.args, '-b:v')).toBe('4000k');
    expect(value(plan.args, '-muxrate')).toBe('4600000');
    expect(value(plan.args, '-filter_complex')).toContain('setsar=32/27');
  });

  it.each(['dvd-iso', 'bd-iso'])('%s 不可容納完整音訊尾端時在編譯階段拒絕', format => {
    const impossible = { buses: [{ id: 'a', inputs: [{ file: 'long.wav', trimEnd: 1e8 }] }],
      streams: [{ layout: 'mono', busIds: ['a'] }] };
    expect(() => buildDeliveryArgv(spec(format, { audioPlan: impossible }))).toThrow(/容量/);
  });

  it('固定 FPS 主導 TC，凍結後的 DF 標記可重複驗證', () => {
    const fonts = { timecodeFontFile: 'font.ttf' };
    const raw = buildDeliveryArgv(spec('mod-fhd', { timecodeWatermark: { start: '01:00:00;00' } }), fonts);
    const frozen = buildDeliveryArgv(spec('mod-fhd', { timecodeWatermark: { start: '01:00:00.00', rate: '30' } }), fonts);
    expect(raw.args).toEqual(frozen.args);
    const graph = value(raw.args, '-filter_complex');
    expect(graph).toContain(':r=30:');
    expect(graph.indexOf('tinterlace=')).toBeLessThan(graph.indexOf('drawtext='));
  });
});
