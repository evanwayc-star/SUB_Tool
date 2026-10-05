// @subtool-ci windows
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDeliveryArgv } from '../electron/export-plan.js';
import { ExternalAudioLibrary } from '../src/external-audio.js';
import { buildProjectAudioPlan } from '../src/project-audio.js';

const FFMPEG = process.env.FFMPEG_PATH || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../electron/ffmpeg/ffmpeg.exe');
const nativeIt = existsSync(FFMPEG) ? it : it.skip;
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
