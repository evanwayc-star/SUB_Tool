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
import { nativeTestTools } from './fixtures/native-tools.cjs';

const { ffmpeg: FFMPEG, ffprobe: FFPROBE } = nativeTestTools();
const nativeIt = existsSync(FFMPEG) ? it : it.skip;
const require = createRequire(import.meta.url);
const { createDeliveryRunner } = require('../electron/delivery-runner.js');
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
      encoder: { proresArgs: () => ['-c:v', 'prores_ks', '-c:a', 'pcm_s24le'] },
      runFfmpeg: async args => { runFfmpeg(args); return { maps: [] }; } });
    try {
      await runner.run({ id: 'delayed-forward', payload: { format: mode === 'wav' ? 'wav' : 'prores',
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
