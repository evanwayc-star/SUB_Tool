// @subtool-ci windows
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildDeliveryArgv } from '../electron/export-plan.js';
import { ExternalAudioLibrary } from '../src/external-audio.js';
import { buildProjectAudioPlan } from '../src/project-audio.js';
import { buildExportSnapshot } from '../src/delivery-job.js';
import { applyDeliveryAudioSpec, composeDeliveryAudioPlan, createDeliveryAudioSpec } from '../src/export-job-engine.js';
import { nativeTestTools } from './fixtures/native-tools.cjs';

const { ffmpeg: FFMPEG, ffprobe: FFPROBE } = nativeTestTools();
const nativeIt = existsSync(FFMPEG) ? it : it.skip;
const require = createRequire(import.meta.url);
const { createDeliveryRunner } = require('../electron/delivery-runner.js');
const { captureOutputDirectory, captureOutputAuthority, captureDestinationEvidence } = require('../electron/export-lease.js');
const { createMediaProbe } = require('../electron/media-probe.js');
const SAMPLE_RATE = 48000;
const roots = [];

function runFfmpeg(args) {
  const result = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], {
    windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024,
  });
  expect(result.error || result.status, result.stderr?.toString()).toBe(0);
  return result.stdout;
}

function toneFile(directory, name, duration, frequency) {
  const frames = SAMPLE_RATE * duration;
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(SAMPLE_RATE, 24); bytes.writeUInt32LE(SAMPLE_RATE * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let frame = 0; frame < frames; frame++) {
    bytes.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * frequency * frame / SAMPLE_RATE)), 44 + frame * 2);
  }
  const file = path.join(directory, name);
  writeFileSync(file, bytes);
  return file;
}

function channelRms(bytes, channel, start, end) {
  let energy = 0;
  const first = Math.round(start * SAMPLE_RATE), last = Math.round(end * SAMPLE_RATE);
  for (let frame = first; frame < last; frame++) energy += bytes.readFloatLE((frame * 2 + channel) * 4) ** 2;
  return Math.sqrt(energy / (last - first));
}

