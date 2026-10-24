// @subtool-ci windows
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildExportSnapshot } from '../src/delivery-job.js';
import { fadeAlphaAtTimeline } from '../src/image-compositor-engine.js';
import {Seq} from '../src/sequence.js';
import {sourceFrameWindow,sourcePresentationMetadata,clearSourceFrameIndexes} from '../src/decode/source-frame-index.js';
import {createNativePreviewRuntime} from '../src/media-player-adapter.js';
import {sourceFrameTargetUs} from '../shared/media-source-clock.cjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = require(path.join(ROOT, 'electron/export-plan.js'));
const { buildClipFrameArgs } = require('../electron/clip-frame-cache.js');
const { privateSarasaFont } = require('./fixtures/private-font.cjs');
const { createDeliveryRunner } = require('../electron/delivery-runner.js');
const FFMPEG = process.env.FFMPEG_PATH || path.join(ROOT, 'electron/ffmpeg/ffmpeg.exe');

describe.skipIf(!fs.existsSync(FFMPEG))('一般片段的來源影格交付', () => {
  it.each([
    { name: 'normal', fps: 30, start: 29, end: 37 },
    { name: 'boundary', fps: 30, start: 30, end: 38 },
    { name: 'reverse', fps: 30, start: 22, end: 30, reverse: true },
    { name: 'fast', fps: 30, start: 29, end: 45, speed: 2 },
    { name: 'slow', fps: 30, start: 29, end: 33, speed: 0.5 },
    { name: 'NTSC', fps: 30000 / 1001, start: 29, end: 37 },
    { name: 'NTSC-reverse', fps: 30000 / 1001, start: 22, end: 30, reverse: true },
    { name: 'NTSC-reverse-to-50', fps: 30000 / 1001, deliveryFps: 50, start: 22, end: 30, reverse: true },
    { name: 'source-PTS', fps: 30, start: 29, end: 37, sourceOrigin: 5 },
    { name: 'source-PTS-reverse', fps: 30, start: 22, end: 30, sourceOrigin: 5, reverse: true },
    { name: 'same-mother', fps: 30, start: 29, end: 33, secondStart: 31 },
    { name: 'same-mother-reverse', fps: 30, start: 29, end: 33, secondStart: 31, reverse: true },
    { name: 'timeline-offset', fps: 30, start: 29, end: 37, offsetFrame: 29 },
    { name: 'one-frame-gap-120', fps: 120, start: 29, end: 37, offsetFrame: 1 },
    { name: 'short-segments-30-to-25', fps: 30, deliveryFps: 25, start: 0, end: 1, segments: 10 },
    { name: '30-to-50', fps: 30, deliveryFps: 50, start: 29, end: 37 },
    { name: 'off-grid-gap-30-to-25', fps: 30, deliveryFps: 25, start: 29, end: 37, offsetFrame: 1 },
    { name: 'same-mother-cut-30-to-25', fps: 30, deliveryFps: 25, start: 29, end: 33, secondStart: 31 },
    { name: 'different-mother', fps: 30, start: 29, end: 33, secondStart: 31, secondMother: true },
    { name: 'layered-tail', fps: 30, start: 29, end: 37, secondStart: 31, secondMother: true, layered: true },
    { name: 'slow-fade-30-to-50', fps: 30, deliveryFps: 50, start: 29, end: 41, offsetFrame: 1, speed: 0.5, fade: true },
    { name: 'track-opacity', fps: 30, start: 29, end: 37, opacity: 0.5 },
    { name: 'upper-fade-off-grid', fps: 30, deliveryFps: 50, start: 0, end: 30, secondStart: 0, secondMother: true, layered: true, upperFade: true },
    { name: 'same-track-fade', fps: 30, deliveryFps: 50, start: 0, end: 12, secondStart: 0, secondMother: true, secondFade: true },
    ...[false, true].flatMap(reverse => [1, .5, 2].flatMap(speed => [0, 1].map(offsetFrame => ({
      name: `legal-project-grid-${reverse ? 'reverse' : 'forward'}-${speed}-${offsetFrame}`,
      fps: 30, deliveryFps: 25, projectFps: 25, inSeconds: .04, outSeconds: .24,
      offsetFrame, speed, reverse,
    })))),
    ...[false,true].flatMap(reverse=>[1,.5,2].flatMap(speed=>[0,.04].map(offsetSeconds=>({
      name:`late-legal-project-grid-${reverse?'reverse':'forward'}-${speed}-${offsetSeconds}`,
      fps:30,deliveryFps:25,projectFps:25,inSeconds:1.08,outSeconds:1.28,offsetSeconds,speed,reverse,
    })))),
    ...[false, true].flatMap(reverse => [1, .5, 2].flatMap(speed => [0, 1].map(offsetFrame => ({
      name: `VFR-${reverse ? 'reverse' : 'forward'}-${speed}-${offsetFrame}`,
      fps: 25, deliveryFps: 30, projectFps: 25, inSeconds: 0, outSeconds: .28,
      timestamps: [0, .04, .20, .24], offsetFrame, speed, reverse,
    })))),
    ...[false,true].map(vfr=>({name:`internal-reverse-boundary-${vfr?'VFR':'CFR'}`,fps:25,
      deliveryFps:25,inSeconds:0,outSeconds:.28,reverse:true,...(vfr?{timestamps:[0,.04,.20,.24]}:{})})),
    { name: 'VFR-fixed-containing', fps: 25, deliveryFps: 30, inSeconds: 0, outSeconds: .28,
      timestamps: [0, .04, .20, .24], freezeTime: .12 },
    ...[false, true].map(reverse => ({ name: `long-VFR-${reverse ? 'reverse' : 'forward'}`,
      fps: 25, deliveryFps: 25, inSeconds: 1, outSeconds: 1.2, timestamps: [0, .04, 2, 2.04], reverse })),
    { name: 'long-VFR-fixed-containing', fps: 25, deliveryFps: 25, inSeconds: 1, outSeconds: 1.2,
      timestamps: [0, .04, 2, 2.04], freezeTime: 1 },
  ])('$name：真實 renderer 快照與 FFmpeg 逐格跟母素材預覽一致', async scenario => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-video-trim-clock-'));
    const run = args => {
      const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], {
        cwd: directory, windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024,
      });
      expect(result.error || result.status, result.stderr?.toString()).toBe(0);
      return result.stdout;
    };
    const nativeFetch=globalThis.fetch;
    // Real file bytes serve the same Range seam as the renderer; neither PTS
    // nor frame selection is mocked or inferred from average source FPS.
    globalThis.fetch=async(url,options={})=>{
      if(!String(url).startsWith('native-preview:'))return nativeFetch(url,options);
      const bytes=fs.readFileSync(String(url).slice('native-preview:'.length));
      const range=options.headers?.Range?.match(/bytes=(\d+)-(\d+)/);
      const body=range?bytes.subarray(Number(range[1]),Math.min(bytes.length,Number(range[2])+1)):bytes;
      return new Response(body,{status:range?206:200});
    };
    const preview=createNativePreviewRuntime({video:null});
    try {
      const source = path.join(directory, 'mother.mov');
      const output = path.join(directory, 'delivery.mp4');
      const sourceClock = scenario.timestamps ? scenario.timestamps.slice(0, -1).reduceRight((rest, pts, index) =>
        `if(eq(N,${index}),${pts},${rest})`, String(scenario.timestamps.at(-1))) : 'PTS*TB';
      run(['-y', '-f', 'lavfi', '-i',
        `color=red:s=64x48:r=${scenario.fps}:d=3,drawbox=c=green:t=fill:enable='eq(mod(n,3),1)',drawbox=c=blue:t=fill:enable='eq(mod(n,3),2)'`,
        '-vf', `setpts='(${sourceClock}+${scenario.sourceOrigin || 0})/TB'`,
        ...(scenario.timestamps ? ['-frames:v', String(scenario.timestamps.length), '-fps_mode:v', 'passthrough'] : []),
        '-c:v', 'libx264', '-g', '240', '-bf', '2', source]);
      const speed = scenario.speed || 1;
      const clip = { id: 'first', path: source, type: 'video', in: scenario.inSeconds ?? scenario.start / scenario.fps,
        out: scenario.outSeconds ?? scenario.end / scenario.fps, offset: scenario.offsetSeconds ?? (scenario.offsetFrame || 0) / scenario.fps, vtrack: 0, fps: scenario.fps,
        natW: 64, natH: 48, speed, reverse: !!scenario.reverse,
        ...(scenario.freezeTime != null ? { freezeTime: scenario.freezeTime } : {}),
        fadeIn: scenario.fade ? 0.2 : 0, fadeOut: scenario.fade ? 0.2 : 0 };
      const firstDuration = (clip.out - clip.in) / speed;
      const clips = [clip];
      if (scenario.segments) for (let index = 1; index < scenario.segments; index++) clips.push({ ...clip,
        id: `part-${index}`, in: index / scenario.fps, out: (index + 1) / scenario.fps, offset: index / scenario.fps });
      if (scenario.secondStart != null) {
        const second = scenario.secondMother ? path.join(directory, 'second.mov') : source;
        if (scenario.secondMother) run(['-y', '-f', 'lavfi', '-i',
          `color=yellow:s=64x48:r=${scenario.fps}:d=3,drawbox=c=cyan:t=fill:enable='eq(mod(n,3),1)',drawbox=c=magenta:t=fill:enable='eq(mod(n,3),2)'`,
          '-c:v', 'libx264', '-g', '240', '-bf', '2', second]);
        const faded = scenario.upperFade || scenario.secondFade;
        clips.push({ ...clip, path: second, id: 'second', vtrack: scenario.layered ? 1 : 0,
          in: scenario.secondStart / scenario.fps, out: (scenario.secondStart + (faded ? 12 : scenario.layered ? 2 : 4)) / scenario.fps,
          offset: scenario.upperFade ? 1 / scenario.fps : scenario.layered ? 2 / scenario.fps : firstDuration,
          speed: faded ? 0.5 : clip.speed, fadeIn: faded ? 0.2 : clip.fadeIn, fadeOut: faded ? 0.2 : clip.fadeOut });
      }
      const duration = Math.max(...clips.map(c => c.offset + (c.out - c.in) / (c.speed || 1)));
      const deliveryFps = scenario.deliveryFps || scenario.fps;
      const snapshot = buildExportSnapshot({ state: { clips, fps: scenario.projectFps || 24, videoTracks: [{ visible: true, opacity: scenario.opacity || 1 }, { visible: true }] }, sequenceEnd: duration });
      expect(snapshot.clips[0].in).toBe(clip.in); expect(snapshot.clips[0].out).toBe(clip.out);
      const delivery = P.buildDeliveryArgv({ ...snapshot, format: 'h264', outPath: output,
        width: 64, height: 48, fps: deliveryFps, videoKbps: 800 }, {
        hasAudioStream: () => false, vencArgsBitrate: () => ['-c:v', 'libx264'],
      });
      run(delivery.args);
      const pixels = run(['-i', output, '-map', '0:v:0', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
      const frameCount = Math.ceil(duration * deliveryFps - 1e-6);
      expect(pixels.length / 3, `${scenario.name}: 實際交付影格數`).toBe(frameCount);
      const references = new Map();
      for (let outputFrame = 0; outputFrame < frameCount; outputFrame++) {
        const time = outputFrame / deliveryFps;
        const visible = clips.filter(c => time + 1e-9 >= c.offset && time + 1e-9 < c.offset + (c.out - c.in) / (c.speed || 1))
          .sort((a, b) => a.vtrack - b.vtrack || a.offset - b.offset);
        let expected = Buffer.from([0, 0, 0]);
        const sourceFrames = [];
        for (const active of visible) {
          const url=`native-preview:${active.path}`;
          if(!preview.sourceClock(url)){
            const metadata=await sourcePresentationMetadata(url);
            expect(metadata,`${scenario.name}: true presentation metadata`).not.toBeNull();
            preview.registerSourceClock(url,metadata);
          }
          const sourceTime = active.freezeTime ?? Seq.toSource(time,active);
          // Only trim-out is half-open. An internal source PTS belongs to the
          // interval beginning at that PTS, including during reverse playback.
          const target=active.reverse&&active.freezeTime==null?sourceFrameTargetUs(sourceTime,active)/1e6:sourceTime;
          const window=await sourceFrameWindow(url,target,preview.sourceClock(url));
          expect(window,`${scenario.name}: source ${target} has an actual presentation interval`).not.toBeNull();
          sourceFrames.push(window.start);
          const key = `${active.path}:${window.start}`;
          let referencePixels = references.get(key);
          if (!referencePixels) {
            const reference = path.join(directory, `reference-${references.size}.png`);
            run(buildClipFrameArgs({ path: active.path, time: window.start, fps: scenario.fps }, reference));
            referencePixels = run(['-i', reference, '-vf', 'scale=1:1', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
            references.set(key, referencePixels);
          }
          const alpha = fadeAlphaAtTimeline(active, time) * (scenario.opacity || 1);
          expected = Buffer.from([...expected].map((value, channel) => Math.round(referencePixels[channel] * alpha + value * (1 - alpha))));
        }
        const actual = pixels.subarray(outputFrame * 3, (outputFrame + 1) * 3);
        // 標準 fade 的 st 落在首個交付格；baseline 真 pixels 在此 .2s fade 的最大誤差 9.87。
        // 純來源格選擇維持較嚴格容差，淡入淡出另容許這個已存在的 filter 格網量化。
        const tolerance = scenario.fade || scenario.upperFade || scenario.secondFade ? 12 : 8;
        for (let channel = 0; channel < 3; channel++) expect(Math.abs(actual[channel] - expected[channel]),
          `${scenario.name}: output ${outputFrame}, source ${sourceFrames}, actual ${[...actual]}, preview ${[...expected]}`).toBeLessThan(tolerance);
      }
    } finally {
      globalThis.fetch=nativeFetch;clearSourceFrameIndexes();
      const resolved = fs.realpathSync(directory);
      if (path.dirname(resolved) !== fs.realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-video-trim-clock-')) throw new Error('拒絕清除未核對的影格測試目錄');
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 30000);
});

describe.skipIf(!fs.existsSync(FFMPEG))('來源首個 presentation 畫格之前的缺口', () => {
  it('正向與反向在絕對交付格網保留透明缺口，讓下層穿透，不能借未來畫格', () => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-video-leading-gap-'));
    const run = args => {
      const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], {
        cwd: directory, windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024,
      });
      expect(result.error || result.status, result.stderr?.toString()).toBe(0); return result.stdout;
    };
    try {
      const source = path.join(directory, 'leading-gap.mkv'), lower = path.join(directory, 'lower.mov');
      const timestamps = [.52, .56, .72, .76];
      run(['-y', '-f', 'lavfi', '-i', "color=red:s=64x48:r=25:d=0.16,drawbox=c=green:t=fill:enable='eq(n,1)',drawbox=c=blue:t=fill:enable='eq(n,2)'",
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=0.8',
        '-filter_complex', "[0:v]setpts='if(eq(N,0),.52,if(eq(N,1),.56,if(eq(N,2),.72,.76)))/TB'[v]",
        '-map', '[v]', '-map', '1:a:0', '-c:v', 'libx264', '-bf', '0', '-fps_mode:v', 'passthrough', '-c:a', 'pcm_s16le', source]);
      run(['-y', '-f', 'lavfi', '-i', 'color=cyan:s=64x48:r=25:d=2', '-an', '-c:v', 'libx264', lower]);
      const references = new Map();
      for (const file of [source, lower]) for (const target of file === lower ? [0] : timestamps) {
        const png = path.join(directory, `reference-${references.size}.png`);
        run(buildClipFrameArgs({ path: file, time: target, fps: 25 }, png));
        references.set(`${file}:${target}`, run(['-i', png, '-vf', 'scale=1:1', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']));
      }
      for (const reverse of [false, true]) for (const speed of [.5, 1, 2]) for (const offset of [0, .02]) {
        const duration = offset + .8 / speed, output = path.join(directory, `${reverse}-${speed}-${offset}.mp4`);
        const upper = { path: source, type: 'video', in: 0, out: .8, offset, speed, reverse, fps: 25, vtrack: 1, natW: 64, natH: 48 };
        const snapshot = buildExportSnapshot({ state: { fps: 50, videoTracks: [{ visible: true }, { visible: true }], clips: [
          { path: lower, type: 'video', in: 0, out: duration, offset: 0, fps: 25, vtrack: 0, natW: 64, natH: 48 }, upper,
        ] }, sequenceEnd: duration });
        const plan = P.buildDeliveryArgv({ ...snapshot, format: 'h264', outPath: output, width: 64, height: 48, fps: 25 },
          { hasAudioStream: () => false, sourceClock: () => ({ timestampOffset: 0 }), vencArgsBitrate: () => ['-c:v', 'libx264'] });
        run(plan.args);
        const pixels = run(['-i', output, '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
        const count = Math.ceil(duration * 25 - 1e-6); expect(pixels.length / 3).toBe(count);
        for (let index = 0; index < count; index++) {
          const time = index / 25;
          const sourceTime = Seq.toSource(time,upper);
          const target=reverse?sourceFrameTargetUs(sourceTime,upper)/1e6:sourceTime;
          const targetUs=Math.round(target*1e6);
          const frame = time + 1e-9 < offset ? -1 : timestamps.findLastIndex(pts => Math.round(pts*1e6)<=targetUs);
          const expected = frame < 0 ? references.get(`${lower}:0`) : references.get(`${source}:${timestamps[frame]}`);
          const actual = pixels.subarray(index * 3, index * 3 + 3);
          for (let channel = 0; channel < 3; channel++) expect(Math.abs(actual[channel] - expected[channel]),
            `reverse=${reverse} speed=${speed} offset=${offset} output=${index} source=${sourceTime} actual=${[...actual]} expected=${[...expected]}`).toBeLessThan(8);
        }
      }
    } finally {
      const resolved = fs.realpathSync(directory);
      if (path.dirname(resolved) !== fs.realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-video-leading-gap-')) throw new Error('拒絕清除未核對的影片缺口測試目錄');
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 30000);
});

describe.skipIf(!fs.existsSync(FFMPEG))('合法字型路徑的真 FFmpeg 內容驗證', () => {
  it('ASS 與 TC 在逗號、引號、括號、分號、空白與 Unicode 路徑使用相同字型，逐 pixel 與正常路徑相同', async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-font-filter-path-'));
    const source = path.join(root, 'source.mov');
    const privateFont = privateSarasaFont(fs.readFileSync(path.join(ROOT, 'font/更紗黑體/sarasa-mono-tc-nerd-regular.ttf')));
    const run = (args, cwd = root) => {
      const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', ...args], { cwd, windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
      expect(result.error || result.status, result.stderr?.toString()).toBe(0);
      return result;
    };
    try {
      run(['-y', '-f', 'lavfi', '-i', 'color=black:s=320x180:r=25:d=0.4', '-c:v', 'libx264', '-an', source]);
      fs.writeFileSync(path.join(root, 'burn.ass'), '[Script Info]\nScriptType: v4.00+\nPlayResX: 320\nPlayResY: 180\n[V4+ Styles]\n'
        + 'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\n'
        + `Style: Default,${privateFont.family},24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,0,0,20,1\n[Events]\n`
        + 'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\nDialogue: 0,0:00:00.00,0:00:00.40,Default,,0,0,0,,字幕 ０Ａ\n');
      for (const mode of ['ASS', 'TC']) {
        let baseline;
        // Keep leading/internal whitespace; a trailing-space directory requires
        // an NT namespace path and is not a normal Win32 font directory.
        for (const name of ['plain', 'font,comma', "font'quote", 'font[brackets]', 'font;semicolon', " 字型 空白,'[;]", 'font-🚀']) {
          const directory = path.join(root, name); fs.mkdirSync(directory, { recursive: true });
          const font = path.join(directory, 'fixed.ttf'); fs.writeFileSync(font, privateFont.bytes);
          const outPath = path.join(root, 'delivery.mov');
          const plan = P.buildDeliveryArgv({ format: 'prores', clips: [{ path: source, in: 0, out: 0.4, offset: 0, audio: [] }],
            videoTracks: [{ vt: 0 }], width: 320, height: 180, fps: 25, duration: 0.4, outPath,
            ...(mode === 'ASS' ? { assFileName: 'burn.ass' } : { timecodeWatermark: { start: '01:00:00:00' } }),
          }, { fontsDir: directory, timecodeFontFile: font, proresArgs: () => ['-c:v', 'prores_ks', '-c:a', 'pcm_s24le'] });
          let encoded;
          try {
            if (mode === 'ASS') encoded = run(plan.args);
            else {
              const progress=[];
              const runner=createDeliveryRunner({
                queue:{assertJobCapabilities(){},registerActiveJob(){},clearActiveJob(){},reportProgress(_id,data){progress.push(data);return true;}},
                queueDir:()=>root,tempDir:directory,
                nativeCapabilities:{assertReady:async()=>{}},
                fonts:{timecodeFile:()=>font},
                mediaProbe:()=>({hasAudio:async()=>false,audioBitrates:async()=>[]}),
                encoder:{proresArgs:()=>['-c:v','prores_ks','-c:a','pcm_s24le']},
                runFfmpeg:async(args,options)=>{encoded=run(args,options.cwd);return{maps:[]};},
              });
              await runner.run({id:'native-timecode',payload:{format:'prores',clips:[{path:source,in:0,out:0.4,offset:0,audio:[]}],videoTracks:[{vt:0}],width:320,height:180,fps:25,duration:0.4,outPath,timecodeWatermark:{start:'01:00:00:00'}}});
              expect(progress.at(-1),JSON.stringify(progress)).toMatchObject({done:true});
              expect(fs.readdirSync(directory)).toEqual(['fixed.ttf']);
            }
          }
          catch (error) { throw new Error(`${mode}: ${name}\n${JSON.stringify(plan.args)}\n${error.message}`, { cause: error }); }
          if (mode === 'ASS') {
            const selections = encoded.stderr.toString().split(/\r?\n/).filter(line => line.includes('fontselect:'));
            expect(selections.length).toBeGreaterThan(0);
            expect(selections.every(line => line.includes(privateFont.postscript)), selections.join('\n')).toBe(true);
          }
          const pixels = run(['-loglevel', 'error', '-i', outPath, '-map', '0:v:0', '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1']).stdout;
          expect(pixels.length).toBe(320 * 180);
          expect(pixels.some(value => value > 200)).toBe(true);
          if (baseline) expect(pixels, `${mode}: ${name}`).toEqual(baseline);
          else baseline = pixels;
        }
      }
    } finally {
      const resolved = fs.realpathSync(root);
      if (path.dirname(resolved) !== fs.realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-font-filter-path-')) throw new Error('拒絕清除未核對的字型測試目錄');
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 30000);
});
