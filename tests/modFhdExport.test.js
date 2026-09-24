import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDeliveryArgv, _normaliseExportTimecodeWatermark } from '../electron/export-plan.js';
import { MOD_FHD, normalizeDeliveryPresetAudio, deliveryPresetAudioProblem } from '../shared/delivery-formats.cjs';

const FFMPEG = process.env.FFMPEG_PATH || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../electron/ffmpeg/ffmpeg.exe');
const nativeIt = existsSync(FFMPEG) ? it : it.skip;
function runFfmpeg(args) {
  const result = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-y', ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  expect(result.error || result.status, result.stderr).toBe(0);
  return result.stderr;
}

const source = { path: 'master.mov', type: 'video', in: 0, out: 3, offset: 0,
  natW: 1920, natH: 1080, fps: 29.97 };
const spec = { format: 'mod-fhd', clips: [source], width: 1280, height: 720,
  fps: 25, videoKbps: 1000, duration: 3, outPath: 'delivery.ts' };
const value = (args, key) => args[args.indexOf(key) + 1];

describe('MOD-FHD 交付規格', () => {
  it('固定規格優先於 payload，禁止 GPU 與 stream copy 繞過 TFF/CBR', () => {
    const plan = buildDeliveryArgv(spec, {
      hasAudioStream: () => false, encoderName: 'h264_nvenc',
      vencArgsBitrate: () => ['-c:v', 'h264_nvenc'], hwdecArgs: () => ['-hwaccel', 'auto'],
    });
    expect(plan).toMatchObject({ plannedEncoder: 'libx264', isGpu: false, kbps: 7280, audioBitrates: ['256k'] });
    expect(plan.label).toContain('MOD-FHD');
    for (const [key, expected] of Object.entries({
      '-c:v': 'libx264', '-profile:v': 'high', '-level:v': '4.1', '-r': '30000/1001',
      '-b:v': '7280k', '-minrate': '7280k', '-maxrate': '7280k', '-bufsize': '7280k',
      '-f': 'mpegts', '-muxrate': '7980k', '-c:a': 'aac', '-profile:a': 'aac_low',
      '-aac_pns': '0', '-ar': '48000', '-ac': '2', '-pcr_period': '40', '-pat_period': '0.1',
      '-mpegts_pmt_start_pid': '1280', '-pes_payload_size': '0',
    })) expect(value(plan.args, key), key).toBe(expected);
    expect(plan.args).toContain('0:4131');
    expect(plan.args).toContain('1:4130');
    expect(plan.args).not.toContain('-movflags');
    expect(plan.args).not.toContain('-hwaccel');
    const graph = value(plan.args, '-filter_complex');
    expect(graph).toContain('s=1920x1080:r=60000/1001');
    expect(graph).toContain('bwdif=mode=send_field:parity=auto:deint=interlaced');
    expect(graph).toContain('tinterlace=mode=interleave_top,setfield=tff');
    expect(graph).toContain('anullsrc=r=48000:cl=stereo');
  });

  it('TC 在交織後以輸出幀率計數，字幕先按場時刻合成', () => {
    const { args } = buildDeliveryArgv({ ...spec, assFileName: 'burn.ass',
      timecodeWatermark: _normaliseExportTimecodeWatermark({ start: '00:00:12:00' }, 29.97),
    }, { hasAudioStream: () => false, timecodeFontFile: 'font.ttf' });
    const graph = value(args, '-filter_complex');
    expect(graph.indexOf('ass=burn.ass')).toBeLessThan(graph.indexOf('tinterlace='));
    expect(graph.indexOf('tinterlace=')).toBeLessThan(graph.indexOf('drawtext='));
    expect(graph).toContain(':r=30:');
  });

  it('恰好兩條 mono 編成左右聲道且不修改原計畫，多聲道不偷偷丟棄', () => {
    const plan = { buses: [{ id: 'left', inputs: [] }, { id: 'right', inputs: [] }],
      streams: [{ id: 's1', layout: 'mono', busIds: ['right'] }, { id: 's2', layout: 'mono', busIds: ['left'] }] };
    const normalized = normalizeDeliveryPresetAudio(MOD_FHD.format, plan);
    expect(normalized.streams[0].busIds).toEqual(['right', 'left']);
    expect(plan.streams).toHaveLength(2);
    expect(deliveryPresetAudioProblem(MOD_FHD.format, normalized)).toBeNull();
    const encoded = buildDeliveryArgv({ ...spec, audioPlan: plan });
    expect(value(encoded.args, '-filter_complex')).toContain('channel_layout=stereo');
    const surround = { buses: plan.buses, streams: [{ layout: '5.1', busIds: ['a','b','c','d','e','f'] }] };
    expect(() => buildDeliveryArgv({ ...spec, audioPlan: surround })).toThrow('單一 Stereo');
    expect(deliveryPresetAudioProblem('h264', surround)).toBeNull();
  });

  it('預設在最終 Stereo 混音套用 −12 dBTP，上游已平衡時不重複處理', () => {
    const route = { buses: ['left', 'right'].map((id, channel) => ({ id, inputs: [{
      file: 'master.mov', sourceStream: 0, sourceChannel: channel, trimStart: 0, trimEnd: 3,
    }] })), streams: [{ layout: 'stereo', busIds: ['left', 'right'] }] };
    const normal = buildDeliveryArgv({ ...spec, audioPlan: route });
    const graph = value(normal.args, '-filter_complex');
    expect(graph).toContain('loudnorm=I=-15.0:TP=-9.0');
    expect(graph).toContain('volume=-3.00dB,aeval=');
    expect(graph).toContain('aformat=channel_layouts=stereo[modBalancedAudio]');
    expect(normal.args).toContain('[modBalancedAudio]');

    const sourceBalanced = structuredClone(route);
    sourceBalanced.buses[0].inputs[0].audioLimiterSpec = { max: -6, min: -12, inputBoost: 0 };
    const withSourceBalance = buildDeliveryArgv({ ...spec, audioPlan: sourceBalanced });
    expect(value(withSourceBalance.args, '-filter_complex')).not.toContain('[modBalancedAudio]');

    const projectBalanced = { ...route, loudness: {
      enabled: true, maximumAmplitude: -6, targetLoudness: -12, isTruePeak: true,
    } };
    const withProjectBalance = buildDeliveryArgv({ ...spec, audioPlan: projectBalanced });
    expect(value(withProjectBalance.args, '-filter_complex')).not.toContain('[modBalancedAudio]');
  });

  nativeIt('實際 AAC：低音量升至 −18 LUFS、真峰值低於 −12 dBTP，純靜音仍可編碼', () => {
    const route = { buses: ['left', 'right'].map(id => ({ id, inputs: [] })),
      streams: [{ layout: 'stereo', busIds: ['left', 'right'] }] };
    const args = buildDeliveryArgv({ ...spec, audioPlan: route }).args;
    const graph = value(args, '-filter_complex');
    const filter = graph.match(/\[apS0\]([^;]+)\[modBalancedAudio\]/)?.[1];
    expect(filter).toBeTruthy();
    const work = mkdtempSync(path.join(tmpdir(), 'subtool-mod-loudness-'));
    const quiet = path.join(work, 'quiet.m4a');
    const silent = path.join(work, 'silent.m4a');
    try {
      runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=3',
        '-af', `volume=0.03,aformat=channel_layouts=stereo,${filter}`,
        '-c:a', 'aac', '-b:a', '256k', quiet]);
      const report = runFfmpeg(['-i', quiet, '-filter_complex', 'ebur128=peak=true', '-f', 'null', 'NUL']);
      const summary = report.slice(report.lastIndexOf('Summary:'));
      const loudness = Number(summary.match(/I:\s+(-?\d+(?:\.\d+)?) LUFS/)?.[1]);
      const peak = Number(summary.match(/Peak:\s+(-?\d+(?:\.\d+)?) dBFS/)?.[1]);
      expect(loudness).toBeGreaterThanOrEqual(-18.5);
      expect(loudness).toBeLessThanOrEqual(-17.5);
      expect(peak).toBeLessThanOrEqual(-12);

      runFfmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=0.3',
        '-af', filter, '-c:a', 'aac', '-b:a', '256k', silent]);
      const silentReport = runFfmpeg(['-i', silent, '-filter_complex', 'ebur128=peak=true', '-f', 'null', 'NUL']);
      expect(silentReport.slice(silentReport.lastIndexOf('Summary:'))).toMatch(/Peak:\s+-inf dBFS/);
    } finally {
      for (const file of [quiet, silent]) if (existsSync(file)) unlinkSync(file);
      rmdirSync(work);
    }
  });
});
