// @subtool-ci windows
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExportSnapshot } from '../src/delivery-job.js';
import { composeDeliveryAudioPlan } from '../src/export-job-engine.js';

const { buildDeliveryArgv, prepareDeliveryPayload } = createRequire(import.meta.url)('../electron/export-plan.js');
const FFMPEG = process.env.FFMPEG_PATH || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../electron/ffmpeg/ffmpeg.exe');
const RATE = 48000;

function clip(file, extra = {}) {
  return { id: 'clip', name: 'mother.mov', path: file, audioSourceId: 'mother',
    audioSrc: 'clip:clip', type: 'video', in: 0.5, out: 3.5, offset: 0.25,
    vtrack: 0, fps: 25, natW: 64, natH: 64, reverse: true, ...extra };
}

function project() {
  return { buses: [{ id: 'left', volume: 1 }, { id: 'right', volume: 1 }],
    sourceMaps: { mother: { channels: [
      { sourceStream: 1, sourceChannel: 0, enabled: true, gain: 1, busIds: ['right'] },
      { sourceStream: 1, sourceChannel: 1, enabled: true, gain: 1, busIds: ['left'] },
    ] } }, exportLayout: { streams: [{ id: 'program', layout: 'stereo', busIds: ['left', 'right'] }] } };
}

function snapshot(file, mode, extra = {}, range = {}) {
  return buildExportSnapshot({ state: { clips: [clip(file, extra)],
    videoTracks: [{ visible: true }], audioProject: mode === 'routed' ? project() : null, ...range },
  mediaTracks: mode === 'legacy-channel' ? [{ source: 'clip:clip', kind: 'element',
    file: 'C:/preview-cache.m4a', sourceStream: 1, sourceChannel: 1, volume: 1 }] : [],
  sequenceEnd: 0.25 + (3 / (extra.speed || 1)) });
}

const graphOf = plan => plan.args[plan.args.indexOf('-filter_complex') + 1];

describe('反轉交付保留母素材音訊', () => {
  it('交付範圍保留升冪 trim，反轉與速度穿過配線編組及入列正規化，固定/解除影音仍靜音', () => {
    const data = snapshot('C:/mother.mov', 'routed', { speed: 2, fadeIn: 1, fadeOut: 1 },
      { exportIn: 0.5, exportOut: 1.5 });
    const composed = composeDeliveryAudioPlan(data.audioPlan);
    const prepared = prepareDeliveryPayload({ ...data, audioPlan: composed, format: 'wav' });
    for (const bus of prepared.audioPlan.buses) {
      expect(bus.inputs).toHaveLength(1);
      expect(bus.inputs[0]).toMatchObject({ file: 'C:/mother.mov', trimStart: 1,
        trimEnd: 3, reverse: true, speed: 2, offset: 0,
        fadeSourceOffset: 0.25, fadeSourceLength: 1.5 });
    }
    expect(snapshot('C:/mother.mov', 'routed', { freezeTime: 0, reverse: true })
      .audioPlan.buses.every(bus => bus.inputs.length === 0)).toBe(true);
    expect(snapshot('C:/mother.mov', 'routed', { audioDetached: true, reverse: true })
      .audioPlan.buses.every(bus => bus.inputs.length === 0)).toBe(true);
  });

  it.each(['routed', 'legacy-channel', 'legacy-raw'])('%s 先裁來源再 areverse/atempo，淡化與延遲維持時間軸順序', mode => {
    const data = snapshot('C:/mother.mov', mode, { speed: 2, fadeIn: 0.5, fadeOut: 0.5 });
    const plan = buildDeliveryArgv({ ...data, format: 'prores', width: 64, height: 64,
      fps: 25, outPath: 'C:/delivery.mov' }, { hasAudioStream: () => true });
    const graph = graphOf(plan);
    expect(graph).toContain('aresample=48000:async=1:first_pts=0,atrim=start=0.500000:end=3.500000,asetpts=PTS-STARTPTS,apad=whole_dur=3.000000,atrim=duration=3.000000,areverse,asetpts=PTS-STARTPTS,atempo=2.000000');
    expect(graph).toContain('afade=t=in:st=0:');
    expect(graph).toContain('afade=t=out:st=1.000');
    expect(graph).toContain('adelay=250:all=1');
    expect(plan.args.join(' ')).not.toContain('preview-cache');
  });

  it('獨立來源 audioPlan 也保留 reverse，舊快照未帶欄位預設正向', () => {
    const audioPlan = { buses: [{ id: 'mono', inputs: [{ file: 'C:/mother.wav',
      trimStart: 1, trimEnd: 3, reverse: true, speed: 0.25 }] }], streams: [] };
    const prepared = prepareDeliveryPayload({ format: 'wav', audioPlan });
    expect(prepared.audioPlan.buses[0].inputs[0].reverse).toBe(true);
    const graph = graphOf(buildDeliveryArgv({ format: 'wav', audioPlan, outPath: 'C:/delivery.wav' }));
    expect(graph).toContain('atrim=start=1.000000:end=3.000000,asetpts=PTS-STARTPTS,apad=whole_dur=2.000000,atrim=duration=2.000000,areverse,asetpts=PTS-STARTPTS,atempo=0.5,atempo=0.500000');
    delete audioPlan.buses[0].inputs[0].reverse;
    expect(prepareDeliveryPayload({ format: 'wav', audioPlan }).audioPlan.buses[0].inputs[0].reverse).toBe(false);
  });
});

