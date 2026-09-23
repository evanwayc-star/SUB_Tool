import { describe, expect, it } from 'vitest';
import { buildDeliveryArgv } from '../electron/export-plan.js';

const audioPlan = {
  buses: Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, inputs: [{
    file: 'master.mov', sourceStream: 0, sourceChannel: i, trimStart: 0, trimEnd: 3,
  }] })),
  streams: [
    { layout: '5.1', busIds: ['a0', 'a1', 'a2', 'a3', 'a4', 'a5'] },
    { layout: 'stereoLtRt', busIds: ['a6', 'a7'] },
  ],
};

describe('光碟交付計畫', () => {
  it.each(['dvd-iso', 'bd-iso'])('%s 保留多聲道且以顯示比例燒字幕', format => {
    const plan = buildDeliveryArgv({ format, duration: 3, width: 320, height: 240, fps: 25,
      outPath: 'final.iso', assFileName: 'burn.ass', audioPlan,
      clips: [{ path: 'master.mov', type: 'video', in: 0, out: 3, offset: 0, natW: 1920, natH: 1080 }],
    }, { hwdecArgs: () => ['-hwaccel', 'auto'] });
    const graph = plan.args[plan.args.indexOf('-filter_complex') + 1];
    const dvd = format === 'dvd-iso';
    expect(graph).toContain(dvd ? 's=854x480:r=60000/1001' : 's=1920x1080:r=24');
    expect(graph.indexOf('ass=burn.ass')).toBeLessThan(graph.indexOf('[vdisc]'));
    expect(graph).toContain(dvd ? 'setsar=32/27' : 'setsar=1/1');
    expect(graph.includes('tinterlace=mode=interleave_top')).toBe(dvd);
    expect(graph).toContain('pan=mono|c0=c7');
    expect(plan.args).toContain('-c:a:1');
    expect(plan.args).toContain('-dsur_mode:a:1');
    expect(plan.args).not.toContain('-ac');
    expect(plan.args).not.toContain('-hwaccel');
    expect(plan.args.at(-1)).toBe('final.iso');
    expect(plan.audioBitrates).toEqual(dvd ? ['384k', '384k'] : ['640k', '640k']);
  });
});