afterEach(() => {
  const temp = realpathSync(tmpdir());
  for (const directory of roots.splice(0)) {
    const resolved = realpathSync(directory);
    if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith('subtool-export-audio-duration-')) {
      throw new Error('拒絕清除未驗證的測試路徑');
    }
    rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('交付音訊完整時間範圍', () => {
  nativeIt.each(['wav', 'prores'])('%s 交付獨立選 A7 左／A8 右，八聲道母素材經 snapshot／runner 的每個 PCM sample 都不混入 A1–A6', async format => {
    const directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'subtool-export-audio-duration-')); roots.push(directory);
    const frames = 2 * SAMPLE_RATE;
    const motherPcm = Buffer.alloc(frames * 8 * 3);
    const selectedPcm = Buffer.alloc(frames * 2 * 3);
    const frequencies = [211, 307, 401, 503, 601, 701, 809, 907];
    for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < 8; channel++) {
      // A1–A6 remain audible throughout. A7/A8 have different tones and
      // distinct silence windows, so channel swaps and downmix leaks are visible.
      const silent = channel === 6 ? frame < SAMPLE_RATE / 4 || frame >= SAMPLE_RATE * 1.75
        : channel === 7 && frame >= SAMPLE_RATE * 0.75 && frame < SAMPLE_RATE * 1.25;
      const sample = silent ? 0 : Math.round((450000 + channel * 150000)
        * Math.sin(2 * Math.PI * frequencies[channel] * frame / SAMPLE_RATE));
      motherPcm.writeIntLE(sample, (frame * 8 + channel) * 3, 3);
      if (channel >= 6) selectedPcm.writeIntLE(sample, (frame * 2 + channel - 6) * 3, 3);
    }
    const raw = path.join(directory, 'eight-channels.s24le');
    const referenceRaw = path.join(directory, 'selected-reference.s24le');
    const reference = path.join(directory, 'selected-reference.wav');
    const source = path.join(directory, 'eight-channels.mov');
    writeFileSync(raw, motherPcm); writeFileSync(referenceRaw, selectedPcm);
    runFfmpeg(['-f', 'lavfi', '-i', 'color=black:s=64x48:r=25:d=2',
      '-f', 's24le', '-ar', String(SAMPLE_RATE), '-ac', '8', '-channel_layout', '7.1', '-i', raw,
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'prores_ks', '-c:a', 'pcm_s24le', source]);
    // The independent oracle uses the generated A7/A8 samples, never the
    // production plan/filter graph, and uses the same 24-bit delivery format.
    runFfmpeg(['-f', 's24le', '-ar', String(SAMPLE_RATE), '-ac', '2', '-i', referenceRaw,
      '-c:a', 'pcm_s24le', reference]);
    expect(runFfmpeg(['-i', source, '-map', '0:a:0', '-f', 's24le', '-c:a', 'pcm_s24le', 'pipe:1']).equals(motherPcm)).toBe(true);

    const buses = Array.from({ length: 8 }, (_, index) => ({ id: `a${index + 1}`, name: `A${index + 1}`, volume: 1 }));
    const audioProject = { buses, sourceMaps: { mother: { channels: buses.map((bus, sourceChannel) => ({
      sourceStream: 0, sourceChannel, enabled: true, gain: 1, busIds: [bus.id],
    })) } }, exportLayout: { streams: buses.map(bus => ({ id: `project-${bus.id}`, layout: 'mono', busIds: [bus.id] })) } };
    const originalProject = structuredClone(audioProject);
    const snapshot = buildExportSnapshot({ state: { audioProject, videoTracks: [{ visible: true }], clips: [{
      id: 'mother-clip', audioSourceId: 'mother', path: source, type: 'video', in: 0, out: 2, offset: 0,
      vtrack: 0, fps: 25, natW: 64, natH: 48,
    }] }, sequenceEnd: 2 });
    const draft = createDeliveryAudioSpec(audioProject);
    draft.buses = draft.buses.filter(bus => ['a7', 'a8'].includes(bus.id));
    draft.streams = [{ id: 'delivery-stereo', layout: 'stereo', busIds: ['a7', 'a8'] }];
    draft.wavBusIds = ['a7', 'a8'];
    const record = applyDeliveryAudioSpec({ format }, draft);
    const audioPlan = composeDeliveryAudioPlan(snapshot.audioPlan, record);
    expect(audioPlan.buses.map(bus => bus.id)).toEqual(['a7', 'a8']);
    expect(audioPlan.buses.map(bus => bus.inputs[0].sourceChannel)).toEqual([6, 7]);
    expect(audioPlan.streams).toEqual(draft.streams);
    expect(audioProject).toEqual(originalProject);
    const outPath = path.join(directory, format === 'wav' ? 'delivery.wav' : 'delivery.mov');
    const probe = createMediaProbe({ executable: FFPROBE });
    const progress = [], active = new Map();
    const queue = { assertJobCapabilities() {}, reportProgress: (_id, data) => { progress.push(data); return true; },
      registerActiveJob: (id, session) => active.set(id, session), clearActiveJob: id => active.delete(id) };
    const runner = createDeliveryRunner({ queue, queueDir: () => directory, tempDir: directory, mediaProbe: () => probe,
      nativeCapabilities: { assertReady: async () => {} },
      encoder: { proresArgs: () => ['-c:v', 'prores_ks', '-c:a', 'pcm_s24le'] },
      runFfmpeg: async args => { runFfmpeg(args); return { maps: [] }; } });
    try {
      await runner.run({ id: `selected-${format}`, outputAuthority: captureDestinationEvidence(captureOutputAuthority(outPath, captureOutputDirectory(directory))),
        payload: { ...snapshot, format, audioPlan, outPath, width: 64, height: 48, fps: 25 } });
      expect(progress.find(item => item.error), JSON.stringify(progress)).toBeUndefined();
      expect(progress.at(-1)).toMatchObject({ done: true, pct: 100 });
      expect(active.size).toBe(0);
      const metadata = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'a', '-show_streams', '-of', 'json', outPath],
        { windowsHide: true, timeout: 15000 });
      expect(metadata.error || metadata.status, metadata.stderr?.toString()).toBe(0);
      const streams = JSON.parse(metadata.stdout.toString()).streams;
      expect(streams).toHaveLength(1);
      expect(streams[0]).toMatchObject({ codec_name: 'pcm_s24le', channels: 2, channel_layout: 'stereo', sample_rate: '48000', bits_per_sample: 24 });
      expect(Number(streams[0].duration)).toBeCloseTo(2, 6);
      const decode = file => runFfmpeg(['-i', file, '-map', '0:a:0', '-f', 's24le', '-c:a', 'pcm_s24le', 'pipe:1']);
      const actual = decode(outPath), expected = decode(reference);
      expect(expected.equals(selectedPcm)).toBe(true);
      expect(actual.length).toBe(frames * 2 * 3);
      let mismatchedSamples = 0, maximumDifference = 0;
      for (let byte = 0; byte < actual.length; byte += 3) {
        const difference = Math.abs(actual.readIntLE(byte, 3) - expected.readIntLE(byte, 3));
        if (difference) mismatchedSamples++;
        maximumDifference = Math.max(maximumDifference, difference);
      }
      expect({ mismatchedSamples, maximumDifference }).toEqual({ mismatchedSamples: 0, maximumDifference: 0 });
      // In these windows all six excluded channels carry signal; the selected
      // channel must remain digital zero, not merely below an audible threshold.
      for (let frame = 0; frame < SAMPLE_RATE / 4; frame++) expect(actual.readIntLE(frame * 6, 3)).toBe(0);
      for (let frame = SAMPLE_RATE * 0.75; frame < SAMPLE_RATE * 1.25; frame++) expect(actual.readIntLE(frame * 6 + 3, 3)).toBe(0);
      expect(audioProject).toEqual(originalProject);
    } finally { await probe.cancelAllAndWait(); }
  }, 30000);

  nativeIt.each(['wav', 'routed', 'routed-case', 'legacy-channel', 'legacy-raw'].flatMap(mode => [0, 0.5, 1.75].map(inPoint => ({ mode, inPoint }))))
  ('$mode 正向來源延後開聲，trim=$inPoint 的實際 runner/probe/FFmpeg 保留缺口且 seek 後不重加延遲', async ({ mode, inPoint }) => {
    const directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'subtool-export-audio-duration-')); roots.push(directory);
    const source = path.join(directory, 'delayed.mov'), outPath = path.join(directory, mode === 'wav' ? 'delivery.wav' : 'delivery.mov');
    runFfmpeg(['-f', 'lavfi', '-i', 'color=black:s=64x48:r=25:d=3', '-itsoffset', '1',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2', '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'pcm_s16le', source]);
    const audioPlan = { buses: [{ id: 'mono', inputs: [{ file: mode === 'routed-case' ? source.toUpperCase() : source, sourceStream: 0, sourceChannel: 0,
      trimStart: inPoint, trimEnd: 3, offset: 0.2 }] }], streams: [{ layout: 'mono', busIds: ['mono'] }] };
    const clip = { path: source, type: 'video', in: inPoint, out: 3, offset: 0.2, vtrack: 0,
      ...(mode === 'legacy-channel' ? { audio: [{ file: source, sourceStream: 0, sourceChannel: 0, volume: 1 }] } : {}) };
    const probe = createMediaProbe({ executable: FFPROBE });
    const progress = [], active = new Map();
    const queue = { assertJobCapabilities() {}, reportProgress: (_id, data) => { progress.push(data); return true; },
      registerActiveJob: (id, session) => active.set(id, session), clearActiveJob: id => active.delete(id) };
    const runner = createDeliveryRunner({ queue, queueDir: () => directory, tempDir: directory, mediaProbe: () => probe,
      nativeCapabilities: { assertReady: async () => {} },
      encoder: { proresArgs: () => ['-c:v', 'prores_ks', '-c:a', 'pcm_s24le'] },
      runFfmpeg: async args => { runFfmpeg(args); return { maps: [] }; } });
    try {
      await runner.run({ id: 'delayed-forward', outputAuthority: captureDestinationEvidence(captureOutputAuthority(outPath, captureOutputDirectory(directory))), payload: { format: mode === 'wav' ? 'wav' : 'prores',
        duration: 3.2 - inPoint, outPath, clips: mode === 'wav' ? [] : [clip], videoTracks: [{ vt: 0 }], width: 64, height: 48, fps: 25,
        audioPlan: mode === 'wav' || mode.startsWith('routed') ? audioPlan : null } });
      expect(progress.find(record => record.error), JSON.stringify(progress)).toBeUndefined();
      expect(progress.at(-1)).toMatchObject({ done: true, pct: 100 });
      expect(active.size).toBe(0);
      const pcm = runFfmpeg(['-i', outPath, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1']);
      expect(pcm.length / 4).toBe(Math.round((3.2 - inPoint) * SAMPLE_RATE));
      const onset = 0.2 + Math.max(0, 1 - inPoint);
      const rms = (start, end) => {
        let sum = 0, count = 0;
        for (let frame = Math.round(start * SAMPLE_RATE); frame < Math.round(end * SAMPLE_RATE); frame++) { sum += pcm.readFloatLE(frame * 4) ** 2; count++; }
        return Math.sqrt(sum / count);
      };
      expect(rms(0.02, onset - 0.02)).toBeLessThan(0.000001);
      expect(rms(onset + 0.08, onset + 0.25)).toBeGreaterThan(0.05);
      expect(rms(3.2 - inPoint - 0.25, 3.2 - inPoint - 0.05)).toBeGreaterThan(0.05);
    } finally { await probe.cancelAllAndWait(); }
  }, 30000);

  nativeIt('未提供 probe adapter 的公開 WAV plan 仍保留 FFmpeg 來源 PTS 缺口', () => {
    const directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'subtool-export-audio-duration-')); roots.push(directory);
    const source = path.join(directory, 'delayed.mov'), outPath = path.join(directory, 'delivery.wav');
    runFfmpeg(['-f', 'lavfi', '-i', 'color=black:s=64x48:r=25:d=3', '-itsoffset', '1',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2', '-c:v', 'libx264', '-c:a', 'pcm_s16le', source]);
    runFfmpeg(buildDeliveryArgv({ format: 'wav', duration: 3, outPath, audioPlan: {
      buses: [{ id: 'mono', inputs: [{ file: source, trimStart: 0, trimEnd: 3, sourceStream: 0, sourceChannel: 0 }] }], streams: [],
    } }).args);
    const pcm = runFfmpeg(['-i', outPath, '-ac', '1', '-f', 'f32le', '-c:a', 'pcm_f32le', 'pipe:1']);
    expect(pcm.subarray(0, SAMPLE_RATE * 4)).toEqual(Buffer.alloc(SAMPLE_RATE * 4));
    expect(Math.abs(pcm.readFloatLE(Math.round(2.40025 * SAMPLE_RATE) * 4))).toBeGreaterThan(0.05);
  });

  nativeIt.each([
    {label:'跨淡入淡出',fadeIn:2,fadeOut:1.5},
    {label:'沒有淡化',fadeIn:0,fadeOut:0},
  ])('外部音訊 $label 重複切割，經 production audioPlan 匯出的 PCM 每個 sample 保持原曲線',({fadeIn,fadeOut})=>{
    const directory=mkdtempSync(path.join(realpathSync(tmpdir()),'subtool-export-audio-duration-'));roots.push(directory);
    const source=toneFile(directory,'source.wav',3,440);
    const library=new ExternalAudioLibrary();
    const asset=library.add({path:source,duration:3,in:0,out:3,offset:0,fadeIn,fadeOut,descriptors:[{sourceStream:0,sourceChannel:0}]});
    const original=library.serialize();
    const split=(clip,time)=>{
      const plan=library.planSplit(clip.id,time);Object.assign(clip,plan.left);library.normalize(clip);
      // Media.splitExternalAudio 會把 mother path 傳给 addAudioFileDesktop，純切點計畫不開檔。
      return library.add({...plan.right,path:clip.path});
    };
    const right=split(asset,1.25);split(right,2);
    const rebuilt=new ExternalAudioLibrary();for(const saved of library.serialize())rebuilt.add(saved);
    const render=(sources,name)=>{
      const audioProject={buses:[{id:'mono',volume:1}],sourceMaps:Object.fromEntries(sources.map(clip=>[
        clip.audioSourceId,{channels:[{sourceStream:0,sourceChannel:0,enabled:true,gain:1,busIds:['mono']}]}
      ])),exportLayout:{streams:[{id:'mono',layout:'mono',busIds:['mono']}]}};
      const audioPlan=buildProjectAudioPlan({audioProject,externalSources:sources});
      expect(audioPlan.unresolvedSources).toEqual([]);
      expect(audioPlan.buses[0].inputs).toHaveLength(sources.length);
      const outPath=path.join(directory,name+'.wav');
      runFfmpeg(buildDeliveryArgv({format:'wav',duration:3,outPath,audioPlan}).args);
      return runFfmpeg(['-i',outPath,'-map','0:a:0','-f','f32le','-c:a','pcm_f32le','pipe:1']);
    };
    const before=render(original,'original'),after=render(rebuilt.serialize(),'split');
    expect(before.length).toBe(3*SAMPLE_RATE*4);expect(after.length).toBe(before.length);
    let maximumDifference=0;
    for(let byte=0;byte<before.length;byte+=4) maximumDifference=Math.max(maximumDifference,Math.abs(before.readFloatLE(byte)-after.readFloatLE(byte)));
    expect(maximumDifference).toBeLessThan(0.000005);
  });
  nativeIt.each(['wav', 'prores'])('%s 各專案音軌長度不同時保留較長聲道尾音，並補滿交付範圍', format => {
    const directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'subtool-export-audio-duration-'));
    roots.push(directory);
    const left = toneFile(directory, 'left.wav', 1, 440);
    const right = toneFile(directory, 'right.wav', 2, 880);
    const outPath = path.join(directory, format === 'wav' ? 'delivery.wav' : 'delivery.mov');
    const video = path.join(directory, 'video.mov');
    if (format === 'prores') {
      runFfmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=25:d=3', '-c:v', 'prores_ks', '-an', video]);
    }
    const plan = buildDeliveryArgv({ format, duration: 3, outPath, width: 160, height: 90, fps: 25,
      clips: format === 'wav' ? [] : [{ path: video, in: 0, out: 3, offset: 0, natW: 160, natH: 90 }], audioPlan: {
      buses: [
        { id: 'left', inputs: [{ file: left, trimStart: 0, trimEnd: 1, sourceStream: 0, sourceChannel: 0 }] },
        { id: 'right', inputs: [{ file: right, trimStart: 0, trimEnd: 2, sourceStream: 0, sourceChannel: 0 }] },
      ],
      streams: [{ id: 'stereo', layout: 'stereo', busIds: ['left', 'right'] }],
    } }, { proresArgs: () => ['-c:v', 'prores_ks', '-c:a', 'pcm_s24le'] });
    runFfmpeg(plan.args);
    const samples = runFfmpeg(['-i', outPath, '-map', '0:a:0', '-f', 'f32le', '-c:a', 'pcm_f32le', 'pipe:1']);

    expect(samples.length / (4 * 2)).toBe(144000);
    expect(channelRms(samples, 0, 0.25, 0.75)).toBeGreaterThan(0.1);
    expect(channelRms(samples, 0, 1.25, 1.75)).toBeLessThan(0.00001);
    expect(channelRms(samples, 1, 1.25, 1.75)).toBeGreaterThan(0.1);
    expect(channelRms(samples, 0, 2.25, 2.75)).toBeLessThan(0.00001);
    expect(channelRms(samples, 1, 2.25, 2.75)).toBeLessThan(0.00001);
  });
});
