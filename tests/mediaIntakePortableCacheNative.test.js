// @subtool-ci windows
import fs from 'node:fs';
import { observeFullSourceOpen } from './fixtures/full-source-reads.js';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
import { nativeTestTools } from './fixtures/native-tools.cjs';

const require = createRequire(import.meta.url);
const { FileAuthority } = require('../electron/file-authority.js');
const { createMediaIntakeRuntime, cacheKeyFor } = require('../electron/media-intake-runtime.js');
const { createMediaProbe } = require('../electron/media-probe.js');
const { createFFmpegExecution } = require('../electron/ffmpeg-execution-engine.js');
const { ffmpeg, ffprobe } = nativeTestTools();

function run(args) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], {
    windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024,
  });
  expect(result.error || result.status, result.stderr?.toString()).toBe(0);
  return result.stdout;
}

function streamTags(file) {
  const result = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_tag_string', '-of', 'csv=p=0', file],
    {windowsHide: true, encoding: 'utf8'});
  expect(result.error || result.status, result.stderr).toBe(0);
  return result.stdout.trim().split(/\r?\n/);
}

it.skipIf(!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe))('40 分鐘 NTSC 長片經正常分段後，全部 PTS、尾端逐格顏色與聲道對齊', async () => {
  const base = fs.realpathSync(tmpdir()), dir = fs.mkdtempSync(path.join(base, 'subtool-proxy-long-'));
  const source = path.join(dir, 'feature.mov'), cacheRoot = path.join(dir, 'cache');
  const probe = createMediaProbe({executable: ffprobe});
  const execution = createFFmpegExecution({getFFmpegPath: () => ffmpeg, getUserDataDir: () => dir});
  const partPaths = [];
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot: dir, allowSidecarCache: false,
    fileAuthority: new FileAuthority({internalDirectories: [cacheRoot]}),
    ffmpegExecution: {execute(args, options) {
      // Preview parts and their final MP4 use the project's clock; the camera timecode stays on the mother file.
      expect(args[args.indexOf('-write_tmcd') + 1]).toBe('0');
      return execution.execute(args, options);
    }},
    describeVideo: async file => (await probe.describe(file)).video,
    describeProxyPart: file => { partPaths.push(file); return probe.describe(file); },
  });
  const frames = 72000, frameSeconds = 1001 / 30000, duration = frames * frameSeconds;
  const rgb = (file, index) => {
    // Seek a little before the target PTS so rounding the CLI time to microseconds cannot skip the target.
    const seek = Math.max(0, (index - 0.1) * frameSeconds).toFixed(6);
    return [...run(['-ss', seek, '-i', file, '-vf', 'scale=1:1', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])];
  };
  try {
    run(['-f', 'lavfi', '-i', 'color=red:s=32x24:r=30000/1001:d=2402.4',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=8000:d=2.4,adelay=2400000',
      '-vf', "drawbox=c=blue:t=fill:enable='gte(t,2400)',drawbox=c=lime:t=fill:enable='eq(n,71999)'",
      '-c:v', 'libx264', '-preset', 'ultrafast', '-threads:v', '1', '-bf', '0', '-c:a', 'pcm_s16le',
      '-timecode', '01:00:00;00', source]);
    const info = await probe.describe(source);
    expect(info.duration).toBeCloseTo(duration, 4);
    expect(info.video.nominalFrameRate).toBe('30000/1001');
    expect(streamTags(source)).toContain('tmcd');
    const result = await runtime.ingest({src: source, duration: info.duration, needsProxy: true, audio: info.audio});
    expect(result.cached).toBe(false);
    expect(new Set(partPaths).size).toBe(Math.ceil(duration / 120));
    const video = await probe.describe(result.proxy);
    expect(streamTags(result.proxy)).toEqual(['avc1']);
    const packets = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_packets',
      '-show_entries', 'packet=pts', '-of', 'csv=p=0', result.proxy], {windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024});
    expect(packets.error || packets.status, packets.stderr).toBe(0);
    const pts = packets.stdout.trim().split(/\r?\n/).map(Number);
    expect(pts).toHaveLength(frames);
    const [num, den] = video.video.timeBase.split('/').map(Number), tick = num / den;
    const maxError = pts.reduce((worst, point, index) => Math.max(worst, Math.abs(point * tick - index * frameSeconds)), 0);
    expect(maxError).toBeLessThanOrEqual(0.000001);
    for (const [index, color] of [[0,[255,0,0]], [frames-2,[0,0,255]], [frames-1,[0,255,0]]]) {
      for (const file of [source, result.proxy]) {
        const pixel = rgb(file, index);
        expect(pixel).toHaveLength(3);
        expect(pixel.every((v, i) => Math.abs(v - color[i]) < 8), JSON.stringify({index, pixel})).toBe(true);
      }
    }
    expect(result.channels).toHaveLength(1);
    for (const file of [source, result.channels[0].file, result.wave]) {
      for (const [seek, audible] of [[2399.5,false],[2401.5,true]]) {
        const bytes = run(['-ss', String(seek), '-i', file, '-map', '0:a:0', '-t', '0.125',
          '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1']);
        expect(bytes.length).toBe(2000);
        let real = 0, imaginary = 0, peak = 0;
        for (let i = 0; i < 1000; i++) {
          const amplitude = bytes.readInt16LE(2*i) / 32768, phase = 2*Math.PI*880*i / 8000;
          real += amplitude * Math.cos(phase); imaginary += amplitude * Math.sin(phase);
          peak = Math.max(peak, Math.abs(amplitude));
        }
        if (audible) expect(2*Math.hypot(real,imaginary) / 1000).toBeGreaterThan(0.08);
        else expect(peak).toBeLessThan(0.001);
      }
    }
  } finally {
    await runtime.close(); await execution.cancelAllAndWait(); await probe.cancelAllAndWait();
    const target = fs.realpathSync(dir);
    if (path.dirname(target) !== base || !path.basename(target).startsWith('subtool-proxy-long-')) throw new Error('暫存目錄已變更');
    fs.rmSync(target, {recursive:true, force:true});
  }
}, 120000);