describe.skipIf(!existsSync(FFMPEG))('反轉交付實際 PCM 內容', () => {
  let directory, source, external;
  let outputSeq = 0;
  const sourceSamples = [];
  const gapSources = {};
  const execute = args => {
    const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args],
      { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || String(result.stderr));
    return result.stdout;
  };

  beforeAll(() => {
    directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'subtool-reverse-audio-'));
    for (let stream = 0; stream < 2; stream++) {
      const pcm = Buffer.alloc(4 * RATE * 2 * 2);
      for (let frame = 0; frame < 4 * RATE; frame++) for (let channel = 0; channel < 2; channel++) {
        // Deliberately asymmetric in time, stream and channel. A tone alone
        // would stay audible even if it came from the wrong trim/direction.
        const phase = 2 * Math.PI * (173 + stream * 227 + channel * 151) * frame / RATE;
        const level = 2500 + Math.floor(frame / (RATE / 2)) * 650 + stream * 350 + channel * 200;
        pcm.writeInt16LE(Math.round(level * Math.sin(phase)), (frame * 2 + channel) * 2);
      }
      sourceSamples.push(pcm);
      writeFileSync(path.join(directory, `stream${stream}.pcm`), pcm);
    }
    source = path.join(directory, 'mother.mov');
    execute(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=25:d=4',
      '-f', 's16le', '-ar', String(RATE), '-ac', '2', '-i', path.join(directory, 'stream0.pcm'),
      '-f', 's16le', '-ar', String(RATE), '-ac', '2', '-i', path.join(directory, 'stream1.pcm'),
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'prores_ks', '-c:a', 'pcm_s16le', source]);
    external = path.join(directory, 'mother.wav');
    execute(['-y', '-f', 's16le', '-ar', String(RATE), '-ac', '2', '-i', path.join(directory, 'stream1.pcm'), external]);
    for (const kind of ['early-eof', 'delayed-start']) {
      const files = sourceSamples.map((pcm, stream) => {
        const raw = path.join(directory, `${kind}-${stream}.pcm`);
        const file = path.join(directory, `${kind}-${stream}.wav`);
        writeFileSync(raw, kind === 'early-eof' ? pcm.subarray(0, 2 * RATE * 4) : pcm);
        // Raw PCM demuxing regenerates PTS and ignores itsoffset. A WAV input
        // retains the deliberate stream delay in the resulting mother MOV.
        execute(['-y', '-f', 's16le', '-ar', String(RATE), '-ac', '2', '-i', raw, file]);
        return file;
      });
      const audioInputs = files.flatMap(file => [
        ...(kind === 'delayed-start' ? ['-itsoffset', '1'] : []),
        '-i', file,
      ]);
      gapSources[kind] = path.join(directory, `${kind}.mov`);
      execute(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=25:d=4',
        ...audioInputs, '-map', '0:v', '-map', '1:a', '-map', '2:a',
        '-c:v', 'prores_ks', '-c:a', 'pcm_s16le', gapSources[kind]]);
      if (kind === 'delayed-start') {
        const decoded = execute(['-i', gapSources[kind], '-map', '0:a:0', '-af',
          'aresample=48000:async=1:first_pts=0', '-f', 'f32le', '-c:a', 'pcm_f32le', 'pipe:1']);
        expect(rms(decoded, 0, 0.1, 0.9)).toBeLessThan(0.000001);
        expect(rms(decoded, 0, 1.1, 1.4)).toBeGreaterThan(0.05);
      }
    }
  });

  afterAll(() => {
    if (!directory) return;
    const resolved = realpathSync(directory);
    if (path.dirname(resolved) !== realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-reverse-audio-'))
      throw new Error('拒絕清除未驗證的反轉音訊測試目錄');
    rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function render(mode, extra = {}, range = {}, mother = source) {
    const data = snapshot(mother, mode, extra, range);
    const outPath = path.join(directory, `delivery-${outputSeq++}.mov`);
    const plan = buildDeliveryArgv({ ...data, format: 'prores', width: 64, height: 64, fps: 25, outPath },
      { hasAudioStream: () => true, proresArgs: () => ['-c:v', 'prores_ks', '-c:a', 'pcm_s24le'] });
    execute(plan.args);
    return execute(['-i', outPath, '-map', '0:a:0', '-ar', String(RATE), '-ac', '2', '-f', 'f32le', '-c:a', 'pcm_f32le', 'pipe:1']);
  }

  function rms(pcm, channel, start, end) {
    let energy = 0;
    const first = Math.round(start * RATE), last = Math.round(end * RATE);
    for (let frame = first; frame < last; frame++) energy += pcm.readFloatLE((frame * 2 + channel) * 4) ** 2;
    return Math.sqrt(energy / (last - first));
  }

  it.each(['routed', 'legacy-channel', 'legacy-raw'])('%s 每個輸出 sample 倒放正確 stream/channel，保留開頭間隙', mode => {
    const pcm = render(mode);
    expect(pcm.length / (4 * 2)).toBe(3.25 * RATE);
    expect(rms(pcm, 0, 0.05, 0.2)).toBeLessThan(0.000001);
    const stream = mode === 'legacy-raw' ? 0 : 1;
    for (let channel = 0; channel < 2; channel++) {
      const sourceChannel = mode === 'routed' ? 1 - channel : mode === 'legacy-channel' ? 1 : channel;
      // FFmpeg mono -> stereo uses equal-power gain for the legacy channel path.
      const gain = mode === 'legacy-channel' ? Math.SQRT1_2 : 1;
      let maxDifference = 0;
      for (let frame = 0; frame < 3 * RATE; frame++) {
        const expected = sourceSamples[stream].readInt16LE(((3.5 * RATE - 1 - frame) * 2 + sourceChannel) * 2) / 32768 * gain;
        const actual = pcm.readFloatLE(((0.25 * RATE + frame) * 2 + channel) * 4);
        maxDifference = Math.max(maxDifference, Math.abs(actual - expected));
      }
      expect(maxDifference).toBeLessThan(0.000005);
      expect(rms(pcm, channel, 0.3, 0.5)).toBeGreaterThan(rms(pcm, channel, 3, 3.2) * 1.7);
    }
  });

  it('WAV 獨立母素材來源從 trim 尾端倒放，裁切以外音訊不進入輸出', () => {
    const outPath = path.join(directory, 'external-reverse.wav');
    const audioPlan = { buses: [{ id: 'mono', inputs: [{ file: external, sourceStream: 0,
      sourceChannel: 1, trimStart: 1, trimEnd: 3, reverse: true }] }], streams: [] };
    execute(buildDeliveryArgv({ format: 'wav', duration: 2, audioPlan, outPath }).args);
    const pcm = execute(['-i', outPath, '-map', '0:a', '-f', 'f32le', '-c:a', 'pcm_f32le', 'pipe:1']);
    expect(pcm.length / 4).toBe(2 * RATE);
    let maxDifference = 0;
    for (let frame = 0; frame < 2 * RATE; frame++) {
      const expected = sourceSamples[1].readInt16LE(((3 * RATE - 1 - frame) * 2 + 1) * 2) / 32768;
      maxDifference = Math.max(maxDifference, Math.abs(pcm.readFloatLE(frame * 4) - expected));
    }
    expect(maxDifference).toBeLessThan(0.000005);
  });

  it.each(['routed', 'legacy-channel', 'legacy-raw'])('%s 範圍落於反轉淡化內時保留原始音量曲線，固定畫面仍無聲', mode => {
    const pcm = render(mode, { fadeIn: 2, fadeOut: 1 }, { exportIn: 0.75, exportOut: 2.75 });
    expect(pcm.length / (4 * 2)).toBe(2 * RATE);
    const sourceChannel = mode === 'legacy-raw' ? 0 : 1;
    const stream = mode === 'legacy-raw' ? 0 : 1;
    const gain = mode === 'legacy-channel' ? Math.SQRT1_2 : 1;
    let maxDifference = 0;
    for (let frame = 0; frame < 2 * RATE; frame++) {
      const local = 0.5 + frame / RATE;
      const fade = Math.min(local / 2, 1) * Math.min((3 - local) / 1, 1);
      const expected = sourceSamples[stream].readInt16LE(((3 * RATE - 1 - frame) * 2 + sourceChannel) * 2) / 32768 * gain * fade;
      maxDifference = Math.max(maxDifference, Math.abs(pcm.readFloatLE(frame * 8) - expected));
    }
    expect(maxDifference).toBeLessThan(0.00001);
    const fixed = render(mode, { freezeTime: 1, reverse: true });
    expect(rms(fixed, 0, 0.5, 2.5)).toBeLessThan(0.000001);
  });

  it.each(['routed', 'legacy-channel', 'legacy-raw'])('%s 2 倍速音訊長度減半，尾端 marker 先於片頭 marker', mode => {
    const pcm = render(mode, { speed: 2 });
    expect(pcm.length / (4 * 2)).toBeGreaterThan(1.65 * RATE);
    expect(pcm.length / (4 * 2)).toBeLessThanOrEqual(1.75 * RATE);
    expect(rms(pcm, 0, 0.35, 0.45)).toBeGreaterThan(0.07);
    expect(rms(pcm, 0, 0.35, 0.45)).toBeGreaterThan(rms(pcm, 0, 1.5, 1.6) * 1.7);
  });

  it.each(['routed', 'legacy-channel', 'legacy-raw'])('%s 反轉加速與範圍裁切後，淡化仍依原本片段的時間軸秒數', mode => {
    const range = { exportIn: 0.5, exportOut: 1.5 };
    const plain = render(mode, { speed: 2 }, range);
    const faded = render(mode, { speed: 2, fadeIn: 1, fadeOut: 0.5 }, range);
    expect(faded.length).toBe(plain.length);
    expect(rms(plain, 0, 0.1, 0.2)).toBeGreaterThan(0.05);
    let maxDifference = 0;
    for (let frame = 0; frame < plain.length / 8; frame++) {
      const local = 0.25 + frame / RATE;
      const gain = Math.min(local, 1) * Math.min((1.5 - local) / 0.5, 1);
      for (let channel = 0; channel < 2; channel++) {
        const byte = (frame * 2 + channel) * 4;
        maxDifference = Math.max(maxDifference, Math.abs(faded.readFloatLE(byte) - plain.readFloatLE(byte) * gain));
      }
    }
    expect(maxDifference).toBeLessThan(0.00001);
  });

  it.each(['routed', 'legacy-channel', 'legacy-raw'])('%s 母素材音訊提早 EOF 時，反轉後完整片尾靜音移至片頭', mode => {
    const pcm = render(mode, {}, {}, gapSources['early-eof']);
    expect(pcm.length / 8).toBe(3.25 * RATE);
    expect(rms(pcm, 0, 0.3, 1.7)).toBeLessThan(0.000001);
    expect(rms(pcm, 0, 1.85, 2)).toBeGreaterThan(0.05);
    const stream = mode === 'legacy-raw' ? 0 : 1;
    const sourceChannel = mode === 'legacy-raw' ? 0 : 1;
    const gain = mode === 'legacy-channel' ? Math.SQRT1_2 : 1;
    let maxDifference = 0;
    for (let frame = 0; frame < 1.5 * RATE; frame++) {
      const expected = sourceSamples[stream].readInt16LE(((2 * RATE - 1 - frame) * 2 + sourceChannel) * 2) / 32768 * gain;
      maxDifference = Math.max(maxDifference, Math.abs(pcm.readFloatLE((1.75 * RATE + frame) * 8) - expected));
    }
    expect(maxDifference).toBeLessThan(0.000005);
  });

  it.each(['routed', 'legacy-channel', 'legacy-raw'])('%s 延遲開聲的 stream PTS 保留來源缺口，反轉後片头靜音移至片尾', mode => {
    const pcm = render(mode, {}, {}, gapSources['delayed-start']);
    expect(pcm.length / 8).toBe(3.25 * RATE);
    expect(rms(pcm, 0, 0.3, 0.5)).toBeGreaterThan(0.05);
    expect(rms(pcm, 0, 2.8, 3.2)).toBeLessThan(0.000001);
    const stream = mode === 'legacy-raw' ? 0 : 1;
    const sourceChannel = mode === 'legacy-raw' ? 0 : 1;
    const gain = mode === 'legacy-channel' ? Math.SQRT1_2 : 1;
    let maxDifference = 0;
    for (let frame = 0; frame < 2.5 * RATE; frame++) {
      const expected = sourceSamples[stream].readInt16LE(((2.5 * RATE - 1 - frame) * 2 + sourceChannel) * 2) / 32768 * gain;
      maxDifference = Math.max(maxDifference, Math.abs(pcm.readFloatLE((0.25 * RATE + frame) * 8) - expected));
    }
    expect(maxDifference).toBeLessThan(0.000005);
  });

  it.each(['routed', 'legacy-channel', 'legacy-raw'])('%s 延遲開聲後才 seek 的反轉裁切不再次加上原本 start offset', mode => {
    const pcm = render(mode, {}, { exportIn: 0.25, exportOut: 1.75 }, gapSources['delayed-start']);
    expect(pcm.length / 8).toBe(1.5 * RATE);
    const stream = mode === 'legacy-raw' ? 0 : 1;
    const sourceChannel = mode === 'legacy-raw' ? 0 : 1;
    const gain = mode === 'legacy-channel' ? Math.SQRT1_2 : 1;
    let maxDifference = 0;
    for (let frame = 0; frame < 1.5 * RATE; frame++) {
      const expected = sourceSamples[stream].readInt16LE(((2.5 * RATE - 1 - frame) * 2 + sourceChannel) * 2) / 32768 * gain;
      maxDifference = Math.max(maxDifference, Math.abs(pcm.readFloatLE(frame * 8) - expected));
    }
    expect(maxDifference).toBeLessThan(0.000005);
  });

  it.each(['routed', 'legacy-channel', 'legacy-raw'])('%s 整個反轉來源區間已在音訊 EOF 後，仍匯出完整靜音', mode => {
    const pcm = render(mode, { in: 2.5, out: 3.5 }, { exportOut: 1.25 }, gapSources['early-eof']);
    expect(pcm.length / 8).toBe(1.25 * RATE);
    expect(rms(pcm, 0, 0.05, 1.2)).toBeLessThan(0.000001);
    expect(rms(pcm, 1, 0.05, 1.2)).toBeLessThan(0.000001);
  });
});
