import { describe, expect, it } from 'vitest';
import { buildDeliveryArgv, _normaliseExportTimecodeWatermark } from '../electron/export-plan.js';
import { airlineEncoding, airlineMuxArgs } from '../electron/airline-encoding.js';

const source = { path: 'master.mov', type: 'video', in: 0, out: 3, offset: 0,
  natW: 1920, natH: 1080, fps: 25 };
const spec = format => ({ format, clips: [source], width: 1920, height: 1080,
  fps: 25, videoKbps: 5000, duration: 3, outPath: 'video.mpg' });

describe('航空 TS 直接合成交付計畫', () => {
  it.each(['airline-s3k', 'airline-dmpes'])('%s 固定 progressive 並在顯示比例燒錄後轉非方形像素', format => {
    const encoding = airlineEncoding(format);
    const plan = buildDeliveryArgv({ ...spec(format), assFileName: 'burn.ass',
      timecodeWatermark: _normaliseExportTimecodeWatermark({ start: '00:00:12:00' }, 29.97),
    }, { airlineEncoding: encoding, airlineMuxArgs: airlineMuxArgs(), hasAudioStream: () => false, timecodeFontFile: 'font.ttf',
      vencArgsBitrate: () => ['-c:v', 'h264_nvenc'], hwdecArgs: () => ['-hwaccel', 'auto'] });
    const graph = plan.args[plan.args.indexOf('-filter_complex') + 1];
    expect(graph).toContain(format === 'airline-s3k' ? 's=322x240:r=30000/1001' : 's=854x480:r=30000/1001');
    expect(graph).toContain('bwdif=mode=send_frame:parity=auto:deint=interlaced');
    expect(graph).not.toContain('tinterlace=');
    expect(graph.indexOf('ass=burn.ass')).toBeLessThan(graph.indexOf('drawtext='));
    expect(graph.indexOf('drawtext=')).toBeLessThan(graph.indexOf(`setsar=${encoding.sar}`));
    expect(graph).toContain('setfield=prog[vairline]');
    expect(plan.args).not.toContain('-hwaccel');
    expect(plan.args).not.toContain('-movflags');
    expect(plan.args.at(-1)).toBe('video.mpg');
    expect(plan.args.filter(arg => arg === 'video.mpg')).toHaveLength(1);
    expect(plan.args.slice(-2)).toEqual(['mpegts', 'video.mpg']);
    expect(plan.args).not.toContain('-an');
    expect(plan.args).not.toContain('-vn');
    expect(plan.args).not.toContain('h264');
    expect(plan.args).not.toContain('adts');
    expect(plan).toMatchObject({ isGpu: false, duration: 3, kbps: 1500, audioBitrates: ['128k'] });
  });

  it('缺少航空 adapter 不回退一般 H.264，也不偷偷丟棄多聲道', () => {
    expect(() => buildDeliveryArgv(spec('airline-s3k'))).toThrow('缺少影音編碼');
    expect(() => buildDeliveryArgv({ ...spec('airline-dmpes'), audioPlan: {
      buses: [], streams: [{ layout: '5.1', busIds: ['a','b','c','d','e','f'] }],
    } })).toThrow('單一 Stereo');
  });
});