it.skipIf(!fs.existsSync(ffmpeg)||!fs.existsSync(ffprobe))('重建同大小損毀的 Proxy 後每格像素一致，保留原聲道',async()=>{
  const base=fs.realpathSync(tmpdir()),dir=fs.mkdtempSync(path.join(base,'subtool-proxy-repair-'));
  const src=path.join(dir,'source.mkv'),cacheRoot=path.join(dir,'cache');
  const probe=createMediaProbe({executable:ffprobe});
  const execution=createFFmpegExecution({getFFmpegPath:()=>ffmpeg,getUserDataDir:()=>dir});
  const runtime=createMediaIntakeRuntime({cacheRoot,tempRoot:dir,fileAuthority:new FileAuthority({internalDirectories:[cacheRoot]}),
    ffmpegExecution:execution,describeVideo:async file=>(await probe.describe(file)).video});
  try{
    run(['-f','lavfi','-i','testsrc2=s=64x48:r=5:d=1','-f','lavfi','-i','sine=d=1','-c:v','libx264','-c:a','pcm_s16le',src]);
    const info=await probe.describe(src),request={src,duration:1,needsProxy:true,audio:info.audio};
    const original=await runtime.ingest(request);
    const frames=file=>run(['-i',file,'-map','0:v:0','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
    const pixels=frames(original.proxy),sound=fs.readFileSync(original.channels[0].file);
    expect(pixels.length).toBe(64*48*3*5);
    fs.writeFileSync(original.proxy,Buffer.alloc(fs.statSync(original.proxy).size));
    const repaired=await runtime.ingest({...request,failedProxy:original.proxy});
    expect(repaired.proxy).not.toBe(original.proxy);expect(frames(repaired.proxy)).toEqual(pixels);
    expect(repaired.channels).toEqual(original.channels);expect(fs.readFileSync(repaired.channels[0].file)).toEqual(sound);
  }finally{
    await runtime.close();await execution.cancelAllAndWait();await probe.cancelAllAndWait();
    const target=fs.realpathSync(dir);
    if(path.dirname(target)!==base||!path.basename(target).startsWith('subtool-proxy-repair-'))throw new Error('暫存目錄已變更');
    fs.rmSync(target,{recursive:true,force:true});
  }
});

it.skipIf(!fs.existsSync(ffmpeg)||!fs.existsSync(ffprobe)).each(['pcm_s16le','aac'])('75%% 中斷後跨 runtime 只重編尾段，%s 母片的 VFR 時序、畫面與連續 PCM 保持一致',async codec=>{
  const base=fs.realpathSync(tmpdir()),dir=fs.mkdtempSync(path.join(base,'subtool-proxy-parts-'));
  const source=path.join(dir,'media.mov'),probe=createMediaProbe({executable:ffprobe});
  const execution=createFFmpegExecution({getFFmpegPath:()=>ffmpeg,getUserDataDir:()=>dir});
  const runtimes=[],calls=[];
  let stop=false;
  function create(name,checkpoints,onProgress){
    const cacheRoot=path.join(dir,name);
    const rt=createMediaIntakeRuntime({cacheRoot,tempRoot:dir,allowSidecarCache:false,
      fileAuthority:new FileAuthority({internalDirectories:[cacheRoot]}),
      ffmpegExecution:{execute:(args,options)=>{calls.push(args);return execution.execute(args,options);}},
      describeVideo:async file=>(await probe.describe(file)).video,
      ...(checkpoints?{proxyCheckpointSeconds:1,describeProxyPart:file=>probe.describe(file)}:{}),
      sendProgress:(_target,data)=>onProgress?.(data)});
    runtimes.push(rt);return rt;
  }
  try{
    const makeSource=hue=>run(['-y','-f','lavfi','-i',codec==='aac'?'testsrc2=s=64x48:r=5:d=4':'testsrc2=s=64x48:r=25:d=4',
      '-f','lavfi','-i',codec==='aac'?'sine=frequency=880:sample_rate=16000:duration=4':'sine=frequency=880:sample_rate=48000:duration=4','-vf',
      "select='not(eq(mod(n,9),1))',hue=h="+hue,'-fps_mode','vfr','-c:v','libx264','-bf','0','-c:a',codec,
      '-output_ts_offset','5',source]);
    makeSource(0);
    const info=await probe.describe(source),request={src:source,duration:4,audio:info.audio,needsProxy:true};
    const direct=await create('reference',false).ingest(request);
    const first=create('checkpoint',true,p=>{if(p.label?.includes('3/4')&&p.pct===75)stop=true;});
    await expect(first.ingest(request,{isCancelled:()=>stop})).rejects.toMatchObject({code:'INGEST_SUPERSEDED'});
    await first.close();calls.length=0;
    if (codec === 'pcm_s16le') {
      // A previous release can leave a one-second, video + camera-timecode part in this bucket.
      const cache = path.join(dir, 'checkpoint');
      const markers = fs.readdirSync(cache, {recursive: true}).filter(file =>
        file.includes('proxy-part-') && path.basename(file) === 'ready');
      const marker = markers.map(file => path.join(cache, file)).find(file => JSON.parse(fs.readFileSync(file, 'utf8')).first === 0);
      expect(marker).toBeTruthy();
      const part = path.join(path.dirname(marker), 'content.mp4'), legacy = path.join(dir, 'short-timecoded.mp4');
      run(['-i', part, '-map', '0:v:0', '-c:v', 'copy', '-video_track_timescale', '1000000',
        '-timecode', '01:00:00:00', legacy]);
      expect(streamTags(legacy)).toContain('tmcd');
      const bytes = fs.readFileSync(legacy), receipt = JSON.parse(fs.readFileSync(marker, 'utf8'));
      fs.writeFileSync(part, bytes);
      fs.writeFileSync(marker, JSON.stringify({...receipt, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')}));
    }
    const messages=[];
    const next=create('checkpoint',true,p=>messages.push(p.label));
    const resumed=await next.ingest(request);
    expect(calls.filter(args=>args.includes('-enc_time_base'))).toHaveLength(1);
    expect(messages).toContain('Proxy 分段 3/4（沿用 3 段）');
    expect(streamTags(resumed.proxy)).toEqual(['avc1']);
    const times=file=>JSON.parse(spawnSync(ffprobe,['-v','error','-select_streams','v:0','-show_frames',
      '-show_entries','frame=pts_time','-of','json',file],{encoding:'utf8',windowsHide:true}).stdout).frames.map(frame=>Number(frame.pts_time));
    expect(times(resumed.proxy)).toEqual(times(direct.proxy));
    const pixels=file=>run(['-i',file,'-vf','scale=8:8','-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
    const expected=pixels(direct.proxy),actual=pixels(resumed.proxy);
    expect(actual.length).toBe(expected.length);
    for(let start=0;start<expected.length;start+=192){
      let delta=0;for(let n=0;n<192;n++)delta+=Math.abs(actual[start+n]-expected[start+n]);
      expect(delta/192).toBeLessThan(4);
    }
    const pcm=file=>run(['-i',file,'-f','s16le','-ac','1','pipe:1']);
    expect(pcm(resumed.channels[0].file)).toEqual(pcm(direct.channels[0].file));
    expect(fs.readFileSync(resumed.wave)).toEqual(fs.readFileSync(direct.wave));
    expect(fs.readdirSync(path.dirname(path.dirname(resumed.proxy))).filter(name=>name.startsWith('proxy-part-'))).toEqual([]);
    makeSource(110);calls.length=0;
    const replacement=await next.ingest(request);
    expect(replacement.cached).toBe(false);expect(calls.filter(args=>args.includes('-enc_time_base'))).toHaveLength(4);
    expect(pixels(replacement.proxy).equals(actual)).toBe(false);
  }finally{
    await Promise.all(runtimes.map(rt=>rt.close()));await execution.cancelAllAndWait();await probe.cancelAllAndWait();
    const target=fs.realpathSync(dir);
    if(path.dirname(target)!==base||!path.basename(target).startsWith('subtool-proxy-parts-'))throw new Error('暫存目錄已變更');
    fs.rmSync(target,{recursive:true,force:true});
  }
},30000);

it.skipIf(!fs.existsSync(ffmpeg)||!fs.existsSync(ffprobe)).each(['停止','尚未退出的磁碟快照'])('首次成長串流%s後，先播含 MIX 的已算前段，從缺格續算並交接完整聲道',async(mode)=>{
  const base=fs.realpathSync(tmpdir()),dir=fs.mkdtempSync(path.join(base,'subtool-stream-resume-'));
  const src=path.join(dir,'media.mov'),cacheRoot=path.join(dir,'cache'),runtimes=[];
  const probe=createMediaProbe({executable:ffprobe});
  const execution=createFFmpegExecution({getFFmpegPath:()=>ffmpeg,getUserDataDir:()=>dir});
  const trace=[],messages=[];
  let cancelled=false,releaseTail;
  function open(interrupt=false){
    const rt=createMediaIntakeRuntime({cacheRoot,tempRoot:dir,allowSidecarCache:false,
      fileAuthority:new FileAuthority({internalDirectories:[cacheRoot]}),
      describeVideo:async file=>(await probe.describe(file)).video,proxyCheckpointSeconds:1,describeProxyPart:file=>probe.describe(file),
      sendProgress:(_target,p)=>messages.push(p.label),log:(...args)=>messages.push(args.join(' ')),
      ffmpegExecution:{async execute(args,options){
        if(interrupt){
          const out=args.findIndex(arg=>arg.endsWith('proxy.mp4'));
          await execution.execute([...args.slice(0,out),'-t','3',...args.slice(out)],{...options,onProgress:undefined});
          fs.appendFileSync(args[out],Buffer.from([0,0,1,200,109,111,111,102,0]));
          if(mode==='尚未退出的磁碟快照'){
            options.onProgress({pct:75});
            const ready=await vi.waitFor(()=>{
              const name=fs.readdirSync(cacheRoot,{recursive:true}).find(file=>file.includes('proxy-stream-')&&path.basename(file)==='ready');
              expect(name).toBeTruthy();return name;
            });
            const snapshot=path.join(dir,'snapshot');
            fs.cpSync(cacheRoot,snapshot,{recursive:true});
            // A hard exit after appending data but before replacing its receipt.
            fs.appendFileSync(path.join(snapshot,path.dirname(ready),'content.mp4'),Buffer.alloc(71,0x55));
          }
          cancelled=true;
          throw new Error('模擬停止後尚有截斷 fragment');
        }
        trace.push(args);
        if(args.includes('-enc_time_base')&&!releaseTail)await new Promise(resolve=>{releaseTail=resolve;});
        return execution.execute(args,options);
      }}});
    runtimes.push(rt);return rt;
  }
  try{
    run(['-y','-f','lavfi','-i','testsrc2=s=96x72:r=25:d=4','-f','lavfi','-i','sine=frequency=830:sample_rate=48000:d=4',
      '-vf',"select='not(eq(mod(n,11),5))'",'-fps_mode','vfr','-c:v','libx264','-bf','0','-c:a','pcm_s16le','-output_ts_offset','5',src]);
    const info=await probe.describe(src),request={src,duration:4,audio:info.audio};
    const first=open(true);
    const aborted=await first.stream(request,{isCancelled:()=>cancelled});
    await aborted.completion;
    await first.close();
    if(mode==='尚未退出的磁碟快照'){
      fs.renameSync(cacheRoot,path.join(dir,'after-stop'));
      fs.renameSync(path.join(dir,'snapshot'),cacheRoot);
    }
    const second=open();
    const resumed=await second.stream(request);
    expect(releaseTail,messages.join('\n')).toBeTypeOf('function');
    expect(resumed.response.previewMix).toBe(true);
    const response=await fetch(resumed.response.streamUrl);
    const partial=path.join(dir,'prefix.mp4');
    fs.writeFileSync(partial,Buffer.from(await response.arrayBuffer()));
    const pts=file=>JSON.parse(spawnSync(ffprobe,['-v','error','-select_streams','v:0','-show_frames','-show_entries',
      'frame=pts_time','-of','json',file],{encoding:'utf8',windowsHide:true}).stdout).frames.map(f=>Number((Number(f.pts_time)-(file===src?5:0)).toFixed(6)));
    const partialPts=pts(partial),expected=pts(src);
    expect(partialPts.length).toBeGreaterThan(55);
    expect(partialPts).toEqual(expected.slice(0,partialPts.length));
    const pcm=file=>run(['-i',file,'-map','0:a:0','-ar','48000','-f','s16le','pipe:1']);
    const early=pcm(partial),sourcePcm=pcm(src);
    expect(early.length).toBeGreaterThan(2*48000*2);
    expect(early).toEqual(sourcePcm.subarray(0,early.length));
    releaseTail();await resumed.completion;
    expect(messages.join('\n')).toContain('沿用前 '+expected[partialPts.length].toFixed(1)+' 秒');
    expect(trace.filter(args=>args.includes('-enc_time_base'))).toHaveLength(2);
    expect(pts(resumed.response.proxy)).toEqual(expected);
    const pixels=file=>run(['-i',file,'-map','0:v:0','-vf','scale=8:8','-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
    const sourcePixels=pixels(src),proxyPixels=pixels(resumed.response.proxy);
    expect(proxyPixels.length).toBe(sourcePixels.length);
    for(let start=0;start<sourcePixels.length;start+=192){
      let difference=0;
      for(let i=start;i<start+192;i++)difference+=Math.abs(sourcePixels[i]-proxyPixels[i]);
      expect(difference/192).toBeLessThan(6);
    }
    expect(pcm(resumed.response.proxy)).toEqual(sourcePcm);
    expect(resumed.response.channels.length).toBe(1);
    expect(pcm(resumed.response.channels[0].file).length).toBeGreaterThanOrEqual(sourcePcm.length);
    expect(fs.readdirSync(path.dirname(path.dirname(resumed.response.proxy))).filter(name=>name.startsWith('proxy-'))).toEqual([]);
    expect(second.releaseStream(resumed.response.streamLeaseId)).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(resumed.response.proxy),'resume.mp4'))).toBe(false);
  }finally{
    releaseTail?.();
    await Promise.all(runtimes.map(rt=>rt.close()));await execution.cancelAllAndWait();await probe.cancelAllAndWait();
    const target=fs.realpathSync(dir);
    if(path.dirname(target)!==base||!path.basename(target).startsWith('subtool-stream-resume-'))throw new Error('暫存目錄已變更');
    fs.rmSync(target,{recursive:true,force:true});
  }
},30000);

it.skipIf(!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe)).each([
  { name: '同共享檔案換掛載與 profile', copySource: false },
  { name: '新建快取連素材複製到另一部電腦', copySource: true },
])('$name：沿用真 Proxy／聲道，不再執行 FFmpeg，像素與 PCM 內容相同', async ({ copySource }) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-portable-intake-native-'));
  const firstMedia = path.join(root, 'computer-A', 'media'), secondMedia = path.join(root, 'computer-B', 'different-drive');
  fs.mkdirSync(firstMedia, { recursive: true });
  const source = path.join(firstMedia, 'red-tone.mkv');
  const probe = createMediaProbe({ executable: ffprobe });
  const execution = createFFmpegExecution({ getFFmpegPath: () => ffmpeg, getUserDataDir: () => root });
  const runtimes = [];
  try {
    run(['-y', '-f', 'lavfi', '-i', 'color=red:s=64x48:r=10:d=0.5',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=0.5',
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-bf', '0', '-c:a', 'pcm_s16le', source]);
    const info = await probe.describe(source);
    const firstCache = path.join(root, 'profile-A', 'mediacache');
    const first = createMediaIntakeRuntime({
      cacheRoot: firstCache, tempRoot: root, delay: async () => {},
      fileAuthority: new FileAuthority({ internalDirectories: [firstCache] }),
      ffmpegExecution: execution, describeVideo: async file => (await probe.describe(file)).video,
    });
    runtimes.push(first);
    const saved = await first.ingest({ src: source, duration: 0.5, needsProxy: true, audio: info.audio });
    expect(saved.cached).toBe(false);
    expect(saved.channels).toHaveLength(1);
    const originalProxy = fs.readFileSync(saved.proxy), originalChannel = fs.readFileSync(saved.channels[0].file);
    const pixel = run(['-i', saved.proxy, '-vf', 'scale=1:1', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
    expect(pixel[0]).toBeGreaterThan(240); expect(pixel[1]).toBeLessThan(30); expect(pixel[2]).toBeLessThan(30);
    const originalPcm = run(['-i', saved.channels[0].file, '-ar', '4000', '-ac', '1', '-f', 'f32le', 'pipe:1']);
    expect(originalPcm.length / 4).toBeGreaterThanOrEqual(1600);
    let energy = 0;
    for (let sample = 200; sample < 1600; sample++) energy += originalPcm.readFloatLE(sample * 4) ** 2;
    expect(Math.sqrt(energy / 1400)).toBeGreaterThan(0.05);
    expect(Math.sqrt(energy / 1400)).toBeLessThan(0.15);
    const originalKey = cacheKeyFor(source);
    await first.close();
    if (copySource) {
      fs.cpSync(firstMedia, secondMedia, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(secondMedia), { recursive: true });
      fs.renameSync(firstMedia, secondMedia);
    }
    const copiedSource = path.join(secondMedia, path.basename(source));
    if (copySource) fs.utimesSync(copiedSource, new Date('2026-01-01'), new Date('2026-01-01'));
    expect(cacheKeyFor(copiedSource)).not.toBe(originalKey);
    const secondCache = path.join(root, 'profile-B', 'mediacache');
    const execute = vi.fn(async () => { throw new Error('另一電腦不應重新計算已有 Proxy'); });
    const secondProbe = vi.fn(async file => (await probe.describe(file)).video);
    const second = createMediaIntakeRuntime({ cacheRoot: secondCache, tempRoot: root, delay: async () => {},
      fileAuthority: new FileAuthority({ internalDirectories: [secondCache] }),
      ffmpegExecution: { execute }, describeVideo: secondProbe });
    runtimes.push(second);
    const reused = await second.ingest({ src: copiedSource, duration: 0.5, needsProxy: true, audio: info.audio });
    expect(reused.cached).toBe(true);
    expect(reused.proxy).toBe(path.join(secondMedia, path.relative(firstMedia, saved.proxy)));
    expect(fs.readFileSync(reused.proxy)).toEqual(originalProxy);
    expect(fs.readFileSync(reused.channels[0].file)).toEqual(originalChannel);
    expect(execute).not.toHaveBeenCalled(); expect(secondProbe).not.toHaveBeenCalled();
    expect(run(['-i', reused.proxy, '-vf', 'scale=1:1', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])).toEqual(pixel);
    expect(run(['-i', reused.channels[0].file, '-ar', '4000', '-ac', '1', '-f', 'f32le', 'pipe:1'])).toEqual(originalPcm);
    await second.close();
    const thirdMedia = path.join(root, 'another-mount');
    fs.renameSync(secondMedia, thirdMedia);
    const movedSource = path.join(thirdMedia, path.basename(source));
    const thirdCache = path.join(root, 'profile-C', 'mediacache');
    const third = createMediaIntakeRuntime({ cacheRoot: thirdCache, tempRoot: root, delay: async () => {},
      fileAuthority: new FileAuthority({ internalDirectories: [thirdCache] }),
      ffmpegExecution: { execute }, describeVideo: secondProbe });
    runtimes.push(third);
    const open = fsp.open;
    const noFullRead = observeFullSourceOpen((file, ...args) => {
      if (path.resolve(file) === movedSource) throw new Error('同一共享檔案不應重新讀全文驗證');
      return open(file, ...args);
    });
    try {
      const shared = await third.ingest({ src: movedSource, duration: 0.5, needsProxy: true, audio: info.audio });
      expect(shared.cached).toBe(true);
      expect(fs.readFileSync(shared.proxy)).toEqual(originalProxy);
      expect(fs.readFileSync(shared.channels[0].file)).toEqual(originalChannel);
      expect(execute).not.toHaveBeenCalled(); expect(secondProbe).not.toHaveBeenCalled();
      expect(run(['-i', shared.proxy, '-vf', 'scale=1:1', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])).toEqual(pixel);
      expect(run(['-i', shared.channels[0].file, '-ar', '4000', '-ac', '1', '-f', 'f32le', 'pipe:1'])).toEqual(originalPcm);
    } finally { noFullRead.stop(); }
  } finally {
    await Promise.all(runtimes.map(runtime => runtime.close()));
    await execution.cancelAllAndWait(); await probe.cancelAllAndWait();
    const resolved = fs.realpathSync(root);
    if (path.dirname(resolved) !== fs.realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-portable-intake-native-')) {
      throw new Error('拒絕清除未核對的可攜原生快取測試目錄');
    }
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 30000);
