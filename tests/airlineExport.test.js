import { describe, expect, it } from 'vitest';
import { buildDeliveryArgv, _normaliseExportTimecodeWatermark } from '../electron/export-plan.js';

const source = { path: 'master.mov', type: 'video', in: 0, out: 3, offset: 0,
  natW: 1920, natH: 1080, fps: 25 };
const spec = format => ({ format, clips: [source], width: 1920, height: 1080,
  fps: 25, videoKbps: 5000, duration: 3, outPath: 'video.mpg' });

describe('航空 TS 直接合成交付計畫', () => {
  it('已壓縮母素材的雙聲道編組保留來源影音起點差，避免 0 ms 報告掩蓋真實遲到', () => {
    const audioPlan = {
      buses: ['left', 'right'].map((id, sourceChannel) => ({ id, inputs: [{
        file: 'master.mov', sourceStream: 0, sourceChannel, trimStart: 0, trimEnd: 3,
      }] })),
      streams: [{ layout: 'stereo', busIds: ['left', 'right'] }],
    };
    const plan = buildDeliveryArgv({ ...spec('airline-dmpes'), audioPlan }, {
      audioVideoStartOffset: () => -1024 / 48000,
    });
    const graph = plan.args[plan.args.indexOf('-filter_complex') + 1];
    expect(graph.match(/asetpts=PTS-STARTPTS-0\.021333\/TB,aresample=first_pts=0/g))
      .toHaveLength(2);
  });

  it.each(['airline-s3k', 'airline-dmpes', 'airline-dmpes-4m'])('%s 固定 progressive 並在顯示比例燒錄後轉非方形像素', format => {
    const plan = buildDeliveryArgv({ ...spec(format), assFileName: 'burn.ass',
      timecodeWatermark: _normaliseExportTimecodeWatermark({ start: '00:00:12:00' }, 29.97),
    }, { hasAudioStream: () => false, timecodeFontFile: 'font.ttf',
      vencArgsBitrate: () => ['-c:v', 'h264_nvenc'], hwdecArgs: () => ['-hwaccel', 'auto'] });
    const graph = plan.args[plan.args.indexOf('-filter_complex') + 1];
    expect(graph).toContain(format === 'airline-s3k' ? 's=322x240:r=30000/1001' : 's=854x480:r=30000/1001');
    expect(graph).toContain('bwdif=mode=send_frame:parity=auto:deint=interlaced');
    expect(graph).not.toContain('tinterlace=');
    expect(graph.indexOf('ass=burn.ass')).toBeLessThan(graph.indexOf('drawtext='));
    expect(graph.indexOf('drawtext=')).toBeLessThan(graph.indexOf(`setsar=${format === 'airline-s3k' ? '200/219' : '32/27'}`));
    expect(graph).toContain('setfield=prog[vairline]');
    if (format === 'airline-s3k') {
      expect(graph).toContain('adelay=671S:all=1[airlineS3kAudio]');
      expect(plan.args).toContain('[airlineS3kAudio]');
    } else expect(graph).not.toContain('[airlineS3kAudio]');
    expect(plan.args).not.toContain('-hwaccel');
    expect(plan.args).not.toContain('-movflags');
    expect(plan.args.at(-1)).toBe('video.mpg');
    expect(plan.args.filter(arg => arg === 'video.mpg')).toHaveLength(1);
    expect(plan.args.slice(-2)).toEqual(['mpegts', 'video.mpg']);
    expect(plan.args).not.toContain('-an');
    expect(plan.args).not.toContain('-vn');
    expect(plan.args).not.toContain('h264');
    expect(plan.args).not.toContain('adts');
    expect(plan).toMatchObject({ isGpu: false, duration: 3, kbps: format.endsWith('-4m') ? 4000 : 1500, audioBitrates: ['128k'] });
    expect(plan.args[plan.args.indexOf('-muxrate') + 1]).toBe(format.endsWith('-4m') ? '4600000' : '1855594');
  });

  it('航空規格由正式計畫選擇，也不偷偷丟棄多聲道', () => {
    expect(buildDeliveryArgv(spec('airline-s3k')).plannedEncoder).toBe('mpeg1video');
    expect(() => buildDeliveryArgv({ ...spec('airline-dmpes'), audioPlan: {
      buses: [], streams: [{ layout: '5.1', busIds: ['a','b','c','d','e','f'] }],
    } })).toThrow('單一 Stereo');
  });
});
