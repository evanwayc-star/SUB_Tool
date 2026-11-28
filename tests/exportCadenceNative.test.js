// @subtool-ci windows
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { buildExportSnapshot } from '../src/delivery-job.js';
import { createDeliveryList } from '../src/delivery-list.js';
import { createDeliverySubmission, freezeExportSubmission } from '../src/delivery-submission.js';

const require = createRequire(import.meta.url);
const { buildDeliveryArgv } = require('../electron/export-plan.js');
const { createMediaProbe } = require('../electron/media-probe.js');
const { createDeliveryRunner } = require('../electron/delivery-runner.js');
const { captureOutputAuthority, captureOutputDirectory, captureDestinationEvidence } = require('../electron/export-lease.js');
const ffmpeg = process.env.FFMPEG_PATH || path.resolve('electron/ffmpeg/ffmpeg.exe');
const ffprobe = process.env.FFPROBE_PATH || path.resolve('electron/ffmpeg/ffprobe.exe');
const rate = 24000 / 1001;
const width = 64, height = 48, lumaSize = width * height, frameSize = lumaSize * 1.5;

it.skipIf(!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe))('一格字幕 00:06:35:15 依各交付列的實際畫格和場燒錄，In/Out 不移動起訖', async () => {
  const base = fs.realpathSync(tmpdir()), dir = fs.mkdtempSync(path.join(base, 'subtool-burn-cue-'));
  const w = 160, h = 90, mother = path.join(dir, 'black.mp4');
  const run = args => {
    const r = spawnSync(ffmpeg, ['-hide_banner','-nostdin','-loglevel','error', ...args], {
      cwd: dir, windowsHide:true, timeout:30000, maxBuffer:8*1024*1024,
    });
    expect(r.error || r.status, r.stderr?.toString()).toBe(0);
    return r.stdout;
  };
  try {
    run(['-f','lavfi','-i','color=black:s=160x90:r=25:d=1','-an','-c:v','libx264',mother]);
    let progress;
    const runner = createDeliveryRunner({
      queueDir:()=>dir, tempDir:dir, mediaProbe:()=>createMediaProbe({executable:ffprobe}),
      nativeCapabilities:{assertReady:async()=>{}},
      queue:{assertJobCapabilities(){},registerActiveJob(){},clearActiveJob(){},reportProgress(_id, update){progress=update;}},
      encoder:{bitrateArgs:()=>['-c:v','libx264','-preset','ultrafast','-crf','0','-threads','1']},
      runFfmpeg:async args=>{run(args);return {};},
    });
    for (const cropped of [false, true]) {
      const fps = cropped ? 24 : 29.97, actualFps = cropped ? 24 : 30000/1001;
      const first = 395*Math.round(fps)+15, timelineStart = cropped ? (first-4)/actualFps : 0;
      const start = first/actualFps, end = (first+1)/actualFps;
      // A reopened project can retain numeric edges within one microsecond of its grid.
      const savedOffset = cropped ? 0 : 0.0000002;
      const project = freezeExportSubmission({
        clips:[{id:'black',path:mother,type:'video',in:0,out:.1,offset:0,vtrack:0,natW:w,natH:h}],
        videoTracks:[{visible:true}], timelineStart, duration:(first+5)/actualFps-timelineStart,
      }, {fps, canvasW:w, canvasH:h, tracks:[{visible:true}], cues:[
        {id:'one-frame',start:start+savedOffset,end:end+savedOffset,track:0,text:'MMMM',style:{fontSize:185,posX:50,posY:60}},
      ]});
      const list = createDeliveryList({projectTag:'burn',fps,canvasW:w,canvasH:h,
        defaultAudioLayout:{streams:[{layout:'stereo',busIds:['left','right']}]}});
      const rows = cropped ? [60,'mod-fhd'] : [29.97,25,50];
      rows.forEach((row, i) => {
        if (i) list.add();
        if (typeof row === 'number') list.setTargetFps(i, row);
        else list.setFormat(i, row);
        list.setOutDir(i, dir);
        list.setName(i, `burn-${fps}-${i}`+(typeof row === 'number' ? '.mp4' : '.ts'));
      });
      const jobs = [];
      const submission = createDeliverySubmission({list,initialProject:project,readProject:()=>project,isCurrent:()=>true,
        desktop:{listDir:async()=>[],exportVideo:async job=>{jobs.push(job);return 'job-'+jobs.length;}},confirmOverwrite:async()=>true});
      const receipt = await submission.submit();
      expect(receipt, receipt.reason || receipt.error?.message).toMatchObject({status:'submitted',accepted:rows.length});
      for (const job of jobs) {
        fs.writeFileSync(path.join(dir,'burn.ass'),job.assText);
        const interlaced = job.format === 'mod-fhd';
        const authority = captureOutputAuthority(job.outPath,captureOutputDirectory(dir));
        progress=null;
        await runner.run({id:'burn',assRef:'burn.ass',payload:{...job,assText:null},outputAuthority:captureDestinationEvidence(authority)});
        expect(progress,progress?.errorMsg).toMatchObject({done:true});
        const sampleRate = (job.fps === 29.97 ? 30000/1001 : job.fps) * (interlaced ? 2 : 1);
        const on = Math.ceil((start-timelineStart)*sampleRate-1e-7), off = Math.ceil((end-timelineStart)*sampleRate-1e-7);
        const fieldFilter = interlaced ? 'separatefields,' : '';
        const pixels = run(['-i',job.outPath,'-map','0:v:0','-vf',
          fieldFilter+`select='between(n,${on-1},${off})',scale=${w}:${h}`,'-fps_mode','passthrough','-pix_fmt','gray','-f','rawvideo','pipe:1']);
        expect(pixels.length).toBe((off-on+2)*w*h);
        for (let sample=on-1; sample<=off; sample++) {
          const offset=(sample-on+1)*w*h;
          expect(pixels.subarray(offset,offset+w*h).some(value=>value>100),
            `${fps}→${job.fps} / ${job.format} sample ${sample}`).toBe(sample>=on && sample<off);
        }
      }
    }
  } finally {
    const resolved=fs.realpathSync(dir);
    if (path.dirname(resolved)!==base || !path.basename(resolved).startsWith('subtool-burn-cue-')) throw new Error('暫存目錄已變更');
    fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
}, 30000);

describe.skipIf(!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe))('粗時間刻度母素材的逐格交付', () => {
  it('相同原始影格裝入 MOV 或毫秒 MKV 後，同 FPS 交付都沒有新增重複或遺失影格', async () => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-export-cadence-'));
    const probe = createMediaProbe({ executable: ffprobe });
    const run = args => {
      const result = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error',
        '-threads', '2', '-filter_threads', '2', '-filter_complex_threads', '2', ...args],
      { cwd: directory, windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
      expect(result.error || result.status, result.stderr?.toString()).toBe(0);
      return result.stdout;
    };
    const decode = file => {
      const bytes = run(['-i', file, '-map', '0:v:0', '-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1']);
      expect(bytes.length % frameSize).toBe(0);
      return Array.from({ length: bytes.length / frameSize }, (_, index) => bytes.subarray(index * frameSize, index * frameSize + lumaSize));
    };
    try {
      const mov = path.join(directory, 'mother.mov'), mkv = path.join(directory, 'mother.mkv');
      run(['-f', 'lavfi', '-i', "nullsrc=s=64x48:r=24000/1001:d=2,geq=lum='16+4*N':cb=128:cr=128",
        '-frames:v', '48', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '0', '-threads', '2', '-pix_fmt', 'yuv420p', mov]);
      run(['-i', mov, '-map', '0:v:0', '-c', 'copy', mkv]);
      const reference = decode(mov);
      expect(reference).toHaveLength(48);
      expect(new Set(reference.map(frame => frame[0])).size).toBe(48);
      expect(decode(mkv)).toEqual(reference);
      const deliver = async (source, changes = {}, deliveryFps = rate) => {
        const descriptor = await probe.describe(source);
        const output = path.join(directory, path.extname(source).slice(1) + '.mp4');
        const clip = { id: 'mother', path: source, type: 'video', in: 0, out: 2, offset: 0,
          fps: rate, speed: 1, vtrack: 0, natW: width, natH: height, ...changes };
        const duration = clip.offset + (clip.out - clip.in) / clip.speed;
        const snapshot = buildExportSnapshot({ state: { clips: [clip], fps: 23.976, videoTracks: [{ visible: true }] }, sequenceEnd: duration });
        const plan = buildDeliveryArgv({ ...snapshot, format: 'h264', fps: deliveryFps, width, height, outPath: output }, {
          sourceClock: () => descriptor.video, hasAudioStream: () => false,
          vencArgsBitrate: () => ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '0', '-threads', '2'],
        });
        run(plan.args);
        const actual = decode(output);
        expect(actual).toHaveLength(Math.ceil(duration * deliveryFps - 1e-6));
        return actual;
      };
      for (const source of [mov, mkv]) {
        const actual = await deliver(source);
        expect(actual).toHaveLength(reference.length);
        // Independent oracle: the exact same encoded mother frames were remuxed.
        // Compare every luma pixel, not frame count, FPS metadata or exit code.
        actual.forEach((frame, index) => expect(frame.equals(reference[index]), `${path.extname(source)} output frame ${index}: Y=${frame[0]}, expected ${reference[index][0]}`).toBe(true));
      }
      // The high precision MOV is an independent timestamp control for the same
      // mother content through trimmed, reversed, retimed and cross-FPS plans.
      for (const reverse of [false, true]) for (const speed of [.5, 1, 2]) for (const fps of [rate, 25, 50]) {
        const clip = { in: 25 / rate, out: 41 / rate, offset: 1 / 25, reverse, speed };
        const expected = await deliver(mov, clip, fps), actual = await deliver(mkv, clip, fps);
        expect(actual).toHaveLength(expected.length);
        actual.forEach((frame, index) => expect(frame.equals(expected[index]),
          `reverse=${reverse} speed=${speed} fps=${fps} frame=${index} Y=${frame[0]} expected=${expected[index][0]}`).toBe(true));
      }
    } finally {
      await probe.cancelAllAndWait();
      const resolved = fs.realpathSync(directory);
      if (path.dirname(resolved) !== fs.realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-export-cadence-')) throw new Error('拒絕清除未核對的測試目錄');
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 30000);

  it('毫秒 VFR 保留真正長格；seek 落在前置空白時也不可提早借首格', async () => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-export-cadence-'));
    const probe = createMediaProbe({ executable: ffprobe });
    const run = args => {
      const result = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error',
        '-threads', '2', '-filter_threads', '2', '-filter_complex_threads', '2', ...args],
      { cwd: directory, windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
      expect(result.error || result.status, result.stderr?.toString()).toBe(0);
      return result.stdout;
    };
    try {
      for (const leading of [false, true]) {
        const timestamps = leading ? [.584, .75, .9] : [0, .05, .20, .24, .4, .7];
        const source = path.join(directory, `${leading}.mkv`);
        const pts = timestamps.slice(0, -1).reduceRight((rest, time, index) => `if(eq(N,${index}),${time},${rest})`, String(timestamps.at(-1)));
        run(['-f', 'lavfi', '-i', "nullsrc=s=64x48:r=24000/1001:d=2,geq=lum='40+20*N':cb=128:cr=128",
          '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=1.1', '-vf', `settb=1/1000,setpts='(${pts})/TB'`,
          '-frames:v', String(timestamps.length), '-fps_mode:v', 'passthrough', '-enc_time_base:v', '1/1000',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '0', '-threads', '2', '-c:a', 'pcm_s16le', source]);
        const descriptor = await probe.describe(source);
        expect(descriptor.video).toMatchObject({ timeBase: '1/1000', nominalFrameRate: '24000/1001' });
        for (const reverse of [false, true]) {
          const first = leading ? 13 / rate : 0, last = leading ? 18 / rate : .75;
          const fps = leading ? rate : 25, duration = last - first;
          const clip = { id: 'sparse', path: source, type: 'video', in: first, out: last, offset: 0,
            fps: rate, speed: 1, reverse, vtrack: 0, natW: width, natH: height };
          const snapshot = buildExportSnapshot({ state: { clips: [clip], fps: 23.976, videoTracks: [{ visible: true }] }, sequenceEnd: duration });
          const output = path.join(directory, `${leading}-${reverse}.mp4`);
          const plan = buildDeliveryArgv({ ...snapshot, format: 'h264', fps, width, height, outPath: output }, {
            // A source-clock fixture with a real sparse track: source zero is
            // the container's zero, not the first available video frame.
            sourceClock: () => ({ ...descriptor.video, timestampOffset: 0 }), hasAudioStream: () => false,
            vencArgsBitrate: () => ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '0', '-threads', '2'],
          });
          if (leading) expect(Number(plan.args[plan.args.indexOf('-ss') + 1])).toBeGreaterThan(0);
          run(plan.args);
          const bytes = run(['-i', output, '-map', '0:v:0', '-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1']);
          const count = Math.ceil(duration * fps - 1e-6);
          expect(bytes.length).toBe(count * frameSize);
          for (let n = 0; n < count; n++) {
            const target = reverse ? Math.min(last - 1e-6, last - n / fps) : first + n / fps;
            const selected = timestamps.findLastIndex(time => Math.round(time * 1e6) <= Math.round(target * 1e6));
            const expected = selected < 0 ? 16 : 40 + selected * 20;
            const frame = bytes.subarray(n * frameSize, n * frameSize + lumaSize);
            expect(frame.every(value => value === expected), `leading=${leading} reverse=${reverse} output=${n} target=${target} Y=${frame[0]} expected=${expected}`).toBe(true);
          }
        }
      }
    } finally {
      await probe.cancelAllAndWait();
      const resolved = fs.realpathSync(directory);
      if (path.dirname(resolved) !== fs.realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-export-cadence-')) throw new Error('拒絕清除未核對的測試目錄');
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 30000);
});
